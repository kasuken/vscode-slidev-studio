import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  duplicateImportedSlideReference,
  duplicateLocalSlide,
} from '../slideEdits';

async function applyAndUndo(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
  label: string,
  transform: (text: string) => Promise<string>,
): Promise<void> {
  const savedText = document.getText();
  assert.equal(document.isDirty, false, `${label}: fixture must start clean`);
  const savedDiskText = Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8');
  assert.equal(savedDiskText, savedText, `${label}: fixture buffer must match disk before editing`);

  const marker = `\n<!-- unsaved host-test ${label} -->\n`;
  assert.equal(
    await editor.edit(edit => edit.insert(document.positionAt(document.getText().length), marker)),
    true,
    `${label}: should create unsaved changes`,
  );
  const dirtyBaseline = document.getText();
  assert.equal(document.isDirty, true, `${label}: document should be dirty before the operation`);
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8'),
    savedDiskText,
    `${label}: unsaved baseline must not change the file on disk`,
  );

  const expectedVersion = document.version;
  const updatedText = await transform(dirtyBaseline);
  assert.notEqual(updatedText, dirtyBaseline, `${label}: operation should change the document`);
  assert.equal(document.version, expectedVersion, `${label}: document version should remain current`);
  assert.equal(document.getText(), dirtyBaseline, `${label}: operation preparation must not alter the buffer`);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(new vscode.Position(0, 0), document.positionAt(dirtyBaseline.length)),
    updatedText,
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true, `${label}: host should apply the WorkspaceEdit`);
  assert.equal(document.getText(), updatedText, `${label}: WorkspaceEdit should update the dirty buffer`);
  assert.equal(document.isDirty, true, `${label}: WorkspaceEdit should leave the document dirty`);
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8'),
    savedDiskText,
    `${label}: WorkspaceEdit must not save the document`,
  );

  await vscode.commands.executeCommand('undo');
  assert.equal(document.getText(), dirtyBaseline, `${label}: one undo should restore the unsaved baseline`);
  assert.equal(document.isDirty, true, `${label}: one undo should preserve the earlier unsaved changes`);
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8'),
    savedDiskText,
    `${label}: undo must leave the saved file unchanged`,
  );

  await vscode.commands.executeCommand('undo');
  assert.equal(document.getText(), savedText, `${label}: cleanup undo should restore the saved contents`);
  assert.equal(document.isDirty, false, `${label}: cleanup should leave the document clean`);
  console.log(`PASS Extension Host: ${label} WorkspaceEdit is undone in one step on a dirty document`);
}

export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'Extension Host should open the extension workspace.');
  const fixture = vscode.Uri.joinPath(workspaceFolder.uri, 'test-fixtures', 'slides.md');
  const document = await vscode.workspace.openTextDocument(fixture);
  const editor = await vscode.window.showTextDocument(document);

  await applyAndUndo(document, editor, 'local slide duplication', async text => {
    const updated = (await duplicateLocalSlide(text, 3)).text;
    assert.equal((updated.match(/^# Local slide$/gm) ?? []).length, 2);
    return updated;
  });
  await applyAndUndo(document, editor, 'imported reference duplication', async text => {
    const updated = (await duplicateImportedSlideReference(text, 2)).text;
    assert.equal((updated.match(/^src: \.\/shared\/intro\.md$/gm) ?? []).length, 2);
    return updated;
  });
}
