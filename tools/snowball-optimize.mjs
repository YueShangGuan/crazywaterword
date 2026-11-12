// 走江踏浪策略优化器：在抓包回放引擎上比较不同打法，寻找最高得分。
//
// 用法:
//   node tools/snowball-optimize.mjs                 # 跑全部实验
//   node tools/snowball-optimize.mjs --quick         # 只跑关键对比
//
// 策略:
//   P0 production  现有 src/automation/snowball.mjs 的贪心启发式（移植）
//   P1 phase       分阶段启发式：先铺满5列→再补第二排→持续合成，符文按危机规则
//   P2 beam        beam search（宽度可调），评估函数=生存+火力+合成潜力

import { extractReplay, initialState, step, setFlags, bigColumns } from './snowball-engine.mjs';

const POWER = lv => 2 ** (Math.min(10, Math.max(1, lv)) - 1);
const BULLETS = lv => (lv <= 1 ? 1 : lv <= 3 ? 2 : 4); // 引擎校验后的模型：男1=1发
const isToken = name => /信物/.test(name);

setFlags({ bigWidth: 2, bigAnchor: 'left' });

const DIR = 'E:/MyProject/疯狂水世界/抓包/fksj-analyzer/capture-fksj-20261109-101709';
const { initial, spawns, refills } = extractReplay(DIR);
const SCHEDULE = { spawns, refills };
const FIRE_MAX = 5, ICE_MAX = 5;
export const TUNABLE = { fireGate: 25, nearGate: 20 };

function clone(s) {
  return JSON.parse(JSON.stringify(s));
}

/** 跑一整局。policy(state, used) 返回下一步动作或 null（放弃）。 */
function simulate(policy, { fireBudget = FIRE_MAX, iceBudget = ICE_MAX, maxActions = 400 } = {}) {
  let state = initialState(initial);
  const trace = [];
  for (let n = 0; n < maxActions; n += 1) {
    const used = { fire: state.fireUsed, ice: state.iceUsed };
    const action = policy(state, used, { fireBudget, iceBudget });
    if (!action) break;
    const next = step(state, action, SCHEDULE);
    if (!next) break;
    trace.push(action);
    state = next;
    if (state.failed) break;
  }
  return { state, trace };
}

// ───────────────────────── P0：现有自动化策略（移植） ─────────────────────────

function p0SimAttack(partners, enemies) {
  // 与生产代码一致的简化模型：女先打整列，男按弹数打本列最前
  let gain = 10;
  const females = [], males = [];
  for (let i = 0; i < 10; i += 1) {
    const p = partners[i];
    if (!p) continue;
    (p.name === '女伙伴' ? females : males).push({ index: i, ...p });
  }
  const hit = (e, dmg) => {
    e.hp -= dmg;
    if (e.hp <= 0) { gain += e.maxHp; return true; }
    return false;
  };
  for (const p of females) {
    const col = p.index % 5;
    for (let i = 0; i < 30; i += 1) {
      const e = enemies[i];
      if (!e || i % 5 !== col || isToken(e.name)) continue;
      if (hit(e, POWER(p.level))) enemies[i] = null;
    }
  }
  for (const p of males) {
    const col = p.index % 5;
    const shots = p.level <= 1 ? 1 : p.level <= 3 ? 2 : 4;
    for (let s = 0; s < shots; s += 1) {
      let t = -1;
      for (let i = 29; i >= 0; i -= 1) {
        if (enemies[i] && i % 5 === col) { t = i; break; }
      }
      if (t < 0) break;
      const e = enemies[t];
      if (isToken(e.name)) { enemies[t] = null; continue; }
      if (hit(e, POWER(p.level))) enemies[t] = null;
    }
  }
  return gain;
}

function p0Policy(state, used, { fireBudget, iceBudget }) {
  const partners = state.partners, rest = state.rest, enemies = state.enemies;
  const fireOk = used.fire < Math.min(FIRE_MAX, fireBudget);
  const iceOk = used.ice < Math.min(ICE_MAX, iceBudget) && !state.frozen;

  const applyMove = (zone, from, to) => {
    const P = partners.map(p => (p ? { ...p } : null));
    if (zone === 1) {
      const m = rest[from];
      if (!m) return null;
      if (P[to]) return null;
      P[to] = { ...m };
      return { partners: P, placed: { ...m, index: to } };
    }
    const m = P[from];
    if (!m || from === to) return null;
    const t = P[to];
    if (!t) { P[to] = m; P[from] = null; }
    else if (t.name === m.name && t.level === m.level && t.level < 10) { P[to] = { name: t.name, level: t.level + 1 }; P[from] = null; }
    else { P[to] = m; P[from] = t; }
    return { partners: P };
  };

  let best = null;
  const score = (next, gain) => {
    const cov = new Set();
    next.partners.forEach((p, i) => { if (p) cov.add(i % 5); });
    const powerSum = next.partners.reduce((s, p) => s + (p ? POWER(p.level) : 0), 0);
    const threat = [0, 0, 0, 0, 0];
    enemies.forEach((e, i) => { if (e) threat[i % 5] += e.hp + i * 0.15; });
    let pressure = 0;
    threat.forEach((t, c) => {
      const has = next.partners.some((p, i) => p && i % 5 === c);
      pressure += has ? t * 0.15 : t * 3;
    });
    return gain + cov.size * 40 + powerSum * 1.2 - pressure;
  };

  for (let z = 1; z <= 2; z += 1) {
    const slots = z === 1 ? 2 : 10;
    for (let from = 0; from < slots; from += 1) {
      if (z === 1 && !rest[from]) continue;
      if (z === 2 && !partners[from]) continue;
      for (let to = 0; to < 10; to += 1) {
        if (z === 2 && from === to) continue;
        if (z === 1 && partners[to]) continue;
        const next = applyMove(z, from, to);
        if (!next) continue;
        const E = enemies.map(e => (e ? { ...e } : null));
        const gain = p0SimAttack(next.partners, E);
        const v = score(next, gain);
        if (!best || v > best.v) best = { v, action: { type: 'op', fromZone: z, fromIndex: from, toIndex: to } };
      }
    }
  }
  if (fireOk) {
    for (let col = 0; col < 5; col += 1) {
      let total = 0, near = false;
      enemies.forEach((e, i) => {
        if (e && !isToken(e.name) && bigColumns(e.name, i).includes(col)) {
          total += e.maxHp;
          if (i >= 25) near = true;
        }
      });
      const high = total >= 60 || (total >= 30 && near);
      if (high) {
        const E = enemies.map(e => (e ? { ...e } : null));
        E.forEach((e, i) => { if (e && !isToken(e.name) && bigColumns(e.name, i).includes(col)) E[i] = null; });
        const v = score({ partners }, total) + 20;
        if (!best || v > best.v + 15) best = { v, action: { type: 'fire', column: col } };
      }
    }
  }
  if (iceOk) {
    const imminent = enemies.some((e, i) => e && i >= 27);
    if (imminent) {
      const v = score({ partners }, 0) + 10;
      if (!best || v > best.v + 25) best = { v, action: { type: 'ice' } };
    }
  }
  return best?.action ?? null;
}

// ───────────────────────── P1：分阶段启发式 ─────────────────────────

function boardInfo(state) {
  const threat = [0, 0, 0, 0, 0];
  let nearest = -1;
  state.enemies.forEach((e, i) => {
    if (!e || isToken(e.name)) return;
    for (const c of bigColumns(e.name, i)) threat[c] += e.hp * (1 + (i / 29) * 2);
    nearest = Math.max(nearest, i);
  });
  return { threat, nearest };
}

function p1Policy(state, used, { fireBudget, iceBudget, params = P1_DEFAULT }) {
  const { partners, rest, enemies } = state;
  const { threat } = boardInfo(state);
  const occupiedCols = new Set();
  partners.forEach((p, i) => { if (p) occupiedCols.add(i % 5); });
  const emptyBoard = [];
  partners.forEach((p, i) => { if (!p) emptyBoard.push(i); });

  // —— 危机符文 ——
  const fireOk = used.fire < Math.min(FIRE_MAX, fireBudget);
  const iceOk = used.ice < Math.min(ICE_MAX, iceBudget) && !state.frozen;
  const escapeRisk = enemies.some((e, i) => e && !isToken(e.name) && i >= 25);
  if (escapeRisk) {
    // 有怪临近终点：先看本列火力够不够在它出去前磨死，不够就上符文
    for (let i = 25; i < 30; i += 1) {
      const e = enemies[i];
      if (!e || isToken(e.name)) continue;
      const col = i % 5;
      const cap = partners.reduce((s, p, b) => s + (p && b % 5 === col ? POWER(p.level) * (p.name === '女伙伴' ? 1 : BULLETS(p.level)) : 0), 0);
      if (e.hp > cap * 1.5) {
        if (iceOk) return { type: 'ice' };
        if (fireOk) return { type: 'fire', column: col };
      }
    }
  }

  // —— 1. 铺满 5 列：休息区有牌且有空位，优先威胁大的列 ——
  const restCard = rest.findIndex(c => c);
  if (restCard >= 0 && emptyBoard.length > 0 && occupiedCols.size < 5) {
    // 找空列
    const emptyCols = [0, 1, 2, 3, 4].filter(c => !occupiedCols.has(c));
    emptyCols.sort((a, b) => threat[b] - threat[a]);
    const targetCol = emptyCols[0];
    const cell = emptyBoard.filter(i => i % 5 === targetCol)[0]
      ?? emptyBoard.slice().sort((a, b) => threat[b % 5] - threat[a % 5])[0];
    return { type: 'op', fromZone: 1, fromIndex: restCard, toIndex: cell };
  }

  // —— 2. 休息区卡与场上同名同级 → 直接合成（一步升级，性价比最高） ——
  if (restCard >= 0) {
    const card = rest[restCard];
    const target = partners.findIndex(p => p && p.name === card.name && p.level === card.level && p.level < 10);
    if (target >= 0) return { type: 'op', fromZone: 1, fromIndex: restCard, toIndex: target };
  }

  // —— 3. 场上合成：优先威胁列 ——
  let bestMerge = null;
  for (let a = 0; a < 10; a += 1) {
    const pa = partners[a];
    if (!pa) continue;
    for (let b = 0; b < 10; b += 1) {
      if (b === a) continue;
      const pb = partners[b];
      if (pb && pb.name === pa.name && pb.level === pa.level && pb.level < 10) {
        const v = threat[b % 5] * 2 + POWER(pb.level) * 4;
        if (!bestMerge || v > bestMerge.v) bestMerge = { v, action: { type: 'op', fromZone: 2, fromIndex: a, toIndex: b } };
      }
    }
  }
  if (bestMerge && (occupiedCols.size >= 5 || !rest.some(c => c))) return bestMerge.action;

  // —— 4. 第二排：有空位且休息区有牌 → 铺（女优先补未满列，男补已有女/大怪的列） ——
  if (restCard >= 0 && emptyBoard.length > 0) {
    const card = rest[restCard];
    const emptyCols = [0, 1, 2, 3, 4].filter(c => {
      const cells = partners.filter((p, i) => p && i % 5 === c);
      return cells.length < 2;
    });
    emptyCols.sort((a, b) => threat[b] - threat[a]);
    let cell = emptyCols.length
      ? emptyBoard.filter(i => i % 5 === emptyCols[0])[0]
      : null;
    if (cell === undefined || cell === null) {
      // 全满：放到同列合成位由 3 处理，否则换牌（跳过本回合弱操作：移动同列最优伙伴）
      return p1Fallback(state, params);
    }
    return { type: 'op', fromZone: 1, fromIndex: restCard, toIndex: cell };
  }
  return p1Fallback(state, params);
}

function p1Fallback(state, params) {
  // 没牌可放：在场上找一次有意义的移动（把火力移向威胁列），否则随便动一步
  const { partners, enemies } = state;
  const { threat } = boardInfo(state);
  let best = null;
  for (let from = 0; from < 10; from += 1) {
    const p = partners[from];
    if (!p) continue;
    for (let to = 0; to < 10; to += 1) {
      if (to === from || partners[to]) continue;
      const fromCol = from % 5, toCol = to % 5;
      const v = (threat[toCol] - threat[fromCol]) * (p.name === '女伙伴' ? 1.5 : 1);
      if (!best || v > best.v) best = { v, action: { type: 'op', fromZone: 2, fromIndex: from, toIndex: to } };
    }
  }
  return best?.action ?? null;
}

const P1_DEFAULT = {};

// ───────────────────────── P2：Beam Search ─────────────────────────

function evalState(state, lambda = 1) {
  // P0 风格评估（产出 1897 的原始版本，勿轻改——pairs 项移除/列均衡变体均实测更差）
  const { partners, enemies } = state;
  const cov = new Set();
  partners.forEach((p, i) => { if (p) cov.add(i % 5); });
  const powerSum = partners.reduce((s2, p) => s2 + (p ? POWER(p.level) : 0), 0);
  const threat = [0, 0, 0, 0, 0];
  enemies.forEach((e, i) => {
    if (!e) return;
    for (const c of bigColumns(e.name, i)) threat[c] += (isToken(e.name) ? 0 : e.hp) + i * 0.15;
  });
  let pressure = 0;
  threat.forEach((t, c) => {
    const has = partners.some((p, i) => p && i % 5 === c);
    pressure += has ? t * 0.15 : t * 3;
  });
  const cards = [...partners.filter(Boolean), ...state.rest.filter(Boolean)];
  const byKey = {};
  for (const c of cards) {
    const k = c.name + c.level;
    byKey[k] = (byKey[k] ?? 0) + 1;
  }
  let pairs = 0;
  for (const n of Object.values(byKey)) pairs += Math.floor(n / 2);
  return (cov.size * 40 + powerSum * 1.2 - pressure + pairs * 8 + state.rest.filter(Boolean).length * 3) * lambda;
}

function candidateActions(state, used, { fireBudget, iceBudget, prune = true }) {
  const out = [];
  const { partners, rest, enemies } = state;
  for (let slot = 0; slot < 2; slot += 1) {
    if (!rest[slot]) continue;
    for (let to = 0; to < 10; to += 1) {
      const t = partners[to];
      if (!t) out.push({ type: 'op', fromZone: 1, fromIndex: slot, toIndex: to });
      else if (t.name === rest[slot].name && t.level === rest[slot].level && t.level < 10) {
        out.push({ type: 'op', fromZone: 1, fromIndex: slot, toIndex: to }); // 直接合成
      }
    }
  }
  for (let from = 0; from < 10; from += 1) {
    if (!partners[from]) continue;
    for (let to = 0; to < 10; to += 1) {
      if (to === from) continue;
      const t = partners[to];
      if (t && (t.name !== partners[from].name || t.level !== partners[from].level)) continue; // 跳过普通交换与降级合并
      out.push({ type: 'op', fromZone: 2, fromIndex: from, toIndex: to });
    }
  }
  if (used.fire < Math.min(FIRE_MAX, fireBudget)) {
    for (let col = 0; col < 5; col += 1) {
      let total = 0, near = false;
      enemies.forEach((e, i) => {
        if (e && !isToken(e.name) && bigColumns(e.name, i).includes(col)) {
          total += e.hp;
          if (i >= 22) near = true;
        }
      });
      // 符文门槛（可调）：列内总血达标或已有怪临近终点
      if (total >= TUNABLE.fireGate || (near && total >= TUNABLE.nearGate)) out.push({ type: 'fire', column: col });
    }
  }
  if (used.ice < Math.min(ICE_MAX, iceBudget) && !state.frozen) {
    if (enemies.some((e, i) => e && !isToken(e.name) && i >= 27)) out.push({ type: 'ice' });
  }
  return out;
}

function beamSearch({ width = 60, lambda = 1, fireBudget = FIRE_MAX, iceBudget = ICE_MAX, maxRounds = 130 }) {
  let beam = [{ state: initialState(initial), trace: [] }];
  for (let depth = 0; depth < maxRounds; depth += 1) {
    const next = [];
    for (const node of beam) {
      if (node.state.failed) { next.push(node); continue; }
      const used = { fire: node.state.fireUsed, ice: node.state.iceUsed };
      for (const action of candidateActions(node.state, used, { fireBudget, iceBudget })) {
        const s = step(node.state, action, SCHEDULE);
        if (!s) continue;
        next.push({ state: s, trace: [...node.trace, action] });
      }
      if (next.length > width * 6) break;
    }
    if (!next.length) break;
    const seen = new Set();
    const uniq = [];
    for (const n of next) {
      const key = n.state.partners.map(p => (p ? p.name + p.level : '-')).join()
        + '|' + n.state.rest.map(p => (p ? p.name + p.level : '-')).join()
        + '|' + n.state.enemies.map(e => (e ? e.name + e.hp : '-')).join()
        + '|' + n.state.score + '|' + n.state.baseHp;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(n);
    }
    uniq.sort((a, b) =>
      (b.state.score + evalState(b.state, lambda)) - (a.state.score + evalState(a.state, lambda)));
    beam = uniq.slice(0, width);
    if (beam.every(n => n.state.failed)) break;
  }
  beam.sort((a, b) => b.state.score - a.state.score);
  return beam[0];
}

// ───────────────────────── 实验运行 ─────────────────────────

export function describe(trace) {
  const fire = trace.filter(a => a.type === 'fire').length;
  const ice = trace.filter(a => a.type === 'ice').length;
  return `符文 火${fire}/冰${ice}`;
}

export { simulate, p0Policy, p1Policy, beamSearch, evalState, candidateActions, initialState, initial, SCHEDULE };

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\/]/).pop())) {
  const experiments = process.argv.includes('--quick');
  const run = (name, fn) => {
    const t0 = Date.now();
    const r = fn();
    const s = r.state ?? r;
    console.log(name.padEnd(28), `得分 ${String(s.score).padStart(5)}`, `回合 ${String(s.round).padStart(3)}`, `${Date.now() - t0}ms`);
    return r;
  };
  console.log('== 走江踏浪策略对比（回放：capture-fksj-20261109-101709）==');
  run('P0 现有自动化策略', () => simulate(p0Policy));
  run('P1 分阶段启发式', () => simulate(p1Policy));
  if (!experiments) {
    run('P1 符文受限 火2冰1', () => simulate(p1Policy, { fireBudget: 2, iceBudget: 1 }));
    run('P1 符文受限 火1冰0', () => simulate(p1Policy, { fireBudget: 1, iceBudget: 0 }));
  }
  for (const [width, lambda] of experiments ? [[60, 1]] : [[40, 0.7], [60, 1], [100, 1], [60, 1.5]]) {
    const r = beamSearch({ width, lambda, fireBudget: 5, iceBudget: 5 });
    console.log(`P2 beam w=${width} λ=${lambda} 5/5`.padEnd(28), `得分 ${String(r.state.score).padStart(5)}`, `回合 ${String(r.state.round).padStart(3)}`, describe(r.trace));
  }
  for (const [f, i] of experiments ? [[2, 1]] : [[3, 1], [2, 1], [1, 0]]) {
    const r = beamSearch({ width: 60, lambda: 1, fireBudget: f, iceBudget: i });
    console.log(`P2 beam w=60 火${f}冰${i}`.padEnd(28), `得分 ${String(r.state.score).padStart(5)}`, `回合 ${String(r.state.round).padStart(3)}`, describe(r.trace));
  }
}
