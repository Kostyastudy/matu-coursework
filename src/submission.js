const crypto = require('node:crypto');
const { MatuError } = require('./errors');
const { isTerminal } = require('./parser');

const taskKey = task => `${task.classId}:${task.groupId}:${task.groupTaskId}:${task.taskId}`;

class SubmissionManager {
  constructor(client, options = {}) {
    this.client = client;
    this.pending = options.pending || {};
    this.persist = options.persist || (async () => {});
    this.update = options.update || (() => {});
    this.now = options.now || Date.now;
    this.delay = options.delay || (ms => new Promise(resolve => {
      const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, ms);
      this.timers.set(timer, resolve);
    }));
    this.timers = new Map();
    this.maxWait = options.maxWait ?? 120000;
    this.locks = new Set();
    this.disposed = false;
  }

  busy(task) { return this.locks.has(taskKey(task)); }
  waiting(task) { return this.pending[taskKey(task)]; }

  async save() { await this.persist(this.pending); }

  async submit(task, filename, source) {
    const key = taskKey(task);
    if (this.disposed) throw new MatuError('提交连接已关闭。', 'DISPOSED');
    if (this.locks.has(key)) throw new MatuError('这道题正在提交或查询评测，请稍候。', 'BUSY');
    if (this.pending[key]) throw new MatuError('这道题还有未确认的提交，请先刷新评测或查看提交记录。', 'PENDING');
    this.locks.add(key);
    try {
      const baseline = await this.client.history(task);
      if (task.allowedAttempts !== null && task.allowedAttempts !== undefined && baseline.length >= task.allowedAttempts) {
        throw new MatuError('这道题的允许提交次数已用完。', 'LIMIT');
      }
      const form = await this.client.uploadForm(task);
      if (this.disposed) throw new MatuError('提交已取消。', 'DISPOSED');
      const item = {
        task, baseline: baseline.map(row => row.id), id: null, startedAt: this.now(),
        phase: 'sending', digest: crypto.createHash('sha256').update(source).digest('hex')
      };
      this.pending[key] = item;
      await this.save();
      this.update(task, { kind: 'sending', pending: item, history: baseline });
      try {
        const receipt = await this.client.upload(task, form, filename, source);
        if (receipt.id && !item.baseline.includes(receipt.id)) item.id = receipt.id;
        item.phase = 'pending';
      } catch (error) {
        if (['REJECTED', 'ASSOCIATION', 'UPLOAD_FORM', 'ORIGIN', 'CLOZE'].includes(error.code)) {
          delete this.pending[key];
          await this.save();
          throw error;
        }
        item.phase = 'unknown';
        this.update(task, { kind: 'unknown', pending: item });
      }
      await this.save();
      return await this.poll(task);
    } finally {
      this.locks.delete(key);
    }
  }

  async reconcile(task) {
    const key = taskKey(task);
    const item = this.pending[key];
    const history = await this.client.history(task);
    if (!item) {
      this.update(task, { kind: 'history', history });
      return { kind: 'history', history };
    }
    if (!item.id) {
      const candidates = history.filter(row => !item.baseline.includes(row.id));
      if (candidates.length === 1) {
        item.id = candidates[0].id;
        item.phase = 'pending';
        await this.save();
      } else if (candidates.length > 1) {
        item.phase = 'ambiguous';
        await this.save();
        const result = { kind: 'ambiguous', pending: item, history };
        this.update(task, result);
        return result;
      }
    }
    const record = history.find(row => row.id === item.id);
    if (record && isTerminal(record)) {
      const details = await this.client.scoreDetail(record.id);
      delete this.pending[key];
      await this.save();
      const result = { kind: 'complete', record, details, history };
      this.update(task, result);
      return result;
    }
    const result = { kind: item.id ? 'pending' : 'unknown', pending: item, record, history };
    this.update(task, result);
    return result;
  }

  async poll(task) {
    const until = this.now() + this.maxWait;
    let interval = 2000;
    let result = { kind: 'unknown', pending: this.waiting(task) };
    do {
      if (this.disposed) return result;
      try {
        result = await this.reconcile(task);
        if (['complete', 'ambiguous'].includes(result.kind)) return result;
      } catch (error) {
        if (error.code === 'DISPOSED' || this.disposed) return result;
        if (!['NETWORK', 'AUTH', 'LOGIN'].includes(error.code)) throw error;
        result = { kind: 'unknown', pending: this.waiting(task), error: error.message };
        this.update(task, result);
      }
      const remaining = until - this.now();
      if (remaining <= 0) break;
      await this.delay(Math.min(interval, remaining));
      interval = Math.min(interval * 2, 10000);
    } while (this.now() < until);
    const waiting = this.waiting(task);
    if (waiting) { waiting.phase = result.kind; await this.save(); }
    return result;
  }

  async refresh(task) {
    const key = taskKey(task);
    if (this.locks.has(key)) throw new MatuError('正在查询这道题的评测，请稍候。', 'BUSY');
    this.locks.add(key);
    try { return await this.reconcile(task); }
    finally { this.locks.delete(key); }
  }

  async discard(task) {
    if (this.busy(task)) throw new MatuError('正在提交或查询，请稍候。', 'BUSY');
    delete this.pending[taskKey(task)];
    await this.save();
  }

  dispose() {
    this.disposed = true;
    for (const [timer, resolve] of this.timers) { clearTimeout(timer); resolve(); }
    this.timers.clear();
  }
}

module.exports = { SubmissionManager, taskKey };
