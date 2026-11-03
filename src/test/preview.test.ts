import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlidevPreviewSession } from '../preview';
import { readInstalledSlidevVersion } from '../sourceGraph';

async function createFakeSlidev(
  rootPath: string,
  version = '53.0.0',
  exportDelayMs = 0,
  host = '127.0.0.1',
): Promise<string> {
  const packagePath = join(rootPath, 'node_modules', '@slidev', 'cli');
  await mkdir(packagePath, { recursive: true });
  const entryPoint = join(packagePath, 'slidev.mjs');
  await writeFile(join(packagePath, 'package.json'), JSON.stringify({
    name: '@slidev/cli',
    version,
    bin: { slidev: 'slidev.mjs' },
  }));
  await writeFile(entryPoint, `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
const args = process.argv.slice(2);
if (args[0] === 'export') {
  const output = args[args.indexOf('--output') + 1];
  const format = args[args.indexOf('--format') + 1];
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(process.cwd(), 'export-args.txt'), JSON.stringify(args) + '\\n');
  if (format === 'png' && args.includes('--range')) {
    const range = args[args.indexOf('--range') + 1];
    appendFileSync(join(process.cwd(), 'export-runs.txt'), range + '\\n');
    const [start, end = start] = range.split('-').map(Number);
    for (let slide = start; slide <= end; slide++) {
      writeFileSync(join(directory, 'slide-' + slide + '.png'), Buffer.from([137, 80, 78, 71]));
    }
  } else {
    writeFileSync(output, Buffer.from(format));
  }
  await new Promise(resolve => setTimeout(resolve, ${exportDelayMs}));
  process.exit(0);
} else {
  appendFileSync(join(process.cwd(), 'preview-args.txt'), JSON.stringify(args) + '\\n');
  const port = Number(args[args.indexOf('--port') + 1]);
  const server = createServer((_request, response) => response.end('Slidev preview'));
  server.listen(port, ${JSON.stringify(host)});
}
`);
  return entryPoint;
}

test('starts the local Slidev CLI on an allocated loopback port and stops it', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-preview-'));
  const session = new SlidevPreviewSession();
  try {
    await createFakeSlidev(rootPath);
    const deckPath = join(rootPath, 'slides.md');
    await writeFile(deckPath, '# Preview fixture');

    const preview = await session.startServer(rootPath, deckPath);
    assert.match(preview.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(await (await fetch(preview.url)).text(), 'Slidev preview');

    await session.stop();
    await assert.rejects(fetch(preview.url));
  } finally {
    await session.stop();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('starts the supported Slidev 52.14.2 CLI on loopback', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-preview-v52-'));
  const session = new SlidevPreviewSession();
  try {
    await createFakeSlidev(rootPath, '52.14.2', 0, 'localhost');
    const deckPath = join(rootPath, 'slides.md');
    await writeFile(deckPath, '# Slidev 52 preview fixture');

    const preview = await session.startServer(rootPath, deckPath);
    assert.match(preview.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(await (await fetch(preview.url)).text(), 'Slidev preview');
    const args = JSON.parse((await readFile(join(rootPath, 'preview-args.txt'), 'utf8')).trim()) as string[];
    assert.equal(args.includes('--remote'), false);
    await session.stop();

    const outputPath = join(rootPath, 'slides.pdf');
    await session.exportDeck(rootPath, deckPath, outputPath, 'pdf');
    assert.equal(await readFile(outputPath, 'utf8'), 'pdf');
  } finally {
    await session.stop();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('exports a deck with argument-safe paths and reports supported formats', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-export-'));
  const session = new SlidevPreviewSession();
  try {
    await createFakeSlidev(rootPath);
    const deckPath = join(rootPath, 'slides.md');
    const outputPath = join(rootPath, 'output folder', 'my talk.pptx');
    await writeFile(deckPath, '# Export fixture');

    await session.exportDeck(rootPath, deckPath, outputPath, 'pptx');

    assert.equal(await readFile(outputPath, 'utf8'), 'pptx');
    const args = JSON.parse((await readFile(join(rootPath, 'export-args.txt'), 'utf8')).trim()) as string[];
    assert.ok(args.includes('--format') && args[args.indexOf('--format') + 1] === 'pptx');
    assert.ok(args.includes('--output') && args[args.indexOf('--output') + 1] === outputPath);
  } finally {
    await session.stop();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('exports PNG slides into a new directory within the selected folder', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-export-png-'));
  const session = new SlidevPreviewSession();
  try {
    await createFakeSlidev(rootPath);
    const deckPath = join(rootPath, 'slides.md');
    await writeFile(deckPath, '# PNG export fixture');

    const outputDirectory = await session.exportDeck(rootPath, deckPath, rootPath, 'png');

    assert.ok(outputDirectory.startsWith(rootPath));
    assert.deepEqual((await readdir(outputDirectory)).sort(), ['slide.png']);
  } finally {
    await session.stop();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('cancels a running presentation export', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-export-cancel-'));
  const session = new SlidevPreviewSession();
  try {
    await createFakeSlidev(rootPath, '53.0.0', 5000);
    const deckPath = join(rootPath, 'slides.md');
    const outputPath = join(rootPath, 'slides.pdf');
    await writeFile(deckPath, '# Export fixture');
    const pending = session.exportDeck(rootPath, deckPath, outputPath, 'pdf');
    const cancellation = assert.rejects(pending, /cancelled/);
    const deadline = Date.now() + 5000;
    let started = false;
    while (Date.now() < deadline) {
      try {
        await stat(join(rootPath, 'export-args.txt'));
        started = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    assert.equal(started, true);
    await session.cancelExport();
    await cancellation;
  } finally {
    await session.stop();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('detects the workspace-local @slidev/cli package used by the adapter', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-cli-'));
  try {
    assert.equal(await readInstalledSlidevVersion(rootPath), undefined);
    await createFakeSlidev(rootPath);
    assert.equal(await readInstalledSlidevVersion(rootPath), '53.0.0');
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('exports requested ranges first and reuses per-slide cached thumbnails', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-thumbnails-'));
  const session = new SlidevPreviewSession();
  try {
    await createFakeSlidev(rootPath);
    const deckPath = join(rootPath, 'slides.md');
    await writeFile(deckPath, '# Thumbnail fixture');
    const fingerprint = 'a'.repeat(64);

    const first = await session.captureThumbnails(rootPath, deckPath, rootPath, fingerprint, 4, 5, 100);
    const second = await session.captureThumbnails(rootPath, deckPath, rootPath, fingerprint, 4, 5, 100);
    assert.deepEqual(second, first);
    assert.deepEqual(first.map(file => file.slide), [4, 5]);
    assert.deepEqual(first.map(file => file.path.split(/[\\/]/).pop()), ['slide-4.png', 'slide-5.png']);

    const overlapping = await session.captureThumbnails(rootPath, deckPath, rootPath, fingerprint, 5, 7, 100);
    assert.deepEqual(overlapping.map(file => file.slide), [5, 6, 7]);
    assert.equal(
      await readFile(join(rootPath, 'export-runs.txt'), 'utf8'),
      '4-5\n6-7\n',
    );

    await session.invalidateThumbnails();
    const afterInvalidation = await session.captureThumbnails(rootPath, deckPath, rootPath, fingerprint, 4, 5, 100);
    assert.equal(afterInvalidation.length, 2);
    assert.equal((await readFile(join(rootPath, 'export-runs.txt'), 'utf8')).split('\n').filter(Boolean).length, 3);
  } finally {
    await session.stop();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('cancels a running thumbnail export when the viewport changes', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-cancel-'));
  const session = new SlidevPreviewSession();
  try {
    await createFakeSlidev(rootPath, '53.0.0', 5000);
    const deckPath = join(rootPath, 'slides.md');
    await writeFile(deckPath, '# Thumbnail fixture');
    const fingerprint = 'b'.repeat(64);
    const pending = session.captureThumbnails(rootPath, deckPath, rootPath, fingerprint, 2, 3, 10);
    const cancellation = assert.rejects(pending, /cancelled/);
    const runsPath = join(rootPath, 'export-runs.txt');
    const deadline = Date.now() + 5000;
    let started = false;
    while (Date.now() < deadline) {
      try {
        await readFile(runsPath, 'utf8');
        started = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    assert.equal(started, true);
    await session.cancelThumbnailExport();
    await cancellation;
  } finally {
    await session.stop();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('refuses unsupported Slidev versions and invalid cache fingerprints', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-version-'));
  const session = new SlidevPreviewSession();
  try {
    const deckPath = join(rootPath, 'slides.md');
    await createFakeSlidev(rootPath, '52.6.0');
    await writeFile(deckPath, '# Unsupported fixture');

    await assert.rejects(
      session.startServer(rootPath, deckPath),
      /Slidev 52\.6\.0 is unsupported/,
    );
    await assert.rejects(
      session.captureThumbnails(rootPath, deckPath, rootPath, '../invalid', 1, 1, 1),
      /fingerprint is invalid/,
    );
    await assert.rejects(
      session.captureThumbnails(rootPath, deckPath, rootPath, 'c'.repeat(64), 1, 13, 20),
      /between 1 and 12 valid slides/,
    );
  } finally {
    await session.stop();
    await rm(rootPath, { recursive: true, force: true });
  }
});
