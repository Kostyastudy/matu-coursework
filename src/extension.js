const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MatuClient } = require('./client');
const { FileStore, accountKey } = require('./files');
const { SubmissionManager, taskKey } = require('./submission');
const { recordLabel, isTerminal } = require('./parser');
const { render } = require('./webview');
const { MatuError } = require('./errors');

const SECRET = 'matu.credentials.v1';

class CourseworkTree {
  constructor(app) {
    this.app = app;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  dispose() { this.emitter.dispose(); }
  async getChildren(node) {
    try {
      if (!await this.app.session(false)) return [];
      const app = this.app;
      if (!node) return (await app.cached('courses', () => app.client.courses())).map(data => ({ kind: 'course', data }));
      if (node.kind === 'course') {
        return (await app.cached(`groups:${node.data.classId}`, () => app.client.groups(node.data))).map(data => ({ kind: 'group', data }));
      }
      if (node.kind === 'group') {
        const tasks = await app.cached(`tasks:${node.data.classId}:${node.data.groupId}`, () => app.client.tasks(node.data));
        const statuses = await app.cached(`statuses:${node.data.classId}:${node.data.groupId}`, async () => {
          const result = {};
          for (const task of tasks) {
            const history = await app.client.history(task);
            result[taskKey(task)] = history[0] || null;
          }
          return result;
        });
        return tasks.map(data => ({ kind: 'task', data, record: statuses[taskKey(data)] }));
      }
      return [];
    } catch (error) {
      this.app.showError(error);
      return this.app.fallbackNodes(node);
    }
  }
  getTreeItem(node) {
    const data = node.data;
    if (node.kind === 'course') {
      const item = new vscode.TreeItem(data.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `course-${data.classId}`;
      item.description = data.className;
      item.iconPath = new vscode.ThemeIcon('mortar-board');
      return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(data.groupName, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group-${data.classId}-${data.groupId}`;
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    const item = new vscode.TreeItem(data.title, vscode.TreeItemCollapsibleState.None);
    item.id = `task-${taskKey(data)}`;
    item.description = recordLabel(node.record);
    item.tooltip = `题号 ${data.taskId} · ${data.language}\n${recordLabel(node.record)}`;
    item.iconPath = new vscode.ThemeIcon(node.record?.score === 100 && isTerminal(node.record) ? 'pass' : node.record ? 'circle-filled' : 'circle-outline');
    item.contextValue = 'matuTask';
    item.command = { command: 'matu.openTask', title: '打开题目', arguments: [data] };
    return item;
  }
}

class App {
  constructor(context) {
    this.context = context;
    this.client = null;
    this.files = null;
    this.manager = null;
    this.account = null;
    this.cache = {};
    this.cachePromises = new Map();
    this.sessionPromise = null;
    this.panel = null;
    this.panelTask = null;
    this.panelState = {};
    this.submitting = false;
    this.openSequence = 0;
    this.disposed = false;
    this.lastError = '';
    this.tree = new CourseworkTree(this);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
    this.status.command = 'matu.submit';
    this.status.tooltip = '提交当前码图题目';
  }

  async session(prompt = true) {
    if (this.disposed) throw new MatuError('扩展已关闭。', 'DISPOSED');
    if (this.client) return true;
    if (!this.sessionPromise) this.sessionPromise = this.createSession(prompt).finally(() => { this.sessionPromise = null; });
    return this.sessionPromise;
  }

  async createSession(prompt) {
    const stored = await this.context.secrets.get(SECRET);
    let credentials;
    try { credentials = stored ? JSON.parse(stored) : null; } catch { credentials = null; }
    if (!credentials && !prompt) return false;
    if (!credentials) {
      const account = await vscode.window.showInputBox({
        title: '登录码图', prompt: '账号 · 当前网站使用 HTTP，登录信息在传输中不加密。',
        ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : '请输入账号。'
      });
      if (account === undefined) return false;
      const password = await vscode.window.showInputBox({
        title: '登录码图', prompt: '密码仅通过 VS Code 安全存储保存在本机。',
        password: true, ignoreFocusOut: true, validateInput: value => value ? undefined : '请输入密码。'
      });
      if (password === undefined) return false;
      credentials = { account: account.trim(), password };
    }
    const client = new MatuClient();
    try {
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '正在登录码图' }, () => client.login(credentials.account, credentials.password));
      } catch (error) {
        if (error.code !== 'NETWORK' || !stored) throw error;
        client.credentials = credentials;
        this.showError(new MatuError(`${error.message} 已保留本地题面与源码，可稍后刷新。`, 'NETWORK'));
      }
      if (this.disposed) { client.dispose(); return false; }
      const root = vscode.workspace.getConfiguration('matu').get('homeworkDirectory', 'C:\\Study\\matu-homework');
      const files = new FileStore(root, credentials.account);
      await files.load();
      const key = accountKey(credentials.account);
      this.cache = this.context.globalState.get(`cache:${key}`, {});
      const manager = new SubmissionManager(client, {
        pending: this.context.globalState.get(`pending:${key}`, {}),
        persist: pending => this.context.globalState.update(`pending:${key}`, pending),
        update: (task, state) => this.onSubmissionUpdate(task, state)
      });
      await this.context.secrets.store(SECRET, JSON.stringify(credentials));
      this.account = credentials.account;
      this.files = files;
      this.client = client;
      this.manager = manager;
      this.updateEditor();
      return true;
    } catch (error) {
      client.dispose();
      if (error.code === 'LOGIN') await this.context.secrets.delete(SECRET);
      throw error;
    }
  }

  async login() {
    if (await this.session()) {
      this.tree.refresh();
      vscode.window.showInformationMessage('码图已登录。');
    }
  }

  async logout() {
    if (this.submitting || this.sessionPromise || this.manager?.locks.size) {
      throw new MatuError('登录或评测查询正在进行，请结束后再退出。', 'BUSY');
    }
    this.manager?.dispose();
    this.client?.dispose();
    this.manager = this.client = this.files = null;
    this.account = null;
    this.cache = {};
    this.cachePromises.clear();
    this.panel?.dispose();
    await this.context.secrets.delete(SECRET);
    this.updateEditor();
    this.tree.refresh();
    vscode.window.showInformationMessage('已退出码图并清除本机登录信息。');
  }

  async cached(key, fetch, force = false) {
    const old = this.cache[key];
    if (!force && old && Date.now() - old.updated < 5 * 60 * 1000) return old.value;
    if (this.cachePromises.has(key)) return this.cachePromises.get(key);
    const cache = this.cache;
    const account = this.account;
    const promise = (async () => {
      try {
        const value = await fetch();
        if (this.account === account && this.cache === cache) {
          cache[key] = { value, updated: Date.now() };
          await this.context.globalState.update(`cache:${accountKey(account)}`, cache);
        }
        return value;
      } catch (error) {
        if (old && ['NETWORK', 'AUTH', 'LOGIN'].includes(error.code)) {
          this.showError(new MatuError(`${error.message} 当前显示本地缓存。`, error.code));
          return old.value;
        }
        throw error;
      } finally { this.cachePromises.delete(key); }
    })();
    this.cachePromises.set(key, promise);
    return promise;
  }

  fallbackNodes(node) {
    if (!this.account) return [];
    if (!node) return (this.cache.courses?.value || []).map(data => ({ kind: 'course', data }));
    if (node.kind === 'course') return (this.cache[`groups:${node.data.classId}`]?.value || []).map(data => ({ kind: 'group', data }));
    if (node.kind === 'group') {
      const statuses = this.cache[`statuses:${node.data.classId}:${node.data.groupId}`]?.value || {};
      return (this.cache[`tasks:${node.data.classId}:${node.data.groupId}`]?.value || []).map(data => ({ kind: 'task', data, record: statuses[taskKey(data)] }));
    }
    return [];
  }

  async refresh() {
    if (!await this.session()) return;
    for (const entry of Object.values(this.cache)) entry.updated = 0;
    await this.cached('courses', () => this.client.courses(), true);
    this.tree.refresh();
  }

  resolveTask(argument) {
    if (argument?.kind === 'task') return argument.data;
    if (argument?.groupTaskId) return argument;
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === 'file') {
      const task = this.files?.lookup(editor.document.uri.fsPath);
      if (task) return task;
    }
    return this.panelTask;
  }

  async openTask(argument) {
    if (!await this.session()) return;
    const sequence = ++this.openSequence;
    const task = this.resolveTask(argument);
    if (!task) throw new MatuError('请先在码图侧栏选择一道题。', 'ASSOCIATION');
    const detailed = await this.cached(`detail:${taskKey(task)}`, () => this.client.detail(task));
    if (sequence !== this.openSequence) return;
    let filename;
    if (detailed.filenames.length > 1 && !Object.values(this.files.associations).some(value => taskKey(value.task) === taskKey(task))) {
      filename = await vscode.window.showQuickPick(detailed.filenames, { title: '选择这道题提交的源文件名' });
      if (!filename) return;
    }
    const filePath = await this.files.ensure(detailed, filename);
    if (sequence !== this.openSequence) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    if (sequence !== this.openSequence) return;
    this.panelTask = detailed;
    const history = this.cache[`history:${taskKey(task)}`]?.value || [];
    const pending = this.manager.waiting(task);
    this.panelState = { history, pending, kind: pending ? 'unknown' : 'history' };
    this.showPanel();
    try { await this.manager.refresh(task); } catch (error) { this.showError(error); }
    this.updateEditor();
  }

  showPanel() {
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('matu.task', '码图题目', { viewColumn: vscode.ViewColumn.Two, preserveFocus: true }, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        retainContextWhenHidden: true
      });
      this.panel = panel;
      panel.onDidDispose(() => { if (this.panel === panel) { this.panel = null; this.panelTask = null; } }, null, this.context.subscriptions);
      panel.webview.onDidReceiveMessage(message => {
        if (!message || typeof message.command !== 'string') return;
        this.run(async () => {
          const task = this.panelTask;
          if (!task) return;
          if (message.command === 'open') await this.openTask(task);
          if (message.command === 'refresh') await this.refreshCurrent(task);
          if (message.command === 'submit') await this.submit(task);
          if (message.command === 'discard') await this.discardPending(task);
          if (message.command === 'detail' && /^\d+$/.test(String(message.id)) &&
              this.panelState.history?.some(row => row.id === message.id)) {
            const details = await this.client.scoreDetail(message.id);
            if (this.panelTask && taskKey(task) === taskKey(this.panelTask)) {
              this.panelState = { ...this.panelState, record: this.panelState.history.find(row => row.id === message.id), details, showResults: true };
              this.showPanel();
            }
          }
        });
      }, null, this.context.subscriptions);
    }
    this.panel.title = `码图 · ${this.panelTask.title}`;
    this.panel.webview.html = render(this.panel.webview, name => vscode.Uri.joinPath(this.context.extensionUri, 'media', name), this.panelTask, this.panelState);
    this.panel.reveal(vscode.ViewColumn.Two, true);
  }

  async submit(expectedTask) {
    if (this.submitting) throw new MatuError('正在提交或查询评测，请稍候。', 'BUSY');
    this.submitting = true;
    this.updateEditor();
    try {
      if (!await this.session()) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') throw new MatuError('请打开并选中要提交的源码文件。', 'ASSOCIATION');
      const document = editor.document;
      const task = await this.files.validate(document.uri.fsPath);
      if (expectedTask?.groupTaskId && taskKey(task) !== taskKey(expectedTask)) {
        throw new MatuError('当前源码与题面不是同一道题，请先打开这道题的源码。', 'ASSOCIATION');
      }
      if (!await document.save()) throw new MatuError('源码保存未成功，已停止提交。', 'SAVE');
      if (document.isDirty) throw new MatuError('保存期间源码再次变化，请保存后重新提交。', 'SAVE');
      await this.files.validate(document.uri.fsPath);
      const source = await fs.readFile(document.uri.fsPath);
      if (!source.toString('utf8').trim()) throw new MatuError('源码文件为空，请完成代码后再提交。', 'EMPTY');
      if (source.length > 2 * 1024 * 1024) throw new MatuError('源文件超过 2 MB，已停止提交。', 'SIZE');
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `码图 · ${task.title}`, cancellable: false
      }, async progress => {
        progress.report({ message: '上传源码并查询评测' });
        return this.manager.submit(task, path.basename(document.uri.fsPath), source);
      });
      if (result.kind === 'complete') vscode.window.showInformationMessage(`码图：${recordLabel(result.record)}`);
      else vscode.window.showWarningMessage('提交结果尚未确认，请刷新当前题目评测；源码不会自动重复上传。');
    } finally {
      this.submitting = false;
      this.updateEditor();
    }
  }

  async refreshCurrent(argument) {
    if (!await this.session()) return;
    const task = this.resolveTask(argument);
    if (!task) throw new MatuError('请先选择一道码图题目。', 'ASSOCIATION');
    const result = await this.manager.refresh(task);
    if (this.panelTask && taskKey(this.panelTask) === taskKey(task)) {
      this.panelState = { ...this.panelState, ...result, showResults: true };
      this.showPanel();
    }
  }

  async history(argument) {
    if (!await this.session()) return;
    const task = this.resolveTask(argument);
    if (!task) throw new MatuError('请先选择一道码图题目。', 'ASSOCIATION');
    if (!this.panelTask || taskKey(task) !== taskKey(this.panelTask)) await this.openTask(task);
    await this.refreshCurrent(task);
  }

  async discardPending(argument) {
    if (!await this.session()) return;
    const task = this.resolveTask(argument);
    if (!task || !this.manager.waiting(task)) return;
    await this.manager.refresh(task);
    if (!this.manager.waiting(task)) return;
    const choice = await vscode.window.showWarningMessage(
      '网站提交仍未确认。结束跟踪不会撤销网站提交；再次上传可能消耗提交次数。请核对网站记录后操作。',
      { modal: true }, '结束跟踪'
    );
    if (choice !== '结束跟踪') return;
    await this.manager.discard(task);
    if (this.panelTask && taskKey(task) === taskKey(this.panelTask)) {
      this.panelState = { history: this.panelState.history || [], kind: 'history', showResults: true };
      this.showPanel();
    }
  }

  onSubmissionUpdate(task, state) {
    if (this.disposed) return;
    if (state.history) {
      this.cache[`history:${taskKey(task)}`] = { value: state.history, updated: Date.now() };
      const statusesKey = `statuses:${task.classId}:${task.groupId}`;
      const entry = this.cache[statusesKey] || { value: {}, updated: 0 };
      entry.value[taskKey(task)] = state.history[0] || null;
      this.cache[statusesKey] = entry;
      this.context.globalState.update(`cache:${accountKey(this.account)}`, this.cache).then(undefined, () => {});
      this.tree.refresh();
    }
    if (this.panelTask && taskKey(task) === taskKey(this.panelTask)) {
      this.panelState = { ...this.panelState, ...state, showResults: state.kind !== 'history' };
      if (!state.pending) delete this.panelState.pending;
      if (!state.error) delete this.panelState.error;
      if (!Object.hasOwn(state, 'details')) delete this.panelState.details;
      if (!Object.hasOwn(state, 'record')) delete this.panelState.record;
      this.showPanel();
    }
  }

  updateEditor() {
    const editor = vscode.window.activeTextEditor;
    const task = editor?.document.uri.scheme === 'file' ? this.files?.lookup(editor.document.uri.fsPath) : null;
    vscode.commands.executeCommand('setContext', 'matu.associated', Boolean(task));
    vscode.commands.executeCommand('setContext', 'matu.busy', this.submitting);
    if (task) {
      this.status.text = this.submitting ? '$(sync~spin) 码图评测中' : `$(cloud-upload) 码图 · ${task.taskId}`;
      this.status.show();
    } else this.status.hide();
  }

  showError(error) {
    const message = error instanceof MatuError ? error.message : '操作未完成，请检查本地目录权限和网站连接后重试。';
    if (message === this.lastError) return;
    this.lastError = message;
    vscode.window.showErrorMessage(message);
    setTimeout(() => { this.lastError = ''; }, 4000).unref();
  }

  async run(action) {
    try { return await action(); } catch (error) { this.showError(error); }
  }

  dispose() {
    this.disposed = true;
    this.manager?.dispose();
    this.client?.dispose();
    this.panel?.dispose();
    this.status.dispose();
    this.tree.dispose();
  }
}

function activate(context) {
  const app = new App(context);
  context.subscriptions.push(app);
  const commands = {
    login: () => app.login(), logout: () => app.logout(), refresh: () => app.refresh(),
    openTask: task => app.openTask(task), submit: () => app.submit(),
    history: task => app.history(task), refreshCurrent: task => app.refreshCurrent(task),
    discardPending: task => app.discardPending(task)
  };
  for (const [name, action] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`matu.${name}`, (...args) => app.run(() => action(...args))));
  }
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('matu.coursework', app.tree),
    vscode.window.onDidChangeActiveTextEditor(() => app.updateEditor()),
    vscode.workspace.onDidRenameFiles(() => app.updateEditor()),
    vscode.workspace.onDidDeleteFiles(() => app.updateEditor()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('matu.homeworkDirectory')) app.run(async () => {
        if (!app.account) return;
        if (app.submitting) {
          vscode.window.showWarningMessage('目录设置将在提交结束并重新登录后生效。');
          return;
        }
        app.files = new FileStore(vscode.workspace.getConfiguration('matu').get('homeworkDirectory'), app.account);
        await app.files.load();
        app.updateEditor();
      });
    })
  );
  app.run(async () => {
    if (await app.session(false)) app.tree.refresh();
  });
  return { app };
}

module.exports = { activate };
