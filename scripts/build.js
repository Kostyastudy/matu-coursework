const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');

async function build() {
  await esbuild.build({
    entryPoints: ['src/extension.js'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    outfile: 'dist/extension.js',
    sourcemap: false,
    minify: false,
    legalComments: 'eof'
  });
  const assets = path.dirname(require.resolve('@vscode/codicons/package.json'));
  for (const name of ['codicon.css', 'codicon.ttf']) {
    await fs.copyFile(path.join(assets, 'dist', name), path.join('media', name));
  }
  await fs.copyFile(path.join(assets, 'LICENSE'), path.join('media', 'codicons-LICENSE.txt'));
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
