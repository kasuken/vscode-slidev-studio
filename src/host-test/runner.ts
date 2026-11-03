import { resolve, join } from 'node:path';
import { runTests } from '@vscode/test-electron';

const extensionDevelopmentPath = resolve(__dirname, '../..');

void runTests({
  version: '1.104.0',
  cachePath: join(extensionDevelopmentPath, '.vscode-test'),
  extensionDevelopmentPath,
  extensionTestsPath: resolve(__dirname, 'suite.js'),
  launchArgs: [extensionDevelopmentPath, '--disable-extensions'],
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
