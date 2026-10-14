const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultFilename } = require('./parser');
const { taskKey } = require('./submission');
const { MatuError } = require('./errors');

const accountKey = account => crypto.createHash('sha256').update(account.trim()).digest('hex').slice(0, 20);
const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (root, target) => {
  const relative = path.relative(normalize(root), normalize(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const validTask = task => task && ['classId', 'groupId', 'groupTaskId', 'taskId'].every(key => /^\d+$/.test(task[key]));

class FileStore {
  constructor(root, account) {
    this.root = path.resolve(root);
    this.account = account;
    this.key = accountKey(account);
    this.associations = {};
    this.index = path.join(this.root, '.matu', `associations-${this.key}.json`);
  }

  async load() {
    try {
      const content = JSON.parse(await fs.readFile(this.index, 'utf8'));
      if (content.version !== 1 || !content.files || typeof content.files !== 'object') {
        throw new MatuError('本地题目关联文件格式不正确。', 'ASSOCIATION');
      }
      this.associations = content.files;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.index), { recursive: true });
    const temporary = `${this.index}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, files: this.associations }, null, 2), { mode: 0o600 });
    await fs.rename(temporary, this.index);
  }

  async ensure(task, chosenFilename) {
    if (!validTask(task)) throw new MatuError('题目关联编号不合法。', 'ASSOCIATION');
    const existing = Object.entries(this.associations).find(([, value]) => value.accountKey === this.key && taskKey(value.task) === taskKey(task));
    if (existing) {
      const target = path.resolve(this.root, existing[0]);
      await this.validate(target);
      return target;
    }
    const filename = chosenFilename || defaultFilename(task);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:c|cpp)$/.test(filename) || path.basename(filename) !== filename) {
      throw new MatuError('题目指定的源文件名不合法。', 'FILENAME');
    }
    const target = path.join(this.root, `account-${this.key}`, `course-${task.classId}`, `assignment-${task.groupId}`, `task-${task.taskId}-${task.groupTaskId}`, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const realRoot = await fs.realpath(this.root);
    const realParent = await fs.realpath(path.dirname(target));
    if (!within(realRoot, realParent)) throw new MatuError('作业目录指向了配置目录以外的位置。', 'ASSOCIATION');
    try {
      const handle = await fs.open(target, 'wx');
      await handle.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const prior = this.lookup(target);
    if (prior && taskKey(prior) !== taskKey(task)) throw new MatuError('当前文件已关联其他题目，已停止修改关联。', 'ASSOCIATION');
    this.associations[path.relative(this.root, target)] = { accountKey: this.key, task };
    await this.validate(target);
    await this.save();
    return target;
  }

  lookup(target) {
    if (!within(this.root, target)) return null;
    const relative = path.relative(this.root, path.resolve(target));
    const entry = Object.entries(this.associations).find(([key]) => normalize(path.resolve(this.root, key)) === normalize(path.resolve(this.root, relative)));
    const value = entry?.[1];
    if (!value || value.accountKey !== this.key || !validTask(value.task)) return null;
    return value.task;
  }

  async validate(target) {
    const task = this.lookup(target);
    if (!task || !/\.(c|cpp)$/i.test(target)) throw new MatuError('当前文件没有关联码图课程题目。', 'ASSOCIATION');
    const realTarget = await fs.realpath(target);
    const realRoot = await fs.realpath(this.root);
    if (!within(realRoot, realTarget)) throw new MatuError('当前源文件指向作业目录以外的位置。', 'ASSOCIATION');
    if (!(await fs.stat(realTarget)).isFile()) throw new MatuError('当前路径不是源文件。', 'ASSOCIATION');
    return task;
  }
}

module.exports = { FileStore, accountKey, within, validTask };
