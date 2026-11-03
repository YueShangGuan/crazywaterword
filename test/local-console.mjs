import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// 独立测试仓库：该进程不读取默认 data 目录，不具备任何真实游戏凭证。
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ui-'));
process.env.CW_DATA_DIR = directory;
const { saveStore, upsertAccount } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const store = { version: 1, activeId: null, accounts: [] };
for (const id of ['offline-ui-a', 'offline-ui-b']) upsertAccount(store, { url: 'wss://offline.invalid/ws', login: { eworldParams: { openId: id } } }, { label: id });
saveStore(store);
const app = createConsole({ port: 17329 });

/** UI 运行只允许内存查询，遇到意外动作立即报错；不创建 WebSocket。 */
class OfflineClient extends EventEmitter {
  /** 模拟已连接状态供计划、状态与默认关闭模块的 UI 流程验收。 */
  constructor() { super(); this.connected = true; }
  /** 空状态仅用于界面展示，任何不支持的动作都拒绝。 */
  async request(name) {
    if (name === 'AllResourceRequest') return { list: [] };
    if (name === 'AllItemRequest') return { items: [] };
    if (/Request$/.test(name)) return {};
    throw new Error(`离线界面禁止 ${name}`);
  }
  /** 登录初始化信号在离线夹具中不发出网络帧。 */
  send() {}
  /** 只允许登录视图同步信号，不访问任何网关或产生游戏状态变更。 */
  async sendWatch(name) {
    if (!['ExitWorldMapRequest', 'RedPointRequest', 'LoginFinishRequest'].includes(name)) throw new Error(`离线界面禁止 ${name}`);
    return {};
  }
  /** 控制台连接状态为固定夹具值。 */
  snapshot() { return { state: this.connected ? 'READY' : 'STOPPED' }; }
  /** 断开仅改变内存状态。 */
  stop() { this.connected = false; }
}

await app.listen();
await fetch('http://127.0.0.1:17329/api/accounts');
for (const account of store.accounts) {
  const session = app.sessions.get(account.id); session.client = new OfflineClient(); session.player = { playerId: account.id, level: 1 };
}
console.log('OFFLINE_UI_READY http://127.0.0.1:17329');
/** 清理只在本脚本创建的临时目录内进行，关闭页面连接后退出。 */
async function close() {
  app.server.closeAllConnections(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true }); process.exit(0);
}
process.on('SIGINT', close); process.on('SIGTERM', close);
