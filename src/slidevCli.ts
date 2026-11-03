import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const supportedSlidevVersions = ['52.14.2', '53.0.0'] as const;
export const defaultSlidevParserVersion = '53.0.0';

export function isSupportedSlidevVersion(version: string): boolean {
  return supportedSlidevVersions.some(supportedVersion => supportedVersion === version);
}

export async function loadSlidevParser(version?: string) {
  if (version === '52.14.2') {
    const parser = await import('./parser52Adapter.mjs');
    return { ...parser, version };
  }

  const [{ parse }, { parseRangeString }] = await Promise.all([
    import('@slidev/parser/core'),
    import('@slidev/parser/utils'),
  ]);
  return { parse, parseRangeString, version: defaultSlidevParserVersion };
}

export interface SlidevCli {
  version: string;
  entryPoint: string;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function resolveSlidevCli(rootPath: string): Promise<SlidevCli | undefined> {
  const packagePath = join(rootPath, 'node_modules', '@slidev', 'cli', 'package.json');
  let contents: string;
  try {
    contents = await readFile(packagePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }

  const packageJson: unknown = JSON.parse(contents);
  if (
    typeof packageJson !== 'object'
    || packageJson === null
    || !('name' in packageJson)
    || packageJson.name !== '@slidev/cli'
    || !('version' in packageJson)
    || typeof packageJson.version !== 'string'
    || !('bin' in packageJson)
  ) {
    throw new Error('The installed @slidev/cli package has invalid package metadata.');
  }

  const bin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : typeof packageJson.bin === 'object' && packageJson.bin !== null && 'slidev' in packageJson.bin
      ? packageJson.bin.slidev
      : undefined;
  if (typeof bin !== 'string' || !bin.trim()) {
    throw new Error('The installed @slidev/cli package does not expose a Slidev executable.');
  }

  const entryPoint = resolve(dirname(packagePath), bin);
  try {
    return { version: packageJson.version, entryPoint: await realpath(entryPoint) };
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error('The installed @slidev/cli executable could not be found.');
    }
    throw error;
  }
}
