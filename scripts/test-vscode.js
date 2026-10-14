const fs = require('node:fs/promises');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const executable = process.env.MATU_VSCODE_EXE;
  await fs.mkdir(path.join(root, '.local'), { recursive: true });
  await runTests({
    ...(executable ? { vscodeExecutablePath: executable } : {
      version: '1.141.0',
      cachePath: path.join(root, '.local', 'vscode-test')
    }),
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', 'vscode-host.js'),
    launchArgs: [
      '--user-data-dir', path.join(root, '.test-profile'),
      '--extensions-dir', path.join(root, '.test-extensions'),
      '--skip-welcome', '--skip-release-notes', '--disable-updates',
      '--disable-workspace-trust', '--disable-extensions'
    ]
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
