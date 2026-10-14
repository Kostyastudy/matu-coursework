const crypto = require('node:crypto');
const { recordLabel } = require('./parser');

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function render(webview, mediaUri, task, state = {}) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const iconCss = webview.asWebviewUri(mediaUri('codicon.css'));
  const styleCss = webview.asWebviewUri(mediaUri('panel.css'));
  const rows = state.history || [];
  const pending = state.pending;
  const status = state.kind === 'sending' ? '正在上传' :
    state.kind === 'ambiguous' ? '发现多条新记录，请核对提交记录' :
    state.kind === 'unknown' ? '提交结果待确认，请刷新评测' :
    state.kind === 'pending' ? '正在评测' : recordLabel(state.record || rows[0]);
  const disabled = state.kind === 'sending' ? 'disabled' : '';
  const details = state.details || (state.kind === 'complete' ? '网站未提供额外错误详情。' : '');
  const selectedId = state.record?.id || pending?.id || '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${iconCss}">
<link rel="stylesheet" href="${styleCss}">
<title>${escape(task.title)}</title>
</head>
<body>
<header>
  <div class="breadcrumb">${escape(task.name)} / ${escape(task.groupName)}</div>
  <div class="heading">
    <h1>${escape(task.title)}</h1>
    <div class="tools">
      <button class="icon-button" data-command="submit" title="提交当前题目" aria-label="提交当前题目" ${disabled}><span class="codicon codicon-cloud-upload"></span></button>
      <button class="icon-button" data-command="refresh" title="刷新评测" aria-label="刷新评测" ${disabled}><span class="codicon codicon-refresh"></span></button>
      <button class="icon-button" data-command="open" title="打开源码" aria-label="打开源码"><span class="codicon codicon-go-to-file"></span></button>
    </div>
  </div>
  <div class="metadata"><span>题号 ${escape(task.taskId)}</span><span>${escape(task.language)}</span><span>${escape(task.points)} 分</span>${task.allowedAttempts === null ? '' : `<span>允许提交 ${escape(task.allowedAttempts)} 次</span>`}</div>
</header>
<nav aria-label="题目视图">
  <button class="tab active" data-tab="statement" aria-selected="true">题目</button>
  <button class="tab" data-tab="results" aria-selected="false">评测与记录${rows.length ? ` (${rows.length})` : ''}</button>
</nav>
<main>
<section id="statement">
  <pre class="statement">${escape(task.statement)}</pre>
  ${task.submissionNotice ? `<p class="error">${escape(task.submissionNotice)}</p>` : ''}
  ${task.clozeTemplate ? `<h2 class="history-heading">代码填空 · ${escape(task.blankCount)} 处</h2><p class="muted">${task.blankCount === 1 ? '提交内容：填空位置的代码，或仅补全填空位置的完整程序。' : '提交内容：完整程序，仅补全填空位置。'}</p><pre class="statement">${escape(task.clozeTemplate)}</pre>` : ''}
</section>
<section id="results" hidden>
  <div class="result-heading">
    <h2>${escape(status)}</h2>
    ${pending ? '<button class="text-button" data-command="discard">结束跟踪</button>' : ''}
  </div>
  ${selectedId ? `<p class="muted">提交编号 ${escape(selectedId)}</p>` : ''}
  ${state.error ? `<p class="error">${escape(state.error)}</p>` : ''}
  ${details ? `<pre class="details">${escape(details)}</pre>` : ''}
  <h2 class="history-heading">提交记录</h2>
  ${rows.length ? `<div class="table-wrap"><table>
  <thead><tr><th>时间</th><th>状态</th><th>编号</th><th><span class="sr-only">查看详情</span></th></tr></thead>
  <tbody>${rows.map(row => `<tr${row.id === selectedId ? ' class="selected"' : ''}><td>${escape(row.time)}</td><td>${escape(recordLabel(row))}</td><td>${escape(row.id)}</td><td><button class="icon-button" data-record="${escape(row.id)}" title="查看提交 ${escape(row.id)} 的评测详情" aria-label="查看评测详情"><span class="codicon codicon-list-selection"></span></button></td></tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">尚无提交记录</p>'}
</section>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
function selectTab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    const selected = button.dataset.tab === name;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  document.getElementById('statement').hidden = name !== 'statement';
  document.getElementById('results').hidden = name !== 'results';
  vscode.setState({ tab: name });
}
selectTab(${JSON.stringify(state.showResults ? 'results' : '')} || vscode.getState()?.tab || 'statement');
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.tab) selectTab(button.dataset.tab);
  if (button.dataset.command) vscode.postMessage({ command: button.dataset.command });
  if (button.dataset.record) vscode.postMessage({ command: 'detail', id: button.dataset.record });
});
</script>
</body>
</html>`;
}

module.exports = { render, escape };
