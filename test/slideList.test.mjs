import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingSlideIndexes, nextThumbnailRange, visibleSlideWindow } from '../media/slideList.mjs';

test('filters by title, source path, or exact slide number without losing deck indexes', () => {
  const slides = [
    { title: 'Cover', sourcePath: 'slides.md' },
    { title: 'Agent workflows', sourcePath: 'shared/agents.md' },
    { title: 'Code review', sourcePath: 'slides.md' },
  ];
  assert.deepEqual(matchingSlideIndexes(slides, ' AGENT '), [1]);
  assert.deepEqual(matchingSlideIndexes(slides, 'shared/'), [1]);
  assert.deepEqual(matchingSlideIndexes(slides, '3'), [2]);
  assert.deepEqual(matchingSlideIndexes(slides, 'nothing'), []);
  assert.deepEqual(matchingSlideIndexes(slides, ''), [0, 1, 2]);
});

test('bounds virtualized windows for large decks, resizing, and empty results', () => {
  assert.deepEqual(visibleSlideWindow(1000, 50_000, 400, 100), { start: 498, end: 506 });
  assert.deepEqual(visibleSlideWindow(3, 1000, 400, 100), { start: 3, end: 3 });
  assert.deepEqual(visibleSlideWindow(0, 0, 400, 100), { start: 0, end: 0 });
  assert.deepEqual(visibleSlideWindow(100, -10, 200, 100), { start: 0, end: 4 });
});

test('requests uncached, contiguous deck indexes with a maximum of twelve slides', () => {
  assert.deepEqual(nextThumbnailRange([3, 4, 5], []), { start: 4, end: 6 });
  assert.deepEqual(nextThumbnailRange([3, 20, 35], []), { start: 4, end: 4 });
  assert.deepEqual(nextThumbnailRange([3, 4, 5], { 3: 'cached' }), { start: 5, end: 6 });
  assert.deepEqual(nextThumbnailRange([3, 4, 5], { 4: 'cached' }), { start: 4, end: 4 });
  assert.deepEqual(nextThumbnailRange(Array.from({ length: 100 }, (_, i) => i), []), { start: 1, end: 12 });
  assert.equal(nextThumbnailRange([0, 1], ['one', 'two']), undefined);
  assert.equal(nextThumbnailRange([], []), undefined);
});
