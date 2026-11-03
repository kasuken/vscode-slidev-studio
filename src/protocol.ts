export type SidebarMessage =
  | { type: 'ready' | 'refresh' | 'openSource' | 'startPreview' | 'stopPreview' | 'present' | 'export' | 'insertAsset' | 'setLayout' }
  | { type: 'select'; id: string }
  | { type: 'openSlide'; id: string }
  | { type: 'selectSlide'; id: string }
  | { type: 'moveSlide'; id: string; direction: -1 | 1 }
  | { type: 'moveSlideTo'; deckId: string; id: string; targetId: string; after: boolean }
  | { type: 'editNotes'; id: string }
  | { type: 'removeImportReference'; id: string }
  | { type: 'duplicateImportReference'; id: string }
  | { type: 'addSlide'; id: string }
  | { type: 'duplicateSlide'; id: string }
  | { type: 'deleteSlide'; id: string }
  | { type: 'thumbnailRange'; start: number; end: number; uiGeneration: number };

export function isSidebarMessage(value: unknown): value is SidebarMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  if (value.type === 'select' || value.type === 'openSlide' || value.type === 'selectSlide') {
    return 'id' in value && typeof value.id === 'string';
  }
  if (value.type === 'moveSlide') {
    return 'id' in value
      && typeof value.id === 'string'
      && 'direction' in value
      && (value.direction === -1 || value.direction === 1);
  }
  if (value.type === 'moveSlideTo') {
    return 'id' in value
      && typeof value.id === 'string'
      && 'deckId' in value
      && typeof value.deckId === 'string'
      && 'targetId' in value
      && typeof value.targetId === 'string'
      && 'after' in value
      && typeof value.after === 'boolean';
  }
  if (
    value.type === 'editNotes'
    || value.type === 'removeImportReference'
    || value.type === 'duplicateImportReference'
    || value.type === 'addSlide'
    || value.type === 'duplicateSlide'
    || value.type === 'deleteSlide'
  ) {
    return 'id' in value && typeof value.id === 'string';
  }
  if (value.type === 'thumbnailRange') {
    return 'start' in value
      && Number.isSafeInteger(value.start)
      && 'end' in value
      && Number.isSafeInteger(value.end)
      && 'uiGeneration' in value
      && Number.isSafeInteger(value.uiGeneration);
  }
  return value.type === 'ready'
    || value.type === 'refresh'
    || value.type === 'openSource'
    || value.type === 'startPreview'
    || value.type === 'stopPreview'
    || value.type === 'present'
    || value.type === 'export'
    || value.type === 'insertAsset'
    || value.type === 'setLayout';
}
