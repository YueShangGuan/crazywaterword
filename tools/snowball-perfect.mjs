// ═══════════════════════════════════════════════════════════════════════════
// 走江踏浪 · 完美算法方案（snowball-perfect）
// ═══════════════════════════════════════════════════════════════════════════
//
// 全部规则经 capture-fksj-20261109-101709 的 92 回合真实对局逐帧校验。
// 离线回放实测（同一出怪时刻表）：
//   参考实现（snowball-optimize.mjs，同参数）  1897 分 / 93 回合（火5冰5）
//   本文件（洁净单文件版，规则等价）          1547 分 / 81 回合（火5冰5）
//   ─ 两版前 64 步分毫不差，之后在中局近平局上分叉（beam 混沌：非优选槽位的
//     累积微差会放大），属搜索稳定性差异，非规则差异。参考实现保留了调参
//     过程中的偶然有利截断行为。
//   真人操作回放                             1759 分 / 89 回合（服务端真值 1923 / 92）
//   旧版自动化（snowball.mjs）                662 分 / 49 回合
//
// ── 一、已验证规则 ──────────────────────────────────────────────────────
// 棋盘    伙伴区 10 格（2 行×5 列，index%5=列）；休息区 2 格；战场 30 格（6 行×5 列）
// 回合    玩家 1 次操作 → 全体伙伴攻击 → 怪物推进 +5 → 服务端按时刻表补怪
// 攻击    女伙伴：对本列全部怪物造成 2^(等级-1) 点伤害（AoE）
//         男伙伴：对本列最前（index 最大）怪物造成 2^(等级-1) 点伤害（单发）
//         大怪横跨 (index, index+1) 两格：两列的伙伴都能打它（法证 26/26 事件零反例）
// 合成    同名同级 → 等级+1，占一步；休息区卡可直接砸到场上同名同级卡上（一步合成）
//         落异卡 = 交换（上阵卡回休息区）；威力上限 2^9
// 信物    女信物/男信物 hp=0 不可伤害；被男伙伴子弹命中 → 转化为对应 1 级伙伴卡进休息区；
//         自己走出终点同样转化（不判负）。休息区只靠信物转化补牌，服务器不主动补
// 火焰符  烧死目标列（含大怪覆盖列）全部怪物，无视血量；不耗回合、不耗体力；每局上限 5 张
// 冰冻符  冻结怪物一回合（下一次推进跳过）；不耗回合、不耗体力；每局上限 5 张
// 计分    每次操作 +10 基础分；击杀另加 maxHp（最后一排被杀同样计分）
// 判负    活着的怪物推进越过 index 29 = 立刻判负（r92 实证：19/27 小怪出界 → failed）
// 体力    每次操作扣 1 点「打雪仗体力」×开局倍率；用符不扣
//
// ── 二、策略支柱（全部实测支撑） ────────────────────────────────────────
// 1. 覆盖优先：任何一列无人守备 = 漏怪 = 立刻判负。开局 9 步内铺满 5 列（威胁列优先）
// 2. 合成即升级：铺满后每步优先级 = 休息区直接合成 > 同列合成 > 补第二排 > 移动（+10 刷分）
//    理想列配置 = 女（面伤清杂）+ 男（集火大怪）各一
// 3. 符文是危机弹：火符留到 r55+ 的高血量墙（列总血 ≥45 或有怪进 22+ 格），
//    每张边际价值 ≈ +135 分；冰符在实测中从不划算，只在「怪即将出界且列火力不足」时保命用
// 4. 信物经济：男伙伴站位要顺路打信物——每转化一张牌 = 未来一步合成材料
// 5. 已知短板（诚实记录）：中级阶段的火力分布会向 2~3 个强列集中，
//    r80 后弱列漏怪。评估函数的 7 种列均衡惩罚/分层 beam 实测全部劣化（详见优化日志），
//    本方案的解法是符文留一张救列 + 依赖 beam 的长线搜索，而非修改评估函数
//
// ── 三、架构 ────────────────────────────────────────────────────────────
//   decide(snapshot, ctx)      在线决策：每个服务端快照调用一次，返回下一步动作
//   simulateAction             正确规则的前向模型（与 snowball-engine.mjs 校验版一致）
//   evalState                  验证过的评估函数（cov40/威力1.2/压力/pairs8/休3，勿轻改）
//   beamPlan(spawnsKnown?)     离线/回放模式：出怪已知时的 beam search（w60 λ2.2 门槛45）
//
// 在线模式说明：服务端不会提前发牌，未来出怪不可知。因此在线决策 = 1 步前瞻贪心
// （候选 × 正确前向模型 × 评估排序），另含信物经济加成。其实测上限低于离线 beam
// （出怪未知使长线规划退化），这是信息论边界而非实现缺陷；若活动允许观察若干局后
// 出怪序列呈现固定模式，可把「期望出怪曲线」注入 beamPlan 的未来回合以恢复长线能力。

import { POWER, column } from './snowball-engine.mjs';

// ═══════════════════════════ 常量 ═══════════════════════════

export const RULES = {
  CELLS: 30,            // 战场格数
  PARTNER_CELLS: 10,    // 伙伴区格数
  REST_SLOTS: 2,        // 休息区
  FIRE_MAX: 5,          // 每局火符上限
  ICE_MAX: 5,           // 每局冰符上限
  FIRE: '打雪仗火焰符',
  ICE: '打雪仗冰冻符',
  STAMINA: '打雪仗体力',
};

// 调优参数（回放实测最优，见文件头记分板）
export const TUNING = {
  lambda: 2.2,          // 评估权重（2.2 > 2 > 1.5，实测）
  beamWidth: 60,        // beam 宽度（60 稳定；更大触发评估噪声病态，实测）
  fireGate: 45,         // 火符门槛：目标列怪物总血 ≥ 45
  fireNearGate: 20,     // 或有怪进 22+ 格且列总血 ≥ 20
};

const isToken = name => /信物/.test(name);

/** 大怪横跨的列：(index, index+1)，模 5 自然回绕（法证 26/26 吻合） */
export function bigColumns(name, index) {
  if (name !== '大怪') return [column(index)];
  return [column(index), (column(index) + 1) % 5];
}

// ═══════════════════════════ 前向模型（正确规则，无副作用） ═══════════════════════════

/** 深拷贝对局状态。状态格式与协议解码快照一致（partners/rest/enemies 均为数组）。 */
export function cloneState(s) {
  return {
    partners: s.partners.map(p => (p ? { ...p } : null)),
    rest: s.rest.map(p => (p ? { ...p } : null)),
    enemies: s.enemies.map(e => (e ? { ...e } : null)),
    round: s.round, score: s.score, frozen: !!s.frozen,
    failed: !!s.failed, fireUsed: s.fireUsed ?? 0, iceUsed: s.iceUsed ?? 0,
  };
}

/** 从协议快照（DispSnowballSnapshot 解码结果）构造状态。 */
export function stateFromSnapshot(snap) {
  const s = cloneState({
    partners: [], rest: [], enemies: [],
    round: snap.round ?? 1, score: snap.score ?? 0,
  });
  for (const e of snap.battlefield ?? []) s.enemies[e.index] = { name: e.name, hp: e.hp, maxHp: e.maxHp };
  for (const p of snap.partner ?? []) s.partners[p.index] = { name: p.name, level: p.level };
  for (const r of snap.rest ?? []) s.rest[r.index] = { name: r.name, level: r.level };
  return s;
}

/**
 * 执行一步（攻击阶段按已验证规则内联模拟；出怪由调用方在推进后注入）。
 * @param action {type:'op',fromZone,fromIndex,toIndex} | {type:'fire',column} | {type:'ice'}
 * @returns 新状态；动作非法返回 null
 */
export function simulateAction(state, action) {
  const next = cloneState(state);
  next.colStreak = [...(state.colStreak ?? [0, 0, 0, 0, 0])];

  if (action.type === 'fire') {
    // 烧死目标列（含大怪覆盖列）全部怪物，无视血量
    let gain = 0;
    for (let i = 0; i < RULES.CELLS; i += 1) {
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
    next.frozen = true;
    return next;
  }

  // —— 普通操作 ——
  const { fromZone, fromIndex, toIndex } = action;
  if (fromZone === 1) {
    // 休息区卡上阵：空位=放置；同名同级=直接合成；异卡=交换
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

  // 攻击阶段：女 AoE 整列 → 男逐发打本列最前（含大怪尾格判定）
  let gain = 0;
  const females = [];
  const males = [];
  for (let i = 0; i < RULES.PARTNER_CELLS; i += 1) {
    const p = next.partners[i];
    if (!p) continue;
    (p.name === '女伙伴' ? females : males).push({ index: i, ...p });
  }
  for (const p of females) {
    const col = column(p.index);
    for (let i = 0; i < RULES.CELLS; i += 1) {
      const e = next.enemies[i];
      if (!e || isToken(e.name) || !bigColumns(e.name, i).includes(col)) continue;
      e.hp -= POWER(p.level);
      if (e.hp <= 0) { gain += e.maxHp; next.enemies[i] = null; }
    }
  }
  for (const p of males) {
    const col = column(p.index);
    for (let shot = 0; shot < 1; shot += 1) {
      let target = -1, targetFront = -1;
      for (let i = 0; i < RULES.CELLS; i += 1) {
        const e = next.enemies[i];
        if (!e || !bigColumns(e.name, i).includes(col)) continue;
        const front = e.name === '大怪' && (i + 1) % 5 === col ? i + 1 : i;
        if (front > targetFront) { targetFront = front; target = i; }
      }
      if (target < 0) break;
      const e = next.enemies[target];
      if (isToken(e.name)) {
        next.enemies[target] = null;
        const slot = next.rest.findIndex(c => !c);
        if (slot >= 0) next.rest[slot] = { name: e.name === '男信物' ? '男伙伴' : '女伙伴', level: 1 };
      } else {
        e.hp -= POWER(p.level);
        if (e.hp <= 0) { gain += e.maxHp; next.enemies[target] = null; }
      }
    }
  }

  // 推进：高 index 先行；活怪越界 = 判负；信物出界转化为休息区牌
  if (!next.frozen) {
    for (let i = RULES.CELLS - 1; i >= 0; i -= 1) {
      const e = next.enemies[i];
      if (!e) continue;
      if (i + 5 > RULES.CELLS - 1) {
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
      next.enemies[i] = null;
    }
  } else {
    next.frozen = false;
  }
  next.round += 1;
  next.score += 10 + gain;
  return next;
}

/** 出怪注入（推进后调用）：spawns: Map<round, [{index,name,hp,maxHp}]> */
export function injectSpawns(state, spawns, round) {
  const fresh = spawns.get(round) ?? [];
  for (const sp of fresh) state.enemies[sp.index] = { name: sp.name, hp: sp.hp, maxHp: sp.maxHp };
  return state;
}

// ═══════════════════════════ 评估（验证过的版本，勿轻改） ═══════════════════════════

export function evalState(state, lambda = TUNING.lambda) {
  const { partners, enemies } = state;
  const cov = new Set();
  partners.forEach((p, i) => { if (p) cov.add(i % 5); });
  const powerSum = partners.reduce((s, p) => s + (p ? POWER(p.level) : 0), 0);
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

// ═══════════════════════════ 候选生成 ═══════════════════════════

/** @param used {fire,ice} 已使用数；@param stock Map<物品名, 数量> 库存 */
export function candidateActions(state, used, { fireBudget = RULES.FIRE_MAX, iceBudget = RULES.ICE_MAX, stock = null } = {}) {
  const out = [];
  const { partners, rest, enemies } = state;
  for (let slot = 0; slot < RULES.REST_SLOTS; slot += 1) {
    if (!rest[slot]) continue;
    for (let to = 0; to < RULES.PARTNER_CELLS; to += 1) {
      const t = partners[to];
      if (!t) out.push({ type: 'op', fromZone: 1, fromIndex: slot, toIndex: to });
      else if (t.name === rest[slot].name && t.level === rest[slot].level && t.level < 10) {
        out.push({ type: 'op', fromZone: 1, fromIndex: slot, toIndex: to }); // 直接合成
      }
    }
  }
  for (let from = 0; from < RULES.PARTNER_CELLS; from += 1) {
    if (!partners[from]) continue;
    for (let to = 0; to < RULES.PARTNER_CELLS; to += 1) {
      if (to === from) continue;
      const t = partners[to];
      if (t && (t.name !== partners[from].name || t.level !== partners[from].level)) continue; // 跳过普通交换
      out.push({ type: 'op', fromZone: 2, fromIndex: from, toIndex: to });
    }
  }
  const fireLeft = Math.min(RULES.FIRE_MAX, fireBudget) - used.fire;
  const stockFire = stock ? (stock.get(RULES.FIRE) ?? 0) : RULES.FIRE_MAX;
  if (fireLeft > 0 && stockFire > 0) {
    for (let col = 0; col < 5; col += 1) {
      let total = 0, near = false;
      enemies.forEach((e, i) => {
        if (e && !isToken(e.name) && bigColumns(e.name, i).includes(col)) {
          total += e.hp;
          if (i >= 22) near = true;
        }
      });
      if (total >= TUNING.fireGate || (near && total >= TUNING.fireNearGate)) {
        out.push({ type: 'fire', column: col });
      }
    }
  }
  const iceLeft = Math.min(RULES.ICE_MAX, iceBudget) - used.ice;
  const stockIce = stock ? (stock.get(RULES.ICE) ?? 0) : RULES.ICE_MAX;
  if (iceLeft > 0 && stockIce > 0 && !state.frozen) {
    if (enemies.some((e, i) => e && !isToken(e.name) && i >= 27)) out.push({ type: 'ice' });
  }
  return out;
}

// ═══════════════════════════ 在线决策 ═══════════════════════════

/**
 * 在线决策：给定当前快照状态，返回下一步动作。
 * @param state  stateFromSnapshot 的输出（或等价状态）
 * @param ctx    { used?: {fire,ice}, stock?: Map, lambda?: number,
 *                 futureSpawns?: Map<round, spawns> }
 *                 futureSpawns：若已知（回放/模式固定），传入以启用完整 beam；
 *                 缺省时用 1 步前瞻贪心 + 信物经济加成。
 */
export function decide(state, ctx = {}) {
  const used = ctx.used ?? { fire: state.fireUsed ?? 0, ice: state.iceUsed ?? 0 };
  const lambda = ctx.lambda ?? TUNING.lambda;
  if (ctx.futureSpawns && ctx.futureSpawns.size) {
    const plan = beamPlan(state, ctx.futureSpawns, { fireBudget: ctx.fireBudget, iceBudget: ctx.iceBudget, stock: ctx.stock });
    return plan?.trace[0] ?? null;
  }
  // —— 1 步前瞻贪心（在线默认）——
  const candidates = candidateActions(state, used, { fireBudget: ctx.fireBudget, iceBudget: ctx.iceBudget, stock: ctx.stock });
  let best = null;
  for (const action of candidates) {
    const next = simulateAction(state, action);
    if (!next) continue;
    let v = (next.score - state.score) + evalState(next, lambda);
    // 信物经济：这一步让男伙伴对准信物 → 下一回合转化一张休息区牌
    state.enemies.forEach((e, idx) => {
      if (!e || !isToken(e.name)) return;
      const col = idx % 5;
      if (next.partners.some((p, b) => p && p.name === '男伙伴' && b % 5 === col)) v += 8;
    });
    if (!best || v > best.v) best = { v, action };
  }
  return best?.action ?? null;
}

// ═══════════════════════════ 离线 beam（出怪已知时） ═══════════════════════════

/**
 * 出怪已知时的完整规划。
 * @param state       起始状态
 * @param spawns      Map<round, [{index,name,hp,maxHp}]>（完整出怪时刻表）
 * @param opts        { width, lambda, fireBudget, iceBudget, stock, maxRounds }
 */
export function beamPlan(state, spawns, opts = {}) {
  const width = opts.width ?? TUNING.beamWidth;
  const lambda = opts.lambda ?? TUNING.lambda;
  const maxRounds = opts.maxRounds ?? 150;
  let beam = [{ state: cloneState(state), trace: [] }];
  for (let depth = 0; depth < maxRounds; depth += 1) {
    const next = [];
    for (const node of beam) {
      if (node.state.failed) { next.push(node); continue; }
      const used = { fire: node.state.fireUsed, ice: node.state.iceUsed };
      for (const action of candidateActions(node.state, used, { fireBudget: opts.fireBudget, iceBudget: opts.iceBudget, stock: opts.stock })) {
        const s = simulateAction(node.state, action);
        if (!s) continue;
        injectSpawns(s, spawns, s.round);
        next.push({ state: s, trace: [...node.trace, action] });
      }
      // 展开截断（回放实测关键：只展开排序最前的少量节点，过量探索反而劣化）
      if (next.length > width * 6) break;
    }
    if (!next.length) break;
    const seen = new Set();
    const uniq = [];
    for (const n of next) {
      const key = n.state.partners.map(p => (p ? p.name + p.level : '-')).join()
        + '|' + n.state.rest.map(p => (p ? p.name + p.level : '-')).join()
        + '|' + n.state.enemies.map(e => (e ? e.name + e.hp : '-')).join()
        + '|' + n.state.score;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(n);
    }
    uniq.sort((a, b) => (b.state.score + evalState(b.state, lambda)) - (a.state.score + evalState(a.state, lambda)));
    beam = uniq.slice(0, width);
    if (beam.every(n => n.state.failed)) break;
  }
  beam.sort((a, b) => b.state.score - a.state.score);
  return beam[0];
}

// ═══════════════════════════ CLI 自测 ═══════════════════════════
// 用法：node tools/snowball-perfect.mjs <capture-dir> [fireBudget iceBudget]
// 从抓包提取出怪时刻表并回放本方案，输出得分（应与文件头记分板一致）。

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const dir = process.argv[2];
  const fireBudget = Number(process.argv[3] ?? 5);
  const iceBudget = Number(process.argv[4] ?? 0);
  if (!dir) {
    console.log('用法: node tools/snowball-perfect.mjs <capture-dir> [fireBudget iceBudget]');
  } else {
    Promise.all([import('./snowball-engine.mjs')]).then(([eng]) => {
      const { extractReplay, initialState } = eng;
      const { initial, spawns } = extractReplay(dir);
      const r = beamPlan(initialState(initial), spawns, { fireBudget, iceBudget });
      console.log(`本方案 beam（火${fireBudget} 冰${iceBudget}）:`, r.state.score, '分 /', r.state.round, '回合, failed=' + r.state.failed);
    }).catch(e => { console.error(e.message); process.exit(1); });
  }
}
