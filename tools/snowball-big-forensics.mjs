// 大怪法证分析：追踪每只大怪的生命线（出生/移动/受伤/死亡），
// 对每次受伤枚举伤害来源，检验三种占位假设：
//   L: (i, i+1)  R: (i-1, i)  W: 跨界回绕 (4,0) / (i-1..i+1 等)
// 用法: node tools/snowball-big-forensics.mjs

import { extractReplay, POWER } from './snowball-engine.mjs';

const DIR = 'E:/MyProject/疯狂水世界/抓包/fksj-analyzer/capture-fksj-20261109-101709';
const { initial, actions, responses } = extractReplay(DIR);
const isToken = n => /信物/.test(n);

// 操作后的伙伴布局（与引擎一致的 zone1/zone2 语义）
function applyOp(prevPartner, prevRest, a, nextPartner) {
  const P = prevPartner.map(p => ({ ...p }));
  if (a.type === 'op' && a.fromZone === 1) {
    const R = prevRest.map(c => (c ? { ...c } : null));
    const mover = R[a.fromIndex];
    if (!mover) return nextPartner.map(p => ({ ...p }));
    R[a.fromIndex] = null;
    const t = P.find(p => p.index === a.toIndex);
    if (!t) P.push({ ...mover, index: a.toIndex });
    else if (t.name === mover.name && t.level === mover.level && t.level < 10) {
      t.level += 1;
    } else {
      P.push({ ...mover, index: a.toIndex });
      t.index = a.fromIndex;
    }
    return P;
  }
  if (a.type === 'op' && a.fromZone === 2) {
    const mv = P.find(p => p.index === a.fromIndex);
    if (!mv) return nextPartner.map(p => ({ ...p }));
    const t = P.find(p => p.index === a.toIndex);
    if (!t) mv.index = a.toIndex;
    else if (t.name === mv.name && t.level === mv.level && t.level < 10) {
      t.level += 1;
      P.splice(P.indexOf(mv), 1);
    } else {
      const fi = mv.index;
      mv.index = t.index;
      t.index = fi;
    }
    return P;
  }
  return nextPartner.map(p => ({ ...p })); // 用符回合布局不变
}

const POWER_F = lv => 2 ** (Math.min(10, Math.max(1, lv)) - 1);

// ── 1. 追踪全部大怪生命线 ──
const lineages = []; // {id, birth:{round,index,maxHp}, events:[{round, index, hpBefore, hpAfter, damage, columns}];
let prevPartner = initial.partner.map(p => ({ ...p }));
let prevRest = initial.rest.map(c => ({ ...c }));
let prevE = initial.battlefield.map(e => ({ ...e }));
const alive = new Map(); // key: maxHp+firstIndex → lineage

let lid = 0;
for (let k = 0; k < responses.length; k += 1) {
  const next = responses[k];
  const a = actions[k];
  const postP = applyOp(prevPartner, prevRest, a, next.partner);

  // 找新增大怪（出生）
  for (const e of next.battlefield) {
    if (e.name !== '大怪') continue;
    const fromPrev = prevE.find(x => x.name === '大怪' && x.maxHp === e.maxHp && x.index === e.index - 5);
    if (!fromPrev) {
      const lineage = { id: ++lid, birth: { round: next.round, index: e.index, maxHp: e.maxHp }, events: [], death: null };
      lineages.push(lineage);
      alive.set(e.maxHp + ':' + e.index, lineage);
    }
  }
  // 逐只大怪结算本回合伤害
  for (const e of next.battlefield) {
    if (e.name !== '大怪') continue;
    const key = [...alive.keys()].find(k2 => k2.startsWith(e.maxHp + ':'));
    const lineage = alive.get(key);
    if (!lineage) continue;
    const fromPrev = prevE.find(x => x.name === '大怪' && x.maxHp === e.maxHp && x.index === e.index - 5 && x.hp >= e.hp)
      ?? prevE.find(x => x.name === '大怪' && x.maxHp === e.maxHp && x.index === e.index && x.hp >= e.hp);
    if (!fromPrev) continue;
    alive.delete(e.maxHp + ':' + fromPrev.index);
    alive.set(e.maxHp + ':' + e.index, lineage);
    const damage = fromPrev.hp - e.hp;
    lineage.events.push({
      round: next.round, index: e.index, hpBefore: fromPrev.hp, hpAfter: e.hp, damage,
      partners: postP.map(p => ({ col: p.index % 5, name: p.name[0] + p.level, power: POWER_F(p.level), isF: p.name === '女伙伴', index: p.index })),
      died: e.hp <= 0,
    });
    if (e.hp <= 0) lineage.death = { round: next.round, index: e.index, killed: true };
  }
  // 死亡移除
  for (const [key, lineage] of alive) {
    const [maxHp, idx] = key.split(':').map(Number);
    const still = next.battlefield.find(e => e.name === '大怪' && e.maxHp === maxHp && e.hp > 0
      && (e.index === idx || e.index === idx + 5 || e.index === idx + 10 || e.index === idx + 15 || e.index === idx + 20 || e.index === idx + 25));
    if (!still) alive.delete(key);
  }
  prevPartner = next.partner.map(p => ({ ...p }));
  prevRest = next.rest.map(c => ({ ...c }));
  prevE = next.battlefield.map(e => ({ ...e }));
}

// ── 2. 打印生命线 ──
console.log('════ 大怪生命线 ════');
for (const L of lineages) {
  const moves = L.events.map(ev => `r${ev.round}@${ev.index}(-${ev.damage})`).join(' → ');
  console.log(`#${L.id} 出生 r${L.birth.round}@${L.birth.index} maxHp=${L.birth.maxHp}`);
  console.log('   轨迹:', moves, L.death ? `(r${L.death.round} 死亡)` : '(未死/烧死?)');
}

// ── 3. 每次受伤的伤害来源假设检验 ──
// 对每个伤害事件，检验四种列集合假设下的「可达伤害」：
//   L(i,i+1)  R(i-1,i)  W(回绕到第0列)  M(单体=只算头部列)
// 女伙伴：在覆盖列内 → 造成 power（AoE，一次）
// 男伙伴：在覆盖列内 且 大怪是本列最前 → 造成 power×子弹数；否则 0
// 子弹数模型：Lv1-2 → 2 发，Lv3-4 → ？——用引擎已验证模型 A：男=单发 power。
console.log('\n════ 受伤事件 × 假设检验 ════');
const tally = { L: 0, R: 0, W: 0, M: 0, Lfail: [], Rfail: [], Wfail: [], Mfail: [] };
for (const L of lineages) {
  for (const ev of L.events) {
    if (ev.damage === 0) continue;
    const c = ev.index % 5;
    const spans = {
      L: [c, (c + 1) % 5],
      R: [(c - 1 + 5) % 5, c],
      W: [(c - 1 + 5) % 5, c, (c + 1) % 5], // 回绕宽 3（覆盖两列+回绕）
      M: [c],
    };
    const row = { round: ev.round, index: ev.index, damage: ev.damage, obs: [] };
    for (const [tag, cols] of Object.entries(spans)) {
      let dmg = 0;
      for (const p of ev.partners) {
        if (!cols.includes(p.col)) continue;
        if (p.isF) dmg += p.power;
        // 男伙伴：只有当大怪是本列最前才打它——宽松处理：计入 0 与 power 两种可能，
        // 用区间 [dmg, dmg+男伤] 判定
      }
      // 男伙伴可命中上限
      let maleMax = 0;
      for (const p of ev.partners) {
        if (!p.isF && cols.includes(p.col)) maleMax += p.power;
      }
      const lo = dmg, hi = dmg + maleMax;
      const fit = ev.damage >= lo && ev.damage <= hi;
      row.obs.push(`${tag}:[${lo}~${hi}]${fit ? '✓' : '✗'}`);
      if (fit) tally[tag] += 1;
      else tally[tag + 'fail'].push(`r${ev.round}@${ev.index} 掉${ev.damage} 假设${tag}可达[${lo}~${hi}]`);
    }
    console.log(`r${String(ev.round).padStart(2)} 大怪@${String(ev.index).padStart(2)} 掉${String(ev.damage).padStart(2)}`,
      row.obs.join(' '), '| 列内伙伴:', ev.partners.map(p => `${p.name}@${p.index}(c${p.col},${p.power})`).join(' '));
  }
}
console.log('\n════ 假设吻合统计（事件数） ════');
console.log('L (i,i+1):', tally.L, ' R (i-1,i):', tally.R, ' W(回绕3列):', tally.W, ' M(单体):', tally.M);
for (const tag of ['L', 'R', 'W', 'M']) {
  if (tally[tag + 'fail'].length) console.log(`假设${tag} 反例:`, tally[tag + 'fail'].join(' ; '));
}
