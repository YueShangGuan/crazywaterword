import { readFileSync } from 'node:fs';
import { automationTasks } from './automation.mjs';
import { operationLabels } from './operation-labels.mjs';
import { iconEntry } from './art.mjs';
import { rail, topbar, journal, dialogs, templates, overviewPage, manualPage, heroesPage, dailiesPage, activitiesPage, accountPage, automationPage, idlePanel, stagePanel } from './ui/dist/console.mjs';
import { AUTOMATION_SCRIPT } from './automation-ui.mjs';
const componentCss = readFileSync(new URL('./ui/dist/theme.css', import.meta.url), 'utf8');
const consoleCss = readFileSync(new URL('./console.css', import.meta.url), 'utf8');
const automationCss = readFileSync(new URL('./automation.css', import.meta.url), 'utf8');
const progressionScript = readFileSync(new URL('./ui/progression.js', import.meta.url), 'utf8');
const activitiesScript = readFileSync(new URL('./ui/activities.js', import.meta.url), 'utf8');
const connectionScript = readFileSync(new URL('./ui/connection.js', import.meta.url), 'utf8');

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect fill='%23102d39' width='40' height='40' rx='8'/%3E%3Cpath fill='%23ffbd77' d='m20 3 4 13 13 4-13 4-4 13-4-13-13-4 13-4z'/%3E%3C/svg%3E">
<title>疯狂水世界</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>@layer theme, legacy, utilities; @layer legacy { ${consoleCss} ${automationCss} } ${componentCss}</style>
</head>
<body>
<div class="app">
${rail(iconEntry)}
<div class="stage">
${topbar()}
<div class="deck" id="deck"><main>
  <section id="tab-overview">
    ${overviewPage()}
  </section>

  <section id="tab-idle" class="hidden">
    ${idlePanel(automationTasks.filter(task => task.group !== '限时活动'))}
  </section>

  <section id="tab-manual" class="hidden">
    ${manualPage()}
  </section>

  <section id="tab-stages" class="hidden">
    ${stagePanel()}
  </section>

  <section id="tab-heroes" class="hidden">
    ${heroesPage()}
  </section>

  <section id="tab-activities" class="hidden">
    ${activitiesPage()}
  </section>
  <section id="tab-dailies" class="hidden">
    ${dailiesPage()}
  </section>

  <section id="tab-automation" class="hidden">
    ${automationPage()}
  </section>

  <section id="tab-account" class="hidden">
    ${accountPage()}
  </section>
</main>
${journal()}</div>
</div>
</div>
${dialogs()}
${templates()}

<script>
const $ = (id) => document.getElementById(id);
const logEl = $('log');
const operationNames = ${JSON.stringify(operationLabels)};

// 同一个页面只伺候一个账号：所有请求都带 ?account=<当前选中>。
let current = null;
let accounts = [];
let stream = null;

function num(v) {
  if (v == null || typeof v !== 'object') return v;
  return (v.low >>> 0) + (v.high >>> 0) * 4294967296;
}

function fmt(v) {
  const n = num(v);
  if (typeof n !== 'number') return String(n == null ? '-' : n);
  return n.toLocaleString('zh-CN');
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function call(path, options) {
  const opts = options || {};
  let url = path;
  if (current && url.indexOf('/api/') === 0 && url.indexOf('account=') < 0) {
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'account=' + encodeURIComponent(current);
  }
  const account = current;
  try {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data.error || res.statusText);
      if (data.log && (!data.log.account || account === current)) appendLog(data.log);
      error.logged = true;
      if (!data.log && account === current) reportError(new Error(data.error || ('控制台返回 HTTP ' + res.status)), path);
      throw error;
    }
    return data;
  } catch (error) {
    if (!error.logged && account === current) reportError(error, path);
    error.logged = true;
    throw error;
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  node.textContent = '';
  return node;
}

/** Copy the current detailed automation result without exposing the global run journal. */
async function copyAutomationLog() {
  const text = $('automation-view').innerText;
  if (!text) {
    $('automation-log-copy-hint').textContent = '当前没有日志可复制';
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    $('automation-log-copy-hint').textContent = '已复制当前自动化日志';
  } catch (error) {
    // Clipboard permission depends on the browser window, so only report success after the write resolves.
    $('automation-log-copy-hint').textContent = '复制失败，请检查浏览器剪贴板权限';
  }
}

$('automation-log-copy').onclick = copyAutomationLog;

// ---- 图标 ------------------------------------------------------------------
// 图集页整张给到浏览器，靠 CSS 裁。FGUI 里约 15% 的图是转 90 度打包的，
// 这些要把裁好的矩形转回来再摆正，否则显示出来是躺着的。

function iconEl(entry, size, name) {
  const box = el('span', 'ico');
  box.style.width = size + 'px';
  box.style.height = size + 'px';
  if (!entry) {
    box.appendChild(el('span', 'fallback', (name || '?').slice(0, 1)));
    box.title = name || '';
    return box;
  }
  // 显示尺寸就是矩形本身 w×h，转不转都一样。
  const k = size / Math.max(entry.w, entry.h);
  const wrap = el('span', 'ico');
  wrap.style.width = Math.round(entry.w * k) + 'px';
  wrap.style.height = Math.round(entry.h * k) + 'px';
  const inner = el('i', 'atlas');
  // 但旋转打包的贴图在图集里占的是 h 宽、w 高（跟显示尺寸正好差一个 90 度），
  // 所以元素盒子要按 h×w 铺，再整体转回来：占位 [0,w*k]×[0,h*k] 就是显示尺寸。
  inner.style.width = (entry.rotated ? entry.h : entry.w) + 'px';
  inner.style.height = (entry.rotated ? entry.w : entry.h) + 'px';
  inner.style.backgroundImage = 'url(' + entry.url + ')';
  inner.style.backgroundPosition = '-' + entry.x + 'px -' + entry.y + 'px';
  inner.style.transform = entry.rotated
    ? 'translate(0,' + Math.round(entry.h * k) + 'px) rotate(-90deg) scale(' + k + ')'
    : 'scale(' + k + ')';
  inner.title = name || '';
  wrap.appendChild(inner);
  return wrap;
}

// 一项东西：图标 + 名字 + 数量
function cell(entry, size, name, qty, showPlaceholder = true) {
  const node = el('div', 'cell');
  if (entry || showPlaceholder) node.appendChild(iconEl(entry, size || 34, name));
  const txt = el('div', 'txt');
  txt.appendChild(el('span', 'nm', name || '?'));
  if (qty != null) txt.appendChild(el('span', 'qty', qty));
  node.appendChild(txt);
  return node;
}

function component(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}
function smallButton(label, danger = false) {
  const button = component(danger ? 'ui-delete' : 'ui-button');
  button.textContent = label;
  return button;
}
function chip(status, text) {
  const badge = component('ui-badge');
  badge.classList.add('chip', status);
  badge.textContent = text;
  return badge;
}

// ---- 弹窗 ------------------------------------------------------------------
// 抓包要改系统设置，所以确认做得重一点：先勾选，再等倒计时，两样都满足才能点。

let modalTimer = null;
function closeModal() {
  $('modal').close();
  if (modalTimer) clearInterval(modalTimer);
  modalTimer = null;
  $('m-ok').onclick = null;
}
function canConfirm(seconds) {
  return isChecked($('m-ack')) && seconds <= 0;
}
function openConfirm(title, bodyNodes, onOk) {
  $('m-title').textContent = title;
  const body = clear($('m-body'));
  for (const node of bodyNodes) body.appendChild(node);
  setAck(false);
  $('m-ok').disabled = true;
  let left = 3;
  $('m-count').textContent = '请先勾选，' + left + ' 秒后可确认';
  modalTimer = setInterval(() => {
    left -= 1;
    $('m-ok').disabled = !canConfirm(left);
    $('m-count').textContent = left > 0 ? '请先勾选，' + left + ' 秒后可确认' : (isChecked($('m-ack')) ? '' : '还需要勾选上面的选项');
    if (left <= 0) {
      clearInterval(modalTimer);
      modalTimer = null;
    }
  }, 1000);
  $('m-ack').onclick = () => {
    setAck(!isChecked($('m-ack')));
    $('m-ok').disabled = !canConfirm(left);
    if (left <= 0 && !isChecked($('m-ack'))) $('m-count').textContent = '还需要勾选上面的选项';
    else if (left <= 0) $('m-count').textContent = '';
  };
  $('m-ok').onclick = async () => {
    const run = onOk;
    closeModal();
    try {
      await run();
    } catch (error) {
      $('hint').textContent = '';
      reportError(error);
    }
  };
  $('modal').showModal();
  $('m-ack').focus();
}
$('m-cancel').onclick = closeModal;
$('modal').oncancel = event => { event.preventDefault(); closeModal(); };
function isChecked(control) {
  return control.getAttribute('aria-checked') === 'true';
}
function setAck(checked) {
  const control = $('m-ack');
  control.setAttribute('aria-checked', String(checked));
  control.dataset.state = checked ? 'checked' : 'unchecked';
}
for (const control of document.querySelectorAll('[data-local-switch]')) {
  control.onclick = () => setTaskSwitch(control, !isChecked(control));
}

function accountDialog(title, message, value) {
  const dialog = $('account-dialog'), input = $('account-label-input');
  $('account-title').textContent = title;
  $('account-message').textContent = message;
  input.hidden = value === undefined;
  input.value = value ?? '';
  dialog.returnValue = '';
  dialog.showModal();
  if (!input.hidden) input.select();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value : null), { once: true });
  });
}

function bindGameAction(id, action) {
  const button = $(id);
  button.onclick = async () => {
    if (!current || button.disabled) return;
    button.disabled = true;
    try { await action(); }
    catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
}

// ---- 运行记录 --------------------------------------------------------------
const seen = new Set();
const logTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
let logAccount;
let onlyIssues = false;
let giftRedeemBatchId = null;
let giftRedeemRunning = false;
const giftRedeemResults = [];
let messageTab = 'world';
let messageStore = { world: [], notice: [], private: [], guild: [] };
let messageErrors = [];
const MESSAGE_TAB_LABELS = { world: '世界', notice: '通知', private: '私聊', guild: '联盟' };

/** Reflect whether the cross-account redemption batch is still accepting progress events. */
function renderGiftRedeemControls() {
  const button = $('batch-redeem-run');
  button.disabled = giftRedeemRunning;
  button.textContent = giftRedeemRunning ? '批量兑换中...' : '批量兑换';
}

/** Render only structured per-code outcomes so ordinary log rows remain compact. */
function renderGiftRedeemResults() {
  const box = clear($('batch-redeem-results'));
  if (!giftRedeemResults.length) {
    box.textContent = giftRedeemRunning ? '批次已启动，正在等待在线账号…' : '兑换后会在这里显示每个账号的结果。';
    return;
  }
  for (const result of giftRedeemResults) {
    const row = el('div', 'batch-redeem-result ' + result.status);
    row.appendChild(el('strong', null, result.accountTitle || '全部账号'));
    const detail = [result.code ? '兑换码 ' + result.code : null, result.rewards || result.reason || result.message]
      .filter(Boolean).join(' · ');
    row.appendChild(el('span', 'dim', detail));
    box.appendChild(row);
  }
}

/** Consume a server-emitted batch event after its normal log record has been displayed. */
function applyGiftRedeemEvent(entry) {
  const event = entry.extra?.batchRedeem;
  if (!event) return;
  if (event.phase === 'start') {
    giftRedeemBatchId = event.id;
    giftRedeemRunning = true;
    giftRedeemResults.length = 0;
    $('batch-redeem-hint').textContent = '正在处理在线账号…';
  } else if (event.id !== giftRedeemBatchId) {
    return;
  } else if (event.phase === 'summary') {
    giftRedeemRunning = false;
    $('batch-redeem-hint').textContent = entry.message.replace(/^批量兑换 · /, '');
    $('batch-redeem-summary').textContent = '成功 ' + (event.succeeded ?? 0) + ' · 失败 ' + (event.failed ?? 0) + ' · 离线 ' + (event.offline ?? 0);
  } else if (event.phase === 'result') {
    giftRedeemResults.push({ ...event, message: entry.message, status: event.status || event.phase });
  }
  renderGiftRedeemControls();
  renderGiftRedeemResults();
}

/** Submit the raw user text once; server-side parsing owns de-duplication and execution order. */
async function submitGiftCodeBatch(codes) {
  if (giftRedeemRunning) return;
  giftRedeemRunning = true;
  giftRedeemBatchId = null;
  giftRedeemResults.length = 0;
  $('batch-redeem-hint').textContent = '正在启动批次…';
  renderGiftRedeemControls();
  renderGiftRedeemResults();
  try {
    const data = await call('/api/gift-codes/redeem', { method: 'POST', body: JSON.stringify({ confirm: true, codes }) });
    if (giftRedeemBatchId !== data.batchId) {
      giftRedeemBatchId = data.batchId;
      giftRedeemRunning = true;
      $('batch-redeem-hint').textContent = '批次已启动，正在等待在线账号…';
      renderGiftRedeemControls();
      renderGiftRedeemResults();
    }
  } catch (error) {
    $('batch-redeem-hint').textContent = error.message;
    giftRedeemRunning = false;
    renderGiftRedeemControls();
  }
}

$('batch-redeem-run').onclick = () => {
  const codes = $('batch-redeem-codes').value;
  if (!codes.trim()) {
    $('batch-redeem-hint').textContent = '请先输入兑换码';
    return;
  }
  void submitGiftCodeBatch(codes);
};

/** Render the selected account-local message channel without querying the game server again. */
function renderMessages({ connected = snapshot.connected, errors = messageErrors } = {}) {
  const list = clear($('message-list'));
  const messages = messageStore[messageTab] || [];
  if (!messages.length) list.appendChild(el('div', 'message-empty', connected ? '暂时没有消息' : '未连接，暂无内存消息'));
  for (const message of messages) {
    const row = el('div', 'message-row');
    row.appendChild(el('span', 'ts', new Date(message.at).toLocaleTimeString('zh-CN', { hour12: false })));
    row.appendChild(el('span', 'sender', message.sender?.nickname || (message.kind === 'notice' ? '系统' : '未知')));
    row.appendChild(el('span', 'body', message.text || '（无文本消息）'));
    list.appendChild(row);
  }
  const parts = [connected ? '实时消息已连接' : (messages.length ? '已断开，显示内存消息' : '未连接')];
  if (errors.length) parts.push(errors.map(item => item.source + '：' + item.error).join('；'));
  $('messages-status').textContent = parts.join(' · ');
}

/** Load a safe JSON snapshot for the selected account; this endpoint never triggers a login. */
async function loadMessages() {
  const account = current;
  if (!account) return;
  const data = await call('/api/messages');
  if (account !== current) return;
  messageStore = {
    world: Array.isArray(data.messages?.world) ? data.messages.world : [],
    notice: Array.isArray(data.messages?.notice) ? data.messages.notice : [],
    private: Array.isArray(data.messages?.private) ? data.messages.private : [],
    guild: Array.isArray(data.messages?.guild) ? data.messages.guild : [],
  };
  messageErrors = data.errors || [];
  renderMessages(data);
}

/** Switch the visible channel while preserving all account-local message snapshots in memory. */
function selectMessageTab(kind) {
  messageTab = kind;
  document.querySelectorAll('#message-tabs button').forEach(button => button.classList.toggle('on', button.dataset.messageTab === kind));
  renderMessages();
}

/** Append a unique real-time message received through the current account's SSE stream. */
function appendMessageToPage(message) {
  const list = messageStore[message.kind];
  if (!list || list.some(entry => entry.id === message.id)) return;
  list.push(message);
  list.sort((left, right) => left.at - right.at);
  while (list.length > 100) list.shift();
  if (message.kind === messageTab) renderMessages();
}

document.querySelectorAll('#message-tabs button').forEach(button => {
  button.onclick = () => selectMessageTab(button.dataset.messageTab);
});
function updateLogSummary() {
  const issues = logEl.querySelectorAll('.error,.warn').length;
  const count = onlyIssues ? issues : logEl.childElementCount;
  $('log-toggle-count').hidden = !issues;
  $('log-toggle-count').textContent = String(issues);
  $('log-count').textContent = String(count);
  $('log-empty').hidden = count > 0;
  $('log-empty').textContent = onlyIssues ? '没有警告或错误' : '还没有运行记录';
}
function appendLog(entry) {
  applyGiftRedeemEvent(entry);
  if (entry.account && entry.account !== current) return;
  if (entry.id && seen.has(entry.id)) return;
  if (entry.id) seen.add(entry.id);
  const atEnd = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
  const batch = entry.extra?.batch;
  const last = logEl.lastElementChild;
  if (batch && last?.dataset.batch === batch && last.logIds.length < 32) {
    last.logIds.push(entry.id);
    const timestamp = logTime.format(entry.t);
    last.querySelector('time').textContent = timestamp;
    last.querySelector('.log-message').textContent = entry.extra.factory + '：连续安排生产' + entry.extra.product + '，共 ' + last.logIds.length + ' 次';
    last.querySelector('.log-details').hidden = false;
    last.querySelector('.log-detail-text').textContent += '\\n' + timestamp + ' ' + entry.message;
  } else {
    const row = el('div', 'row ' + entry.level);
    row.logIds = entry.id ? [entry.id] : [];
    if (batch) row.dataset.batch = batch;
    const timestamp = logTime.format(entry.t);
    row.appendChild(el('time', 'ts', timestamp));
    const body = el('div', 'log-body');
    const levelName = { error: '错误', warn: '提醒' }[entry.level];
    if (levelName) body.appendChild(el('span', 'log-level', levelName));
    body.appendChild(el('span', 'log-message', entry.message));
    if (entry.detail || batch) {
      const details = el('details', 'log-details');
      details.hidden = !entry.detail;
      details.append(el('summary', null, batch ? '查看逐次排产' : '查看详情'),
        el('div', 'log-detail-text', entry.detail || timestamp + ' ' + entry.message));
      body.appendChild(details);
    }
    row.appendChild(body);
    logEl.appendChild(row);
  }
  while (logEl.childElementCount > 400) {
    for (const id of logEl.firstChild.logIds) seen.delete(id);
    logEl.firstChild.remove();
  }
  updateLogSummary();
  if (atEnd) logEl.scrollTop = logEl.scrollHeight;
}
function logReport(message, detail) {
  appendLog({ t: Date.now(), level: 'info', message, detail });
}
function reportError(error, context) {
  if (error?.logged) return;
  const api = context?.startsWith('/api/');
  const action = api ? operationNames[context.split('?')[0]] || '控制台操作' : context;
  const raw = error?.message || String(error);
  const reason = raw === 'Failed to fetch' ? '无法连接本地控制台，请检查控制台是否仍在运行' : raw;
  appendLog({ t: Date.now(), level: 'error', message: (action ? action + '失败：' : '') + reason,
    detail: api ? context + ' · ' + raw : undefined });
  if (error instanceof Error) error.logged = true;
}
window.addEventListener('unhandledrejection', (event) => { reportError(event.reason); event.preventDefault(); });
for (const [id, filtered] of [['log-all', false], ['log-issues', true]]) {
  $(id).onclick = () => {
    onlyIssues = filtered;
    $('journal').classList.toggle('issues', filtered);
    $('log-all').setAttribute('aria-pressed', String(!filtered));
    $('log-issues').setAttribute('aria-pressed', String(filtered));
    updateLogSummary();
  };
}
// 宽屏日志占一栏并记住开合，窄屏是抽屉，默认收起以免挡住内容。
// Node-side page checks do not implement matchMedia, so treat them as the narrow layout instead of failing at script load.
const wideLog = (typeof matchMedia === 'function' ? matchMedia : () => ({ matches: false, addEventListener() {} }))('(min-width:1180px)');
function savedLogOpen() {
  try { return localStorage.getItem('journal:open') !== '0'; } catch { return true; }
}
function setLogOpen(open) {
  $('deck').classList.toggle('log-closed', !open);
  // The browser control always implements setAttribute; this guard keeps headless page checks on the same layout path.
  $('log-toggle').setAttribute?.('aria-expanded', String(open));
  if (open) logEl.scrollTop = logEl.scrollHeight;
}
function toggleLog(open) {
  setLogOpen(open);
  if (wideLog.matches) {
    try { localStorage.setItem('journal:open', open ? '1' : '0'); } catch {}
  }
  (open ? $('log-close') : $('log-toggle')).focus();
}
setLogOpen(wideLog.matches && savedLogOpen());
wideLog.addEventListener('change', event => setLogOpen(event.matches && savedLogOpen()));
$('log-toggle').onclick = () => toggleLog($('deck').classList.contains('log-closed'));
$('log-close').onclick = () => toggleLog(false);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || wideLog.matches || $('deck').classList.contains('log-closed') || document.querySelector('dialog[open]')) return;
  toggleLog(false);
});
function subscribe() {
  if (stream) stream.close();
  if (logAccount !== current) {
    seen.clear(); clear(logEl); updateLogSummary(); logAccount = current;
  }
  stream = new EventSource('/api/events' + (current ? '?account=' + encodeURIComponent(current) : ''));
  stream.onmessage = (event) => {
    const entry = JSON.parse(event.data);
    if (entry.kind === 'game-message') {
      if (entry.account === current && entry.message) appendMessageToPage(entry.message);
      return;
    }
    appendLog(entry);
    if (entry.extra?.pauseChanged && entry.account === current) void loadAccounts(false);
    if (entry.extra?.pirateUpdated && entry.account === current && !$('activity-pirates').closest('.hidden,[hidden]')) refreshActivities();
    if (entry.extra?.worldUpdated && entry.account === current && Date.now() - entry.t < 10_000) refreshManualWorld();
  };
}

// ---- 账号 ------------------------------------------------------------------
let snapshot = { connected: false, state: 'IDLE', busy: null, looping: false };
const disconnected = new Set();

function renderAccountSelect() {
  const box = clear($('account'));
  if (!accounts.length) {
    box.appendChild(new Option('没有账号', ''));
    box.disabled = true;
  } else {
    box.disabled = false;
    for (const account of accounts) {
      const option = new Option(account.title + (account.active ? '（当前）' : ''), account.id);
      box.appendChild(option);
    }
    box.value = current || '';
  }
  $('loot-run').disabled = claiming || !current || snapshot.paused;
  $('account-pause').disabled = !current;
  $('account-pause').textContent = snapshot.paused ? '恢复托管' : '暂停托管';
  $('account-pause').title = snapshot.paused ? '结束自行上号，允许控制台重新登录游戏' : '断开游戏连接，方便自行上号';
  $('busy').textContent = snapshot.paused ? '已暂停 · 可自行上号' : snapshot.connected ? '已连接' : '未连接';
  $('busy').dataset.state = snapshot.paused ? 'paused' : snapshot.connected ? 'on' : 'off';
  $('connect').disabled = snapshot.paused || snapshot.connected || !accounts.length;
  $('disconnect').disabled = !snapshot.connected;
  renderOverviewMeta();
}

async function loadAccounts(reload) {
  const data = await call('/api/accounts');
  const previous = current;
  accounts = data.accounts;
  if (!current && data.activeId) current = data.activeId;
  if (current && !accounts.some((a) => a.id === current)) current = data.activeId;
  snapshot = accounts.find(a => a.id === current)?.status ?? {};
  renderAccountSelect();
  if (previous !== current || reload) refreshProgression();
  if (previous !== current) refreshManualWorld();
  if (reload) {
    subscribe();
    loadMessages().catch(error => { $('messages-status').textContent = '消息加载失败：' + error.message; });
    refreshOverview();
  }
}

$('account').onchange = async () => {
  current = $('account').value;
  snapshot = accounts.find(a => a.id === current)?.status ?? {};
  renderAccountSelect();
  refreshProgression();
  refreshManualWorld();
  refreshActivities();
  refreshStages();
  refreshLoop();
  await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id: current }) });
  if (!$('tab-automation').classList.contains('hidden')) await loadAutomation();
  subscribe();
  await loadMessages();
  refreshOverview();
};

$('account-pause').onclick = async () => {
  const account = current;
  $('account-pause').disabled = true;
  try {
    const status = await call('/api/accounts/pause', { method: 'POST', body: JSON.stringify({ paused: !snapshot.paused }) });
    const row = accounts.find(a => a.id === account);
    if (row) row.status = status;
    if (current !== account) return;
    snapshot = status;
    if (!status.paused) disconnected.delete(account);
    renderAccountSelect();
    refreshProgression();
    refreshManualWorld();
    refreshOverview();
    refreshLoop();
    refreshActivities();
  } finally {
    if (current === account) $('account-pause').disabled = false;
  }
};

$('connect').onclick = async () => {
  $('hint').textContent = '正在连接 ...';
  try {
    await call('/api/connect', { method: 'POST' });
    disconnected.delete(current);
    refreshManualWorld();
    snapshot.connected = true;
    renderAccountSelect();
    refreshProgression();
    refreshOverview();
    refreshActivities();
    await loadMessages();
    $('hint').textContent = '';
  } catch (error) {
    $('hint').textContent = '';
    reportError(error);
  }
};
$('disconnect').onclick = async () => {
  const account = current;
  disconnected.add(account);
  refreshProgression();
  refreshManualWorld();
  refreshActivities();
  await call('/api/disconnect', { method: 'POST' });
  if (account !== current) return;
  snapshot.connected = false;
  renderAccountSelect();
};

// ---- 总览 ------------------------------------------------------------------
/** 将账户关键信息写成总览卡片，宽字段独占一行以避免挤压基础属性。 */
function statTile(box, label, value, wide) {
  const tile = el('div', wide ? 'item wide' : 'item');
  tile.appendChild(el('span', 'k', label));
  tile.appendChild(el('span', 'v', value));
  box.appendChild(tile);
}

/** 渲染当前账户的角色等级、战力、区服和挂机收益摘要。 */
function renderWho(view) {
  const box = clear($('who'));
  const role = view.player || {};
  const items = [
    ['角色', role.nickname || '-'],
    ['等级', role.level == null ? '-' : String(role.level)],
    ['战力', fmt(role.power)],
    ['区服', role.worldId == null ? '-' : String(role.worldId)],
  ];
  for (const [k, v] of items) statTile(box, k, v);
  if (view.afk) {
    const finish = view.afk.finishTime;
    const status = view.afk.capped ? '收益已满' : finish > 0 ? new Date(finish * 1000).toLocaleTimeString() + ' 满额' : '暂无计时';
    statTile(box, '闯关挂机收益', '等级 ' + (view.afk.level ?? '-') + ' · ' + status, true);
  }
}

/**
 * Renders labelled overview rows while keeping gateway-provided strings in
 * text nodes. Values may be factories when a row needs an interactive native
 * element such as the expandable trade-radar detail.
 */
function renderOverviewRows(id, rows) {
  const box = clear($(id));
  const lines = rows.filter((row) => row && row[1] !== undefined && row[1] !== null && row[1] !== '');
  if (!lines.length) {
    box.appendChild(el('span', 'dim', '暂无数据'));
    return;
  }
  const list = el('div', 'overview-lines');
  for (const [label, value] of lines) {
    const line = el('div', 'overview-line');
    line.appendChild(el('span', 'label', label));
    const content = typeof value === 'function' ? value() : el('span', 'value', String(value));
    if (typeof value === 'function') content.classList.add('value');
    line.appendChild(content);
    list.appendChild(line);
  }
  box.appendChild(list);
}

/** Builds an expandable, readable trade-radar list so city and goods IDs are not the only operator-facing data. */
function tradeRadarDisclosure(radar) {
  const details = el('details', 'trade-radar-disclosure');
  details.appendChild(el('summary', null, radar.length + ' 个城市'));
  const list = el('div', 'trade-radar-list');
  for (const entry of radar) {
    const row = el('div', 'trade-radar-row');
    row.appendChild(el('strong', null, (entry.cityName || '未知城市') + ' #' + (entry.cityId ?? '-')));
    const field = (label, name, id) => {
      const cell = el('div', 'trade-radar-field');
      cell.appendChild(el('small', null, label));
      cell.appendChild(document.createTextNode((name || '未知') + (id == null ? '' : ' #' + id)));
      return cell;
    };
    row.append(field('特产', entry.specGoodsName, entry.specGoodsId));
    row.append(field('紧缺', entry.rareGoodsName, entry.rareGoodsId));
    row.append(field('共享人', entry.reportName, null));
    list.appendChild(row);
  }
  if (!radar.length) list.appendChild(el('span', 'dim', '暂无商情明细'));
  details.appendChild(list);
  return details;
}

/** Renders Sea Merchant data only while the server confirms that its current period is open. */
function renderOverviewTrade(data) {
  const card = $('overview-trade');
  const trade = data.trade || {};
  // A non-positive period means the event is closed, so old voyage data must not remain visible after a refresh.
  const tradeOpen = Number(trade.period) > 0;
  card.hidden = !tradeOpen;
  if (!tradeOpen) {
    clear(card);
    return;
  }
  const player = trade.player || {};
  const cargo = trade.cargo || {};
  const moving = cargo.moveEndTime && cargo.moveEndTime > Date.now() / 1000;
  const goods = (player.goods || []).filter((item) => (item.num ?? 0) > 0);
  renderOverviewRows('overview-trade', [
    ['开放状态', '已开放，第 ' + trade.period + ' 期'],
    ['贸易船', '等级 ' + (cargo.cargoLv ?? '-') + '，' + (moving ? '航行中' : '已停靠')],
    ['航线', cargo.cityId ? String(cargo.cityId) + ' → ' + (cargo.moveToCityId || '-') : null],
    ['到港时间', moving ? when(cargo.moveEndTime * 1000) : '当前已到港'],
    ['贸易金币', fmt(player.coins ?? 0) + ' / ' + fmt(player.maxCoins ?? 0)],
    ['累计利润', fmt(player.profit ?? 0)],
    ['船舱货物', goods.length ? goods.map((item) => '货物' + item.goodsId + ' ×' + item.num).join('；') : '空'],
    ['联盟商情', () => tradeRadarDisclosure(data.tradeRadar || [])],
  ]);
}

/** Renders the current ten-thousand-ton ship reward availability and the player's occupation rank. */
function renderOverviewMerchantShip(data) {
  const merchant = data.merchantShip || {};
  const rewards = (merchant.reward || []).map((asset) => (asset.name || asset.id || '未知奖励') + ' ×' + (asset.num ?? 0));
  renderOverviewRows('overview-merchant-ship', [
    ['今日剩余领奖次数', merchant.remainingRewardTimes == null ? null : String(merchant.remainingRewardTimes) + ' 次'],
    ['状态', merchant.uid == null ? '当前不存在万吨货轮' : '已出现'],
    ['当前奖品', merchant.uid == null ? null : (rewards.join('、') || '暂无奖品')],
    ['当前占有排名', merchant.uid == null ? null : (merchant.rank == null ? '暂未上榜' : '第 ' + merchant.rank + ' 名')],
  ]);
}

/** Renders every farm crop and factory queue item so operators can distinguish an empty queue from a finished product. */
function renderOverviewProduction(data) {
  const box = clear($('overview-production'));
  const production = data.production || {};
  const farms = production.farms || [];
  const factories = production.factories || [];
  if (!farms.length && !factories.length) {
    box.appendChild(el('span', 'dim', '暂无农田或工厂数据'));
    return;
  }
  const grid = el('div', 'overview-production');
  const farmPane = el('div', 'overview-table');
  farmPane.appendChild(el('h4', null, '农田（' + farms.length + ' 块）'));
  farmPane.appendChild(table(['农田', '作物', '状态'], farms.map((farm) => {
    const ripe = farm.productId && farm.ripeTime && farm.ripeTime <= Date.now() / 1000;
    const status = !farm.productId ? chip('paid', '空闲') : ripe ? chip('done', '已成熟')
      : chip('ready', farm.ripeTime ? '生长至 ' + when(farm.ripeTime * 1000) : '种植中');
    return [farm.buildingId, farm.productId ? { cells: [{ name: farm.productId, icon: farm.icon }] } : '未种植', status];
  })));
  grid.appendChild(farmPane);
  const factoryPane = el('div', 'overview-table');
  factoryPane.appendChild(el('h4', null, '工厂（' + factories.length + ' 座）'));
  factoryPane.appendChild(table(['工厂', '产品', '状态 / 完成时间'], factories.map((factory) => {
    const queue = factory.queue || [];
    const products = queue.length ? queue.map((job) => ({ name: job.productId, icon: job.icon }))
      : factory.autoProductId ? [{ name: '自动：' + factory.autoProductId, icon: factory.autoIcon }] : [];
    const finish = queue.filter((job) => job.finishTime).map((job) => when(job.finishTime * 1000)).join('、');
    const status = queue.length ? chip('ready', '生产中 ' + queue.length + ' 项')
      : factory.autoProductId ? chip('ready', '自动生产')
        : factory.finished?.length ? chip('paid', '待领取 ' + factory.finished.length + ' 项') : chip('paid', '空闲');
    return [factory.buildingId, products.length ? { cells: products } : '无排产', finish ? '生产中至 ' + finish : status];
  })));
  grid.appendChild(factoryPane);
  box.appendChild(grid);
}

/** Renders basic account data together with cache-backed inventory, commerce and production panels. */
function renderOverview(data) {
  renderWho(data);
  const res = clear($('res'));
  for (const entry of data.resources || []) res.appendChild(cell(entry.icon, 34, entry.name, fmt(entry.amount), false));
  if (!res.childElementCount) res.appendChild(el('span', 'dim', '暂无数据'));

  const items = clear($('items'));
  for (const entry of (data.items && data.items.top) || []) items.appendChild(cell(entry.icon, 34, entry.name, 'x' + fmt(entry.num)));
  if (!items.childElementCount) items.appendChild(el('span', 'dim', '暂无数据'));

  const materials = clear($('materials'));
  // Dynamic capacity comes from the latest game effect; fixed initial limits would mislead when the warehouse was upgraded.
  for (const entry of data.materials || []) materials.appendChild(cell(entry.icon, 34, entry.itemId, fmt(entry.num) + ' / ' + (entry.capacity == null ? '-' : fmt(entry.capacity))));
  if (!materials.childElementCount) materials.appendChild(el('span', 'dim', '暂无原材料数据'));

  const crops = clear($('crops'));
  for (const entry of data.crops || []) {
    const node = cell(entry.icon, 34, entry.itemId, fmt(entry.num) + ' / ' + (entry.capacity == null ? '-' : fmt(entry.capacity)));
    // A configured positive reserve signals that the farm module should refill this crop, so show an actionable low-stock state.
    if (Number(entry.plantTarget) > 0 && Number(entry.num) < Number(entry.plantTarget)) node.classList.add('crop-low-stock');
    crops.appendChild(node);
  }
  if (!crops.childElementCount) crops.appendChild(el('span', 'dim', '暂无农作物数据'));

  const heroes = clear($('hero-strip'));
  for (const hero of (data.heroes && data.heroes.list) || []) {
    heroes.appendChild(cell(hero.icon, 40, hero.heroId, 'lv' + hero.level + ' · ' + hero.star + '星'));
  }
  if (!heroes.childElementCount) heroes.appendChild(el('span', 'dim', '暂无数据'));
  renderOverviewTrade(data);
  renderOverviewMerchantShip(data);
  renderOverviewProduction(data);
}

let overviewPending = false;
let claiming = false;
let overviewAt = 0, overviewAccount = null, overviewFailed = false;
function renderOverviewMeta() {
  const live = current && !snapshot.paused && !disconnected.has(current);
  const time = overviewAccount === current && overviewAt ? logTime.format(overviewAt) : '';
  $('overview-refresh').disabled = !live;
  $('overview-updated').textContent = !time ? ''
    : !live ? '未连接，以下是 ' + time + ' 的数据'
    : overviewFailed ? '刷新失败，以下是 ' + time + ' 的数据'
    : '更新于 ' + time + '，每 20 秒自动刷新';
}
async function refreshOverview() {
  if (!$('tab-overview').classList.contains('hidden')) refreshIncome();
  if (overviewPending || claiming || !current || snapshot.paused || disconnected.has(current) || document.hidden || $('tab-overview').classList.contains('hidden')) return;
  const account = current;
  overviewPending = true;
  try {
    const data = await call('/api/overview');
    if (account !== current || snapshot.paused || disconnected.has(account)) return;
    snapshot = data.status;
    renderAccountSelect();
    renderOverview(data);
    overviewAt = Date.now();
    overviewAccount = account;
    overviewFailed = false;
    renderOverviewMeta();
    $('hint').textContent = '';
  } catch (error) {
    overviewFailed = true;
    if (account === current) renderOverviewMeta();
    reportError(error, '刷新总览');
  } finally { overviewPending = false; }
}

$('overview-refresh').onclick = () => refreshOverview();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOverview(); });

$('loot-run').onclick = async () => {
  const account = current;
  if (!account || claiming) return;
  claiming = true;
  $('loot-run').disabled = true;
  $('loot-hint').textContent = '领取中…';
  try {
    await call('/api/loot/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  } finally {
    claiming = false;
    $('loot-hint').textContent = '';
    $('loot-run').disabled = !current;
  }
};

// ---- 挂机 ------------------------------------------------------------------
const HERO_STATUS = { ready: '可做', done: '已完成', blocked: '不可做' };

let stageVersion = 0;
let stageAccount = null;
function stagePreferences() {
  return { maxFailures: Number($('stage-failures').value) };
}
function renderStages(data) {
  $('stage-start').disabled = data.running || !current;
  $('stage-stop').disabled = !data.running || data.stopping;
  $('stage-failures').disabled = data.running;
  if (data.running) {
    $('stage-failures').value = data.maxFailures;
  }
  const details = data.stage ? '第 ' + data.stage + ' 关 · 已通过 ' + data.wins + ' 关 · 连续失败 ' + data.failures + ' 次' : '';
  $('stage-view').textContent = [data.stopping ? '正在停止，等待在途战报' : data.running ? '推关中' : '未在推关', details, data.reason].filter(Boolean).join('　');
}
async function refreshStages() {
  if ($('tab-stages').classList.contains('hidden')) return;
  const version = ++stageVersion;
  const account = current;
  if (stageAccount !== account) {
    stageAccount = account;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('stages:' + account)) || {}; } catch {}
    $('stage-failures').value = saved.maxFailures || 3;
    $('stage-start').disabled = $('stage-stop').disabled = true;
    $('stage-view').textContent = '正在读取状态';
  }
  if (!account) { $('stage-view').textContent = '请先选择账号'; return; }
  try {
    const data = await call('/api/stages');
    if (current === account && stageVersion === version) renderStages(data);
  } catch (error) {
    if (current === account && stageVersion === version) { reportError(error); }
  }
}
async function stageCommand(start) {
  const account = current;
  const prefs = stagePreferences();
  if (start && (!Number.isSafeInteger(prefs.maxFailures) || prefs.maxFailures < 1)) {
    reportError(new Error('失败次数需要填写正整数'), '主线推关');
    return;
  }
  ++stageVersion;
  $('stage-start').disabled = $('stage-stop').disabled = true;
  try {
    const data = await call('/api/stages/' + (start ? 'start' : 'stop'), {
      method: 'POST', body: JSON.stringify({ confirm: true, ...prefs }),
    });
    if (start) {
      try { localStorage.setItem('stages:' + account, JSON.stringify(prefs)); } catch {}
    }
    if (account === current) renderStages(data);
  } catch (error) {
    if (account === current) { reportError(error); }
  } finally { refreshStages(); }
}
$('stage-start').onclick = () => stageCommand(true);
$('stage-stop').onclick = () => stageCommand(false);

let loopVersion = 0;
let loopAccount = null;
const savingTasks = new Set();
const savingReserve = new Set();
let reserveEdited = false;
const reserveInput = $('fishing-reserve'), reserveSave = $('fishing-reserve-save');
const taskInputs = [...document.querySelectorAll('[data-auto-task]')];
function setTaskSwitch(input, enabled) {
  input.setAttribute('aria-checked', String(enabled));
  input.dataset.state = enabled ? 'checked' : 'unchecked';
  input.querySelector('[data-slot=switch-thumb]').dataset.state = input.dataset.state;
}
function renderLoop(data) {
  if (loopAccount !== current) reserveEdited = false;
  if (!reserveEdited) reserveInput.value = data.fishingGoldReserve;
  reserveInput.disabled = savingReserve.has(current);
  reserveSave.disabled = reserveInput.disabled || !reserveEdited;
  for (const input of taskInputs) {
    if (savingTasks.has(current + ':' + input.dataset.autoTask)) continue;
    const task = data.tasks.find(t => t.key === input.dataset.autoTask);
    setTaskSwitch(input, task?.enabled === true);
    const hint = $('next-' + input.dataset.autoTask);
    hint.textContent = task?.nextCheck ? '下次检查 ' + new Date(task.nextCheck * 1000).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }) + '（北京时间）' : '';
    input.disabled = false;
  }
  if (loopAccount !== current || data.running) {
    $('loop-every').value = data.everyMs / 1000;
    $('loop-rounds').value = data.rounds;
  }
  loopAccount = current;
  $('loop-every').disabled = $('loop-rounds').disabled = data.running;
  $('loop-start').disabled = data.running;
  $('loop-stop').disabled = !data.running || data.stopping;
  renderReconnect(data);
  $('loop-hint').textContent = (data.running ? '挂机中，已完成 ' : '未在挂机，累计 ') + data.completed + ' 轮' + (data.error ? '，已中止' : '');
  if (data.stopping) $('loop-hint').textContent = '正在暂停，等待在途请求结束';
  if (data.recovery?.nextAt) $('loop-hint').textContent = '连接中断，' + logTime.format(data.recovery.nextAt) + ' 第 ' + data.recovery.attempts + ' 次自动重连';
}

async function refreshLoop() {
  const account = current, version = ++loopVersion;
  if ($('tab-idle').classList.contains('hidden')) return;
  if (loopAccount !== account || !account) {
    $('loop-hint').textContent = account ? '正在读取设置' : '请选择账号';
    for (const input of taskInputs) {
      input.disabled = true;
      setTaskSwitch(input, false);
      $('next-' + input.dataset.autoTask).textContent = '';
    }
    reserveInput.disabled = reserveSave.disabled = true;
    reserveInput.value = '';
    reserveEdited = false;
    $('loop-start').disabled = $('loop-stop').disabled = true;
  }
  if (!account) return;
  try {
    const data = await call('/api/loop');
    if (account === current && version === loopVersion) renderLoop(data);
  } catch {
    /* call 已记录错误 */
  }
}

async function toggleAutoTask(input) {
  const account = current, key = input.dataset.autoTask, saving = account + ':' + key;
  if (!account || input.disabled || savingTasks.has(saving)) return;
  const enabled = input.getAttribute('aria-checked') !== 'true';
  setTaskSwitch(input, enabled);
  savingTasks.add(saving);
  activityTaskEdits.set(saving, { enabled, pending: true, version: activitiesVersion });
  syncActivityTask(key, enabled, account);
  input.disabled = true;
  ++loopVersion;
  try {
    await call('/api/loop/task', { method: 'POST', body: JSON.stringify({ confirm: true, key, enabled }) });
  } catch (error) {
    setTaskSwitch(input, !enabled);
    syncActivityTask(key, !enabled, account);
    reportError(error);
  }
  finally {
    savingTasks.delete(saving);
    const saved = input.getAttribute('aria-checked') === 'true';
    activityTaskEdits.set(saving, { enabled: saved, pending: false, version: activitiesVersion });
    syncActivityTask(key, saved, account);
    if (account === current) {
      if (input.dataset.eventTask) {
        for (const toggle of document.querySelectorAll('[data-event-task]')) {
          if (toggle.dataset.autoTask !== key) continue;
          setTaskSwitch(toggle, input.getAttribute('aria-checked') === 'true');
          toggle.disabled = false;
        }
      }
      else refreshLoop();
    }
  }
}
for (const input of taskInputs) input.onclick = () => toggleAutoTask(input);

reserveInput.oninput = () => {
  reserveEdited = true;
  reserveSave.disabled = false;
};
$('fishing-reserve-form').onsubmit = async event => {
  event.preventDefault();
  const account = current;
  if (!account || account !== loopAccount || savingReserve.has(account)) return;
  const value = reserveInput.valueAsNumber;
  if (!Number.isSafeInteger(value) || value < 0) {
    reportError(new Error('预留金币必须是非负整数'), '设置钓具预留金币');
    return;
  }
  ++loopVersion;
  savingReserve.add(account);
  reserveInput.disabled = reserveSave.disabled = true;
  try {
    await call('/api/loop/fishing-reserve', { method: 'POST', body: JSON.stringify({ fishingGoldReserve: value }) });
    if (account === current) reserveEdited = false;
  } catch (error) { if (account === current) reportError(error); }
  finally {
    savingReserve.delete(account);
    if (account === current) refreshLoop();
  }
};

$('loop-start').onclick = async () => {
  try {
    await call('/api/loop/start', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        rounds: Number($('loop-rounds').value || 0),
        everySeconds: Number($('loop-every').value || 60),
      }),
    });
    refreshLoop();
  } catch (error) {
    $('loop-hint').textContent = '';
    reportError(error);
  }
};
$('loop-stop').onclick = async () => {
  try {
    await call('/api/loop/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    refreshLoop();
  } catch (error) {
    $('loop-hint').textContent = '';
    reportError(error);
  }
};

$('tasks-plan').onclick = async () => {
  $('tasks-hint').textContent = '检查中 ...';
  try {
    const data = await call('/api/tasks');
    $('tasks-hint').textContent = '';
    logReport('任务奖励：可领 ' + data.plan.length + ' 条', data.text);
  } catch (error) {
    $('tasks-hint').textContent = '';
    reportError(error);
  }
};
bindGameAction('tasks-run', async () => {
  const account = current;
  const data = await call('/api/tasks/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  if (current === account) logReport('任务奖励：本轮成功领取 ' + data.results.filter((r) => r.ok).length + ' 项', data.text);
});

function orderState(order, data) {
  const box = el('div', 'order-state');
  const decision = order.decision;
  const labels = { ready: data.idleRunning ? '等待自动交付' : '等待开启挂机', disabled: '自动交付已关闭', refreshing: '订单刷新中',
    unknown: '等待核对', missing: '材料不足', reserved: '材料已预留', reroll: '等待换单' };
  const state = decision?.status ?? 'unknown';
  const label = !data.autoDeliverOrders && state !== 'reroll' ? labels.disabled : labels[state] || labels.unknown;
  box.appendChild(chip(state === 'ready' && data.idleRunning && data.autoDeliverOrders ? 'ready' : 'waiting', label));
  if (decision?.reason) box.appendChild(el('span', 'dim', decision.reason));
  return box;
}

const pendingResidentOrders = new Set();
function residentOrderButton(order) {
  const account = current, key = account + ':' + order.index;
  const pending = pendingResidentOrders.has(key);
  const button = smallButton(pending ? '提交中…' : '提交订单');
  button.dataset.residentOrder = String(order.index);
  const ready = Boolean(order.orderKey) && order.manualDecision?.status === 'ready';
  button.disabled = pending || !ready || !account || snapshot.paused || disconnected.has(account);
  button.title = pending ? '账号忙时自动排队，结果见运行日志'
    : ready ? '提交这份居民订单' : order.manualDecision?.reason || '请先刷新订单状态';
  button.setAttribute('aria-label', '提交' + (order.workerName || '居民') + '的订单 #' + order.index);
  button.onclick = async () => {
    if (button.disabled || pendingResidentOrders.has(key) || current !== account || snapshot.paused || disconnected.has(account)) return;
    pendingResidentOrders.add(key);
    button.disabled = true;
    button.textContent = '提交中…';
    try {
      await call('/api/world/order/submit', { method: 'POST', body: JSON.stringify({ confirm: true, index: order.index, orderKey: order.orderKey }) });
    } catch (error) {
      if (current === account) reportError(error, '提交居民订单');
    } finally {
      pendingResidentOrders.delete(key);
      if (current === account) {
        const displayed = $('world-orders').querySelector('[data-resident-order="' + order.index + '"]');
        if (displayed) {
          displayed.disabled = true;
          displayed.textContent = '待刷新';
        }
        refreshManualWorld(true);
      }
    }
  };
  return button;
}

function renderWorldPlan(actions) {
  const box = clear($('world-view'));
  if (!actions?.length) {
    box.appendChild(el('span', 'dim', '现在没有可执行的动作'));
    return;
  }
  box.appendChild(el('strong', null, '点「执行一轮」会做这些'));
  const list = el('ul');
  for (const action of actions) list.appendChild(el('li', null, action.label));
  box.appendChild(list);
}

function renderWorld(data) {
  const summary = clear($('world-summary'));
  statTile(summary, '人口', data.population + (data.futurePopulation ? ' → ' + data.futurePopulation : ''));
  statTile(summary, '库存', data.stock.length + ' 种');
  statTile(summary, '工厂', data.factories.length + ' 栋');
  statTile(summary, '居民订单', data.orders.length + ' 条');
  statTile(summary, '资源田', (data.resFields.fields?.length ?? 0) + '/' + (data.resFields.maxNum ?? '?'));
  renderWorldPlan(data.plan);
  const fbox = clear($('world-factories'));
  if (data.farms?.length) {
    fbox.appendChild(el('h2', null, '农田'));
    const plots = el('div', 'icons');
    for (const farm of data.farms) plots.appendChild(cell(null, 0, farm.plot.replace(/^([0-9]+)农田$/, '$1 号农田'), farm.status, false));
    fbox.appendChild(plots);
  }
  // 空位：没盖的（待建）与正在盖的（施工中）。计划器只会建「待建」那些，
  // 施工中的只能等它盖完由竣工步骤收尾，所以两种状态要分开说，不然看不出差在哪。
  const slots = (data.buildings || []).filter((b) => b.level === 0);
  if (slots.length) {
    fbox.appendChild(el('h2', null, '空位'));
    fbox.appendChild(table(['空位', '类型', '状态'], slots.map((b) => [
      { cell: b.icon, text: b.buildingId },
      b.typeName || b.type || '未知类型',
      b.building ? chip('waiting', '施工中') : b.awaitingFinish ? chip('ready', '待竣工') : chip('ready', '待建'),
    ])));
  }
  if (data.factories.length) {
    fbox.appendChild(el('h2', null, '工厂'));
    fbox.appendChild(table(['建筑', '类型', '等级', '队列', '自动生产'], data.factories.map((b) => [
      { cell: b.icon, text: b.buildingId },
      b.typeName || b.type,
      'lv' + b.level,
      String(b.queue),
      b.auto || '未设置',
    ])));
  }
  const obox = clear($('world-orders'));
  if (data.orders.length) {
    obox.appendChild(el('h2', null, '居民订单'));
    obox.appendChild(el('p', 'dim', '可手动提交材料已齐的订单。账号忙时自动排队，交付结果见运行日志。'));
    obox.appendChild(table(['订单', '居民', '需求', '挂机交付', '手动交付'], data.orders.map((o) => [
      '#' + o.index,
      { cell: o.workerIcon, text: (o.workerName || '未知居民') + (o.isSpecial ? '（特殊）' : '') },
      o.requirements.length && o.decision?.status !== 'refreshing' ? { cells: o.requirements } : '—',
      orderState(o, data),
      residentOrderButton(o),
    ])));
  }
  const sbox = clear($('world-stock'));
  for (const entry of data.stock) sbox.appendChild(cell(entry.icon, 30, entry.name, fmt(entry.num)));
  if (!sbox.childElementCount) sbox.appendChild(el('span', 'dim', '仓库空'));
  $('world-fields').textContent = data.resFields.text || '';
}

let worldVersion = 0, worldRead = null, displayedWorldAccount;
function refreshManualWorld(force = false) {
  if (force) { worldVersion++; worldRead = null; }
  if ($('tab-manual').classList.contains('hidden')) return;
  const account = current;
  const available = account && !snapshot.paused && !disconnected.has(account);
  if (displayedWorldAccount !== account || !available) {
    displayedWorldAccount = account;
    worldVersion++;
    worldRead = null;
    for (const id of ['world-summary', 'world-factories', 'world-orders', 'world-stock', 'world-fields', 'world-hint']) clear($(id));
    $('world-view').textContent = !account ? '请先选择账号' : !available ? '账号已断开连接' : '正在读取海面数据…';
  }
  if (!available || worldRead?.account === account) return;
  const version = ++worldVersion;
  worldRead = { account, version };
  $('world-hint').textContent = '正在读取…';
  call('/api/world').then(data => {
    if (version === worldVersion && current === account) renderWorld(data);
  }).catch(error => {
    if (version === worldVersion && current === account) {
      $('world-view').textContent = '海面数据读取失败，可点「刷新数据」重试。';
      reportError(error);
    }
  }).finally(() => {
    if (worldRead?.version === version) worldRead = null;
    if (version === worldVersion) $('world-hint').textContent = '';
  });
}
$('world-plan').onclick = () => refreshManualWorld();
bindGameAction('world-run', async () => {
  const account = current;
  $('world-hint').textContent = '执行中 ...';
  try {
    const body = { confirm: true, speedUp: isChecked($('world-speedup')), reroll: isChecked($('world-reroll')) };
    const data = await call('/api/world/run', { method: 'POST', body: JSON.stringify(body) });
    if (account !== current || disconnected.has(account)) return;
    worldVersion++;
    $('world-hint').textContent = '';
    logReport('海面：执行 ' + data.results.length + ' 个动作，失败 ' + data.results.filter((r) => r.ok === false).length + ' 个');
    if (!data.refreshError) renderWorld(data);
  } catch (error) {
    $('world-hint').textContent = '';
    reportError(error);
  }
});

// ---- 英雄 ------------------------------------------------------------------
function renderAppointments(data) {
  const box = clear($('appoint-table'));
  box.appendChild(el('div', 'dim', '已任命 ' + data.occupied + '/' + data.slots.length + ' 个开放职位'));
  if (data.slots.length) box.appendChild(table(['职位', '效果', '英雄'], data.slots.map(slot => [String(slot.id), slot.effect, slot.hero || '空缺'])));
}
bindGameAction('appoint-view', async () => {
  const account = current;
  const result = await call('/api/appointments');
  if (account === current) renderAppointments(result);
});
bindGameAction('appoint-run', async () => {
  const account = current;
  const result = await call('/api/appointments/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  if (account === current) renderAppointments(result);
});
// 技能是一串等级，原始形状是 [1,0,0,0]，直接摆给用户看没意义，只说练了几项。
function skillText(levels) {
  const list = levels || [];
  if (!list.length) return '—';
  const raised = list.filter((level) => level > 0);
  return raised.length ? '已升 ' + raised.length + '/' + list.length : '未升级';
}

function renderHeroes(data) {
  const box = clear($('hero-table'));
  const planned = new Set(data.steps.map(step => step.heroId));
  if (!planned.size) return;
  box.appendChild(table(['英雄', '等级', '星级', { label: '战力', num: true }, '技能'], data.heroes.filter(hero => planned.has(hero.heroId)).map((hero) => [
    { cell: hero.head || hero.icon, text: hero.heroId },
    'lv' + hero.level,
    hero.star + ' 星',
    { num: true, text: fmt(hero.power) },
    skillText(hero.skillLevels),
  ])));
}

$('hero-plan').onclick = async () => {
  $('hero-hint').textContent = '计算中 ...';
  try {
    const data = await call('/api/heroes');
    renderHeroes(data);
    $('hero-hint').textContent = '';
    logReport('英雄养成计划：' + data.steps.length + ' 步', data.text);
  } catch (error) {
    $('hero-hint').textContent = '';
    reportError(error);
  }
};
bindGameAction('hero-run', async () => {
  $('hero-hint').textContent = '执行中 ...';
  try {
    const data = await call('/api/heroes/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    $('hero-hint').textContent = '';
    logReport('英雄养成：发出 ' + data.sent + ' 个请求，失败 ' + data.failed + '，跳过 ' + data.skipped + '，耗时 ' + Math.round(data.ms / 1000) + ' 秒');
    renderHeroes(await call('/api/heroes'));
  } catch (error) {
    $('hero-hint').textContent = '';
    reportError(error);
  }
});

// ---- 日常 ------------------------------------------------------------------
const DAILY_LABEL = { ready: '可做', paid: '需付费', partial: '部分可做', waiting: '等待中', done: '已完成', blocked: '不可用', error: '出错', unknown: '未知' };

function renderDailies(data) {
  const box = clear($('dailies-table'));
  box.appendChild(table(['任务', '进度', '状态', '动作 / 原因'], data.tasks.map((entry) => [
    entry.task.title,
    entry.task.progress + '/' + entry.task.targetProgress,
    chip(entry.status, DAILY_LABEL[entry.status] || entry.status),
    entry.status === 'ready' || entry.status === 'paid'
      ? (entry.actions || []).map((a) => a.cost || a.request).join('；') || '直接完成'
      : (entry.reason || ''),
  ])));
  if (data.chests) {
    const line = (label, chest) => {
      const tiers = chest.tiers || [];
      const tail = tiers.length
        ? '第 ' + tiers.map((t2) => t2.id).join(' / ') + ' 档'
        : (chest.nextAt == null ? '这一季的档位都领完了' : '下一档要 ' + chest.nextAt + ' 点活跃');
      return [label, chest.activity + ' 活跃', chip(tiers.length ? 'ready' : 'done', tiers.length ? '可领' : '不欠'), tail];
    };
    box.appendChild(table(['活跃奖励', '活跃度', '状态', '动作 / 原因'], [
      line('每日宝箱', data.chests.daily),
      line('每周宝箱', data.chests.weekly),
    ]));
  }
  if (data.gift) {
    const free = data.gift.freeAvailable;
    box.appendChild(table(['每日礼包', '状态', '动作 / 原因'], [
      ['每日精选赠礼', chip(free ? 'ready' : 'done', free ? '可领' : '已领'),
        free ? '免费，一键领取会顺手领掉' : '今天那份已经领过了，明天 0 点重置'],
    ]));
  }
}

$('dailies-plan').onclick = async () => {
  $('dailies-hint').textContent = '探测中 ...';
  try {
    const data = await call('/api/dailies');
    renderDailies(data);
    $('dailies-hint').textContent = '';
    logReport('每日任务探测：钻石 ' + fmt(data.ruby), data.text);
  } catch (error) {
    $('dailies-hint').textContent = '';
    reportError(error);
  }
};
bindGameAction('dailies-run', async () => {
  const paid = isChecked($('dailies-paid'));
  $('dailies-hint').textContent = '执行中 ...';
  try {
    const data = await call('/api/dailies/run', { method: 'POST', body: JSON.stringify({ confirm: true, paid }) });
    $('dailies-hint').textContent = '';
    logReport('每日任务：完成 ' + data.results.filter((r) => r.ok).length + ' 个动作，失败 ' + data.results.filter((r) => r.ok === false).length + ' 个，领取奖励 ' + data.claimed.length + ' 个，耗时 ' + Math.round(data.ms / 1000) + ' 秒');
    renderDailies(data);
  } catch (error) {
    $('dailies-hint').textContent = '';
    reportError(error);
  }
});

// ---- 表格 ------------------------------------------------------------------
// 单元格可以是字符串、{num}、{chip}、{cell: 图标项}、{cells: [图标项]}
function putCell(td, spec) {
  if (spec == null) return;
  if (spec instanceof Node) {
    td.appendChild(spec);
    return;
  }
  if (typeof spec !== 'object') {
    td.textContent = spec;
    return;
  }
  if (spec.num) {
    td.classList.add('num');
    td.textContent = spec.text;
    return;
  }
  if (spec.chip) {
    td.appendChild(chip(spec.chip, spec.text));
    return;
  }
  if ('cell' in spec || spec.cells) {
    const list = spec.cells ?? [{ name: spec.text, icon: spec.cell }];
    if (spec.prefix) td.appendChild(el('span', 'dim', spec.prefix));
    for (const entry of list) {
      const who = el('span', 'who-cell');
      if (entry?.icon) who.appendChild(iconEl(entry.icon, 26, entry.name));
      who.appendChild(el('span', null, entry ? entry.name + (entry.num != null ? ' x' + fmt(entry.num) : '') : spec.text));
      td.appendChild(who);
      td.appendChild(document.createTextNode(' '));
    }
    if (!list.length) td.appendChild(el('span', 'dim', '齐'));
    return;
  }
  td.textContent = spec.text || '';
}

function table(headers, rows) {
  const box = component('ui-table');
  const head = box.querySelector('thead tr');
  const headCell = head.firstElementChild;
  headCell.remove();
  for (const h of headers) {
    const th = headCell.cloneNode(false);
    th.textContent = typeof h === 'string' ? h : h.label;
    if (h.num) th.classList.add('num');
    head.appendChild(th);
  }
  const body = box.querySelector('tbody');
  const rowTemplate = body.firstElementChild;
  const cellTemplate = rowTemplate.firstElementChild;
  rowTemplate.remove();
  for (const row of rows) {
    const tr = rowTemplate.cloneNode(false);
    for (const spec of row) {
      const td = cellTemplate.cloneNode(false);
      putCell(td, spec);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  return box;
}

// ---- 账号页 ----------------------------------------------------------------
async function exportAccounts(id) {
  try {
    const response = await fetch('/api/accounts/export', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(id ? { id } : { all: true }) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '账号导出失败');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = (id ? 'account-' : 'accounts-') + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { reportError(error); }
}
$('export-accounts').onclick = () => exportAccounts();
async function renderAccounts() {
  $('export-accounts').disabled = !accounts.length;
  const box = clear($('accounts'));
  if (!accounts.length) {
    box.appendChild(el('div', 'dim', '还没有账号。先在下面用「从电脑微信添加」，或跑 node tools/capture-credentials.mjs。'));
    return;
  }
  for (const account of accounts) {
    const card = el('div', 'acct' + (account.id === current ? ' on' : ''));
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', account.title));
    top.appendChild(el('span', 'id', account.id.slice(0, 10) + '…'));
    if (account.id === current) top.appendChild(chip('done', '当前'));
    const seenInfo = account.lastSeen
      ? '上次 ' + (account.lastSeen.nickname || '?') + ' lv' + (account.lastSeen.level ?? '?') + ' 战力' + fmt(account.lastSeen.power) + ' @' + when(account.lastSeen.at)
      : '还没连过';
    top.appendChild(el('span', 'id', seenInfo));
    const use = smallButton(account.id === current ? '已选中' : '切换到它');
    use.disabled = account.id === current;
    use.onclick = async () => {
      current = account.id;
      await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id }) });
      await loadAccounts(true);
      renderAccounts();
    };
    const rename = smallButton('改备注');
    rename.onclick = async () => {
      const label = await accountDialog('修改账号备注', account.title, account.title);
      if (label == null) return;
      await call('/api/accounts/label', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id, label }) });
      await loadAccounts(false);
      renderAccounts();
    };
    const drop = smallButton('删除', true);
    drop.onclick = async () => {
      if (await accountDialog('删除本机账号', '删除「' + account.title + '」保存在本机的凭证？') === null) return;
      await call('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id }) });
      await loadAccounts(true);
      renderAccounts();
    };
    const download = smallButton('导出');
    download.onclick = () => exportAccounts(account.id);
    top.append(use, rename, download, drop);
    card.appendChild(top);
    box.appendChild(card);
  }
}

$('cred-show').onclick = async () => {
  $('cred-show').disabled = true;
  try {
    const data = await call('/api/accounts/credential?reveal=1');
    const box = clear($('cred'));
    const rows = [
      ['账号', data.title + '（' + data.id + '）'],
      ['openId', data.raw.openId || '-'],
      ['token', data.raw.token || '-'],
      ['sign', data.raw.sign || '-'],
      ['timestamp', data.raw.timestamp == null ? '-' : String(num(data.raw.timestamp))],
      ['网关', data.url],
      ['抓于', when(data.capturedAt)],
    ];
    const kv = el('div', 'kv');
    for (const [k, v] of rows) {
      kv.appendChild(el('div', 'k', k));
      kv.appendChild(el('div', 'v', v));
    }
    box.appendChild(kv);
    box.appendChild(el('div', 'dim', '登录帧原始数据（' + (data.loginFrameHex || '').length + ' 个十六进制字符）'));
    box.appendChild(el('pre', null, data.loginFrameHex || '（没有保存）'));
  } catch (error) {
    $('hint').textContent = '';
    reportError(error);
  }
  $('cred-show').disabled = false;
};
$('cred-hide').onclick = () => clear($('cred')).appendChild(el('span', 'dim', '已收起，点「显示凭证」再看'));

async function renderWorlds() {
  const data = await call('/api/worlds');
  const box = clear($('worlds'));
  for (const world of data.recentWorlds) {
    const role = world.role || {};
    const row = el('div', 'acct');
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', String(world.worldId)));
    if (role.worldId && role.worldId !== world.worldId) top.appendChild(el('span', 'id', '合服后 -> ' + role.worldId));
    top.appendChild(el('span', 'id', (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power) + ' 上次登录 ' + when(role.lastLoginTime)));
    const enter = smallButton('进入');
    enter.onclick = () => enterWorld(world.worldId);
    top.appendChild(enter);
    row.appendChild(top);
    box.appendChild(row);
  }
  if (!data.recentWorlds.length) box.appendChild(el('div', 'dim', '这个账号下没有区服'));
  else box.appendChild(el('div', 'dim', '共 ' + data.recentWorlds.length + ' 个区服，分组 ' + data.latestGroupId));
}

async function enterWorld(worldId) {
  $('worlds-hint').textContent = '进入 ' + worldId + ' ...';
  try {
    const data = await call('/api/worlds/enter', { method: 'POST', body: JSON.stringify({ confirm: true, worldId, fromWorldId: 0 }) });
    const role = data.player || {};
    $('worlds-hint').textContent = '已在 ' + worldId + '：' + (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power);
    await loadAccounts(false);
    renderAccounts();
    refreshOverview();
  } catch (error) {
    $('worlds-hint').textContent = '';
    reportError(error);
  }
}

$('load-worlds').onclick = async () => {
  $('worlds-hint').textContent = '加载中 ...';
  try {
    await renderWorlds();
    $('worlds-hint').textContent = '';
  } catch (error) {
    $('worlds-hint').textContent = '';
    reportError(error);
  }
};
$('enter-world').onclick = () => {
  const worldId = Number($('world-input').value.trim());
  if (!worldId) {
    $('worlds-hint').textContent = '先填 worldId';
    return;
  }
  enterWorld(worldId);
};

// ---- 添加账号：从电脑微信采集登录 -----------------------------------------
let capturePoll = null;

function renderCapture(state) {
  const hint = $('cap-hint');
  const box = clear($('cap-box'));
  const cleanupPending = state.phase === 'error';
  $('cap-start').disabled = state.running || cleanupPending;
  $('cap-douyin').disabled = state.running || cleanupPending;
  $('cap-stop').disabled = !state.running && !cleanupPending;
  hint.textContent = state.error ? '采集已停止，请查看运行日志' : (state.running ? '抓包中：' + (state.phase === 'waiting' ? '等待电脑游戏登录' : state.phase) : (state.accountId ? '凭证已保存，登录验证结果请查看日志' : ''));
  hint.className = state.error ? 'bad' : 'warn';

  if (state.running) {
    const steps = el('ol', 'steps');
    const lines = [
      '先登录电脑版' + (state.platform === 'douyin' ? '抖音' : '微信') + '，再从该客户端打开《疯狂水世界》',
      '如果游戏已经打开，请完全退出后重新进入，让它重新发送登录请求',
      '捕获后保存凭证，并尝试读取角色验证登录；验证失败会显示在日志中',
      '完成、失败或等待超时后会自动恢复代理，只移除本次新安装的证书',
    ];
    for (const text of lines) steps.appendChild(el('li', null, text));
    const qr = el('div', 'qr');
    const side = el('div', null, '');
    if (state.platform !== 'douyin' && state.qr && state.qr.kind === 'image') {
      const img = el('img');
      img.src = state.qr.url + '?t=' + Date.now();
      img.alt = '游戏入口码（非扫码登录授权）';
      qr.appendChild(img);
    }
    if (state.platform !== 'douyin') side.appendChild(el('div', 'dim', state.qr?.note || '请在电脑微信中打开游戏。'));
    side.appendChild(steps);
    qr.appendChild(side);
    box.appendChild(qr);

    const status = el('div', 'kv');
    const rows = [
      ['系统代理', (state.proxyOn ? '已打开 -> ' + (state.proxy?.ProxyServer ?? '') : '未打开') + '　原值 ' + (state.originalProxy?.ProxyEnable ?? '无') + ' / ' + (state.originalProxy?.ProxyServer ?? '无')],
      ['本地证书', state.caInstalled ? (state.caAddedByCapture ? '本次安装，结束后移除' : '原有证书，结束后保留') : '未安装'],
      ['抓包代理', state.port ? '127.0.0.1:' + state.port : '-'],
    ];
    for (const [k, v] of rows) {
      status.appendChild(el('div', 'k', k));
      status.appendChild(el('div', 'v', v));
    }
    box.appendChild(status);
  }

}

async function pollCapture() {
  try {
    const state = await call('/api/capture');
    renderCapture(state);
    if (!state.running && capturePoll) {
      clearInterval(capturePoll);
      capturePoll = null;
      await loadAccounts(true);
      renderAccounts();
    }
  } catch (error) {
    $('cap-hint').textContent = '';
    reportError(error);
  }
}


$('cap-start').onclick = () => beginCapture('wechat');
$('cap-douyin').onclick = () => beginCapture('douyin');
async function beginCapture(platform) {
  let state;
  try {
    state = await call('/api/capture');
  } catch (error) {
    $('cap-hint').textContent = '';
    reportError(error);
    return;
  }
  const body = [
    el('div', null, '抓包只做两处「仅当前用户」的改动，抓到账号后立刻自动还原：'),
    el('div', null, '1. 若缺少证书，Windows 会打开导入向导，目标已选定为当前用户的“受信任的根证书颁发机构”。点击“完成”；若出现安全警告，核对 CrazyWaterWorld Local Test CA 后选择“是”。'),
    el('div', null, '2. 把当前用户的系统代理指向 127.0.0.1:' + state.port + '（原来指向 ' + (state.proxy?.ProxyServer ?? '无') + '，结束后写回）'),
    el('div', null, '使用系统代理的其他程序也会临时经过本机代理；仅解密本游戏网关，结束后恢复原设置。随时可点「停止抓包」。'),
    el('div', null, '采集就绪后，请只在电脑' + (platform === 'douyin' ? '抖音' : '微信') + '里重新打开《疯狂水世界》。'),
    el('div', null, '捕获后会尝试连接游戏验证角色，可能让正在运行的游戏掉线一次。'),
  ];
  openConfirm('开始抓包（将修改当前用户的系统设置）', body, async () => {
    $('cap-hint').textContent = '请在 Windows 证书导入向导中完成导入，返回后会自动检查根证书库…';
    const next = await call('/api/capture/start', { method: 'POST', body: JSON.stringify({ confirm: true, platform }) });
    renderCapture(next);
    if (capturePoll) clearInterval(capturePoll);
    capturePoll = setInterval(pollCapture, 1500);
  });
}

$('cap-stop').onclick = async () => {
  const state = await call('/api/capture/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  renderCapture(state);
  if (capturePoll) {
    clearInterval(capturePoll);
    capturePoll = null;
  }
  await loadAccounts(true);
  renderAccounts();
};

// ---- 启动 ------------------------------------------------------------------
${AUTOMATION_SCRIPT}
${activitiesScript}
${progressionScript}
${connectionScript}
document.querySelectorAll('[data-subtabs]').forEach((group) => {
  const tabs = [...group.querySelectorAll('[role=tab]')];
  const choose = (tab, focus) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      $(other.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
    refreshProgression();
  };
  tabs.forEach((tab, index) => {
    tab.onclick = () => choose(tab);
    tab.onkeydown = (event) => {
      const offsets = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: tabs.length - index - 1 };
      if (!(event.key in offsets)) return;
      event.preventDefault();
      choose(tabs[(index + offsets[event.key] + tabs.length) % tabs.length], true);
    };
  });
});
document.querySelectorAll('#tabs button').forEach((button) => {
  button.onclick = () => {
    for (const other of document.querySelectorAll('#tabs button')) other.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'page');
    for (const section of document.querySelectorAll('main > section')) {
      section.classList.toggle('hidden', section.id !== 'tab-' + button.dataset.tab);
    }
    $('page-title').textContent = button.textContent;
    // The automation page owns floating controls that must not remain visible after a tab switch.
    updateAutomationBackToTop();
    refreshProgression();
    if (button.dataset.tab === 'overview') refreshOverview();
    if (button.dataset.tab === 'account') {
      renderAccounts();
      pollCapture();
    }
    if (button.dataset.tab === 'manual') refreshManualWorld();
    if (button.dataset.tab === 'idle') refreshLoop();
    if (button.dataset.tab === 'activities') refreshActivities();
    if (button.dataset.tab === 'stages') refreshStages();
    if (button.dataset.tab === 'automation') loadAutomation().catch(error => $('automation-hint').textContent = error.message);
  };
});

async function boot() {
  try {
    await loadAccounts(true);
  } catch (error) {
    $('hint').textContent = '';
    reportError(error);
    return;
  }
  pollCapture();
}
boot();
setInterval(refreshOverview, 20000);
setInterval(refreshLoop, 3000);
setInterval(refreshStages, 3000);
</script>
</body>
</html>`;
