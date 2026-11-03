import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { getMarkdownImageInsertion, getSlidevImageReference } from '../assets';

test('uses Slidev public URLs and encodes asset paths', () => {
  const root = join('workspace', 'presentation');
  const deck = join(root, 'talk', 'slides.md');
  const asset = join(root, 'public', 'images', 'team photo.png');

  assert.equal(getSlidevImageReference(root, deck, asset), '/images/team%20photo.png');
  assert.equal(getMarkdownImageInsertion(asset, '/images/team%20photo.png'), '![team photo](/images/team%20photo.png)');
});

test('uses deck-relative paths for assets outside the public directory', () => {
  const root = join('workspace', 'presentation');
  const deck = join(root, 'talk', 'slides.md');
  const asset = join(root, 'media', 'cover art.svg');

  assert.equal(getSlidevImageReference(root, deck, asset), '../media/cover%20art.svg');
});

test('rejects assets outside the workspace folder', () => {
  const root = join('workspace', 'presentation');
  const deck = join(root, 'slides.md');
  const asset = join('workspace', 'outside', 'secret.png');

  assert.throws(
    () => getSlidevImageReference(root, deck, asset),
    /outside the presentation workspace/,
  );
});
