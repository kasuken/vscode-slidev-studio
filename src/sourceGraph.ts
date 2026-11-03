import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  defaultSlidevParserVersion,
  isSupportedSlidevVersion,
  loadSlidevParser,
  resolveSlidevCli,
  supportedSlidevVersions,
} from './slidevCli';

interface SourceSlide {
  filepath: string;
  index: number;
  start: number;
  contentStart: number;
  end: number;
  raw: string;
  title?: string;
  frontmatter: Record<string, unknown>;
}

interface ParsedMarkdown {
  filepath: string;
  raw: string;
  slides: SourceSlide[];
  errors?: { row: number; message: string }[];
}

export interface SlideOccurrence {
  id: string;
  title: string;
  deckIndex: number;
  sourceIndex: number;
  sourcePath: string;
  line: number;
  imported: boolean;
  importChain: string[];
  importReferencePath?: string;
  importReferenceIndex?: number;
  importReferenceTitle?: string;
  importReferenceLine?: number;
  effectiveFrontmatter: Record<string, unknown>;
  usageCount: number;
  canNavigate: boolean;
  readOnlyReason?: string;
}

export interface DeckSourceGraph {
  slides: SlideOccurrence[];
  diagnostics: string[];
  fingerprint: string;
  renderedMappingAvailable: boolean;
}

interface SourceGraphOptions {
  customPreparser?: boolean;
  slidevVersion?: string;
  entryMarkdown?: string;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function getSourceLine(source: { start: number; contentStart: number; raw: string }): number {
  const rawLines = source.raw.split(/\r?\n/);
  let contentOffset = Math.max(0, source.contentStart - source.start);
  while (contentOffset < rawLines.length && !rawLines[contentOffset]?.trim()) {
    contentOffset++;
  }
  return source.start + contentOffset + 1;
}

export async function readInstalledSlidevVersion(rootPath: string): Promise<string | undefined> {
  return (await resolveSlidevCli(rootPath))?.version;
}

export async function buildDeckSourceGraph(
  deckPath: string,
  rootPath: string,
  options: SourceGraphOptions = {},
): Promise<DeckSourceGraph> {
  const absoluteRootPath = await realpath(rootPath);
  const diagnostics: string[] = [];
  const readOnlyReasons: string[] = [];

  if (options.customPreparser) {
    diagnostics.push(
      'Source-outline mode: a custom Slidev preparser is present. Studio navigates and edits original Markdown without executing it. Rendered slide order is unverified; per-slide preview synchronization and thumbnails are disabled.',
    );
  }

  if (options.slidevVersion) {
    if (!isSupportedSlidevVersion(options.slidevVersion)) {
      readOnlyReasons.push(
        `Slidev ${options.slidevVersion} is unsupported; source mapping supports ${supportedSlidevVersions.join(' and ')}.`,
      );
    }
  } else {
    diagnostics.push(
      `No workspace Slidev installation was found. Source mapping uses the pinned @slidev/parser ${defaultSlidevParserVersion} and is not verified against a workspace renderer.`,
    );
  }

  const readOnlyReason = readOnlyReasons.join(' ');
  const renderedMappingAvailable = !options.customPreparser && !readOnlyReason;
  const parser = await loadSlidevParser(options.slidevVersion);
  const parsedFiles = new Map<string, ParsedMarkdown>();
  const occurrences: {
    source: SourceSlide;
    importChain: SourceSlide[];
    effectiveFrontmatter: Record<string, unknown>;
  }[] = [];

  const pathKey = (path: string) => {
    const resolved = resolve(path);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  const pathLabel = (path: string) => relative(absoluteRootPath, path) || path;

  async function loadMarkdown(
    path: string,
    range?: string,
    frontmatterOverride: Record<string, unknown> = {},
    importChain: SourceSlide[] = [],
    importer?: SourceSlide,
  ): Promise<void> {
    let actualPath: string;
    try {
      actualPath = await realpath(path);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        const prefix = importer ? `${pathLabel(importer.filepath)}:${importer.start + 1}: ` : '';
        diagnostics.push(`${prefix}Imported markdown file not found: ${pathLabel(path)}`);
        return;
      }
      throw error;
    }

    if (!isWithinRoot(absoluteRootPath, actualPath)) {
      const prefix = importer ? `${pathLabel(importer.filepath)}:${importer.start + 1}: ` : '';
      diagnostics.push(`${prefix}Imported Markdown resolves outside the workspace folder.`);
      return;
    }

    const key = pathKey(actualPath);
    let markdown = parsedFiles.get(key);
    if (!markdown) {
      const raw = options.entryMarkdown !== undefined && key === pathKey(resolve(deckPath))
        ? options.entryMarkdown
        : await readFile(actualPath, 'utf8');
      markdown = await parser.parse(raw, actualPath);
      parsedFiles.set(key, markdown);
    }

    const slides = range === undefined
      ? markdown.slides.map((_, index) => index + 1)
      : parser.parseRangeString(markdown.slides.length, range);
    for (const index of slides) {
      const source = markdown.slides[index - 1];
      if (!source) {
        diagnostics.push(
          `${pathLabel(actualPath)}: Slide ${index} does not exist; this file has ${markdown.slides.length} slides.`,
        );
        continue;
      }
      await loadSlide(source, frontmatterOverride, importChain);
    }
  }

  async function loadSlide(
    source: SourceSlide,
    frontmatterOverride: Record<string, unknown>,
    importChain: SourceSlide[],
  ): Promise<void> {
    if (source.frontmatter.disabled || source.frontmatter.hide) {
      return;
    }

    const sourcePath = source.frontmatter.src;
    if (sourcePath !== undefined) {
      if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
        diagnostics.push(`${pathLabel(source.filepath)}:${source.start + 1}: Slide src must be a non-empty string.`);
        return;
      }
      if (/%[^%\r\n]+%/.test(sourcePath)) {
        diagnostics.push(
          `${pathLabel(source.filepath)}:${source.start + 1}: unresolved environment placeholder in slide src; it was not evaluated.`,
        );
        return;
      }

      const selectorIndex = sourcePath.indexOf('#');
      const rawPath = selectorIndex === -1 ? sourcePath : sourcePath.slice(0, selectorIndex);
      const range = selectorIndex === -1 ? undefined : sourcePath.slice(selectorIndex + 1);
      if (!rawPath.trim()) {
        diagnostics.push(`${pathLabel(source.filepath)}:${source.start + 1}: Imported Markdown path is empty.`);
        return;
      }
      const targetPath = resolve(
        rawPath.startsWith('/')
          ? absoluteRootPath
          : dirname(source.filepath),
        rawPath.startsWith('/') ? rawPath.slice(1) : rawPath,
      );
      if (!isWithinRoot(absoluteRootPath, targetPath)) {
        diagnostics.push(`${pathLabel(source.filepath)}:${source.start + 1}: Imported Markdown escapes the workspace folder.`);
        return;
      }

      let actualTarget: string;
      try {
        actualTarget = await realpath(targetPath);
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          diagnostics.push(
            `${pathLabel(source.filepath)}:${source.start + 1}: Imported markdown file not found: ${pathLabel(targetPath)}`,
          );
          return;
        }
        throw error;
      }
      if (!isWithinRoot(absoluteRootPath, actualTarget)) {
        diagnostics.push(`${pathLabel(source.filepath)}:${source.start + 1}: Imported Markdown resolves outside the workspace folder.`);
        return;
      }

      const ancestors = new Set(importChain.map(slide => pathKey(slide.filepath)));
      if (pathKey(actualTarget) === pathKey(source.filepath) || ancestors.has(pathKey(actualTarget))) {
        diagnostics.push(`${pathLabel(source.filepath)}:${source.start + 1}: Circular import detected for "${sourcePath}".`);
        return;
      }

      const nextOverride = { ...source.frontmatter, ...frontmatterOverride };
      delete nextOverride.src;
      await loadMarkdown(
        actualTarget,
        range,
        nextOverride,
        [...importChain, source],
        source,
      );
      return;
    }

    occurrences.push({
      source,
      importChain,
      effectiveFrontmatter: { ...source.frontmatter, ...frontmatterOverride },
    });
  }

  await loadMarkdown(resolve(deckPath));
  for (const markdown of parsedFiles.values()) {
    const path = relative(absoluteRootPath, markdown.filepath) || markdown.filepath;
    for (const error of markdown.errors ?? []) {
      diagnostics.push(`${path}:${error.row + 1}: ${error.message}`);
    }
    if (/%[^%\r\n]+%/.test(markdown.raw)) {
      diagnostics.push(`${path}: environment placeholders are left unresolved and are never evaluated.`);
    }
  }

  const identity = (path: string, index: number) => `${pathKey(path)}#${index}`;
  const usageCounts = new Map<string, number>();
  for (const occurrence of occurrences) {
    const key = identity(occurrence.source.filepath, occurrence.source.index);
    usageCounts.set(key, (usageCounts.get(key) ?? 0) + 1);
  }

  const slides = occurrences.map((occurrence, index): SlideOccurrence => {
    const importReference = occurrence.importChain[0];
    return {
      id: randomBytes(16).toString('hex'),
      title: occurrence.source.title?.trim() || `Slide ${occurrence.source.index + 1}`,
      deckIndex: index + 1,
      sourceIndex: occurrence.source.index + 1,
      sourcePath: pathLabel(occurrence.source.filepath),
      line: getSourceLine(occurrence.source),
      imported: occurrence.importChain.length > 0,
      importChain: occurrence.importChain.map(source => pathLabel(source.filepath)),
      ...(importReference
        ? {
            importReferencePath: pathLabel(importReference.filepath),
            importReferenceIndex: importReference.index + 1,
            importReferenceTitle: importReference.title?.trim() || `Slide ${importReference.index + 1}`,
            importReferenceLine: getSourceLine(importReference),
          }
        : {}),
      effectiveFrontmatter: occurrence.effectiveFrontmatter,
      usageCount: usageCounts.get(identity(occurrence.source.filepath, occurrence.source.index)) ?? 1,
      canNavigate: !readOnlyReason,
      ...(readOnlyReason ? { readOnlyReason } : {}),
    };
  });

  if (readOnlyReason) {
    diagnostics.push(readOnlyReason);
  }

  const fingerprint = createHash('sha256')
    .update(`slidev-parser-${parser.version}\0`)
    .update(options.customPreparser ? 'source-outline\0' : 'rendered\0')
    .update(pathKey(resolve(deckPath)))
    .update('\0')
    .update([...parsedFiles.values()]
      .sort((left, right) => left.filepath.localeCompare(right.filepath))
      .map(markdown => `${pathKey(markdown.filepath)}\0${markdown.raw}`)
      .join('\0'))
    .digest('hex');
  return { slides, diagnostics, fingerprint, renderedMappingAvailable };
}
