import { matchingSlideIndexes, nextThumbnailRange, visibleSlideWindow } from './slideList.mjs';

(() => {
  const vscode = acquireVsCodeApi();
  const decks = document.getElementById('decks');
  const viewport = document.getElementById('slides-viewport');
  const slides = document.getElementById('slides');
  const previewFrame = document.getElementById('preview-frame');
  let rowHeight = 100;
  const overscan = 2;
  let state;
  let draggedSlideId;
  let dropTarget;
  const savedView = vscode.getState() ?? {};
  const search = document.getElementById('slide-search');
  let query = savedView.query ?? '';
  let viewMode = savedView.viewMode === 'outline' ? 'outline' : 'thumbnails';
  let previewCollapsed = savedView.previewCollapsed === true;
  let filteredIndexes = [];
  search.value = query;
  let previousDeckId = savedView.deckId;
  let previousThumbnailUiGeneration;
  let lastRequestedRange;
  let rangeTimer;
  let previousSelectedSlideId;
  let restoreView = true;

  function saveView() {
    vscode.setState({
      deckId: state?.selectedId ?? savedView.deckId,
      scrollTop: viewport.scrollTop,
      focusedId: document.activeElement?.id,
      query,
      viewMode,
      previewCollapsed,
      disclosures: Object.fromEntries([...document.querySelectorAll('details[id]')]
        .map(element => [element.id, element.open])),
    });
  }
  document.querySelectorAll('details[id]').forEach(element => {
    element.open = savedView.disclosures?.[element.id] === true;
    element.addEventListener('toggle', saveView);
  });
  document.querySelectorAll('.action-disclosure').forEach(element => {
    element.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        element.open = false;
        element.querySelector('summary').focus();
      }
    });
    element.addEventListener('click', event => {
      if (event.target.closest('button') && !event.target.closest('button').disabled) {
        element.open = false;
        element.querySelector('summary').focus();
      }
    });
  });

  const send = type => vscode.postMessage({ type });
  function updatePreviewDisclosure() {
    document.getElementById('preview-stage').hidden = previewCollapsed;
    const toggle = document.getElementById('toggle-preview');
    toggle.setAttribute('aria-expanded', String(!previewCollapsed));
    toggle.setAttribute('aria-label', previewCollapsed ? 'Expand preview' : 'Collapse preview');
    toggle.title = previewCollapsed ? 'Expand preview' : 'Collapse preview';
  }
  document.getElementById('toggle-preview').addEventListener('click', () => {
    previewCollapsed = !previewCollapsed;
    updatePreviewDisclosure();
    saveView();
  });
  function updateFilter() {
    lastRequestedRange = undefined;
    clearTimeout(rangeTimer);
    viewport.scrollTop = 0;
    renderVisibleSlides();
    const selected = state?.slides.find(slide => slide.id === state.selectedSlideId);
    document.getElementById('move-slide-up').disabled = !selected || !canMoveSlide(selected, -1);
    document.getElementById('move-slide-down').disabled = !selected || !canMoveSlide(selected, 1);
    saveView();
  }
  search.addEventListener('input', () => { query = search.value; updateFilter(); });
  function clearSearch() {
    query = '';
    search.value = '';
    updateFilter();
  }
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { clearSearch(); event.preventDefault(); }
    else if (event.key === 'ArrowDown') {
      event.preventDefault();
      slides.querySelector('button')?.focus();
    }
  });
  document.getElementById('clear-search').addEventListener('click', () => { clearSearch(); search.focus(); });
  function revealSelected() {
    if (!state?.selectedSlideId) return;
    const index = state.slides.findIndex(slide => slide.id === state.selectedSlideId);
    if (!filteredIndexes.includes(index)) clearSearch();
    const position = filteredIndexes.indexOf(index);
    if (position < 0) return;
    viewport.scrollTop = Math.max(0, position * rowHeight - (viewport.clientHeight - rowHeight) / 2);
    renderVisibleSlides();
    saveView();
  }
  document.getElementById('show-selected').addEventListener('click', revealSelected);
  document.getElementById('toggle-view').addEventListener('click', () => {
    if (!state?.renderedMappingAvailable) return;
    viewMode = viewMode === 'thumbnails' ? 'outline' : 'thumbnails';
    clearTimeout(rangeTimer);
    lastRequestedRange = undefined;
    renderVisibleSlides();
    revealSelected();
    saveView();
  });
  document.getElementById('refresh').addEventListener('click', () => send('refresh'));
  document.getElementById('open').addEventListener('click', () => send('openSource'));
  document.getElementById('insert-asset').addEventListener('click', () => send('insertAsset'));
  document.getElementById('start-preview').addEventListener('click', () => send('startPreview'));
  document.getElementById('stop-preview').addEventListener('click', () => send('stopPreview'));
  document.getElementById('present').addEventListener('click', () => send('present'));
  document.getElementById('export').addEventListener('click', () => send('export'));
  decks.addEventListener('change', () => vscode.postMessage({ type: 'select', id: decks.value }));
  document.getElementById('add-slide').addEventListener('click', () => {
    if (state?.selectedSlideId) vscode.postMessage({ type: 'addSlide', id: state.selectedSlideId });
  });
  document.getElementById('duplicate-slide').addEventListener('click', () => {
    if (state?.selectedSlideId) vscode.postMessage({ type: 'duplicateSlide', id: state.selectedSlideId });
  });
  document.getElementById('delete-slide').addEventListener('click', () => {
    if (state?.selectedSlideId) vscode.postMessage({ type: 'deleteSlide', id: state.selectedSlideId });
  });
  document.getElementById('edit-notes').addEventListener('click', () => {
    if (state?.selectedSlideId) vscode.postMessage({ type: 'editNotes', id: state.selectedSlideId });
  });
  document.getElementById('remove-import').addEventListener('click', () => {
    if (state?.selectedSlideId) vscode.postMessage({ type: 'removeImportReference', id: state.selectedSlideId });
  });
  document.getElementById('duplicate-import').addEventListener('click', () => {
    if (state?.selectedSlideId) vscode.postMessage({ type: 'duplicateImportReference', id: state.selectedSlideId });
  });
  document.getElementById('set-layout').addEventListener('click', () => send('setLayout'));
  document.getElementById('open-slide-source').addEventListener('click', () => {
    if (state?.selectedSlideId) vscode.postMessage({ type: 'openSlide', id: state.selectedSlideId });
  });

  function moveSelectedSlide(direction) {
    const slide = state?.slides.find(entry => entry.id === state.selectedSlideId);
    if (!slide || !canMoveSlide(slide, direction)) return;
    vscode.postMessage({ type: 'moveSlide', id: slide.id, direction });
  }

  function canMoveSlide(slide, direction) {
    if (!slide?.canReorder || !state || query.trim()) return false;
    const range = getSlideGroupRange(slide);
    if (!range) return false;
    const neighborIndex = direction < 0 ? range.start - 1 : range.end + 1;
    const neighbor = state.slides[neighborIndex];
    return Boolean(neighbor?.canReorder && getSlideGroupKey(neighbor) !== getSlideGroupKey(slide));
  }

  document.getElementById('move-slide-up').addEventListener('click', () => moveSelectedSlide(-1));
  document.getElementById('move-slide-down').addEventListener('click', () => moveSelectedSlide(1));

  function requestVisibleRange(start, end) {
    if (!state?.renderedMappingAvailable || state.previewState !== 'running' || end < start) return;
    const key = `${start}-${end}`;
    if (key === lastRequestedRange) return;
    lastRequestedRange = key;
    const uiGeneration = state.thumbnailUiGeneration;
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => {
      if (!state?.renderedMappingAvailable || state.previewState !== 'running') return;
      vscode.postMessage({
        type: 'thumbnailRange',
        start,
        end,
        uiGeneration,
      });
    }, 120);
  }

  function renderVisibleSlides() {
    if (!state) return;
    const entries = state.slides;
    const activeViewMode = state.renderedMappingAvailable ? viewMode : 'outline';
    const fontSize = parseFloat(getComputedStyle(document.body).fontSize);
    const digits = Math.max(2, String(entries.length).length) + 0.5;
    const visualWidth = Math.max(0, viewport.clientWidth - digits * fontSize * 0.6 - 28);
    const nextRowHeight = activeViewMode === 'outline'
      ? Math.max(64, fontSize * 5)
      : Math.max(120, visualWidth * 9 / 16 + fontSize * 1.6 + 30);
    if (rowHeight !== nextRowHeight) {
      viewport.scrollTop = viewport.scrollTop / rowHeight * nextRowHeight;
      rowHeight = nextRowHeight;
    }
    filteredIndexes = matchingSlideIndexes(entries, query);
    const count = filteredIndexes.length;
    slides.dataset.view = activeViewMode;
    const viewToggle = document.getElementById('toggle-view');
    viewToggle.disabled = !state.renderedMappingAvailable;
    viewToggle.setAttribute('aria-pressed', String(activeViewMode === 'outline'));
    viewToggle.setAttribute('aria-label', !state.renderedMappingAvailable ? 'Thumbnail view unavailable in source-outline mode'
      : activeViewMode === 'outline' ? 'Use thumbnail view' : 'Use outline view');
    viewToggle.title = viewToggle.getAttribute('aria-label');
    viewToggle.querySelector('svg').innerHTML = activeViewMode === 'outline'
      ? '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M3 20h18"/>'
      : '<path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/>';
    slides.style.setProperty('--slide-number-width', `${digits}ch`);
    slides.style.height = `${count * rowHeight}px`;
    document.getElementById('clear-search').hidden = !query;
    document.getElementById('filter-status').textContent = query.trim()
      ? `${count} of ${entries.length} slides match. Clear search to reorder.` : '';
    document.getElementById('slides-empty').hidden = count > 0;
    document.getElementById('slides-empty').textContent = query.trim()
      ? 'No matching slides. Try a title, source path, or slide number.'
      : state.selectedId ? 'No slides to display. Check source mapping warnings or open the deck source.'
        : 'Choose a presentation to see its slides.';
    viewport.hidden = count === 0;
    document.getElementById('show-selected').disabled = !state.selectedSlideId;
    search.disabled = !entries.length;
    if (!count) {
      slides.replaceChildren();
      return;
    }

    const height = viewport.clientHeight || rowHeight * 3;
    const { start, end } = visibleSlideWindow(count, viewport.scrollTop, height, rowHeight, overscan);
    const visibleIndexes = filteredIndexes.slice(start, end);
    const range = nextThumbnailRange(visibleIndexes, state.thumbnails);
    if (range && activeViewMode === 'thumbnails') requestVisibleRange(range.start, range.end);

    const focusedButton = document.activeElement?.closest?.('button[data-slide-index]');
    const focusedIndex = focusedButton ? Number(focusedButton.dataset.slideIndex) : undefined;
    const tabbableIndex = focusedIndex !== undefined && visibleIndexes.includes(focusedIndex)
      ? focusedIndex
      : visibleIndexes.includes(entries.findIndex(slide => slide.id === state.selectedSlideId))
        ? entries.findIndex(slide => slide.id === state.selectedSlideId) : visibleIndexes[0];
    slides.replaceChildren(...visibleIndexes.map((index, offset) => {
      const slide = entries[index];
      const item = document.createElement('li');
      item.dataset.slideIndex = String(index);
      item.draggable = slide.canReorder === true && !query.trim();
      item.style.top = `${(start + offset) * rowHeight}px`;
      item.style.height = `${rowHeight}px`;
      if (dropTarget?.id === slide.id) {
        item.classList.add(dropTarget.after ? 'drop-after' : 'drop-before');
      }
      item.setAttribute('aria-posinset', String(start + offset + 1));
      item.setAttribute('aria-setsize', String(count));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slide-card';
      button.dataset.slideIndex = String(index);
      button.tabIndex = index === tabbableIndex ? 0 : -1;
      if (slide.id === state.selectedSlideId) button.setAttribute('aria-current', 'true');
      const number = document.createElement('span');
      number.className = 'slide-number';
      number.textContent = String(index + 1);
      number.setAttribute('aria-hidden', 'true');
      button.append(number);
      const visual = document.createElement('span');
      visual.className = 'slide-visual';
      const thumbnail = state.renderedMappingAvailable ? state.thumbnails[index] : undefined;
      if (thumbnail) {
        const image = document.createElement('img');
        image.src = thumbnail;
        image.alt = '';
        image.loading = 'lazy';
        image.className = 'slide-thumbnail';
        visual.append(image);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'thumbnail-placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        const outlineTitle = document.createElement('span');
        outlineTitle.className = 'outline-title';
        outlineTitle.textContent = slide.title;
        const label = document.createElement('span');
        label.className = 'outline-label';
        label.textContent = 'Source outline';
        placeholder.append(label, outlineTitle);
        visual.append(placeholder);
      }
      button.append(visual);
      const copy = document.createElement('span');
      copy.className = 'slide-copy';
      const title = document.createElement('span');
      title.className = 'slide-title';
      title.textContent = slide.title;
      copy.append(title);
      button.title = `${slide.title}\n${slide.sourcePath}:${slide.line}${slide.readOnlyReason ? `\n${slide.readOnlyReason}` : ''}`;
      button.setAttribute('aria-label', `${state.renderedMappingAvailable ? 'Slide' : 'Source occurrence'} ${index + 1} of ${entries.length}: ${slide.title}${slide.imported ? ', imported' : ''}`);
      if (slide.canReorder) button.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
      button.addEventListener('click', () => vscode.postMessage({ type: 'selectSlide', id: slide.id }));
      button.addEventListener('dblclick', () => {
        if (slide.canNavigate) vscode.postMessage({ type: 'openSlide', id: slide.id });
      });
      button.addEventListener('focus', () => {
        slides.querySelectorAll('button[data-slide-index]').forEach(entry => {
          entry.tabIndex = entry === button ? 0 : -1;
        });
      });

      const metadata = document.createElement('span');
      metadata.textContent = slide.readOnlyReason ? 'Read-only'
        : slide.imported ? 'Imported'
          : slide.sourceIndex === 1 ? 'Cover' : '';
      metadata.hidden = !metadata.textContent;
      metadata.className = 'slide-meta';
      copy.append(metadata);
      button.append(copy);
      item.append(button);
      return item;
    }));

    if (focusedIndex !== undefined) {
      const focused = slides.querySelector(`button[data-slide-index="${focusedIndex}"]`);
      (focused ?? viewport).focus({ preventScroll: true });
    }
  }

  function getSlideGroupKey(slide) {
    if (!slide) return undefined;
    if (slide.imported) {
      return slide.importReferenceIndex
        ? `import:${slide.importReferencePath}:${slide.importReferenceIndex}`
        : undefined;
    }
    return `local:${slide.sourcePath}:${slide.sourceIndex}`;
  }

  function getSlideGroupRange(slide) {
    const key = getSlideGroupKey(slide);
    if (!key || !state) return;
    const indexes = [];
    for (let index = 0; index < state.slides.length; index++) {
      if (getSlideGroupKey(state.slides[index]) === key) indexes.push(index);
    }
    if (!indexes.length || indexes[indexes.length - 1] - indexes[0] + 1 !== indexes.length) return;
    return { start: indexes[0], end: indexes[indexes.length - 1] };
  }

  function getDropPosition(event, item) {
    const targetIndex = Number(item.dataset.slideIndex);
    const target = state?.slides[targetIndex];
    const source = state?.slides.find(slide => slide.id === draggedSlideId);
    if (!source?.canReorder || !target?.canReorder) return;
    const sourceRange = getSlideGroupRange(source);
    const targetRange = getSlideGroupRange(target);
    if (!sourceRange || !targetRange || getSlideGroupKey(source) === getSlideGroupKey(target)) return;

    const rect = item.getBoundingClientRect();
    const after = event.clientY >= rect.top + rect.height / 2;
    return { id: target.id, after };
  }

  const getSlideItem = target => target instanceof Element
    ? target.closest('li[data-slide-index]')
    : null;

  slides.addEventListener('dragstart', event => {
    const item = getSlideItem(event.target);
    const slide = item && state?.slides[Number(item.dataset.slideIndex)];
    if (!slide?.canReorder || query.trim() || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    draggedSlideId = slide.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', slide.id);
    item.classList.add('dragging');
  });

  slides.addEventListener('dragover', event => {
    if (!draggedSlideId) return;
    const item = getSlideItem(event.target);
    const target = item && getDropPosition(event, item);
    if (!target || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropTarget?.id === target.id && dropTarget.after === target.after) return;
    slides.querySelectorAll('.drop-before, .drop-after').forEach(element => {
      element.classList.remove('drop-before', 'drop-after');
    });
    dropTarget = target;
    item.classList.add(target.after ? 'drop-after' : 'drop-before');
  });

  slides.addEventListener('drop', event => {
    if (!draggedSlideId || !state?.selectedId) return;
    const item = getSlideItem(event.target);
    const target = item && getDropPosition(event, item);
    if (!target) return;
    event.preventDefault();
    vscode.postMessage({
      type: 'moveSlideTo',
      deckId: state.selectedId,
      id: draggedSlideId,
      targetId: target.id,
      after: target.after,
    });
  });

  function clearDragState() {
    draggedSlideId = undefined;
    dropTarget = undefined;
    slides.querySelectorAll('.dragging, .drop-before, .drop-after').forEach(element => {
      element.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  }

  window.addEventListener('dragend', clearDragState);
  slides.addEventListener('dragleave', event => {
    const item = getSlideItem(event.target);
    if (item && !(event.relatedTarget instanceof Node && item.contains(event.relatedTarget))) {
      item.classList.remove('drop-before', 'drop-after');
      if (dropTarget?.id === state?.slides[Number(item.dataset.slideIndex)]?.id) {
        dropTarget = undefined;
      }
    }
  });

  viewport.addEventListener('scroll', () => { renderVisibleSlides(); saveView(); }, { passive: true });
  new ResizeObserver(renderVisibleSlides).observe(viewport);
  slides.addEventListener('keydown', event => {
    const button = event.target.closest('button[data-slide-index]');
    if (!button || !filteredIndexes.length) return;
    const current = Number(button.dataset.slideIndex);
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const slide = state.slides[current];
      if (slide && canMoveSlide(slide, event.key === 'ArrowUp' ? -1 : 1)) {
        vscode.postMessage({
          type: 'moveSlide',
          id: slide.id,
          direction: event.key === 'ArrowUp' ? -1 : 1,
        });
      }
      return;
    }
    const position = filteredIndexes.indexOf(current);
    let target;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = Math.min(filteredIndexes.length - 1, position + 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') target = Math.max(0, position - 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = filteredIndexes.length - 1;
    else return;
    event.preventDefault();
    viewport.scrollTop = Math.max(0, target * rowHeight - Math.floor((viewport.clientHeight - rowHeight) / 2));
    renderVisibleSlides();
    requestAnimationFrame(() => slides.querySelector(`button[data-slide-index="${filteredIndexes[target]}"]`)?.focus());
  });

  window.addEventListener('message', event => {
    const nextState = event.data;
    if (!nextState || nextState.type !== 'state') return;
    state = nextState;
    if (!draggedSlideId) dropTarget = undefined;
    if (
      state.selectedId !== previousDeckId
      || state.thumbnailUiGeneration !== previousThumbnailUiGeneration
      || !state.renderedMappingAvailable
    ) {
      if (state.selectedId !== previousDeckId) clearDragState();
      lastRequestedRange = undefined;
      clearTimeout(rangeTimer);
      if (state.selectedId !== previousDeckId) {
        viewport.scrollTop = 0;
        query = '';
        search.value = '';
      }
    }
    previousDeckId = state.selectedId;
    previousThumbnailUiGeneration = state.thumbnailUiGeneration;

    decks.replaceChildren(...state.decks.map(deck => {
      const option = document.createElement('option');
      option.value = deck.id;
      const duplicateTitle = state.decks.filter(entry => entry.title === deck.title).length > 1;
      option.textContent = duplicateTitle ? `${deck.title} (${deck.path})` : deck.title;
      return option;
    }));
    decks.value = state.selectedId ?? '';
    decks.disabled = state.decks.length === 0;
    const selected = state.decks.find(deck => deck.id === state.selectedId);
    document.getElementById('detail').hidden = !selected;
    document.getElementById('status').textContent = state.decks.length
      ? `${state.decks.length} ${state.decks.length === 1 ? 'presentation' : 'presentations'} in this workspace`
      : 'No presentations found. Add slides*.md with YAML headmatter, or configure slidevStudio.include.';
    document.getElementById('status').classList.toggle('sr-only', state.decks.length > 0);
    if (selected) {
      document.getElementById('title').textContent = selected.title;
      document.getElementById('path').textContent = selected.path;
      document.getElementById('theme').textContent = selected.theme ? `Theme: ${selected.theme}` : 'Theme: Slidev default';
    }
    document.getElementById('issues-section').hidden = state.issues.length === 0;
    document.getElementById('issues').replaceChildren(...state.issues.map(issue => {
      const item = document.createElement('li');
      item.textContent = issue;
      return item;
    }));
    document.getElementById('slide-count').textContent = state.slides.length ? `(${state.slides.length})` : '';
    document.getElementById('slides-heading-label').textContent =
      state.renderedMappingAvailable || !selected ? 'Slides' : 'Source outline';
    document.getElementById('slides').setAttribute('aria-label',
      state.renderedMappingAvailable ? 'Presentation slides' : 'Original Markdown source occurrences');
    document.getElementById('graph-status').textContent = !state.slides.length ? state.graphStatus
      : state.renderedMappingAvailable ? '' : 'Original Markdown. Preview is independent; slide synchronization and thumbnails are unavailable.';
    document.getElementById('slides-empty').hidden = state.slides.length > 0;
    document.getElementById('slides-empty').textContent = selected
      ? 'No slides to display. Check source mapping warnings or open the deck source.'
      : 'Choose a presentation to see its slides.';
    document.getElementById('slides-viewport').hidden = state.slides.length === 0;
    const selectedSlide = state.slides.find(slide => slide.id === state.selectedSlideId);
    const restoringSameDeck = restoreView && savedView.deckId === state.selectedId;
    document.getElementById('selection-section').hidden = !selectedSlide;
    document.getElementById('selection-title').textContent = selectedSlide
      ? `${state.renderedMappingAvailable ? '' : 'Source '}${selectedSlide.deckIndex} / ${state.slides.length}  ${selectedSlide.title}` : '';
    document.getElementById('selection-source').textContent = selectedSlide
      ? `${selectedSlide.sourcePath}:${selectedSlide.line} (source slide ${selectedSlide.sourceIndex})` : '';
    const provenance = document.getElementById('selection-provenance');
    provenance.hidden = !selectedSlide?.importChain.length;
    provenance.textContent = selectedSlide?.importChain.length
      ? `Imported through ${selectedSlide.importChain.join(' → ')}` : '';
    document.getElementById('selection-kind').textContent = selectedSlide?.readOnlyReason ? 'Read-only'
      : selectedSlide?.imported ? 'Imported' : selectedSlide?.sourceIndex === 1 ? 'Cover' : 'Local';
    document.getElementById('selection-kind').hidden =
      !selectedSlide?.readOnlyReason && !selectedSlide?.imported && selectedSlide?.sourceIndex !== 1;
    document.getElementById('selection-hint').textContent = selectedSlide?.readOnlyReason
      ?? (selectedSlide?.imported
        ? `This group references shared source.${selectedSlide.usageCount > 1 ? ` Used ${selectedSlide.usageCount} times.` : ''} Duplicate or remove the reference in More; source files stay untouched.`
        : selectedSlide?.sourceIndex === 1 ? 'The cover stays first and cannot be duplicated or deleted.' : '');
    document.getElementById('open-slide-source').disabled = !selectedSlide?.canNavigate;
    document.getElementById('insert-asset').disabled = !state.canEditSelectedSlide;
    if (!restoringSameDeck && state.selectedSlideId !== previousSelectedSlideId) {
      const more = document.getElementById('more-slide-actions');
      if (more.open && more.contains(document.activeElement)) more.querySelector('summary').focus();
      more.open = false;
    }
    previousSelectedSlideId = state.selectedSlideId;
    document.getElementById('move-slide-up').disabled =
      !selectedSlide || !canMoveSlide(selectedSlide, -1);
    document.getElementById('move-slide-down').disabled =
      !selectedSlide || !canMoveSlide(selectedSlide, 1);
    document.getElementById('add-slide').disabled = !state.canEditSelectedSlide;
    document.getElementById('duplicate-slide').disabled =
      !state.canEditSelectedSlide || !selectedSlide || selectedSlide.sourceIndex === 1;
    document.getElementById('duplicate-slide').hidden = selectedSlide?.imported === true;
    document.getElementById('delete-slide').disabled =
      !state.canEditSelectedSlide || !selectedSlide || selectedSlide.sourceIndex === 1;
    document.getElementById('delete-slide').hidden = selectedSlide?.imported === true;
    document.getElementById('edit-notes').disabled = !state.canEditSelectedSlide;
    document.getElementById('set-layout').disabled = !state.canEditSelectedSlide;
    document.getElementById('remove-import').hidden = !state.canRemoveImportReference;
    document.getElementById('remove-import').disabled = !state.canRemoveImportReference;
    document.getElementById('duplicate-import').hidden = !state.canDuplicateImportReference;
    document.getElementById('duplicate-import').disabled = !state.canDuplicateImportReference;
    document.getElementById('preview-controls').hidden = !state.workspaceTrusted || !selected;
    document.getElementById('preview-section').hidden = !selected;
    document.getElementById('preview-section').dataset.state = state.previewState;
    document.getElementById('preview-indicator').textContent = !state.workspaceTrusted ? 'Restricted mode'
      : ({ running: 'Live', starting: 'Starting…', error: 'Failed', stopped: 'Source only' }[state.previewState] ?? 'Source only');
    document.getElementById('preview-status').textContent = state.workspaceTrusted
      ? ['starting', 'error'].includes(state.previewState) ? state.previewMessage
        : state.previewState === 'running' && !state.renderedMappingAvailable
          ? 'Whole-deck preview. Selecting a source occurrence does not change the rendered slide.' : ''
      : 'Trust this workspace to run the deck code and render a preview.';
    document.getElementById('start-preview').hidden = !state.workspaceTrusted || state.previewState === 'running';
    document.getElementById('start-preview').textContent = state.previewState === 'starting' ? 'Starting preview…'
      : state.previewState === 'error' ? 'Retry preview' : 'Start preview';
    document.getElementById('start-preview').disabled = !state.selectedId || state.previewState === 'starting';
    document.getElementById('stop-preview').hidden = !state.workspaceTrusted
      || !['running', 'starting'].includes(state.previewState);
    document.getElementById('present').disabled = !state.selectedId
      || state.previewState === 'starting';
    document.getElementById('present').classList.toggle('quiet', state.previewState !== 'running');
    document.getElementById('export').disabled = !state.selectedId;
    previewFrame.hidden = state.previewState !== 'running' || !state.previewUrl;
    document.getElementById('preview-empty').hidden = !previewFrame.hidden;
    document.getElementById('preview-empty-message').textContent = !state.workspaceTrusted
      ? 'Preview runs your deck code. Trust this workspace to enable it.'
      : !selected ? 'Choose a presentation to start preview.'
        : state.previewState === 'starting' ? 'Starting the local Slidev server…'
          : state.previewState === 'error' ? 'Preview could not start. Check the error below and retry.'
            : 'Start preview to render this presentation.';
    updatePreviewDisclosure();
    if (
      state.previewState === 'running'
      && state.previewUrl
    ) {
      const selectedSlide = state.slides.find(slide => slide.id === state.selectedSlideId) ?? state.slides[0];
      const slideUrl = state.renderedMappingAvailable && selectedSlide
        ? new URL(String(selectedSlide.deckIndex), state.previewUrl).toString()
        : state.previewUrl;
      if (previewFrame.src !== slideUrl) previewFrame.src = slideUrl;
    } else {
      previewFrame.removeAttribute('src');
    }
    document.getElementById('thumbnail-status').textContent = state.renderedMappingAvailable ? state.thumbnailMessage : '';
    document.getElementById('source-diagnostics-section').hidden = state.sourceDiagnostics.length === 0;
    document.getElementById('source-diagnostics').replaceChildren(...state.sourceDiagnostics.map(issue => {
      const item = document.createElement('li');
      item.textContent = issue;
      return item;
    }));
    renderVisibleSlides();
    if (restoringSameDeck) {
      viewport.scrollTop = savedView.scrollTop ?? 0;
      renderVisibleSlides();
      const focused = document.getElementById(savedView.focusedId);
      if (focused && !focused.hidden && !focused.disabled && focused.getClientRects().length) {
        focused.focus({ preventScroll: true });
      }
    }
    restoreView = false;
    saveView();
  });
  send('ready');
})();
