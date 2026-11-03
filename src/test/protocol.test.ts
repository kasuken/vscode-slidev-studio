import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isSidebarMessage } from '../protocol';

test('accepts supported messages', () => {
  for (const type of ['ready', 'refresh', 'openSource', 'startPreview', 'stopPreview', 'present', 'export', 'insertAsset', 'setLayout']) {
    assert.equal(isSidebarMessage({ type }), true);
  }
  assert.equal(isSidebarMessage({ type: 'select', id: 'known-deck' }), true);
  assert.equal(isSidebarMessage({ type: 'openSlide', id: 'known-slide' }), true);
  assert.equal(isSidebarMessage({ type: 'selectSlide', id: 'known-slide' }), true);
  assert.equal(isSidebarMessage({ type: 'moveSlide', id: 'known-slide', direction: -1 }), true);
  assert.equal(isSidebarMessage({ type: 'editNotes', id: 'known-slide' }), true);
  assert.equal(isSidebarMessage({ type: 'removeImportReference', id: 'known-slide' }), true);
  assert.equal(isSidebarMessage({ type: 'duplicateImportReference', id: 'known-slide' }), true);
  assert.equal(isSidebarMessage({
    type: 'moveSlideTo',
    deckId: 'known-deck',
    id: 'known-slide',
    targetId: 'target-slide',
    after: true,
  }), true);
  for (const type of ['addSlide', 'duplicateSlide', 'deleteSlide']) {
    assert.equal(isSidebarMessage({ type, id: 'known-slide' }), true);
  }
  assert.equal(isSidebarMessage({ type: 'thumbnailRange', start: 2, end: 8, uiGeneration: 1 }), true);
});

test('rejects malformed or unknown messages', () => {
  for (const value of [
    null,
    undefined,
    1,
    'refresh',
    {},
    { type: 'delete' },
    { type: 'select' },
    { type: 'select', id: 12 },
    { type: 'openSlide' },
    { type: 'openSlide', id: 12 },
    { type: 'selectSlide' },
    { type: 'selectSlide', id: 12 },
    { type: 'editNotes', id: 12 },
    { type: 'removeImportReference', id: 12 },
    { type: 'duplicateImportReference', id: 12 },
    { type: 'moveSlide', id: 'known-slide', direction: 0 },
    { type: 'moveSlide', id: 12, direction: 1 },
    { type: 'moveSlideTo', deckId: 'known-deck', id: 'known-slide', targetId: 'target-slide', after: 'yes' },
    { type: 'moveSlideTo', id: 'known-slide', targetId: 'target-slide', after: true },
    { type: 'moveSlideTo', deckId: 'known-deck', id: 'known-slide', after: false },
    { type: 'deleteSlide', id: 12 },
    { type: 'thumbnailRange', start: '1', end: 2, uiGeneration: 0 },
    { type: 'thumbnailRange', start: 1, end: Infinity, uiGeneration: 0 },
    { type: 'thumbnailRange', start: 1, end: 2 },
  ]) {
    assert.equal(isSidebarMessage(value), false);
  }
});
