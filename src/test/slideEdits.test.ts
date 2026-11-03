import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  addLocalSlideAfter,
  deleteLocalSlide,
  duplicateImportedSlideReference,
  duplicateLocalSlide,
  locateLocalSlideNotes,
  moveLocalSlide,
  moveLocalSlideTo,
  moveDeckSlideBlockTo,
  removeImportedSlideReference,
  setLocalSlideLayout,
} from '../slideEdits';

function fixture(eol: '\n' | '\r\n'): string {
  return [
    '---',
    'title: Reorder fixture',
    '---',
    '',
    '# Cover',
    '',
    '---',
    'layout: center',
    '---',
    '# First local slide',
    '',
    '<!-- First slide notes -->',
    '---',
    '',
    '# Second local slide',
    '',
    '<!-- Second slide notes -->',
    '',
  ].join(eol);
}

for (const eol of ['\n', '\r\n'] as const) {
  test(`moves complete local slide blocks and preserves ${eol === '\n' ? 'LF' : 'CRLF'} source exactly`, async () => {
    const original = fixture(eol);
    const moved = await moveLocalSlide(original, 2, 1);
    assert.ok(moved.indexOf('# Second local slide') < moved.indexOf('# First local slide'));
    assert.ok(moved.indexOf('<!-- Second slide notes -->') < moved.indexOf('<!-- First slide notes -->'));
    assert.ok(moved.startsWith('---' + eol + 'title: Reorder fixture'));
    assert.equal(await moveLocalSlide(moved, 3, -1), original);
    await assert.rejects(
      moveLocalSlide(original, 2, 1, { title: 'Stale slide title', line: 10 }),
      /deck changed since this slide list was built/,
    );
  });
}

test('protects the cover and refuses imported or non-adjacent source blocks', async () => {
  const text = [
    '# Cover',
    '',
    '---',
    '',
    '# Local',
    '',
    '---',
    'src: ./shared.md',
    '---',
    '',
    '# Last local',
  ].join('\n');

  await assert.rejects(moveLocalSlide(text, 1, 1), /cover slide cannot be moved/);
  await assert.rejects(moveLocalSlide(text, 3, -1), /Only (adjacent local|local, visible)/);
});

test('moves a local slide to a non-adjacent local position and preserves complete blocks', async () => {
  for (const eol of ['\n', '\r\n'] as const) {
    const original = [
      fixture(eol).trimEnd(),
      '---',
      '',
      '# Third local slide',
      '',
      '<!-- Third slide notes -->',
      '',
    ].join(eol);
    const moved = await moveLocalSlideTo(original, 2, 4, {
      title: 'First local slide',
      line: 10,
    });
    assert.ok(moved.indexOf('# Second local slide') < moved.indexOf('# Third local slide'));
    assert.ok(moved.indexOf('# Third local slide') < moved.indexOf('# First local slide'));
    assert.ok(moved.indexOf('<!-- First slide notes -->') > moved.indexOf('# First local slide'));
    assert.equal(await moveLocalSlideTo(moved, 4, 2), original);
    assert.ok((moved.match(/\r\n|\n/g) ?? []).every(lineEnding => lineEnding === eol));
  }
});

test('moves first and last local blocks exactly without splitting comments or fenced separators', async () => {
  const cover = '# Cover\n\n';
  const first = [
    '---',
    '',
    '# First local slide',
    '',
    '<!-- First slide notes -->',
    '<!--',
    '---',
    '-->',
    '```md',
    '---',
    '# Not a slide',
    '```',
    '',
  ].join('\n');
  const last = [
    '---',
    '',
    '# Last local slide',
    '',
    '<!-- Last slide notes -->',
    '',
  ].join('\n');
  const original = cover + first + last;

  const firstMovedToLast = await moveLocalSlideTo(original, 2, 3);
  assert.equal(firstMovedToLast, cover + last + first);
  assert.equal(await moveLocalSlideTo(firstMovedToLast, 3, 2), original);
});

test('moves the first editable imported block to the final position and back exactly', async () => {
  const cover = '# Cover\n\n';
  const first = '---\nsrc: ./shared.md#2-4\nlayout: center\n---\n\n';
  const last = '---\nclass: final\n---\n# Last local slide\n\n';
  const original = cover + first + last;

  const moved = await moveDeckSlideBlockTo(original, 2, 3);
  assert.equal(moved, cover + last + first);
  assert.equal(await moveDeckSlideBlockTo(moved, 3, 2), original);
});

test('refuses drag moves across imported, hidden, or disabled source blocks', async () => {
  const text = [
    '# Cover',
    '',
    '---',
    '',
    '# Local',
    '',
    '---',
    'src: ./shared.md',
    '---',
    '',
    '---',
    '',
    '# Last local',
  ].join('\n');
  await assert.rejects(moveLocalSlideTo(text, 2, 4), /Only local, visible slides/);

  const hidden = [
    '# Cover',
    '',
    '---',
    '',
    '# Local',
    '',
    '---',
    'hide: true',
    '---',
    '',
    '# Hidden',
    '',
    '---',
    '',
    '# Last local',
  ].join('\n');
  await assert.rejects(moveLocalSlideTo(hidden, 2, 4), /Only local, visible slides/);
  await assert.rejects(moveLocalSlideTo(fixture('\n'), 1, 2), /cover slide cannot be moved/);
  await assert.rejects(moveLocalSlideTo(fixture('\n'), 2, 1), /cover slide cannot be moved/);
});

test('locates final inline notes and creates a note comment without touching other comments', async () => {
  for (const eol of ['\n', '\r\n'] as const) {
    const original = [
      '# Cover',
      '',
      '---',
      '',
      '# Local slide',
      '',
      '<!-- This is a source comment, not notes. -->',
      '',
      'Slide content.',
      '',
    ].join(eol);
    const location = await locateLocalSlideNotes(original, 2, {
      title: 'Local slide',
      line: 5,
    });
    assert.ok(location.insertion);
    const updated = original.slice(0, location.insertion.offset)
      + location.insertion.text
      + original.slice(location.insertion.offset);
    if (location.selectionStart === undefined) {
      throw new Error('An empty notes comment should place the cursor inside its body.');
    }
    assert.ok(updated.includes('<!-- This is a source comment, not notes. -->'));
    assert.equal(updated.slice(location.selectionStart, location.selectionStart + eol.length), eol);

    const withNotes = updated.replace(
      `${eol}${eol}-->`,
      `${eol}Speaker note text${eol}-->`,
    );
    const existing = await locateLocalSlideNotes(withNotes, 2, {
      title: 'Local slide',
      line: 5,
    });
    assert.equal(withNotes.slice(existing.start, existing.end).trim(), 'Speaker note text');
  }
});

test('identifies external _note paths without interpreting them as inline comments', async () => {
  const text = [
    '# Cover',
    '',
    '---',
    '_note: notes/speaker.md',
    '---',
    '# Local',
  ].join('\n');
  const location = await locateLocalSlideNotes(text, 2);
  assert.equal(location.externalPath, 'notes/speaker.md');
});

test('sets a layout on slides with and without frontmatter while preserving LF and CRLF', async () => {
  for (const eol of ['\n', '\r\n'] as const) {
    const original = [
      '# Cover',
      '',
      '---',
      '',
      '# Local slide',
      '',
      'Slide content.',
      '',
      '---',
      'layout: quote # keep this note',
      'class: text-xl',
      '---',
      '# Slide with frontmatter',
      '',
    ].join(eol);

    const withLayout = await setLocalSlideLayout(original, 2, 'two-cols', {
      title: 'Local slide',
      line: 5,
    });
    assert.ok(withLayout.includes(`---${eol}layout: two-cols${eol}---${eol}${eol}# Local slide`));
    const replaced = await setLocalSlideLayout(withLayout, 3, 'center', {
      title: 'Slide with frontmatter',
      line: 15,
    });
    assert.ok(replaced.includes(`layout: center # keep this note${eol}class: text-xl`));
    assert.ok(replaced.includes(`---${eol}# Slide with frontmatter`));
    assert.equal((replaced.match(/layout:/g) ?? []).length, 2);
    assert.ok((replaced.match(/\r\n|\n/g) ?? []).every(lineEnding => lineEnding === eol));
  }
});

test('adds layouts to empty frontmatter and rejects ambiguous or invalid layout data', async () => {
  const emptyFrontmatter = ['# Cover', '', '---', '', '---', '', '# Slide', ''].join('\n');
  const updated = await setLocalSlideLayout(emptyFrontmatter, 2, 'center');
  assert.ok(updated.includes('---\nlayout: center\n---\n'));

  const duplicateLayouts = [
    '# Cover',
    '',
    '---',
    'layout: center',
    'layout: quote',
    '---',
    '# Slide',
  ].join('\n');
  await assert.rejects(setLocalSlideLayout(duplicateLayouts, 2, 'center'), /duplicate layout entries/);
  await assert.rejects(setLocalSlideLayout(emptyFrontmatter, 2, '../outside'), /layout name is invalid/);
});

test('adds a valid local slide after the selected slide and preserves line endings', async () => {
  for (const eol of ['\n', '\r\n'] as const) {
    const original = fixture(eol);
    const result = await addLocalSlideAfter(original, 2, {
      title: 'First local slide',
      line: 10,
    });
    assert.ok(result.text.indexOf('# New slide') > result.text.indexOf('# First local slide'));
    assert.ok(result.text.indexOf('# New slide') < result.text.indexOf('# Second local slide'));
    assert.equal(result.selectedSourceIndex, 3);
    const lineEndings = result.text.match(/\r\n|\n/g) ?? [];
    assert.ok(lineEndings.length > 0);
    assert.ok(lineEndings.every(lineEnding => lineEnding === eol));
  }
});

test('duplicates complete local slide source blocks, including frontmatter and notes', async () => {
  const original = fixture('\n');
  const result = await duplicateLocalSlide(original, 2, {
    title: 'First local slide',
    line: 10,
  });
  assert.equal(result.selectedSourceIndex, 3);
  assert.equal(result.text.match(/layout: center/g)?.length, 2);
  assert.equal(result.text.match(/<!-- First slide notes -->/g)?.length, 2);
  assert.ok(result.text.indexOf('# First local slide') < result.text.lastIndexOf('# First local slide'));
  await assert.rejects(duplicateLocalSlide(original, 1), /cover slide cannot be duplicated/);
});

test('deletes only the selected local slide and leaves the cover and other source intact', async () => {
  const original = fixture('\n');
  const result = await deleteLocalSlide(original, 2, {
    title: 'First local slide',
    line: 10,
  });
  assert.equal(result.selectedSourceIndex, 2);
  assert.ok(result.text.includes('# Cover'));
  assert.ok(!result.text.includes('# First local slide'));
  assert.ok(result.text.includes('# Second local slide'));
  await assert.rejects(deleteLocalSlide(original, 1), /cover slide cannot be deleted/);
});

test('adds after, duplicates, and deletes the final local slide with exact source boundaries', async () => {
  const prefix = '# Cover\n\n---\n\n# First local slide\n\n';
  const finalBlock = '---\n\n# Last local slide\n';
  const original = prefix + finalBlock;

  const added = await addLocalSlideAfter(original, 3);
  assert.equal(added.text, original + '---\n\n# New slide\n');
  assert.equal(added.selectedSourceIndex, 4);

  const duplicated = await duplicateLocalSlide(original, 3);
  assert.equal(duplicated.text, original + finalBlock);
  assert.equal(duplicated.selectedSourceIndex, 4);

  const deleted = await deleteLocalSlide(original, 3);
  assert.equal(deleted.text, prefix);
  assert.equal(deleted.selectedSourceIndex, 2);
});

test('removes only the selected import reference and preserves shared source references', async () => {
  for (const eol of ['\n', '\r\n'] as const) {
    const original = [
      '# Cover',
      '',
      '---',
      'src: ./shared.md#2-4',
      'layout: center',
      '---',
      '',
      '---',
      '',
      '# Local slide',
      '',
    ].join(eol);
    const result = await removeImportedSlideReference(original, 2);
    assert.ok(result.text.includes('# Cover'));
    assert.ok(result.text.includes('# Local slide'));
    assert.ok(!result.text.includes('src: ./shared.md#2-4'));
    assert.ok(!result.text.includes('layout: center'));
    assert.equal(result.selectedSourceIndex, 1);
    assert.ok((result.text.match(/\r\n|\n/g) ?? []).every(lineEnding => lineEnding === eol));
    await assert.rejects(
      removeImportedSlideReference(original, 2, { title: 'Stale reference', line: 4 }),
      /deck changed since this slide list was built/,
    );
  }
});

test('protects the cover import and refuses to remove local slide source', async () => {
  const coverImport = ['---', 'src: ./cover.md', '---', ''].join('\n');
  const deck = ['# Cover', '', '---', '', '# Local'].join('\n');
  await assert.rejects(removeImportedSlideReference(coverImport, 1), /cover reference cannot be removed/);
  await assert.rejects(removeImportedSlideReference(deck, 2), /not an imported slide reference/);
});

test('duplicates an imported reference as a shared source block and protects the cover', async () => {
  for (const eol of ['\n', '\r\n'] as const) {
    const original = [
      '# Cover',
      '',
      '---',
      'src: ./shared.md#2-4',
      'layout: center',
      '---',
      '',
      '---',
      '',
      '# Local slide',
      '',
    ].join(eol);
    const result = await duplicateImportedSlideReference(original, 2);
    assert.equal(result.selectedSourceIndex, 3);
    assert.equal((result.text.match(/src: \.\/shared\.md#2-4/g) ?? []).length, 2);
    assert.equal((result.text.match(/layout: center/g) ?? []).length, 2);
    assert.ok(result.text.indexOf('src: ./shared.md#2-4') < result.text.lastIndexOf('src: ./shared.md#2-4'));
    assert.ok((result.text.match(/\r\n|\n/g) ?? []).every(lineEnding => lineEnding === eol));
    await assert.rejects(duplicateImportedSlideReference(original, 2, { title: 'Stale', line: 4 }), /deck changed/);
  }
  await assert.rejects(
    duplicateImportedSlideReference(['---', 'src: ./cover.md', '---', ''].join('\n'), 1),
    /cover reference cannot be duplicated/,
  );
  await assert.rejects(
    duplicateImportedSlideReference(['# Cover', '', '---', '', '# Local'].join('\n'), 2),
    /not an imported slide reference/,
  );
});

test('duplicates or removes a final imported reference without changing its selector or neighbors', async () => {
  const prefix = '# Cover\n\n---\n\n# Local slide\n\n';
  const finalReference = '---\nsrc: ./shared.md#2-3\nclass: keep\n---\n';
  const original = prefix + finalReference;

  const duplicated = await duplicateImportedSlideReference(original, 3);
  assert.equal(duplicated.text, original + finalReference);
  assert.equal(duplicated.selectedSourceIndex, 4);

  const removed = await removeImportedSlideReference(original, 3);
  assert.equal(removed.text, prefix);
  assert.equal(removed.selectedSourceIndex, 2);
});

test('moves complete local or imported source blocks without crossing the cover', async () => {
  for (const eol of ['\n', '\r\n'] as const) {
    const original = [
      '# Cover',
      '',
      '---',
      'src: ./shared.md#2-4',
      'layout: center',
      '---',
      '',
      '---',
      'class: local',
      '---',
      '# Local slide',
      '',
      '---',
      'src: ./other.md',
      '---',
      '',
      '# Last local',
      '',
    ].join(eol);
    const moved = await moveDeckSlideBlockTo(original, 2, 4);
    assert.ok(moved.indexOf('# Local slide') < moved.indexOf('src: ./other.md'));
    assert.ok(moved.indexOf('src: ./other.md') < moved.indexOf('src: ./shared.md#2-4'));
    assert.ok(moved.startsWith(`# Cover${eol}${eol}`));
    assert.ok((moved.match(/\r\n|\n/g) ?? []).every(lineEnding => lineEnding === eol));
    assert.equal(await moveDeckSlideBlockTo(moved, 4, 2), original);
    await assert.rejects(moveDeckSlideBlockTo(original, 2, 1), /cover block cannot be moved/);
    await assert.rejects(moveDeckSlideBlockTo(original, 2, 4, undefined, { title: 'Stale', line: 17 }), /deck changed/);
  }
});

test('does not edit imported slides or act on stale slide selections', async () => {
  const text = [
    '# Cover',
    '',
    '---',
    'src: ./shared.md',
    '---',
    '',
    '---',
    '',
    '# Local',
  ].join('\n');
  await assert.rejects(addLocalSlideAfter(text, 2), /Only local, visible slides/);
  await assert.rejects(duplicateLocalSlide(text, 2), /Only local, visible slides/);
  await assert.rejects(deleteLocalSlide(text, 2), /Only local, visible slides/);
  await assert.rejects(
    addLocalSlideAfter(fixture('\n'), 2, { title: 'Renamed slide', line: 10 }),
    /deck changed since this slide list was built/,
  );
});
