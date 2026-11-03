import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSupportedSlidevVersion, resolveSlidevCli, supportedSlidevVersions } from './slidevCli';

export interface RunningPreview {
  url: string;
  port: number;
}

interface CachedThumbnails {
  version: string;
  slideCount: number;
  files: Record<string, string>;
}

export interface ThumbnailFile {
  slide: number;
  path: string;
}

const serverStartupTimeoutMs = 90_000;
const thumbnailTimeoutMs = 30 * 60_000;
const exportTimeoutMs = 30 * 60_000;
export const maxThumbnailBatchSize = 12;

export type SlidevExportFormat = 'pdf' | 'png' | 'pptx';

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    });
    throw new Error('Unable to allocate a local Slidev preview port.');
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
  if (!child.kill()) {
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error('Unable to stop the Slidev process.');
    }
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise<boolean>(resolveTimeout => {
      timeout = setTimeout(() => resolveTimeout(true), 3000);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (!timedOut) {
    return;
  }

  child.kill('SIGKILL');
  let forceTimeout: ReturnType<typeof setTimeout> | undefined;
  const forceTimedOut = await Promise.race([
    closed.then(() => false),
    new Promise<boolean>(resolveTimeout => {
      forceTimeout = setTimeout(() => resolveTimeout(true), 1000);
    }),
  ]);
  if (forceTimeout) {
    clearTimeout(forceTimeout);
  }
  if (forceTimedOut) {
    throw new Error('The Slidev process did not exit after a forced stop.');
  }
}

async function waitForServer(
  port: number,
  child: ChildProcess,
  processError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + serverStartupTimeoutMs;
  const url = `http://127.0.0.1:${port}/`;
  while (Date.now() < deadline) {
    const error = processError();
    if (error) {
      throw new Error(`Unable to start Slidev: ${error.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Slidev exited before its server became ready (exit code ${child.exitCode ?? 'unknown'}).`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status < 600) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // The server can refuse connections while Slidev is still starting.
    } finally {
      clearTimeout(timeout);
    }
    await delay(250);
  }
  throw new Error(`Slidev did not become ready within ${serverStartupTimeoutMs / 1000} seconds.`);
}

function outputTail(chunks: string[]): string {
  return chunks.join('').slice(-12_000).trim();
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function collectPngFiles(directory: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const childPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(childPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
        results.push(childPath);
      }
    }
  }

  await visit(directory);
  return results.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export class SlidevPreviewSession {
  private server: ChildProcess | undefined;
  private thumbnailProcess: ChildProcess | undefined;
  private exportProcess: ChildProcess | undefined;
  private exportGeneration = 0;
  private readonly cacheDirectories = new Set<string>();
  private readonly inFlightThumbnails = new Map<string, Promise<ThumbnailFile[]>>();
  private thumbnailQueue: Promise<void> = Promise.resolve();
  private thumbnailGeneration = 0;

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  async startServer(rootPath: string, deckPath: string): Promise<RunningPreview> {
    await this.stop();
    const cli = await resolveSlidevCli(rootPath);
    if (!cli) {
      throw new Error('Slidev is not installed in this workspace. Install its local @slidev/cli dependency first.');
    }
    if (!isSupportedSlidevVersion(cli.version)) {
      throw new Error(
        `Slidev ${cli.version} is unsupported; this preview adapter supports ${supportedSlidevVersions.join(' and ')}.`,
      );
    }

    const actualRoot = await realpath(rootPath);
    const actualDeck = await realpath(deckPath);
    const port = await findAvailablePort();
    const child = spawn(
      process.execPath,
      [
        '--dns-result-order=ipv4first',
        cli.entryPoint,
        actualDeck,
        '--port',
        String(port),
        '--bind',
        '127.0.0.1',
        '--log',
        'info',
      ],
      {
        cwd: actualRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      },
    );
    this.server = child;
    const chunks: string[] = [];
    let capturedLength = 0;
    let processError: Error | undefined;
    const capture = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.log(text.trimEnd());
      if (capturedLength < 24_000) {
        chunks.push(text.slice(0, 24_000 - capturedLength));
        capturedLength += text.length;
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', error => { processError = error; });
    child.once('close', (code, signal) => {
      if (this.server === child) {
        this.server = undefined;
        const detail = outputTail(chunks);
        this.log(`Slidev preview stopped unexpectedly (${signal ?? `exit ${code ?? 'unknown'}`}).${detail ? `\n${detail}` : ''}`);
      }
    });

    try {
      await waitForServer(port, child, () => processError);
      if (this.server !== child) {
        throw new Error('Slidev preview stopped during startup.');
      }
      return { url: `http://127.0.0.1:${port}/`, port };
    } catch (error) {
      if (this.server === child) {
        this.server = undefined;
      }
      await terminate(child);
      const detail = outputTail(chunks);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
    }
  }

  async captureThumbnails(
    rootPath: string,
    deckPath: string,
    cacheRoot: string,
    fingerprint: string,
    start: number,
    end: number,
    slideCount: number,
  ): Promise<ThumbnailFile[]> {
    if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
      throw new Error('The thumbnail cache fingerprint is invalid.');
    }
    if (
      !Number.isSafeInteger(slideCount)
      || slideCount < 1
      || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 1
      || end < start
      || end > slideCount
      || end - start + 1 > maxThumbnailBatchSize
    ) {
      throw new Error(`Thumbnail range must contain between 1 and ${maxThumbnailBatchSize} valid slides.`);
    }
    const generation = this.thumbnailGeneration;
    const key = `${fingerprint}:${slideCount}:${start}-${end}`;
    const existing = this.inFlightThumbnails.get(key);
    if (existing) {
      return existing;
    }
    const task = this.thumbnailQueue.then(() => this.captureThumbnailsCore(
      rootPath,
      deckPath,
      cacheRoot,
      fingerprint,
      start,
      end,
      slideCount,
      generation,
    ));
    this.thumbnailQueue = task.then(() => undefined, () => undefined);
    this.inFlightThumbnails.set(key, task);
    try {
      return await task;
    } finally {
      if (this.inFlightThumbnails.get(key) === task) {
        this.inFlightThumbnails.delete(key);
      }
    }
  }

  async cancelThumbnailExport(): Promise<void> {
    this.thumbnailGeneration++;
    this.inFlightThumbnails.clear();
    const child = this.thumbnailProcess;
    this.thumbnailProcess = undefined;
    if (child) {
      await terminate(child);
    }
  }

  async exportDeck(
    rootPath: string,
    deckPath: string,
    outputPath: string,
    format: SlidevExportFormat,
    onOutput: (text: string) => void = () => undefined,
    deckName = 'slides',
  ): Promise<string> {
    if (this.exportProcess) {
      throw new Error('A Slidev export is already running.');
    }
    const generation = ++this.exportGeneration;
    if (!['pdf', 'png', 'pptx'].includes(format)) {
      throw new Error(`Unsupported Slidev export format: ${format}.`);
    }
    const cli = await resolveSlidevCli(rootPath);
    if (!cli) {
      throw new Error('Slidev is not installed in this workspace. Install its local @slidev/cli dependency first.');
    }
    if (!isSupportedSlidevVersion(cli.version)) {
      throw new Error(
        `Slidev ${cli.version} is unsupported; export supports ${supportedSlidevVersions.join(' and ')}.`,
      );
    }

    let cliOutputPath = resolve(outputPath);
    let pngOutputDirectory: string | undefined;
    if (format === 'png') {
      const outputDirectory = await realpath(outputPath);
      pngOutputDirectory = join(
        outputDirectory,
        `${deckName.replace(/[<>:"/\\|?*]/g, '-').trim() || 'slides'}-export-${randomBytes(6).toString('hex')}`,
      );
      await mkdir(pngOutputDirectory);
      cliOutputPath = join(pngOutputDirectory, 'slide.png');
    }

    const child = spawn(
      process.execPath,
      [
        cli.entryPoint,
        'export',
        await realpath(deckPath),
        '--format',
        format,
        '--output',
        cliOutputPath,
        '--timeout',
        '120000',
      ],
      {
        cwd: await realpath(rootPath),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      },
    );
    this.exportProcess = child;
    const chunks: string[] = [];
    let capturedLength = 0;
    let processError: Error | undefined;
    const capture = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.log(text.trimEnd());
      onOutput(text);
      if (capturedLength < 12_000) {
        chunks.push(text.slice(0, 12_000 - capturedLength));
        capturedLength += text.length;
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', error => { processError = error; });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTriggered = false;
    const timeout = new Promise<never>((_resolveTimeout, rejectTimeout) => {
      timer = setTimeout(() => {
        timeoutTriggered = true;
        rejectTimeout(new Error(`Slidev ${format.toUpperCase()} export exceeded ${exportTimeoutMs / 60_000} minutes.`));
      }, exportTimeoutMs);
    });
    try {
      const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => {
        child.once('close', (code, signal) => resolveClose({ code, signal }));
      });
      const result = await Promise.race([close, timeout]);
      if (generation !== this.exportGeneration) {
        throw new Error('Slidev export was cancelled.');
      }
      if (processError) {
        throw new Error(`Unable to run Slidev ${format.toUpperCase()} export: ${processError.message}`);
      }
      if (result.code !== 0) {
        const detail = outputTail(chunks);
        throw new Error(
          `Slidev ${format.toUpperCase()} export failed (exit code ${result.code ?? result.signal ?? 'unknown'}).${detail ? `\n${detail}` : ''}`,
        );
      }
      if (format === 'png') {
        const files = await collectPngFiles(pngOutputDirectory!);
        if (files.length === 0) {
          throw new Error('Slidev completed the PNG export but did not create any slide images.');
        }
        return pngOutputDirectory!;
      } else {
        try {
          const output = await stat(cliOutputPath);
          if (!output.isFile() || output.size === 0) {
            throw new Error(`Slidev completed the export but created an empty or invalid output: ${outputPath}`);
          }
        } catch (error) {
          if (isMissingFile(error)) {
            throw new Error(`Slidev completed the export but did not create the selected output: ${outputPath}`);
          }
          throw error;
        }
        return cliOutputPath;
      }
    } catch (error) {
      const cancelled = generation !== this.exportGeneration;
      if (this.exportProcess === child) {
        this.exportProcess = undefined;
      }
      await terminate(child);
      if (pngOutputDirectory) {
        await rm(pngOutputDirectory, { recursive: true, force: true });
      }
      if (cancelled) {
        throw new Error('Slidev export was cancelled.');
      }
      if (timeoutTriggered) {
        throw error;
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (this.exportProcess === child) {
        this.exportProcess = undefined;
      }
    }
  }

  async cancelExport(): Promise<void> {
    this.exportGeneration++;
    const child = this.exportProcess;
    this.exportProcess = undefined;
    if (child) {
      await terminate(child);
    }
  }

  async stopServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await terminate(server);
    }
  }

  async stop(): Promise<void> {
    this.exportGeneration++;
    this.thumbnailGeneration++;
    this.inFlightThumbnails.clear();
    const thumbnailProcess = this.thumbnailProcess;
    const exportProcess = this.exportProcess;
    this.thumbnailProcess = undefined;
    this.exportProcess = undefined;
    const server = this.server;
    this.server = undefined;
    if (thumbnailProcess) {
      await terminate(thumbnailProcess);
    }
    if (exportProcess) {
      await terminate(exportProcess);
    }
    if (server) {
      await terminate(server);
    }
  }

  async invalidateThumbnails(): Promise<void> {
    this.thumbnailGeneration++;
    this.inFlightThumbnails.clear();
    const thumbnailProcess = this.thumbnailProcess;
    this.thumbnailProcess = undefined;
    if (thumbnailProcess) {
      await terminate(thumbnailProcess);
    }
    const directories = [...this.cacheDirectories];
    this.cacheDirectories.clear();
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  }

  dispose(): void {
    void this.stop().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Unable to clean up Slidev processes: ${message}`);
    });
  }

  private async captureThumbnailsCore(
    rootPath: string,
    deckPath: string,
    cacheRoot: string,
    fingerprint: string,
    start: number,
    end: number,
    slideCount: number,
    generation: number,
  ): Promise<ThumbnailFile[]> {
    const ensureCurrent = () => {
      if (generation !== this.thumbnailGeneration) {
        throw new Error('Slidev thumbnail export was cancelled.');
      }
    };
    ensureCurrent();
    const cli = await resolveSlidevCli(rootPath);
    ensureCurrent();
    if (!cli) {
      throw new Error('Slidev is not installed in this workspace. Install its local @slidev/cli dependency first.');
    }
    if (!isSupportedSlidevVersion(cli.version)) {
      throw new Error(
        `Slidev ${cli.version} is unsupported; PNG export supports ${supportedSlidevVersions.join(' and ')}.`,
      );
    }

    const cacheDirectory = resolve(cacheRoot, 'thumbnails', fingerprint);
    this.cacheDirectories.add(cacheDirectory);
    await mkdir(cacheDirectory, { recursive: true });
    ensureCurrent();
    const markerPath = join(cacheDirectory, '.complete.json');
    let filesBySlide: Record<string, string> = {};
    try {
      const cache: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
      if (
        typeof cache === 'object'
        && cache !== null
        && 'version' in cache
        && cache.version === cli.version
        && 'slideCount' in cache
        && cache.slideCount === slideCount
        && 'files' in cache
        && typeof cache.files === 'object'
        && cache.files !== null
      ) {
        const cacheRoot = await realpath(cacheDirectory);
        const entries = Object.entries(cache.files).filter(([slide, file]) =>
          /^[1-9]\d*$/.test(slide)
          && Number(slide) <= slideCount
          && typeof file === 'string'
          && resolve(cacheDirectory, file) !== cacheDirectory
          && isWithinDirectory(cacheDirectory, resolve(cacheDirectory, file)),
        );
        const valid = await Promise.all(entries.map(async ([slide, file]) => {
          const path = resolve(cacheDirectory, file);
          try {
            const actualFile = await realpath(path);
            return isWithinDirectory(cacheRoot, actualFile) ? [slide, file] as const : undefined;
          } catch (error) {
            if (isMissingFile(error)) {
              return undefined;
            }
            throw error;
          }
        }));
        filesBySlide = Object.fromEntries(valid.filter(
          (entry): entry is readonly [string, string] => entry !== undefined,
        ));
        if (Object.keys(filesBySlide).length === Object.keys(cache.files).length) {
          ensureCurrent();
        }
      }
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) {
        throw error;
      }
    }

    ensureCurrent();
    const requested = Array.from({ length: end - start + 1 }, (_, index) => start + index);
    const missing = requested.filter(slide => !filesBySlide[String(slide)]);
    const runs: number[][] = [];
    for (const slide of missing) {
      const current = runs[runs.length - 1];
      if (current && slide === current[current.length - 1]! + 1) {
        current.push(slide);
      } else {
        runs.push([slide]);
      }
    }

    for (const run of runs) {
      ensureCurrent();
      const [runStart, runEnd] = [run[0]!, run[run.length - 1]!];
      const renderDirectory = join(cacheDirectory, `.render-${randomBytes(8).toString('hex')}`);
      await mkdir(renderDirectory, { recursive: true });
      const outputPath = join(renderDirectory, 'slide.png');
      const range = runStart === runEnd ? String(runStart) : `${runStart}-${runEnd}`;
      const child = spawn(
        process.execPath,
        [
          cli.entryPoint,
          'export',
          await realpath(deckPath),
          '--format',
          'png',
          '--range',
          range,
          '--output',
          outputPath,
        ],
        {
          cwd: await realpath(rootPath),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        },
      );
      this.thumbnailProcess = child;
      const chunks: string[] = [];
      let capturedLength = 0;
      let processError: Error | undefined;
      const capture = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.log(text.trimEnd());
        if (capturedLength < 12_000) {
          chunks.push(text.slice(0, 12_000 - capturedLength));
          capturedLength += text.length;
        }
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.on('error', error => { processError = error; });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolveTimeout, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(
          `Slidev thumbnail export exceeded ${thumbnailTimeoutMs / 60_000} minutes.`,
        )), thumbnailTimeoutMs);
      });
      try {
        const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => {
          child.once('close', (code, signal) => resolveClose({ code, signal }));
        });
        const result = await Promise.race([close, timeout]);
        ensureCurrent();
        if (processError) {
          throw new Error(`Unable to run Slidev PNG export: ${processError.message}`);
        }
        if (result.code !== 0) {
          const detail = outputTail(chunks);
          throw new Error(
            `Slidev PNG export failed (exit code ${result.code ?? result.signal ?? 'unknown'}).${detail ? `\n${detail}` : ''}`,
          );
        }

        const renderedFiles = await collectPngFiles(renderDirectory);
        if (renderedFiles.length !== run.length) {
          throw new Error(
            `Slidev rendered ${renderedFiles.length} thumbnails for requested slides ${range}; expected ${run.length}.`,
          );
        }
        for (const [index, slide] of run.entries()) {
          ensureCurrent();
          const filename = `slide-${slide}.png`;
          await rename(renderedFiles[index]!, join(cacheDirectory, filename));
          filesBySlide[String(slide)] = filename;
        }
      } catch (error) {
        if (this.thumbnailProcess === child) {
          this.thumbnailProcess = undefined;
        }
        await terminate(child);
        await rm(renderDirectory, { recursive: true, force: true });
        throw error;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        if (this.thumbnailProcess === child) {
          this.thumbnailProcess = undefined;
        }
      }
      await rm(renderDirectory, { recursive: true, force: true });
      const cache: CachedThumbnails = {
        version: cli.version,
        slideCount,
        files: filesBySlide,
      };
      ensureCurrent();
      const temporaryMarker = `${markerPath}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporaryMarker, JSON.stringify(cache), 'utf8');
      ensureCurrent();
      await rename(temporaryMarker, markerPath);
    }

    ensureCurrent();
    return requested.map(slide => ({
      slide,
      path: resolve(cacheDirectory, filesBySlide[String(slide)]!),
    }));
  }
}
