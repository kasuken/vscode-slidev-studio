import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDeckSourceGraph } from '../sourceGraph';
import { duplicateLocalSlide, locateLocalSlideNotes, setLocalSlideLayout } from '../slideEdits';

const fixtures = join(__dirname, '..', '..', 'test-fixtures');

test('uses unsaved entry Markdown through a workspace symlink or junction without overriding imports', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-workspace-alias-'));
  try {
    const workspacePath = join(rootPath, 'workspace');
    const aliasPath = join(rootPath, 'alias');
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, 'slides.md'), '# Saved cover');
    await writeFile(join(workspacePath, 'shared.md'), '# Shared source');
    await symlink(workspacePath, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
    for (const slidevVersion of ['52.14.2', '53.0.0']) {
      const graph = await buildDeckSourceGraph(join(aliasPath, 'slides.md'), aliasPath, {
        slidevVersion,
        entryMarkdown: '# Unsaved cover\n---\nsrc: ./shared.md\n---\n',
      });
      assert.deepEqual(graph.slides.map(slide => slide.title), ['Unsaved cover', 'Shared source']);
      assert.equal(graph.slides[0]?.sourcePath, 'slides.md');
      assert.equal(graph.slides[1]?.sourcePath, 'shared.md');
      assert.equal(graph.slides[1]?.imported, true);
      assert.equal(graph.diagnostics.length, 0);
    }
    assert.equal(await readFile(join(workspacePath, 'slides.md'), 'utf8'), '# Saved cover');
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('maps imported occurrences to their original source and provenance', async () => {
  const deckPath = join(fixtures, 'slides.md');
  const rootPath = await realpath(fixtures);
  const graph = await buildDeckSourceGraph(deckPath, rootPath, { slidevVersion: '53.0.0' });
  assert.equal(graph.renderedMappingAvailable, true);

  const imported = graph.slides.find(slide => slide.imported);
  assert.ok(imported);
  assert.match(imported.sourcePath, /shared[\\/]intro\.md$/);
  assert.equal(imported.importChain.length, 1);
  assert.ok(imported.line > 0);
  assert.equal(imported.canNavigate, true);
  assert.equal(imported.usageCount, 1);
  assert.equal(imported.importReferencePath, 'slides.md');
  assert.equal(imported.importReferenceIndex, 2);
  assert.ok(imported.importReferenceLine);
});

test('counts repeated imported occurrences that share the same source slide', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-shared-'));
  try {
    const deckPath = join(rootPath, 'slides.md');
    await writeFile(deckPath, [
      '# Deck',
      '---',
      'src: ./part.md',
      '---',
      '',
      '---',
      'src: ./part.md',
      '---',
      '',
    ].join('\n'));
    await writeFile(join(rootPath, 'part.md'), '# Shared slide');

    const graph = await buildDeckSourceGraph(deckPath, rootPath, { slidevVersion: '53.0.0' });
    const importedSlides = graph.slides.filter(slide => slide.imported);
    assert.equal(importedSlides.length, 2);
    assert.ok(importedSlides.every(slide => slide.usageCount === 2));
    assert.deepEqual(importedSlides.map(slide => slide.importReferenceIndex), [2, 3]);
    assert.notEqual(importedSlides[0]?.id, importedSlides[1]?.id);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('maps nested and consecutive imports to their exact source slides and deck references', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-nested-'));
  try {
    const deckPath = join(rootPath, 'slides.md');
    await writeFile(deckPath, [
      '# Deck cover',
      '---',
      'src: ./outer.md',
      'layout: center',
      '---',
      '---',
      'src: ./part.md#2,4',
      '---',
      '',
    ].join('\n'));
    await writeFile(join(rootPath, 'outer.md'), [
      '# Outer before',
      '---',
      'src: ./nested.md#2',
      '---',
      '',
      '# Outer after',
    ].join('\n'));
    await writeFile(join(rootPath, 'nested.md'), [
      '# Deep one',
      '---',
      '',
      '# Deep selected',
    ].join('\n'));
    await writeFile(join(rootPath, 'part.md'), [
      '# Part one',
      '---',
      '',
      '# Part two',
      '---',
      '',
      '# Part three',
      '```md',
      '---',
      '# Not a slide',
      '```',
      '---',
      '',
      '# Part four',
    ].join('\n'));

    const graph = await buildDeckSourceGraph(deckPath, rootPath, { slidevVersion: '53.0.0' });
    assert.deepEqual(graph.slides.map(({
      title,
      sourcePath,
      sourceIndex,
      line,
      importChain,
      importReferencePath,
      importReferenceIndex,
    }) => ({
      title,
      sourcePath,
      sourceIndex,
      line,
      importChain,
      importReferencePath,
      importReferenceIndex,
    })), [
      {
        title: 'Deck cover',
        sourcePath: 'slides.md',
        sourceIndex: 1,
        line: 1,
        importChain: [],
        importReferencePath: undefined,
        importReferenceIndex: undefined,
      },
      {
        title: 'Outer before',
        sourcePath: 'outer.md',
        sourceIndex: 1,
        line: 1,
        importChain: ['slides.md'],
        importReferencePath: 'slides.md',
        importReferenceIndex: 2,
      },
      {
        title: 'Deep selected',
        sourcePath: 'nested.md',
        sourceIndex: 2,
        line: 4,
        importChain: ['slides.md', 'outer.md'],
        importReferencePath: 'slides.md',
        importReferenceIndex: 2,
      },
      {
        title: 'Part two',
        sourcePath: 'part.md',
        sourceIndex: 2,
        line: 4,
        importChain: ['slides.md'],
        importReferencePath: 'slides.md',
        importReferenceIndex: 3,
      },
      {
        title: 'Part four',
        sourcePath: 'part.md',
        sourceIndex: 4,
        line: 14,
        importChain: ['slides.md'],
        importReferencePath: 'slides.md',
        importReferenceIndex: 3,
      },
    ]);
    assert.equal(graph.slides.length, 5);
    assert.equal(graph.slides[2]?.effectiveFrontmatter.layout, 'center');
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('resolves workspace-root imports and reports unresolved or escaping paths', async () => {
  const outerPath = await mkdtemp(join(tmpdir(), 'slidev-studio-roots-'));
  const rootPath = join(outerPath, 'workspace');
  try {
    await mkdir(rootPath);
    await writeFile(join(rootPath, 'slides.md'), [
      '# Cover',
      '---',
      'src: /shared.md',
      '---',
      '',
      '---',
      'src: "%SLIDEV_SECTION%"',
      '---',
      '',
      '---',
      'src: ../outside.md',
      '---',
      '',
    ].join('\n'));
    await writeFile(join(rootPath, 'shared.md'), '# Shared');
    await writeFile(join(outerPath, 'outside.md'), '# Outside');

    const graph = await buildDeckSourceGraph(
      join(rootPath, 'slides.md'),
      rootPath,
      { slidevVersion: '53.0.0' },
    );
    assert.deepEqual(graph.slides.map(slide => slide.sourcePath), ['slides.md', 'shared.md']);
    assert.ok(graph.diagnostics.some(diagnostic => diagnostic.includes('unresolved environment placeholder')));
    assert.ok(graph.diagnostics.some(diagnostic => diagnostic.includes('escapes the workspace folder')));
  } finally {
    await rm(outerPath, { recursive: true, force: true });
  }
});

test('uses Slidev parsing for selectors, fenced separators, and HTML comments', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-source-'));
  try {
    const deckPath = join(rootPath, 'slides.md');
    const partPath = join(rootPath, 'part.md');
    await writeFile(deckPath, [
      '---',
      'title: Selector fixture',
      '---',
      '# Cover',
      '```md',
      '---',
      '# Not a slide',
      '```',
      '<!--',
      '---',
      '-->',
      '---',
      'src: ./part.md#2,4',
      '---',
      '',
    ].join('\n'));
    await writeFile(partPath, [
      '# One',
      '---',
      '',
      '# Two',
      '---',
      '',
      '# Three',
      '```md',
      '---',
      '# Still not a slide',
      '```',
      '---',
      '',
      '# Four',
    ].join('\n'));

    const graph = await buildDeckSourceGraph(deckPath, rootPath, { slidevVersion: '53.0.0' });
    assert.deepEqual(graph.slides.map(slide => slide.title), ['Selector fixture', 'Two', 'Four']);
    assert.deepEqual(graph.slides.map(slide => slide.sourceIndex), [1, 2, 4]);
    assert.deepEqual(graph.slides.slice(1).map(slide => slide.sourcePath), ['part.md', 'part.md']);
    assert.deepEqual(graph.slides.slice(1).map(slide => slide.line), [4, 14]);
    assert.deepEqual(graph.slides.slice(1).map(slide => slide.importReferenceIndex), [2, 2]);
    assert.equal(graph.slides[0]?.sourcePath, 'slides.md');
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('maps Slidev 52.14.2 decks with its matching parser adapter', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-v52-'));
  try {
    const deckPath = join(rootPath, 'slides.md');
    await writeFile(deckPath, [
      '# Cover',
      '---',
      'src: ./part.md#2',
      '---',
      '',
    ].join('\n'));
    await writeFile(join(rootPath, 'part.md'), [
      '# First',
      '---',
      '',
      '# Selected by Slidev 52',
      '```md',
      '---',
      '# Not a slide',
      '```',
    ].join('\n'));

    const graph = await buildDeckSourceGraph(deckPath, rootPath, { slidevVersion: '52.14.2' });
    assert.deepEqual(graph.slides.map(slide => ({
      title: slide.title,
      sourceIndex: slide.sourceIndex,
      canNavigate: slide.canNavigate,
      importReferenceIndex: slide.importReferenceIndex,
    })), [
      { title: 'Cover', sourceIndex: 1, canNavigate: true, importReferenceIndex: undefined },
      { title: 'Selected by Slidev 52', sourceIndex: 2, canNavigate: true, importReferenceIndex: 2 },
    ]);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('reports missing imports and circular imports without flattening them silently', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-imports-'));
  try {
    const deckPath = join(rootPath, 'slides.md');
    const cyclePath = join(rootPath, 'cycle.md');
    await writeFile(deckPath, [
      '# Cover',
      '---',
      'src: ./missing.md',
      '---',
      '',
      '---',
      'src: ./cycle.md',
      '---',
      '',
    ].join('\n'));
    await writeFile(cyclePath, [
      '---',
      'src: ./slides.md',
      '---',
    ].join('\n'));

    const graph = await buildDeckSourceGraph(deckPath, rootPath, { slidevVersion: '53.0.0' });
    assert.ok(graph.diagnostics.some(diagnostic => diagnostic.includes('Imported markdown file not found')));
    assert.ok(graph.diagnostics.some(diagnostic => diagnostic.includes('Circular import detected')));
    assert.deepEqual(graph.slides.map(slide => slide.title), ['Cover']);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

for (const slidevVersion of ['52.14.2', '53.0.0']) {
  test(`navigates and edits original Markdown with a custom preparser on ${slidevVersion} without executing it`, async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-source-outline-'));
    try {
      const deckPath = join(rootPath, 'slides.md');
      const sharedPath = join(rootPath, 'shared.md');
      const markerPath = join(rootPath, 'preparser-executed');
      await mkdir(join(rootPath, 'setup'));
      await writeFile(join(rootPath, 'setup', 'preparser.js'), [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "executed");`,
        'throw new Error("Discovery must not execute this preparser");',
      ].join('\n'));
      const savedText = [
        '# Cover',
        '---',
        'src: ./shared.md',
        '---',
        '',
        '---',
        '_note: ./notes.md',
        '---',
        '# Saved title',
        'Speaker: %SLIDEV_SPEAKER%',
        '',
      ].join('\r\n');
      const draft = savedText.replace('# Saved title', '# %SLIDEV_TITLE%');
      await writeFile(deckPath, savedText);
      await writeFile(sharedPath, '# Shared slide\n');
      const options = { slidevVersion, entryMarkdown: draft };
      const ordinaryGraph = await buildDeckSourceGraph(deckPath, rootPath, options);
      const graph = await buildDeckSourceGraph(deckPath, rootPath, { ...options, customPreparser: true });

      assert.equal(ordinaryGraph.renderedMappingAvailable, true);
      assert.equal(graph.renderedMappingAvailable, false);
      assert.notEqual(graph.fingerprint, ordinaryGraph.fingerprint);
      assert.deepEqual(
        graph.slides.map(({ id, ...source }) => source),
        ordinaryGraph.slides.map(({ id, ...source }) => source),
      );
      assert.ok(graph.slides.every(slide => slide.canNavigate && !slide.readOnlyReason));
      assert.ok(graph.diagnostics.some(diagnostic => /Source-outline mode/.test(diagnostic)));
      assert.ok(graph.diagnostics.some(diagnostic => /placeholders are left unresolved/.test(diagnostic)));
      const imported = graph.slides.find(slide => slide.imported);
      assert.ok(imported);
      assert.equal(imported.sourcePath, 'shared.md');
      assert.equal(imported.line, 1);
      assert.equal(imported.importReferenceIndex, 2);
      const local = graph.slides.find(slide => slide.sourceIndex === 3 && !slide.imported);
      assert.ok(local);
      assert.equal(local.title, '%SLIDEV_TITLE%');
      assert.equal(local.line, 9);
      assert.equal(local.sourcePath, 'slides.md');
      assert.equal(local.usageCount, 1);
      const expected = { title: local.title, line: local.line };
      const duplicated = await duplicateLocalSlide(draft, local.sourceIndex, expected);
      assert.equal((duplicated.text.match(/^# %SLIDEV_TITLE%$/gm) ?? []).length, 2);
      assert.equal((duplicated.text.match(/^src: \.\/shared\.md$/gm) ?? []).length, 1);
      assert.equal(duplicated.text.replace(/\r\n/g, '').includes('\n'), false);
      const layout = await setLocalSlideLayout(draft, local.sourceIndex, 'center', expected);
      assert.ok(layout.includes('layout: center\r\n'));
      assert.ok(layout.includes('# %SLIDEV_TITLE%\r\n'));
      const notes = await locateLocalSlideNotes(draft, local.sourceIndex, expected);
      assert.equal(notes.externalPath, './notes.md');
      assert.equal(await readFile(deckPath, 'utf8'), savedText);
      assert.equal(await readFile(sharedPath, 'utf8'), '# Shared slide\n');
      await assert.rejects(access(markerPath), { code: 'ENOENT' });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
}

test('keeps mismatched Slidev versions read-only even with a custom preparser', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'slidev-studio-readonly-'));
  try {
    const deckPath = join(rootPath, 'slides.md');
    await mkdir(join(rootPath, 'setup'));
    await writeFile(deckPath, '# Cover');
    await writeFile(join(rootPath, 'setup', 'preparser.ts'), 'export default () => undefined');

    const graph = await buildDeckSourceGraph(deckPath, rootPath, {
      customPreparser: true,
      slidevVersion: '52.6.0',
    });
    const slide = graph.slides[0];
    assert.ok(slide);
    assert.equal(slide.canNavigate, false);
    assert.equal(graph.renderedMappingAvailable, false);
    assert.ok(graph.diagnostics.some(diagnostic => diagnostic.includes('custom Slidev preparser')));
    assert.match(slide.readOnlyReason ?? '', /Slidev 52\.6\.0 is unsupported/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
