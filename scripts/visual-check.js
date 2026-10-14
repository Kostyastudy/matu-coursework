const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { render } = require('../src/webview');
const { parseTaskDetail } = require('../src/parser');
const f = require('../test/fixtures');

async function main() {
  const playwright = require(process.env.MATU_PLAYWRIGHT || 'playwright');
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, '.local', 'visual');
  await fs.mkdir(output, { recursive: true });
  const theme = `
  :root {
    --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#cccccc;
    --vscode-descriptionForeground:#989898; --vscode-icon-foreground:#cccccc;
    --vscode-panel-border:#3a3a3a; --vscode-focusBorder:#0078d4;
    --vscode-list-inactiveSelectionBackground:#37373d; --vscode-toolbar-hoverBackground:#333333;
    --vscode-font-family:"Segoe UI",sans-serif; --vscode-editor-font-family:Consolas,monospace;
  }`;
  let commands = [];
  let origin;
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (pathname === '/theme.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(theme); return; }
    if (/^\/(?:panel\.css|codicon\.css|codicon\.ttf)$/.test(pathname)) {
      res.writeHead(200, { 'Content-Type': pathname.endsWith('.ttf') ? 'font/ttf' : 'text/css' });
      res.end(await fs.readFile(path.join(root, 'media', path.basename(pathname))));
      return;
    }
    let html = render({ cspSource: origin, asWebviewUri: value => value }, file => `${origin}/${file}`, {
      ...parseTaskDetail(f.detail, f.task), title: '2_实现指定函数swap_中文题目显示检查'
    }, {
      kind: 'complete', record: { id: '101', status: 'score', score: 80 },
      details: '扣分:20\nWhen test group(1) step(1), the input is (2), the real output is not right.',
      history: [{ id: '101', status: 'score', score: 80, time: '2026-10-14 11:00:00.0' }]
    });
    html = html.replace('</head>', `<link rel="stylesheet" href="${origin}/theme.css"></head>`);
    res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch({
    executablePath: process.env.MATU_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.exposeFunction('captureCommand', message => { commands.push(message); });
    await page.addInitScript(() => {
      let state;
      window.acquireVsCodeApi = () => ({
        postMessage: message => window.captureCommand(message),
        getState: () => state, setState: value => { state = value; }
      });
    });
    for (const width of [760, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(origin);
      await page.locator('.statement').waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await page.evaluate(() => document.fonts.check('16px codicon')), 'icon font loaded');
      await page.screenshot({ path: path.join(output, `statement-${width}.png`), fullPage: true });
      assert.match(await page.locator('.statement').innerText(), /实现swap方法/);
      const fit = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      assert.ok(fit, `statement fits viewport ${width}`);
      await page.getByRole('button', { name: '评测与记录 (1)' }).click();
      await page.screenshot({ path: path.join(output, `results-${width}.png`), fullPage: true });
      assert.match(await page.locator('#results').innerText(), /80 分/);
      await page.getByRole('button', { name: '查看评测详情' }).click();
    }
    assert.equal(commands.filter(command => command.command === 'detail').length, 2);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({
      passed: true, widths: [760, 360], checks: ['Chinese text', 'no page overflow', 'tab switching', 'detail button', 'no browser errors']
    }, null, 2));
    console.log('Webview visual checks passed: 760px and 360px');
  } finally {
    await browser.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
