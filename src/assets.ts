import { dirname, isAbsolute, relative, sep } from 'node:path';

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const path = relative(rootPath, candidatePath);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function encodePath(path: string): string {
  return path.split(sep).map(encodeURIComponent).join('/');
}

export function getSlidevImageReference(
  rootPath: string,
  deckPath: string,
  assetPath: string,
): string {
  const workspacePath = relative(rootPath, assetPath);
  if (!isWithinRoot(rootPath, assetPath)) {
    throw new Error('The selected asset is outside the presentation workspace.');
  }

  const workspaceSegments = workspacePath.split(sep);
  if (workspaceSegments[0] === 'public') {
    return `/${encodePath(workspaceSegments.slice(1).join(sep))}`;
  }

  const relativePath = relative(dirname(deckPath), assetPath);
  if (isAbsolute(relativePath)) {
    throw new Error('The selected asset cannot be referenced from the active presentation.');
  }
  const encoded = encodePath(relativePath);
  return encoded.startsWith('.') ? encoded : `./${encoded}`;
}

export function getMarkdownImageInsertion(assetPath: string, reference: string): string {
  const filename = assetPath.split(/[\\/]/).pop() ?? 'image';
  const alt = filename.replace(/\.[^.]+$/, '').replace(/[[\]\\]/g, ' ').trim() || 'image';
  return `![${alt}](${reference})`;
}
