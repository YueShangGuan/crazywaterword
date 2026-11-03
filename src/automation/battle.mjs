import { amount, idString } from './context.mjs';
import { mutate, repeat, skip, succeeded } from './common.mjs';

// 实测服务端约需 1.3 秒间隔，取 1.5 秒为网络抖动保留余量。
const CHALLENGE_COOLDOWN_MS = 1_500;

/**
 * 按服务端挑战频控等待下一次挑战；预览模式不发送请求，因此不产生真实等待。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {{ lastSentAt: number }} pacing 当前战斗模块共享的发送时间。
 */
async function waitChallengeCooldown(ctx, pacing) {
  if (ctx.dryRun || !pacing.lastSentAt) {
    if (!ctx.dryRun) pacing.lastSentAt = Date.now();
    return;
  }
  const remaining = CHALLENGE_COOLDOWN_MS - (Date.now() - pacing.lastSentAt);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  ctx.assertReady();
  pacing.lastSentAt = Date.now();
}

/** 判断战令是否还有达到分数的未领档位，已购档位也只领取现有权益。 */
export function passReady(state, rows) {
  return rows.some(row => {
    // BattlePassItem 使用 id 标识档位；误用其他玩法的 stage 字段会把已领奖励判成未领取。
    const got = state.got?.find(g => g.id === row.rwdId);
    return state.score >= row.reqScore && ((row.freeReward?.length && !got?.freeGot) || (state.activePay && row.payReward?.length && !got?.payGot));
  });
}

/** 判断指定章节是否存在当前主线进度已满足、但尚未领取的战令档位。 */
function passStageRewardReady(ctx, stage, chapter) {
  return ctx.rows('PassStagePackCfg').some(row => {
    // PassStageItem 用 id 对应配置 rwdId；stage 是领奖请求参数，不是领奖记录字段。
    const got = chapter.got?.find(item => item.id === row.rwdId);
    return row.stage === stage && row.needStage < ctx.player.mainlineStage && ((row.freeReward?.length && !got?.freeGot) || (chapter.activePay && row.payReward?.length && !got?.payGot));
  });
}

/**
 * 用当前章节领奖状态恢复旧的未确认记录；尚有可领奖励时不重发，也不让该记录停止其他模块。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {number} stage 章节编号。
 * @param {boolean} ready 当前章节是否仍有可领取奖励。
 * @returns {boolean} 是否允许继续处理该章节。
 */
function reconcilePassStageReward(ctx, stage, ready) {
  const key = `PassStageGotRewardRequest:${JSON.stringify({ stage })}`;
  if (!ctx.ledger.pending[key]) return true;
  if (ready) {
    // 读回仍显示可领取，无法区分旧请求未生效与状态尚未同步，保留记录并停止战斗模块。
    ctx.record({ request: 'PassStageGotRewardRequest', label: `战令章节 ${stage}`, status: 'uncertain', reason: '上次结果未确认，当前仍有可领取奖励，跳过战斗模块' });
    return false;
  }
  // 当前章节已无可领取奖励，说明旧请求或等效的外部操作已达成目标，可安全解除重复提交锁。
  ctx.settlePending(key);
  ctx.record({ request: 'PassStageGotRewardRequest', label: `恢复战令章节 ${stage} 未确认记录`, status: 'success', verifiedByRead: true });
  return true;
}

/**
 * 领取指定玩法当前周期内已达标的战令奖励。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {number | undefined} type 服务端战令玩法枚举。
 * @param {string} table 战令配置表名，仅用于读取与诊断。
 * @param {Array<object>} rows 当前玩法及周期允许参与判断的奖励档位。
 */
export async function claimPass(ctx, type, table, rows = ctx.rows(table)) {
  if (type === undefined || !rows.length) return skip(ctx, `缺少 ${table} 或战令枚举`);
  await repeat(ctx, 50, async () => {
    const state = await ctx.query('BattlePassRequest', { type });
    if ((state.endTime > 0 && state.endTime <= ctx.now() / 1000) || !passReady(state, rows)) return false;
    return succeeded(await mutate(ctx, 'BattlePassGotRewardRequest', { type }, 'BattlePassRequest', s => s.got, { stateBody: { type } }));
  });
}

/** 挑战共用显式次数上限，主线和试炼战败后立即停止当前玩法。 */
export async function battle(ctx, options) {
  const pacing = { lastSentAt: 0 };
  let challengeRejected = false;
  if (options.stage.enabled) {
    let stage = ctx.player.mainlineStage;
    await repeat(ctx, options.maxActions, async () => {
      if (!(stage > 0)) return false;
      let result;
      for (let attempt = 0; attempt <= options.stage.samePowerRetryCount; attempt++) {
        await waitChallengeCooldown(ctx, pacing);
        result = await ctx.action('ChallengeStageRequest', { stage }, { accept: r => r?.stats?.isLeftWin === true });
        if (result.status === 'rejected') {
          // 频控拒绝说明当前连接仍在冷却期，停止整个战斗模块避免继续打其他副本。
          challengeRejected = true;
          break;
        }
        if (result.status !== 'failed') break;
      }
      if (challengeRejected) return false;
      if (!succeeded(result)) return false;
      if (!ctx.dryRun) ctx.player.mainlineStage = ++stage;
      return true;
    });
  }
  if (challengeRejected) return;
  if (options.stage.claimReward) {
    const state = await ctx.query('PassStageStateRequest');
    for (let stage = 1; stage <= state.maxOpenStage; stage++) {
      let pendingBlocked = false;
      await repeat(ctx, 50, async () => {
        const chapter = await ctx.query('PassStageRequest', { stage });
        const ready = passStageRewardReady(ctx, stage, chapter);
        if (!reconcilePassStageReward(ctx, stage, ready)) { pendingBlocked = true; return false; }
        if (!ready) return false;
        // PassStageGotRewardResponse 可能为空，必须读回 got 才能避免把领奖成功误留为未确认。
        return succeeded(await mutate(ctx, 'PassStageGotRewardRequest', { stage }, 'PassStageRequest', value => value.got, { stateBody: { stage }, confirmAfterResponse: true }));
      });
      if (pendingBlocked) return;
    }
  }
  if (options.arena.challenge || options.arena.sweep) await arena(ctx, options);
  for (const [key, raidId] of [['heroExp', 1], ['forge', 2], ['petExp', 3]]) {
    const rule = options.trial[key];
    if (rule.challenge || rule.rubySweep) {
      challengeRejected = await trial(ctx, raidId, rule, options.maxActions, pacing);
      if (challengeRejected) return;
    }
    // 广告额外扫荡是独立的每日权益，不受普通扫荡次数或钻石扫荡开关限制。
    if (vipTrialSweepEnabled(ctx)) await vipTrialSweep(ctx, raidId);
  }
  if (['challenge', 'hangupReward', 'danReward', 'passReward'].some(k => options.league[k])) await league(ctx, options.league, options.maxActions);
  if (['challenge', 'sweep', 'finalReward', 'freePass'].some(k => options.expedition[k])) await expedition(ctx, options.expedition, options.maxActions);
}

/** 当前连接同时具备角色等级、VIP 等级和用户授权时，才允许领取试炼免广告权益。 */
function vipTrialSweepEnabled(ctx) {
  // 本轮收到的 VIP 推送优先于登录快照，避免升档或降档后继续使用过期资格。
  const vipLevel = ctx.pushes.get('SCVipUpdate')?.vipLevel ?? ctx.player.vip?.vipLevel;
  return ctx.settings.vipFreeAd === true && ctx.client.connected
    && Number.isSafeInteger(ctx.player.level) && ctx.player.level >= 10
    && Number.isSafeInteger(vipLevel) && vipLevel >= 3;
}

/**
 * 按 VIP3 抓包的登记、领奖顺序领取三类试炼广告额外扫荡，每日尝试额度写前落盘。
 *
 * @param {object} ctx 当前角色自动化上下文。
 * @param {number} raidId 英雄经验、强化石或宠物经验试炼编号。
 */
async function vipTrialSweep(ctx, raidId) {
  // 2026-11-03 VIP3 抓包确认的映射；这些 ID 属于广告业务，不能直接复用 raidId。
  const id = { 1: 4, 2: 3, 3: 5 }[raidId];
  const type = ctx.protocol.AdvType?.ADV_EFFECT;
  const rule = ctx.rows('AdvEffectCfg').find(row => row.id === id);
  if (type === undefined || !Number.isSafeInteger(rule?.dailyLimit) || rule.dailyLimit <= 0) return skip(ctx, `试炼 ${raidId} 缺少广告额度配置`);
  const raid = (await ctx.query('TrialRaidInfoRequest', { raidId })).raid;
  if (raid?.raidId !== raidId || !(raid.passedStage > 0)) return;
  const state = (await ctx.query('OnWaterRequest')).adv?.find(row => row.id === id);
  if (!Number.isSafeInteger(state?.gotTimes) || state.gotTimes < 0) return skip(ctx, `试炼 ${raidId} 缺少服务端广告次数`);
  const countKey = `trial.vipAdSweep.${raidId}`;
  if (state.gotTimes >= rule.dailyLimit || ctx.count(countKey) >= rule.dailyLimit) return;
  // 只读查询期间也可能收到 VIP 更新，写入前再次核对当前资格。
  if (!vipTrialSweepEnabled(ctx)) return;

  // 先保存尝试次数：进程退出、登记拒绝或空奖励回包后，本日也不能重发同一组请求。
  if (!ctx.dryRun) ctx.count(countKey, 1);
  const registered = await ctx.action('WatchAdvRequest', { type, id }, {
    response: 'OkResponse', label: `试炼 ${raidId} VIP免广告登记`,
  });
  if (!succeeded(registered)) return;
  if (!vipTrialSweepEnabled(ctx)) return;
  // VIP 免去播放，仍须登记广告权益；抓包的实际成功证据是奖励回包，而非普通扫荡计数变化。
  await ctx.action('TrialRaidBuySweepRequest', { raidId, useAdvCard: true }, {
    response: 'GotRewardResponse', label: `试炼 ${raidId} VIP免广告额外扫荡`,
    accept: value => value?.reward?.asset?.some(asset => amount(asset.num) > 0) === true,
  });
}

/** 竞技场选择可扫荡排名或比自己弱且排名更高的对手。 */
async function arena(ctx, options) {
  await repeat(ctx, options.maxActions, async () => {
    const state = await ctx.query('ArenaInfoRequest');
    const mine = state.myself;
    if (!mine || (ctx.stock.get('ARENA_POINT') ?? 0) < 1) return false;
    if (options.arena.sweep && state.challenges?.some(c => c.rankNo > mine.rankNo)) return succeeded(await mutate(ctx, 'ArenaSweepRequest', {}, 'ArenaInfoRequest', s => s.dailyChallengeTimes));
    if (!options.arena.challenge) return false;
    const enemy = state.challenges?.filter(c => c.rankNo < mine.rankNo && amount(c.power) < amount(mine.power)).sort((a, b) => a.rankNo - b.rankNo)[0];
    if (!enemy) return false;
    return succeeded(await ctx.action('ArenaChallengeRequest', { rank: enemy.rankNo, challengeId: idString(enemy.id) }, { accept: r => r.isWin === true }));
  });
}

/** 试炼胜负以读回通关 ID 判定；挑战被频控拒绝时停止整个战斗模块。 */
async function trial(ctx, raidId, options, limit, pacing) {
  let challengeRejected = false;
  if (options.challenge) await repeat(ctx, limit, async () => {
    const raid = (await ctx.query('TrialRaidInfoRequest', { raidId })).raid;
    if (!raid) return false;
    const next = ctx.rows('TrialRaidStageCfg').filter(r => r.raidId === raidId && r.stageId > raid.passedStage).sort((a, b) => a.stageId - b.stageId)[0];
    if (!next || next.openLevel > ctx.player.level) return false;
    await waitChallengeCooldown(ctx, pacing);
    const result = await ctx.action('TrialRaidChallengeRequest', { raidId, stageId: next.stageId }, { accept: async () => (await ctx.query('TrialRaidInfoRequest', { raidId })).raid?.passedStage >= next.stageId });
    if (result.status === 'rejected') {
      // 频控拒绝通常是当前连接的全局冷却，继续切换副本仍会重复触发同一限制。
      challengeRejected = true;
      return false;
    }
    return succeeded(result);
  });
  if (challengeRejected) return true;
  await repeat(ctx, limit, async () => {
    const raid = (await ctx.query('TrialRaidInfoRequest', { raidId })).raid;
    const cap = ctx.rows('TrialRaidParamCfg').find(r => r.paramName === '试炼副本扫荡次数')?.paramValue;
    if (!raid?.passedStage || !cap || raid.buySweepTimes >= cap) return false;
    const price = ctx.rows('TrialRaidBuySweepCfg').find(r => r.buyTimes === raid.buySweepTimes + 1)?.costRuby;
    if (price === undefined) { skip(ctx, '当前扫荡次数缺少价格，停止'); return false; }
    if (price > 0 && !options.rubySweep) return false;
    return succeeded(await mutate(ctx, 'TrialRaidBuySweepRequest', { raidId, useAdvCard: false }, 'TrialRaidInfoRequest', s => s.raid?.buySweepTimes, { stateBody: { raidId }, ruby: price }));
  });
}

/** 联盟赛只用现有积分挑战较弱对手，并领取挂机、段位和战令奖励。 */
async function league(ctx, options, limit) {
  let state = await ctx.query('LeagueInfoRequest');
  if (options.hangupReward && amount(state.bonusItemNum) > 0) await mutate(ctx, 'GotLeagueBonusItemRequest', {}, 'LeagueInfoRequest', s => s.bonusItemNum);
  if (options.danReward) await repeat(ctx, limit, async () => {
    state = await ctx.query('LeagueInfoRequest');
    if (state.dan <= state.gotBonusDan) return false;
    return succeeded(await ctx.action('LeagueGotBonusDanRequest'));
  });
  if (options.passReward) await repeat(ctx, limit, async () => {
    const pass = await ctx.query('LeagueBattlePassInfoRequest');
    if (!passReady(pass, ctx.rows('LeaguePassCfg').filter(r => r.dan === state.dan))) return false;
    return succeeded(await ctx.action('LeagueGotPassRewardRequest'));
  });
  if (!options.challenge) return;
  const defeated = new Set();
  await repeat(ctx, limit, async () => {
    if ((ctx.stock.get('LEAGUE_POINT') ?? 0) <= options.reservePoints) return false;
    state = await ctx.query('LeagueInfoRequest');
    const rivals = await ctx.query('LeagueRefreshRivalRequest', { isRefresh: false });
    const rival = rivals.rivals?.filter(r => !defeated.has(idString(r.playerId)) && amount(r.power) < amount(state.mine?.power)).sort((a, b) => amount(a.power) - amount(b.power))[0];
    if (!rival) return false;
    const result = await ctx.action('LeagueFightRequest', { playerId: idString(rival.playerId) });
    if (result.value?.win === 0) defeated.add(idString(rival.playerId));
    return succeeded(result);
  });
}

/** 远征血量使用本次服务器最大观察值，阵亡或低血线时不再推进。 */
export function expeditionHealth(heroes, maximum) {
  if (!heroes.length) return { count: 0, dead: 0, percent: 0 };
  let dead = 0, total = 0;
  for (const hero of heroes) {
    const hp = amount(hero.hp);
    maximum.set(hero.heroId, Math.max(maximum.get(hero.heroId) ?? 0, hp));
    if (hp <= 0) dead++;
    total += maximum.get(hero.heroId) > 0 ? hp / maximum.get(hero.heroId) * 100 : 0;
  }
  return { count: heroes.length, dead, percent: total / heroes.length };
}

/** 远征每次挑战后读回进度，选完待选增益才进入下一关。 */
async function expedition(ctx, options, limit) {
  let state = await ctx.query('ExpeditionInfoRequest');
  if (state.endTime > 0 && state.endTime <= ctx.now() / 1000) return skip(ctx, '远征已结束');
  if (options.sweep) for (const raidId of state.passedRaid ?? []) await ctx.action('ExpeditionSweepRequest', { raidId });
  if (options.freePass) await claimPass(ctx, ctx.protocol.BattlePassType.BP_EXPEDITION, 'ExpeditionBattlePassCfg');
  if (options.challenge && state.raidId) {
    if (!state.hero?.length && !state.passedStage) {
      const cfg = ctx.rows('ExpeditionRaidCfg').find(r => r.raidId === state.raidId);
      const heroId = (await ctx.query('AllHeroRequest')).heroes?.sort((a, b) => amount(b.power) - amount(a.power)).slice(0, cfg?.heroCount ?? 0).map(h => h.heroId) ?? [];
      if (!heroId.length) return skip(ctx, '远征缺少英雄或副本人数配置');
      if (!succeeded(await mutate(ctx, 'ExpeditionChooseRaidRequest', { raidId: state.raidId, heroId }, 'ExpeditionInfoRequest', s => s.hero))) return;
    }
    const cycle = `expedition.${state.raidId}.${state.endTime}`;
    const saved = ctx.memory(cycle);
    // 已经打过的远征不能把当前残血当作满血；没有基线时按配置血线保守停止。
    if (!saved && state.passedStage > 0 && options.challengeMinTeamHpPct > 0) return skip(ctx, '远征缺少本周期满血基线，请先建立基线或明确关闭百分比停止条件');
    const maximum = new Map(Object.entries(saved ?? {}));
    await repeat(ctx, limit, async () => {
      state = await ctx.query('ExpeditionInfoRequest');
      const health = expeditionHealth(state.hero ?? [], maximum);
      ctx.memory(cycle, Object.fromEntries(maximum));
      if (!health.count || (options.challengeStopOnHeroDeath && health.dead) || health.percent < options.challengeMinTeamHpPct) { skip(ctx, '远征触发阵亡或最低血量停止条件'); return false; }
      if (state.stageBuff?.length) if (!succeeded(await ctx.action('ExpeditionChooseBuffRequest', { raidId: state.raidId, buffId: state.stageBuff[0] }))) return false;
      const next = ctx.rows('ExpeditionStageCfg').filter(r => r.raidId === state.raidId && r.stageId > state.passedStage).sort((a, b) => a.stageId - b.stageId)[0];
      if (!next) return false;
      return succeeded(await ctx.action('ExpeditionChallengeRequest', { raidId: state.raidId, stageId: next.stageId }, { accept: async () => (await ctx.query('ExpeditionInfoRequest')).passedStage > state.passedStage }));
    });
  }
  state = await ctx.query('ExpeditionInfoRequest');
  const last = Math.max(0, ...ctx.rows('ExpeditionStageCfg').filter(r => r.raidId === state.raidId).map(r => r.stageId));
  if (options.finalReward && !state.gotFinal && last > 0 && state.passedStage >= last) await mutate(ctx, 'ExpeditionGotFinalRewardRequest', { raidId: state.raidId }, 'ExpeditionInfoRequest', s => s.gotFinal);
}
