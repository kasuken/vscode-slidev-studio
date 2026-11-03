import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readDeckMetadata } from '../metadata';

test('reads deck title and a private theme without executing project code', () => {
  assert.deepEqual(readDeckMetadata('---\ntitle: My deck\ntheme: "@example/theme"\n---\n# Cover', 'fallback'), {
    title: 'My deck', theme: '@example/theme',
  });
});

test('supports BOM and Windows line endings', () => {
  assert.deepEqual(readDeckMetadata('\uFEFF---\r\nlayout: cover\r\n---\r\n# Windows deck\r\n', 'fallback'), {
    title: 'Windows deck',
  });
});

test('uses only the cover heading and falls back to the file name', () => {
  assert.deepEqual(readDeckMetadata('---\nlayout: cover\n---\nCover without heading\n\n---\n# Later slide', 'slides_demo.md'), {
    title: 'slides_demo.md',
  });
});

test('does not discover ordinary Markdown as a deck', () => {
  assert.equal(readDeckMetadata('# README\n\n---\n\nText', 'README'), undefined);
});

test('reports malformed, duplicate, missing, and non-mapping headmatter', () => {
  for (const source of [
    '---\ntitle: [broken\n---',
    '---\ntitle: A\ntitle: B\n---',
    '---\ntitle: Missing close',
    '---\n- a\n- b\n---',
  ]) {
    assert.throws(() => readDeckMetadata(source, 'fallback'));
  }
});

test('does not expose object values as a title or theme', () => {
  assert.deepEqual(readDeckMetadata('---\ntitle: { nested: value }\ntheme: [x]\n---\n# Cover', 'fallback'), {
    title: 'Cover',
  });
});
