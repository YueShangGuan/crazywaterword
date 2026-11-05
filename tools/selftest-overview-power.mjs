// The overview must not show the login snapshot's power once the server has a newer value.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-overview-power-'));
process.env.CW_DATA_DIR = dir;
process.env.CW_CONFIG_PACK = path.join(dir, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const protocol = (await import('../src/proto.mjs')).loadProtocol();
for (const name of ['OtherPlayerInfoRequest', 'OtherPlayerInfoResponse', 'SCPlayerPower']) assert(protocol[name], name + ' 应存在于真实协议');

const { GameClient, toNumber } = await import('../src/client.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');

const long = (value) => ({ low: value % 2 ** 32 | 0, high: Math.floor(value / 2 ** 32), unsigned: false });
// Above Number.MAX_SAFE_INTEGER: 0x7FFFFFFF_00000001.
const playerId = { low: 1, high: 0x7fffffff, unsigned: false };
const playerIdText = ((BigInt(0x7fffffff) << 32n) + 1n).toString();
let serverPower = long(294225);
let failRead = false;
const asked = [];
let logins = 0;
Object.defineProperty(GameClient.prototype, 'connected', { get: () => true });
GameClient.prototype.connect = async () => { logins++; return { playerInfo: { playerId, nickname: '测试', level: 20, power: long(166051) } }; };
GameClient.prototype.send = () => {};
GameClient.prototype.request = async (name, body) => {
  if (name !== 'OtherPlayerInfoRequest') return {};
  asked.push(body.playerId);
  if (failRead) throw new Error('offline');
  return { power: serverPower };
};

saveStore({ activeId: 'a', accounts: [{ id: 'a', url: 'ws://invalid.invalid', login: {}, automation: { enabled: false } }] });
const app = createConsole({ port: 0 });
try {
  await app.listen();
  const overview = async () => {
    const res = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/overview?account=a', { signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 200);
    return res.json();
  };

  assert.equal(toNumber((await overview()).player.power), 294225, '总览应显示服务端战力，而不是登录快照');
  assert.equal(asked.at(-1), playerIdText, 'playerId 不能经过不安全的数字转换');

  failRead = true;
  assert.equal(toNumber((await overview()).player.power), 294225, '读取失败时保留已知战力，总览不能因此失败');

  const session = app.sessions.get('a');
  session.client.emit('message', { name: 'SCPlayerPower', body: { power: long(300000) } });
  assert.equal(toNumber((await overview()).player.power), 300000, '战力推送应立即生效');

  session.client.emit('message', { name: 'SCPlayerPower', body: { power: long(0) } });
  assert.equal(toNumber((await overview()).player.power), 300000, '空的战力推送不能清零');

  assert.equal(logins, 1, '刷新总览不能重新登录');

  failRead = false;
  serverPower = long(0);
  assert.equal(toNumber((await overview()).player.power), 300000, '回包没有战力时保留已知值');
} finally {
  app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('overview power ok: server read, unsafe player id, failed read fallback, push update, empty values ignored');
process.exit(0);
