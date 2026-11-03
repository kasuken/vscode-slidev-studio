export type SlideMoveDirection = -1 | 1;

export interface SlideEditResult {
  text: string;
  selectedSourceIndex: number;
}

export interface ExpectedSlide {
  title: string;
  line: number;
}

interface ParsedDeck {
  slides: Array<{
    start: number;
    contentStart: number;
    raw: string;
    title?: string;
    frontmatter: Record<string, unknown>;
  }>;
  blocks: string[];
  blockOffsets: number[];
}

export interface SlideNoteLocation {
  externalPath?: string;
  start: number;
  end: number;
  insertion?: { offset: number; text: string };
  selectionStart?: number;
}

function getSourceLine(source: { start: number; contentStart: number; raw: string }): number {
  const rawLines = source.raw.split(/\r?\n/);
  let contentOffset = Math.max(0, source.contentStart - source.start);
  while (contentOffset < rawLines.length && !rawLines[contentOffset]?.trim()) {
    contentOffset++;
  }
  return source.start + contentOffset + 1;
}

function getLineOffset(text: string, line: number): number {
  let offset = 0;
  for (let current = 0; current < line; current++) {
    const newline = text.indexOf('\n', offset);
    if (newline === -1) {
      return text.length;
    }
    offset = newline + 1;
  }
  return offset;
}

async function parseDeck(text: string): Promise<ParsedDeck> {
  const { parseSync } = await import('@slidev/parser/core');
  const slides = parseSync(text, 'slides.md').slides;
  const lines = text.split(/\r?\n/);
  const blockStarts = slides.map((slide, slideIndex) => {
    if (
      slideIndex > 0
      && slide.contentStart === slide.start
      && lines[slide.start - 1]?.trimEnd() === '---'
    ) {
      return slide.start - 1;
    }
    return slide.start;
  });
  if (blockStarts[0] !== 0 || blockStarts.some((start, index) => index > 0 && start <= blockStarts[index - 1]!)) {
    throw new Error('Slide source boundaries are ambiguous; this deck cannot be safely edited.');
  }
  const blockOffsets = blockStarts.map(start => getLineOffset(text, start));
  const blocks = blockOffsets.map((startOffset, index) => {
    const endOffset = getLineOffset(text, blockStarts[index + 1] ?? lines.length);
    return text.slice(startOffset, endOffset);
  });
  return { slides, blocks, blockOffsets };
}

function assertEditableSlide(
  parsed: ParsedDeck,
  sourceIndex: number,
  expected?: ExpectedSlide,
): number {
  const index = sourceIndex - 1;
  if (!Number.isSafeInteger(sourceIndex) || index < 0 || index >= parsed.slides.length) {
    throw new Error('The slide is no longer available. Refresh the deck and try again.');
  }
  const slide = parsed.slides[index];
  if (!slide) {
    throw new Error('The slide is no longer available. Refresh the deck and try again.');
  }
  if (
    expected
    && (
      (slide.title?.trim() || `Slide ${sourceIndex}`) !== expected.title
      || getSourceLine(slide) !== expected.line
    )
  ) {
    throw new Error('The deck changed since this slide list was built. Refresh the deck and try again.');
  }
  if (slide.frontmatter.src !== undefined || slide.frontmatter.hide || slide.frontmatter.disabled) {
    throw new Error('Only local, visible slides can be edited.');
  }
  return index;
}

function getEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function ensureTrailingEol(block: string, eol: string): string {
  return block.endsWith('\n') ? block : `${block}${eol}`;
}

function findYamlComment(value: string): number {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote === '"') {
      if (character === '\\') {
        index++;
      } else if (character === '"') {
        quote = undefined;
      }
    } else if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") {
        index++;
      } else if (character === "'") {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#' && (index === 0 || /\s/.test(value[index - 1]!))) {
      return index;
    }
  }
  return -1;
}

export async function locateLocalSlideNotes(
  text: string,
  sourceIndex: number,
  expected?: ExpectedSlide,
): Promise<SlideNoteLocation> {
  const parsed = await parseDeck(text);
  const index = assertEditableSlide(parsed, sourceIndex, expected);
  const slide = parsed.slides[index]!;
  if (slide.frontmatter._note !== undefined) {
    if (typeof slide.frontmatter._note !== 'string' || !slide.frontmatter._note.trim()) {
      throw new Error('The slide _note value must be a non-empty local file path.');
    }
    return { externalPath: slide.frontmatter._note.trim(), start: 0, end: 0 };
  }

  const block = parsed.blocks[index]!;
  const blockOffset = parsed.blockOffsets[index]!;
  const comments = Array.from(block.matchAll(/<!--([\s\S]*?)-->/g));
  const finalComment = comments.at(-1);
  if (
    finalComment?.index !== undefined
    && block.slice(finalComment.index + finalComment[0].length).trim() === ''
  ) {
    const start = blockOffset + finalComment.index + 4;
    return { start, end: start + finalComment[1]!.length };
  }

  const trailingWhitespace = /(?:\r?\n)*$/.exec(block)?.[0] ?? '';
  const offset = blockOffset + block.length - trailingWhitespace.length;
  const eol = getEol(text);
  const content = block.slice(0, block.length - trailingWhitespace.length);
  const prefix = content && !content.endsWith('\n') ? eol : '';
  const insertion = `${prefix}<!--${eol}${eol}-->${eol}`;
  return {
    start: offset + prefix.length + 4 + eol.length,
    end: offset + prefix.length + 4 + eol.length,
    insertion: { offset, text: insertion },
    selectionStart: offset + prefix.length + 4 + eol.length,
  };
}

export async function setLocalSlideLayout(
  text: string,
  sourceIndex: number,
  layout: string,
  expected?: ExpectedSlide,
): Promise<string> {
  if (!/^[\w.-]+$/.test(layout) || layout === '.' || layout === '..') {
    throw new Error('The selected layout name is invalid.');
  }
  const parsed = await parseDeck(text);
  const index = assertEditableSlide(parsed, sourceIndex, expected);
  const slide = parsed.slides[index]!;
  const blocks = [...parsed.blocks];
  const block = blocks[index]!;
  const eol = getEol(text);

  if (slide.contentStart === slide.start) {
    if (block.startsWith('---')) {
      const firstLineEnd = block.indexOf('\n');
      if (firstLineEnd === -1) {
        throw new Error('The slide separator is incomplete; the layout cannot be added safely.');
      }
      const lineEol = block.slice(Math.max(0, firstLineEnd - 1), firstLineEnd + 1) === '\r\n' ? '\r\n' : '\n';
      blocks[index] = `---${lineEol}layout: ${layout}${lineEol}---${lineEol}${block.slice(firstLineEnd + 1)}`;
    } else {
      blocks[index] = `---${eol}layout: ${layout}${eol}---${eol}${block}`;
    }
    return blocks.join('');
  }

  const frontmatterMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---(?=\r?\n|$))/.exec(block);
  if (!frontmatterMatch) {
    throw new Error('Slide frontmatter boundaries are ambiguous; this slide cannot be safely edited.');
  }
  const frontmatter = frontmatterMatch[2]!;
  const layoutLines = Array.from(frontmatter.matchAll(/^layout\s*:(.*?)(\r?)$/gm));
  if (layoutLines.length > 1) {
    throw new Error('The slide has duplicate layout entries; resolve them in the source before editing.');
  }
  if (layoutLines.length === 1) {
    const existing = layoutLines[0]!;
    const value = existing[1] ?? '';
    const commentIndex = findYamlComment(value);
    const comment = commentIndex >= 0 ? ` ${value.slice(commentIndex).trimStart()}` : '';
    const replacement = `layout: ${layout}${comment}${existing[2] ?? ''}`;
    const lineOffset = existing.index!;
    const updatedFrontmatter = frontmatter.slice(0, lineOffset)
      + replacement
      + frontmatter.slice(lineOffset + existing[0].length);
    blocks[index] = frontmatterMatch[1] + updatedFrontmatter + frontmatterMatch[3] + block.slice(frontmatterMatch[0].length);
  } else {
    const eol = frontmatterMatch[3]!.startsWith('\r\n') ? '\r\n' : '\n';
    const updatedFrontmatter = frontmatter
      ? `${frontmatter}${eol}layout: ${layout}`
      : `layout: ${layout}`;
    blocks[index] = frontmatterMatch[1] + updatedFrontmatter + frontmatterMatch[3] + block.slice(frontmatterMatch[0].length);
  }
  return blocks.join('');
}

export async function moveLocalSlide(
  text: string,
  sourceIndex: number,
  direction: SlideMoveDirection,
  expected?: ExpectedSlide,
): Promise<string> {
  const parsed = await parseDeck(text);
  const slides = parsed.slides;
  const index = sourceIndex - 1;
  const targetIndex = index + direction;
  if (!Number.isSafeInteger(sourceIndex) || index < 1 || targetIndex < 1 || targetIndex >= slides.length) {
    throw new Error('The cover slide cannot be moved, and the requested position is outside the deck.');
  }

  const moving = slides[index];
  const target = slides[targetIndex];
  if (!moving || !target) {
    throw new Error('The slide is no longer available. Refresh the deck and try again.');
  }
  assertEditableSlide(parsed, sourceIndex, expected);
  if (target.frontmatter.src !== undefined || target.frontmatter.hide || target.frontmatter.disabled) {
    throw new Error('Only adjacent local, visible slides can be reordered.');
  }

  const blocks = parsed.blocks;
  [blocks[index], blocks[targetIndex]] = [blocks[targetIndex]!, blocks[index]!];
  return blocks.join('');
}

export async function moveLocalSlideTo(
  text: string,
  sourceIndex: number,
  targetIndex: number,
  expected?: ExpectedSlide,
): Promise<string> {
  const parsed = await parseDeck(text);
  const target = targetIndex - 1;
  if (
    !Number.isSafeInteger(sourceIndex)
    || sourceIndex < 2
    || !Number.isSafeInteger(targetIndex)
    || target < 1
    || target >= parsed.slides.length
  ) {
    throw new Error('The cover slide cannot be moved, and the requested position is outside the deck.');
  }
  const source = assertEditableSlide(parsed, sourceIndex, expected);
  if (source === target) {
    return text;
  }

  const first = Math.min(source, target);
  const last = Math.max(source, target);
  for (let index = first; index <= last; index++) {
    assertEditableSlide(parsed, index + 1);
  }

  const blocks = [...parsed.blocks];
  const [moving] = blocks.splice(source, 1);
  if (moving === undefined) {
    throw new Error('The slide is no longer available. Refresh the deck and try again.');
  }
  blocks.splice(target, 0, moving);
  return blocks.join('');
}

export async function addLocalSlideAfter(
  text: string,
  sourceIndex: number,
  expected?: ExpectedSlide,
): Promise<SlideEditResult> {
  const parsed = await parseDeck(text);
  const index = assertEditableSlide(parsed, sourceIndex, expected);
  const blocks = [...parsed.blocks];
  const eol = getEol(text);
  blocks[index] = ensureTrailingEol(blocks[index]!, eol);
  blocks.splice(index + 1, 0, `---${eol}${eol}# New slide${eol}`);
  return { text: blocks.join(''), selectedSourceIndex: sourceIndex + 1 };
}

export async function duplicateLocalSlide(
  text: string,
  sourceIndex: number,
  expected?: ExpectedSlide,
): Promise<SlideEditResult> {
  const parsed = await parseDeck(text);
  const index = assertEditableSlide(parsed, sourceIndex, expected);
  if (index === 0) {
    throw new Error('The cover slide cannot be duplicated.');
  }
  const blocks = [...parsed.blocks];
  blocks.splice(index + 1, 0, blocks[index]!);
  return { text: blocks.join(''), selectedSourceIndex: sourceIndex + 1 };
}

export async function deleteLocalSlide(
  text: string,
  sourceIndex: number,
  expected?: ExpectedSlide,
): Promise<SlideEditResult> {
  const parsed = await parseDeck(text);
  const index = assertEditableSlide(parsed, sourceIndex, expected);
  if (index === 0) {
    throw new Error('The cover slide cannot be deleted.');
  }
  const blocks = [...parsed.blocks];
  blocks.splice(index, 1);
  return {
    text: blocks.join(''),
    selectedSourceIndex: Math.min(sourceIndex, blocks.length),
  };
}

export async function removeImportedSlideReference(
  text: string,
  sourceIndex: number,
  expected?: ExpectedSlide,
): Promise<SlideEditResult> {
  const parsed = await parseDeck(text);
  const index = sourceIndex - 1;
  if (!Number.isSafeInteger(sourceIndex) || index < 0 || index >= parsed.slides.length) {
    throw new Error('The imported slide reference is no longer available. Refresh the deck and try again.');
  }
  const reference = parsed.slides[index];
  if (!reference) {
    throw new Error('The imported slide reference is no longer available. Refresh the deck and try again.');
  }
  if (
    expected
    && (
      (reference.title?.trim() || `Slide ${sourceIndex}`) !== expected.title
      || getSourceLine(reference) !== expected.line
    )
  ) {
    throw new Error('The deck changed since this slide list was built. Refresh the deck and try again.');
  }
  if (index === 0) {
    throw new Error('The cover reference cannot be removed.');
  }
  if (typeof reference.frontmatter.src !== 'string' || !reference.frontmatter.src.trim()) {
    throw new Error('The selected source block is not an imported slide reference.');
  }
  if (reference.frontmatter.hide || reference.frontmatter.disabled) {
    throw new Error('Hidden or disabled import references cannot be removed from the slide list.');
  }

  const blocks = [...parsed.blocks];
  blocks.splice(index, 1);
  return {
    text: blocks.join(''),
    selectedSourceIndex: Math.max(1, sourceIndex - 1),
  };
}

export async function duplicateImportedSlideReference(
  text: string,
  sourceIndex: number,
  expected?: ExpectedSlide,
): Promise<SlideEditResult> {
  const parsed = await parseDeck(text);
  const index = sourceIndex - 1;
  const reference = parsed.slides[index];
  if (!Number.isSafeInteger(sourceIndex) || index < 0 || !reference) {
    throw new Error('The imported slide reference is no longer available. Refresh the deck and try again.');
  }
  if (
    expected
    && (
      (reference.title?.trim() || `Slide ${sourceIndex}`) !== expected.title
      || getSourceLine(reference) !== expected.line
    )
  ) {
    throw new Error('The deck changed since this slide list was built. Refresh the deck and try again.');
  }
  if (index === 0) {
    throw new Error('The cover reference cannot be duplicated.');
  }
  if (typeof reference.frontmatter.src !== 'string' || !reference.frontmatter.src.trim()) {
    throw new Error('The selected source block is not an imported slide reference.');
  }
  if (reference.frontmatter.hide || reference.frontmatter.disabled) {
    throw new Error('Hidden or disabled import references cannot be duplicated.');
  }

  const blocks = [...parsed.blocks];
  blocks.splice(index + 1, 0, blocks[index]!);
  return { text: blocks.join(''), selectedSourceIndex: sourceIndex + 1 };
}

export async function moveDeckSlideBlockTo(
  text: string,
  sourceIndex: number,
  targetIndex: number,
  expectedSource?: ExpectedSlide,
  expectedTarget?: ExpectedSlide,
): Promise<string> {
  const parsed = await parseDeck(text);
  const source = sourceIndex - 1;
  const target = targetIndex - 1;
  if (
    !Number.isSafeInteger(sourceIndex)
    || !Number.isSafeInteger(targetIndex)
    || source < 1
    || target < 1
    || source >= parsed.slides.length
    || target >= parsed.slides.length
  ) {
    throw new Error('The cover block cannot be moved, and the requested position is outside the deck.');
  }
  const moving = parsed.slides[source];
  const targetSlide = parsed.slides[target];
  if (!moving || !targetSlide) {
    throw new Error('The selected slide block is no longer available. Refresh the deck and try again.');
  }
  for (const [slide, index, expected] of [
    [moving, sourceIndex, expectedSource],
    [targetSlide, targetIndex, expectedTarget],
  ] as const) {
    if (
      expected
      && (
        (slide.title?.trim() || `Slide ${index}`) !== expected.title
        || getSourceLine(slide) !== expected.line
      )
    ) {
      throw new Error('The deck changed since this slide list was built. Refresh the deck and try again.');
    }
    if (slide.frontmatter.hide || slide.frontmatter.disabled) {
      throw new Error('Hidden or disabled slide blocks cannot be reordered.');
    }
  }
  if (source === target) return text;

  const blocks = [...parsed.blocks];
  const [block] = blocks.splice(source, 1);
  if (block === undefined) {
    throw new Error('The selected slide block is no longer available. Refresh the deck and try again.');
  }
  blocks.splice(target, 0, block);
  return blocks.join('');
}
