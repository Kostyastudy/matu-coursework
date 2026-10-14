const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/parser');
const f = require('./fixtures');
const { render } = require('../src/webview');

test('course, group and task identity is preserved across course assignment parsing', () => {
  assert.deepEqual(p.parseCourses(f.courses), [f.course]);
  assert.deepEqual(p.parseGroups(f.groups, f.course), [f.group]);
  assert.deepEqual(p.parseTasks(f.tasks, f.group), [f.task]);
});

test('statement preserves Chinese, line breaks, function signatures and required filename', () => {
  const detail = p.parseTaskDetail(f.detail, f.task);
  assert.match(detail.statement, /方法：\nvoid swap/);
  assert.match(detail.statement, /输出"error"/);
  assert.equal(p.defaultFilename(detail), 'swap.cpp');
  assert.equal(p.defaultFilename({ language: 'C' }), 'main.c');
  assert.equal(p.defaultFilename({ language: 'C++', filenames: ['../../oops.c'] }), 'main.cpp');
  assert.equal(p.parseTasks(f.tasks.replace('<td>C++</td>', '<td>C</td>'), f.group)[0].language, 'C');
});

test('upload form fields come from page and mismatched assignments are rejected', () => {
  const form = p.parseUploadForm(f.upload, f.task, 'http://matu.uestc.edu.cn/aptat/');
  assert.equal(form.fileField, 'fileUpload');
  assert.equal(form.fields['taskGroupTask.id'], '45151');
  assert.equal(form.fields['task.name'], f.task.title);
  assert.throws(() => p.parseUploadForm(f.upload.replace('value="45151"', 'value="999"'), f.task, 'http://matu.uestc.edu.cn'), { code: 'ASSOCIATION' });
  assert.throws(() => p.parseUploadForm(f.upload.replace('/aptat/assignment/upload_assignment_by_single_file', 'http://evil.invalid/aptat/assignment/upload_assignment_by_single_file'), f.task, 'http://matu.uestc.edu.cn'), { code: 'UPLOAD_FORM' });
});

test('login expiry and malformed pages do not appear as empty successful results', () => {
  for (const parse of [p.parseCourses, p.parseHistory]) assert.throws(() => parse(f.login), { code: 'AUTH' });
  assert.throws(() => p.parseCourses('<html>maintenance</html>'), { code: 'STRUCTURE' });
  assert.throws(() => p.parseHistory('<html>maintenance</html>'), { code: 'STRUCTURE' });
  assert.deepEqual(p.parseHistory(f.history()), []);
  assert.equal(p.rejection('<p>允许提交次数已达到上限，不能提交</p>'), '允许提交次数已达到上限，不能提交');
});

test('history identifies exact record and shows website status without claiming ungraded score 100 passed', () => {
  const rows = p.parseHistory(f.history([{ id: '8', score: 0 }, { id: '9', status: '编译错误', score: 0 }]));
  assert.equal(rows[0].id, '9');
  assert.match(p.recordLabel(rows[0]), /编译错误 · 0 分/);
  assert.equal(p.recordLabel({ status: 'score', score: 100 }), '已通过 · 100 分');
  assert.notEqual(p.recordLabel({ status: '排队中', score: 100 }), '已通过 · 100 分');
  assert.match(p.parseScoreDetail(f.score), /扣分:20\nWhen test/);
  assert.equal(p.isTerminal({ status: '排队中' }), false);
});

test('pagination stays within current endpoint and receipt is not guessed from multiple records', () => {
  const html = '<a href="?page=2&taskGroupTask.id=45151">next</a><a href="http://evil.invalid/?page=3">bad</a>';
  assert.deepEqual(p.pageLinks(html, 'http://matu.uestc.edu.cn/aptat/assignment/listttudenttaskgrouptaskassignmentforstudent?taskGroupTask.id=45151'),
    ['http://matu.uestc.edu.cn/aptat/assignment/listttudenttaskgrouptaskassignmentforstudent?page=2&taskGroupTask.id=45151']);
  assert.equal(p.receiptId(f.history([{ id: '8' }, { id: '9' }]), 'http://matu.uestc.edu.cn/aptat/assignment/listassignment'), null);
});

test('webview renders real Chinese content while escaping website scripts and errors', () => {
  const html = render({ cspSource: 'vscode-webview:', asWebviewUri: value => value },
    file => `vscode-webview:/${file}`, p.parseTaskDetail(f.detail, f.task), {
      kind: 'complete', record: { id: '22', status: 'score', score: 0 },
      details: '<img src=x onerror=alert(1)>', history: []
    });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /题号 5/);
  assert.doesNotMatch(html, /<img src=x/);
});
