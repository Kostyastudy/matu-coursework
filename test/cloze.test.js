const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseUploadForm, clozeAnswer } = require('../src/parser');
const { MatuClient } = require('../src/client');
const { task, history } = require('./fixtures');

const template = '#include<stdio.h>\nvoid main()\n{\n int s = 0;\n ///<%cloze block%>\n printf("%d", s);\n}\n';
function page(framework = template) {
  return `<script>
var strencoded = "${Buffer.from(framework).toString('base64')}";
var clozeblock = "///<%cloze block%>";
document.getElementById("taskId").value = 5;
document.getElementById("taskGroupId").value = 8855;
document.getElementById("taskGroupTaskId").value = 45151;
</script><form action="ClozeTestServlet.servlet" method="post">
<input name="taskId"><input name="taskGroupId"><input name="taskGroupTaskId"><input name="anwser"></form>`;
}

test('cloze submission matches website field spelling and validates course identifiers', () => {
  const form = parseUploadForm(page(), task, 'http://matu.uestc.edu.cn/aptat/');
  assert.equal(form.mode, 'cloze');
  assert.equal(form.blankCount, 1);
  const fragment = clozeAnswer(form, Buffer.from('s = 3;'));
  assert.equal(Buffer.from(fragment, 'base64').toString(), 's = 3;///<%cloze block%>');
  const full = template.replace(' ///<%cloze block%>', 's = 3;');
  assert.equal(clozeAnswer(form, Buffer.from(full)), fragment);
  assert.throws(() => clozeAnswer(form, Buffer.from(full.replace('int s = 0;', 'int s = 9;'))), { code: 'CLOZE' });
  assert.throws(() => parseUploadForm(page().replace('.value = 45151', '.value = 9'), task, 'http://matu.uestc.edu.cn/aptat/'), { code: 'ASSOCIATION' });
});

test('multiple blank extraction preserves the exact fixed framework and rejects incomplete code', () => {
  const two = template.replace(' printf', ' ///<%cloze block%>\n printf');
  const form = parseUploadForm(page(two), task, 'http://matu.uestc.edu.cn/aptat/');
  assert.equal(form.blankCount, 2);
  const full = two.replace(' ///<%cloze block%>', 's = 3;').replace(' ///<%cloze block%>', 's++;');
  assert.equal(Buffer.from(clozeAnswer(form, Buffer.from(full)), 'base64').toString(), 's = 3;///<%cloze block%>s++;///<%cloze block%>');
  assert.throws(() => clozeAnswer(form, Buffer.from('s = 3;')), { code: 'CLOZE' });
});

test('cloze client sends base64 answer to distinct endpoint once', async t => {
  let uploads = 0;
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      uploads++;
      received = new URLSearchParams(body);
      assert.equal(req.url, '/aptat/ClozeTestServlet.servlet');
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(history([{ id: '10' }]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/aptat/`;
  const client = new MatuClient(base);
  t.after(() => { client.dispose(); return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  await client.upload(task, parseUploadForm(page(), task, base), 'main.cpp', Buffer.from('s = 3;'));
  assert.equal(uploads, 1);
  assert.equal(received.get('taskGroupTaskId'), '45151');
  assert.equal(Buffer.from(received.get('anwser'), 'base64').toString(), 's = 3;///<%cloze block%>');
});
