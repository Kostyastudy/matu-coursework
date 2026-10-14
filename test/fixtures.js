const course = { classId: '632', name: 'c语言', className: '2026SWI' };
const group = { ...course, groupId: '8855', groupName: '第四次作业' };
const task = {
  ...group, taskId: '5', groupTaskId: '45151', title: '2_实现指定函数swap',
  language: 'C++', allowedAttempts: 100, points: 10
};
const login = `<form action="/aptat/user/dologin.action">
<input name="user.Login"><input type="password" name="user.Password"></form>`;
const courses = `<h1>班级列表</h1><table><tr><td>c语言</td><td>2026SWI</td><td>45.75</td>
<td><a href="/aptat/task/liststudenttaskgroup?_class.id=632">作业列表</a></td></tr></table>`;
const groups = `<h1>作业列表</h1><table><tr><td>8855</td><td>第四次作业</td><td>0.2</td>
<td>2026-09-14</td><td><a href="/aptat/task/listTaskGroup_Task?taskGroup.id=8855">题目列表</a></td></tr></table>`;
const tasks = `<h1>题目列表</h1><table><tr>
<td><a href="/aptat/task/taskdetail?taskid=5&taskGroupTask.id=45151&taskGroup.id=8855">5</a></td>
<td><a href="/aptat/task/taskdetail?taskid=5&taskGroupTask.id=45151&taskGroup.id=8855">2_实现指定函数swap</a></td>
<td>C++</td><td>100</td><td>10.0</td><td>查看</td></tr></table>`;
const detail = `<fieldset><legend>2_实现指定函数swap</legend><pre>实现swap方法：
void swap(int * array,int n);
保存为swap.cpp。
遇到异常情况，输出&quot;error&quot;。
&lt;script&gt;alert(1)&lt;/script&gt;</pre></fieldset>`;
const upload = `<form action="/aptat/assignment/upload_assignment_by_single_file" method="post" enctype="multipart/form-data">
<input type="hidden" name="taskGroupTask.id" value="45151">
<input type="hidden" name="taskGroup.id" value="8855">
<input name="task.id" value="5"><input name="task.name" value="2_实现指定函数swap">
<input type="file" name="fileUpload"><input type="submit" name="Submit" value="提交"></form>`;
function history(records = []) {
  return `<h1>作业状态</h1><table>${records.map(row => `<tr>
<td>${row.taskId || '5'}</td><td>2_实现指定函数swap</td><td>C++</td><td>${row.time || '2026-10-14 11:00:00.0'}</td>
<td>${row.status || 'score'}</td><td>${row.score ?? 100}</td>
<td><a href="/aptat/assignment/scoredetail?assignmentid=${row.id}">查看</a></td></tr>`).join('')}</table>`;
}
const score = `<h1>成绩详单</h1><table><tr><td>扣分:20</td><td>When test group(1) step(1),
the input is (2),the real output is not right.</td></tr></table>`;
module.exports = { course, group, task, login, courses, groups, tasks, detail, upload, history, score };
