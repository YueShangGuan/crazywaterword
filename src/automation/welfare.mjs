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

/** 周活动档期由 WeekInfo 下发，只有开放中的行（type：4=周抽奖，7=周翻牌）。 */
async function openWeekRow(ctx, type) {
  const second = ctx.now() / 1000;
  return ((await ctx.query('WeekInfoRequest')).activityTime ?? [])
    .find(row => row.type === type && row.startTime <= second && second < row.endTime) ?? null;
}

/** 福利领取使用服务端已达标状态；周抽奖和专属抽奖均独立于日奖开关。 */
export async function welfare(ctx, options) {
  if (options.growth) await repeat(ctx, 50, async () => {
    const survey = await surveyTasks(ctx.client, ctx.protocol, { config: ctx.config, player: ctx.player });
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
    // 周抽奖按期次排期：档期没开时服务器会直接拒绝信息查询（提示码 74），
    // 与礼包是否已领无关——已领判断在下面 gotTimes 处，只有查询成功才会走到。
    // 未开放保持安静不刷记录；真正的查询拒绝仍要可见，且只能中断本项：
    // 后面的限购零元礼包、皮肤赠礼与本活动无关，不能陪葬。
    let lottery = null;
    try {
      if (await openWeekRow(ctx, 4)) lottery = await ctx.query('WeekLotteryInfoRequest');
    } catch (error) {
      skip(ctx, `周抽奖活动查询被拒绝（${error.message}），跳过本项`, '周抽奖免费礼包');
    }
    if (lottery) {
      const freePack = ctx.rows('WeekLotteryPackCfg').find(r => r.price === 0);
      const requests = [];
      if (freePack && (lottery.gift?.find(g => g.giftId === freePack.packId)?.gotTimes ?? 0) < freePack.limitedTimes) requests.push('WeekLotteryFreePackRequest');
      for (const request of requests) {
        if (ctx.count(`free.${request}`)) continue;
        const result = await rewardAction(ctx, request);
        if (result.status === 'success' || result.status === 'rejected') ctx.count(`free.${request}`, 1);
      }
    }
  }
  if (options.uniqueLottery) {
    // 专属抽奖独立于日奖：用户可以仅领取免费次数，也能完全禁止访问该玩法。
    // 与周抽奖同理：档期未开时查询会被拒绝，先看 WeekInfo，未开放保持安静。
    let unique = null;
    try {
      if (await openWeekRow(ctx, 7)) unique = await ctx.query('WeekUniqueLotteryRequest');
    } catch (error) {
      skip(ctx, `专属抽奖活动查询被拒绝（${error.message}），跳过本项`, '专属抽奖免费次数');
    }
    if (unique && !unique.gotFree && !ctx.count('free.GotUniqueLotteryFreeRequest')) {
      const result = await rewardAction(ctx, 'GotUniqueLotteryFreeRequest');
      if (result.status === 'success' || result.status === 'rejected') ctx.count('free.GotUniqueLotteryFreeRequest', 1);
    }
  }
  if (options.limitedFree) {
    // 限购商城零元日礼包：每日免费档(id 1000)与军备竞赛免费补给(weekDay>0)同一接口；
    // 服务器用 shopItem.gotTimes 记录已领次数，条目缺失代表 gotTimes=0 而不是礼包不存在。
    const packs = ctx.rows('LimitedPackCfg').filter(row => row.type === '日礼包' && row.price === 0 && row.limitedTimes > 0);
    if (packs.length) {
      const shop = await ctx.query('LimitedShopRequest', { type: 1 });
      if (Array.isArray(shop.shopItem)) {
        for (const pack of packs) {
          const got = shop.shopItem.find(item => item.id === pack.id)?.gotTimes ?? 0;
          if (got >= pack.limitedTimes || ctx.count(`free.limited:${pack.id}`)) continue;
          const result = await rewardAction(ctx, 'LimitedShopGotFreeRequest', { type: 1, id: pack.id }, { label: `限购商城 · ${pack.name}${pack.weekDay > 0 ? '（军备竞赛补给）' : ''}` });
          if (result.status === 'success' || result.status === 'rejected') ctx.count(`free.limited:${pack.id}`, 1);
        }
      } else skip(ctx, '限购商城免费礼包状态未同步');
    }
  }
  if (options.skinGift) {
    // 皮肤活动免费赠礼：状态只随 SCAllActivity 推送（gotFree 是服务端已领标记），
    // 协议没有专用回包，与周抽奖一样由库存变化确认；活动窗口外不发送请求。
    const skin = (await activities(ctx))?.skinActive;
    const second = Math.floor(ctx.now() / 1000);
    if (skin?.activeId && skin.startTime <= second && second < skin.endTime && !skin.gotFree && !ctx.count('free.SkinActiveGotFree')) {
      const result = await rewardAction(ctx, 'SkinActiveGotFreeRequest', { activeId: skin.activeId }, { label: '皮肤活动 · 免费赠礼' });
      if (result.status === 'success' || result.status === 'rejected') ctx.count('free.SkinActiveGotFree', 1);
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
