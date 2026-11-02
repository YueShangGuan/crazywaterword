import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { automationTasks } from '../src/automation.mjs';
import { runWorld } from '../src/world.mjs';
import { runLoop } from '../src/loop.mjs';

// Never use the player's account store or open a game connection.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-auto-test-'));
process.env.CW_DATA_DIR = dir;
const { saveStore } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
let logins = 0;
let finishedLogins = 0;
GameClient.prototype.connect = async () => { logins++; return { playerInfo: {} }; };
GameClient.prototype.send = function (name) {
  assert.equal(name, 'LoginFinishRequest');
  finishedLogins++;
  this.emit('message', { name: 'SCAllActivity', body: { festivalActivities: [
    { type: '捞尸人联动活动', subActivity: [{ subActivityType: 30 }] },
  ] } });
};
GameClient.prototype.request = async name => {
  assert.equal(name, 'EmailBoxRequest');
  return {};
};
const tasks = Object.fromEntries(automationTasks.map(t => [t.key, t.key === 'mail']));
saveStore({ activeId: 'a', accounts: ['a', 'b'].map(id => ({
  id, url: 'ws://invalid.invalid', login: {}, automation: { tasks, enabled: id === 'a' },
})) });
let app;
async function open() {
  app = createConsole({ port: 0 });
  await app.listen();
}
async function api(id, route, payload) {
  const url = 'http://127.0.0.1:' + app.server.address().port + '/api/loop' + route + '?account=' + id;
  const res = await fetch(url, payload && { method: 'POST', body: JSON.stringify({ confirm: true, ...payload }) });
  assert.equal(res.status, 200);
  return res.json();
}
try {
  await open();
  assert.equal((await api('a', '')).running, true);
  assert.equal(finishedLogins, logins);
  assert.equal(app.sessions.get('a').client.festivals[0].type, '捞尸人联动活动');
  const request = (route, payload) => fetch('http://127.0.0.1:' + app.server.address().port + '/api/' + route + '?account=a',
    payload && { method: 'POST', body: JSON.stringify(payload) });
  assert.equal((await (await request('accounts/pause', { paused: true })).json()).paused, true);
  const before = logins;
  await app.close();
  await open();
  assert.equal((await api('a', '')).running, false);
  for (const [route, payload] of [['overview'], ['connect', {}], ['worlds/enter', { confirm: true, worldId: 1 }], ['loop/start', { confirm: true }]]) {
    assert.match((await (await request(route, payload)).json()).error, /账号已暂停/);
  }
  assert.equal(logins, before);
  assert.equal((await (await request('accounts/pause', { paused: false })).json()).paused, false);
  assert.equal((await api('a', '')).running, true);
  assert.equal(logins, before + 1);
  assert.equal((await api('b', '')).running, false);
  await api('a', '/task', { key: 'mail', enabled: false });
  await app.sessions.get('a').loop.job;
  assert.equal((await api('b', '')).tasks.find(t => t.key === 'mail').enabled, true);
  await app.close();
  await open();
  const paused = await api('a', '');
  assert.equal(paused.running, false);
  assert.equal(paused.tasks.some(t => t.enabled), false);
  await api('a', '/task', { key: 'mail', enabled: true });
  await api('a', '/start', { everySeconds: 120 });
  await app.close();
  await open();
  assert.equal((await api('a', '')).everyMs, 120000);
  assert.equal((await api('a', '')).running, true);
  await api('a', '/stop', {});
  await app.sessions.get('a').loop.job;
  assert.equal((await api('a', '')).running, false);

  let build = true;
  const sent = [];
  const plan = { actions: ['build', 'build', 'gainFactory'].map((kind, index) =>
    ({ kind, request: kind, body: { index } })) };
  await runWorld({ async sendWatch(name) { sent.push(name); build = false; } },
    { build: true, gainFactory: true }, plan, { allowMutate: true, enabled: kind => kind !== 'build' || build });
  assert.deepEqual(sent, ['build', 'gainFactory']);
  // Two reward periods expire between ordinary rounds. The server clock is 2 s ahead.
  const realNow = Date.now;
  let now = 100_000, finish = 105;
  const draws = [];
  try {
    Date.now = () => now;
    const client = { serverClockOffsetMs: 2000, async request(name) {
      if (name === 'AfkInfoRequest') return { afkInfo: { afkFinishTime: finish } };
      assert.equal(name, 'DrawAfkRewardRequest');
      draws.push(now);
      finish += 4;
      return { afkFinishTime: finish };
    } };
    await runLoop(client, { DrawAfkRewardRequest: true, DrawAfkRewardResponse: true }, {
      allowMutate: true, rounds: 2, everyMs: 10_000, isEnabled: key => key === 'afk',
      sleep: async ms => { now += ms; },
    });
    assert.deepEqual(draws, [103_000, 107_000]);

    now = 100_000;
    const work = [];
    let collected = false, restocked = false;
    const factoryClient = { connected: true, serverClockOffsetMs: 2000, async request(name) {
      if (name === 'GainFactoryProduceRequest') { collected = true; work.push(['收成品', now]); return {}; }
      assert.equal(name, 'OnWaterRequest');
      const done = now >= 103_000;
      const factoryQ = restocked ? [{ productId: '布匹', finishTime: 200 }] : done ? [] : [{ productId: '布匹', finishTime: 105 }];
      return { building: [{ buildingId: '1材料厂', level: 1, factory: { factoryQ,
        finishedProducts: done && !collected ? [{ id: '布匹', num: 1 }] : [] } }] };
    }, async sendWatch(name) {
      assert.equal(name, 'StartFactoryProduceRequest');
      assert.equal(collected, true);
      restocked = true;
      work.push(['补产', now]);
    } };
    const config = { tables: {
      BuildingCfg: { data: [{ buildingType: '材料厂' }] },
      GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] },
      BuildingProduceParamCfg: { data: [{ paramName: '制造位上限', paramValue: 1 }] },
      BuildingProduceCfg: { data: [{ buildType: '材料厂', unlockLevel: 1, itemId: '布匹', produceTime: 60 }] },
    } };
    await runLoop(factoryClient, { OnWaterRequest: true, OnWaterResponse: true, GainFactoryProduceRequest: true,
      GainFactoryProduceResponse: true, StartFactoryProduceRequest: true }, { config, allowMutate: true, rounds: 2,
      everyMs: 10_000, isEnabled: k => ['collect', 'startProduce'].includes(k), sleep: async ms => { now += ms; } });
    assert.deepEqual(work, [['收成品', 103_250], ['补产', 103_250]]);
  } finally { Date.now = realNow; }
  console.log('automation ok: 账号隔离、重启恢复、暂停持久化、轮内跳过');
} finally {
  if (app?.server.listening) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
