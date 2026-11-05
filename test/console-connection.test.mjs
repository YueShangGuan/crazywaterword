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
const { automationEntryLogLevel, createConsole, parseGiftCodes } = await import('../src/server.mjs');
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
  return { app, api, base };
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

/** 已确认的主线战败是正常业务结果，其他失败状态仍须以错误样式展示。 */
test('console: mainline loss uses the normal log style', () => {
  assert.equal(automationEntryLogLevel({ request: 'ChallengeStageRequest', status: 'failed' }), 'info');
  assert.equal(automationEntryLogLevel({ request: 'TrialRaidChallengeRequest', status: 'failed' }), 'info');
  assert.equal(automationEntryLogLevel({ request: 'TrialRaidChallengeRequest', status: 'failed', reason: '试炼进度读回失败' }), 'error');
  assert.equal(automationEntryLogLevel({ request: 'ChallengeStageRequest', status: 'rejected' }), 'error');
});

/** 兑换码文本只能去除分隔空白和重复项，不能更改服务端可能区分的大小写。 */
test('console: batch gift code parser preserves order and case', () => {
  assert.deepEqual(parseGiftCodes(' A\nB, A， b\r\n ,C '), ['A', 'B', 'b', 'C']);
});

/** 在线账号必须按账号、兑换码顺序发送明确回包请求，重复码在服务端解析阶段即排除。 */
test('console: batch gift codes redeem online accounts in account-code order', async t => {
  const requests = [];
  mockGateway(t, undefined, async function (name, body, response) {
    if (name === 'GotGiftCodeRequest') {
      requests.push({ client: this, body, response });
      return { reward: { asset: [{ type: 0, id: '木材', num: 2 }] } };
    }
    return {};
  });
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  assert.equal((await api('/api/connect', {}, 'connection-b')).status, 200);
  assert.equal(app.sessions.get('connection-a').client.connected, true);
  assert.equal(app.sessions.get('connection-b').client.connected, true);
  assert.equal(app.sessions.get('connection-a').busy, null);
  assert.equal(app.sessions.get('connection-b').busy, null);

  const started = await api('/api/gift-codes/redeem', { confirm: true, codes: 'FIRST, SECOND\nFIRST' });
  assert.equal(started.status, 200);
  assert.deepEqual(started.value.codes, ['FIRST', 'SECOND']);
  // 首次奖励摘要会加载本地配置表；允许冷缓存解析完成，仍验证最终的严格账号、兑换码顺序。
  await waitFor(() => requests.length === 4, () => '批量兑换未完成两个在线账号的顺序请求：' + JSON.stringify(requests), 300);

  assert.deepEqual(requests, [
    { client: app.sessions.get('connection-a').client, body: { giftCode: 'FIRST' }, response: 'GotRewardResponse' },
    { client: app.sessions.get('connection-a').client, body: { giftCode: 'SECOND' }, response: 'GotRewardResponse' },
    { client: app.sessions.get('connection-b').client, body: { giftCode: 'FIRST' }, response: 'GotRewardResponse' },
    { client: app.sessions.get('connection-b').client, body: { giftCode: 'SECOND' }, response: 'GotRewardResponse' },
  ]);
  assert.equal(app.sessions.get('connection-a').busy, null);
  assert.equal(app.sessions.get('connection-b').busy, null);
});

/** 离线账号只能写明未调用，批次不能为了兑换码隐式使用保存的凭证重新登录。 */
test('console: batch gift codes skip offline accounts without connecting them', async t => {
  const login = mockGateway(t, undefined, async function (name) {
    if (name === 'GotGiftCodeRequest') return { reward: { asset: [] } };
    return {};
  });
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  const started = await api('/api/gift-codes/redeem', { confirm: true, codes: 'ONLINE-ONLY' });
  assert.equal(started.status, 200);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(login.mock.callCount(), 1);
});

/** 忙碌账号的批次保留全局单活锁，释放原业务锁后才可发送兑换请求。 */
test('console: batch gift codes wait for a busy account and reject a second batch', async t => {
  const requests = [];
  mockGateway(t, undefined, async function (name, body) {
    if (name === 'GotGiftCodeRequest') requests.push(body.giftCode);
    return { reward: { asset: [] } };
  });
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  const session = app.sessions.get('connection-a');
  session.busy = 'POST /api/tasks/run';

  assert.equal((await api('/api/gift-codes/redeem', { confirm: true, codes: 'WAIT-ME' })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(requests, []);
  const duplicate = await api('/api/gift-codes/redeem', { confirm: true, codes: 'SECOND-BATCH' });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.value.error, /正在执行/);

  session.busy = null;
  await waitFor(() => requests.length === 1, '原业务锁释放后批量兑换没有继续');
});

/** Prompt 拒绝是单码业务结果；仍在线时必须继续处理后续兑换码。 */
test('console: batch gift codes continue after a server prompt rejection', async t => {
  const requests = [];
  mockGateway(t, undefined, async function (name, body) {
    if (name !== 'GotGiftCodeRequest') return {};
    requests.push(body.giftCode);
    if (body.giftCode === 'REJECTED') {
      // 客户端只在 PromptResponse 已明确归属时附加 prompt；这与超时等未知终态不同。
      const error = new Error('server prompt: invalid gift code');
      error.prompt = { prompt: 1 };
      throw error;
    }
    return { reward: { asset: [] } };
  });
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  assert.equal((await api('/api/gift-codes/redeem', { confirm: true, codes: 'REJECTED, NEXT' })).status, 200);
  await waitFor(() => requests.length === 2, 'Prompt 拒绝后没有继续下一兑换码');
  assert.deepEqual(requests, ['REJECTED', 'NEXT']);
});

/** 超时后响应可能迟到且无请求 ID；当前账号必须停止，避免把旧回包归属给下一兑换码。 */
test('console: batch gift codes stop the account after a response timeout', async t => {
  const requests = [];
  mockGateway(t, undefined, async function (name, body) {
    if (name !== 'GotGiftCodeRequest') return {};
    requests.push(body.giftCode);
    if (body.giftCode === 'TIMEOUT') throw new Error('timeout waiting for GotRewardResponse (sent GotGiftCodeRequest)');
    return { reward: { asset: [] } };
  });
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  assert.equal((await api('/api/gift-codes/redeem', { confirm: true, codes: 'TIMEOUT, NEXT' })).status, 200);
  await waitFor(() => requests.length === 1, '超时兑换码没有发出');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(requests, ['TIMEOUT']);
});

/** 连接中止后必须停止该账号剩余码，同时继续处理下一个仍在线账号。 */
test('console: batch gift codes stop an account after its connection fails', async t => {
  const requests = [];
  let brokenClient = null;
  mockGateway(t, undefined, async function (name, body) {
    if (name !== 'GotGiftCodeRequest') return {};
    requests.push({ client: this, code: body.giftCode });
    if (!brokenClient) {
      brokenClient = this;
      this.setState('STOPPED');
      throw new Error('socket closed');
    }
    return { reward: { asset: [] } };
  });
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  assert.equal((await api('/api/connect', {}, 'connection-b')).status, 200);
  assert.equal((await api('/api/gift-codes/redeem', { confirm: true, codes: 'BREAK, SHOULD-NOT-SEND' })).status, 200);
  await waitFor(() => requests.length === 3, '连接故障后没有继续处理下一在线账号');
  assert.deepEqual(requests, [
    { client: app.sessions.get('connection-a').client, code: 'BREAK' },
    { client: app.sessions.get('connection-b').client, code: 'BREAK' },
    { client: app.sessions.get('connection-b').client, code: 'SHOULD-NOT-SEND' },
  ]);
});

/** 跨账号批次以全局 SSE 广播，当前账号页也必须收到其他账号的逐条兑换结果。 */
test('console: batch gift code events broadcast all account results through SSE', async t => {
  mockGateway(t, undefined, async name => name === 'GotGiftCodeRequest' ? { reward: { asset: [] } } : {});
  const { api, base } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  assert.equal((await api('/api/connect', {}, 'connection-b')).status, 200);
  let stream;
  let events = '';
  await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/events?account=connection-a', response => {
      stream = response;
      response.setEncoding('utf8');
      response.on('data', chunk => { events += chunk; });
      resolve();
    });
    request.on('error', reject);
  });
  t.after(() => stream?.destroy());

  assert.equal((await api('/api/gift-codes/redeem', { confirm: true, codes: 'SSE-CODE' })).status, 200);
  await waitFor(() => events.includes('"accountId":"connection-b"') && events.includes('"phase":"summary"'),
    () => 'SSE 未广播其他账号的兑换结果或汇总：' + events, 150);
});

/** 设置页读取海盗次数只能复用已连接会话，不能为展示数据隐式登录游戏。 */
test('console: pirate sweep status reports the current role without implicit login', async t => {
  const login = mockGateway(t, async () => ({ result: 0, initSeqNo: 1, playerInfo: { playerId: '1', nickname: '离线角色', level: 1, vip: { vipLevel: 12 } } }), async name => name === 'AllPirateRequest' ? { sweepTimes: 4 } : {});
  const { api } = await consoleFixture(t);
  const disconnected = await api('/api/automation/pirate-sweep-status');
  assert.equal(disconnected.status, 200);
  assert.deepEqual(disconnected.value, { connected: false });
  assert.equal(login.mock.callCount(), 0);

  assert.equal((await api('/api/connect', {})).status, 200);
  const connected = await api('/api/automation/pirate-sweep-status');
  assert.equal(connected.status, 200);
  assert.deepEqual(connected.value, { connected: true, dailyLimit: 30, used: 4, remaining: 26 });
});

/** 在线保存海盗目标时必须用当前角色 VIP 上限拒绝超额设置。 */
test('console: pirate sweep settings enforce the connected role daily cap', async t => {
  const login = mockGateway(t, async () => ({ result: 0, initSeqNo: 1, playerInfo: { playerId: '1', nickname: 'VIP12角色', level: 1, vip: { vipLevel: 12 } } }), async name => name === 'AllPirateRequest' ? { sweepTimes: 0 } : {});
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const settings = defaultSettings();
  settings.modules.world.pirate.dailySweepLimit = 31;
  settings.modules.world.pirate.sweepTypes = [{ type: 1, times: 31 }];
  const rejected = await api('/api/automation/settings', { confirm: true, settings });
  assert.equal(rejected.status, 400);
  assert.match(rejected.value.error, /当前角色上限 30/);
  assert.equal(login.mock.callCount(), 1);
});

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

/** 总览接口只读账号缓存，连续请求不得再次向游戏发送整组查询。 */
test('console: concurrent overview requests read the in-memory cache', async t => {
  mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const session = app.sessions.get('connection-a');
  await waitFor(() => !session.cache.syncing && !session.cache.initialSync, '登录后的总览缓存没有完成首次同步');
  let queryCount = 0;
  t.mock.method(GameClient.prototype, 'request', async () => { queryCount += 1; return {}; });
  const first = api('/api/overview');
  const second = api('/api/overview');
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(queryCount, 0);
  assert.deepEqual(firstResponse.value.cache, secondResponse.value.cache);
});

/** 空闲定时同步失败时保留农田旧快照，并把生产分类标记为过期和报错。 */
test('console: idle cache refresh preserves the last trusted category value on failure', async t => {
  let failFarm = false;
  let refresh;
  mockGateway(t, undefined, async function (name) {
    if (failFarm && name === 'OnWaterRequest') throw new Error('农田状态读取失败');
    if (name === 'OnWaterRequest') return { building: [{ buildingId: '1农田', farm: { productId: '小麦', ripeTime: 123 } }] };
    return {};
  });
  t.mock.method(globalThis, 'setInterval', callback => {
    refresh = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const session = app.sessions.get('connection-a');
  await waitFor(() => typeof refresh === 'function' && !session.cache.syncing && !session.cache.initialSync, '空闲总览定时器没有启动');
  const before = await api('/api/overview');
  const productionBefore = before.value.production;
  const categoryBefore = before.value.cache.categories.production;

  failFarm = true;
  refresh();
  await waitFor(() => !session.cache.syncing && session.cache.categories.get('production')?.stale === true, '农田分类失败后没有标记过期');
  const after = await api('/api/overview');
  assert.deepEqual(after.value.production, productionBefore);
  assert.equal(after.value.cache.categories.production.updatedAt, categoryBefore.updatedAt);
  assert.match(after.value.cache.categories.production.error, /农田状态读取失败/);
});

/** 只读总览在挂机循环运行期间仍可查询，避免手动刷新被写操作保护拦截。 */
test('console: overview remains readable while the loop is running', async t => {
  mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  await waitFor(() => !app.sessions.get('connection-a').cache.syncing, '核心总览缓存没有完成同步');
  const session = app.sessions.get('connection-a');
  session.loop.running = true;
  const response = await api('/api/overview');
  assert.equal(response.status, 200);
  assert.equal(response.value.status.connected, true);
  session.loop.running = false;
});

/** 总览读取万吨货轮后只为当前目标查询一次占有榜，并匹配当前角色名次。 */
test('console: overview includes merchant ship reward and current role rank', async t => {
  mockGateway(t,
    async () => ({ result: 0, initSeqNo: 1, playerInfo: { playerId: '42', nickname: '万吨角色', level: 10 } }),
    async function (name, body) {
      if (name === 'TreasureLootStatsRequest') return { todayRewardTimes: 3 };
      if (name === 'TreasureLootListRequest') return { treasure: [{ uid: 77, color: 5, reward: { asset: [{ type: 0, id: '高级宝箱', num: 2 }] } }] };
      if (name === 'TreasureLootRankRequest') {
        assert.deepEqual(body, { uid: 77 });
        return { items: [{ playerId: '42', rank: 4, rewardTimes: 1 }] };
      }
      return {};
    });
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  await waitFor(() => !app.sessions.get('connection-a').cache.syncing, '核心总览缓存没有完成同步');
  const overview = await api('/api/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.value.merchantShip.remainingRewardTimes, 3);
  assert.equal(overview.value.merchantShip.uid, 77);
  assert.equal(overview.value.merchantShip.rank, 4);
  assert.deepEqual(overview.value.merchantShip.reward.map(({ id, num }) => ({ id, num })), [{ id: '高级宝箱', num: 2 }]);
});

/** 没有万吨货轮时总览仍返回次数，且不会发起占有榜查询。 */
test('console: overview keeps merchant reward count without an active ship', async t => {
  const rankRequests = [];
  mockGateway(t, undefined, async function (name) {
    if (name === 'TreasureLootStatsRequest') return { todayRewardTimes: 1 };
    if (name === 'TreasureLootListRequest') return { treasure: [{ uid: 78, color: 4 }] };
    if (name === 'TreasureLootRankRequest') rankRequests.push(name);
    return {};
  });
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  await waitFor(() => !app.sessions.get('connection-a').cache.syncing, '总览缓存没有完成首次同步');
  const overview = await api('/api/overview');
  assert.equal(overview.value.merchantShip.remainingRewardTimes, 1);
  assert.equal(overview.value.merchantShip.uid, null);
  assert.deepEqual(rankRequests, []);
});

/** 总览可以读取忙碌账号，但不能接管业务锁或在总览结束时提前释放它。 */
test('console: overview preserves an active operation busy lock', async t => {
  mockGateway(t);
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  await waitFor(() => !app.sessions.get('connection-a').cache.syncing, '核心总览缓存没有完成同步');
  const session = app.sessions.get('connection-a');
  session.busy = 'POST /api/tasks/run';
  const response = await api('/api/overview');
  assert.equal(response.status, 200);
  assert.equal(response.value.status.connected, true);
  assert.equal(session.busy, 'POST /api/tasks/run');
  session.busy = null;
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
  const giftRedeemRequests = [];
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
      else if (route === '/api/gift-codes/redeem') {
        const payload = JSON.parse(options.body);
        giftRedeemRequests.push(payload);
        data = { started: true, batchId: 'page-gift', codes: ['CODE-A', 'CODE-B'] };
      }
      else if (route === '/api/overview') data = { status, resources: [{ name: '金币', amount: 123 }], items: { top: [] }, heroes: { list: [] } };
      else data = { ok: true };
      return { ok: true, json: async () => data };
    },
  });
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)[1];
  // 保留实际事件和轮询函数，仅移除启动调用，避免异步 boot 干扰用例顺序。
  vm.runInContext(script.slice(0, script.lastIndexOf('boot();')), context);
  vm.runInContext("current = 'page-a'", context);
  return { context, calls, node, window, clipboardWrites, notificationRequests, giftRedeemRequests, getNotifications: () => notifications };
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

/** 自动和手动总览刷新在挂机状态下都必须把接口返回的数据写入总览。 */
test('console page: manual overview refresh renders data while looping', async () => {
  const { context, calls, node } = pageFixture({ looping: true });
  await vm.runInContext('loadAccounts(false)', context);
  assert.equal(node('overview-refresh').disabled, false);

  await vm.runInContext('refreshOverview()', context);
  await node('overview-refresh').onclick();

  assert.equal(calls.filter(route => route === '/api/overview').length, 2);
  assert.ok(node('res').children.length >= 1);
  assert.match(node('res').innerText, /金币/);
});

/** 生产面板传给通用表格的图文项必须使用 name，不能泄露未被渲染的协议字段 id。 */
test('console page: production panel passes product names to the table renderer', () => {
  const { context } = pageFixture();
  let farmRows = null;
  let factoryRows = null;
  // 该用例只核对生产数据到表格的字段契约，不依赖完整浏览器模板的 DOM 实现。
  context.chip = () => context.document.createElement('span');
  context.table = (headers, rows) => {
    if (headers[0] === '农田') farmRows = rows;
    if (headers[0] === '工厂') factoryRows = rows;
    return context.document.createElement('table');
  };

  vm.runInContext(`renderOverviewProduction({ production: { farms: [
    { buildingId: '1农田', productId: '小麦', icon: null, ripeTime: 1 },
  ], factories: [
    { buildingId: '1食品厂', queue: [{ productId: '香煎鱼排', icon: null, finishTime: 1 }], autoProductId: null, finished: [] },
    { buildingId: '1海水厂', queue: [], autoProductId: '淡水', autoIcon: null, finished: [] },
  ] } })`, context);

  assert.equal(farmRows[0][1].cells[0].name, '小麦');
  assert.equal(factoryRows[0][1].cells[0].name, '香煎鱼排');
  assert.equal(factoryRows[1][1].cells[0].name, '自动：淡水');
});

/** 万吨货轮卡片按有船和无船两种状态显示次数、奖品、排名或空状态提示。 */
test('console page: merchant ship panel renders active and absent states', () => {
  const active = pageFixture();
  const { context, node } = active;
  vm.runInContext(`renderOverviewMerchantShip({ merchantShip: {
    remainingRewardTimes: 2, uid: 77, reward: [{ name: '高级宝箱', num: 3 }], rank: 5,
  } })`, context);
  assert.match(node('overview-merchant-ship').innerText, /今日剩余领奖次数/);
  assert.match(node('overview-merchant-ship').innerText, /高级宝箱 ×3/);
  assert.match(node('overview-merchant-ship').innerText, /第 5 名/);

  const absent = pageFixture();
  vm.runInContext(`renderOverviewMerchantShip({ merchantShip: {
    remainingRewardTimes: 1, uid: null, reward: [], rank: null,
  } })`, absent.context);
  assert.match(absent.node('overview-merchant-ship').innerText, /当前不存在万吨货轮/);
  assert.doesNotMatch(absent.node('overview-merchant-ship').innerText, /当前奖品/);
});

/** 手动刷新不能因自动化状态轮询或已有业务请求计数而丢弃服务端返回的总览。 */
test('console page: manual overview refresh waits through page business activity', async () => {
  const { context, calls, node } = pageFixture({ looping: true });
  await vm.runInContext('loadAccounts(false)', context);
  vm.runInContext("automationRunning = true; activeBusinessRequests = 1", context);

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

/** 页面提交必须带确认标记，并将 SSE 的逐条结果和汇总同步到账号页结果区。 */
test('console page: batch gift code submit and realtime result panel stay in sync', async () => {
  const { context, giftRedeemRequests, node } = pageFixture();
  node('batch-redeem-codes').value = ' CODE-A\nCODE-B ';
  await vm.runInContext("submitGiftCodeBatch(document.getElementById('batch-redeem-codes').value)", context);

  assert.deepEqual(giftRedeemRequests, [{ confirm: true, codes: ' CODE-A\nCODE-B ' }]);
  assert.equal(node('batch-redeem-run').disabled, true);
  vm.runInContext("appendLog({ id: 801, t: 0, level: 'info', message: '批量兑换 · 开始', extra: { batchRedeem: { id: 'page-gift', phase: 'start' } } })", context);
  vm.runInContext("appendLog({ id: 802, t: 1, level: 'info', message: '兑换码 CODE-A 兑换成功：木材 × 2', extra: { batchRedeem: { id: 'page-gift', phase: 'result', status: 'success', accountTitle: '账号 A', code: 'CODE-A', rewards: '木材 × 2' } } })", context);
  vm.runInContext("appendLog({ id: 803, t: 2, level: 'info', message: '本批结束：在线 1 个，离线 0 个，成功 1 次，失败 0 次', extra: { batchRedeem: { id: 'page-gift', phase: 'summary', succeeded: 1, failed: 0, offline: 0 } } })", context);

  assert.equal(node('batch-redeem-results').children.length, 1);
  assert.match(node('batch-redeem-results').children[0].innerText, /CODE-A/);
  assert.equal(node('batch-redeem-summary').textContent, '成功 1 · 失败 0 · 离线 0');
  assert.equal(node('batch-redeem-run').disabled, false);
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
async function waitFor(predicate, message, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(typeof message === 'function' ? message() : message);
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
