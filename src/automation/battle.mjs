import { amount, idString } from './context.mjs';
import { mutate, repeat, skip, succeeded } from './common.mjs';

// 实测服务端约需 1.3 秒间隔，取 1.5 秒为网络抖动保留余量。
const CHALLENGE_COOLDOWN_MS = 1_500;
// 积分赛服务端每次只展示四名对手；数量不完整时无法保证榜单优先级，宁可跳过。
const LEAGUE_RIVAL_COUNT = 4;
// 抓包中当前免费刷新资格以 refreshTimes=1 表示；其他计数没有无钻证明，禁止发送刷新写请求。
const LEAGUE_FREE_REFRESH_TIMES = 1;
// 协议 raidId 固定对应三个设置入口；日志转换为玩法名称，用户才能识别实际挑战目标。
const TRIAL_NAMES = { 1: '英雄经验试炼', 2: '强化石试炼', 3: '宠物经验试炼' };

/**
 * 将试炼副本 ID 转换为控制台可读的玩法名称。
 *
 * @param {number} raidId 服务端试炼副本 ID。
 * @returns {string} 用于运行日志的试炼名称。
 */
function trialName(raidId) {
  return TRIAL_NAMES[raidId] ?? `试炼 ${raidId}`;
}

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
  if (['challenge', 'hangupReward', 'danReward', 'passReward'].some(k => options.league[k])) {
    try {
      await league(ctx, options.league, options.maxActions);
    } catch (error) {
      if (!isLeagueScoreMatchLocked(error)) throw error;
      // 这是服务端临时锁定而非连接断开；跳过积分赛可让本轮其余模块和下一轮继续执行。
      skip(ctx, '积分赛当前锁定，跳过本轮挑战');
    }
  }
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
 * 单个试炼的未知结果只阻止该试炼当天重发，不影响其余试炼或后续玩法。
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
    // 三类试炼的广告权益彼此独立；账本仍锁定当前登记，继续执行不会重复发这条请求。
    continueAfterUncertain: true, blockModuleOnUncertain: false,
  });
  if (!succeeded(registered)) return;
  if (!vipTrialSweepEnabled(ctx)) return;
  // VIP 免去播放，仍须登记广告权益；抓包的实际成功证据是奖励回包，而非普通扫荡计数变化。
  await ctx.action('TrialRaidBuySweepRequest', { raidId, useAdvCard: true }, {
    response: 'GotRewardResponse', label: `试炼 ${raidId} VIP免广告额外扫荡`,
    accept: value => value?.reward?.asset?.some(asset => amount(asset.num) > 0) === true,
    // 奖励回包超时同样只能跳过本试炼，不能据此停止后续独立玩法。
    continueAfterUncertain: true, blockModuleOnUncertain: false,
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
    const result = await ctx.action('TrialRaidChallengeRequest', { raidId, stageId: next.stageId }, {
      label: `${trialName(raidId)}第 ${next.stageId} 关`,
      accept: async () => (await ctx.query('TrialRaidInfoRequest', { raidId })).raid?.passedStage >= next.stageId,
    });
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

/**
 * 将积分赛阵容转换为可比较的两支舰队战力；缺队、零战力或并列时不能预测胜负。
 *
 * @param {Array<{power?: unknown}>|undefined} formations 服务端返回的阵容列表。
 * @returns {[number, number]|null} 1、2 号位舰队战力；无法明确强弱时返回 null。
 */
function leagueFormationPowers(formations) {
  if (!Array.isArray(formations) || formations.length !== 2 || formations.some(formation => formation?.power === undefined || formation.power === null)) return null;
  const powers = formations.map(formation => amount(formation.power));
  // 两队并列时无法定义“强队”，不能用任意位置猜测两局结果。
  if (!powers.every(power => Number.isFinite(power) && power > 0) || powers[0] === powers[1]) return null;
  return powers;
}

/**
 * 按客户端 LeagueTeamItem 的规则，将我方站位中的英雄当前战力相加得到两队战力。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {object} state LeagueInfoResponse 的最新我方阵容。
 * @returns {Promise<[number, number]|null>} 服务端数组顺序对应的两队战力；缺少英雄或有效战力时跳过。
 */
async function leagueOwnPowers(ctx, state) {
  const formations = state.ownFormations;
  if (!Array.isArray(formations) || formations.length !== 2 || formations.some(formation => !formation.heroPositions?.length)) {
    skip(ctx, '我方积分赛缺少两支完整阵容');
    return null;
  }
  try {
    // ownFormations 只含站位、不含 power；客户端逐队累加 AllHero 的英雄战力，宠物不额外相加。
    const heroes = new Map(((await ctx.query('AllHeroRequest')).heroes ?? []).map(hero => [hero.heroId, hero]));
    const powers = formations.map(formation => ({ power: formation.heroPositions.reduce((sum, position) => {
      const power = heroes.get(position.heroId)?.power;
      // 缺失英雄或战力不能按零补齐，否则会让错误阵容参与强弱队判断。
      return power === undefined || power === null || amount(power) <= 0 ? NaN : sum + amount(power);
    }, 0) }));
    const mine = leagueFormationPowers(powers);
    if (!mine) skip(ctx, '我方积分赛缺少两支可区分的舰队战力');
    return mine;
  } catch (error) {
    skip(ctx, `我方积分赛舰队战力读取失败：${error.message}`);
    return null;
  }
}

/**
 * 查询积分赛对手当前 1、2 号位的舰队战力；该接口不用于读取自己。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {string} playerId 积分赛玩家 ID。
 * @param {string} label 失败日志中展示的对象名称。
 * @returns {Promise<[number, number]|null>} 两支舰队战力，或无法安全比较时的 null。
 */
async function leaguePowers(ctx, playerId, label) {
  if (!playerId) {
    skip(ctx, `${label}缺少积分赛玩家 ID`);
    return null;
  }
  try {
    const state = await ctx.query('LeagueOtherFormationRequest', { playerId });
    const powers = leagueFormationPowers(state.formation);
    if (!powers) skip(ctx, `${label}缺少两支可区分的舰队战力`);
    return powers;
  } catch (error) {
    // 对手阵容读取失败不能降级为总战力比较，否则会把单队失败隐藏成“稳赢”。
    skip(ctx, `${label}舰队战力读取失败：${error.message}`);
    return null;
  }
}

/**
 * 计算严格获胜或保分平局需要的我方站位；返回 null 表示该阵容无法满足目标。
 *
 * @param {[number, number]} mine 我方当前 1、2 号位舰队战力。
 * @param {[number, number]} rival 对方当前 1、2 号位舰队战力。
 * @param {'win'|'draw'} strategy 严格两胜或强打弱的平局策略。
 * @returns {{ swap: boolean, positionedMine: [number, number] }|null} 是否需要 [2,1] 换位及目标位置战力。
 */
function leaguePairing(mine, rival, strategy) {
  const mineStrong = mine[0] > mine[1] ? 0 : 1;
  const rivalStrong = rival[0] > rival[1] ? 0 : 1;
  // 两胜要强对强；平局要强打弱。只有两队位置相反时才发送换位请求。
  const swap = strategy === 'win' ? mineStrong !== rivalStrong : mineStrong === rivalStrong;
  const positionedMine = swap ? [mine[1], mine[0]] : mine;
  const positionedStrong = positionedMine[0] > positionedMine[1] ? 0 : 1;
  if (strategy === 'win') {
    return positionedMine.every((power, index) => power > rival[index]) ? { swap, positionedMine } : null;
  }
  const mineWeak = 1 - positionedStrong;
  return positionedStrong !== rivalStrong
    && positionedMine[positionedStrong] > rival[positionedStrong]
    && positionedMine[mineWeak] < rival[mineWeak]
    ? { swap, positionedMine }
    : null;
}

/**
 * 在服务端给出的原始榜单顺序中查找第一个符合策略的对手，绝不按总战力重新排序。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {object} state 当前积分赛状态。
 * @param {[number, number]} mine 已从我方站位和英雄快照核对的两队战力。
 * @param {Array<object>} rivals 服务端当前展示的四名对手。
 * @param {'win'|'draw'} strategy 严格两胜或平局策略。
 * @param {Set<string>} fought 本轮已挑战过的对手，避免列表延迟更新后重复挑战。
 * @returns {Promise<{ rival: object, mineId: string, pairing: { swap: boolean, positionedMine: [number, number] } }|null>} 首个可挑战候选。
 */
async function leagueCandidate(ctx, state, mine, rivals, strategy, fought) {
  const mineId = idString(state.mine?.playerId);
  if (!mineId || state.mine?.power === undefined || state.mine?.power === null || amount(state.mine.power) <= 0) {
    skip(ctx, '积分赛缺少我方总战力或玩家 ID');
    return null;
  }
  for (const rival of rivals) {
    const rivalId = idString(rival?.playerId);
    if (!rivalId || fought.has(rivalId)) continue;
    // 严格获胜必须先满足总战力更低；平局则允许总战力更高，只看强弱队能否一胜一负。
    if (strategy === 'win' && (rival?.power === undefined || rival.power === null || amount(rival.power) >= amount(state.mine.power))) continue;
    const rivalPowers = await leaguePowers(ctx, rivalId, `对手 ${rival.nickname || rivalId}`);
    if (!rivalPowers) continue;
    const pairing = leaguePairing(mine, rivalPowers, strategy);
    if (pairing) return { rival, mineId, pairing };
  }
  return null;
}

/**
 * 必要时切换积分赛两队顺序，并通过我方阵容读回确认，而不是仅相信换位接口回包。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {{ rival: object, mineId: string, pairing: { swap: boolean, positionedMine: [number, number] } }} candidate 待挑战候选。
 * @param {'win'|'draw'} strategy 当前挑战策略。
 * @returns {Promise<boolean>} 当前实际站位是否已经满足候选条件。
 */
async function positionLeagueCandidate(ctx, candidate, strategy) {
  if (!candidate.pairing.swap) return true;
  const name = candidate.rival.nickname || idString(candidate.rival.playerId);
  const result = await ctx.action('LeagueFormationSequenceRequest', { index: [2, 1] }, {
    response: 'LeagueFormationResponse', label: `联盟赛${strategy === 'win' ? '两胜' : '平局'}换位 ${name}`,
    // 换位回包不带战力；重新读取自己的站位和英雄快照，确认实际两队顺序已经改变。
    accept: async () => JSON.stringify(await leagueOwnPowers(ctx, await ctx.query('LeagueInfoRequest'))) === JSON.stringify(candidate.pairing.positionedMine),
  });
  if (succeeded(result)) return true;
  skip(ctx, `对手 ${name} 换位未确认，跳过挑战`);
  return false;
}

/**
 * 归一化积分赛两局回包，按我方在左右哪一侧转换 isLWin，并保留本方积分变化用于保分验证。
 *
 * @param {object|undefined} value LeagueFightResponse 回包。
 * @param {string} mineId 我方积分赛玩家 ID。
 * @returns {{ wins: number, score: number, finalScore: number }|null} 两局结果与我方积分；字段不完整时返回 null。
 */
function leagueFightSummary(value, mineId) {
  if (!Array.isArray(value?.records) || value.records.length !== 2 || value.records.some(record => typeof record?.isLWin !== 'boolean')) return null;
  const leftMine = idString(value.lPlayer?.playerId) === mineId;
  const rightMine = idString(value.rPlayer?.playerId) === mineId;
  if (leftMine === rightMine) return null;
  const player = leftMine ? value.lPlayer : value.rPlayer;
  if (player?.score === undefined || player?.score === null || player.finalScore === undefined || player.finalScore === null) return null;
  const score = amount(player.score), finalScore = amount(player.finalScore);
  if (!Number.isFinite(score) || !Number.isFinite(finalScore)) return null;
  const wins = value.records.filter(record => leftMine ? record.isLWin : !record.isLWin).length;
  return { wins, score, finalScore };
}

/**
 * 发送积分赛挑战，并只接受策略要求的两局战果；平局必须以本方最终积分不降低为准。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {{ rival: object, mineId: string, pairing: { swap: boolean, positionedMine: [number, number] } }} candidate 已完成筛选的对手。
 * @param {'win'|'draw'} strategy 当前挑战策略。
 * @returns {Promise<boolean>} 是否已得到可确认的策略结果。
 */
async function fightLeagueCandidate(ctx, candidate, strategy) {
  const name = candidate.rival.nickname || idString(candidate.rival.playerId);
  const result = await ctx.action('LeagueFightRequest', { playerId: idString(candidate.rival.playerId) }, {
    label: `联盟赛${strategy === 'win' ? '两胜' : '平局'}挑战 ${name}`,
    accept: value => {
      const summary = leagueFightSummary(value, candidate.mineId);
      return strategy === 'win'
        ? summary?.wins === 2
        : summary?.wins === 1 && summary.finalScore >= summary.score;
    },
  });
  if (succeeded(result)) return true;
  const summary = leagueFightSummary(result.value, candidate.mineId);
  if (strategy === 'draw' && summary?.wins === 1 && summary.finalScore < summary.score) skip(ctx, `对手 ${name} 平局后积分下降，停止积分赛挑战`);
  else skip(ctx, `对手 ${name} 未满足${strategy === 'win' ? '两局全胜' : '一胜一负且积分不降'}，停止积分赛挑战`);
  return false;
}

/**
 * 只有抓包已证明的首个免费刷新计数才允许提交实际换榜请求，并在回包后复核钻石余额未变化。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {object} listed 当前免费列表回包。
 * @returns {Promise<Array<object>|null>} 刷新后的四名对手；未证实免费或刷新异常时返回 null。
 */
async function refreshLeagueRivalsFree(ctx, listed) {
  if (listed?.refreshTimes !== LEAGUE_FREE_REFRESH_TIMES) {
    skip(ctx, '积分赛刷新次数未处于已验证的免费档，拒绝刷新');
    return null;
  }
  const rubyBefore = ctx.stock.get('RUBY') ?? 0;
  const result = await ctx.action('LeagueRefreshRivalRequest', { isRefresh: true }, {
    response: 'LeagueRefreshRivalResponse', label: '积分赛免费刷新',
    // 首次 true 刷新是抓包中唯一确认无 RUBY 推送的实际换榜请求；读回余额防止服务端规则变动后继续挑战。
    accept: async value => {
      await ctx.refreshStock();
      return Array.isArray(value?.rivals) && value.rivals.length === LEAGUE_RIVAL_COUNT && (ctx.stock.get('RUBY') ?? 0) === rubyBefore;
    },
  });
  // 预览只会得到 planned 结果，没有服务端换榜数据；不能据此虚构后续候选或平局战斗。
  return succeeded(result) ? result.value?.rivals ?? null : null;
}

/**
 * 验证服务端当前榜单确为四名不同对手，避免半页或重复数据破坏从上到下的积分优先级。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {object} listed LeagueRefreshRivalResponse 回包。
 * @returns {Array<object>|null} 可按原顺序处理的四名对手。
 */
function leagueRivals(ctx, listed) {
  const rivals = listed?.rivals;
  const ids = Array.isArray(rivals) ? rivals.map(rival => idString(rival?.playerId)) : [];
  if (rivals?.length !== LEAGUE_RIVAL_COUNT || ids.some(id => !id) || new Set(ids).size !== LEAGUE_RIVAL_COUNT) {
    skip(ctx, '积分赛对手列表不是四名不同对手，停止本轮挑战');
    return null;
  }
  return rivals;
}

/**
 * 判断本次积分赛读取是否被服务端的锁定提示拒绝；仅该已知提示可按本轮跳过处理。
 *
 * @param {unknown} error 当前协议请求抛出的异常。
 * @returns {boolean} 是否为积分赛已锁定提示。
 */
function isLeagueScoreMatchLocked(error) {
  return error instanceof Error
    && Array.isArray(error.prompt?.args)
    && error.prompt.args.join(' ').trim().toLowerCase() === 'score match locked';
}

/** 联盟赛只按榜单从上到下挑战两局全胜对手；无稳赢时仅做一次已验证免费的换榜，再以保分平局兜底。 */
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
  const fought = new Set();
  let usedFreeRefresh = false;
  await repeat(ctx, limit, async () => {
    if ((ctx.stock.get('LEAGUE_POINT') ?? 0) <= options.reservePoints) return false;
    state = await ctx.query('LeagueInfoRequest');
    // 我方阵容不完整时无法筛选候选，停止本轮，不能把读取失败误当成需要刷新对手。
    const mine = await leagueOwnPowers(ctx, state);
    if (!mine) return false;
    const listed = await ctx.query('LeagueRefreshRivalRequest', { isRefresh: false });
    let rivals = leagueRivals(ctx, listed);
    if (!rivals) return false;
    let candidate = await leagueCandidate(ctx, state, mine, rivals, 'win', fought);
    if (candidate) {
      if (!await positionLeagueCandidate(ctx, candidate, 'win')) return false;
      if (!await fightLeagueCandidate(ctx, candidate, 'win')) return false;
      fought.add(idString(candidate.rival.playerId));
      return true;
    }
    if (usedFreeRefresh) return false;
    usedFreeRefresh = true;
    const refreshed = await refreshLeagueRivalsFree(ctx, listed);
    // 未获准刷新或预览没有新榜单时直接结束，不能把空结果误报成服务器对手人数不足。
    if (!refreshed) return false;
    rivals = leagueRivals(ctx, { rivals: refreshed });
    // 只有服务端实际返回四名不同对手，才继续使用新榜单筛选挑战目标。
    if (!rivals) return false;
    candidate = await leagueCandidate(ctx, state, mine, rivals, 'win', fought);
    if (candidate) {
      if (!await positionLeagueCandidate(ctx, candidate, 'win')) return false;
      if (!await fightLeagueCandidate(ctx, candidate, 'win')) return false;
      fought.add(idString(candidate.rival.playerId));
      return true;
    }
    candidate = await leagueCandidate(ctx, state, mine, rivals, 'draw', fought);
    if (!candidate) return false;
    if (!await positionLeagueCandidate(ctx, candidate, 'draw')) return false;
    // 平局只用于保住当前积分；无论成功与否，都停止本轮，避免继续扩大不确定性。
    await fightLeagueCandidate(ctx, candidate, 'draw');
    return false;
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
