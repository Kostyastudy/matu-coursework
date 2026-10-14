const { MatuClient } = require('../src/client');
const { defaultFilename } = require('../src/parser');

async function main() {
  const account = process.env.MATU_READ_ACCOUNT;
  const password = process.env.MATU_READ_PASSWORD;
  delete process.env.MATU_READ_ACCOUNT;
  delete process.env.MATU_READ_PASSWORD;
  if (!account || !password) throw new Error('请在本机临时环境变量中提供只读验证凭据。');
  const client = new MatuClient();
  try {
    await client.login(account, password);
    const courses = await client.courses();
    const results = [];
    for (const course of courses) {
      for (const group of await client.groups(course)) {
        const tasks = await client.tasks(group);
        const samples = [];
        const modeCounts = {};
        for (const task of tasks) {
          const detail = await client.detail(task);
          const form = await client.uploadForm(task);
          const history = await client.history(task);
          const errorRecord = history.find(row => row.score !== null && row.score < 100);
          const score = errorRecord ? await client.scoreDetail(errorRecord.id) : '';
          modeCounts[form.mode] = (modeCounts[form.mode] || 0) + 1;
          const sample = {
            title: task.title, language: task.language, filename: defaultFilename(detail),
            statementCharacters: detail.statement.length, submissionMode: form.mode,
            formMatches: (form.fields['taskGroupTask.id'] || form.fields.taskGroupTaskId) === task.groupTaskId,
            submissions: history.length, errorDetailCharacters: score.length
          };
          if (samples.length < 2 || task.language === 'C' || form.mode === 'cloze') samples.push(sample);
        }
        results.push({ course: course.name, group: group.groupName, tasks: tasks.length, checked: tasks.length, modeCounts, samples });
      }
    }
    console.log(JSON.stringify({ readOnly: true, results }, null, 2));
  } finally { client.dispose(); }
}

main().catch(error => { console.error(error.code || 'READ_FAILED', error.message); process.exitCode = 1; });
