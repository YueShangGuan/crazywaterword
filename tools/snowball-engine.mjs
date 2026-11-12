// 走江踏浪离线对局引擎：从抓包提取出怪/补牌时刻表，支持任意操作序列的确定性回放。
//
// 引擎规则（全部由 capture-fksj-20261109-101709 的 92 回合真实对局校验）：
//   op → 伙伴攻击 → 怪物推进 +5（越过 29 判负）→ 服务端补怪/补牌
//   每次操作消耗 1 体力并得 10 基础分，击杀另加 maxHp；用符不耗回合不耗体力。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodec } from '../src/codec.mjs';
import { loadProtocol, PROTO_BUNDLE } from '../src/proto.mjs';

export const POWER = level => 2 ** (Math.min(10, Math.max(1, level)) - 1);
// 男伙伴伤害模型（用整局回放择优）：
//   A 单发 2^(lv-1)   B 单发 max(2, 2^(lv-1))   C 两发×2^(lv-1)
export const MALE_MODELS = {
  A: level => [{ count: 1, power: POWER(level) }],
  B: level => [{ count: 1, power: Math.max(2, POWER(level)) }],
  C: level => [{ count: 2, power: POWER(level) }],
};
let maleModel = 'A';
export function setMaleModel(name) { maleModel = name; }
// 机制开关（网格搜索择优）：
//   charge: off | jump(跳格Δ≥2 冲锋=移动者威力打全场最前) | move(任意移动) | jump1(跳格补1) | move1(任意移动补1)
//   combo:  同列连续命中同目标，伤害按 2^连击数 翻倍
//   parting: 移动距离=1 时对原列最前补 1 点
export const ENGINE_FLAGS = { charge: 'off', combo: false, parting: false, ageMult: false, bigWidth: 2, bigAnchor: 'left', targetBy: 'maxCell' };
// 大怪横跨的列：占 bigWidth 列，锚点=头部格(left)或尾部(right)
export function bigColumns(name, index) {
  if (name !== '大怪') return [column(index)];
  const w = ENGINE_FLAGS.bigWidth;
  const base = ENGINE_FLAGS.bigAnchor === 'left' ? column(index) : (column(index) - w + 1 + 5) % 5;
  const cols = [];
  for (let k = 0; k < w; k += 1) cols.push((base + k) % 5);
  return cols;
}
export function setFlags(flags) { Object.assign(ENGINE_FLAGS, flags); }
export const column = index => index % 5;
const isToken = name => /信物/.test(name);

/** 解码抓包目录里的全部 Snowball 帧，按时间顺序返回 {id, name, body} 列表。 */
export function decodeSnowballFrames(dir) {
  const protocol = loadProtocol(PROTO_BUNDLE);
  const codec = createCodec(protocol);
  const events = [];
  for (const file of readdirSync(join(dir, 'frames')).filter(f => f.endsWith('.bin')).sort()) {
    let decoded;
    try {
      decoded = codec.decode(readFileSync(join(dir, 'frames', file)));
    } catch {
      continue;
    }
    if (/^Snowball/.test(decoded.name)) events.push({ id: parseInt(file, 10), name: decoded.name, body: decoded.body });
  }
  return events;
}

/** 从解码事件里提取：初始快照、真实操作序列、每回合出怪表、补牌队。 */
export function extractReplay(dir) {
  const events = decodeSnowballFrames(dir);
  let initial = null;
  const actions = []; // {type:'op',fromZone,fromIndex,toIndex} | {type:'fire',column} | {type:'ice'}
  const responses = []; // 每个操作后的服务端快照
  for (const ev of events) {
    if (ev.name === 'SnowballStartResponse' && !initial) initial = ev.body.session.snapshot;
    else if (ev.name === 'SnowballOpRequest') actions.push({ type: 'op', ...ev.body });
    else if (ev.name === 'SnowballUseItemRequest') {
      const { itemName, column: col } = ev.body;
      actions.push(itemName.includes('火焰') ? { type: 'fire', column: col } : { type: 'ice' });
    } else if ((ev.name === 'SnowballOpResponse' || ev.name === 'SnowballUseItemResponse') && initial) {
      responses.push(ev.body.snapshot);
    }
  }
  if (!initial) throw new Error('抓包里没有 SnowballStartResponse');

  // 出怪表：对比相邻快照，能被「上一回合 i-5 位置同 名字+maxHp 且血量不增」解释的是推进，其余是新增
  const spawns = new Map(); // round -> [{index, name, hp, maxHp}]
  let prev = initial;
  for (let step = 0; step < responses.length; step += 1) {
    const next = responses[step];
    const round = next.round;
    const source = [...prev.battlefield];
    const fresh = [];
    for (const enemy of [...next.battlefield].sort((a, b) => b.index - a.index)) {
      const from = source.findIndex(
        e => e && e.index === enemy.index - 5 && e.name === enemy.name && e.maxHp === enemy.maxHp && e.hp >= enemy.hp,
      );
      if (from >= 0) source[from] = null;
      else fresh.push({ index: enemy.index, name: enemy.name, hp: enemy.hp, maxHp: enemy.maxHp });
    }
    if (fresh.length) spawns.set(round, fresh);
    prev = next;
  }

  // 补牌队：对比相邻快照的休息区，扣除玩家取走的牌和信物转化，剩下的是服务端补充
  const refills = []; // 按顺序：{round, name, level}
  let prevRest = initial.rest.map(card => ({ ...card }));
  let prevEnemies = initial.battlefield.map(e => ({ ...e }));
  let restTaken = null;
  let tokenConverted = [];
  let actionIdx = 0;
  for (let step = 0; step < responses.length; step += 1) {
    const next = responses[step];
    const action = actions[actionIdx];
    actionIdx += 1;
    restTaken = null;
    tokenConverted = [];
    if (action?.type === 'op') {
      if (action.fromZone === 1) restTaken = prevRest[action.fromIndex] ?? null;
      // 信物转化：本回合攻击阶段被打掉的信物 → 对应 1 级伙伴进休息区
      tokenConverted = prevEnemies
        .filter(e => isToken(e.name))
        .filter(e => !next.battlefield.some(n => n.name === e.name && n.index === e.index + 5))
        .map(e => ({ name: e.name === '男信物' ? '男伙伴' : '女伙伴', level: 1 }));
    }
    // 快照的 rest 只含有牌的槽位（空=空数组），必须按 index 对齐到固定 2 槽
    const expected = Array(2).fill(null);
    for (const card of prevRest) if (card) expected[card.index] = { ...card };
    if (restTaken && action) expected[action.fromIndex] = null;
    for (const card of tokenConverted) {
      const slot = expected.findIndex(c => !c);
      if (slot >= 0) expected[slot] = card;
    }
    for (let slot = 0; slot < 2; slot += 1) {
      const actual = next.rest.find(c => c.index === slot);
      if (actual && !expected[slot]) refills.push({ round: next.round, name: actual.name, level: actual.level });
    }
    prevRest = next.rest.map(card => ({ ...card }));
    prevEnemies = next.battlefield.map(e => ({ ...e }));
  }
  return { initial, actions, responses, spawns, refills };
}

/** 空棋盘状态。 */
export function initialState(initial) {
  const state = {
    partners: Array(10).fill(null),
    rest: Array(2).fill(null),
    enemies: Array(30).fill(null),
    round: initial.round,
    score: initial.score,
    baseHp: initial.baseHp ?? 20,
    frozen: false,
    failed: false,
    fireUsed: 0,
    iceUsed: 0,
  };
  for (const e of initial.battlefield) state.enemies[e.index] = { name: e.name, hp: e.hp, maxHp: e.maxHp, born: initial.round };
  for (const p of initial.partner) state.partners[p.index] = { name: p.name, level: p.level };
  for (const r of initial.rest) state.rest[r.index] = { name: r.name, level: r.level };
  return state;
}

function cloneState(state) {
  return {
    partners: state.partners.map(p => (p ? { ...p } : null)),
    rest: state.rest.map(p => (p ? { ...p } : null)),
    enemies: state.enemies.map(e => (e ? { ...e } : null)),
    round: state.round, score: state.score, frozen: state.frozen,
    baseHp: state.baseHp, failed: state.failed, fireUsed: state.fireUsed, iceUsed: state.iceUsed,
    colStreak: [...(state.colStreak ?? [0, 0, 0, 0, 0])],
  };
}

function attackPhase(state, colStreak) {
  let gain = 0;
  const females = [];
  const males = [];
  for (let i = 0; i < 10; i += 1) {
    const p = state.partners[i];
    if (!p) continue;
    (p.name === '女伙伴' ? females : males).push({ index: i, ...p });
  }
  // 年龄增伤假设：怪物存活第 2 回合起每多活 1 回合受伤 ×2（封顶 ×16）
  const ageMult = e => {
    if (!ENGINE_FLAGS.ageMult) return 1;
    const age = (state.round - (e.born ?? state.round)) + 1;
    return 2 ** Math.min(4, Math.max(0, age - 1));
  };
  const colDealt = {};
  const multOf = col => (ENGINE_FLAGS.combo ? 2 ** Math.min(3, colStreak?.[col] ?? 0) : 1);
  for (const p of females) {
    const col = column(p.index);
    const mult = multOf(col);
    for (let i = 0; i < 30; i += 1) {
      const e = state.enemies[i];
      if (!e || !bigColumns(e.name, i).includes(col) || isToken(e.name)) continue;
      e.hp -= POWER(p.level) * mult * ageMult(e);
      colDealt[col] = true;
      if (e.hp <= 0) { gain += e.maxHp; state.enemies[i] = null; }
    }
  }
  for (const p of males) {
    const col = column(p.index);
    const mult = multOf(col);
    const hits = MALE_MODELS[maleModel](p.level);
    for (const { count, power } of hits) {
      for (let shot = 0; shot < count; shot += 1) {
        let target = -1;
        let targetFront = -1;
        for (let i = 0; i < 30; i += 1) {
          const e = state.enemies[i];
          if (!e) continue;
          const cols = bigColumns(e.name, i);
          if (!cols.includes(col)) continue;
          // 索敌比较键：maxCell=覆盖本列的最大格；head=怪物头部格
          let front;
          if (ENGINE_FLAGS.targetBy === 'head') front = i;
          else {
            front = i;
            if (e.name === '大怪' && (i + 1) % 5 === col) front = i + 1;
            if (ENGINE_FLAGS.bigWidth >= 3 && e.name === '大怪' && (i + 2) % 5 === col) front = Math.max(front, i + 2);
          }
          if (front > targetFront) { targetFront = front; target = i; }
        }
        if (target < 0) break;
        const e = state.enemies[target];
        if (isToken(e.name)) {
          state.enemies[target] = null;
          const slot = state.rest.findIndex(c => !c);
          if (slot >= 0) state.rest[slot] = { name: e.name === '男信物' ? '男伙伴' : '女伙伴', level: 1 };
        } else {
          e.hp -= power * mult * ageMult(e);
          colDealt[col] = true;
          if (e.hp <= 0) { gain += e.maxHp; state.enemies[target] = null; }
        }
      }
    }
  }
  if (colStreak) {
    for (let col = 0; col < 5; col += 1) {
      colStreak[col] = colDealt[col] ? Math.min(3, (colStreak[col] ?? 0) + 1) : 0;
    }
  }
  return gain;
}

/**
 * 执行一步。
 * @param action {type:'op',fromZone,fromIndex,toIndex} | {type:'fire',column} | {type:'ice'}
 * @param schedule {spawns:Map, refills:[{round,name,level}]}
 */
export function step(state, action, schedule, refillCursor = { i: 0 }) {
  const next = cloneState(state);
  if (action.type === 'fire') {
    // 火焰符（用户确认 + r64 实测）：目标列（含大怪覆盖列）全部怪物烧死，无视血量
    let gain = 0;
    for (let i = 0; i < 30; i += 1) {
      const e = next.enemies[i];
      if (!e || isToken(e.name)) continue;
      if (!bigColumns(e.name, i).includes(action.column)) continue;
      gain += e.maxHp;
      next.enemies[i] = null;
    }
    next.fireUsed += 1;
    next.score += gain;
    return next;
  }
  if (action.type === 'ice') {
    next.iceUsed += 1;
    next.frozen = true; // 下一次 op 的推进阶段跳过
    return next;
  }
  // —— 普通操作 ——
  const { fromZone, fromIndex, toIndex } = action;
  // 冲锋/搬移增伤假设（网格搜索择优）：棋盘内移动后，移动者向全场最前非信物目标补刀
  let charger = null;
  {
    const mode = ENGINE_FLAGS.charge;
    const dist = Math.abs(toIndex - fromIndex);
    if (fromZone === 2 && mode !== 'off' && dist > 0) {
      const jump = dist >= 2;
      if (mode === 'move' || mode === 'move1' || (mode === 'jump' || mode === 'jump1') && jump) {
        charger = next.partners[fromIndex] ?? null;
      }
    }
  }
  if (fromZone === 1) {
    // 休息区卡上阵：落空位=放置；落同名同级=直接合成；落异卡=交换（上阵卡回休息区）
    const mover = next.rest[fromIndex];
    if (!mover) return null;
    const target = next.partners[toIndex];
    next.rest[fromIndex] = null;
    if (!target) next.partners[toIndex] = mover;
    else if (target.name === mover.name && target.level === mover.level && target.level < 10) {
      next.partners[toIndex] = { name: target.name, level: target.level + 1 };
    } else {
      next.partners[toIndex] = mover;
      next.rest[fromIndex] = target;
    }
  } else {
    const mover = next.partners[fromIndex];
    if (!mover || fromIndex === toIndex) return null;
    const target = next.partners[toIndex];
    next.partners[fromIndex] = null;
    if (!target) next.partners[toIndex] = mover;
    else if (target.name === mover.name && target.level === mover.level && target.level < 10) {
      next.partners[toIndex] = { name: target.name, level: target.level + 1 };
    } else {
      next.partners[toIndex] = mover;
      next.partners[fromIndex] = target;
    }
  }
  let gain = 0;
  if (charger) {
    for (let i = 29; i >= 0; i -= 1) {
      const e = next.enemies[i];
      if (!e || isToken(e.name)) continue;
      e.hp -= ENGINE_FLAGS.charge.endsWith('1') ? 1 : POWER(charger.level);
      if (e.hp <= 0) { gain += e.maxHp; next.enemies[i] = null; }
      break;
    }
  }
  if (!next.colStreak) next.colStreak = [0, 0, 0, 0, 0];
  gain += attackPhase(next, next.colStreak);
  // 推进：高 index 先走。攻击阶段已先结算：被打死的怪（含最后一排）直接移除并计分；
  // 活着越过终点的怪 = 立刻判负（r92 实证：19/27 小怪走出去 → failed）。
  // 信物走出去则转化为伙伴卡进休息区，不判负。
  if (!next.frozen) {
    for (let i = 29; i >= 0; i -= 1) {
      const e = next.enemies[i];
      if (!e) continue;
      if (i + 5 > 29) {
        next.enemies[i] = null;
        if (isToken(e.name)) {
          const slot = next.rest.findIndex(c => !c);
          if (slot >= 0) next.rest[slot] = { name: e.name === '男信物' ? '男伙伴' : '女伙伴', level: 1 };
        } else {
          next.failed = true;
        }
        continue;
      }
      next.enemies[i + 5] = e;
      if (i + 5 !== i) next.enemies[i] = null;
    }
  } else {
    next.frozen = false;
  }
  // 补怪（记录出生回合，用于「存活越久受伤翻倍」假设）
  const fresh = schedule.spawns.get(next.round + 1) ?? [];
  for (const s of fresh) next.enemies[s.index] = { name: s.name, hp: s.hp, maxHp: s.maxHp, born: next.round + 1 };
  // 补牌：只补「本回合计划补充」的牌，最多填满空位
  for (let slot = 0; slot < 2; slot += 1) {
    if (!next.rest[slot] && refillCursor.i < schedule.refills.length) {
      const card = schedule.refills[refillCursor.i];
      if (card.round === next.round + 1) {
        next.rest[slot] = { name: card.name, level: card.level };
        refillCursor.i += 1;
      } else break;
    }
  }
  next.round += 1;
  next.score += 10 + gain;
  return next;
}

/** 用真实操作序列回放，逐回合对照抓包快照。返回不一致明细。 */
export function validateReplay(dir, verbose = false) {
  const { initial, actions, responses, spawns, refills } = extractReplay(dir);
  const schedule = { spawns, refills };
  let state = initialState(initial);
  const cursor = { i: 0 };
  const mismatches = [];
  for (let k = 0; k < actions.length; k += 1) {
    state = step(state, actions[k], schedule, cursor);
    if (!state) { mismatches.push({ k, error: '非法操作' }); break; }
    const truth = responses[k];
    const got = state;
    const truthEnemies = truth.battlefield.map(e => `${e.name}@${e.index}:${e.hp}/${e.maxHp}`).sort();
    const gotEnemies = got.enemies
      .map((e, i) => (e ? `${e.name}@${i}:${e.hp}/${e.maxHp}` : null))
      .filter(Boolean).sort();
    const truthPartners = truth.partner.map(p => `${p.name}${p.level}@${p.index}`).sort();
    const gotPartners = got.partners.map((p, i) => (p ? `${p.name}${p.level}@${i}` : null)).filter(Boolean).sort();
    const truthRest = truth.rest.map(p => `${p.name}${p.level}@${p.index}`).sort();
    const gotRest = got.rest.map((p, i) => (p ? `${p.name}${p.level}@${i}` : null)).filter(Boolean).sort();
    const problems = [];
    if (truth.score !== got.score) problems.push(`分 ${got.score}≠${truth.score}`);
    if (truth.round !== got.round) problems.push(`回合 ${got.round}≠${truth.round}`);
    if (truthEnemies.join() !== gotEnemies.join()) problems.push(`怪 [${gotEnemies}]≠[${truthEnemies}]`);
    if (truthPartners.join() !== gotPartners.join()) problems.push(`伙伴 [${gotPartners}]≠[${truthPartners}]`);
    if (truthRest.join() !== gotRest.join()) problems.push(`休息 [${gotRest}]≠[${truthRest}]`);
    if (problems.length) mismatches.push({ k, round: got.round, problems });
    if (state.failed) break;
  }
  if (verbose) {
    console.log(`动作 ${actions.length} 个，快照 ${responses.length} 份，出怪回合 ${spawns.size}，补牌 ${refills.length} 张`);
  }
  return { mismatches, final: state, total: actions.length, schedule: { spawns, refills } };
}
