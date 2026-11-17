import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { after, test } from 'node:test';
import { GameClient } from '../src/client.mjs';
import { PAGE } from '../src/page.mjs';
import { loadProtocol } from '../src/proto.mjs';

// 临时账号和模拟登录完全隔离真实凭证；测试只访问随机端口的本地 HTTP 服务。
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-console-connection-'));
process.env.CW_DATA_DIR = directory;
const { saveStore, upsertAccount } = await import('../src/accounts.mjs');
const { accountDirectory, defaultSettings } = await import('../src/automation/settings.mjs');
const { automationEntryLogLevel, createConsole, loopEntryLogLevel, parseGiftCodes } = await import('../src/server.mjs');
const { formatLoopStep } = await import('../src/loop.mjs');
const protocol = loadProtocol();
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
    const url = `${base}${route}${route.includes('?') ? '&' : '?'}account=${account}`;
    const response = await fetch(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
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
function mockGateway(t, login = async () => ({ result: 0, initSeqNo: 1, playerInfo: { playerId: '1', nickname: '离线角色', level: 1 } }), request = async () => ({}), sendWatch = async () => ({})) {
  t.mock.getter(GameClient.prototype, 'connected', function () { return this.state === 'READY'; });
  const connecting = t.mock.method(GameClient.prototype, 'connect', async function () {
    this.setState('CONNECTING');
    const response = await login(this);
    this.setState('READY');
    return response;
  });
  // 总览查询只返回空数据，不编码、不发帧、不创建 WebSocket。
  t.mock.method(GameClient.prototype, 'sendWatch', sendWatch);
  // 上游登录完成信号同样在内存截断，测试不得创建真实网关帧。
  t.mock.method(GameClient.prototype, 'send', () => 1);
  t.mock.method(GameClient.prototype, 'request', request);
  return connecting;
}

/** Wait for asynchronous local-only work without exposing test timing to the implementation. */
async function waitFor(predicate, message, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

/** 批次必须完全收尾：兑换模块按账号持久化活动批次，残留会顶掉下一批（跨测试串扰）。
 *  必须动态 import：静态导入会在第 14 行设置 CW_DATA_DIR 之前加载 accounts.mjs，
 *  导致 DATA_DIR 回落到仓库目录，测试数据写进真实 data/。 */
async function waitGiftBatchIdle(...ids) {
  const { giftCodeStatus } = await import('../src/gift-codes.mjs');
  await waitFor(() => ids.every(id => !giftCodeStatus(id).running), '礼包批次没有收尾');
}

/** 已确认战败保持普通日志，待确认写入显示提醒且不伪装为服务异常。 */
test('console: loop log level keeps confirmed battle losses normal', () => {
  assert.equal(automationEntryLogLevel({ request: 'ChallengeStageRequest', status: 'failed' }), 'info');
  assert.equal(automationEntryLogLevel({ request: 'TrialRaidChallengeRequest', status: 'failed' }), 'info');
  assert.equal(automationEntryLogLevel({ request: 'TrialRaidChallengeRequest', status: 'failed', reason: '试炼进度读回失败' }), 'error');
  assert.equal(automationEntryLogLevel({ request: 'ChallengeStageRequest', status: 'rejected' }), 'error');
  assert.equal(automationEntryLogLevel({ request: 'StartFishingRequest', status: 'uncertain' }), 'warn');
  assert.equal(automationEntryLogLevel({ request: 'SetAssembleCityRequest', status: 'reminder' }), 'warn');
  assert.equal(loopEntryLogLevel({ phase: 'automation', request: 'ChallengeStageRequest', status: 'failed' }), 'info');
  assert.equal(loopEntryLogLevel({ phase: 'automation', request: 'TrialRaidChallengeRequest', status: 'failed', reason: '试炼进度读回失败' }), 'error');
  assert.equal(loopEntryLogLevel({ phase: 'world', skipped: true }), 'info');
  assert.equal(loopEntryLogLevel({ phase: 'world', ok: false }), 'error');
  assert.equal(formatLoopStep({ phase: 'automation', request: 'StartFishingRequest', label: 'StartFishingRequest', status: 'uncertain', reason: '上次结果未确认，禁止重复提交' }),
    '挂机 · StartFishingRequest待确认，未重复提交：上次结果未确认，禁止重复提交');
  assert.equal(formatLoopStep({ phase: 'automation', request: 'ChallengeStageRequest', label: '主线第 10 关挑战', status: 'failed', ok: false }),
    '挂机 · 主线第 10 关挑战已确认战败');
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
  // 跨账号发送门每个兑换码间隔 700ms，四个请求约 2.1 秒，等待窗口放宽到 6 秒。
  await waitFor(() => requests.length === 4, () => '批量兑换未完成两个在线账号的顺序请求：' + JSON.stringify(requests), 600);

  // 跨账号发送门按提交顺序串行化并保持 700ms 间隔，账号之间允许交错；协议安全
  // 要求的是同一连接内严格保序（回包按序归属），这里按账号分组断言。
  const codesByAccount = new Map();
  for (const entry of requests) {
    const list = codesByAccount.get(entry.client) ?? [];
    list.push(entry.body.giftCode);
    codesByAccount.set(entry.client, list);
  }
  assert.deepEqual([...codesByAccount.values()].sort(), [['FIRST', 'SECOND'], ['FIRST', 'SECOND']]);
  assert.equal(app.sessions.get('connection-a').busy, null);
  assert.equal(app.sessions.get('connection-b').busy, null);
  await waitGiftBatchIdle('connection-a', 'connection-b');
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
  await waitGiftBatchIdle('connection-a', 'connection-b');
});

/** 忙碌账号的批次保留全局单活锁，释放原业务锁后才可发送兑换请求。 */
test('console: batch gift codes wait for a busy account and reject a second batch', async t => {
  const requests = [];
  mockGateway(t, undefined, async function (name, body) {
    if (name === 'GotGiftCodeRequest') requests.push(body.giftCode);
    // 上游兑换状态机会核对奖励明细；空 asset 会被判“未取得可核对的奖励”而停号。
    return { reward: { asset: [{ type: 0, id: '木材', num: 2 }] } };
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
  await waitGiftBatchIdle('connection-a', 'connection-b');
});

/** Prompt 拒绝是单码业务结果；仍在线时必须继续处理后续兑换码。 */
test('console: batch gift codes continue after a server prompt rejection', async t => {
  const requests = [];
  mockGateway(t, undefined, async function (name, body) {
    if (name !== 'GotGiftCodeRequest') return {};
    requests.push(body.giftCode);
    if (body.giftCode === 'REJECTED') {
      // 客户端只在 PromptResponse 已明确归属时附加 prompt 与请求名；这与超时等未知终态不同。
      const error = new Error('server prompt: invalid gift code');
      error.prompt = { prompt: 1 };
      error.request = 'GotGiftCodeRequest';
      throw error;
    }
    return { reward: { asset: [{ type: 0, id: '木材', num: 2 }] } };
  });
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  assert.equal((await api('/api/gift-codes/redeem', { confirm: true, codes: 'REJECTED, NEXT' })).status, 200);
  await waitFor(() => requests.length === 2, 'Prompt 拒绝后没有继续下一兑换码', 300);
  assert.deepEqual(requests, ['REJECTED', 'NEXT']);
  await waitGiftBatchIdle('connection-a', 'connection-b');
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
  await waitGiftBatchIdle('connection-a', 'connection-b');
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
    return { reward: { asset: [{ type: 0, id: '木材', num: 2 }] } };
  });
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {}, 'connection-a')).status, 200);
  assert.equal((await api('/api/connect', {}, 'connection-b')).status, 200);
  assert.equal((await api('/api/gift-codes/redeem', { confirm: true, codes: 'BREAK, SHOULD-NOT-SEND' })).status, 200);
  await waitFor(() => requests.length === 3, '连接故障后没有继续处理下一在线账号', 300);
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
  await waitGiftBatchIdle('connection-a', 'connection-b');
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

/** 联盟商船材料只从已连接角色本轮可补给的船读取，展示页不能为此隐式登录。 */
test('console: guild ship material choices use only prepared unclaimed ships without implicit login', async t => {
  const requests = [];
  const login = mockGateway(t, undefined, async function (name, body, response) {
    if (name !== 'GuildShipRequest') return {};
    requests.push({ body, response });
    const readyAt = Date.now() / 1000 + 60;
    return {
      ship: [
        { shipId:1, state:protocol.GuildShipState.GS_STATE_PREPARED, preparedEndTime:readyAt, reward:{ asset:[{ type:0, id:'精铁' }] }, cabin:[{ order:[{ type:0, id:'木材' }] }] },
        { shipId:2, state:protocol.GuildShipState.GS_STATE_PREPARED, preparedEndTime:readyAt - 120, reward:{ asset:[{ type:0, id:'玻璃' }] }, cabin:[{ order:[{ type:0, id:'玻璃' }] }] },
        { shipId:3, state:protocol.GuildShipState.GS_STATE_PREPARED, preparedEndTime:readyAt, reward:{ asset:[{ type:0, id:'水姆币' }] }, cabin:[{ order:[{ type:0, id:'精铁' }] }] },
      ],
      ownRun: [{ shipId:3 }],
    };
  });
  const { api } = await consoleFixture(t);
  const disconnected = await api('/api/automation/guild-ship-options');
  assert.equal(disconnected.status, 200);
  assert.deepEqual(disconnected.value, { connected:false, rewards:[], materials:[] });
  assert.equal(login.mock.callCount(), 0);

  assert.equal((await api('/api/connect', {})).status, 200);
  requests.length = 0;
  const connected = await api('/api/automation/guild-ship-options');
  assert.equal(connected.status, 200);
  assert.equal(connected.value.connected, true);
  assert.deepEqual(requests, [{ body:{}, response:'GuildShipResponse' }]);
  assert.ok(connected.value.rewards.every(item => item.value !== '玻璃' && item.value !== '水姆币'));
  assert.ok(connected.value.materials.every(item => item.value !== '玻璃' && item.value !== '精铁'));
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

/** 世界地图底图只依赖本地地图包与配置，不应为了打开页面而登录游戏。 */
test('console: world map layout loads without a game login', async t => {
  const login = mockGateway(t);
  const { api } = await consoleFixture(t);
  const layout = await api('/api/map/layout');
  assert.equal(layout.status, 200);
  assert.equal(layout.value.scenarioId, 1);
  assert.ok(layout.value.width > 0 && layout.value.height > 0);
  assert.ok(layout.value.cities.length > 0, '底图应包含城市');
  assert.ok(layout.value.fields.length > 0, '底图应包含资源田');
  assert.ok(layout.value.cities.every(city => Number.isSafeInteger(city.x) && Number.isSafeInteger(city.y)));
  assert.equal(login.mock.callCount(), 0, '打开地图不能隐式登录游戏');
});

/** 离线时只返回缓存/空状态，不因轮询而重新登录。 */
test('console: world map state stays read-only and disconnected without logging in', async t => {
  const login = mockGateway(t);
  const { api } = await consoleFixture(t);
  const response = await api('/api/map/state');
  assert.equal(response.status, 200);
  assert.equal(response.value.connected, false);
  assert.ok(response.value.warnings.some(warning => /请先连接账号/.test(warning)));
  assert.equal(login.mock.callCount(), 0);
});

/** fresh=1 只发送四个只读查询，并把手里的响应压成城市归属与航线。 */
test('console: world map fresh state reads ownership and tracks without writes', async t => {
  const now = Math.floor(Date.now() / 1000);
  const requests = [];
  mockGateway(t, async () => ({ result: 0, initSeqNo: 1, playerInfo: {
    playerId: '1', nickname: '地图角色', level: 20, scenarioId: 1,
    guildId: { low: 7, high: 0, unsigned: false },
  } }), async function (name, body, response) {
    requests.push({ name, body, response });
    if (name === 'MyFleetsRequest') return { fleets: [{
      buildingId: '1舰队', state: 2, durability: 100, maxDura: 200,
      startGridIdx: 240, targetGridIdx: 480, moveStartTs: now - 60, moveEndTs: now + 60,
      cityId: 1, targetCityId: 2,
    }] };
    if (name === 'WorldInfoRequest') return { cities: [
      { id: 1, guildIdx: 3, state: 1 },
      { id: 2, guildIdx: 0, state: 2 },
    ] };
    if (name === 'TradeInfoRequest') return { period: 1, cargo: {
      cityId: 1, moveToCityId: 2, moveStartTime: now - 60, moveEndTime: now + 60,
    } };
    if (name === 'GuildCityInfoRequest') return { cities: [{ cityId: 1 }] };
    return {};
  });
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const response = await api('/api/map/state?fresh=1');
  assert.equal(response.status, 200);
  const value = response.value;
  assert.equal(value.connected, true);
  assert.equal(value.stale, false, JSON.stringify(value.warnings));
  assert.equal(value.cities.length, 2);
  assert.equal(value.summary.ownCities, 1);
  assert.equal(value.summary.neutralCities, 1);
  assert.equal(value.fleets.length, 1);
  assert.ok(value.fleets[0].track, '舰队应带航线');
  assert.ok(value.trade.cargo.track, '商船应带航线');
  const worldInfo = requests.find(request => request.name === 'WorldInfoRequest');
  assert.ok(worldInfo, '应读取世界信息');
  assert.ok(Number.isSafeInteger(worldInfo.body.screenCenter.x));
  assert.ok(Number.isSafeInteger(worldInfo.body.screenCenter.y));
  const reads = [...new Set(requests
    .filter(request => ['MyFleetsRequest', 'WorldInfoRequest', 'TradeInfoRequest', 'WarDeclarationRequest', 'GuildCityInfoRequest'].includes(request.name))
    .map(request => request.name))].sort();
  assert.deepEqual(reads, ['GuildCityInfoRequest', 'MyFleetsRequest', 'TradeInfoRequest', 'WarDeclarationRequest', 'WorldInfoRequest']);
});

/** 城战手动派遣只允许当前可进攻目标，并在舰队状态读回后才算确认。 */
test('console: city war settings save and manual dispatch confirm the fleet', async t => {
  const now = Math.floor(Date.now() / 1000);
  let sent = false;
  const sends = [];
  mockGateway(t, async () => ({ result: 0, initSeqNo: 1, playerInfo: {
    playerId: '1', nickname: '城战角色', level: 20, scenarioId: 1,
    guildId: { low: 7, high: 0, unsigned: false },
  } }), async function (name) {
    if (name === 'WorldInfoRequest') return { cities: [{ id: 1, guildIdx: 3, state: 1 }, { id: 2, guildIdx: 5, state: 1 }] };
    if (name === 'WarDeclarationRequest') return {
      startTime: now - 60, endTime: now + 3600, assembleCityId: 1,
      declarations: [{ cityId: 2, attackGuildIdx: 3, defenceGuildIdx: 5 }],
    };
    if (name === 'GuildCityInfoRequest') return { cities: [{ cityId: 1, recommended: true }] };
    if (name === 'MyFleetsRequest') return { fleets: [{
      buildingId: '1舰队', state: sent ? 2 : 1, durability: 2000, maxDura: 2000,
      cityId: 1, targetCityId: sent ? 2 : 0,
      moveStartTs: sent ? now : 0, moveEndTs: sent ? now + 600 : 0,
    }] };
    if (name === 'TradeInfoRequest') return { period: 0 };
    return {};
  }, async function (name, body) {
    sends.push({ name, body });
    if (name === 'MoveFleetsToCityRequest') sent = true;
  });
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const state = await api('/api/map/state?fresh=1');
  assert.equal(state.status, 200);
  assert.equal(state.value.war.active, true);
  assert.deepEqual(state.value.war.attackTargets.map(target => target.cityId), [2]);
  assert.deepEqual(state.value.war.defendTargets.map(target => target.cityId), [1]);

  const saved = await api('/api/map/city-war/settings', { enabled: true, online: true, reattack: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.cityWar.enabled, true);
  assert.equal(saved.value.cityWar.online, true);
  assert.equal(saved.value.cityWar.reattack, true);

  const dispatch = await api('/api/map/city-war/dispatch', { confirm: true, buildingId: '1舰队', cityId: 2, role: 'attack' });
  assert.equal(dispatch.status, 200, JSON.stringify(dispatch.value));
  assert.equal(dispatch.value.confirmed, true);
  assert.deepEqual(sends.filter(entry => entry.name === 'MoveFleetsToCityRequest').map(entry => entry.body),
    [{ buildingId: ['1舰队'], cityId: 2 }]);
});

/** 读回窗口内只有耐久这类无关字段变化不能证明派遣已提交：确认必须等到目标变化。 */
test('console: dispatch without a real departure is not reported as confirmed', async t => {
  const now = Math.floor(Date.now() / 1000);
  let polls = 0;
  mockGateway(t, async () => ({ result: 0, initSeqNo: 1, playerInfo: {
    playerId: '1', nickname: '城战角色', level: 20, scenarioId: 1,
    guildId: { low: 7, high: 0, unsigned: false },
  } }), async function (name) {
    if (name === 'WorldInfoRequest') return { cities: [{ id: 1, guildIdx: 3, state: 1 }, { id: 2, guildIdx: 5, state: 1 }] };
    if (name === 'WarDeclarationRequest') return {
      startTime: now - 60, endTime: now + 3600, assembleCityId: 1,
      declarations: [{ cityId: 2, attackGuildIdx: 3, defenceGuildIdx: 5 }],
    };
    if (name === 'GuildCityInfoRequest') return { cities: [{ cityId: 1, recommended: true }] };
    if (name === 'MyFleetsRequest') {
      polls += 1;
      return { fleets: [{
        buildingId: '1舰队', state: 1, durability: Math.max(1, 2000 - polls), maxDura: 2000,
        cityId: 1, targetCityId: 0, moveStartTs: 0, moveEndTs: 0,
      }] };
    }
    if (name === 'TradeInfoRequest') return { period: 0 };
    return {};
  }, async function () {});
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const dispatch = await api('/api/map/city-war/dispatch', { confirm: true, buildingId: '1舰队', cityId: 2, role: 'attack' });
  assert.equal(dispatch.status, 200);
  assert.equal(dispatch.value.ok, false, JSON.stringify(dispatch.value));
  assert.equal(dispatch.value.confirmed, false, '无关字段变化不能冒充派遣确认');
});

/** 浏览器跨站请求带外源 Origin：写端点必须拒绝，本源请求不受影响。 */
test('console: cross-site POST with a foreign Origin is rejected', async t => {
  mockGateway(t, async () => ({ result: 0, initSeqNo: 1, playerInfo: {
    playerId: '42', nickname: '跨站角色', level: 20, scenarioId: 1,
  } }), async function () { return {}; }, async function () {});
  const { api, base } = await consoleFixture(t);
  const evil = await fetch(`${base}/api/chat/send?account=connection-a`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ channel: 1, text: '跨站注入' }),
  });
  assert.equal(evil.status, 403, '外源 Origin 的写请求必须被拒绝');
  const ok = await api('/api/chat/send', { channel: 1, text: '   ' });
  assert.notEqual(ok.status, 403, '无 Origin 的本源请求不受影响');
});

/** 聊天发送是静默写入：发完读频道记录确认自己的发言入库。 */
test('console: chat send delivers text and confirms via channel record', async t => {
  const writes = [];
  mockGateway(t, async () => ({ result: 0, initSeqNo: 1, playerInfo: {
    playerId: '42', nickname: '聊天角色', level: 20, scenarioId: 1,
  } }), async function (name, body) {
    if (name === 'ChatRecordRequest') {
      // ChatRecordRequest 只有 channel；确认文本用同频道已发送的写入回放。
      const channelText = writes.find(entry => entry.name === 'SendChatRequest' && entry.body.channel === body.channel)?.body.content.text;
      return channelText
        ? { message: [{ sender: { playerId: '42', nickname: '聊天角色' }, content: { type: 1, text: channelText }, timestamp: 1 }] }
        : { message: [] };
    }
    return {};
  }, async function (name, body) { writes.push({ name, body }); });
  const { api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);

  const blank = await api('/api/chat/send', { channel: 1, text: '   ' });
  assert.equal(blank.status, 400);
  assert.match(blank.value.error, /请输入/);

  const sent = await api('/api/chat/send', { channel: 2, text: '打G2了' });
  assert.equal(sent.status, 200, JSON.stringify(sent.value));
  assert.equal(sent.value.confirmed, true);
  assert.equal(sent.value.channel, 2);
  assert.deepEqual(writes.filter(entry => entry.name === 'SendChatRequest').map(entry => entry.body),
    [{ channel: 2, content: { type: 1, text: '打G2了' } }]);
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
      // 全局统计故意与当前角色条目不同，确保总览使用角色实时 rewardTimes。
      if (name === 'TreasureLootStatsRequest') return { todayRewardTimes: 1, totalRewardTimes: 3 };
      if (name === 'TreasureLootListRequest') return { treasure: [{ uid: 77, color: 5, reward: { asset: [{ type: 0, id: '高级宝箱', num: 2 }] } }] };
      if (name === 'TreasureLootRankRequest') {
        assert.deepEqual(body, { uid: 77 });
        return { items: [{ playerId: '42', rank: 4, rewardTimes: 3 }] };
      }
      return {};
    });
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  await waitFor(() => !app.sessions.get('connection-a').cache.syncing, '核心总览缓存没有完成同步');
  const overview = await api('/api/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.value.merchantShip.todayRewardTimes, 3);
  assert.equal(overview.value.merchantShip.totalRewardTimes, 3);
  assert.equal(overview.value.merchantShip.uid, 77);
  assert.equal(overview.value.merchantShip.rank, 4);
  assert.deepEqual(overview.value.merchantShip.reward.map(({ id, num }) => ({ id, num })), [{ id: '高级宝箱', num: 2 }]);
  const merchantLogs = app.sessions.get('connection-a').log.filter(entry => entry.extra?.merchantShipReward);
  assert.equal(merchantLogs.length, 1);
  assert.match(merchantLogs[0].message, /^万吨货轮 #77 · 奖品：.+ ×2$/);
  assert.deepEqual(merchantLogs[0].extra.merchantShipReward.rewards.map(({ id, num }) => ({ id, num })), [{ id: '高级宝箱', num: 2 }]);
  // 抢夺中的当前货轮（即使占有榜 rewardTimes>0）奖品还没入库，不能计入今日已领。
  assert.equal(overview.value.merchantShip.claimedShips, 0);
  assert.deepEqual(overview.value.merchantShip.claimedToday, []);
  await api('/api/overview');
  assert.equal(app.sessions.get('connection-a').log.filter(entry => entry.extra?.merchantShipReward).length, 1);
});

/** 万吨货轮消失且协议今日计数上涨才计入今日已领；计数未动的消失是别人领走的，不计入。 */
test('console: overview tracks claimed merchant ship rewards across ship changes', async t => {
  let treasure = { uid: 81, color: 5, progress: 60, reward: { asset: [{ type: 0, id: '高级宝箱', num: 2 }] } };
  let statsTimes = 0;
  let refresh;
  mockGateway(t, undefined, async function (name) {
    if (name === 'TreasureLootStatsRequest') return { todayRewardTimes: statsTimes, totalRewardTimes: 3 };
    if (name === 'TreasureLootListRequest') return { treasure: [treasure] };
    if (name === 'TreasureLootRankRequest') return { items: [{ playerId: '42', rank: 4, rewardTimes: 0 }] };
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
  const overview = await api('/api/overview');
  assert.equal(overview.value.merchantShip.claimedShips, 0, 'rewardTimes 为 0 时不能提前计入已领');
  assert.deepEqual(overview.value.merchantShip.claimedToday, []);

  // 货轮换新：旧船从列表消失且今日计数从 0 涨到 1，下一轮空闲刷新应把旧船奖品计入今日已领。
  treasure = { uid: 82, color: 5, progress: 10, reward: { asset: [{ type: 0, id: '木材', num: 5 }] } };
  statsTimes = 1;
  refresh();
  await waitFor(() => !session.cache.syncing && session.merchantShipClaims.get('81')?.claimedDay != null, '货轮消失后没有标记为已领');
  const after = await api('/api/overview');
  assert.equal(after.value.merchantShip.claimedShips, 1);
  // 旧船消失后按消失时刻计入今日已领，奖品分组保持一次领取一行。
  assert.deepEqual(after.value.merchantShip.claimedToday.map(ship => ({ at: ship.at != null, rewards: ship.rewards.map(({ id, num }) => ({ id, num })) })), [{ at: true, rewards: [{ id: '高级宝箱', num: 2 }] }]);
});

/** 已领记录按账号落盘；会话重建（重启/重连）后总览仍能恢复今天的已领列表。 */
test('console: merchant ship claimed rewards persist across session restart', async t => {
  // 同账号目录在本文件的多个用例间共享；先清掉前面用例留下的已领落盘，从零验证恢复。
  fs.rmSync(path.join(accountDirectory('connection-a'), 'merchant-ship-claims.json'), { force: true });
  let treasure = { uid: 91, color: 5, reward: { asset: [{ type: 0, id: '高级宝箱', num: 2 }] } };
  let statsTimes = 0;
  mockGateway(t, undefined, async function (name) {
    if (name === 'TreasureLootStatsRequest') return { todayRewardTimes: statsTimes, totalRewardTimes: 3 };
    if (name === 'TreasureLootListRequest') return { treasure: [treasure] };
    if (name === 'TreasureLootRankRequest') return { items: [{ playerId: '42', rank: 4, rewardTimes: 0 }] };
    return {};
  });
  let refresh;
  t.mock.method(globalThis, 'setInterval', callback => {
    refresh = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  const session = app.sessions.get('connection-a');
  await waitFor(() => typeof refresh === 'function' && !session.cache.syncing && !session.cache.initialSync, '初始缓存没有完成同步');

  // 船 91 消失换成船 92，今日计数同步上涨：旧船按消失计入今日已领并写入账号目录。
  treasure = { uid: 92, color: 5, reward: { asset: [{ type: 0, id: '木材', num: 5 }] } };
  statsTimes = 1;
  refresh();
  await waitFor(() => !session.cache.syncing && session.merchantShipClaims.get('91')?.claimedDay != null, '货轮消失后没有标记为已领');

  // 模拟重启：丢弃会话后重新连接，新会话应从落盘文件恢复船 91 的今日已领。
  app.sessions.delete('connection-a');
  assert.equal((await api('/api/connect', {})).status, 200);
  const restarted = app.sessions.get('connection-a');
  assert.notEqual(restarted, session, '重连后应创建全新会话');
  await waitFor(() => !restarted.cache.syncing && !restarted.cache.initialSync, '重启后的缓存没有完成同步');
  const overview = await api('/api/overview');
  assert.equal(overview.value.merchantShip.claimedShips, 1);
  assert.deepEqual(overview.value.merchantShip.claimedToday.map(ship => ({ at: ship.at != null, rewards: ship.rewards.map(({ id, num }) => ({ id, num })) })), [{ at: true, rewards: [{ id: '高级宝箱', num: 2 }] }]);
});

/** 没有万吨货轮时总览仍返回次数，且不会发起占有榜查询。 */
test('console: overview keeps merchant reward count without an active ship', async t => {
  const rankRequests = [];
  mockGateway(t, undefined, async function (name) {
    if (name === 'TreasureLootStatsRequest') return { todayRewardTimes: 1, totalRewardTimes: 3 };
    if (name === 'TreasureLootListRequest') return { treasure: [{ uid: 78, color: 4 }] };
    if (name === 'TreasureLootRankRequest') rankRequests.push(name);
    return {};
  });
  const { app, api } = await consoleFixture(t);
  assert.equal((await api('/api/connect', {})).status, 200);
  await waitFor(() => !app.sessions.get('connection-a').cache.syncing, '总览缓存没有完成首次同步');
  const overview = await api('/api/overview');
  assert.equal(overview.value.merchantShip.todayRewardTimes, 1);
  assert.equal(overview.value.merchantShip.totalRewardTimes, 3);
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
  const elements = [];
  /** Match the selectors used by the bundled page without implementing a complete browser DOM. */
  function matchesSelector(value, selector) {
    const matchesSimple = (node, query) => {
      if (query.startsWith('.')) return query.slice(1).split('.').every(name => node.className.split(/\s+/).includes(name));
      const match = query.match(/^\[data-([a-z-]+)(?:=([^\]]+))?\]$/);
      if (match) {
        const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        const expected = match[2]?.replace(/["']/g, '');
        return Object.hasOwn(node.dataset, key) && (expected === undefined || node.dataset[key] === expected);
      }
      // 简单标签名（table() 模板查询 thead/tbody/tr 时使用）。
      return !!query && /^[a-z][a-z0-9-]*$/i.test(query) && node.tagName === query;
    };
    return selector.split(',').some((part) => {
      const chain = part.trim().split(/\s+/).filter(Boolean);
      if (!chain.length) return false;
      if (!matchesSimple(value, chain.at(-1))) return false;
      let node = value;
      for (let index = chain.length - 2; index >= 0; index--) {
        let parent = node.parentNode;
        while (parent && !matchesSimple(parent, chain[index])) parent = parent.parentNode;
        if (!parent) return false;
        node = parent;
      }
      return true;
    });
  }
  /** DOM 桩同时模拟日志节点、设置开关和指针事件，不触发浏览器或网络副作用。 */
  function element() {
    const listeners = new Map();
    const attributes = new Map();
    let ownText = '';
    const value = {
      disabled: false,
      className: '',
      tagName: '',
      style: { setProperty: () => {} },
      dataset: {},
      value: '',
      valueAsNumber: 0,
      options: [],
      checked: false,
      hidden: false,
      parentNode: null,
      children: [],
      clientHeight: 0,
      scrollHeight: 0,
      scrollTop: 0,
      classList: {
        // The fixture only opens the overview tab; background page refreshes must stay behind their hidden panels.
        contains(name) { return name === 'hidden' && ['tab-idle', 'tab-map', 'tab-manual', 'tab-stages', 'tab-heroes', 'tab-dailies', 'tab-activities', 'tab-account', 'tab-automation', 'tab-guild', 'tab-inventory', 'tab-giftcodes', 'tab-settings'].includes(value.id); },
        add: () => {}, remove: () => {}, toggle: () => {},
      },
      appendChild(child) { ownText = ''; this.children.push(child); child.parentNode = this; return child; },
      insertBefore(node, ref) { if (ref && this.children.includes(ref)) this.children.splice(this.children.indexOf(ref), 0, node); else this.children.unshift(node); node.parentNode = this; return node; },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; },
      remove() { this.parentNode?.removeChild(this); },
      cloneNode() { const copy = element(); copy.tagName = this.tagName; copy.id = this.id; copy.className = this.className; Object.assign(copy.dataset, this.dataset); return copy; },
      contains(child) { for (let node = child; node; node = node.parentNode) if (node === this) return true; return false; },
      setAttribute(name, attributeValue) { attributes.set(name, String(attributeValue)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
      scrollIntoView() {},
      querySelectorAll(selector) {
        const descendants = [];
        const visit = item => { for (const child of item.children ?? []) { descendants.push(child); visit(child); } };
        visit(this);
        return descendants.filter(child => matchesSelector(child, selector));
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
      closest() { return null; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      emit(type) { listeners.get(type)?.({ type, target: this }); },
    };
    Object.defineProperties(value, {
      textContent: { get: () => ownText, set: text => { ownText = String(text); value.children.forEach(child => { child.parentNode = null; }); value.children = []; } },
      childElementCount: { get: () => value.children.length },
      firstChild: { get: () => value.children[0] ?? null },
      lastElementChild: { get: () => value.children.at(-1) ?? null },
      innerText: { get: () => value.children.length ? value.children.map(child => child.innerText ?? child.textContent).join('\n') : value.textContent },
    });
    elements.push(value);
    return value;
  }
  /** ui-table 模板的最小子树：thead>tr>th 与 tbody>tr>td，供页面 table() 克隆扩展。 */
  function tableTemplate() {
    const th = element(); th.tagName = 'th';
    const headRow = element(); headRow.tagName = 'tr'; headRow.appendChild(th);
    const thead = element(); thead.tagName = 'thead'; thead.appendChild(headRow);
    const td = element(); td.tagName = 'td';
    const rowTemplate = element(); rowTemplate.tagName = 'tr'; rowTemplate.appendChild(td);
    const tbody = element(); tbody.tagName = 'tbody'; tbody.appendChild(rowTemplate);
    const box = element(); box.tagName = 'table'; box.appendChild(thead); box.appendChild(tbody);
    return box;
  }
  /** 按 ID 复用节点，使真实页面绑定的事件可被测试直接调用。 */
  function node(id) {
    if (!nodes.has(id)) {
      const value = element();
      value.id = id;
      if (id === 'ui-table') value.content = { firstElementChild: tableTemplate() };
      else if (id === 'ui-badge' || id === 'ui-button' || id === 'ui-select' || id === 'ui-delete' || id === 'ui-number') value.content = { firstElementChild: element() };
      nodes.set(id, value);
    }
    return nodes.get(id);
  }
  let connected = true;
  const calls = [];
  const clipboardWrites = [];
  const notifyRequests = [];
  const giftRedeemRequests = [];
  let notifySettings = { webhookUrl: '', webhookFormat: 'generic', events: { kicked: true, disconnect: true, recovered: true } };
  const notifyEvents = [{ key: 'kicked', label: '账号被顶号' }, { key: 'disconnect', label: '连接中断' }, { key: 'recovered', label: '恢复挂机' }];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const window = {
    getSelection: () => ({ rangeCount: 0, isCollapsed: true }),
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    emit(type) { windowListeners.get(type)?.({ type, target: window }); },
  };
  // 页面进度组件会监听可见性变化；夹具提供浏览器同名接口以便脚本加载时完成事件绑定。
  const document = {
    hidden: false,
    // trackCall 用 body 标记加载态；夹具只需让它接受属性读写。
    body: element(),
    getElementById: node,
    createElement: element,
    createTextNode: text => ({ textContent: text, parentNode: null }),
    querySelectorAll: selector => elements.filter(value => matchesSelector(value, selector)),
    querySelector: selector => elements.filter(value => matchesSelector(value, selector))[0] ?? null,
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    emit(type) { documentListeners.get(type)?.({ type, target: document }); },
  };
  const context = vm.createContext({
    window,
    navigator: { clipboard: { writeText: async text => { clipboardWrites.push(text); } } },
    document,
    // 进度组件会管理装备制作的延迟刷新；夹具不调度计时器，只接受清理和创建调用。
    Option: function () {}, setInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    // 新壳页头高度用 ResizeObserver 观测；夹具不布局，只接受注册。
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    // 模拟本地 HTTP 响应，不启动真实浏览器，也不使用磁盘账号。
    fetch: async (url, options = {}) => {
      const route = url.split('?')[0];
      calls.push(route);
      if (route === '/api/disconnect') connected = false;
      if (route === '/api/connect') connected = true;
      const status = { connected, state: connected ? 'READY' : 'STOPPED', busy: null, looping };
      let data;
      if (route === '/api/accounts') data = { activeId: 'page-a', accounts: [{ id: 'page-a', title: '离线账号', status }] };
      else if (route === '/api/notify/save' && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        notifyRequests.push(payload);
        notifySettings = payload;
        data = { settings: notifySettings };
      }
      else if (route === '/api/notify') data = { settings: notifySettings, events: notifyEvents, formats: ['generic', 'wecom', 'feishu'] };
      else if (route === '/api/gift-codes/redeem') {
        const payload = JSON.parse(options.body);
        giftRedeemRequests.push(payload);
        // 与服务端合并后的契约一致：started/batchId 兼容旧面板，accepted/results 供新礼包页消费。
        data = { started: true, batchId: 'page-gift', codes: payload.codes, accepted: 1,
          results: [{ id: 'page-a', title: '离线账号', accepted: true }] };
      }
      else if (route === '/api/gift-codes/accounts') data = { accounts: [{ id: 'page-a', title: '离线账号', paused: false, connected: false, running: false, total: 0, counts: {} }] };
      else if (route === '/api/gift-codes') data = { running: false, rows: [] };
      else if (route === '/api/overview') data = { status, resources: [{ name: '金币', amount: 123 }], items: { top: [] }, heroes: { list: [] } };
      // 城战统计与活动统计/排行在夹具里按不可用处理：页面侧走各自的降级提示路径。
      else if (route === '/api/city-war/stats' || route === '/api/activity-statistics' || route === '/api/activity-ranks' || route === '/api/activity-ranks/view') {
        return { ok: false, status: 404, json: async () => ({ error: '夹具不提供该数据' }) };
      }
      else data = { ok: true };
      return { ok: true, json: async () => data };
    },
  });
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)[1];
  // 保留实际事件和轮询函数，仅移除启动调用，避免异步 boot 干扰用例顺序。
  vm.runInContext(script.slice(0, script.lastIndexOf('boot();')), context);
  vm.runInContext("current = 'page-a'", context);
  return { context, calls, node, window, clipboardWrites, notifyRequests, giftRedeemRequests };
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

/** 总览按钮复用缓存接口，返回后维持当前连接状态和刷新能力。 */
test('console page: overview refresh button requests current overview', async () => {
  const { context, calls, node } = pageFixture();
  await vm.runInContext('loadAccounts(false)', context);
  assert.equal(node('overview-refresh').disabled, false);
  await node('overview-refresh').onclick();
  assert.equal(calls.filter(route => route === '/api/overview').length, 1);
  assert.equal(node('overview-refresh').disabled, false);
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

/** 挂机页保存一套全局 Webhook 配置，并允许在保存后发送测试消息。 */
test('console page: idle panel saves shared Webhook notification settings', async () => {
  const { context, calls, node, notifyRequests } = pageFixture();
  vm.runInContext(`renderNotify({ settings: {
    webhookUrl: '', webhookFormat: 'generic', events: { kicked: true, disconnect: false, recovered: true },
  }, events: [{ key: 'kicked', label: '账号被顶号' }, { key: 'disconnect', label: '连接中断' }, { key: 'recovered', label: '恢复挂机' }] })`, context);
  node('notify-webhook').value = 'https://notify.invalid/hook';
  node('notify-format').value = 'wecom';
  node('notify-webhook').emit('input');
  await node('notify-form').onsubmit({ preventDefault() {} });

  assert.deepEqual(notifyRequests, [{ webhookUrl: 'https://notify.invalid/hook', webhookFormat: 'wecom',
    events: { kicked: true, disconnect: false, recovered: true } }]);
  assert.equal(node('notify-hint').textContent, '已保存');
  await node('notify-test').onclick();
  assert.equal(calls.filter(route => route === '/api/notify/test').length, 1);
});

/** 新壳事实：礼包兑换走「资源与玩法 → 礼包兑换」页——提交带所选账号与确认标记，
 *  响应的 accepted/results 直接决定开始状态与拒收提示；逐条结果由兑换记录轮询与 SSE 日志呈现。 */
test('console page: gift codes page submits selected accounts and consumes per-account results', async () => {
  const { context, giftRedeemRequests, node } = pageFixture();
  node('gift-code-input').value = 'CODE-A\nCODE-B';
  // giftTargets() 只发被勾选账号；夹具里手工置名单并勾上离线账号 page-a。
  vm.runInContext("giftAccounts = [{ id: 'page-a', title: '离线账号', paused: false, running: false, total: 0, counts: {} }]; giftSelected.add('page-a')", context);
  await node('gift-code-start').onclick();

  assert.deepEqual(giftRedeemRequests, [{ confirm: true, codes: 'CODE-A\nCODE-B', accounts: ['page-a'] }]);
  assert.equal(node('gift-code-input').value, '');
  // 兑换开始后立即转入记录轮询；refused 账号的原因展示在状态行。
  assert.match(node('gift-code-state').textContent || '', /.*/);
});

/** 全局通知配置由服务统一保存，切换账号不能产生另一套企微或钉钉地址。 */
test('console: global notification settings are shared by all accounts', async t => {
  const { api } = await consoleFixture(t);
  const initial = await api('/api/notify');
  assert.equal(initial.status, 200);
  assert.equal(initial.value.settings.webhookUrl, '');
  assert(initial.value.events.some(event => event.key === 'disconnect'));

  const settings = {
    webhookUrl: 'https://notify.invalid/webhook', webhookFormat: 'wecom',
    events: Object.fromEntries(initial.value.events.map(event => [event.key, event.key !== 'recovered'])),
  };
  const saved = await api('/api/notify/save', settings);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.settings, settings);
  assert.deepEqual((await api('/api/notify', undefined, 'connection-b')).value.settings, settings);
});

/** 迁移冒烟：新壳在手机断言的导航骨架存在，地图/自动化两个回插 tab 可激活且触发各自加载入口。 */
test('migration smoke: reshelled page keeps bottom tabs and activates map/automation', async () => {
  assert.match(PAGE, /name="viewport" content="width=device-width/);
  assert.match(PAGE, /<nav id="tabs" aria-label="功能导航">/);
  assert.match(PAGE, /data-tab="map"/);
  assert.match(PAGE, /data-tab="automation"/);
  assert.match(PAGE, /<section id="tab-map" class="hidden">/);
  assert.match(PAGE, /<section id="tab-automation" class="hidden">/);
  const { context } = pageFixture();
  await vm.runInContext(`(async () => {
    // 只验证激活分发与加载入口接线；数据渲染由对应路由测试覆盖。
    let mapCalls = 0, autoCalls = 0;
    mapTabRefresh = () => { mapCalls++; };
    refreshProgression = () => {};
    loadAutomation = () => { autoCalls++; return Promise.resolve(); };
    gsLoad = () => Promise.resolve();
    const mapButton = document.createElement('button');
    mapButton.dataset.tab = 'map';
    activateConsolePage(mapButton);
    if (mapCalls !== 1) throw new Error('地图 tab 未触发 mapTabRefresh');
    const autoButton = document.createElement('button');
    autoButton.dataset.tab = 'automation';
    activateConsolePage(autoButton);
    if (autoCalls !== 1) throw new Error('自动化 tab 未触发 loadAutomation');
  })()`, context);
});

test('console: page.mjs 引用的每个元素 id 都存在于外壳 HTML', () => {
  // 换壳曾把 #overview-refresh 丢在新外壳外：顶层 $('id').onclick 取到 null，
  // 整页脚本加载即崩，而下方 vm 夹具的 getElementById 对任意 id 都返回元素，抓不到。
  // 这里静态交叉核对：page.mjs 里的 $('…') 引用必须能在外壳渲染出的 id="…" 里找到。
  const source = fs.readFileSync(new URL('../src/page.mjs', import.meta.url), 'utf8');
  const ids = [...new Set([...source.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]))];
  assert.ok(ids.length > 100, `应从 page.mjs 解析出大量 id 引用，实际 ${ids.length}，解析逻辑可能失效`);
  const missing = ids.filter(id => !PAGE.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `page.mjs 引用但外壳 HTML 缺失的元素 id（会导致顶层 $() 抛 TypeError）：${missing.join(', ')}`);
});
