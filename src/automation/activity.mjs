import { makeTypeResolver } from '../world.mjs';
import { businessDate } from './settings.mjs';
import { amount, idString } from './context.mjs';
import { costs, mutate, repeat, skip, succeeded } from './common.mjs';
import { activities } from './welfare.mjs';
import { claimPass } from './battle.mjs';

/** 活动天数从上海日零点计算，跨午夜不依赖电脑时区。 */
export function openDays(openTime, now) {
  if (!(openTime > 0)) return 0;
  return Math.floor((Date.parse(`${businessDate(now)}T00:00:00+08:00`) - Date.parse(`${businessDate(openTime * 1000)}T00:00:00+08:00`)) / 86400000) + 1;
}

/** 活动消耗道具须出现在服务端本期有效道具列表，不使用上一期道具。 */
function eventItem(ctx, event, suffix) {
  return event.limitTimeItem?.find(r => r.item.endsWith(suffix) && r.openTime <= ctx.now() / 1000 && r.closeTime > ctx.now() / 1000)?.item;
}

/** 活动领奖使用库存变化核对静默回包，记录按 activityId 区分不同活动周期。 */
async function reward(ctx, request, body, key) {
  if (key && ctx.count(key)) return skip(ctx, '本业务日已经领取', request);
  await ctx.refreshStock();
  const before = JSON.stringify([...ctx.stock]);
  const result = await ctx.action(request, body, { confirm: async () => { await ctx.refreshStock(); return JSON.stringify([...ctx.stock]) !== before; } });
  if (key && result.status === 'success') ctx.count(key, 1);
  return result;
}

/** 仅执行本期正在开放的节庆活动，各子活动再校验自己的开放时间。 */
export async function activity(ctx, options) {
  const all = await activities(ctx);
  // 酆都玩法独立识别本期活动，不受历史中秋活动分支限制。
  if (options.edict.enabled) await edict(ctx, all);
  const event = all?.festivalActivities?.find(f => (f.type === '中秋国庆活动' || f.type.includes('中秋')) && f.openTime <= ctx.now() / 1000 && f.closeTime > ctx.now() / 1000);
  if (event) {
    const id = idString(event.activityId);
    /** 子活动参数由当前推送直接读取；缺失不套用默认周期。 */
    const sub = type => event.subActivity?.find(s => s.subActivityType === type && s.openTime <= ctx.now() / 1000 && s.closeTime > ctx.now() / 1000);
    if (options.midAutumn.enabled && sub(11)) {
      const state = sub(11).dailyActive;
      const day = openDays(sub(11).openTime, ctx.now());
      const cfg = ctx.rows('NationalDaySignCfg').find(r => r.signDay === day);
      if (options.midAutumn.signIn && cfg && !state?.checkInId?.includes(cfg.rewardId)) await ctx.action('ClaimActivityDailyCheckInRewardRequest', { activityId: id, checkId: cfg.rewardId });
      if (options.midAutumn.activeReward) await repeat(ctx, 40, async () => {
        const current = ctx.pushes.get('SCAllActivity')?.festivalActivities?.find(f => idString(f.activityId) === id)?.subActivity?.find(s => s.subActivityType === 11)?.dailyActive;
        const next = ctx.rows('NationalDayActiveRewardCfg').find(r => r.rewardId === (current?.claimedRewardId ?? state?.claimedRewardId ?? 0) + 1);
        if (!next || (current?.activeScore ?? state?.activeScore ?? 0) < next.score) return false;
        const result = await ctx.action('ClaimActivityDailyActiveRewardRequest', { activityId: id });
        if (result.value?.claimedId) state.claimedRewardId = result.value.claimedId;
        return succeeded(result);
      });
    }
    if (options.midAutumn.enabled && options.midAutumn.freeGift && sub(6)) {
      const free = ctx.rows('NationalDayDailyDealCfg').find(r => r.season === event.season && r.price === 0);
      if (free && !sub(6).dailyCombGift?.boughtGiftId?.includes(free.packId)) await reward(ctx, 'ClaimDailyCombGiftRequest', { activityId: id, giftId: free.packId }, `event.${id}.comb.${free.packId}`);
    }
    if (options.blindBox.enabled && sub(24)) await blindBox(ctx, event, options.blindBox);
    if (options.catcher.enabled && sub(7)) await catcher(ctx, event, options.catcher, openDays(sub(7).openTime, ctx.now()));
    if (options.workshop.enabled) await workshop(ctx, event, options.workshop);
    if (options.blessing.enabled && sub(25)) await blessing(ctx, event, options.blessing);
  } else if (['midAutumn', 'blindBox', 'catcher', 'workshop', 'blessing'].some(k => options[k].enabled)) skip(ctx, '中秋活动未开放或已经结束');
  if (options.weekOrder.enabled) await weekOrder(ctx, options.weekOrder);
  if (options.weekLottery.enabled) await lottery(ctx, options.weekLottery);
}

/** 校验本局答案、四张显化状态和耐心；缺失状态不能作为未显化或正确答案处理。 */
function validEdictSession(session) {
  return Array.isArray(session?.rune) && session.rune.length === 4
    && session.rune.every(rune => Number.isInteger(rune) && rune >= 0 && rune <= 2147483647)
    && new Set(session.rune).size === 4
    && Array.isArray(session.shown) && session.shown.length === 4
    // 每张有六块遮挡；零表示从未显化，非零表示已经显化过至少一块。
    && session.shown.every(shown => Number.isInteger(shown) && shown >= 0 && shown <= 63)
    && Object.hasOwn(session, 'patience') && Number.isInteger(session.patience)
    && session.patience > 0 && session.patience <= 100;
}

/** 每轮仅处理一局酆都法旨；先逐张显化，再用服务端本局答案竞猜并核对结算。 */
async function edict(ctx, all) {
  const event = all?.festivalActivities?.find(f => f.type === '捞尸人联动活动'
    && f.openTime <= ctx.now() / 1000 && f.closeTime > ctx.now() / 1000);
  if (!event) return skip(ctx, '酆都捞尸人活动未开放或已经结束', '酆都捞尸人');
  const activityId = idString(event.activityId), key = `edict.${activityId}`;
  if (!/^[1-9]\d*$/.test(activityId)) return skip(ctx, '酆都捞尸人活动编号无效', '酆都捞尸人');
  const info = await ctx.query('EdictInfoRequest', { activityId });
  // 超时后的账本记录跨轮保留，不能在旧竞猜未确认时又扣券开下一局。
  if (Object.keys(ctx.ledger.pending).some(pending => pending.startsWith(`${key}.`))) return skip(ctx, '酆都捞尸人上次请求结果未确认，停止参与', '酆都捞尸人');
  let session = info.session;
  if (!session) {
    ctx.memory(`${key}.failedGuess`, null);
    const cost = info.cost, count = amount(cost?.num);
    // 只允许服务端明确给出的道具成本，不能把缺失费用当作免费或改用钻石。
    if (cost?.type !== 0 || !cost.id || !Number.isSafeInteger(count) || count <= 0) return skip(ctx, '酆都捞尸人入场券成本缺失或无效', '酆都捞尸人');
    const expenses = costs([cost], ctx.protocol);
    await ctx.refreshStock();
    if (!ctx.enough(expenses)) return skip(ctx, `酆都捞尸人入场券不足：需要${cost.id} × ${count}`, '酆都捞尸人');
    const start = await ctx.action('EdictStartRequest', { activityId }, {
      key: `${key}.start`, expenses, label: '酆都捞尸人：开始一局',
      accept: value => validEdictSession(value?.session) && value.session.shown.every(shown => shown === 0),
    });
    // 预览仅能规划开局，不能假设已经拿到新局答案和显化状态。
    if (ctx.dryRun || start.status !== 'success') return;
    session = start.value.session;
  }
  if (!validEdictSession(session)) return skip(ctx, '酆都捞尸人本局符文、显化状态或耐心无效，停止参与', '酆都捞尸人');
  if (ctx.memory(`${key}.failedGuess`)) return skip(ctx, '酆都捞尸人本局竞猜已失败，请在游戏内确认后继续', '酆都捞尸人');
  const guess = [...session.rune];
  const missing = session.shown.flatMap((shown, index) => shown === 0 ? [index] : []);
  let patience = session.patience;
  // 每次显化消耗 5 耐心，必须为所有待显化符文和最终竞猜保留正数耐心。
  if (patience <= missing.length * 5) return skip(ctx, '酆都捞尸人耐心不足，停止显化和竞猜', '酆都捞尸人');
  for (const paperIdx of missing) {
    const reveal = await ctx.action('EdictAskRequest', { activityId, paperIdx }, {
      key: `${key}.ask.${paperIdx}`, label: `酆都捞尸人：显化第 ${paperIdx + 1} 张符文`,
      accept: value => Object.hasOwn(value ?? {}, 'cellIdx') && Number.isInteger(value.cellIdx)
        && value.cellIdx >= 0 && value.cellIdx < 6 && Object.hasOwn(value, 'patience') && value.patience === patience - 5,
    });
    if (ctx.dryRun || reveal.status !== 'success') return;
    patience = reveal.value.patience;
  }
  // 仅信任服务端读回的四张已显化状态；cellIdx=0 是有效遮挡块，不能当作失败。
  const current = (await ctx.query('EdictInfoRequest', { activityId })).session;
  if (!validEdictSession(current) || !current.shown.every(shown => shown > 0)
    || current.rune.some((rune, index) => rune !== guess[index]) || current.patience !== patience) {
    return skip(ctx, '酆都捞尸人提交前读回未确认四张显化或本局状态，停止竞猜', '酆都捞尸人');
  }
  if (ctx.dryRun) return skip(ctx, '酆都捞尸人预览仅检查本局状态，不规划竞猜', '酆都捞尸人');
  const result = await ctx.action('EdictGuessRequest', { activityId, guess }, {
    key: `${key}.guess`, label: '酆都捞尸人：竞猜并结算',
    accept: value => value?.success === true && value.correct?.length === 4 && value.correct.every(correct => correct === true),
  });
  // 业务失败不继续猜测；阻止后续循环对同一未完成局重复提交答案。
  if (result.status === 'failed') ctx.memory(`${key}.failedGuess`, true);
  if (result.status !== 'success') return;
  const value = result.value;
  const rewards = costs(value.reward?.asset, ctx.protocol).map(([id, num]) => `${id} × ${num}`).join('、');
  ctx.record({ status: 'success', label: `酆都捞尸人：结算成功，功德 ${value.score}，奖励：${rewards || '无道具奖励'}`, value });
}

/** 盲盒先续开已有局，再消耗有效卡片开新局；每格只提交一次。 */
async function blindBox(ctx, event, options) {
  const activityId = idString(event.activityId), item = eventItem(ctx, event, '_盲盒卡');
  if (options.freeGift) {
    // 本期免费自选礼包 ID 与节庆免费礼包共用配置，不探测付费礼包。
    const free = ctx.rows('NationalDayDailyDealCfg').find(r => r.season === event.season && r.price === 0);
    if (free) await reward(ctx, 'ClaimFreeSelectGiftRequest', { activityId, giftId: free.packId }, `event.${activityId}.select.${free.packId}`);
  }
  if (options.play) await repeat(ctx, 80, async () => {
    let round = (await ctx.query('BlindBoxDetailRequest', { activityId })).round;
    if (!round?.prizeType?.length) {
      if (!item || (ctx.stock.get(item) ?? 0) <= options.keepCards) return false;
      const start = await ctx.action('BlindBoxStartRequest', { activityId }, { expenses: [[item, 1]] });
      if (!succeeded(start)) return false;
      if (ctx.dryRun) return false;
      round = (await ctx.query('BlindBoxDetailRequest', { activityId })).round;
    }
    if (!round?.prizeType?.length) return false;
    for (let boxIndex = 1; boxIndex <= round.prizeType.length; boxIndex++) {
      if (round.opened?.some(r => r.boxIndex === boxIndex)) continue;
      const result = await ctx.action('BlindBoxOpenRequest', { activityId, boxIndex });
      if (!succeeded(result)) return false;
      if (result.value?.finished) break;
    }
    return true;
  });
  if (options.scoreReward) await repeat(ctx, 40, async () => {
    const state = await ctx.query('BlindBoxDetailRequest', { activityId });
    const row = ctx.rows('NationalDayBlindBoxScoreRewardCfg').find(r => r.id === state.claimedId + 1);
    if (!row || state.stat?.totalScore < row.score) return false;
    return succeeded(await mutate(ctx, 'ClaimBlindBoxScoreRewardRequest', { activityId }, 'BlindBoxDetailRequest', s => s.claimedId, { stateBody: { activityId } }));
  });
}

/** 海底捞月使用本关真实奖励 ID、物件配置和解锁天数，未完成关卡优先续结算。 */
async function catcher(ctx, event, options, days) {
  const activityId = idString(event.activityId), item = eventItem(ctx, event, '_捞月钩');
  if (options.passReward) await claimPass(ctx, ctx.protocol.BattlePassType.BP_ACTIVITY_CATCHER, 'NationalDayBattlePassCfg');
  if (!options.play && !options.repeat && !options.sweep) return;
  await repeat(ctx, 40, async () => {
    const info = await ctx.query('CatcherInfoRequest', { activityId });
    const unlocked = (info.stage ?? []).filter(s => s.unlockDay <= days && s.stage <= options.maxStage).sort((a, b) => a.stage - b.stage);
    const pending = unlocked.find(s => s.maxStar < 3);
    const selected = info.currentStage > 0 ? unlocked.find(s => s.stage === info.currentStage) : options.play && pending ? pending : options.repeat ? unlocked.at(-1) : options.sweep ? unlocked.find(s => s.stage === options.sweepStage && s.maxStar === 3) : null;
    if (!selected) return false;
    const stage = selected.stage, cfg = ctx.rows('MinigameMinerStageCfg').find(r => r.stage === stage);
    if (!cfg) { skip(ctx, '缺少捞月关卡配置'); return false; }
    if (!info.currentStage) {
      if (!item || (ctx.stock.get(item) ?? 0) <= options.keepHooks) return false;
      if (options.sweep && !options.repeat && selected.maxStar === 3) return succeeded(await ctx.action('CatcherSweepRequest', { activityId, stage }, { expenses: [[item, 1]] }));
    }
    const memoryKey = `catcher.${activityId}.${stage}`;
    let rewardIds = ctx.memory(memoryKey);
    if (!info.currentStage) {
      const start = await ctx.action('CatcherStartRequest', { activityId, stage }, { expenses: [[item, 1]] });
      if (!succeeded(start) || ctx.dryRun) return false;
      rewardIds = start.value?.rewardItem?.map(r => r.id) ?? [];
      ctx.memory(memoryKey, rewardIds);
    }
    // 查询接口不返回开局奖励 ID；旧会话缺失记录时不能伪造空奖励继续结算。
    if (!Array.isArray(rewardIds)) { skip(ctx, '捞月续局缺少开局奖励记录，请在游戏内完成本局'); return false; }
    const objects = [];
    for (const text of cfg.items) {
      const [id, count] = text.split(',').map(Number), object = ctx.rows('MinigameMinerItemsCfg').find(r => r.id === id);
      if (!object) { skip(ctx, '缺少捞月物件配置'); return false; }
      if (object.hp > 0 || id >= 2000) objects.push(...Array(count).fill(id));
    }
    const result = await ctx.action('CatcherEndRequest', { activityId, stage, hookedRewardIds: rewardIds, hookedObstacleIds: [], hookedObjectIds: objects, hookedStarIds: objects.filter(id => id >= 2000) });
    if (result.status === 'success') ctx.memory(memoryKey, null);
    return succeeded(result);
  });
}

/** 活动工坊独立管理材料保留量、备货水位、生产位及日加速次数。 */
async function workshop(ctx, event, options) {
  const resolve = makeTypeResolver(ctx.config);
  const building = (await ctx.query('OnWaterRequest')).building?.find(b => resolve(b.buildingId) === '活动工厂' && b.factory);
  const item = eventItem(ctx, event, '_捞月钩'), claw = eventItem(ctx, event, '_爪钩');
  const recipe = ctx.rows('BuildingProduceCfg').find(r => r.buildType === '活动工厂' && r.itemId === item && r.unlockLevel <= building?.level);
  if (!building || !recipe || !claw) return skip(ctx, '活动工坊未开放或配方缺失');
  const select = s => s.building?.find(b => b.buildingId === building.buildingId)?.factory;
  if (options.gain && building.factory.finishedProducts?.length) await ctx.action('GainFactoryProduceRequest', { buildingId: building.buildingId });
  const cap = ctx.rows('BuildingProduceParamCfg').find(r => r.paramName === '制造位上限')?.paramValue;
  if (options.produce && cap > 0) await repeat(ctx, cap, async () => {
    const state = select(await ctx.query('OnWaterRequest'));
    const stock = (ctx.stock.get(item) ?? 0) + (state?.factoryQ?.filter(q => q.productId === item).length ?? 0) + (state?.finishedProducts?.filter(p => p.id === item).reduce((sum, p) => sum + Number(p.num), 0) ?? 0);
    if (stock >= options.keepStock || state?.factoryQ?.length >= cap || !ctx.enough(recipe.costItem, { [claw]: options.keepClaws })) return false;
    return succeeded(await mutate(ctx, 'StartFactoryProduceRequest', { buildingId: building.buildingId, productId: item }, 'OnWaterRequest', select, { expenses: recipe.costItem }));
  });
  if (options.speedUp) await repeat(ctx, Math.max(0, options.speedUpDailyLimit - ctx.count('workshop.speed')), async () => {
    const job = select(await ctx.query('OnWaterRequest'))?.factoryQ?.[0];
    if (!job || (ctx.stock.get('加速器') ?? 0) < 1) return false;
    const result = await mutate(ctx, 'SpeedUpFactoryProduceRequest', { buildingId: building.buildingId, index: job.idx, speedUp: { type: 2, useNum: 1 } }, 'OnWaterRequest', select, { expenses: [['加速器', 1]] });
    if (result.status === 'success') ctx.count('workshop.speed', 1);
    return succeeded(result);
  });
}

/** 祝福只投向用户选择皮肤，心动上限及领奖档取本期配置。 */
async function blessing(ctx, event, options) {
  const activityId = idString(event.activityId), skinId = options.skinId, item = eventItem(ctx, event, '_福运结');
  const rows = ctx.rows('NationalDayCelebrateCfg').filter(r => r.skinId === skinId && r.season <= event.season).sort((a, b) => a.stageId - b.stageId);
  if (!skinId || !rows.length) return skip(ctx, '请配置有效祝福皮肤');
  if (options.boost) await repeat(ctx, 80, async () => {
    const skin = (await ctx.query('CelebrationDetailRequest', { activityId })).skin?.find(s => s.skinId === skinId);
    if (!item || !skin || skin.curHeart >= rows.at(-1).heartValue) return false;
    const times = Math.min(options.boostTimes, Math.max(0, (ctx.stock.get(item) ?? 0) - options.keepKnots));
    if (times <= 0) return false;
    return succeeded(await ctx.action('CelebrationBoostRequest', { activityId, skinId, times }, { expenses: [[item, times]] }));
  });
  if (options.claimReward) await repeat(ctx, rows.length, async () => {
    const skin = (await ctx.query('CelebrationDetailRequest', { activityId })).skin?.find(s => s.skinId === skinId);
    const next = rows.find(r => r.stageId > (skin?.claimedTier ?? 0) && r.heartValue <= (skin?.curHeart ?? 0));
    if (!next) return false;
    return succeeded(await mutate(ctx, 'ClaimCelebrationRewardRequest', { activityId, skinId }, 'CelebrationDetailRequest', s => s.skin, { stateBody: { activityId } }));
  });
}

/** 周商人缺料购买必须整单有价且满足统一额度，买完读回背包再交单。 */
async function weekOrder(ctx, options) {
  const week = await ctx.query('WeekInfoRequest');
  const periods = ctx.rows('WeekOrderPeriodCfg').map(r => r.periodId);
  const active = week.activityTime?.find(t => periods.includes(t.period) && t.startTime <= ctx.now() / 1000 && t.endTime > ctx.now() / 1000);
  if (!active) return skip(ctx, '不差钱商人未开放');
  await repeat(ctx, 40, async () => {
    const state = await ctx.query('WeekOrderInfoRequest');
    const expenses = costs(state.order, ctx.protocol);
    if (!expenses.length) return false;
    if (!ctx.enough(expenses)) {
      if (!options.buyMissingMaterials) return false;
      const goods = expenses.filter(([id, n]) => (ctx.stock.get(id) ?? 0) < n).map(([itemId, n]) => ({ itemId, num: n - (ctx.stock.get(itemId) ?? 0) }));
      let ruby = 0;
      for (const g of goods) {
        const price = ctx.rows('ItemPriceCfg').find(r => r.itemId === g.itemId)?.rubyPrice;
        if (!(price > 0)) { skip(ctx, `${g.itemId} 缺少购买价格`); return false; }
        ruby += price * g.num;
      }
      if ((ctx.stock.get('RUBY') ?? 0) - ruby < options.minRubyStock) return false;
      if (!succeeded(await ctx.action('CommonBuyGoodsRequest', { goods }, { ruby }))) return false;
      if (ctx.dryRun || !ctx.enough(expenses)) return false;
    }
    return succeeded(await ctx.action('FinishWeekOrderRequest', {}, { expenses }));
  });
  const state = await ctx.query('WeekOrderInfoRequest');
  const rewards = ctx.rows('WeekOrderRwdCfg').filter(r => r.periodId === active.period && r.rwdId > 0);
  if (!state.isGotFinal && rewards.length && state.gotRwdId?.length >= rewards.length) await mutate(ctx, 'WeekOrderGotFinalRequest', {}, 'WeekOrderInfoRequest', s => s.isGotFinal);
}

/** 幸运转盘只用背包已有转盘币，次数奖励按本期配置与已领取档位判断。 */
async function lottery(ctx, options) {
  const week = await ctx.query('WeekInfoRequest');
  const periods = ctx.rows('WeekLotteryPeriodCfg').map(r => r.periodId);
  const active = week.activityTime?.find(t => periods.includes(t.period) && t.startTime <= ctx.now() / 1000 && t.endTime > ctx.now() / 1000);
  if (!active) return skip(ctx, '幸运转盘未开放');
  if (options.prize) await repeat(ctx, options.maxDraws, async () => {
    if ((ctx.stock.get('周转盘币') ?? 0) < 1) return false;
    return succeeded(await ctx.action('WeekLotteryPrizeRequest', { times: 1 }, { expenses: [['周转盘币', 1]] }));
  });
  await repeat(ctx, 40, async () => {
    const state = (await ctx.query('WeekLotteryInfoRequest')).gotInfo;
    const next = ctx.rows('WeekLotteryTimesCfg').find(r => r.periodId === active.period && r.rwdId === state?.gotStage + 1);
    if (!next || state.times < next.reqTimes) return false;
    return succeeded(await ctx.action('WeekLotteryTimesRewardRequest'));
  });
}
