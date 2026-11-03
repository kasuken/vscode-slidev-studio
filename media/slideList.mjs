export function matchingSlideIndexes(slides, query) {
  const text = query.trim().toLocaleLowerCase();
  return slides.flatMap((slide, index) => {
    if (!text || String(index + 1) === text
      || slide.title.toLocaleLowerCase().includes(text)
      || slide.sourcePath.toLocaleLowerCase().includes(text)) return [index];
    return [];
  });
}

export function visibleSlideWindow(count, scrollTop, height, rowHeight, overscan = 2) {
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const start = Math.min(count, Math.max(0, first - overscan));
  const end = Math.min(count, Math.max(start + 1, Math.ceil((Math.max(0, scrollTop) + height) / rowHeight) + overscan));
  return { start, end };
}

export function nextThumbnailRange(indexes, thumbnails, limit = 12) {
  const first = indexes.find(index => !thumbnails[index]);
  if (first === undefined) return;
  let last = first;
  for (const index of indexes) {
    if (index <= first) continue;
    if (index !== last + 1 || index - first >= limit || thumbnails[index]) break;
    last = index;
  }
  return { start: first + 1, end: last + 1 };
}
