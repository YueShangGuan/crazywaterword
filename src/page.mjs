import { readFileSync } from 'node:fs';
import { automationTasks } from './automation.mjs';
import { operationLabels } from './operation-labels.mjs';
import { iconEntry } from './art.mjs';
import { chrome, journal, dialogs, templates, overviewPage, manualPage, heroesPage, dailiesPage, activitiesPage, accountPage, idlePanel, stagePanel } from './ui/dist/console.mjs';
const componentCss = readFileSync(new URL('./ui/dist/theme.css', import.meta.url), 'utf8');
const consoleCss = readFileSync(new URL('./console.css', import.meta.url), 'utf8');
const progressionScript = readFileSync(new URL('./ui/progression.js', import.meta.url), 'utf8');

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect fill='%23102d39' width='40' height='40' rx='8'/%3E%3Cpath fill='%23ffbd77' d='m20 3 4 13 13 4-13 4-4 13-4-13-13-4 13-4z'/%3E%3C/svg%3E">
<title>疯狂水世界</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>@layer theme, legacy, utilities; @layer legacy { ${consoleCss} } ${componentCss}</style>
</head>
<body>
${chrome(iconEntry)}
<div class="deck"><main>
  <div class="page-heading"><h2 id="page-title">总览</h2><a class="jump-log" href="#journal">查看日志 ↓</a></div>
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

  <section id="tab-account" class="hidden">
    ${accountPage()}
  </section>
</main>
${journal()}</div>
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
function updateLogSummary() {
  const count = onlyIssues ? logEl.querySelectorAll('.error,.warn').length : logEl.childElementCount;
  $('log-count').textContent = String(count);
  $('log-empty').hidden = count > 0;
  $('log-empty').textContent = onlyIssues ? '没有警告或错误' : '还没有运行记录';
}
function appendLog(entry) {
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
function subscribe() {
  if (stream) stream.close();
  if (logAccount !== current) {
    seen.clear(); clear(logEl); updateLogSummary(); logAccount = current;
  }
  stream = new EventSource('/api/events' + (current ? '?account=' + encodeURIComponent(current) : ''));
  stream.onmessage = (event) => {
    const entry = JSON.parse(event.data);
    appendLog(entry);
    if (entry.extra?.pauseChanged && entry.account === current) void loadAccounts(false);
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
  $('connect').disabled = snapshot.paused || snapshot.connected || !accounts.length;
  $('disconnect').disabled = !snapshot.connected;
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
  subscribe();
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
  await call('/api/disconnect', { method: 'POST' });
  if (account !== current) return;
  snapshot.connected = false;
  $('busy').textContent = '未连接';
  renderAccountSelect();
};

// ---- 总览 ------------------------------------------------------------------
function renderWho(view) {
  const box = clear($('who'));
  const role = view.player || {};
  const account = view.account || {};
  const status = view.status || {};
  const items = [
    ['账号', account.title || '-'],
    ['角色', role.nickname || '-'],
    ['等级', role.level == null ? '-' : String(role.level)],
    ['战力', fmt(role.power)],
    ['区服', role.worldId == null ? '-' : String(role.worldId)],
    ['状态', status.connected ? '已连接' : '未连接'],
  ];
  for (const [k, v] of items) {
    const cellBox = el('div', 'item');
    cellBox.appendChild(el('span', 'k', k));
    cellBox.appendChild(el('span', 'v', v));
    box.appendChild(cellBox);
  }
  if (view.afk) {
    const afk = el('div', 'item');
    afk.appendChild(el('span', 'k', '闯关挂机收益'));
    const finish = view.afk.finishTime;
    const status = view.afk.capped ? '收益已满' : finish > 0 ? new Date(finish * 1000).toLocaleTimeString() + ' 满额' : '暂无计时';
    afk.appendChild(el('span', 'v', '等级 ' + (view.afk.level ?? '-') + ' · ' + status));
    box.appendChild(afk);
  }
}

function renderOverview(data) {
  renderWho(data);
  const res = clear($('res'));
  for (const entry of data.resources || []) res.appendChild(cell(entry.icon, 34, entry.name, fmt(entry.amount), false));
  if (!res.childElementCount) res.appendChild(el('span', 'dim', '暂无数据'));

  const items = clear($('items'));
  for (const entry of (data.items && data.items.top) || []) items.appendChild(cell(entry.icon, 34, entry.name, 'x' + fmt(entry.num)));
  if (!items.childElementCount) items.appendChild(el('span', 'dim', '暂无数据'));

  const heroes = clear($('hero-strip'));
  for (const hero of (data.heroes && data.heroes.list) || []) {
    heroes.appendChild(cell(hero.icon, 40, hero.heroId, 'lv' + hero.level + ' · ' + hero.star + '星'));
  }
  if (!heroes.childElementCount) heroes.appendChild(el('span', 'dim', '暂无数据'));
}

let overviewPending = false;
let claiming = false;
async function refreshOverview() {
  if (overviewPending || claiming || !current || snapshot.paused || disconnected.has(current) || document.hidden || $('tab-overview').classList.contains('hidden')) return;
  const account = current;
  overviewPending = true;
  try {
    const data = await call('/api/overview');
    if (account !== current || snapshot.paused || disconnected.has(account)) return;
    snapshot = data.status;
    renderAccountSelect();
    renderOverview(data);
    $('hint').textContent = '';
    $('busy').textContent = data.status.connected ? '已连接' : '未连接';
  } catch (error) {
    reportError(error, '刷新总览');
  } finally { overviewPending = false; }
}

$('loot-run').onclick = async () => {
  const account = current;
  if (!account || claiming) return;
  claiming = true;
  $('loot-run').disabled = true;
  $('loot-hint').textContent = '领取中…';
  try {
    const data = await call('/api/loot/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (account === current) $('loot-view').textContent = data.summary;
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
  $('loop-hint').textContent = (data.running ? '挂机中，已完成 ' : '未在挂机，累计 ') + data.completed + ' 轮' + (data.error ? '，已中止' : '');
  if (data.stopping) $('loop-hint').textContent = '正在暂停，等待在途请求结束';
  if (!data.history.length) {
    $('loop-view').textContent = data.running ? '第一轮进行中 ...' : '还没跑过。点「开始挂机」按上面的设置跑起来。';
    return;
  }
  const lines = data.history.map((entry) => entry.text);
  $('loop-view').textContent = lines.join(String.fromCharCode(10, 10));
}

async function refreshLoop() {
  const account = current, version = ++loopVersion;
  if ($('tab-idle').classList.contains('hidden')) return;
  if (loopAccount !== account || !account) {
    $('loop-hint').textContent = account ? '正在读取设置' : '请选择账号';
    $('loop-view').textContent = '';
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
  const enabled = input.getAttribute('aria-checked') !== 'true';
  setTaskSwitch(input, enabled);
  savingTasks.add(saving);
  input.disabled = true;
  ++loopVersion;
  try {
    await call('/api/loop/task', { method: 'POST', body: JSON.stringify({ confirm: true, key, enabled }) });
  } catch (error) { setTaskSwitch(input, !enabled); reportError(error); }
  finally {
    savingTasks.delete(saving);
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
    $('tasks-hint').textContent = '可领 ' + data.plan.length + ' 条';
    $('tasks-view').textContent = data.text;
  } catch (error) {
    $('tasks-hint').textContent = '';
    reportError(error);
  }
};
bindGameAction('tasks-run', async () => {
  const account = current;
  const data = await call('/api/tasks/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  if (current === account) {
    $('tasks-view').textContent = data.text;
    $('tasks-hint').textContent = '本轮成功领取 ' + data.results.filter((r) => r.ok).length + ' 项';
  }
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

function renderWorld(data) {
  $('world-view').textContent = data.text;
  const fbox = clear($('world-factories'));
  if (data.farms?.length) {
    fbox.appendChild(el('h2', null, '农田'));
    fbox.appendChild(table(['地块', '状态'], data.farms.map(f => [f.plot, f.status])));
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
    for (const id of ['world-factories', 'world-orders', 'world-stock', 'world-fields', 'world-hint']) clear($(id));
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
    $('world-hint').textContent = '执行 ' + data.results.length + ' 个动作，失败 ' + data.results.filter((r) => r.ok === false).length;
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
  $('hero-view').textContent = data.text;
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
    renderHeroes(await call('/api/heroes'));
    $('hero-hint').textContent = '';
  } catch (error) {
    $('hero-hint').textContent = '';
    reportError(error);
  }
};
bindGameAction('hero-run', async () => {
  $('hero-hint').textContent = '执行中 ...';
  try {
    const data = await call('/api/heroes/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    $('hero-hint').textContent = '发出 ' + data.sent + ' 个请求，失败 ' + data.failed + '，跳过 ' + data.skipped + '，耗时 ' + Math.round(data.ms / 1000) + 's';
    $('hero-plan').onclick();
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
  $('dailies-view').textContent = data.text + String.fromCharCode(10) + '钻石 ' + fmt(data.ruby) + '（本工具不主动花钻石）';
}

$('dailies-plan').onclick = async () => {
  $('dailies-hint').textContent = '探测中 ...';
  try {
    renderDailies(await call('/api/dailies'));
    $('dailies-hint').textContent = '';
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
    $('dailies-hint').textContent = '完成 ' + data.results.filter((r) => r.ok).length + ' 个动作，失败 ' + data.results.filter((r) => r.ok === false).length + '，领取奖励 ' + data.claimed.length + ' 个，耗时 ' + Math.round(data.ms / 1000) + 's';
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

let sourceIndex;
function renderSourceSearch() {
  const box = clear($('source-results')), query = $('source-query').value.trim();
  if (!query || !sourceIndex) return;
  const matches = sourceIndex.filter(row => row.name.includes(query));
  if (!matches.length) box.textContent = '未找到已配置来源的材料';
  else box.appendChild(table(['材料', '游戏内来源'], matches.map(r => [r.name, r.sources.join('、')])));
}
$('source-query').oninput = renderSourceSearch;

async function refreshDiscovery(version, account) {
  const box = clear($('pirate-tracker'));
  if (!account) return;
  box.textContent = '正在核对赛季和首杀记录…';
  const [sources, pirates] = await Promise.allSettled([sourceIndex ?? call('/api/material-sources'), call('/api/pirates')]);
  if (version !== activitiesVersion || account !== current) return;
  if (sources.status === 'fulfilled') {
    sourceIndex = sources.value;
    renderSourceSearch();
  } else $('source-results').textContent = '来源查询失败，详情见日志';
  clear(box);
  if (pirates.status !== 'fulfilled') { box.textContent = '读取失败，详情见日志'; return; }
  const data = pirates.value;
  box.appendChild(el('p', null, '第 ' + data.season + ' 赛季 · ' + (data.locked ? '世界 ' + data.required + ' 级开放，以下为配置预览' : '各类海盗的下一档首杀目标')));
  box.appendChild(table(['目标', '参考战力', '首杀进度', '地图目标', '首杀材料'], data.targets.map(r => [
    r.name + ' ' + r.level + ' 级', fmt(r.power), r.cleared == null ? '未核对' : r.finished ? '全部完成' : '已击败至 ' + r.cleared + ' 级',
    r.visible == null ? '未查询' : r.visible + ' 个', r.materials || '无材料奖励',
  ])));
}

let activitiesVersion = 0;
let activityExpiryTimer;
async function refreshActivities() {
  const version = ++activitiesVersion, account = current;
  clearTimeout(activityExpiryTimer);
  if ($('tab-activities').classList.contains('hidden')) return;
  const list = clear($('activities-list')), materials = clear($('activities-order'));
  if (snapshot.paused) { list.textContent = '账号已暂停'; clear($('pirate-tracker')); return; }
  list.textContent = account ? '正在读取活动…' : '请先选择账号';
  void refreshDiscovery(version, account);
  if (!account) return;
  try {
    const data = await call('/api/activities');
    if (version !== activitiesVersion || account !== current) return;
    clear(list);
    const active = data.activities.filter(row => row.endTime > data.serverNow);
    if (active.length) {
      const hasTask = active.some(row => row.taskKey);
      if (hasTask) list.appendChild(el('p', 'dim', '开启的限时任务随账号挂机执行，到期自动停止。'));
      const headers = ['活动', '结束时间（北京时间）'];
      if (hasTask) headers.push('限时自动任务');
      list.appendChild(table(headers, active.map(row => {
        const cells = [row.name, new Date(row.endTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })];
        const task = data.eventTasks.find(t => t.key === row.taskKey);
        if (task) {
          const toggle = component('ui-event-switch');
          toggle.dataset.autoTask = task.key;
          toggle.dataset.eventTask = 'true';
          toggle.setAttribute('aria-label', task.label);
          toggle.title = task.label;
          setTaskSwitch(toggle, task.enabled);
          toggle.disabled = savingTasks.has(account + ':' + task.key);
          toggle.onclick = () => toggleAutoTask(toggle);
          const control = el('div', 'bar');
          control.append(toggle, el('span', null, task.label));
          cells.push(control);
        } else if (hasTask) cells.push('');
        return cells;
      })));
      const nextEnd = Math.min(...active.map(row => row.endTime));
      activityExpiryTimer = setTimeout(refreshActivities, Math.min(2147483647, Math.ceil((nextEnd - data.serverNow) * 1000)));
    }
    else list.textContent = '当前没有开放的周活动或节日活动';
    const lottery = data.lottery;
    if (lottery) list.appendChild(el('p', null, '周抽奖 · 累计 ' + lottery.times + ' 次 · '
      + (lottery.required == null ? '全部档位已领完' : '下一档 ' + lottery.required + ' 次' + (lottery.ready ? '（可领取）' : ''))));
    if (data.lotteryError) list.appendChild(el('p', null, '周抽奖进度读取失败，详见日志'));
    const fish = data.fish;
    list.appendChild(el('p', null, fish ? '钓鱼图鉴 · 已收集 ' + fish.names.length + '/' + fish.total + ' 种 · '
      + (fish.next ? '下一档 ' + fish.score + '/' + fish.required + ' 分' : '档位已领完')
      + (fish.names.length ? '（' + fish.names.join('、') + '）' : '') : '钓鱼图鉴读取失败，详见日志'));
    const newbie = data.newbie;
    list.appendChild(el('p', null, newbie ? '新手七日登录 · 已登录 ' + newbie.loginDays + ' 天 · '
      + (newbie.available.length ? '可领第 ' + newbie.available.join('、') + ' 天奖励' : '当前奖励已领完') : '新手七日登录 · 当前无开放活动'));
    if (data.order?.materials.length && !data.order.finished) {
      materials.appendChild(el('p', 'dim', data.order.ready
        ? '周订单材料已齐，已预留整单用量，可在游戏内手动提交。'
        : '周订单尚缺材料。已备齐的居民订单可先用所需份额，挂机再按缺口补产。'));
      materials.appendChild(table(['材料', '需要', '库存', '还缺', '生产地点', '当前状态'], data.order.materials.map(row =>
      [row.name, String(row.required), String(row.owned), row.missing ? String(row.missing) : '已齐',
        row.seed ? '农田' : row.factory ? row.factory.name + ' · ' + row.factory.required + ' 级' : '无工厂配方',
        row.seed ? row.farmStatus : !row.factory ? '—' : row.factory.level === null ? '等级未知' : row.factory.level ? row.factory.level + ' 级' + (row.factory.constructing ? ' · 升级中' : '') : row.factory.constructing ? '建造中' : '未建造'])));
    } else materials.textContent = data.orderError ? '未能读取材料，详情见运行日志' : !data.order ? '本期未开放周订单' : data.order.finalReady ? '本期周订单已全部交付，可在游戏内领取最终奖励。' : data.order.finished ? '本期周订单已完成' : '当前没有材料需求';
  } catch {
    if (version === activitiesVersion && account === current) list.textContent = '读取失败，详情见运行日志';
  }
}
$('activities-refresh').onclick = () => { refreshActivities(); refreshProgression(); };

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

  if (state.log && state.log.length) {
    box.appendChild(el('h2', null, '抓包记录'));
    box.appendChild(el('pre', null, state.log.join(String.fromCharCode(10))));
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
${progressionScript}
document.querySelectorAll('#tabs button').forEach((button) => {
  button.onclick = () => {
    for (const other of document.querySelectorAll('#tabs button')) other.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'page');
    for (const section of document.querySelectorAll('main > section')) {
      section.classList.toggle('hidden', section.id !== 'tab-' + button.dataset.tab);
    }
    $('page-title').textContent = button.textContent;
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
