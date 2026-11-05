import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { businessDate, loadLedger, writeJson, accountDirectory, accountSpending } from './settings.mjs';
import { moduleActive } from './schedule.mjs';

const activeRoles = new Set();
const LOCK_INITIALIZATION_GRACE_MS = 5_000;

/** int64 标识保留十进制字符串，禁止先转 Number 丢失精度。 */
export function idString(value) {
  if (value && typeof value === 'object' && typeof value.low === 'number') return ((BigInt(value.unsigned ? value.high >>> 0 : value.high) << 32n) + BigInt(value.low >>> 0)).toString();
  return String(value ?? '');
}

/** 数量在显示和预算计算时转换；角色/道具 UID 不经过此函数。 */
export function amount(value) {
  return Number(idString(value)) || 0;
}

/** 用同一套生成编解码器验证必填、嵌套字段及数组，拒绝 protobuf 会静默丢弃的参数。 */
export function validateMessage(type, body) {
  if (!type?.encode || !type?.decode) throw new Error('当前协议类型不存在');
  const decoded = type.decode(type.encode(body).finish());
  /** 以解码实例的构造器核验嵌套必填字段；Long 保留生成器自己的精度转换。 */
  function inspect(input, model, location) {
    if (!input || typeof input !== 'object' || model?.low !== undefined) return;
    const decoder = model?.constructor?.decode?.toString() ?? '';
    for (const match of decoder.matchAll(/hasOwnProperty\("([A-Za-z0-9_]+)"\)/g)) {
      if (input[match[1]] === undefined || input[match[1]] === null) throw new Error(`${location}.${match[1]} 为必填字段`);
    }
    for (const [key, value] of Object.entries(input)) {
      if (!(key in model)) throw new Error(`${location} 不存在字段 ${key}`);
      if (Array.isArray(model[key])) {
        if (!Array.isArray(value)) throw new Error(`${location}.${key} 必须是数组`);
        value.forEach((entry, index) => inspect(entry, model[key][index], `${location}.${key}[${index}]`));
      } else if (value && typeof value === 'object') inspect(value, model[key], `${location}.${key}`);
    }
  }
  inspect(body, decoded, type.name || 'message');
  return decoded;
}

/** 同一账号角色只容许一条业务链，防止 Prompt 和资源预算被并发请求串扰。 */
export async function withRoleLock(accountId, roleId, work) {
  const key = `${accountId}/${idString(roleId)}`;
  if (activeRoles.has(key)) throw new Error('这个角色已有业务操作正在执行');
  const lockFile = path.join(accountDirectory(accountId), 'business.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (fs.existsSync(lockFile)) {
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) throw new Error('业务锁缺少有效进程号');
    } catch {
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      // 新锁仍可能处于 openSync 与 writeFileSync 的极短间隙，先等待而不是并发夺锁。
      if (age < LOCK_INITIALIZATION_GRACE_MS) throw new Error('这个账号的业务锁正在初始化，请稍后重试');
      // 超过初始化宽限期的半份锁只能由异常退出留下，安全回收后才能继续自动化。
      fs.unlinkSync(lockFile);
    }
    if (owner) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('这个账号的业务连接已被另一个进程占用');
      // 上次进程异常退出留下的互斥文件只在 PID 已不存在时移除。
      fs.unlinkSync(lockFile);
    }
  }
  const fd = fs.openSync(lockFile, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, roleId: idString(roleId) }));
  activeRoles.add(key);
  try { return await work(); } finally { activeRoles.delete(key); fs.closeSync(fd); fs.unlinkSync(lockFile); }
}

/**
 * 构造全部玩法共用的连接、协议、库存、日额度和停止上下文。
 *
 * @param {object} options 上下文依赖和运行回调。
 * @param {import('../client.mjs').GameClient} options.client 当前账号连接。
 * @param {object} options.protocol 当前协议定义。
 * @param {object|null} options.config 当前游戏配置。
 * @param {object|null} options.player 当前登录角色。
 * @param {string} options.accountId 当前账号 ID。
 * @param {object} options.settings 自动化设置。
 * @param {Map} [options.initialPushes] 登录后已收到的推送快照。
 * @param {boolean} [options.dryRun] 是否只生成计划而不发写请求。
 * @param {object} [options.stop] 当前执行的停止信号。
 * @param {Function} [options.onStep] 记录自动化步骤的回调。
 * @param {Function} [options.onQuery] 成功只读查询回包的回调。
 * @param {Function} [options.now] 返回当前时间的函数，测试时可注入。
 * @returns {object} 供各自动化模块使用的上下文对象。
 */
export function createContext({ client, protocol, config, player, accountId, settings, initialPushes = new Map(), dryRun = false, stop = { aborted: false }, onStep = () => {}, onQuery = () => {}, now = () => Date.now() }) {
  const roleId = idString(player?.playerId);
  const { file, ledger } = loadLedger(accountId, roleId);
  const results = [];
  const snapshots = new Map();
  const pushes = new Map(initialPushes);
  const uncertain = new Set();
  const stock = new Map();
  let fatal = null;
  let moduleId = '';
  let moduleBlockReason = null;
  let writes = 0;
  const terminal = info => { fatal = info?.reason || '连接中断'; };
  client.on('fatal', terminal);
  client.on('close', terminal);
  /** 保存本连接活动推送；不得把另一角色或上一登录的活动快照复用。 */
  const capture = message => { if (message.name.startsWith('SC')) pushes.set(message.name, message.body); };
  client.on('message', capture);

  /** 服务端拒绝、超时及停止均中断当前动作；仅明确标记的无副作用模块可隔离未知结果。 */
  function assertReady() {
    if (stop.aborted) throw new Error('自动化已停止');
    if (fatal || !client.connected) throw new Error(fatal || '连接已断开');
  }
  /** 按上海日期创建本日统计，日期在每个动作前重新取值以支持跨午夜。 */
  function day() {
    const date = businessDate(now());
    ledger.days[date] ??= { spent: 0, modules: {}, counts: {} };
    return ledger.days[date];
  }
  /** 写前落盘保证进程崩溃后仍能约束日额度。 */
  function persist() { if (!dryRun) writeJson(file, ledger); }
  /** 统一结果状态供网页、CLI、循环及测试使用。 */
  function record(entry) {
    const row = { module: moduleId, at: new Date(now()).toISOString(), ...entry };
    results.push(row); onStep(row); return row;
  }
  /**
   * 将已由只读核对确认完成的未确认请求结算到账本，并移除本轮内存锁。
   * 只有调用方已经拿到服务端状态证据时才能调用，避免把未知写结果误记为成功。
   */
  function settlePending(key) {
    const pending = ledger.pending[key];
    if (!pending) return false;
    const dayRecord = ledger.days[pending.date] ??= { spent: 0, modules: {}, counts: {} };
    dayRecord.spent += pending.ruby;
    dayRecord.modules[pending.module] = (dayRecord.modules[pending.module] ?? 0) + pending.ruby;
    delete ledger.pending[key];
    try { persist(); }
    catch (error) {
      // 落盘失败时恢复原始预留，重启后仍能阻止重复提交。
      dayRecord.spent -= pending.ruby;
      dayRecord.modules[pending.module] -= pending.ruby;
      ledger.pending[key] = pending;
      stop.aborted = true;
      throw error;
    }
    // 结算完成后必须同时释放本轮内存锁，否则同一自动化运行内仍会把后续同键动作误判为未确认。
    uncertain.delete(key);
    return true;
  }
  /** 标记当前模块已被未确认写请求阻断，供调度器跳过该模块的剩余工作。 */
  function blockModule(reason) { moduleBlockReason = reason || '当前模块存在未确认请求'; }
  /** 取出并清除当前模块阻断原因，允许后续独立模块继续运行。 */
  function consumeModuleBlock() {
    const reason = moduleBlockReason;
    moduleBlockReason = null;
    return reason;
  }
  /**
   * 判断请求是否仍有未决记录；只允许持久化过的写请求在读回确认后恢复，避免把外部变化误当成新操作成功。
   *
   * @param {string} key 请求幂等键。
   * @returns {boolean} 是否需要先做只读结算。
   */
  function hasPending(key) { return uncertain.has(key) || Boolean(ledger.pending[key]); }
  /** 读取当前配置表；缺表由调用方明确报告，不能套用历史数值。 */
  function rows(name) { return config?.tables?.[name]?.data ?? []; }
  /** 串行只读查询并缓存服务端真值，供提交后确认使用。 */
  async function query(name, body = {}, response = `${name.slice(0, -7)}Response`) {
    assertReady();
    if (!protocol[name] || !protocol[response]) throw new Error(`当前协议不支持 ${name}/${response}`);
    validateMessage(protocol[name], body);
    const value = await client.request(name, body, response, 8000);
    assertReady();
    snapshots.set(name, value);
    // 服务端缓存只接收成功的协议回包；动作中的确认查询也能即时更新对应分类。
    onQuery(name, value);
    return value;
  }
  /** 每个模块入口及发生写操作后刷新库存，避免重复消费过期快照。 */
  async function refreshStock() {
    const items = await query('AllItemRequest');
    const resources = await query('AllResourceRequest');
    stock.clear();
    for (const item of items.items ?? []) stock.set(item.itemId, amount(item.num));
    for (const resource of resources.list ?? []) {
      const key = Object.entries(protocol.Resource).find(([, value]) => value === resource.res)?.[0];
      if (key) stock.set(key, amount(resource.amount));
    }
    return stock;
  }
  /** 计算道具与资源的共同需求；多个资产同名时累计，不重复使用库存。 */
  function enough(costs = [], keep = {}) {
    const needed = new Map();
    for (const [id, count] of costs) {
      if (!id || !Number.isFinite(Number(count)) || Number(count) < 0) throw new Error('资产消耗配置无效');
      needed.set(id, (needed.get(id) ?? 0) + Number(count));
    }
    return [...needed].every(([id, count]) => (stock.get(id) ?? 0) - (keep[id] ?? 0) >= count);
  }
  /**
   * 为一个已知价格的消费预留账本金额；强制券购买只跳过额度比较，仍检查实时余额。
   *
   * @param {string} key 请求幂等键。
   * @param {number} ruby 本次预计消耗的钻石数。
   * @param {{ bypassSpendingLimits?: boolean }} options 是否允许突破普通钻石额度与保留量。
   * @returns {string|null} 预留令牌；零钻石动作不创建预留。
   */
  function reserve(key, ruby, { bypassSpendingLimits = false } = {}) {
    if (!Number.isFinite(ruby) || ruby < 0) throw new Error('消费价格无效');
    if (ruby === 0) return null;
    const policy = settings.spending;
    day();
    const account = accountSpending(accountId, roleId, ledger, now());
    const balanceHeld = Object.values(ledger.pending).reduce((sum, p) => sum + p.ruby, 0);
    if (bypassSpendingLimits) {
      // 强制目标券仍不能制造负钻石；未确认预留也必须从可用余额中扣除。
      if ((stock.get('RUBY') ?? 0) - balanceHeld - ruby < 0) throw new Error('钻石余额不足');
    } else {
      if (!policy.enabled || policy.dailyLimit <= 0 || (policy.modules[moduleId] ?? 0) <= 0) throw new Error('钻石消费未开启或额度为 0');
      if (account.spent + account.held + ruby > policy.dailyLimit || (account.modules[moduleId] ?? 0) + (account.heldModules[moduleId] ?? 0) + ruby > policy.modules[moduleId]) throw new Error('钻石日额度不足');
      if ((stock.get('RUBY') ?? 0) - balanceHeld - ruby < policy.minRubyStock) throw new Error('消费后低于钻石保留量');
    }
    const token = randomUUID();
    ledger.pending[key] = { token, ruby, module: moduleId, date: businessDate(now()) };
    persist(); return token;
  }
  /**
   * 执行单条写请求；提交前预留，回包或读回后才能标记成功。
   *
   * @param {string} name 协议请求名。
   * @param {object} body 已通过 protobuf 校验的请求体。
   * @param {{ response?: string|null, confirm?: () => Promise<boolean>, accept?: (value: unknown) => boolean|Promise<boolean>, onRejected?: (error: Error) => object|null|Promise<object|null>, allowed?: () => boolean, continueAfterUncertain?: boolean, blockModuleOnUncertain?: boolean, confirmAfterResponse?: boolean, bypassSpendingLimits?: boolean }} options 写入选项；allowed 在实际提交前复查日期，空回包不能证明业务状态时强制执行 confirm 读回；onRejected 只用于把已知无副作用的服务端拒绝转成业务跳过。
   */
  async function action(name, body = {}, { label = name, ruby = 0, expenses = [], response, confirm, accept, onRejected, allowed = () => true, timeout = 8000, key = `${name}:${JSON.stringify(body)}`, continueAfterUncertain = false, blockModuleOnUncertain = true, confirmAfterResponse = false, bypassSpendingLimits = false } = {}) {
    assertReady();
    if (!protocol[name]) return record({ request: name, label, status: 'skipped', reason: '当前协议缺少请求' });
    if (!enough(expenses)) return record({ request: name, label, status: 'skipped', reason: '资源不足' });
    ruby = Math.max(ruby, expenses.filter(([id]) => id === 'RUBY').reduce((sum, [, num]) => sum + num, 0));
    // 使用当前生成器校验必填字段；多余字段会被 protobuf 静默丢弃，所以显式拒绝。
    validateMessage(protocol[name], body);
    if (hasPending(key)) {
      // 上轮写入可能已在服务端生效但确认读回迟到；先只读核验并结算原预留，绝不重发请求。
      let verified = false;
      if (confirm && client.connected && !fatal) {
        try { verified = await confirm(); } catch { /* 读回失败仍按未确认处理。 */ }
      }
      if (verified) {
        const pendingRuby = ledger.pending[key]?.ruby ?? ruby;
        settlePending(key);
        return record({ request: name, label, status: 'success', verifiedByRead: true, ruby: pendingRuby });
      }
      // 有些互不依赖的权益可只跳过当前动作；默认仍隔离整个模块，避免改变既有写入保护边界。
      if (continueAfterUncertain) {
        if (blockModuleOnUncertain) blockModule('上次结果未确认，禁止重复提交');
      } else stop.aborted = true;
      return record({ request: name, label, status: 'uncertain', reason: '上次结果未确认，禁止重复提交' });
    }
    // 宠物和装备可能在同批次跨过上海午夜，不能只在模块入口检查一次执行日。
    if ((['pet', 'equip'].includes(moduleId) && !moduleActive(moduleId, settings.modules[moduleId], { client, now })) || !allowed())
      return record({ request: name, label, status: 'skipped', reason: '已离开设置的执行日期或活动周期' });
    if (dryRun) {
      // 预览也核验消费开关和额度，但不落盘预留、不向网关发送写请求。
      try { reserve(key, ruby, { bypassSpendingLimits }); delete ledger.pending[key]; } catch (error) { return record({ request: name, label, status: 'skipped', reason: error.message }); }
      for (const [id, num] of expenses) stock.set(id, (stock.get(id) ?? 0) - num);
      if (ruby > 0) { const d = day(); d.spent += ruby; d.modules[moduleId] = (d.modules[moduleId] ?? 0) + ruby; if (!expenses.some(([id]) => id === 'RUBY')) stock.set('RUBY', (stock.get('RUBY') ?? 0) - ruby); }
      return record({ request: name, body, label, ruby, status: 'planned' });
    }
    if (writes >= 500) throw new Error('单轮动作达到上限');
    let token;
    try { token = reserve(key, ruby, { bypassSpendingLimits }); } catch (error) { return record({ request: name, label, status: 'skipped', reason: error.message }); }
    const expected = response === undefined ? (protocol[`${name.slice(0, -7)}Response`] ? `${name.slice(0, -7)}Response` : null) : response;
    /** 结算只发生一次；库存刷新失败不能把已确认消费重新变成预留。 */
    function settle() { if (token && settlePending(key)) token = null; }
    let value;
    let responseReceived = false;
    try {
      writes++;
      if (expected) {
        value = await client.request(name, body, expected, timeout);
        responseReceived = true;
      }
      else await client.sendWatch(name, body, { window: 500 });
      // 没有专用回包时，必须使用调用方提供的业务读回条件。
      if (accept && !await accept(value)) {
        // 战斗失败等属于已确认的业务结果，仍结算已发生消费，但不推进下一步。
        settle();
        try { await refreshStock(); } catch (error) { stop.aborted = true; record({ status: 'error', reason: `已确认失败，但库存刷新失败：${error.message}` }); }
        return record({ request: name, label, status: 'failed', value, ruby });
      }
      // 部分协议会返回空的专用 Response；调用方显式要求时，仍要以业务状态读回确认写入。
      let verified = Boolean(expected);
      if (confirmAfterResponse || !expected) verified = confirm ? await confirm() : false;
      if (!verified) throw new Error('写请求已发出，业务状态尚未确认');
    } catch (error) {
      if (responseReceived && accept) {
        // 业务回包已证明本次写入完成；后续读回失败不能再把同一动作当作未发送而永久拦截。
        settle();
        try { await refreshStock(); } catch (refreshError) { stop.aborted = true; record({ status: 'error', reason: `已确认操作，但库存刷新失败：${refreshError.message}` }); }
        return record({ request: name, label, status: 'failed', reason: `已收到 ${expected}，但业务状态读回失败：${error.message}`, value, ruby });
      }
      if (error.prompt) {
        if (token) { delete ledger.pending[key]; persist(); }
        // 某些幂等领奖接口会用 PromptResponse 表示“已被其他流程领取”；调用方可将这种确定无副作用的拒绝显示为跳过。
        if (onRejected) {
          const handled = await onRejected(error);
          if (handled) return record({ request: name, label, status: handled.status ?? 'skipped', reason: handled.reason ?? error.message });
        }
        return record({ request: name, label, status: 'rejected', reason: error.message });
      }
      // 超时后只读核对；没有证据的请求留存为未确认，不能当作成功或再次发送。
      let verified = false;
      if (confirm && client.connected && !stop.aborted && !fatal) {
        try { verified = await confirm(); } catch { /* 读回失败仍为未确认。 */ }
      }
      if (verified) {
        settle();
        try { await refreshStock(); } catch (refreshError) { stop.aborted = true; record({ status: 'error', reason: `已确认操作，但库存刷新失败：${refreshError.message}` }); }
        return record({ request: name, label, status: 'success', verifiedByRead: true, ruby });
      }
      uncertain.add(key);
      if (!ledger.pending[key]) ledger.pending[key] = { token: randomUUID(), ruby, module: moduleId, date: businessDate(now()) };
      persist();
      // 未确认记录已经落盘，即使继续本轮也会阻止该幂等键重发。
      if (continueAfterUncertain) {
        if (blockModuleOnUncertain) blockModule(error.message);
      } else stop.aborted = true;
      return record({ request: name, label, status: 'uncertain', reason: error.message });
    }
    settle();
    try { await refreshStock(); } catch (error) { stop.aborted = true; record({ status: 'error', reason: `已确认操作，但库存刷新失败：${error.message}` }); }
    return record({ request: name, label, status: 'success', value, ruby });
  }
  /** 通过服务端计数与本地日计数共同约束限制类玩法。 */
  function count(key, increment = 0) { const d = day(); d.counts[key] = (d.counts[key] ?? 0) + increment; if (increment) persist(); return d.counts[key]; }
  /** 跨轮状态归属当前账号角色；远征等跨日流程按其业务周期键保存。 */
  function memory(key, value) {
    ledger.state ??= {};
    if (value !== undefined) { ledger.state[key] = value; persist(); }
    return ledger.state[key];
  }
  /** 释放事件订阅，避免多轮运行累积监听器。 */
  function dispose() { client.off('fatal', terminal); client.off('close', terminal); client.off('message', capture); }
  /** 将结果与额度归属切换到当前玩法。 */
  function setModule(id) { moduleId = id; moduleBlockReason = null; }
  return { client, protocol, config, player, accountId, roleId, season: settings.season, settings, dryRun, stop, now, results, snapshots, pushes, stock, ledger, query, action, rows, enough, refreshStock, record, count, memory, dispose, assertReady, setModule, settlePending, consumeModuleBlock, hasPending, get moduleId() { return moduleId; } };
}
