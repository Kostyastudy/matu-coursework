const cheerio = require('cheerio');
const { MatuError, AuthenticationError } = require('./errors');

const BASE = 'http://matu.uestc.edu.cn';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const numeric = (url, name) => {
  const value = url.searchParams.get(name);
  if (!value || !/^\d+$/.test(value)) throw new MatuError('网站页面缺少有效的作业编号。', 'STRUCTURE');
  return value;
};
const load = html => {
  const $ = cheerio.load(html);
  $('script,style,head').remove();
  return $;
};

function isLogin(html) {
  const $ = cheerio.load(html);
  return $('input[name="user.Password"]').length > 0;
}

function authenticated(html) {
  if (isLogin(html)) throw new AuthenticationError();
}

function pageLinks(html, currentUrl) {
  const $ = cheerio.load(html);
  const current = new URL(currentUrl, BASE);
  const links = new Set();
  $('a[href]').each((_, element) => {
    const url = new URL($(element).attr('href'), current);
    if (url.origin === current.origin && url.pathname === current.pathname &&
        url.searchParams.has('page')) links.add(url.href);
  });
  return [...links];
}

function parseCourses(html) {
  authenticated(html);
  const $ = load(html);
  const rows = new Map();
  $('a[href*="/task/liststudenttaskgroup?"]').each((_, element) => {
    const a = $(element);
    const url = new URL(a.attr('href'), BASE);
    const classId = numeric(url, '_class.id');
    const cells = a.closest('tr').children('td');
    if (cells.length < 2) throw new MatuError('课程列表结构已变化。', 'STRUCTURE');
    rows.set(classId, { classId, name: clean(cells.eq(0).text()), className: clean(cells.eq(1).text()) });
  });
  if (!rows.size && !/班级列表|课程列表/.test($.root().text())) {
    throw new MatuError('无法识别课程列表，请检查网站是否正常。', 'STRUCTURE');
  }
  return [...rows.values()];
}

function parseGroups(html, course) {
  authenticated(html);
  const $ = load(html);
  const rows = new Map();
  $('a[href*="/task/listTaskGroup_Task?"]').each((_, element) => {
    const a = $(element);
    const groupId = numeric(new URL(a.attr('href'), BASE), 'taskGroup.id');
    const cells = a.closest('tr').children('td');
    if (cells.length < 2) throw new MatuError('作业列表结构已变化。', 'STRUCTURE');
    rows.set(groupId, { ...course, groupId, groupName: clean(cells.eq(1).text()) });
  });
  if (!rows.size && !/作业列表/.test($.root().text())) {
    throw new MatuError('无法识别课程作业列表。', 'STRUCTURE');
  }
  return [...rows.values()];
}

function parseTasks(html, group) {
  authenticated(html);
  const $ = load(html);
  const rows = new Map();
  $('a[href*="/task/taskdetail?"]').each((_, element) => {
    const a = $(element);
    const url = new URL(a.attr('href'), BASE);
    const taskId = numeric(url, 'taskid');
    const groupTaskId = numeric(url, 'taskGroupTask.id');
    const groupId = numeric(url, 'taskGroup.id');
    if (groupId !== group.groupId) throw new MatuError('网站返回了其他作业的题目。', 'STRUCTURE');
    const cells = a.closest('tr').children('td');
    const language = clean(cells.eq(2).text());
    if (cells.length < 6 || !['C', 'C++'].includes(language)) {
      throw new MatuError('题目列表结构或语言要求无法识别。', 'STRUCTURE');
    }
    const attempts = Number(clean(cells.eq(3).text()));
    rows.set(groupTaskId, {
      ...group, taskId, groupTaskId, title: clean(cells.eq(1).text()), language,
      allowedAttempts: Number.isFinite(attempts) ? attempts : null,
      points: Number(clean(cells.eq(4).text()))
    });
  });
  if (!rows.size && !/题目列表/.test($.root().text())) {
    throw new MatuError('无法识别题目列表。', 'STRUCTURE');
  }
  return [...rows.values()];
}

function parseTaskDetail(html, task) {
  authenticated(html);
  const $ = load(html);
  const statements = $('fieldset pre');
  if (!statements.length) throw new MatuError('无法读取题面，网站结构可能已变化。', 'STRUCTURE');
  const statement = statements.map((_, element) => $(element).text()).get().join('\n\n');
  const title = clean($('fieldset legend').first().text()) || task.title;
  const requested = [...statement.matchAll(/(?:保存(?:为|成)|文件(?:名)?(?:为|是)?|提交(?:文件|源文件))\s*[：:为]?\s*["'“]?([A-Za-z0-9_.-]+\.(?:cpp|c))\b/gi)];
  const filenames = [...new Set(requested.map(match => match[1]))];
  return { ...task, title, statement, filenames };
}

function defaultFilename(task) {
  if (task.filenames?.length === 1 && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:c|cpp)$/.test(task.filenames[0])) {
    return task.filenames[0];
  }
  return task.language === 'C' ? 'main.c' : 'main.cpp';
}

function parseUploadForm(html, task, baseUrl) {
  authenticated(html);
  const $ = cheerio.load(html);
  const form = $('form').filter((_, el) => String($(el).attr('action')).includes('/upload_assignment_by_single_file')).first();
  if (!form.length) {
    const clozeForm = $('form').filter((_, el) => String($(el).attr('action')).includes('ClozeTestServlet.servlet')).first();
    if (clozeForm.length) return parseClozeForm(html, clozeForm, task, baseUrl, $);
    const text = clean(load(html).root().text());
    throw new MatuError(/次数|上限|不能|截止|未开放/.test(text) ? text.slice(0, 240) : '网站没有提供单文件提交入口。', 'UPLOAD_FORM');
  }
  const action = new URL(form.attr('action'), baseUrl);
  if (action.origin !== new URL(baseUrl).origin || action.pathname !== '/aptat/assignment/upload_assignment_by_single_file') {
    throw new MatuError('提交地址与码图网站不一致。', 'UPLOAD_FORM');
  }
  const fields = {};
  form.find('input[name]').each((_, element) => {
    const input = $(element);
    const type = (input.attr('type') || 'text').toLowerCase();
    if (!['file', 'button', 'image', 'reset'].includes(type)) fields[input.attr('name')] = input.attr('value') || '';
  });
  if (fields['task.id'] !== task.taskId || fields['taskGroup.id'] !== task.groupId ||
      fields['taskGroupTask.id'] !== task.groupTaskId) {
    throw new MatuError('提交表单与当前课程题目不一致，已停止提交。', 'ASSOCIATION');
  }
  const fileField = form.find('input[type="file"]').attr('name');
  if (fileField !== 'fileUpload') throw new MatuError('网站上传字段已变化。', 'UPLOAD_FORM');
  return { mode: 'file', action: action.href, fields, fileField };
}

function parseClozeForm(html, form, task, baseUrl, $) {
  const action = new URL(form.attr('action'), baseUrl);
  if (action.origin !== new URL(baseUrl).origin || action.pathname !== '/aptat/ClozeTestServlet.servlet') {
    throw new MatuError('代码填空提交地址不正确。', 'UPLOAD_FORM');
  }
  const encoded = /\bvar\s+strencoded\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(html)?.[1];
  const marker = /\bvar\s+clozeblock\s*=\s*"([^"\r\n]+)"/.exec(html)?.[1];
  if (!encoded || !marker) throw new MatuError('无法识别代码填空题的框架。', 'UPLOAD_FORM');
  const template = Buffer.from(encoded, 'base64').toString('utf8').replace(/\r\n/g, '\n');
  const blankCount = template.split('\n').filter(line => line.includes(marker)).length;
  if (!blankCount || blankCount > 100) throw new MatuError('代码填空题的空位数量不正确。', 'UPLOAD_FORM');
  const fields = {};
  for (const [name, expected] of [['taskId', task.taskId], ['taskGroupId', task.groupId], ['taskGroupTaskId', task.groupTaskId]]) {
    if (!form.find(`input[name="${name}"]`).length) throw new MatuError('代码填空提交字段已变化。', 'UPLOAD_FORM');
    const pattern = new RegExp(`getElementById\\(["']${name}["']\\)\\.value\\s*=\\s*(\\d+)\\s*;`);
    const id = pattern.exec(html)?.[1] || form.find(`input[name="${name}"]`).attr('value');
    if (id !== expected) throw new MatuError('代码填空表单与当前课程题目不一致。', 'ASSOCIATION');
    fields[name] = id;
  }
  if (!form.find('input[name="anwser"]').length) throw new MatuError('代码填空答案字段已变化。', 'UPLOAD_FORM');
  return { mode: 'cloze', action: action.href, fields, template, marker, blankCount };
}

function clozeAnswer(form, source) {
  const text = source.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = form.template.split('\n');
  const chunks = [''];
  for (const line of lines) {
    if (line.includes(form.marker)) chunks.push('');
    else chunks[chunks.length - 1] += `${line}\n`;
  }
  if (lines[lines.length - 1] === '') chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, -1);
  const capture = form.blankCount > 1 ? '([^\\n]+)\\n' : '([\\s\\S]*?)';
  const pattern = new RegExp(`^${chunks.map(escaped).join(capture)}\\n?$`);
  const fullProgram = pattern.exec(text);
  let answers;
  if (fullProgram) answers = fullProgram.slice(1).map(value => value.replace(/\n$/, ''));
  else if (form.blankCount === 1 && !/^\s*#\s*include\b/m.test(text)) answers = [text.trim()];
  else throw new MatuError('代码填空题请保留题面给出的程序框架，仅修改填空位置。', 'CLOZE');
  if (answers.some(value => !value.trim() || value.includes(form.marker) || /[^\x00-\x7F]/.test(value))) {
    throw new MatuError('填空内容为空或包含网站不支持的字符，请检查源码。', 'CLOZE');
  }
  return Buffer.from(answers.map(value => value + form.marker).join(''), 'ascii').toString('base64');
}

function parseHistory(html) {
  authenticated(html);
  const $ = load(html);
  const rows = new Map();
  $('a[href*="/assignment/scoredetail?"]').each((_, element) => {
    const a = $(element);
    const id = numeric(new URL(a.attr('href'), BASE), 'assignmentid');
    const cells = a.closest('tr').children('td');
    if (cells.length < 7) throw new MatuError('网站提交记录结构已变化。', 'STRUCTURE');
    const taskId = clean(cells.eq(0).text());
    const scoreText = clean(cells.eq(5).text());
    rows.set(id, {
      id, taskId, title: clean(cells.eq(1).text()), language: clean(cells.eq(2).text()),
      time: clean(cells.eq(3).text()), status: clean(cells.eq(4).text()),
      score: /^-?\d+(?:\.\d+)?$/.test(scoreText) ? Number(scoreText) : null
    });
  });
  if (!rows.size && !/作业状态/.test($.root().text())) {
    throw new MatuError('无法识别网站提交记录。', 'STRUCTURE');
  }
  return [...rows.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

function parseScoreDetail(html) {
  authenticated(html);
  const $ = load(html);
  const lines = [];
  $('tr').each((_, element) => {
    const cells = $(element).children('td');
    if (cells.length !== 2 || cells.find('table').length) return;
    const first = clean(cells.eq(0).text());
    const second = cells.eq(1).text().trim();
    if (/扣分|错误|异常|编译|测试|error|test/i.test(first + second)) {
      lines.push(first ? `${first}\n${second}` : second);
    }
  });
  if (!/成绩详单/.test($.root().text())) throw new MatuError('无法识别评测详情。', 'STRUCTURE');
  return lines.join('\n\n');
}

function isTerminal(record) {
  return /^(score|accepted|wrong answer|compile error|runtime error|time limit exceeded)$/i.test(record.status) ||
    /编译错误|运行错误|运行异常|超时|已完成|已通过|评测完成/.test(record.status);
}

function recordLabel(record) {
  if (!record) return '未提交';
  if (isTerminal(record) && record.score === 100) return '已通过 · 100 分';
  return `${record.status || '评测中'}${record.score === null ? '' : ` · ${record.score} 分`}`;
}

function receiptId(html, url) {
  const found = new Set();
  const current = new URL(url, BASE);
  const direct = current.searchParams.get('assignmentid');
  if (direct && /^\d+$/.test(direct)) found.add(direct);
  const $ = load(html);
  $('a[href*="/assignment/scoredetail?"]').each((_, el) => {
    const value = new URL($(el).attr('href'), BASE).searchParams.get('assignmentid');
    if (value && /^\d+$/.test(value)) found.add(value);
  });
  return found.size === 1 ? [...found][0] : null;
}

function rejection(html) {
  const $ = load(html);
  const errors = $('.errorMessage,.error,.errors,font[color="red"]').text().trim();
  const text = clean($.root().text());
  const candidate = errors || (text.length < 1200 && !/作业状态/.test(text) ? text : '');
  return /次数|上限|不能提交|不允许|失败|不能为空|超出|截止|未开放|文件类型|格式错误/.test(candidate) ? clean(candidate).slice(0, 240) : null;
}

module.exports = {
  clean, isLogin, authenticated, pageLinks, parseCourses, parseGroups, parseTasks,
  parseTaskDetail, defaultFilename, parseUploadForm, parseHistory, parseScoreDetail,
  isTerminal, recordLabel, receiptId, rejection, clozeAnswer
};
