// 走江踏浪自动对局：只读取服务端快照，按棋盘威胁、伙伴合成和符文预算逐步决策。
//
// 协议边界：所有操作都以 SnowballOpResponse / SnowballUseItemResponse 返回的 snapshot 为准，
// 不根据上一回合推算怪物位置；开局和详情中的 session 只用于续接已有对局。

import { amount } from './context.mjs';
import { skip, succeeded } from './common.mjs';

const ENERGY = '打雪仗体力';
const FIRE = '打雪仗火焰符';
const ICE = '打雪仗冰冻符';
const MAX_ACTIONS = 500;
const POWER = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

function power(level) {
  return POWER[Math.min(10, Math.max(1, Number(level) || 1))] ?? 0;
}

function column(index) {
  return Number(index) % 5;
}

// 抓包显示大怪只下发左格 index，实际占 index 与 index+1 两列；第 4 列不会生成大怪。
function occupiedColumns(enemy) {
  const col = column(enemy?.index);
  return enemy?.name === '大怪' && col < 4 ? [col, col + 1] : [col];
}

// 大怪的右格才是更靠前的目标；普通怪物就是自身 index。
function frontIndex(enemy) {
  return enemy?.name === '大怪' && column(enemy.index) < 4 ? Number(enemy.index) + 1 : Number(enemy?.index);
}

/** 把协议快照转成可模拟的数组；令牌和怪物共用 battlefield，只按名称区分。 */
function snapshotState(snapshot) {
  const partners = Array(10).fill(null);
  const rest = Array(2).fill(null);
  const enemies = Array(30).fill(null);
  for (const partner of snapshot?.partner ?? []) {
    if (Number.isInteger(partner.index) && partner.index >= 0 && partner.index < 10) {
      partners[partner.index] = { name: partner.name, level: partner.level };
    }
  }
  for (const partner of snapshot?.rest ?? []) {
    if (Number.isInteger(partner.index) && partner.index >= 0 && partner.index < 2) {
      rest[partner.index] = { name: partner.name, level: partner.level };
    }
  }
  for (const enemy of snapshot?.battlefield ?? []) {
    if (Number.isInteger(enemy.index) && enemy.index >= 0 && enemy.index < 30) {
      enemies[enemy.index] = { index: enemy.index, name: enemy.name, hp: enemy.hp, max: enemy.maxHp };
    }
  }
  return { partners, rest, enemies, score: Number(snapshot?.score) || 0, round: Number(snapshot?.round) || 0, frozen: Boolean(snapshot?.frozen) };
}
function cloneState(state) {
  return {
    partners: state.partners.map(partner => partner ? { ...partner } : null),
    rest: state.rest.map(partner => partner ? { ...partner } : null),
    enemies: state.enemies.map(enemy => enemy ? { ...enemy } : null),
    score: state.score,
    round: state.round,
    frozen: state.frozen,
  };
}

function isToken(enemy) {
  return /信物/.test(enemy?.name ?? '');
}

/** 执行一次放置/移动/合成/交换；返回新状态，非法动作返回 null。 */
function applyMove(state, zone, from, to) {
  if (!Number.isInteger(to) || to < 0 || to >= 10) return null;
  if (zone === 2 && from === to) return null;
  const next = cloneState(state);
  if (zone === 1) {
    const mover = next.rest[from];
    if (!mover) return null;
    next.rest[from] = null;
    const target = next.partners[to];
    if (!target) next.partners[to] = mover;
    else if (target.name === mover.name && target.level === mover.level && target.level < 10) {
      next.partners[to] = { name: target.name, level: target.level + 1 };
    } else {
      next.partners[to] = mover;
      next.rest[from] = target;
    }
    return next;
  }
  const mover = next.partners[from];
  if (!mover) return null;
  next.partners[from] = null;
  const target = next.partners[to];
    if (!target) next.partners[to] = mover;
    else if (target.name === mover.name && target.level === mover.level && target.level < 10) {
      next.partners[to] = { name: target.name, level: target.level + 1 };
    } else {
      next.partners[to] = mover;
      next.partners[from] = target;
    }
  return next;
}

/** 模拟一次伙伴攻击：女伙伴打整列，男伙伴单发打最前方目标，令牌生成伙伴。 */
function simulateAttack(state) {
  let gain = 10;
  const females = [];
  const males = [];
  for (let i = 0; i < 10; i += 1) {
    const partner = state.partners[i];
    if (!partner) continue;
    (partner.name === '女伙伴' ? females : males).push({ index: i, ...partner });
  }
  for (const partner of [...females, ...males]) {
    const col = column(partner.index);
    if (partner.name === '女伙伴') {
      for (let i = 0; i < 30; i += 1) {
        const enemy = state.enemies[i];
        if (!enemy || !occupiedColumns(enemy).includes(col) || isToken(enemy)) continue;
        enemy.hp -= power(partner.level);
        if (enemy.hp <= 0) {
          gain += enemy.max;
          state.enemies[i] = null;
        }
      }
      continue;
    }
    // 男伙伴：对本列最前目标单发 2^(等级-1)。引擎 A 模型（男伙伴单发）是
    // capture-fksj-20261109 共 92 回合抓包的校验结论，不存在按等级增发的模型。
    let target = -1;
    for (let i = 0; i < 30; i += 1) {
      const enemy = state.enemies[i];
      if (!enemy || !occupiedColumns(enemy).includes(col)) continue;
      if (target < 0 || frontIndex(enemy) > frontIndex(state.enemies[target])) target = i;
    }
    if (target >= 0) {
      const enemy = state.enemies[target];
      if (isToken(enemy)) {
        state.enemies[target] = null;
        const slot = [0, 1].find(index => !state.rest[index]);
        if (slot !== undefined) {
          state.rest[slot] = { name: enemy.name === '男信物' ? '男伙伴' : '女伙伴', level: 1 };
        }
      } else {
        enemy.hp -= power(partner.level);
        if (enemy.hp <= 0) {
          gain += enemy.max;
          state.enemies[target] = null;
        }
      }
    }
  }
  return gain;
}

function coverage(state) {
  let count = 0;
  for (let col = 0; col < 5; col += 1) {
    if (state.partners.some((partner, index) => partner && column(index) === col)) count += 1;
  }
  return count;
}

function powerSum(state) {
  return state.partners.reduce((total, partner) => total + (partner ? power(partner.level) : 0), 0);
}

function restPower(state) {
  return state.rest.reduce((total, partner) => total + (partner ? power(partner.level) : 0), 0);
}

function tokenCount(state) {
  return state.enemies.reduce((total, enemy) => total + (enemy && isToken(enemy) ? 1 : 0), 0);
}

function threat(state) {
  const columns = Array(5).fill(0);
  for (let i = 0; i < 30; i += 1) {
    const enemy = state.enemies[i];
    if (!enemy) continue;
    const value = enemy.hp + frontIndex(enemy) * 0.15;
    for (const col of occupiedColumns(enemy)) columns[col] += value;
  }
  return columns;
}

function value(state, gain) {
  const threats = threat(state);
  const covered = coverage(state);
  const emptyRest = state.rest.filter(partner => !partner).length;
  const pressure = threats.reduce((sum, value, index) => {
    const has = state.partners.some((partner, cell) => partner && column(cell) === index);
    return sum + (has ? value * 0.15 : value * 3);
  }, 0);
  return gain + covered * 40 + powerSum(state) * 1.2 + restPower(state) * 8 + emptyRest - pressure;
}

/** 选出当前回合最优操作；符文只在明显高于普通操作、且满足保命/高血量条件时使用。 */
export function chooseAction(state, itemUse, stock) {
  let best = null;
  const countUsed = name => itemUse.find(item => item.itemId === name)?.usedCount ?? 0;
  const fireAvailable = countUsed(FIRE) < 5 && (stock.get(FIRE) ?? 0) > 0;
  const iceAvailable = countUsed(ICE) < 5 && (stock.get(ICE) ?? 0) > 0;

  const candidates = [];
  for (let slot = 0; slot < 2; slot += 1) {
    if (!state.rest[slot]) continue;
    // 放置只能落到空位；休息区伙伴不能直接与上阵区伙伴合成或交换。
    for (let to = 0; to < 10; to += 1) {
      if (!state.partners[to]) candidates.push({ kind: 'move', zone: 1, from: slot, to });
    }
  }
  for (let from = 0; from < 10; from += 1) {
    if (!state.partners[from]) continue;
    for (let to = 0; to < 10; to += 1) {
      if (from !== to) candidates.push({ kind: 'move', zone: 2, from, to });
    }
  }
  for (const action of candidates) {
    const next = applyMove(state, action.zone, action.from, action.to);
    if (!next) continue;
    const gain = simulateAttack(next);
    const score = value(next, gain) + Math.max(0, tokenCount(state) - tokenCount(next)) * 30;
    if (!best || score > best.score) best = { ...action, score, gain };
  }

  if (fireAvailable) {
    for (let col = 0; col < 5; col += 1) {
      let total = 0;
      for (let i = 0; i < 30; i += 1) {
        const enemy = state.enemies[i];
        if (enemy && occupiedColumns(enemy).includes(col) && !isToken(enemy)) total += enemy.max;
      }
      const high = total >= 60 || (total >= 30 && state.enemies.some((enemy, i) => enemy && occupiedColumns(enemy).includes(col) && frontIndex(enemy) >= 25));
      if (!high) continue;
      const next = cloneState(state);
      for (let i = 0; i < 30; i += 1) {
        const enemy = next.enemies[i];
        if (enemy && occupiedColumns(enemy).includes(col) && !isToken(enemy)) next.enemies[i] = null;
      }
      const score = value(next, total) + 20;
      if (!best || score > best.score + 15) best = { kind: 'fire', column: col, score, gain: total };
    }
  }

  if (iceAvailable && !state.frozen) {
    const imminent = state.enemies.some((enemy, i) => enemy && frontIndex(enemy) >= 27);
    if (imminent) {
      const next = cloneState(state);
      const score = value(next, 0) + 10;
      if (!best || score > best.score + 25) best = { kind: 'ice', score, gain: 0 };
    }
  }
  return best;
}

async function claimReward(ctx, detail) {
  const total = amount(detail?.totalScore);
  const claimed = amount(detail?.claimedTier);
  if (!(total > claimed)) return false;
  const result = await ctx.action('SnowballClaimRewardRequest', {}, {
    response: 'SnowballClaimRewardResponse',
    label: '走江踏浪 · 领取累计积分奖励',
    key: `snowball:claim:${total}`,
    // 回包丢失时无法安全重发（服务端可能已入账），未确认只跳过本次领取、等跨日
    // 释放作废；这个稳定键每轮入口都会命中，绝不能按默认语义中止整个自动化。
    continueAfterUncertain: true,
    blockModuleOnUncertain: false,
  });
  if (succeeded(result)) {
    ctx.record({ label: '走江踏浪 · 领取累计积分奖励', status: 'success', reason: `累计 ${total}，已领至 ${amount(result.value?.claimedTier)}` });
    return true;
  }
  return false;
}

/** 打一局；返回本局结束原因和剩余能量计数。 */
async function playSession(ctx, session, options) {
  let snapshot = session.snapshot;
  let energy = amount(ctx.stock.get(ENERGY));
  const multiplier = Math.max(1, Number(session.multiplier) || 1);
  let actions = 0;
  let failed = false;
  let reason = '已达到操作上限';
  while (actions < MAX_ACTIONS && !ctx.stop.aborted) {
    if (energy <= 0) { reason = '能量已耗尽'; break; }
    const state = snapshotState(snapshot);
    const itemUse = snapshot.itemUse ?? [];
    const action = chooseAction(state, itemUse, ctx.stock);
    if (!action) { reason = '没有可用操作'; break; }
    let result;
    if (action.kind === 'fire') {
      result = await ctx.action('SnowballUseItemRequest', { itemName: FIRE, column: action.column }, {
        response: 'SnowballUseItemResponse',
        label: `走江踏浪 · 火焰符第 ${action.column + 1} 列`,
        key: `snowball:fire:${Date.now()}:${actions}`,
        continueAfterUncertain: true,
        blockModuleOnUncertain: false,
      });
    } else if (action.kind === 'ice') {
      result = await ctx.action('SnowballUseItemRequest', { itemName: ICE }, {
        response: 'SnowballUseItemResponse',
        label: '走江踏浪 · 冰冻符',
        key: `snowball:ice:${Date.now()}:${actions}`,
        continueAfterUncertain: true,
        blockModuleOnUncertain: false,
      });
    } else {
      result = await ctx.action('SnowballOpRequest', {
        fromZone: action.zone, fromIndex: action.from, toIndex: action.to,
      }, {
        response: 'SnowballOpResponse',
        label: `走江踏浪 · 第 ${snapshot.round ?? '?'} 回合`,
        key: `snowball:op:${Date.now()}:${actions}`,
        continueAfterUncertain: true,
        blockModuleOnUncertain: false,
      });
    }
    actions += 1;
    if (!succeeded(result) || !result.value?.snapshot) { reason = '操作未返回有效快照'; break; }
    if (action.kind === 'move') energy -= multiplier;
    snapshot = result.value.snapshot;
    if (result.value.failed) { failed = true; reason = '本局失败'; break; }
  }
  return { snapshot, actions, energy, failed, reason };
}

/**
 * 活动入口：开启后至少打一局；autoStart 开启时只要还有能量就继续开下一局。
 * @param {object} ctx 自动化上下文。
 * @param {{enabled: boolean, minEnergy: number, autoStart: boolean}} options 走江踏浪设置。
 */
export async function snowball(ctx, options) {
  if (!options?.enabled) return;
  let detail;
  try {
    detail = await ctx.query('SnowballDetailRequest');
  } catch (error) {
    return skip(ctx, `走江踏浪不可用：${error.message}`, '走江踏浪');
  }
  await claimReward(ctx, detail);
  await ctx.refreshStock();
  let session = detail.session ?? null;
  let completed = false;
  while (!ctx.stop.aborted) {
    if (!session) {
      const energy = amount(ctx.stock.get(ENERGY));
      const minimum = options.autoStart ? 1 : Math.max(1, Number(options.minEnergy) || 100);
      if (energy < minimum) {
        return skip(ctx, `能量不足（${energy}/${minimum}），停止走江踏浪`, '走江踏浪');
      }
      const start = await ctx.action('SnowballStartRequest', { multiplier: 1 }, {
        response: 'SnowballStartResponse',
        label: '走江踏浪 · 开局',
        key: `snowball:start:${Date.now()}`,
      });
      if (!succeeded(start) || !start.value?.session) return skip(ctx, '开局未返回对局', '走江踏浪');
      session = start.value.session;
      ctx.record({ label: '走江踏浪 · 开局', status: 'success', reason: `能量 ${energy}` });
    }
    const result = await playSession(ctx, session, options);
    completed = true;
    ctx.record({
      label: '走江踏浪 · 本局结束',
      status: result.failed ? 'skipped' : 'success',
      reason: `${result.reason}，得分 ${amount(result.snapshot?.score)}，回合 ${amount(result.snapshot?.round)}，操作 ${result.actions}`,
    });
    session = null;
    await ctx.refreshStock();
    const after = await ctx.query('SnowballDetailRequest');
    if (await claimReward(ctx, after)) await ctx.refreshStock();
    if (!options.autoStart) return;
    if (amount(ctx.stock.get(ENERGY)) <= 0) return;
  }
  if (!completed) skip(ctx, '走江踏浪没有可执行的对局', '走江踏浪');
}
