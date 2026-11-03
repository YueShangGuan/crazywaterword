import { surveyTasks } from '../tasks.mjs';
import { planChests } from '../dailies.mjs';
import { idString } from './context.mjs';
import { awaitPush, mutate, repeat, rewardAction, skip, succeeded } from './common.mjs';

/** 当前连接未收到活动推送时，只请求登录同步信号，不使用跨账号缓存。 */
export async function activities(ctx) {
  if (!ctx.pushes.has('SCAllActivity')) await awaitPush(ctx, ['SCAllActivity'], () => ctx.client.sendWatch('LoginFinishRequest', {}, { window: 100 }), 1500);
  const state = ctx.pushes.get('SCAllActivity');
  if (!state) { skip(ctx, '当前连接没有活动状态推送'); return null; }
  return state;
}

/** 福利领取使用服务端已达标状态；周抽奖和专属抽奖均独立于日奖开关。 */
export async function welfare(ctx, options) {
  if (options.growth) await repeat(ctx, 50, async () => {
    const survey = await surveyTasks(ctx.client, ctx.protocol, { config: ctx.config });
    const plan = survey.plan.filter(s => s.kind !== 'orderDaily');
    for (const step of plan) {
      const query = step.kind === 'achievement' ? 'AchievementInfoRequest' : 'MainTaskInfoRequest';
      if (!succeeded(await mutate(ctx, step.request, step.body, query, s => s, { label: step.label }))) return false;
    }
    return plan.length > 0;
  });
  if (options.dailyTask) {
    let state = await ctx.query('DailyTaskInfoRequest');
    for (const task of state.dailyTask ?? []) if (!task.rewardClaimed && task.progress >= task.targetProgress) await ctx.action('DrawDailyTaskRewardRequest', { id: task.id });
    state = await ctx.query('DailyTaskInfoRequest');
    for (const step of planChests(state, ctx.config).actions) await mutate(ctx, step.request, step.body, 'DailyTaskInfoRequest', s => [s.dailyRewardClaimed, s.weeklyRewardClaimed]);
  }
  if (options.email) {
    const emails = await ctx.query('EmailBoxRequest', { pageNo: 0 });
    const emailId = emails.email?.filter(e => !e.got && e.attachment).map(e => idString(e.emailId)) ?? [];
    if (emailId.length) await mutate(ctx, 'QuickGotReadEmailRequest', { emailId, all: true }, 'EmailBoxRequest', s => s.email, { stateBody: { pageNo: 0 } });
  }
  if (options.daily) {
    const cards = await ctx.query('MonthCardRequest');
    for (const card of cards.cardItem ?? []) if (!card.gotDailyReward && card.endTime > ctx.now() / 1000) await mutate(ctx, 'MonthCardDailyRewardRequest', { type: card.type }, 'MonthCardRequest', s => s.cardItem);
    const season = await ctx.query('SeasonCardRequest');
    if (season.isPaid && !season.gotDaily) await mutate(ctx, 'SeasonCardGotDailyRequest', {}, 'SeasonCardRequest', s => s.gotDaily);
    const gift = await ctx.query('DailyGiftPackRequest');
    // 每日精选的免费入口由当前客户端定义为“赠礼”，与充值礼包配置的 packId 无关。
    if (!gift.drawnPack?.includes('赠礼')) await mutate(ctx, 'GotFreeDailyPackRequest', { packId: '赠礼' }, 'DailyGiftPackRequest', s => s.drawnPack);
    const vip = ctx.player.vip;
    for (const row of ctx.rows('VipFreeCfg').filter(r => r.level <= vip?.vipLevel)) {
      // 本连接登录快照可能已过时，日记录阻止同日重复领奖探测。
      if (ctx.count(`vip.${row.level}`) || vip.dailyReward?.find(r => r.vipLevel === row.level)?.isGot) continue;
      const result = await rewardAction(ctx, 'GotVipDailyRewardRequest', { vipLevel: row.level });
      if (result.status === 'success') ctx.count(`vip.${row.level}`, 1);
    }
    const channel = await ctx.query('ChannelRewardInfoRequest');
    for (const reward of channel.rewardInfo ?? []) if (!reward.received) await mutate(ctx, 'GotChannelRewardRequest', { rewardId: reward.rewardId }, 'ChannelRewardInfoRequest', s => s.rewardInfo);
    const comic = (await ctx.query('MainTaskInfoRequest')).comicDrama;
    // 服务端要求先阅读当日漫画才允许领取；仅 gotDaily=false 不能证明领取条件已满足。
    if (comic?.isRead && !comic.gotDaily) await mutate(ctx, 'ComicDramaGotDailyRequest', {}, 'MainTaskInfoRequest', s => s.comicDrama?.gotDaily);
  }
  if (options.weeklyLottery) {
    // 周抽奖活动未开放时会拒绝信息查询，所以必须由独立开关显式授权。
    const lottery = await ctx.query('WeekLotteryInfoRequest');
    const freePack = ctx.rows('WeekLotteryPackCfg').find(r => r.price === 0);
    const requests = [];
    if (freePack && (lottery.gift?.find(g => g.giftId === freePack.packId)?.gotTimes ?? 0) < freePack.limitedTimes) requests.push('WeekLotteryFreePackRequest');
    for (const request of requests) {
      if (ctx.count(`free.${request}`)) continue;
      const result = await rewardAction(ctx, request);
      if (result.status === 'success' || result.status === 'rejected') ctx.count(`free.${request}`, 1);
    }
  }
  if (options.uniqueLottery) {
    // 专属抽奖独立于日奖：用户可以仅领取免费次数，也能完全禁止访问该玩法。
    const unique = await ctx.query('WeekUniqueLotteryRequest');
    if (!unique.gotFree && !ctx.count('free.GotUniqueLotteryFreeRequest')) {
      const result = await rewardAction(ctx, 'GotUniqueLotteryFreeRequest');
      if (result.status === 'success' || result.status === 'rejected') ctx.count('free.GotUniqueLotteryFreeRequest', 1);
    }
  }
  if (options.events) {
    const state = await activities(ctx);
    if (state?.sevenDayLogin && !state.sevenDayLogin.isGot && state.sevenDayLogin.day > 0 && !ctx.count(`newbie.${state.sevenDayLogin.day}`)) {
      const result = await rewardAction(ctx, 'DrawNewbieLoginRewardRequest', { day: state.sevenDayLogin.day });
      if (result.status === 'success') ctx.count(`newbie.${state.sevenDayLogin.day}`, 1);
    }
  }
}
