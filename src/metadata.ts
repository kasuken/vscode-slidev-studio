import { isMap, parseDocument } from 'yaml';

export interface DeckMetadata {
  title: string;
  theme?: string;
}

export function readDeckMetadata(source: string, fallbackTitle: string): DeckMetadata | undefined {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return undefined;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) {
    throw new Error('Opening YAML headmatter has no closing delimiter.');
  }
  const document = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map(error => error.message).join('\n'));
  }
  if (!isMap(document.contents)) {
    throw new Error('Deck headmatter must be a YAML mapping.');
  }
  const title = document.get('title');
  const theme = document.get('theme');
  // Only inspect the cover body; a later slide's heading is not the deck title.
  const body = lines.slice(end + 1);
  const nextSeparator = body.findIndex(line => line.trim() === '---');
  const cover = nextSeparator === -1 ? body : body.slice(0, nextSeparator);
  const heading = cover.find(line => /^#\s+\S/.test(line))?.replace(/^#\s+/, '').trim();
  return {
    title: typeof title === 'string' && title.trim() ? title.trim() : heading || fallbackTitle,
    ...(typeof theme === 'string' ? { theme } : {}),
  };
}
