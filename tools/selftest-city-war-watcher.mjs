import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 状态文件与额度账本必须落在临时目录：静态读取真实 data/ 会污染账号数据（CW_DATA_DIR 隔离）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'city-war-watcher-test-'));
process.env.CW_DATA_DIR = dataDir;

const { watchCityWarIdle, cityWarWindowActive } = await import('../src/city-war-watcher.mjs');

/** 最小假客户端：只提供事件订阅，收到的处理器可手动触发。 */
function fakeClient() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) { (handlers.get(name) ?? handlers.set(name, new Set()).get(name)).add(handler); },
    off(name, handler) { handlers.get(name)?.delete(handler); },
    emit(name, body) { for (const handler of handlers.get(name) ?? []) handler(body); },
  };
}

const push = (client, fleets) => client.emit('message', { name: 'SCMyFleetUpdate', body: { fleets } });

async function testWatcherTransitions() {
  const client = fakeClient();
  const watcher = watchCityWarIdle(client);
  const seen = [];
  const unsubscribe = watcher.subscribe(fleet => seen.push(fleet));

  // 战斗结束 3→1：唤醒，并带上迁移前状态。
  push(client, [{ buildingId: '1远征船', state: 3, durability: 110 }]);
  push(client, [{ buildingId: '1远征船', state: 1, durability: 110 }]);
  assert.deepEqual(seen, [{ buildingId: '1远征船', from: 3 }], '3→1 应触发一次唤醒');

  // 维修完成 4→1：唤醒（耐久回满的推送）。
  push(client, [{ buildingId: '2远征船', state: 4 }]);
  push(client, [{ buildingId: '2远征船', state: 1, durability: 2100 }]);
  assert.deepEqual(seen[1], { buildingId: '2远征船', from: 4 }, '4→1（修复完成）应触发唤醒');

  // 战斗中的耐久推送（state 3 不变）：不应触发。
  push(client, [{ buildingId: '1远征船', state: 3, durability: 90 }]);
  assert.equal(seen.length, 2, '同状态耐久变化不应唤醒');

  // 行军/排队等其他迁移（非→1）：不应触发。
  push(client, [{ buildingId: '1远征船', state: 2 }]);
  push(client, [{ buildingId: '1远征船', state: 5 }]);
  push(client, [{ buildingId: '1远征船', state: 3 }]);
  assert.equal(seen.length, 2, '非闲置迁移不应唤醒');

  // 回到闲置是合法 3→1 唤醒；紧接着的重复 idle 推送（1→1）不应再触发。
  push(client, [{ buildingId: '1远征船', state: 1 }]);
  assert.equal(seen.length, 3, '3→1 应再次唤醒');
  push(client, [{ buildingId: '1远征船', state: 1 }]);
  assert.equal(seen.length, 3, '1→1 不应唤醒');

  // 缺 state 或缺 buildingId 的脏推送：忽略且不破坏后续状态跟踪。
  push(client, [{ buildingId: '1远征船' }, { state: 1 }, { buildingId: '3远征船', state: 'x' }]);
  push(client, [{ buildingId: '1远征船', state: 3 }]);
  push(client, [{ buildingId: '1远征船', state: 1 }]);
  assert.equal(seen.length, 4, '脏推送应被忽略，合法 3→1 不受影响且状态跟踪不受影响');

  // 取消订阅后不再收到通知；监听实例按 client 复用。
  unsubscribe();
  push(client, [{ buildingId: '2远征船', state: 3 }]);
  push(client, [{ buildingId: '2远征船', state: 1 }]);
  assert.equal(seen.length, 4, '取消订阅后不应收到通知');
  assert.equal(watchCityWarIdle(client), watcher, '同一 client 应复用同一监听实例');
  assert.deepEqual([...watcher.current().entries()], [['1远征船', 1], ['2远征船', 1]], '状态表应记录最新状态');

  // 首次见到即 idle（重连回放）：只播种不唤醒。
  const fresh = fakeClient();
  const freshSeen = [];
  watchCityWarIdle(fresh).subscribe(fleet => freshSeen.push(fleet));
  push(fresh, [{ buildingId: '1远征船', state: 1 }]);
  assert.equal(freshSeen.length, 0, '首次播种不应唤醒');
}

async function testWindowGate() {
  const sh = (h, m) => Date.UTC(2026, 10, 16, h - 8, m); // 上海时间 = UTC+8
  assert.equal(cityWarWindowActive(sh(20, 0)), true, '20:00 应在窗口内');
  assert.equal(cityWarWindowActive(sh(20, 59)), true, '20:59 应在窗口内');
  assert.equal(cityWarWindowActive(sh(19, 59)), false, '19:59 应在窗口外');
  assert.equal(cityWarWindowActive(sh(21, 0)), false, '21:00 应在窗口外');
  assert.equal(cityWarWindowActive(sh(12, 30)), false, '白天应在窗口外');
}

async function testCityWarWatcher() {
  await testWatcherTransitions();
  await testWindowGate();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await testCityWarWatcher();
  console.log('city war watcher ok: idle transitions, battle noise filter, dirty push guard, replay seeding, window gate');
}
