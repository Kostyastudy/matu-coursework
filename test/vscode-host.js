const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { MatuClient } = require('../src/client');
const { SubmissionManager } = require('../src/submission');
const { FileStore } = require('../src/files');
const f = require('./fixtures');

async function run() {
  const extension = vscode.extensions.getExtension('matu-local.matu-coursework');
  assert.ok(extension, 'extension installed in development host');
  const { app } = await extension.activate();
  await app.sessionPromise;
  assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('matu.submit'));
  const shortcut = extension.packageJSON.contributes.keybindings.find(binding => binding.command === 'matu.submit');
  assert.equal(shortcut.key, 'ctrl+alt+enter');
  assert.match(shortcut.when, /matu.associated/);
  let uploads = 0;
  let payload = '';
  let records = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const response = body => { res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' }); res.end(body); };
    if (url.pathname === '/aptat/user/login.action') return response(f.login);
    if (url.pathname === '/aptat/user/dologin.action') { req.resume(); return response('<title>mannager</title>'); }
    if (url.pathname === '/aptat/course/liststudentclass') return response(f.courses);
    if (url.pathname === '/aptat/task/liststudenttaskgroup') return response(f.groups);
    if (url.pathname === '/aptat/task/listTaskGroup_Task') return response(f.tasks);
    if (url.pathname === '/aptat/task/taskdetail') return response(f.detail);
    if (url.pathname === '/aptat/assignment/upload') return response(f.upload);
    if (url.pathname === '/aptat/assignment/listttudenttaskgrouptaskassignmentforstudent') return response(f.history(records));
    if (url.pathname === '/aptat/assignment/scoredetail') return response(f.score);
    if (url.pathname === '/aptat/assignment/upload_assignment_by_single_file') {
      uploads++;
      req.on('data', chunk => { payload += chunk.toString(); });
      req.on('end', () => {
        records = [{ id: String(100 + uploads), status: 'score', score: 80 }, ...records];
        response(f.history(records));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await fs.mkdtemp(path.join(extension.extensionPath, '.local', 'host-homework-'));
  try {
    app.account = 'host-test-student';
    app.client = new MatuClient(`http://127.0.0.1:${server.address().port}/aptat/`);
    await app.client.login(app.account, 'test-only-password');
    app.cache = {};
    app.files = new FileStore(root, app.account);
    await app.files.load();
    app.manager = new SubmissionManager(app.client, {
      maxWait: 100,
      update: (task, state) => app.onSubmissionUpdate(task, state)
    });
    await app.context.secrets.store('matu.host-test', 'test-only-password');
    assert.equal(await app.context.secrets.get('matu.host-test'), 'test-only-password');
    await app.context.secrets.delete('matu.host-test');
    const courseNodes = await app.tree.getChildren();
    assert.equal(courseNodes[0].data.classId, '632');
    const groupNodes = await app.tree.getChildren(courseNodes[0]);
    const taskNodes = await app.tree.getChildren(groupNodes[0]);
    assert.equal(taskNodes[0].data.groupTaskId, '45151');
    await vscode.commands.executeCommand('matu.openTask', taskNodes[0].data);
    assert.ok(app.panel, 'webview opened');
    assert.equal(app.panel.viewColumn, vscode.ViewColumn.Two);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'source editor remains focused');
    assert.equal(editor.viewColumn, vscode.ViewColumn.One);
    assert.equal(path.basename(editor.document.uri.fsPath), 'swap.cpp');
    assert.equal(editor.document.getText(), '');
    assert.match(app.panel.webview.html, /实现swap方法/);
    assert.match(app.panel.webview.html, /Content-Security-Policy/);
    const sourcePath = editor.document.uri.fsPath;
    await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'void swap(int* a, int n) { (void)a; (void)n; }\n'));
    await vscode.commands.executeCommand('matu.submit');
    assert.equal(uploads, 1);
    assert.match(payload, /name="taskGroupTask.id"\r\n\r\n45151/);
    assert.equal(editor.document.isDirty, false);
    assert.match(app.panel.webview.html, /80 分/);
    assert.match(app.panel.webview.html, /扣分:20/);
    await assert.rejects(app.submit({ ...f.task, groupId: '9999', groupTaskId: '99999' }), { code: 'ASSOCIATION' });
    assert.equal(uploads, 1, 'wrong problem does not upload');
    const second = app.submit();
    await assert.rejects(app.submit(), { code: 'BUSY' });
    await second;
    assert.equal(uploads, 2, 'duplicate command emits only one more upload');
    await vscode.commands.executeCommand('matu.openTask', f.task);
    assert.equal(vscode.window.activeTextEditor.document.getText(), await fs.readFile(sourcePath, 'utf8'));
    const freshNodes = await app.tree.getChildren(groupNodes[0]);
    assert.match(app.tree.getTreeItem(freshNodes[0]).description, /80 分/);
    const report = {
      passed: true, extensionActive: extension.isActive,
      verified: ['commands', 'shortcut context', 'SecretStorage', 'course tree', 'blank file',
        'two columns', 'Chinese statement', 'save before upload', 'mock multipart upload',
        'score detail', 'no overwrite', 'sidebar status', 'wrong problem blocked', 'duplicate command blocked'],
      realWebsiteUploads: 0
    };
    await fs.writeFile(path.join(extension.extensionPath, '.local', 'vscode-host-report.json'), JSON.stringify(report, null, 2));
    console.log('VS Code extension host checks passed:', report.verified.length);
  } finally {
    app.manager?.dispose();
    app.client?.dispose();
    app.panel?.dispose();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}

module.exports = { run };
