const test = require('node:test');
const assert = require('node:assert/strict');
const { SubmissionManager, taskKey } = require('../src/submission');
const { TransportError, MatuError } = require('../src/errors');
const { task } = require('./fixtures');

function setup(options = {}) {
  let time = 0;
  let uploads = 0;
  const saved = [];
  const events = [];
  let rows = [{ id: '10', taskId: '5', status: 'score', score: 100 }];
  const client = {
    history: async () => rows,
    uploadForm: async () => ({ fields: {} }),
    upload: async () => { uploads++; rows = [{ id: '11', taskId: '5', status: 'score', score: 20 }, ...rows]; return { id: '11' }; },
    scoreDetail: async id => `detail-${id}`,
    ...options.client
  };
  const manager = new SubmissionManager(client, {
    maxWait: 100, now: () => time, delay: async ms => { time += ms; },
    persist: async data => saved.push(JSON.parse(JSON.stringify(data))),
    update: (task, state) => events.push(state), ...options.manager
  });
  return { manager, client, saved, events, uploads: () => uploads, setRows: value => { rows = value; } };
}

test('current receipt is evaluated by exact ID rather than an old passing grade', async () => {
  const s = setup();
  const result = await s.manager.submit(task, 'swap.cpp', Buffer.from('code'));
  assert.equal(result.kind, 'complete');
  assert.equal(result.record.id, '11');
  assert.equal(result.record.score, 20);
  assert.equal(result.details, 'detail-11');
  assert.equal(s.uploads(), 1);
  assert.equal(s.saved[0][taskKey(task)].phase, 'sending');
  assert.equal(s.manager.waiting(task), undefined);
});

test('double submit is blocked throughout upload and evaluation', async () => {
  let resolve;
  const blocker = new Promise(r => { resolve = r; });
  const s = setup({ client: { uploadForm: () => blocker } });
  const first = s.manager.submit(task, 'swap.cpp', Buffer.from('code'));
  await assert.rejects(s.manager.submit(task, 'swap.cpp', Buffer.from('code')), { code: 'BUSY' });
  resolve({});
  await first;
  assert.equal(s.uploads(), 1);
});

test('ambiguous upload timeout queries history once and never retries upload', async () => {
  let calls = 0;
  const s = setup({ client: { upload: async () => { calls++; throw new TransportError('timeout', true); } } });
  const result = await s.manager.submit(task, 'swap.cpp', Buffer.from('code'));
  assert.equal(result.kind, 'unknown');
  assert.equal(calls, 1);
  assert.ok(s.manager.waiting(task));
  await assert.rejects(s.manager.submit(task, 'swap.cpp', Buffer.from('code')), { code: 'PENDING' });
  s.setRows([{ id: '12', taskId: '5', status: 'score', score: 100 }]);
  const refreshed = await s.manager.refresh(task);
  assert.equal(refreshed.record.id, '12');
  assert.equal(calls, 1);
});

test('multiple new records do not silently claim any one as current submission', async () => {
  const s = setup({ client: { upload: async () => {
    s.setRows([{ id: '12', taskId: '5', status: 'score', score: 100 }, { id: '11', taskId: '5', status: 'score', score: 0 }]);
    return { id: null };
  } } });
  assert.equal((await s.manager.submit(task, 'swap.cpp', Buffer.from('code'))).kind, 'ambiguous');
  assert.equal(s.manager.waiting(task).id, null);
});

test('queued grade remains pending across restart then resolves the same receipt', async () => {
  const s = setup({ client: { upload: async () => {
    s.setRows([{ id: '11', taskId: '5', status: '排队中', score: 0 }]);
    return { id: '11' };
  } } });
  assert.equal((await s.manager.submit(task, 'swap.cpp', Buffer.from('code'))).kind, 'pending');
  const restored = new SubmissionManager(s.client, { pending: structuredClone(s.manager.pending) });
  s.setRows([{ id: '11', taskId: '5', status: 'score', score: 100 }]);
  assert.equal((await restored.refresh(task)).kind, 'complete');
});

test('attempt limits, rejected uploads and wrong associations prevent accidental submission', async () => {
  const s = setup();
  await assert.rejects(s.manager.submit({ ...task, allowedAttempts: 1 }, 'swap.cpp', Buffer.from('code')), { code: 'LIMIT' });
  assert.equal(s.uploads(), 0);
  s.client.upload = async () => { throw new MatuError('wrong task', 'ASSOCIATION'); };
  await assert.rejects(s.manager.submit(task, 'swap.cpp', Buffer.from('code')), { code: 'ASSOCIATION' });
  assert.equal(s.manager.waiting(task), undefined);
});

test('transient network failure preserves the pending receipt for later refresh', async () => {
  const s = setup({ client: { upload: async () => {
    s.client.history = async () => { throw new TransportError('offline'); };
    return { id: '11' };
  } } });
  assert.equal((await s.manager.submit(task, 'swap.cpp', Buffer.from('code'))).kind, 'unknown');
  assert.equal(s.manager.waiting(task).id, '11');
});
