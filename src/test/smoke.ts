import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('slidevStudio.refresh');
  await vscode.commands.executeCommand('slidevStudio.decks.focus');
  await vscode.commands.executeCommand('slidevStudio.openSource');
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, 'Opening source should create an active editor.');
  const filename = editor.document.uri.path.split('/').pop();
  assert.ok(filename === 'slides.md' || filename === 'slides_workshop.md');
  assert.match(editor.document.getText(), /title: (Studio sample|Workshop)/);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('slidevStudio.selectDeck'));
  assert.ok(commands.includes('slidevStudio.present'));
  assert.ok(commands.includes('slidevStudio.export'));
  assert.ok(commands.includes('slidevStudio.insertAsset'));
  assert.ok(commands.includes('slidevStudio.setLayout'));
  if (process.env.SLIDEV_STUDIO_SMOKE_RESULT) {
    writeFileSync(process.env.SLIDEV_STUDIO_SMOKE_RESULT, 'passed\n', 'utf8');
  }
  console.log('Slidev Studio Extension Host smoke test passed.');
}
