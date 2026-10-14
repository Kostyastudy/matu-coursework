const cheerio = require('cheerio');
const parser = require('./parser');
const { Transport, multipart } = require('./transport');
const { MatuError, AuthenticationError } = require('./errors');

const DEFAULT_URL = 'http://matu.uestc.edu.cn/aptat/';

class MatuClient {
  constructor(baseUrl = DEFAULT_URL, options) {
    this.transport = new Transport(baseUrl, options);
    this.baseUrl = baseUrl;
    this.credentials = null;
    this.loginPromise = null;
    this.disposed = false;
  }

  async login(account, password) {
    if (this.disposed) throw new MatuError('连接已关闭。', 'DISPOSED');
    const entry = await this.transport.request('/aptat/user/login.action');
    const $ = cheerio.load(entry.html);
    const form = $('form').filter((_, el) => $(el).find('input[name="user.Password"]').length > 0).first();
    const action = form.attr('action');
    if (!action) throw new MatuError('无法识别网站登录表单。', 'STRUCTURE');
    const url = new URL(action, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin || !url.pathname.startsWith('/aptat/user/dologin')) {
      throw new MatuError('网站登录地址不正确。', 'ORIGIN');
    }
    const fields = new URLSearchParams();
    form.find('input[type="hidden"][name]').each((_, el) => fields.set($(el).attr('name'), $(el).attr('value') || ''));
    fields.set('user.Login', account);
    fields.set('user.Password', password);
    const response = await this.transport.request(url.href, {
      method: 'POST', body: fields.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (parser.isLogin(response.html)) throw new MatuError('登录失败，请检查账号和密码。', 'LOGIN');
    if (!/mannager|liststudentclass|files\/left\.jsp/i.test(response.html)) {
      throw new MatuError('网站未确认登录成功，请稍后重试。', 'LOGIN');
    }
    this.credentials = { account, password };
  }

  async reconnect() {
    if (!this.credentials) throw new AuthenticationError();
    if (!this.loginPromise) {
      const { account, password } = this.credentials;
      this.loginPromise = this.login(account, password).finally(() => { this.loginPromise = null; });
    }
    return this.loginPromise;
  }

  async read(target, retry = true) {
    const result = await this.transport.request(target);
    if (parser.isLogin(result.html)) {
      if (!retry) throw new AuthenticationError();
      await this.reconnect();
      return this.read(target, false);
    }
    return result;
  }

  async pages(target, parse) {
    const pending = [new URL(target, this.baseUrl).href];
    const visited = new Set();
    const rows = [];
    while (pending.length) {
      const url = pending.shift();
      if (visited.has(url)) continue;
      if (visited.size >= 100) throw new MatuError('网站分页数量异常，已停止读取。', 'STRUCTURE');
      visited.add(url);
      const result = await this.read(url);
      rows.push(...parse(result.html));
      for (const next of parser.pageLinks(result.html, url)) if (!visited.has(next)) pending.push(next);
    }
    return rows;
  }

  async courses() {
    return unique(await this.pages('/aptat/course/liststudentclass', parser.parseCourses), 'classId');
  }

  async groups(course) {
    return unique(await this.pages(`/aptat/task/liststudenttaskgroup?_class.id=${course.classId}`, html => parser.parseGroups(html, course)), 'groupId');
  }

  async tasks(group) {
    return unique(await this.pages(`/aptat/task/listTaskGroup_Task?taskGroup.id=${group.groupId}`, html => parser.parseTasks(html, group)), 'groupTaskId');
  }

  async detail(task) {
    const result = await this.read(`/aptat/task/taskdetail?taskid=${task.taskId}&taskGroupTask.id=${task.groupTaskId}&taskGroup.id=${task.groupId}`);
    const detailed = parser.parseTaskDetail(result.html, task);
    try {
      const form = await this.uploadForm(task);
      if (form.mode === 'cloze') {
        let blank = 0;
        detailed.submissionMode = 'cloze';
        detailed.blankCount = form.blankCount;
        detailed.clozeTemplate = form.template.split('\n').map(line => line.includes(form.marker) ? `/* 填空 ${++blank} */` : line).join('\n');
      }
    } catch (error) {
      if (!['NETWORK', 'UPLOAD_FORM', 'REJECTED'].includes(error.code)) throw error;
      detailed.submissionNotice = error.message;
    }
    return detailed;
  }

  async uploadForm(task) {
    const result = await this.read(`/aptat/assignment/upload?task.id=${task.taskId}&uploadMethod=upload_single_file&taskGroupTask.id=${task.groupTaskId}&taskGroup.id=${task.groupId}`);
    return parser.parseUploadForm(result.html, task, this.baseUrl);
  }

  async upload(task, form, filename, source) {
    // Recheck the association at the upload boundary; an authenticated POST is never retried.
    const matches = form.mode === 'cloze' ?
      form.fields.taskId === task.taskId && form.fields.taskGroupId === task.groupId && form.fields.taskGroupTaskId === task.groupTaskId :
      form.fields['task.id'] === task.taskId && form.fields['taskGroup.id'] === task.groupId && form.fields['taskGroupTask.id'] === task.groupTaskId;
    if (!matches) throw new MatuError('提交表单与当前题目不一致。', 'ASSOCIATION');
    const payload = form.mode === 'cloze' ? {
      body: new URLSearchParams({ ...form.fields, anwser: parser.clozeAnswer(form, source) }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    } : multipart(form.fields, form.fileField, filename, source);
    const result = await this.transport.request(form.action, { method: 'POST', ...payload });
    parser.authenticated(result.html);
    const message = parser.rejection(result.html);
    if (message) throw new MatuError(message, 'REJECTED');
    return { id: parser.receiptId(result.html, result.url) };
  }

  async history(task) {
    const rows = unique(await this.pages(
      `/aptat/assignment/listttudenttaskgrouptaskassignmentforstudent?taskGroupTask.id=${task.groupTaskId}`,
      parser.parseHistory
    ), 'id');
    if (rows.some(row => row.taskId !== task.taskId)) {
      throw new MatuError('网站提交记录与当前题目不一致。', 'ASSOCIATION');
    }
    return rows.sort((a, b) => Number(b.id) - Number(a.id));
  }

  async scoreDetail(id) {
    if (!/^\d+$/.test(id)) throw new MatuError('提交记录编号不合法。', 'ASSOCIATION');
    return parser.parseScoreDetail((await this.read(`/aptat/assignment/scoredetail?assignmentid=${id}`)).html);
  }

  dispose() {
    this.disposed = true;
    this.credentials = null;
    this.transport.dispose();
  }
}

function unique(rows, key) {
  return [...new Map(rows.map(row => [row[key], row])).values()];
}

module.exports = { MatuClient, DEFAULT_URL };
