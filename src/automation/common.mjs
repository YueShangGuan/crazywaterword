import { amount, idString } from './context.mjs';

/**
 * 从工厂收成待确认键中还原目标建筑，格式异常时不尝试猜测目标。
 *
 * @param {string} key 待确认账本键。
 * @returns {string|null} 工厂建筑 ID；无法证明目标时返回 null。
 */
function pendingFactoryHarvestBuildingId(key) {
  const prefix = 'GainFactoryProduceRequest:';
  if (!key.startsWith(prefix)) return null;
  try {
    const { buildingId } = JSON.parse(key.slice(prefix.length));
    return typeof buildingId === 'string' && buildingId ? buildingId : null;
  } catch { return null; }
}

/**
 * 通过工厂当前待领列表结算已不再可见的收成请求。
 *
 * 收成请求超时后不能重发；但同一工厂已没有待领成品时，旧收成无论由原请求还是人工操作完成，
 * 都不再存在可重复领取的目标，可以安全解除该请求的幂等锁。
 *
 * @param {object} ctx 自动化上下文。
 * @returns {Promise<void>} 所有可由当前工厂快照证明完成的收成记录已结算。
 */
export async function reconcileFactoryHarvestPending(ctx) {
  const pending = Object.keys(ctx.ledger.pending)
    .map(key => ({ key, buildingId: pendingFactoryHarvestBuildingId(key) }))
    .filter(entry => entry.buildingId);
  if (!pending.length) return;
  const water = await ctx.query('OnWaterRequest');
  for (const { key, buildingId } of pending) {
    const factory = water.building?.find(building => building.buildingId === buildingId)?.factory;
    // 仅空待领列表能证明旧收成已经不再可重复领取；工厂不存在或仍有成品都保留保护锁。
    if (factory && !(factory.finishedProducts?.length) && ctx.settlePending(key)) {
      ctx.record({ request: 'GainFactoryProduceRequest', label: `恢复未确认工厂收成 ${buildingId}`, status: 'success', verifiedByRead: true });
    }
  }
}

/** 将协议资产转换为规划器统一使用的物品/资源需求。 */
export function costs(assets = [], protocol) {
  return assets.filter(Boolean).map(a => [a.type === 1 ? Object.entries(protocol.Resource).find(([, value]) => value === Number(a.id))?.[0] : a.id, amount(a.num)]);
}

/** 仅对业务成功或预览继续后续步骤，拒绝及不确定结果都必须停止当前流程。 */
export function succeeded(result) { return result?.status === 'success' || result?.status === 'planned'; }

/** 模块数据不足必须可见，不能悄悄换成另一版本字段。 */
export function skip(ctx, reason, label = '') { return ctx.record({ label, status: 'skipped', reason }); }

/** 奖励可能包含资源或物品，两种库存同时读回，避免只奖励金币时被误判未确认。 */
export async function rewardAction(ctx, request, body = {}, options = {}) {
  await ctx.refreshStock();
  const before = JSON.stringify([...ctx.stock].sort(([a], [b]) => a.localeCompare(b)));
  return ctx.action(request, body, { ...options, confirm: async () => {
    await ctx.refreshStock();
    return JSON.stringify([...ctx.stock].sort(([a], [b]) => a.localeCompare(b))) !== before;
  } });
}

/**
 * 静默写入用对应业务快照读回；预览只读取前态，不假设操作已经成功。
 *
 * @param {object} ctx 自动化上下文。
 * @param {string} request 写入协议名。
 * @param {object} body 写入请求体。
 * @param {string} stateRequest 读回状态协议名。
 * @param {(value: object) => unknown} select 用于比较写前写后状态的选择器。
 * @param {{ stateBody?: object, confirm?: () => Promise<boolean> }} options 读回参数；复杂异步状态可提供专用确认器。
 * @returns {Promise<object>} 统一写入结果。
 */
export async function mutate(ctx, request, body, stateRequest, select = value => value, options = {}) {
  const { stateBody = {}, confirm: suppliedConfirm, ...actionOptions } = options;
  const before = JSON.stringify(select(await ctx.query(stateRequest, stateBody)));
  // 默认比较读回快照；个别静默协议落库较慢时，调用方提供的确认器仍只读状态而不会重发写请求。
  const confirm = suppliedConfirm ?? (async () => JSON.stringify(select(await ctx.query(stateRequest, stateBody))) !== before);
  return ctx.action(request, body, { ...actionOptions, confirm });
}

/** 在明确的次数上限内刷新并处理，预览只产生第一步以免假定写操作已经生效。 */
export async function repeat(ctx, limit, work) {
  for (let index = 0; index < limit; index++) {
    ctx.assertReady();
    if (!await work(index) || ctx.dryRun) break;
  }
}

/** 上海时段允许跨午夜，空列表代表全天；两个端点相同代表全天。 */
export function inWindows(windows, now = Date.now()) {
  if (!windows?.length) return true;
  const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now)).split(':').map(Number);
  const current = hour * 60 + minute;
  return windows.some(w => {
    const convert = text => { const [h, m] = String(text).split(':').map(Number); return h * 60 + m; };
    const start = convert(w.start), end = convert(w.end);
    return start === end || (start < end ? current >= start && current <= end : current >= start || current <= end);
  });
}

/** 订阅推送必须先于触发请求，并能在停止、断线及超时后清理。 */
export async function awaitPush(ctx, names, trigger, timeout = 8000) {
  const messages = [];
  const listener = value => { if (names.includes(value.name)) messages.push(value); };
  ctx.client.on('message', listener);
  try {
    if (trigger) await trigger();
    const deadline = Date.now() + timeout;
    while (!messages.length && Date.now() < deadline) {
      ctx.assertReady();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return messages;
  } finally { ctx.client.off('message', listener); }
}

/** 以当前世界舰队状态筛出可派遣舰队，不沿用上个玩法的闲置列表。 */
export async function idleFleets(ctx) {
  const state = await ctx.query('MyFleetsRequest');
  const idle = ctx.protocol.FleetState?.IDLE;
  if (idle === undefined) throw new Error('当前协议缺少舰队闲置枚举');
  return (state.fleets ?? []).filter(f => f.state === idle && f.buildingId);
}

/** 品质顺序来自当前数值表，不通过中文名称猜测。 */
export function qualityIndex(ctx, table, idField, id) {
  return ctx.rows(table).find(r => r[idField] === id)?.qualityIndex;
}

/** 找出英雄、舰队和建筑结构里引用的 UID，避免释放正在使用的对象。 */
export function referencedIds(value, field, out = new Set()) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    if (key === field && item != null) out.add(idString(item));
    else if (item && typeof item === 'object') referencedIds(item, field, out);
  }
  return out;
}
