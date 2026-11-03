import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readDeckMetadata } from './metadata';
import { getMarkdownImageInsertion, getSlidevImageReference } from './assets';
import { isSidebarMessage } from './protocol';
import { buildDeckSourceGraph, readInstalledSlidevVersion, type DeckSourceGraph } from './sourceGraph';
import { maxThumbnailBatchSize, SlidevPreviewSession, type SlidevExportFormat } from './preview';
import {
  addLocalSlideAfter,
  deleteLocalSlide,
  duplicateImportedSlideReference,
  duplicateLocalSlide,
  moveDeckSlideBlockTo,
  locateLocalSlideNotes,
  removeImportedSlideReference,
  setLocalSlideLayout,
  type SlideEditResult,
  type SlideMoveDirection,
} from './slideEdits';

interface Deck {
  id: string;
  title: string;
  path: string;
  uri: vscode.Uri;
  theme?: string;
}

class DeckSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private decks: Deck[] = [];
  private selectedUri: string | undefined;
  private sourceGraph: DeckSourceGraph | undefined;
  private graphStatus = 'Select a presentation to map its slides to source.';
  private previewState: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private previewMessage = 'Start preview to run this deck in Slidev.';
  private previewUri: vscode.Uri | undefined;
  private presenterSession = false;
  private selectedSlideId: string | undefined;
  private preferredSlidePosition: { sourcePath: string; sourceIndex: number; importReferenceIndex?: number } | undefined;
  private thumbnails = new Map<number, string>();
  private thumbnailState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private thumbnailMessage = '';
  private previewGeneration = 0;
  private thumbnailRequestGeneration = 0;
  private thumbnailUiGeneration = 0;
  private pendingThumbnailRange: { start: number; end: number } | undefined;
  private thumbnailWork: Promise<void> | undefined;
  private thumbnailEpoch = randomBytes(8).toString('hex');
  private viewSubscription?: vscode.Disposable;
  private issues: string[] = [];
  private generation = 0;
  private messageSubscription?: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly preview: SlidevPreviewSession,
  ) {
    this.selectedUri = context.workspaceState.get<string>('selectedDeckUri')
      ?? context.workspaceState.get<string>('selectedDeck');
  }

  dispose(): void {
    this.generation++;
    this.messageSubscription?.dispose();
    this.viewSubscription?.dispose();
    this.preview.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        this.context.storageUri ?? this.context.globalStorageUri,
      ],
    };
    this.messageSubscription?.dispose();
    this.viewSubscription?.dispose();
    this.viewSubscription = view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        if (!this.presenterSession) {
          void this.stopPreview().catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`Unable to stop Slidev preview: ${message}`);
          });
        }
      }
    });
    this.view = view;
    this.messageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isSidebarMessage(message)) {
        this.output.appendLine('Rejected an invalid sidebar message.');
        return;
      }
      void this.run(async () => {
        switch (message.type) {
          case 'ready': await this.publish(); break;
          case 'refresh': await this.refresh(); break;
          case 'select': await this.select(message.id); break;
          case 'openSource': await this.openSource(); break;
          case 'openSlide': await this.openSlide(message.id); break;
          case 'selectSlide': await this.selectSlide(message.id); break;
          case 'moveSlide': await this.moveSlide(message.id, message.direction); break;
          case 'moveSlideTo': await this.moveSlideTo(message.deckId, message.id, message.targetId, message.after); break;
          case 'editNotes': await this.editNotes(message.id); break;
          case 'duplicateImportReference': await this.duplicateImportReference(message.id); break;
          case 'removeImportReference': await this.removeImportReference(message.id); break;
          case 'insertAsset': await this.insertAsset(); break;
          case 'setLayout': await this.setLayout(); break;
          case 'addSlide': await this.editSlide(message.id, 'add'); break;
          case 'duplicateSlide': await this.editSlide(message.id, 'duplicate'); break;
          case 'deleteSlide': await this.editSlide(message.id, 'delete'); break;
          case 'startPreview': await this.startPreview(); break;
          case 'stopPreview': await this.stopPreview(); break;
          case 'present': await this.present(); break;
          case 'export': await this.exportDeck(); break;
          case 'thumbnailRange':
            this.requestThumbnailRange(message.start, message.end, message.uiGeneration);
            break;
        }
      });
    });
    view.webview.html = this.html(view.webview, this.previewUri);
    void this.publish();
  }

  async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      await vscode.window.showErrorMessage(`Slidev Studio: ${message}`);
    }
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const previousSelectedUri = this.selectedUri;
    const entries = new Map<string, Deck>();
    const previousIds = new Map(this.decks.map(deck => [deck.uri.toString(), deck.id]));
    const issues: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const patterns = vscode.workspace.getConfiguration('slidevStudio', folder.uri)
        .get<string[]>('include', ['**/slides*.md']);
      for (const pattern of patterns) {
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, pattern),
          '**/{node_modules,.git,dist,exports,.slidev}/**',
        );
        for (const uri of files) {
          if (entries.has(uri.toString())) {
            continue;
          }
          try {
            const document = await vscode.workspace.openTextDocument(uri);
            const metadata = readDeckMetadata(document.getText(), uri.path.split('/').pop() ?? 'Untitled');
            if (metadata) {
              entries.set(uri.toString(), {
                id: previousIds.get(uri.toString()) ?? randomBytes(16).toString('hex'),
                path: vscode.workspace.asRelativePath(uri, true),
                uri,
                ...metadata,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            issues.push(`${vscode.workspace.asRelativePath(uri, true)}: ${message}`);
          }
        }
      }
    }
    if (generation !== this.generation) {
      return;
    }
    this.decks = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.issues = issues;
    for (const issue of issues) {
      this.output.appendLine(issue);
    }
    if (!this.decks.some(deck => deck.uri.toString() === this.selectedUri)) {
      this.selectedUri = this.decks[0]?.uri.toString();
    }
    if (previousSelectedUri !== this.selectedUri && this.previewState !== 'stopped') {
      await this.stopPreview();
    }
    if (previousSelectedUri !== this.selectedUri) {
      this.thumbnails.clear();
      this.thumbnailUiGeneration++;
      this.thumbnailRequestGeneration++;
      this.pendingThumbnailRange = undefined;
    }
    await this.context.workspaceState.update('selectedDeckUri', this.selectedUri);
    await this.updateSourceGraph(generation);
    if (generation !== this.generation) {
      return;
    }
    await this.publish();
  }

  async onWorkspaceTrustChanged(): Promise<void> {
    await this.publish();
  }

  async selectDeck(): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      this.decks.map(deck => ({ label: deck.title, description: deck.path, id: deck.id })),
      { placeHolder: 'Select a Slidev presentation' },
    );
    if (selected) {
      await this.select(selected.id);
    }
  }

  private async select(id: string): Promise<void> {
    const deck = this.decks.find(entry => entry.id === id);
    if (!deck) {
      throw new Error('That deck is no longer available. Refresh the presentations list.');
    }
    if (deck.uri.toString() !== this.selectedUri && this.previewState !== 'stopped') {
      await this.stopPreview();
    }
    const generation = ++this.generation;
    this.selectedUri = deck.uri.toString();
    this.selectedSlideId = undefined;
    this.thumbnails.clear();
    this.thumbnailUiGeneration++;
    this.thumbnailRequestGeneration++;
    this.pendingThumbnailRange = undefined;
    await this.context.workspaceState.update('selectedDeckUri', this.selectedUri);
    await this.updateSourceGraph(generation);
    if (generation !== this.generation) {
      return;
    }
    await this.publish();
  }

  async openSource(): Promise<void> {
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    if (!deck) {
      throw new Error('No presentation selected. Add a deck or refresh the presentations list.');
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(deck.uri));
  }

  async insertAsset(): Promise<void> {
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const folder = deck && vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!deck || !folder) {
      throw new Error('Select a presentation in an available workspace folder before inserting an image.');
    }

    const assets = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*.{png,jpg,jpeg,gif,webp,avif,svg}'),
      '**/{node_modules,.git,dist,exports,.slidev}/**',
      500,
    );
    if (assets.length === 0) {
      throw new Error('No workspace images were found. Add an image to the workspace first.');
    }
    const selected = await vscode.window.showQuickPick(
      assets.map(uri => ({
        label: uri.path.split('/').pop() ?? uri.fsPath,
        description: vscode.workspace.asRelativePath(uri, true),
        uri,
      })),
      { placeHolder: 'Choose a workspace image to insert' },
    );
    if (!selected) return;

    const rootPath = await realpath(folder.uri.fsPath);
    const assetPath = await realpath(selected.uri.fsPath);
    const deckPath = await realpath(deck.uri.fsPath);
    const reference = getSlidevImageReference(rootPath, deckPath, assetPath);
    const insertion = getMarkdownImageInsertion(assetPath, reference);
    const document = await vscode.workspace.openTextDocument(deck.uri);
    const editor = vscode.window.activeTextEditor?.document.uri.toString() === deck.uri.toString()
      ? vscode.window.activeTextEditor
      : await vscode.window.showTextDocument(document);
    if (!editor) {
      throw new Error('Open the selected presentation before inserting an image.');
    }
    if (!await editor.edit(edit => edit.replace(editor.selection, insertion))) {
      throw new Error('VS Code could not insert the image reference.');
    }
  }

  async setLayout(): Promise<void> {
    const graph = this.sourceGraph;
    const slide = graph?.slides.find(entry => entry.id === this.selectedSlideId);
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const folder = deck && vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!graph || !slide || !deck || !folder) {
      throw new Error('Select a slide in an available presentation before choosing a layout.');
    }
    this.requireLocalDeckSource(deck, slide);

    const rootPath = await realpath(folder.uri.fsPath);
    const themeName = deck.theme?.trim() || 'default';
    const packageName = themeName === 'default'
      ? '@slidev/theme-default'
      : themeName.startsWith('@') || themeName.includes('/')
        ? themeName
        : `@slidev/theme-${themeName}`;
    if (themeName.startsWith('.')) {
      const localThemePath = resolve(rootPath, themeName);
      const relativeThemePath = relative(rootPath, localThemePath);
      if (relativeThemePath === '..' || relativeThemePath.startsWith(`..${sep}`) || isAbsolute(relativeThemePath)) {
        throw new Error('The active local theme must be inside the current workspace folder.');
      }
    } else {
      const packageSegments = packageName.split(/[\\/]/);
      if (
        isAbsolute(packageName)
        || packageSegments.some(segment => !segment || segment === '..' || segment === '.')
      ) {
        throw new Error('The active theme name is not a valid installed package name.');
      }
    }
    const themeDirectory = themeName.startsWith('.')
      ? resolve(rootPath, themeName)
      : resolve(rootPath, 'node_modules', ...packageName.split(/[\\/]/));
    const layouts = new Map<string, string>();
    const layoutDirectories = [
      { path: join(themeDirectory, 'layouts'), source: 'Active theme' },
      { path: join(rootPath, 'layouts'), source: 'Workspace layouts' },
      { path: join(rootPath, 'setup', 'layouts'), source: 'Workspace setup layouts' },
    ];
    for (const { path, source } of layoutDirectories) {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      for (const entry of entries) {
        if (entry.isFile() && /\.vue$/i.test(entry.name)) {
          const name = entry.name.replace(/\.vue$/i, '');
          if (/^[\w.-]+$/.test(name) && name !== '.' && name !== '..') {
            layouts.set(name, source);
          }
        }
      }
    }
    if (layouts.size === 0) {
      throw new Error(`No layout components were found for theme "${themeName}", layouts, or setup/layouts.`);
    }
    const selected = await vscode.window.showQuickPick(
      [...layouts].map(([name, source]) => ({
        label: name,
        description: source,
      })),
      { placeHolder: `Choose a layout from ${themeName}` },
    );
    if (!selected) return;

    const document = await vscode.workspace.openTextDocument(deck.uri);
    const documentVersion = document.version;
    const original = document.getText();
    const updated = await setLocalSlideLayout(original, slide.sourceIndex, selected.label, {
      title: slide.title,
      line: slide.line,
    });
    const currentSlide = this.sourceGraph?.slides.find(entry => entry.id === slide.id);
    if (
      this.sourceGraph !== graph
      || this.selectedUri !== deck.uri.toString()
      || !currentSlide
      || currentSlide.sourceIndex !== slide.sourceIndex
      || document.version !== documentVersion
      || document.getText() !== original
    ) {
      throw new Error('The deck changed while choosing a layout. Refresh the deck and try again.');
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), updated);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error('VS Code could not apply the selected layout.');
    }
    this.preferredSlidePosition = { sourcePath: slide.sourcePath, sourceIndex: slide.sourceIndex };
    await this.onWorkspaceFilesChanged(true);
  }

  private async selectSlide(id: string): Promise<void> {
    const slide = this.sourceGraph?.slides.find(entry => entry.id === id);
    if (!slide) {
      throw new Error('That slide is no longer available. Refresh the presentations list.');
    }
    this.selectedSlideId = slide.id;
    await this.publish();
  }

  private async openSlide(id: string): Promise<void> {
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const slide = this.sourceGraph?.slides.find(entry => entry.id === id);
    if (!deck || !slide) {
      throw new Error('That slide is no longer available. Refresh the presentations list.');
    }
    if (!slide.canNavigate) {
      throw new Error(slide.readOnlyReason ?? 'Source mapping is unavailable for this slide.');
    }

    const folder = vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!folder) {
      throw new Error('The selected presentation is not in an available workspace folder.');
    }
    const sourceUri = vscode.Uri.joinPath(folder.uri, ...slide.sourcePath.split(/[\\/]/));
    const document = await vscode.workspace.openTextDocument(sourceUri);
    const line = Math.min(slide.line - 1, document.lineCount - 1);
    const position = new vscode.Position(Math.max(0, line), 0);
    const range = new vscode.Range(position, position);
    this.selectedSlideId = slide.id;
    const editor = await vscode.window.showTextDocument(document, { selection: range });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    await this.publish();
  }

  private async editNotes(id: string): Promise<void> {
    const graph = this.sourceGraph;
    const slide = graph?.slides.find(entry => entry.id === id);
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const folder = deck && vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!graph || !slide || !deck || !folder) {
      throw new Error('That slide is no longer available. Refresh the presentations list.');
    }

    this.requireLocalDeckSource(deck, slide);
    const document = await vscode.workspace.openTextDocument(deck.uri);
    const documentVersion = document.version;
    const original = document.getText();
    const location = await locateLocalSlideNotes(original, slide.sourceIndex, {
      title: slide.title,
      line: slide.line,
    });
    if (location.externalPath) {
      if (/%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_]/.test(location.externalPath)) {
        throw new Error('The _note path contains a variable placeholder; resolve it in the workspace before editing.');
      }
      const externalPath = resolve(folder.uri.fsPath, location.externalPath);
      const relativePath = relative(folder.uri.fsPath, externalPath);
      if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('The _note path escapes the current workspace folder and cannot be edited.');
      }
      const actualRoot = await realpath(folder.uri.fsPath);
      const actualPath = await realpath(externalPath);
      const actualRelative = relative(actualRoot, actualPath);
      if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) {
        throw new Error('The _note file resolves outside the current workspace folder and cannot be edited.');
      }
      if (!(await stat(actualPath)).isFile()) {
        throw new Error('The _note path does not point to a file.');
      }
      if (this.sourceGraph !== graph || this.selectedUri !== deck.uri.toString()) {
        throw new Error('The selected slide changed while resolving its _note file. Refresh and try again.');
      }
      const confirmation = await vscode.window.showWarningMessage(
        `Open external notes for "${slide.title}"?`,
        {
          modal: true,
          detail: `This custom _note convention is read directly from ${vscode.workspace.asRelativePath(vscode.Uri.file(actualPath), true)}. Editing it may affect other slides or decks. Custom preparser code is never executed by Slidev Studio.`,
        },
        'Open Notes',
      );
      if (confirmation !== 'Open Notes') return;
      if (
        this.sourceGraph !== graph
        || this.selectedUri !== deck.uri.toString()
        || document.version !== documentVersion
        || document.getText() !== original
      ) {
        throw new Error('The deck changed while opening its _note file. Refresh and try again.');
      }
      const notesDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(actualPath));
      await vscode.window.showTextDocument(notesDocument);
      return;
    }

    if (
      this.sourceGraph !== graph
      || this.selectedUri !== deck.uri.toString()
      || document.version !== documentVersion
      || document.getText() !== original
    ) {
      throw new Error('The deck changed while preparing to edit its notes. Refresh and try again.');
    }
    if (location.insertion) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, document.positionAt(location.insertion.offset), location.insertion.text);
      if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error('VS Code could not add a speaker-notes comment.');
      }
    }
    const start = document.positionAt(location.selectionStart ?? location.start);
    const end = document.positionAt(location.selectionStart ?? location.end);
    const editor = await vscode.window.showTextDocument(document, { selection: new vscode.Range(start, end) });
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
  }

  private async removeImportReference(id: string): Promise<void> {
    const graph = this.sourceGraph;
    const slide = graph?.slides.find(entry => entry.id === id);
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    if (!graph || !slide || !deck || !this.isDeckImportReference(deck, slide) || !slide.importReferenceIndex) {
      throw new Error('That imported slide reference is no longer available. Refresh the presentations list.');
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Remove the imported slide reference for "${slide.title}" from ${deck.path}?`,
      {
        modal: true,
        detail: 'This removes the import entry from this deck. It may remove several rendered slides, but the shared Markdown file and other decks are unchanged.',
      },
      'Remove Reference',
    );
    if (confirmation !== 'Remove Reference') return;

    const currentSlide = this.sourceGraph?.slides.find(entry => entry.id === id);
    if (
      this.sourceGraph !== graph
      || this.selectedUri !== deck.uri.toString()
      || !currentSlide
      || currentSlide.importReferencePath !== slide.importReferencePath
      || currentSlide.importReferenceIndex !== slide.importReferenceIndex
      || currentSlide.importReferenceLine !== slide.importReferenceLine
    ) {
      throw new Error('The imported reference changed while confirming. Refresh and try again.');
    }

    const document = await vscode.workspace.openTextDocument(deck.uri);
    const documentVersion = document.version;
    const original = document.getText();
    const updated = await removeImportedSlideReference(
      original,
      slide.importReferenceIndex,
      {
        title: slide.importReferenceTitle ?? `Slide ${slide.importReferenceIndex}`,
        line: slide.importReferenceLine ?? slide.line,
      },
    );
    if (
      this.sourceGraph !== graph
      || this.selectedUri !== deck.uri.toString()
      || document.version !== documentVersion
      || document.getText() !== original
    ) {
      throw new Error('The deck changed while preparing to remove the import reference. Refresh and try again.');
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), updated.text);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error('VS Code could not remove the imported slide reference.');
    }
    this.preferredSlidePosition = {
      sourcePath: slide.sourcePath,
      sourceIndex: slide.sourceIndex,
    };
    await this.onWorkspaceFilesChanged(true);
  }

  private async duplicateImportReference(id: string): Promise<void> {
    const graph = this.sourceGraph;
    const slide = graph?.slides.find(entry => entry.id === id);
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    if (!graph || !slide || !deck || !this.isDeckImportReference(deck, slide) || !slide.importReferenceIndex) {
      throw new Error('That imported slide reference is no longer available. Refresh the presentations list.');
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Duplicate the imported group for "${slide.title}" in ${deck.path}?`,
      {
        modal: true,
        detail: 'The new entry points to the same shared Markdown. Editing that source will affect both groups and any other decks that import it.',
      },
      'Duplicate Reference',
    );
    if (confirmation !== 'Duplicate Reference') return;

    const currentSlide = this.sourceGraph?.slides.find(entry => entry.id === id);
    if (
      this.sourceGraph !== graph
      || this.selectedUri !== deck.uri.toString()
      || !currentSlide
      || currentSlide.importReferencePath !== slide.importReferencePath
      || currentSlide.importReferenceIndex !== slide.importReferenceIndex
      || currentSlide.importReferenceLine !== slide.importReferenceLine
    ) {
      throw new Error('The imported reference changed while confirming. Refresh and try again.');
    }

    const document = await vscode.workspace.openTextDocument(deck.uri);
    const documentVersion = document.version;
    const original = document.getText();
    const result = await duplicateImportedSlideReference(
      original,
      slide.importReferenceIndex,
      {
        title: slide.importReferenceTitle ?? `Slide ${slide.importReferenceIndex}`,
        line: slide.importReferenceLine ?? slide.line,
      },
    );
    if (
      this.sourceGraph !== graph
      || this.selectedUri !== deck.uri.toString()
      || document.version !== documentVersion
      || document.getText() !== original
    ) {
      throw new Error('The deck changed while preparing to duplicate the import reference. Refresh and try again.');
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), result.text);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error('VS Code could not duplicate the imported slide reference.');
    }
    this.preferredSlidePosition = {
      sourcePath: slide.sourcePath,
      sourceIndex: slide.sourceIndex,
      importReferenceIndex: result.selectedSourceIndex,
    };
    await this.onWorkspaceFilesChanged(true);
  }

  private async moveSlide(id: string, direction: SlideMoveDirection): Promise<void> {
    const graph = this.sourceGraph;
    const slide = graph?.slides.find(entry => entry.id === id);
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    if (!graph || !slide || !deck) {
      throw new Error('That slide is no longer available. Refresh the presentations list.');
    }
    const blockIndex = this.getDeckBlockIndex(deck, slide);
    const range = blockIndex === undefined ? undefined : this.getDeckBlockRange(graph, deck, blockIndex);
    if (!range) {
      throw new Error('Only local slides and top-level imported groups can be moved.');
    }
    const neighborDeckIndex = direction < 0 ? range.firstDeckIndex - 1 : range.lastDeckIndex + 1;
    const neighbor = graph.slides.find(entry => entry.deckIndex === neighborDeckIndex);
    if (!neighbor || this.getDeckBlockIndex(deck, neighbor) === undefined) {
      throw new Error('The cover stays fixed; only local slides and top-level imported groups can be moved.');
    }
    await this.moveSlideTo(deck.id, slide.id, neighbor.id, direction > 0);
  }

  private async moveSlideTo(deckId: string, id: string, targetId: string, after: boolean): Promise<void> {
    const graph = this.sourceGraph;
    const slide = graph?.slides.find(entry => entry.id === id);
    const target = graph?.slides.find(entry => entry.id === targetId);
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    if (!graph || !slide || !target || !deck || deck.id !== deckId) {
      throw new Error('That slide is no longer available. Refresh the presentations list.');
    }
    const sourceBlockIndex = this.getDeckBlockIndex(deck, slide);
    const targetBlockIndex = this.getDeckBlockIndex(deck, target);
    if (sourceBlockIndex === undefined || targetBlockIndex === undefined) {
      throw new Error('Only local slides and top-level imported groups can be reordered.');
    }
    if (sourceBlockIndex === targetBlockIndex) return;
    if (!this.getDeckBlockRange(graph, deck, sourceBlockIndex) || !this.getDeckBlockRange(graph, deck, targetBlockIndex)) {
      throw new Error('The selected slide group is not contiguous in the presentation.');
    }

    const insertionIndex = targetBlockIndex + (after ? 1 : 0);
    const targetFinalIndex = insertionIndex > sourceBlockIndex
      ? insertionIndex - 1
      : insertionIndex;
    if (targetFinalIndex < 2) throw new Error('The cover stays fixed.');
    await this.reorderDeckBlockTo(deck, graph, slide, target, targetFinalIndex);
  }

  private getDeckBlockIndex(deck: Deck, slide: DeckSourceGraph['slides'][number]): number | undefined {
    if (slide.sourceIndex > 1 && this.isLocalDeckSlide(deck, slide)) return slide.sourceIndex;
    if (this.isDeckImportReference(deck, slide)) return slide.importReferenceIndex;
    return undefined;
  }

  private getDeckBlockRange(
    graph: DeckSourceGraph,
    deck: Deck,
    blockIndex: number,
  ): { firstDeckIndex: number; lastDeckIndex: number } | undefined {
    const matching = graph.slides.filter(slide => this.getDeckBlockIndex(deck, slide) === blockIndex);
    if (matching.length === 0) return undefined;
    const firstDeckIndex = matching[0]!.deckIndex;
    const lastDeckIndex = matching.at(-1)!.deckIndex;
    return lastDeckIndex - firstDeckIndex + 1 === matching.length
      ? { firstDeckIndex, lastDeckIndex }
      : undefined;
  }

  private async reorderDeckBlockTo(
    deck: Deck,
    graph: DeckSourceGraph,
    slide: DeckSourceGraph['slides'][number],
    target: DeckSourceGraph['slides'][number],
    targetBlockIndex: number,
  ): Promise<void> {
    const sourceBlockIndex = this.getDeckBlockIndex(deck, slide);
    if (sourceBlockIndex === undefined || this.sourceGraph !== graph) {
      throw new Error('The selected slide group changed. Refresh the presentations list and try again.');
    }
    const document = await vscode.workspace.openTextDocument(deck.uri);
    const documentVersion = document.version;
    const original = document.getText();
    const expected = (entry: DeckSourceGraph['slides'][number]) => entry.imported
      ? {
          title: entry.importReferenceTitle ?? `Slide ${entry.importReferenceIndex}`,
          line: entry.importReferenceLine ?? entry.line,
        }
      : { title: entry.title, line: entry.line };
    const updated = await moveDeckSlideBlockTo(
      original,
      sourceBlockIndex,
      targetBlockIndex,
      expected(slide),
      expected(target),
    );
    const currentSlide = this.sourceGraph?.slides.find(entry => entry.id === slide.id);
    if (
      this.selectedUri !== deck.uri.toString()
      || this.sourceGraph !== graph
      || !currentSlide
      || currentSlide.sourcePath !== slide.sourcePath
      || currentSlide.sourceIndex !== slide.sourceIndex
      || currentSlide.importReferenceIndex !== slide.importReferenceIndex
      || document.version !== documentVersion
      || document.getText() !== original
    ) {
      throw new Error('The deck changed while preparing the move. Refresh the deck and try again.');
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(original.length)),
      updated,
    );
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error('VS Code could not apply the slide move.');
    }

    this.preferredSlidePosition = {
      sourcePath: slide.sourcePath,
      sourceIndex: slide.sourceIndex,
      ...(slide.imported ? { importReferenceIndex: targetBlockIndex } : {}),
    };
    await this.onWorkspaceFilesChanged(true);
  }

  private requireLocalDeckSource(deck: Deck, slide: DeckSourceGraph['slides'][number]): void {
    const folder = vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!folder) {
      throw new Error('The selected presentation is not in an available workspace folder.');
    }
    if (!this.isLocalDeckSlide(deck, slide)) {
      throw new Error('Only slides authored directly in the selected deck can be edited.');
    }
  }

  private isLocalDeckSlide(deck: Deck, slide: DeckSourceGraph['slides'][number]): boolean {
    if (!slide.canNavigate || slide.imported || slide.usageCount !== 1) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!folder) {
      return false;
    }
    const sourcePath = resolve(folder.uri.fsPath, slide.sourcePath);
    const deckPath = resolve(deck.uri.fsPath);
    const samePath = process.platform === 'win32'
      ? sourcePath.toLocaleLowerCase('en-US') === deckPath.toLocaleLowerCase('en-US')
      : sourcePath === deckPath;
    return samePath;
  }

  private isDeckImportReference(deck: Deck, slide: DeckSourceGraph['slides'][number]): boolean {
    if (
      !slide.canNavigate
      || !slide.imported
      || !slide.importReferencePath
      || !slide.importReferenceIndex
      || slide.importReferenceIndex <= 1
    ) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!folder) return false;
    const referencePath = resolve(folder.uri.fsPath, slide.importReferencePath);
    const deckPath = resolve(deck.uri.fsPath);
    return process.platform === 'win32'
      ? referencePath.toLocaleLowerCase('en-US') === deckPath.toLocaleLowerCase('en-US')
      : referencePath === deckPath;
  }

  private async editSlide(
    id: string,
    operation: 'add' | 'duplicate' | 'delete',
  ): Promise<void> {
    const slide = this.sourceGraph?.slides.find(entry => entry.id === id);
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    if (!slide || !deck) {
      throw new Error('That slide is no longer available. Refresh the presentations list.');
    }
    if (!slide.canNavigate || slide.imported || slide.usageCount !== 1) {
      throw new Error(slide.readOnlyReason ?? 'Only local slides with a verified source map can be edited.');
    }
    if (operation !== 'add' && slide.sourceIndex === 1) {
      throw new Error('The cover slide cannot be duplicated or deleted.');
    }
    this.requireLocalDeckSource(deck, slide);

    if (operation === 'delete') {
      const confirmation = await vscode.window.showWarningMessage(
        `Delete "${slide.title}" from ${deck.path}? You can undo this change.`,
        { modal: true, detail: 'The slide source will be removed from this deck. Shared or imported files are never deleted.' },
        'Delete Slide',
      );
      if (confirmation !== 'Delete Slide') {
        return;
      }
    }

    const currentSlide = this.sourceGraph?.slides.find(entry => entry.id === id);
    if (!currentSlide || currentSlide.sourcePath !== slide.sourcePath || currentSlide.sourceIndex !== slide.sourceIndex) {
      throw new Error('The selected slide changed while confirming the operation. Refresh and try again.');
    }
    const document = await vscode.workspace.openTextDocument(deck.uri);
    const documentVersion = document.version;
    const original = document.getText();
    const expected = { title: slide.title, line: slide.line };
    let result: SlideEditResult;
    if (operation === 'add') {
      result = await addLocalSlideAfter(original, slide.sourceIndex, expected);
    } else if (operation === 'duplicate') {
      result = await duplicateLocalSlide(original, slide.sourceIndex, expected);
    } else {
      result = await deleteLocalSlide(original, slide.sourceIndex, expected);
    }
    if (document.version !== documentVersion || document.getText() !== original) {
      throw new Error('The deck changed while preparing the edit. Refresh the deck and try again.');
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(original.length)),
      result.text,
    );
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error(`VS Code could not ${operation} the slide.`);
    }

    this.preferredSlidePosition = {
      sourcePath: slide.sourcePath,
      sourceIndex: result.selectedSourceIndex,
    };
    await this.onWorkspaceFilesChanged(true);
  }

  async startPreview(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.previewMessage = 'Trust this workspace before running Slidev code.';
      await this.publish();
      return;
    }
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const folder = deck && vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!deck || !folder) {
      throw new Error('Select a presentation in a local workspace folder before starting preview.');
    }

    const generation = ++this.previewGeneration;
    this.previewState = 'starting';
    this.previewMessage = 'Starting the workspace Slidev server...';
    this.thumbnailState = 'idle';
    this.thumbnailMessage = '';
    this.thumbnails.clear();
    this.thumbnailUiGeneration++;
    this.thumbnailRequestGeneration++;
    this.pendingThumbnailRange = undefined;
    this.previewUri = undefined;
    await this.publish();

    try {
      const server = await this.preview.startServer(folder.uri.fsPath, deck.uri.fsPath);
      if (generation !== this.previewGeneration) {
        await this.preview.stopServer();
        return;
      }
      this.previewUri = await vscode.env.asExternalUri(vscode.Uri.parse(server.url));
      this.previewState = 'running';
      this.previewMessage = 'Slidev preview is running in this workspace.';
      this.view && (this.view.webview.html = this.html(this.view.webview, this.previewUri));
      await this.publish();
    } catch (error) {
      if (generation === this.previewGeneration) {
        await this.preview.stopServer();
      }
      if (generation === this.previewGeneration) {
        this.previewState = 'error';
        this.previewMessage = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`Slidev preview: ${this.previewMessage}`);
        await this.publish();
      }
      throw error;
    }
  }

  async present(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before running Slidev code.');
    }
    if (this.previewState !== 'running' || !this.previewUri) {
      await this.startPreview();
    }
    if (!this.previewUri) {
      throw new Error('Slidev preview is not available. Start the preview and try again.');
    }
    const presenterUri = vscode.Uri.joinPath(this.previewUri, 'presenter');
    this.presenterSession = true;
    if (!await vscode.env.openExternal(presenterUri)) {
      this.presenterSession = false;
      throw new Error('VS Code could not open the Slidev presenter view in your browser.');
    }
  }

  async exportDeck(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before exporting Slidev content.');
    }
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const folder = deck && vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!deck || !folder) {
      throw new Error('Select a presentation in an available workspace folder before exporting.');
    }
    const formats: Array<{ label: string; description: string; format: SlidevExportFormat }> = [
      { label: 'PDF', description: 'Portable document', format: 'pdf' },
      { label: 'PNG', description: 'Rendered slide images', format: 'png' },
      { label: 'PowerPoint', description: 'Slide images in a .pptx file', format: 'pptx' },
    ];
    const format = await vscode.window.showQuickPick(
      formats,
      { placeHolder: 'Choose an export format' },
    );
    if (!format) {
      return;
    }

    const safeTitle = deck.title.replace(/[<>:"/\\|?*]/g, '-').trim() || 'slides';
    let outputPath: string;
    if (format.format === 'png') {
      const output = await vscode.window.showOpenDialog({
        title: `Choose a folder for ${deck.title} PNG images`,
        defaultUri: folder.uri,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Export here',
      });
      if (!output?.[0]) return;
      outputPath = output[0].fsPath;
    } else {
      const output = await vscode.window.showSaveDialog({
        title: `Export ${deck.title} as ${format.label}`,
        defaultUri: vscode.Uri.file(resolve(folder.uri.fsPath, `${safeTitle}-export.${format.format}`)),
        filters: { [format.label]: [format.format] },
        saveLabel: 'Export',
      });
      if (!output) return;
      outputPath = output.fsPath;
    }

    let completedOutput = outputPath;
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Exporting ${deck.title} as ${format.label}`,
      cancellable: true,
    }, async (progress, token) => {
      const cancellation = token.onCancellationRequested(() => {
        void this.preview.cancelExport().catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`Unable to cancel Slidev export: ${message}`);
        });
      });
      let outputTail = '';
      try {
        if (token.isCancellationRequested) {
          throw new Error('Slidev export was cancelled.');
        }
        completedOutput = await this.preview.exportDeck(
          folder.uri.fsPath,
          deck.uri.fsPath,
          outputPath,
          format.format,
          text => {
            outputTail = `${outputTail}${text}`.slice(-800);
            const lastLine = outputTail.trim().split(/\r?\n/).pop();
            if (lastLine) {
              progress.report({ message: lastLine.slice(-160) });
            }
          },
          safeTitle,
        );
        if (token.isCancellationRequested) {
          throw new Error('Slidev export was cancelled.');
        }
      } finally {
        cancellation.dispose();
      }
    });
    await vscode.window.showInformationMessage(`Export complete: ${completedOutput}`);
  }

  async stopPreview(): Promise<void> {
    this.previewGeneration++;
    await this.preview.stop();
    this.presenterSession = false;
    this.previewState = 'stopped';
    this.previewMessage = 'Preview stopped.';
    this.previewUri = undefined;
    this.thumbnails.clear();
    this.thumbnailUiGeneration++;
    this.thumbnailRequestGeneration++;
    this.pendingThumbnailRange = undefined;
    this.thumbnailState = 'idle';
    this.thumbnailMessage = '';
    if (this.view) {
      this.view.webview.html = this.html(this.view.webview);
    }
    await this.publish();
  }

  async onWorkspaceFilesChanged(refreshDecks: boolean): Promise<void> {
    this.thumbnailEpoch = randomBytes(8).toString('hex');
    this.previewGeneration++;
    this.thumbnailUiGeneration++;
    this.thumbnailRequestGeneration++;
    this.pendingThumbnailRange = undefined;
    this.thumbnails.clear();
    this.thumbnailState = this.previewUri ? 'loading' : 'idle';
    this.thumbnailMessage = this.previewUri ? 'Refreshing rendered thumbnails...' : '';
    await this.preview.invalidateThumbnails();
    if (refreshDecks) {
      await this.refresh();
    }
    await this.publish();
  }

  private requestThumbnailRange(start: number, end: number, uiGeneration: number): void {
    const graph = this.sourceGraph;
    if (
      !vscode.workspace.isTrusted
      || this.previewState !== 'running'
      || !graph
      || !graph.renderedMappingAvailable
      || uiGeneration !== this.thumbnailUiGeneration
    ) {
      return;
    }
    if (
      start < 1
      || end < start
      || end > graph.slides.length
      || end - start + 1 > maxThumbnailBatchSize
    ) {
      throw new Error('The requested thumbnail range is outside the visible slide window.');
    }
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const folder = deck && vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!deck || !folder) {
      throw new Error('The selected presentation is not in an available workspace folder.');
    }

    this.pendingThumbnailRange = { start, end };
    this.thumbnailRequestGeneration++;
    this.thumbnailState = 'loading';
    this.thumbnailMessage = `Rendering visible slides ${start}-${end}...`;
    void this.publish().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Unable to publish thumbnail progress: ${message}`);
    });
    if (this.thumbnailWork) {
      void this.preview.cancelThumbnailExport().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`Unable to cancel stale thumbnail export: ${message}`);
      });
      return;
    }
    this.startNextThumbnailRange();
  }

  private startNextThumbnailRange(): void {
    const range = this.pendingThumbnailRange;
    if (!this.sourceGraph?.renderedMappingAvailable) {
      this.pendingThumbnailRange = undefined;
      return;
    }
    if (!range || this.thumbnailWork) {
      return;
    }
    this.pendingThumbnailRange = undefined;
    const requestGeneration = this.thumbnailRequestGeneration;
    const previewGeneration = this.previewGeneration;
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const folder = deck && vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!deck || !folder) {
      this.thumbnailState = 'error';
      this.thumbnailMessage = 'Select a presentation in an available workspace folder to render thumbnails.';
      void this.publish();
      return;
    }
    const work = this.captureThumbnailRange(
      range,
      requestGeneration,
      previewGeneration,
      deck,
      folder,
    );
    this.thumbnailWork = work;
    void work.then(() => {
      if (this.thumbnailWork === work) {
        this.thumbnailWork = undefined;
      }
      if (this.pendingThumbnailRange) {
        this.startNextThumbnailRange();
      }
    }, error => {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Unable to complete thumbnail request: ${message}`);
      if (this.thumbnailWork === work) {
        this.thumbnailWork = undefined;
      }
      if (this.pendingThumbnailRange) {
        this.startNextThumbnailRange();
      }
    });
  }

  private async captureThumbnailRange(
    range: { start: number; end: number },
    requestGeneration: number,
    previewGeneration: number,
    deck: Deck,
    folder: vscode.WorkspaceFolder,
  ): Promise<void> {
    const graph = this.sourceGraph;
    if (!graph?.renderedMappingAvailable) {
      this.thumbnailState = 'error';
      this.thumbnailMessage = 'Slide source mapping is unavailable; thumbnails cannot be aligned with the filmstrip.';
      await this.publish();
      return;
    }

    try {
      const cacheRoot = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
      const fingerprint = createHash('sha256')
        .update(deck.uri.toString())
        .update('\0')
        .update(graph.fingerprint)
        .update('\0')
        .update(this.thumbnailEpoch)
        .update('\0')
        .update('1280x720:initial-click-state')
        .digest('hex');
      const paths = await this.preview.captureThumbnails(
        folder.uri.fsPath,
        deck.uri.fsPath,
        cacheRoot,
        fingerprint,
        range.start,
        range.end,
        graph.slides.length,
      );
      if (
        previewGeneration !== this.previewGeneration
        || requestGeneration !== this.thumbnailRequestGeneration
        || this.sourceGraph?.fingerprint !== graph.fingerprint
        || !this.sourceGraph.renderedMappingAvailable
      ) {
        return;
      }
      for (const thumbnail of paths) {
        this.thumbnails.set(thumbnail.slide, thumbnail.path);
      }
      this.thumbnailState = 'ready';
      this.thumbnailMessage = `${this.thumbnails.size} of ${graph.slides.length} thumbnails rendered; visible slides are prioritized.`;
    } catch (error) {
      if (
        previewGeneration !== this.previewGeneration
        || requestGeneration !== this.thumbnailRequestGeneration
        || this.sourceGraph?.fingerprint !== graph.fingerprint
        || !this.sourceGraph.renderedMappingAvailable
      ) {
        return;
      }
      this.thumbnailState = 'error';
      this.thumbnailMessage = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`${deck.path}: thumbnail rendering failed: ${this.thumbnailMessage}`);
    }
    await this.publish();
  }

  private async updateSourceGraph(generation: number): Promise<void> {
    const deck = this.decks.find(entry => entry.uri.toString() === this.selectedUri);
    const previousFingerprint = this.sourceGraph?.fingerprint;
    this.sourceGraph = undefined;
    if (!deck) {
      this.graphStatus = 'Select a presentation to map its slides to source.';
      return;
    }

    this.graphStatus = 'Parsing slides and resolving imports...';
    const folder = vscode.workspace.getWorkspaceFolder(deck.uri);
    if (!folder) {
      this.graphStatus = 'The selected presentation is not in an available workspace folder.';
      return;
    }

    try {
      const preparsers = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, 'setup/preparser.*'),
        '**/{node_modules,.git,dist,exports,.slidev}/**',
      );
      const slidevVersion = await readInstalledSlidevVersion(folder.uri.fsPath);
      const document = await vscode.workspace.openTextDocument(deck.uri);
      const graph = await buildDeckSourceGraph(deck.uri.fsPath, folder.uri.fsPath, {
        customPreparser: preparsers.length > 0,
        slidevVersion,
        entryMarkdown: document.getText(),
      });
      if (generation !== this.generation) {
        return;
      }
      this.sourceGraph = graph;
      if (graph.fingerprint !== previousFingerprint) {
        this.thumbnails.clear();
        this.thumbnailUiGeneration++;
        this.thumbnailRequestGeneration++;
        this.pendingThumbnailRange = undefined;
        this.thumbnailState = 'idle';
        this.thumbnailMessage = '';
        await this.preview.cancelThumbnailExport();
        if (generation !== this.generation) return;
      }
      const preferred = this.preferredSlidePosition;
      const preferredSlide = preferred && graph.slides.find(slide =>
        slide.sourcePath === preferred.sourcePath
        && slide.sourceIndex === preferred.sourceIndex
        && (
          preferred.importReferenceIndex === undefined
          || slide.importReferenceIndex === preferred.importReferenceIndex
        ),
      );
      if (preferred) {
        this.preferredSlidePosition = undefined;
      }
      if (preferredSlide) {
        this.selectedSlideId = preferredSlide.id;
      } else if (!graph.slides.some(slide => slide.id === this.selectedSlideId)) {
        this.selectedSlideId = graph.slides[0]?.id;
      }
      if (graph.slides.length === 0) {
        this.selectedSlideId = undefined;
      }
      this.graphStatus = graph.slides.length
        ? graph.renderedMappingAvailable
          ? `${graph.slides.length} slide occurrence(s) mapped to source.`
          : `${graph.slides.length} source occurrence(s) parsed from original Markdown; rendered order is unverified.`
        : 'No renderable slides were found.';
      for (const diagnostic of graph.diagnostics) {
        this.output.appendLine(`${deck.path}: ${diagnostic}`);
      }
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.graphStatus = `Unable to map slides: ${message}`;
      this.output.appendLine(`${deck.path}: ${this.graphStatus}`);
    }
  }

  private async publish(): Promise<void> {
    const selectedDeck = this.decks.find(deck => deck.uri.toString() === this.selectedUri);
    const selectedSlide = this.sourceGraph?.slides.find(slide => slide.id === this.selectedSlideId);
    await this.view?.webview.postMessage({
      type: 'state',
      decks: this.decks.map(({ id, title, path, theme }) => ({ id, title, path, theme })),
      selectedId: selectedDeck?.id,
      workspaceTrusted: vscode.workspace.isTrusted,
      previewState: this.previewState,
      previewMessage: this.previewMessage,
      previewUrl: this.previewUri?.toString(),
      renderedMappingAvailable: this.sourceGraph?.renderedMappingAvailable ?? false,
      selectedSlideId: this.selectedSlideId,
      canEditSelectedSlide: Boolean(selectedDeck && selectedSlide && this.isLocalDeckSlide(selectedDeck, selectedSlide)),
      canRemoveImportReference: Boolean(selectedDeck && selectedSlide && this.isDeckImportReference(selectedDeck, selectedSlide)),
      canDuplicateImportReference: Boolean(selectedDeck && selectedSlide && this.isDeckImportReference(selectedDeck, selectedSlide)),
      thumbnailUiGeneration: this.thumbnailUiGeneration,
      thumbnailState: this.thumbnailState,
      thumbnailMessage: this.thumbnailMessage,
      thumbnails: this.sourceGraph?.renderedMappingAvailable ? Array.from(
        { length: this.sourceGraph?.slides.length ?? 0 },
        (_, index) => {
          const path = this.thumbnails.get(index + 1);
          return path && this.view
            ? this.view.webview.asWebviewUri(vscode.Uri.file(path)).toString()
            : undefined;
        },
      ) : [],
      slides: this.sourceGraph?.slides.map(slide => ({
        id: slide.id,
        title: slide.title,
        deckIndex: slide.deckIndex,
        sourceIndex: slide.sourceIndex,
        sourcePath: slide.sourcePath,
        line: slide.line,
        imported: slide.imported,
        importChain: slide.importChain,
        importReferencePath: slide.importReferencePath,
        importReferenceIndex: slide.importReferenceIndex,
        importReferenceTitle: slide.importReferenceTitle,
        importReferenceLine: slide.importReferenceLine,
        usageCount: slide.usageCount,
        canNavigate: slide.canNavigate,
        canReorder: Boolean(selectedDeck && this.getDeckBlockIndex(selectedDeck, slide) !== undefined),
        readOnlyReason: slide.readOnlyReason,
      })) ?? [],
      graphStatus: this.graphStatus,
      sourceDiagnostics: this.sourceGraph?.diagnostics ?? [],
      issues: this.issues,
    });
  }

  private html(webview: vscode.Webview, previewUri?: vscode.Uri): string {
    const nonce = randomBytes(24).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.css'));
    const previewOrigin = previewUri
      ? `${previewUri.scheme}://${previewUri.authority}`
      : '';
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'strict-dynamic'; img-src ${webview.cspSource}; frame-src ${previewOrigin || "'none'"};">
<link rel="stylesheet" href="${style}">
<title>Slidev Studio</title>
</head><body>
<main>
<header class="deck-header">
  <div class="deck-switcher"><label for="decks" class="sr-only">Presentation</label>
  <select id="decks" aria-describedby="status"></select>
  <details id="detail" class="action-disclosure deck-disclosure" hidden>
    <summary aria-label="Presentation details" title="Presentation details"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary>
    <div class="disclosure-content"><h1 id="title"></h1><p id="path" class="path secondary"></p><p id="theme" class="secondary"></p>
    <button id="open" class="secondary-button" type="button">Open deck source</button>
    <button id="refresh" class="secondary-button" type="button">Refresh presentations</button></div>
  </details>
  </div>
  <div id="status" class="secondary sr-only" role="status">Discovering presentations...</div>
  <div id="preview-controls" class="command-bar">
    <button id="start-preview" type="button">Start preview</button>
    <button id="stop-preview" class="secondary-button" type="button" hidden>Stop preview</button>
    <button id="present" class="quiet" type="button">Present</button>
    <button id="export" class="icon-button quiet" type="button" aria-label="Export presentation" title="Export presentation"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/></svg></button>
  </div>
</header>
<section id="preview-section" aria-labelledby="preview-heading">
  <div class="section-heading preview-heading"><h2 id="preview-heading">Preview</h2><div class="inline-controls"><span id="preview-indicator" class="state-label">Stopped</span>
    <button id="toggle-preview" class="icon-button quiet" type="button" aria-label="Collapse preview" aria-expanded="true" aria-controls="preview-stage" title="Collapse preview"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg></button></div></div>
  <div id="preview-stage">
    <div id="preview-empty" class="empty-preview"><svg class="stage-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="8" width="36" height="26" rx="2"/><path d="M16 42h16M24 34v8m-5-26 12 6-12 6z"/></svg><p id="preview-empty-message">Start preview to render this presentation.</p></div>
    <iframe id="preview-frame" title="Rendered Slidev preview" sandbox="allow-scripts allow-same-origin allow-forms" hidden></iframe>
  </div>
  <p id="preview-status" class="secondary" role="status"></p>
</section>
<section id="slides-section" aria-labelledby="slides-heading">
  <div class="section-heading"><h2 id="slides-heading"><span id="slides-heading-label">Slides</span> <span id="slide-count" class="secondary"></span></h2><div class="inline-controls">
    <button id="show-selected" class="icon-button quiet" type="button" aria-label="Reveal selected slide" title="Reveal selected slide"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4m0 10v4M3 12h4m10 0h4"/><circle cx="12" cy="12" r="6"/></svg></button>
    <button id="toggle-view" class="icon-button quiet" type="button" aria-label="Use outline view" aria-pressed="false" title="Use outline view"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/></svg></button>
  </div></div>
  <div class="slide-search"><label for="slide-search" class="sr-only">Find a slide by title, source path, or number</label><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg>
    <input id="slide-search" type="search" placeholder="Find a slide…" autocomplete="off" aria-controls="slides" aria-describedby="filter-status">
    <button id="clear-search" class="icon-button quiet" type="button" aria-label="Clear slide search" title="Clear slide search" hidden><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
  </div>
  <p id="filter-status" class="secondary" role="status"></p>
  <p id="graph-status" class="secondary" role="status"></p>
  <p id="slides-empty" class="empty-state" hidden>No slides to display.</p>
  <div id="slides-viewport" tabindex="-1">
    <ol id="slides" class="slide-list" aria-label="Presentation slides" aria-describedby="slide-reorder-help"></ol>
  </div>
  <p id="thumbnail-status" class="secondary" role="status"></p>
</section>
<section id="selection-section" aria-labelledby="selection-heading" hidden>
  <h2 id="selection-heading" class="sr-only">Selected slide</h2>
  <div class="selection-caption"><p id="selection-title"></p><span id="selection-kind" class="state-label"></span></div>
  <div id="slide-actions" class="toolbar" role="group" aria-label="Selected slide actions">
    <button id="open-slide-source" class="quiet" type="button"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-2-14-4 16"/></svg>Source</button>
    <button id="edit-notes" class="quiet" type="button"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5zM9 8h6m-6 4h6m-6 4h4"/></svg>Notes</button>
    <button id="add-slide" class="icon-button quiet" type="button" aria-label="Add slide after selected" title="Add slide after selected"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
    <details id="more-slide-actions" class="action-disclosure">
      <summary>More</summary>
      <div class="disclosure-content">
        <p id="selection-source" class="secondary path"></p><p id="selection-provenance" class="secondary path" hidden></p><p id="selection-hint" class="secondary"></p>
        <div class="action-grid">
        <button id="set-layout" class="secondary-button" type="button">Change layout…</button>
        <button id="insert-asset" class="secondary-button" type="button">Insert image…</button>
        <button id="move-slide-up" class="secondary-button" type="button">Move up</button>
        <button id="move-slide-down" class="secondary-button" type="button">Move down</button>
        <button id="duplicate-slide" class="secondary-button" type="button">Duplicate slide</button>
        <button id="duplicate-import" class="secondary-button" type="button" hidden>Duplicate imported group…</button>
        <button id="delete-slide" class="secondary-button destructive" type="button">Delete slide…</button>
        <button id="remove-import" class="secondary-button destructive" type="button" hidden>Remove imported group…</button>
        </div>
      </div>
    </details>
  </div>
</section>
<details id="slide-help" class="help-disclosure"><summary>Keyboard &amp; editing help</summary><p id="slide-reorder-help">Select a slide to preview it when rendered mapping is available. In source-outline mode, selection and edits refer to original Markdown; whole-deck preview is independent. Use arrow keys to navigate and Enter to select. Double-click or use Source to edit Markdown. Drag to reorder, or use Move up / Move down in More. Alt+Up / Alt+Down also reorder. The cover stays fixed; imported slides move as a group. Clear search before reordering.</p></details>
<details id="source-diagnostics-section" class="diagnostics" hidden>
  <summary id="source-diagnostics-heading">Source mapping warnings</summary>
  <ul id="source-diagnostics"></ul>
</details>
<details id="issues-section" class="diagnostics" hidden><summary>Discovery errors</summary><ul id="issues"></ul></details>
</main>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Slidev Studio');
  const preview = new SlidevPreviewSession(message => output.appendLine(message));
  const sidebar = new DeckSidebar(context, output, preview);
  context.subscriptions.push(
    output,
    sidebar,
    vscode.window.registerWebviewViewProvider('slidevStudio.decks', sidebar),
    vscode.commands.registerCommand('slidevStudio.refresh', () => sidebar.run(() => sidebar.refresh())),
    vscode.commands.registerCommand('slidevStudio.selectDeck', () => sidebar.run(() => sidebar.selectDeck())),
    vscode.commands.registerCommand('slidevStudio.openSource', () => sidebar.run(() => sidebar.openSource())),
    vscode.commands.registerCommand('slidevStudio.insertAsset', () => sidebar.run(() => sidebar.insertAsset())),
    vscode.commands.registerCommand('slidevStudio.setLayout', () => sidebar.run(() => sidebar.setLayout())),
    vscode.commands.registerCommand('slidevStudio.startPreview', () => sidebar.run(() => sidebar.startPreview())),
    vscode.commands.registerCommand('slidevStudio.stopPreview', () => sidebar.run(() => sidebar.stopPreview())),
    vscode.commands.registerCommand('slidevStudio.present', () => sidebar.run(() => sidebar.present())),
    vscode.commands.registerCommand('slidevStudio.export', () => sidebar.run(() => sidebar.exportDeck())),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void sidebar.run(() => sidebar.onWorkspaceTrustChanged())),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void sidebar.run(() => sidebar.refresh())),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('slidevStudio')) {
        void sidebar.run(() => sidebar.refresh());
      }
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      void sidebar.run(() => sidebar.onWorkspaceFilesChanged(document.languageId === 'markdown'));
    }),
    vscode.workspace.onDidCreateFiles(() => void sidebar.run(() => sidebar.onWorkspaceFilesChanged(true))),
    vscode.workspace.onDidDeleteFiles(() => void sidebar.run(() => sidebar.onWorkspaceFilesChanged(true))),
    vscode.workspace.onDidRenameFiles(() => void sidebar.run(() => sidebar.onWorkspaceFilesChanged(true))),
  );
  await sidebar.run(() => sidebar.refresh());
}
