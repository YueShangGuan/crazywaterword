import { idString } from './context.mjs';
import { inWindows, mutate, repeat, skip, succeeded } from './common.mjs';
import { claimPass } from './battle.mjs';
import { activities } from './welfare.mjs';

/** 出牌计划按战力排序，并共同扣减能量、区域空位和服务端放置限制。 */
export function placementsFor(state, config, protocol) {
  const cards = config.tables.GameCardCfg?.data ?? [];
  const round = state.round;
  if (!round?.round) return null;
  const side = state.mySide;
  if (![protocol.SnapSide.SNAP_SIDE_A, protocol.SnapSide.SNAP_SIDE_B].includes(side)) return null;
  const zones = (state.zones ?? []).filter(z => z.unlocked && z.cardLimit > 0).map(z => {
    const board = side === protocol.SnapSide.SNAP_SIDE_A ? z.sideA : z.sideB;
    const restrictions = [...(round.placementLimits ?? []), side === protocol.SnapSide.SNAP_SIDE_A ? z.placeLimitA : z.placeLimitB].filter(l => l && l.zoneIndex === z.zoneIndex && l.side === side);
    return { ...z, used: board?.cards?.length ?? 0, placed: 0, restrictions };
  });
  const hand = [...(state.hand ?? [])];
  // choices 的 cardUid 是客户端选牌索引（从 1 起），不是持有卡牌的真实 UID。
  if (round.choices?.length) hand.push({ uid: '1', heroId: round.choices[0], choice: true });
  const known = hand.map(card => ({ ...card, cfg: cards.find(r => r.heroId === card.heroId) })).filter(c => c.cfg);
  known.sort((a, b) => b.cfg.power - a.cfg.power || a.cfg.cost - b.cfg.cost);
  let energy = round.energy;
  const placements = [];
  for (const card of known) {
    if (card.cfg.cost > energy) continue;
    const zone = zones.find(z => z.used + z.placed < z.cardLimit && z.restrictions.every(l => z.placed < l.limit && card.cfg.cost <= l.costCap));
    if (!zone) continue;
    placements.push({ cardUid: idString(card.uid), zoneIndex: zone.zoneIndex });
    energy -= card.cfg.cost; zone.placed++;
  }
  if (round.choices?.length && !placements.some(p => p.cardUid === '1')) placements.push({ cardUid: '1', zoneIndex: 0 });
  return { placements, round: round.round };
}

/** 水世界牌续打已有对局，免费及钻石匹配独立开关并共用持久化额度。 */
export async function snap(ctx, options) {
  const params = ctx.rows('CardGameParamCfg')[0];
  if (!params) return skip(ctx, '缺少水世界牌参数配置');
  if (options.cancelMatchmaking) {
    const info = await ctx.query('SnapInfoRequest');
    // 已在对局中的 matchId 不能当作队列取消；空队列也不能制造未确认写入。
    if (idString(info.pvpInfo?.matchId ?? 0) !== '0' && !info.pvpMatch?.state) await ctx.action('SnapCancelMatchmakingRequest', {}, { response: 'SCSnapMatchmakingFinished', confirm: async () => idString((await ctx.query('SnapInfoRequest')).pvpInfo?.matchId ?? 0) === '0' });
    else skip(ctx, '没有可取消的匹配队列');
    return;
  }
  if (options.giveUpPve && (await ctx.query('SnapInfoRequest')).pveMatch?.round?.round) {
    await ctx.action('SnapGiveUpRequest', {}, { response: 'SnapMatchStateResponse', confirm: async () => !(await ctx.query('SnapInfoRequest')).pveMatch?.round?.round });
    return;
  }
  if (options.passReward) await claimPass(ctx, ctx.protocol.BattlePassType.BP_ACTIVITY_SNAP, 'CardGameBattlePassCfg');
  if (options.pve) await repeat(ctx, options.maxMatches, async () => {
    let info = await ctx.query('SnapInfoRequest');
    let state = info.pveMatch;
    if (!state?.round?.round) {
      const now = ctx.now() / 1000;
      const events = (await activities(ctx))?.festivalActivities?.filter(e => e.openTime <= now && e.closeTime > now) ?? [];
      const ticket = events.flatMap(e => e.limitTimeItem ?? []).find(r => r.item.endsWith('_打牌券') && r.openTime <= now && r.closeTime > now)?.item;
      if (!ticket || (ctx.stock.get(ticket) ?? 0) < 1) { skip(ctx, '没有本期有效打牌券'); return false; }
      const start = await ctx.action('SnapStartRequest', { rate: 1 }, { response: 'SnapMatchStateResponse', expenses: [[ticket, 1]], confirm: async () => Boolean((await ctx.query('SnapInfoRequest')).pveMatch?.round?.round) });
      if (!succeeded(start) || ctx.dryRun) return false;
      // 开局回包有扁平显示数据和 state 字段，后续操作统一读取权威 SnapInfo.pveMatch。
      state = (await ctx.query('SnapInfoRequest')).pveMatch;
      if (!state) { skip(ctx, '开局回包没有对局状态'); return false; }
    }
    return playPve(ctx, state);
  });
  if (!options.freeMatch && !options.diamondMatch) return;
  const windows = options.matchWindows.length ? options.matchWindows : (params.matchTime ?? []).map(([start, end]) => ({ start, end }));
  if (!windows.length || !inWindows(windows, ctx.now())) return skip(ctx, '不在水世界牌匹配时段');
  await repeat(ctx, options.maxMatches, async () => {
    const info = await ctx.query('SnapInfoRequest');
    if (info.pvpMatch?.state && idString(info.pvpMatch.matchId) !== '0') return options.pvpTrustee ? trustee(ctx, info.pvpMatch) : playPvp(ctx, info.pvpMatch);
    if (!inWindows(windows, ctx.now())) return false;
    const free = info.pvpInfo?.remainFree;
    if (free === undefined) return false;
    const useDiamond = free <= 0;
    if ((!useDiamond && !options.freeMatch) || (useDiamond && (!options.diamondMatch || options.diamondMatchDailyLimit <= ctx.count('snap.diamond')))) return false;
    const ruby = useDiamond ? info.pvpInfo.diamondPrice : 0;
    if (useDiamond && !(ruby > 0)) { skip(ctx, '缺少当前钻石匹配价格'); return false; }
    const result = await ctx.action('SnapStartMatchmakingRequest', { useDiamond }, { ruby, response: 'SCSnapMatchmakingFinished', timeout: (params.matchTimeout + 5) * 1000, confirm: async () => Boolean((await ctx.query('SnapInfoRequest')).pvpMatch?.state) });
    // 完成匹配回包即确认本次匹配已计费；失败原因也计入钻石匹配次数。
    if (result.status === 'success' && useDiamond) ctx.count('snap.diamond', 1);
    if (!succeeded(result) || ctx.dryRun) return false;
    const match = result.value?.pvpMatch ?? (await ctx.query('SnapInfoRequest')).pvpMatch;
    if (!match?.state) { skip(ctx, `匹配结束，原因 ${result.value?.reason ?? '未知'}`); return false; }
    return options.pvpTrustee ? trustee(ctx, match) : playPvp(ctx, match);
  });
}

/** PVE 每轮读服务器最新手牌与阶段，结算后不继续提交回合。 */
async function playPve(ctx, initial) {
  let state = initial;
  for (let index = 0; index < 30; index++) {
    ctx.assertReady();
    const body = placementsFor(state, ctx.config, ctx.protocol);
    if (!body) { skip(ctx, '卡牌阶段或阵营状态不完整'); return false; }
    const result = await ctx.action('SnapEndRoundRequest', body, { confirm: async () => (await ctx.query('SnapInfoRequest')).pveMatch?.round?.round !== body.round });
    if (!succeeded(result) || ctx.dryRun) return false;
    if (result.value?.settlement || result.value?.result?.settlement) return true;
    state = (await ctx.query('SnapInfoRequest')).pveMatch;
    if (!state?.round?.round || state.round.round <= body.round) { skip(ctx, '回合未推进，停止出牌'); return false; }
  }
  skip(ctx, '卡牌单局回合达到上限'); return false;
}

/** 真人对战使用当前回合出牌，等待真实回合推送；没有推进证据就停止提交。 */
async function playPvp(ctx, match) {
  if (match.myTrustee) {
    const result = await mutate(ctx, 'SnapPvpToggleTrusteeRequest', { trustee: false }, 'SnapInfoRequest', s => s.pvpMatch?.myTrustee);
    if (!succeeded(result) || ctx.dryRun) return false;
  }
  for (let index = 0; index < 30; index++) {
    const current = (await ctx.query('SnapInfoRequest')).pvpMatch;
    if (!current?.state || idString(current.matchId) !== idString(match.matchId)) return true;
    const body = placementsFor(current.state, ctx.config, ctx.protocol);
    if (!body) { skip(ctx, '真人对局缺少完整回合状态'); return false; }
    const result = await ctx.action('SnapEndRoundRequest', body, {
      response: 'SCSnapPvpRoundResult', timeout: 70000, key: `snap.pvp.${idString(match.matchId)}.${body.round}`,
      confirm: async () => {
        const info = (await ctx.query('SnapInfoRequest')).pvpMatch;
        return !info?.state || idString(info.matchId) !== idString(match.matchId) || info.state.round?.round > body.round;
      },
    });
    if (!succeeded(result) || ctx.dryRun) return false;
    if (result.value?.result?.settlement) return true;
    const next = (await ctx.query('SnapInfoRequest')).pvpMatch;
    if (!next?.state) return true;
    if (next.state.round?.round <= body.round) { skip(ctx, '真人回合未推进，等待下轮读取'); return false; }
  }
  skip(ctx, '真人对局达到单轮回合上限'); return false;
}

/** PVP 使用服务端托管并等本局结算，轮询期间可随时停止。 */
async function trustee(ctx, match) {
  if (!match.myTrustee) {
    const result = await mutate(ctx, 'SnapPvpToggleTrusteeRequest', { trustee: true }, 'SnapInfoRequest', s => s.pvpMatch?.myTrustee);
    if (!succeeded(result) || ctx.dryRun) return false;
  }
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    ctx.assertReady();
    const current = (await ctx.query('SnapInfoRequest')).pvpMatch;
    if (!current?.state || idString(current.matchId) !== idString(match.matchId)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  skip(ctx, '托管对局尚未结束，保留状态下轮继续'); return false;
}
