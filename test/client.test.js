const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MatuClient } = require('../src/client');
const { Transport } = require('../src/transport');
const f = require('./fixtures');

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}/aptat/`;
}
const reply = (res, body, headers = {}) => { res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8', ...headers }); res.end(body); };

test('expired sessions reauthenticate GETs; upload sends exact multipart once and does not replay', async t => {
  let loggedIn = false;
  let logins = 0;
  let uploads = 0;
  let sent = '';
  const base = await server(t, (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/aptat/user/login.action') return reply(res, f.login, { 'Set-Cookie': 'JSESSIONID=test; Path=/aptat' });
    if (url.pathname === '/aptat/user/dologin.action') {
      req.resume(); logins++; loggedIn = true;
      return reply(res, '<title>mannager</title><frame src="files/left.jsp">');
    }
    if (url.pathname === '/aptat/course/liststudentclass') return reply(res, loggedIn ? f.courses : f.login);
    if (url.pathname === '/aptat/assignment/upload') return reply(res, loggedIn ? f.upload : f.login);
    if (url.pathname === '/aptat/assignment/upload_assignment_by_single_file') {
      uploads++;
      req.on('data', chunk => { sent += chunk.toString(); });
      req.on('end', () => reply(res, f.login));
      return;
    }
    reply(res, '<h1>unknown</h1>');
  });
  const client = new MatuClient(base);
  t.after(() => client.dispose());
  await client.login('test-account', 'test-password');
  loggedIn = false;
  assert.deepEqual(await client.courses(), [f.course]);
  assert.equal(logins, 2);
  const form = await client.uploadForm(f.task);
  await assert.rejects(client.upload(f.task, form, 'swap.cpp', Buffer.from('void swap() {}\n')), { code: 'AUTH' });
  assert.equal(uploads, 1);
  assert.equal(logins, 2);
  assert.match(sent, /name="taskGroupTask.id"\r\n\r\n45151/);
  assert.match(sent, /filename="swap.cpp"/);
  assert.match(sent, /void swap\(\) \{\}/);
  assert.doesNotMatch(sent, /test-password/);
});

test('transport blocks redirects outside origin without sending credentials', async t => {
  const base = await server(t, (req, res) => { res.writeHead(302, { Location: 'http://evil.invalid/collect' }); res.end(); });
  const transport = new Transport(base);
  t.after(() => transport.dispose());
  await assert.rejects(transport.request('/aptat/user/dologin.action', { method: 'POST', body: 'password=secret' }), { code: 'NETWORK' });
});

test('timed out upload is marked ambiguous and never retried by transport', async t => {
  let requests = 0;
  const base = await server(t, req => { requests++; req.resume(); });
  const transport = new Transport(base, { timeout: 30 });
  t.after(() => transport.dispose());
  await assert.rejects(transport.request('/aptat/upload', { method: 'POST', body: 'source' }), error => error.code === 'NETWORK' && error.ambiguous);
  assert.equal(requests, 1);
});

test('history paging deduplicates records and rejects records for another problem', async t => {
  const base = await server(t, (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.searchParams.get('page') === '2') return reply(res, f.history([{ id: '10' }]));
    reply(res, f.history([{ id: '11' }]) + '<a href="?page=2&taskGroupTask.id=45151">下一页</a>');
  });
  const client = new MatuClient(base);
  t.after(() => client.dispose());
  assert.deepEqual((await client.history(f.task)).map(row => row.id), ['11', '10']);
  await assert.rejects(client.history({ ...f.task, taskId: '6' }), { code: 'ASSOCIATION' });
});
