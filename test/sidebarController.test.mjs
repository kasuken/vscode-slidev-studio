import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const extensionPath = fileURLToPath(new URL('../dist/extension.js', import.meta.url));
const requireExtension = createRequire(extensionPath);
const { buildDeckSourceGraph } = requireExtension('./sourceGraph.js');
const root = fileURLToPath(new URL('../test-fixtures', import.meta.url));
const uri = fsPath => ({ fsPath, toString: () => fsPath });

async function createSidebar({ customPreparser = false, capture } = {}) {
  const folder = { uri: uri(root) };
  const deck = { id: 'deck', title: 'Deck', path: 'slides.md', uri: uri(join(root, 'slides.md')) };
  const published = [];
  const captures = [];
  let cancellations = 0;
  const vscode = {
    workspace: {
      isTrusted: true,
      getWorkspaceFolder: () => folder,
      findFiles: async () => customPreparser ? [uri(join(root, 'setup', 'preparser.ts'))] : [],
      openTextDocument: async () => ({ getText: () => readFileSync(deck.uri.fsPath, 'utf8') }),
    },
    RelativePattern: class {},
    Uri: { file: uri },
  };
  const module = { exports: {} };
  // Expose the controller only inside the test VM, without expanding the extension's public API.
  runInNewContext(`${readFileSync(extensionPath, 'utf8')}\nmodule.exports.DeckSidebar = DeckSidebar;`, {
    module, exports: module.exports, process,
    require: name => name === 'vscode' ? vscode : requireExtension(name),
  }, { filename: extensionPath });
  const graph = await buildDeckSourceGraph(deck.uri.fsPath, root, { slidevVersion: '53.0.0' });
  const preview = {
    cancelThumbnailExport: async () => { cancellations++; },
    captureThumbnails: async (...args) => {
      captures.push(args);
      return capture ? capture(...args) : [{ slide: 1, path: join(root, 'thumbnail.png') }];
    },
  };
  const context = {
    workspaceState: { get: () => deck.uri.toString() },
    globalStorageUri: uri(root),
  };
  const sidebar = new module.exports.DeckSidebar(context, { appendLine() {} }, preview);
  sidebar.decks = [deck];
  sidebar.sourceGraph = graph;
  sidebar.selectedSlideId = graph.slides[0].id;
  sidebar.previewState = 'running';
  sidebar.view = {
    webview: {
      postMessage: async state => { published.push(state); },
      asWebviewUri: value => value,
    },
  };
  return { sidebar, deck, folder, graph, captures, published, cancellations: () => cancellations };
}

test('blocks thumbnail requests and queued exports in source-outline mode', async () => {
  const { sidebar, deck, folder, captures, published } = await createSidebar();
  sidebar.sourceGraph.renderedMappingAvailable = false;
  sidebar.requestThumbnailRange(1, 1, sidebar.thumbnailUiGeneration);
  assert.equal(sidebar.pendingThumbnailRange, undefined);
  assert.equal(sidebar.thumbnailState, 'idle');
  sidebar.pendingThumbnailRange = { start: 1, end: 1 };
  sidebar.startNextThumbnailRange();
  assert.equal(sidebar.pendingThumbnailRange, undefined);
  assert.equal(sidebar.thumbnailWork, undefined);
  await sidebar.captureThumbnailRange({ start: 1, end: 1 }, 0, 0, deck, folder);
  assert.equal(captures.length, 0);
  assert.equal(sidebar.thumbnailState, 'error');
  assert.match(sidebar.thumbnailMessage, /cannot be aligned with the filmstrip/);
  assert.equal(published.at(-1).renderedMappingAvailable, false);
  assert.equal(published.at(-1).thumbnails.length, 0);
});

test('keeps raw-source editing eligibility separate from rendered mapping', async () => {
  const { sidebar, deck, graph } = await createSidebar();
  graph.renderedMappingAvailable = false;
  const local = graph.slides.find(slide => !slide.imported && slide.sourceIndex === 3);
  const imported = graph.slides.find(slide => slide.imported);
  const cover = graph.slides[0];
  assert.ok(local && imported);
  assert.equal(sidebar.isLocalDeckSlide(deck, local), true);
  assert.equal(sidebar.isLocalDeckSlide(deck, imported), false);
  assert.equal(sidebar.getDeckBlockIndex(deck, local), 3);
  assert.equal(sidebar.getDeckBlockIndex(deck, imported), 2);
  assert.equal(sidebar.getDeckBlockIndex(deck, cover), undefined);
  assert.equal(sidebar.isLocalDeckSlide(deck, { ...local, canNavigate: false }), false);
});

test('invalidates rendered thumbnails when switching to a preparser source outline', async () => {
  const { sidebar, graph, published, cancellations } = await createSidebar({ customPreparser: true });
  sidebar.thumbnails.set(1, 'old-thumbnail.png');
  sidebar.pendingThumbnailRange = { start: 1, end: 1 };
  await sidebar.updateSourceGraph(0);
  assert.equal(sidebar.sourceGraph.renderedMappingAvailable, false);
  assert.notEqual(sidebar.sourceGraph.fingerprint, graph.fingerprint);
  assert.equal(sidebar.thumbnails.size, 0);
  assert.equal(sidebar.pendingThumbnailRange, undefined);
  assert.equal(sidebar.thumbnailUiGeneration, 1);
  assert.equal(sidebar.thumbnailRequestGeneration, 1);
  assert.equal(cancellations(), 1);
  assert.match(sidebar.graphStatus, /original Markdown; rendered order is unverified/);
  await sidebar.publish();
  assert.equal(published.at(-1).renderedMappingAvailable, false);
  assert.equal(published.at(-1).thumbnails.length, 0);
  await sidebar.updateSourceGraph(0);
  assert.equal(cancellations(), 1);
  assert.equal(sidebar.thumbnailUiGeneration, 1);
});

test('still renders and publishes verified thumbnail ranges', async () => {
  const { sidebar, graph, captures, published } = await createSidebar();
  sidebar.requestThumbnailRange(1, 1, sidebar.thumbnailUiGeneration + 1);
  assert.equal(captures.length, 0);
  sidebar.requestThumbnailRange(1, 1, sidebar.thumbnailUiGeneration);
  await sidebar.thumbnailWork;
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].slice(4), [1, 1, graph.slides.length]);
  assert.equal(sidebar.thumbnails.get(1), join(root, 'thumbnail.png'));
  assert.equal(sidebar.thumbnailState, 'ready');
  assert.equal(published.at(-1).renderedMappingAvailable, true);
  assert.equal(published.at(-1).thumbnails[0], join(root, 'thumbnail.png'));
});

test('keeps in-flight thumbnails valid across unchanged source refresh', async () => {
  let finishCapture;
  const captured = new Promise(resolve => { finishCapture = resolve; });
  const { sidebar, graph, cancellations } = await createSidebar({ capture: () => captured });
  sidebar.requestThumbnailRange(1, 1, sidebar.thumbnailUiGeneration);
  const work = sidebar.thumbnailWork;
  await sidebar.updateSourceGraph(0);
  assert.notEqual(sidebar.sourceGraph, graph);
  assert.equal(sidebar.sourceGraph.fingerprint, graph.fingerprint);
  assert.equal(cancellations(), 0);
  finishCapture([{ slide: 1, path: join(root, 'thumbnail.png') }]);
  await work;
  assert.equal(sidebar.thumbnails.get(1), join(root, 'thumbnail.png'));
  assert.equal(sidebar.thumbnailState, 'ready');
});
