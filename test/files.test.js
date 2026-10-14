const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore } = require('../src/files');
const f = require('./fixtures');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matu-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('empty file creation is persistent, never overwrites code and isolates assignment identities', async t => {
  const root = await temporary(t);
  const store = new FileStore(root, 'test-student');
  await store.load();
  const filename = await store.ensure({ ...f.task, filenames: ['swap.cpp'] });
  assert.equal(await fs.readFile(filename, 'utf8'), '');
  await fs.writeFile(filename, '// my code\n');
  assert.equal(await store.ensure(f.task), filename);
  assert.equal(await fs.readFile(filename, 'utf8'), '// my code\n');
  const second = await store.ensure({ ...f.task, groupId: '9000', groupTaskId: '50000' });
  assert.notEqual(second, filename);
  const reload = new FileStore(root, 'test-student');
  await reload.load();
  assert.equal((await reload.validate(filename)).groupTaskId, '45151');
  assert.equal(reload.lookup(path.join(root, 'unassociated.c')), null);
  await assert.rejects(reload.validate(path.join(root, 'unassociated.c')), { code: 'ASSOCIATION' });
});

test('accounts do not reuse each other source files or associations', async t => {
  const root = await temporary(t);
  const a = new FileStore(root, 'student-A');
  const b = new FileStore(root, 'student-B');
  const af = await a.ensure(f.task);
  const bf = await b.ensure(f.task);
  assert.notEqual(af, bf);
  assert.equal(b.lookup(af), null);
  assert.equal(a.lookup(bf), null);
});

test('invalid names and directory traversal cannot create a source file', async t => {
  const root = await temporary(t);
  const store = new FileStore(root, 'test-student');
  await assert.rejects(store.ensure(f.task, '../../escape.cpp'), { code: 'FILENAME' });
  await assert.rejects(store.ensure({ ...f.task, groupId: '..' }), { code: 'ASSOCIATION' });
});
