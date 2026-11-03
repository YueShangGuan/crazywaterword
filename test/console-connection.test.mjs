import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { after, test } from 'node:test';
import { GameClient } from '../src/client.mjs';
import { PAGE } from '../src/page.mjs';

// 临时账号和模拟登录完全隔离真实凭证；测试只访问随机端口的本地 HTTP 服务。
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-console-connection-'));
process.env.CW_DATA_DIR = directory;
const { saveStore, upsertAccount } = await import('../src/accounts.mjs');
const { defaultSettings, saveSettings } = await import('../src/automation/settings.mjs');
const { createConsole } = await import('../src/server.mjs');
after(() => fs.rmSync(directory, { recursive: true, force: true }));

/** 创建独立控制台及两个假账号，便于验证断开状态不会串到其他账号。 */
async function consoleFixture(t) {
  const store = { version: 1, activeId: null, accounts: [] };
  for (const id of ['connection-a', 'connection-b']) {
    upsertAccount(store, { url: 'wss://offline.invalid/ws', login: { eworldParams: { openId: id } } });
  }
  saveStore(store);
  const app = createConsole({ port: 0 });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    for (const session of app.sessions.values()) session.client?.stop();
    app.server.closeAllConnections();
    await app.close();
  });

  /** HTTP 只访问本测试创建的服务；登录及游戏查询由内存方法替代。 */
  async function api(route, body, account = 'connection-a') {
    const response = await fetch(`${base}${route}?account=${account}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }
  await api('/api/accounts');
  return { app, api };
}

/**
 * 替代所有游戏网关入口，记录登录次数并允许按请求名定制本地响应。
 *
 * @param {object} t Node.js 测试上下文。
 * @param {(client: GameClient) => Promise<object>} login 模拟登录回包。
 * @param {(name: string, body?: object, response?: string) => Promise<object>} request 模拟业务请求回包。
 * @returns {object} 登录 Mock 上下文，供调用方断言次数。
 */
function mockGateway(t, login = async () => ({ result: 0, initSeqNo: 1, playerInfo: { playerId: '1', nickname: '离线角色', level: 1 } }), request = async () => ({})) {
  t.mock.getter(GameClient.prototype, 'connected', function () { return this.state === 'READY'; });
  const connecting = t.mock.method(GameClient.prototype, 'connect', async function () {
    this.setState('CONNECTING');
    const response = await login(this);
    this.setState('READY');
    return response;
  });
  // 总览查询只返回空数据，不编码、不发帧、不创建 WebSocket。
  t.mock.method(GameClient.prototype, 'sendWatch', async () => ({}));
  // 上游登录完成信号同样在内存截断，测试不得创建真实网关帧。
  t.mock.method(GameClient.prototype, 'send', () => 1);
  t.mock.method(GameClient.prototype, 'request', request);
  return connecting;
}

/**
 * 启动只接收本测试通知的本地企微 Webhook，避免访问真实机器人地址。
 *
 * @param {object} t Node.js 测试上下文。
 * @returns {Promise<{messages: object[], webhook: string}>} 已接收消息数组和测试 Webhook 地址。
 */
async function wecomFixture(t) {
  const messages = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      messages.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errcode: 0 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { messages, webhook: `http://127.0.0.1:${server.address().port}/wecom` };
}

/** 复现“断开后轮询又登录”，并验证显式连接和多账号隔离。 */
test('console: disconnect survives polling and queued business requests until explicit connect', async t => {
  const login = mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/overview')).value.status.connected, false);
  assert.equal(login.mock.callCount(), 0);

  assert.equal((await api('/api/connect', {})).status, 200);
  assert.equal((await api('/api/overview')).value.status.connected, true);
  const session = app.sessions.get('connection-a');
  const oldClient = session.client;
  assert.equal((await api('/api/disconnect', {})).status, 200);
  assert.equal(oldClient.stopping, true);
  assert.equal(session.loop.stop.aborted, true);
  assert.equal(session.client, null);
  assert.equal(session.player, null);

  for (let round = 0; round < 3; round++) {
    const overview = await api('/api/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.value.status.connected, false);
    assert.equal(overview.value.status.state, 'STOPPED');
  }
  for (const route of ['/api/tasks', '/api/world', '/api/heroes', '/api/dailies', '/api/worlds']) {
    const response = await api(route);
    assert.equal(response.status, 400);
    assert.match(response.value.error, /已手动断开/);
  }
  assert.equal((await api('/api/automation/plan', { modules: 'cargo' })).status, 400);
  assert.equal((await api('/api/loop/start', { confirm: true, modules: ['cargo'], rounds: 1, everySeconds: 1 })).status, 400);
  assert.equal(login.mock.callCount(), 1);

  assert.equal((await api('/api/connect', {}, 'connection-b')).status, 200);
  assert.equal((await api('/api/overview')).value.status.connected, false);
  assert.equal((await api('/api/connect', {})).status, 200);
  assert.equal((await api('/api/overview')).value.status.connected, true);
  assert.equal(login.mock.callCount(), 3);
});

/** 断开可能发生在登录回包抵达前，迟到回包也不能恢复被取消的会话。 */
test('console: disconnect during login prevents a late reply from restoring the session', async t => {
  let releaseLogin;
  let reportStarted;
  const started = new Promise(resolve => { reportStarted = resolve; });
  const delayed = new Promise(resolve => { releaseLogin = resolve; });
  let oldClient;
  mockGateway(t, async client => { oldClient = client; reportStarted(); return delayed; });
  const { app, api } = await consoleFixture(t);
  const connecting = api('/api/connect', {});
  await started;
  assert.equal((await api('/api/disconnect', {})).status, 200);
  releaseLogin({ result: 0, initSeqNo: 1, playerInfo: { nickname: '迟到角色' } });
  const response = await connecting;
  assert.equal(response.status, 400);
  assert.match(response.value.error, /连接已取消/);
  assert.equal(oldClient.connected, false);
  const session = app.sessions.get('connection-a');
  assert.equal(session.client, null);
  assert.equal(session.player, null);
  assert.equal((await api('/api/overview')).value.status.connected, false);
});

/** 页面刷新留下旧总览采集时，新页面应加入同一条只读结果而不是收到忙碌错误。 */
test('console: concurrent overview requests share the in-flight collection', async t => {
  mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const session = app.sessions.get('connection-a');
  let releaseFirstQuery;
  let firstQueryStarted;
  const firstQuery = new Promise(resolve => { releaseFirstQuery = resolve; });
  const queryStarted = new Promise(resolve => { firstQueryStarted = resolve; });
  let queryCount = 0;
  t.mock.method(GameClient.prototype, 'request', async () => {
    queryCount += 1;
    if (queryCount === 1) {
      firstQueryStarted();
      await firstQuery;
    }
    return {};
  });

  const first = api('/api/overview');
  await queryStarted;
  const second = api('/api/overview');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(session.busy, 'GET /api/overview');
  releaseFirstQuery();

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(session.busy, null);
  assert.equal(session.overviewPromise, null);
  assert.equal(queryCount, 49);
});

/** 只读总览在挂机循环运行期间仍可查询，避免手动刷新被写操作保护拦截。 */
test('console: overview remains readable while the loop is running', async t => {
  mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const session = app.sessions.get('connection-a');
  session.loop.running = true;
  const response = await api('/api/overview');
  assert.equal(response.status, 200);
  assert.equal(response.value.status.connected, true);
  session.loop.running = false;
});

/**
 * 用最小 DOM 执行实际页面脚本；定时器不运行，只手动驱动轮询。
 *
 * @returns {{context: vm.Context, calls: string[], node: (id: string) => object, window: object, clipboardWrites: string[], notificationRequests: object[], getNotifications: () => object}} 页面夹具和通知设置请求记录。
 */
function pageFixture({ looping = false } = {}) {
  const nodes = new Map();
  /** DOM 桩同时模拟日志节点的子项、滚动位置和指针事件，不触发浏览器或网络副作用。 */
  function element() {
    const listeners = new Map();
    const value = {
      disabled: false,
      textContent: '',
      className: '',
      style: {},
      children: [],
      clientHeight: 0,
      scrollHeight: 0,
      scrollTop: 0,
      classList: { contains: () => true, add: () => {}, remove: () => {}, toggle: () => {} },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; },
      contains(child) { for (let node = child; node; node = node.parentNode) if (node === this) return true; return false; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      emit(type) { listeners.get(type)?.({ type, target: this }); },
    };
    Object.defineProperties(value, {
      childElementCount: { get: () => value.children.length },
      firstChild: { get: () => value.children[0] ?? null },
      innerText: { get: () => value.children.length ? value.children.map(child => child.innerText ?? child.textContent).join('\n') : value.textContent },
    });
    return value;
  }
  /** 按 ID 复用节点，使真实页面绑定的事件可被测试直接调用。 */
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  }
  let connected = true;
  const calls = [];
  const clipboardWrites = [];
  const notificationRequests = [];
  let notifications = { wecom: { enabled: false, webhook: '' } };
  const windowListeners = new Map();
  const window = {
    getSelection: () => ({ rangeCount: 0, isCollapsed: true }),
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    emit(type) { windowListeners.get(type)?.({ type, target: window }); },
  };
  const context = vm.createContext({
    window,
    navigator: { clipboard: { writeText: async text => { clipboardWrites.push(text); } } },
    document: {
      getElementById: node,
      createElement: element,
      createTextNode: text => ({ textContent: text, parentNode: null }),
      querySelectorAll: () => [],
    },
    Option: function () {}, setInterval: () => {},
    // 模拟本地 HTTP 响应，不启动真实浏览器，也不使用磁盘账号。
    fetch: async (url, options = {}) => {
      const route = url.split('?')[0];
      calls.push(route);
      if (route === '/api/disconnect') connected = false;
      if (route === '/api/connect') connected = true;
      const status = { connected, state: connected ? 'READY' : 'STOPPED', busy: null, looping };
      let data;
      if (route === '/api/accounts') data = { activeId: 'page-a', accounts: [{ id: 'page-a', title: '离线账号', status }] };
      else if (route === '/api/accounts/notifications' && options.method === 'POST') {
        // 页面保存必须携带确认标记，夹具记录请求体以验证只写通知这一小段设置。
        const payload = JSON.parse(options.body);
        notificationRequests.push(payload);
        notifications = payload.notifications;
        data = { notifications };
      }
      else if (route === '/api/accounts/notifications') data = { notifications };
      else if (route === '/api/overview') data = { status, resources: [{ name: '金币', amount: 123 }], items: { top: [] }, heroes: { list: [] } };
      else data = { ok: true };
      return { ok: true, json: async () => data };
    },
  });
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)[1];
  // 保留实际事件和轮询函数，仅移除启动调用，避免异步 boot 干扰用例顺序。
  vm.runInContext(script.slice(0, script.lastIndexOf('boot();')), context);
  vm.runInContext("current = 'page-a'", context);
  return { context, calls, node, window, clipboardWrites, notificationRequests, getNotifications: () => notifications };
}

/** 页面断开后不再采集总览；再次连接立即更新缓存、按钮和总览。 */
test('console page: disconnect clears cached status and polling waits for explicit connect', async () => {
  const { context, calls, node } = pageFixture();
  await vm.runInContext('loadAccounts(false)', context);
  assert.equal(node('connect').disabled, true);
  await node('disconnect').onclick();
  for (let round = 0; round < 3; round++) await vm.runInContext('refreshOverview()', context);
  assert.equal(calls.filter(route => route === '/api/overview').length, 0);
  assert.equal(node('connect').disabled, false);
  assert.equal(node('disconnect').disabled, true);
  assert.equal(vm.runInContext('snapshot.connected', context), false);

  await node('connect').onclick();
  assert.equal(calls.filter(route => route === '/api/overview').length, 1);
  assert.equal(node('connect').disabled, true);
  assert.equal(node('disconnect').disabled, false);
});

/** 总览手动刷新按钮必须复用总览接口，并在请求结束后恢复可点击状态。 */
test('console page: overview refresh button requests current overview', async () => {
  const { context, calls, node } = pageFixture();
  await vm.runInContext('loadAccounts(false)', context);
  assert.equal(node('overview-refresh').disabled, false);
  assert.equal(node('overview-refresh').textContent, '刷新数据');

  const fetch = context.fetch;
  let releaseOverview;
  let reportStarted;
  const started = new Promise(resolve => { reportStarted = resolve; });
  const delayed = new Promise(resolve => { releaseOverview = resolve; });
  context.fetch = async url => {
    const response = await fetch(url);
    if (url.split('?')[0] === '/api/overview') {
      reportStarted();
      await delayed;
    }
    return response;
  };
  const refreshing = node('overview-refresh').onclick();
  await started;
  assert.equal(node('overview-refresh').disabled, true);
  assert.equal(node('overview-refresh').textContent, '刷新中...');
  releaseOverview();
  await refreshing;

  assert.equal(calls.filter(route => route === '/api/overview').length, 1);
  assert.equal(node('overview-refresh').disabled, false);
  assert.equal(node('overview-refresh').textContent, '刷新数据');
});

/** 手动刷新在挂机状态下必须把接口返回的数据写入总览，而不是被轮询保护提前跳过。 */
test('console page: manual overview refresh renders data while looping', async () => {
  const { context, calls, node } = pageFixture({ looping: true });
  await vm.runInContext('loadAccounts(false)', context);
  assert.equal(node('overview-refresh').disabled, false);

  await node('overview-refresh').onclick();

  assert.equal(calls.filter(route => route === '/api/overview').length, 1);
  assert.equal(node('res').children.length, 1);
  assert.match(node('res').children[0].innerText, /金币/);
});

/** 在途总览保留旧的已连接状态，断开完成后必须丢弃这条迟到响应。 */
test('console page: a late overview cannot restore the disconnected buttons or snapshot', async () => {
  const { context, node } = pageFixture();
  await vm.runInContext('loadAccounts(false)', context);
  const fetch = context.fetch;
  let releaseOverview;
  let reportStarted;
  const started = new Promise(resolve => { reportStarted = resolve; });
  const delayed = new Promise(resolve => { releaseOverview = resolve; });
  // 先生成“已连接”响应再延迟交付，模拟服务器已完成但浏览器仍在等待的旧请求。
  context.fetch = async url => {
    const response = await fetch(url);
    if (url.split('?')[0] === '/api/overview') {
      reportStarted();
      await delayed;
    }
    return response;
  };
  const refreshing = vm.runInContext('refreshOverview()', context);
  await started;
  try { await node('disconnect').onclick(); }
  finally { releaseOverview(); }
  await refreshing;
  assert.equal(vm.runInContext('snapshot.connected', context), false);
  assert.equal(node('connect').disabled, false);
  assert.equal(node('disconnect').disabled, true);
});

/** 拖选尚未形成浏览器 Selection 时，日志更新也不能裁剪节点或强制滚动。 */
test('console page: pointer drag protects pending runtime-log selection', () => {
  const { context, node, window } = pageFixture();
  const log = node('log');
  log.clientHeight = 100;
  log.scrollHeight = 200;
  log.scrollTop = 100;
  vm.runInContext("for (let i = 0; i < 400; i += 1) appendLog({ t: 0, level: 'info', message: String(i) });", context);

  log.scrollTop = 100;
  log.emit('pointerdown');
  vm.runInContext("appendLog({ t: 0, level: 'info', message: 'during-drag' });", context);
  assert.equal(log.childElementCount, 401);
  assert.equal(log.scrollTop, 100);

  window.emit('pointerup');
  vm.runInContext("appendLog({ t: 0, level: 'info', message: 'after-drag' });", context);
  assert.equal(log.childElementCount, 400);
  assert.equal(log.scrollTop, 200);
});

/** 自动化日志复制按钮必须写入实际运行结果面板的当前内容。 */
test('console page: automation copy button writes the current automation log to clipboard', async () => {
  const { context, node, clipboardWrites } = pageFixture();
  node('automation-view').textContent = '[10:00:00] [成功] 农田 收割完成\n[10:00:01] [跳过] 世界 无可用舰队';

  await node('automation-log-copy').onclick();
  assert.equal(clipboardWrites.length, 1);
  assert.match(clipboardWrites[0], /收割完成/);
  assert.match(clipboardWrites[0], /无可用舰队/);
  assert.equal(node('automation-log-copy-hint').textContent, '已复制当前自动化日志');
});

/** 消息接口按账号返回进程内缓存，不能把一个账号收到的消息泄露给另一个账号。 */
test('console: messages endpoint keeps account caches isolated', async t => {
  mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const sessionA = app.sessions.get('connection-a');
  sessionA.client.emit('message', { name: 'SCChatReceive', body: { channel: 1, message: { content: { text: '只属于 A' }, timestamp: 100 } } });
  const own = await api('/api/messages', undefined, 'connection-a');
  const other = await api('/api/messages', undefined, 'connection-b');
  assert.equal(own.value.messages.world.length, 1);
  assert.equal(own.value.messages.world[0].text, '只属于 A');
  assert.equal(other.value.messages.world.length, 0);
});

/** 页面消息面板读取服务端快照后只显示当前 tab，并保留系统消息的文本内容。 */
test('console page: message panel renders the selected tab from the memory snapshot', async () => {
  const { context, node } = pageFixture();
  const originalFetch = context.fetch;
  context.fetch = async url => {
    if (url.split('?')[0] === '/api/messages') {
      return { ok: true, json: async () => ({ connected: true, errors: [], messages: {
        world: [{ id: 'w1', kind: 'world', at: 100000, sender: { nickname: '玩家' }, text: '世界消息' }],
        notice: [{ id: 'n1', kind: 'notice', at: 100001, sender: { nickname: '系统' }, text: '系统公告' }],
        private: [], guild: [],
      } }) };
    }
    return originalFetch(url);
  };
  await vm.runInContext('loadMessages()', context);
  assert.equal(node('message-list').children.length, 1);
  assert.match(node('message-list').children[0].innerText, /世界消息/);
  vm.runInContext("selectMessageTab('notice')", context);
  assert.match(node('message-list').children.at(-1).innerText, /系统公告/);
});

/** 账号页读取并保存当前账号独立的企微机器人地址，不能借用完整自动化设置接口。 */
test('console page: account tab saves the current WeCom notification settings', async () => {
  const { context, calls, getNotifications, node, notificationRequests } = pageFixture();
  await vm.runInContext('renderWecomNotification()', context);
  assert.equal(node('wecom-enabled').checked, false);
  assert.equal(node('wecom-webhook').value, '');

  node('wecom-enabled').checked = true;
  node('wecom-webhook').value = ' https://wecom.invalid/robot ';
  await node('wecom-save').onclick();

  assert.equal(calls.filter(route => route === '/api/accounts/notifications').length, 2);
  assert.deepEqual(notificationRequests, [{ confirm: true, notifications: { wecom: { enabled: true, webhook: 'https://wecom.invalid/robot' } } }]);
  assert.deepEqual(getNotifications(), { wecom: { enabled: true, webhook: 'https://wecom.invalid/robot' } });
  assert.equal(node('wecom-hint').textContent, '企微通知已保存');
});

/** 账号通知接口应按账号保存，且只更新企微通知字段。 */
test('console: account WeCom notification endpoint keeps settings isolated', async t => {
  const { api } = await consoleFixture(t);
  const initial = await api('/api/accounts/notifications');
  assert.deepEqual(initial.value.notifications, { wecom: { enabled: false, webhook: '' } });

  const notifications = { wecom: { enabled: true, webhook: 'https://wecom.invalid/robot' } };
  const saved = await api('/api/accounts/notifications', { confirm: true, notifications });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.notifications, notifications);
  assert.deepEqual((await api('/api/accounts/notifications', undefined, 'connection-b')).value.notifications, { wecom: { enabled: false, webhook: '' } });
});

/** 等待后台重连任务完成，超时后给出明确的异步恢复失败信号。 */
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

/** 单次自动化因业务错误结束时，已启用的企微机器人必须收到包含原因的停止通知。 */
test('console: failed one-off automation sends a WeCom stop notification', async t => {
  const { messages, webhook } = await wecomFixture(t);
  mockGateway(t, undefined, async (name) => {
    if (name === 'AllItemRequest') throw new Error('模拟库存读取失败');
    return {};
  });
  const { api } = await consoleFixture(t);
  const settings = defaultSettings();
  settings.modules.cargo.enabled = true;
  settings.notifications.wecom = { enabled: true, webhook };
  saveSettings('connection-a', settings);

  assert.equal((await api('/api/connect', {})).status, 200);
  assert.equal((await api('/api/automation/run', { confirm: true, modules: 'cargo' })).status, 200);
  await waitFor(() => messages.length === 1, '单次自动化失败后未发送企微停止通知');

  assert.match(messages[0].text.content, /自动化异常停止/);
  assert.match(messages[0].text.content, /单次自动化/);
  assert.match(messages[0].text.content, /模拟库存读取失败/);
});

/** 循环内的自动化模块报错同样需要通知，不能只覆盖单次执行入口。 */
test('console: failed automation loop sends a WeCom stop notification', async t => {
  const { messages, webhook } = await wecomFixture(t);
  mockGateway(t, undefined, async (name) => {
    if (name === 'AllItemRequest') throw new Error('模拟循环库存读取失败');
    return {};
  });
  const { api } = await consoleFixture(t);
  const settings = defaultSettings();
  settings.modules.cargo.enabled = true;
  settings.notifications.wecom = { enabled: true, webhook };
  saveSettings('connection-a', settings);

  assert.equal((await api('/api/connect', {})).status, 200);
  assert.equal((await api('/api/loop/start', { confirm: true, automationOnly: true, modules: ['cargo'], rounds: 1, everySeconds: 1 })).status, 200);
  await waitFor(() => messages.length === 1, '循环自动化失败后未发送企微停止通知');

  assert.match(messages[0].text.content, /自动化异常停止/);
  assert.match(messages[0].text.content, /自动挂机/);
  assert.match(messages[0].text.content, /模拟循环库存读取失败/);
});

/** 用户点击停止是明确的人工意图，不能把它误报为自动化异常。 */
test('console: manually stopped automation does not send a WeCom stop notification', async t => {
  const { messages, webhook } = await wecomFixture(t);
  let releaseStock;
  let stockRequestStarted;
  const started = new Promise(resolve => { stockRequestStarted = resolve; });
  const delayed = new Promise(resolve => { releaseStock = resolve; });
  mockGateway(t, undefined, async (name) => {
    if (name === 'AllItemRequest') {
      stockRequestStarted();
      await delayed;
    }
    return {};
  });
  const { api } = await consoleFixture(t);
  const settings = defaultSettings();
  settings.modules.cargo.enabled = true;
  settings.notifications.wecom = { enabled: true, webhook };
  saveSettings('connection-a', settings);

  assert.equal((await api('/api/connect', {})).status, 200);
  assert.equal((await api('/api/automation/run', { confirm: true, modules: 'cargo' })).status, 200);
  await started;
  assert.equal((await api('/api/automation/stop', { confirm: true })).status, 200);
  releaseStock();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(messages.length, 0);
});

/** 异常断线已有专属消息；它中止自动化时不能再额外发送一条停止通知。 */
test('console: unexpected disconnect sends only the existing WeCom disconnect notification', async t => {
  const { messages, webhook } = await wecomFixture(t);
  let releaseStock;
  let stockRequestStarted;
  const started = new Promise(resolve => { stockRequestStarted = resolve; });
  const delayed = new Promise(resolve => { releaseStock = resolve; });
  mockGateway(t, undefined, async (name) => {
    if (name === 'AllItemRequest') {
      stockRequestStarted();
      await delayed;
    }
    return {};
  });
  const { app, api } = await consoleFixture(t);
  const settings = defaultSettings();
  settings.modules.cargo.enabled = true;
  settings.notifications.wecom = { enabled: true, webhook };
  saveSettings('connection-a', settings);

  assert.equal((await api('/api/connect', {})).status, 200);
  assert.equal((await api('/api/automation/run', { confirm: true, modules: 'cargo' })).status, 200);
  await started;
  const client = app.sessions.get('connection-a').client;
  client.emit('fatal', { reason: 'SCChannelExpired' });
  client.stop();
  releaseStock();
  await waitFor(() => messages.length === 1, '异常断线后未发送企微断线通知');
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.match(messages[0].text.content, /连接异常断开/);
  assert.doesNotMatch(messages[0].text.content, /自动化异常停止/);
  assert.equal(messages.length, 1);
});

/** 顶号表示另一位置已接管账号；通知后必须停止旧连接且不能创建第二次自动登录。 */
test('console: SCChannelExpired does not auto reconnect', async t => {
  const login = mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const session = app.sessions.get('connection-a');
  const oldClient = session.client;

  oldClient.emit('fatal', { reason: 'SCChannelExpired' });
  oldClient.stop();
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(login.mock.callCount(), 1);
  assert.ok(session.log.some(entry => entry.message.includes('这个账号在别处登录了')));
});

/** 心跳超时要在停止旧会话后重连，并使用断线前的循环快照恢复自动挂机。 */
test('console: heartbeat timeout reconnects and restores the prior loop', async t => {
  const login = mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const session = app.sessions.get('connection-a');
  session.loop.running = true;
  session.loop.stop = { aborted: false };
  session.loop.options = {
    automationOnly: true,
    rounds: 1,
    everyMs: 1000,
    modules: ['farm'],
    allowPaid: false,
    allowSpeedUp: false,
    allowReroll: false,
  };
  // 模拟旧循环 finally 释放运行标记；恢复只能在这一步完成后创建新循环。
  session.loop.promise = Promise.resolve().then(() => {
    session.loop.running = false;
    session.loop.promise = null;
  });

  session.client.emit('warn', 'ping timeout');
  await waitFor(
    () => login.mock.callCount() === 2 && session.log.some(entry => entry.message === '已恢复断线前的自动挂机'),
    '心跳超时后未完成自动重连与挂机恢复',
  );

  assert.equal(session.loop.options.automationOnly, true);
  assert.deepEqual(session.loop.options.modules, ['farm']);
  assert.ok(session.log.some(entry => entry.message.startsWith('已自动重连：服务器心跳超时')));
});

for (const route of ['/api/loop/stop', '/api/automation/stop']) {
  for (const phase of ['old-loop', 'login']) {
    /** 两个停止入口在重连的两个等待阶段都必须撤销旧挂机的恢复意图，连接本身仍可恢复。 */
    test(`console: ${route} during reconnect ${phase} prevents loop restoration`, async t => {
      let loginCount = 0;
      let releaseLogin;
      let releaseOldLoop;
      const login = mockGateway(t, async () => {
        loginCount += 1;
        // 让用户停止请求稳定落在第二次登录等待期间，不依赖网络时序。
        if (loginCount === 2 && phase === 'login') await new Promise(resolve => { releaseLogin = resolve; });
        return { result: 0, initSeqNo: 1, playerInfo: { playerId: '1', nickname: '离线角色', level: 1 } };
      });
      const { app, api } = await consoleFixture(t);
      assert.equal((await api('/api/connect', {})).status, 200);
      const session = app.sessions.get('connection-a');
      session.loop.running = true;
      session.loop.options = { automationOnly: true, rounds: 1, everyMs: 1000, modules: ['farm'], allowPaid: false, allowSpeedUp: false, allowReroll: false };
      const originalStop = session.loop.stop;
      const originalRunId = session.loop.runId;
      session.loop.promise = new Promise(resolve => { releaseOldLoop = resolve; }).then(() => {
        session.loop.running = false;
        session.loop.promise = null;
      });
      t.after(() => { releaseOldLoop(); releaseLogin?.(); });

      session.client.emit('warn', 'ping timeout');
      assert.ok(session.reconnect);
      if (phase === 'login') {
        releaseOldLoop();
        await waitFor(() => Boolean(releaseLogin), '自动重连未进入登录等待阶段');
      }
      assert.equal((await api(route, { confirm: true })).status, 200);
      assert.equal(originalStop.manuallyStopped, true);
      releaseOldLoop();
      releaseLogin?.();
      await waitFor(() => session.reconnect === null, '主动停止后的重连任务未退出');

      assert.equal(login.mock.callCount(), 2);
      assert.equal(session.client.connected, true);
      assert.equal(session.loop.running, false);
      assert.equal(session.loop.runId, originalRunId);
      assert.equal(session.loop.stop, originalStop);
      assert.equal(session.log.some(entry => entry.message === '已恢复断线前的自动挂机'), false);
    });
  }
}
