import { amount, idString } from './context.mjs';
import { costs, inWindows, mutate, repeat, skip, succeeded } from './common.mjs';
import { modeActive, serverTime } from './schedule.mjs';

// 服务端以 DAILY_GUILD_AID 同时约束本账号的联盟求助额度；现场已确认每日上限为 20 次。
const DAILY_GUILD_AID_LIMIT = 20;

/** 联盟模块先确认成员身份，未入盟不会发送后续业务请求。 */
export async function guild(ctx, options) {
  const info = await ctx.query('GuildInfoRequest');
  if (!amount(info.guild?.guildId)) return skip(ctx, '角色尚未加入联盟');
  if (options.packs.guild) await claimWelfare(ctx, info.guild?.welfarePack ?? []);
  if (options.packs.title && info.myTitle !== info.gotTitle) await mutate(ctx, 'GotGuildTitleRewardRequest', {}, 'GuildInfoRequest', s => [s.gotTitle, s.gotTitleTime]);
  if (modeActive(options.order.enabled, serverTime(ctx))) await orders(ctx, options.order);
  if (Object.values(options.aid).some(v => v === true)) await aid(ctx, options.aid);
  if (options.tech.enabled) {
    const techs = (await ctx.query('GuildTechInfoRequest')).tech ?? [];
    const candidates = techs.filter(t => !options.tech.items.length || options.tech.items.includes(t.techId)).sort((a, b) => a.level - b.level);
    for (const tech of candidates.slice(0, 12)) {
      const cfg = ctx.rows('GuildTechCfg').find(r => r.techId === tech.techId && r.season === ctx.season);
      if (!cfg) continue;
      const required = cfg.techPointCost + cfg.techPointCostGrowth * tech.level;
      if (!Number.isFinite(required) || !ctx.enough([['公会科技点', required]])) continue;
      await ctx.action('UpgradeGuildTechRequest', { techId: tech.techId }, { expenses: [['公会科技点', required]] });
    }
  }
  if (options.ship.captain || options.ship.crew) await ships(ctx, options.ship);
}

/**
 * 只对自上次领取或拒绝后新出现的联盟福利发包。
 *
 * GuildInfoResponse 在领取后仍会保留历史 welfarePack；重复领取会收到没有文案的
 * PromptResponse(prompt=35)。因此以服务端礼包 ID 组成快照，而不是按本地时间猜测冷却期。
 */
async function claimWelfare(ctx, packs) {
  if (!packs.length) return;
  const snapshot = welfarePackSnapshot(packs);
  if (ctx.memory('guild.welfarePack.snapshot') === snapshot) {
    return skip(ctx, '联盟福利没有新增礼包');
  }
  const result = await ctx.action('GotGuildWelfarePackRequest', {}, {
    // 多个只读/自动化入口可能同时看到同一历史礼包；prompt=35 只说明奖励已被领取，不应继续显示为业务错误。
    onRejected: error => /(?:DUPLICATE_REWARD|prompt=35\b)/.test(error.message)
      ? { status: 'skipped', reason: '联盟福利礼包已被其他领取流程处理' }
      : null,
  });
  // 成功和服务端明确拒绝都证明当前快照已处理；新礼包到达后快照变化会再次尝试。
  if (result.status === 'success' || result.status === 'rejected' || result.reason === '联盟福利礼包已被其他领取流程处理') {
    ctx.memory('guild.welfarePack.snapshot', snapshot);
  }
}

/** 将 int64 礼包 ID 保留为字符串，生成不受 protobuf Long 表示影响的服务端快照。 */
function welfarePackSnapshot(packs) {
  return packs.map(pack => idString(pack.id)).sort().join(',');
}

/** 募兵订单按每日计数、城市筛选、冷却和共享库存决定是否提交。 */
async function orders(ctx, options) {
  const city = (await ctx.query('GuildCityInfoRequest')).cities?.filter(c => !options.cityIds.length || options.cityIds.includes(c.cityId)).sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.defenceNum - b.defenceNum)[0];
  if (!city) return skip(ctx, '没有符合设置的联盟城市');
  await repeat(ctx, 20, async () => {
    if (!modeActive(options.enabled, serverTime(ctx))) return false;
    const counters = (await ctx.query('CounterInfoRequest')).counters ?? [];
    const done = amount(counters.find(c => c.type === 'DAILY_FINISH_GUILD_ORDER')?.num);
    if (options.dailyLimit > 0 && done >= options.dailyLimit) return false;
    const order = (await ctx.query('GuildOrderRequest')).order;
    const expenses = costs(order?.requirements, ctx.protocol);
    if (!expenses.length || order.nextRefreshTime > ctx.now() / 1000 || !ctx.enough(expenses)) return false;
    return succeeded(await ctx.action('FinishGuildOrderRequest', { cityId: city.cityId }, { expenses, allowed: () => modeActive(options.enabled, serverTime(ctx)) }));
  });
}

/** 求助和帮助均逐条执行；不采用批量失败后换单条的隐式降级。 */
async function aid(ctx, options) {
  // 普通联盟互助的协议 type 为 0；这里与参考执行器的 AID_GUILD 一致。
  const type = 0;
  if (options.receive && (await ctx.query('MyGuildAidRequest', { type })).aids?.some(a => a.helper)) await mutate(ctx, 'GotMyGuildAidRequest', { type }, 'MyGuildAidRequest', s => s.aids, { stateBody: { type } });
  if (options.ask) await askAid(ctx, options.askItems, type);
  if (!options.help) return;
  const state = await ctx.query('GuildAidListRequest', { type });
  for (const item of state.askItems ?? []) {
    const counters = (await ctx.query('CounterInfoRequest')).counters ?? [];
    const done = amount(counters.find(c => c.type === 'DAILY_GUILD_AID')?.num);
    if (options.helpDailyLimit > 0 && done >= options.helpDailyLimit) break;
    if (idString(item.asker?.playerId) === ctx.roleId || item.endTime <= ctx.now() / 1000) continue;
    if (options.helpItems.length && !options.helpItems.includes(item.reqItemId)) continue;
    if (options.helpNicknameKeywords.length && !options.helpNicknameKeywords.some(k => item.asker?.nickname?.toLowerCase().includes(k.toLowerCase()))) continue;
    if ((ctx.stock.get(item.reqItemId) ?? 0) <= options.helpMinStock) continue;
    if (!succeeded(await helpAid(ctx, item, type, done))) break;
  }
}

/**
 * 在服务端每日额度内发起联盟求助，并以 OkResponse 确认请求已被接受。
 *
 * GuildAidAskRequest 没有专用业务响应；此前用公开求助列表变更确认会遗漏
 * “自己的新求助不出现在该列表”的正常情形，进而错误留下未确认锁。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {string[]} items 用户选定的求助物品。
 * @param {number} type 联盟互助协议类型。
 * @returns {Promise<void>} 所有可发送物品处理完毕或额度耗尽后返回。
 */
async function askAid(ctx, items, type) {
  const counters = (await ctx.query('CounterInfoRequest')).counters ?? [];
  let used = amount(counters.find(counter => counter.type === 'DAILY_GUILD_AID')?.num);
  if (used >= DAILY_GUILD_AID_LIMIT) {
    return skip(ctx, `每日联盟求助已达上限：DAILY_GUILD_AID=${used}/${DAILY_GUILD_AID_LIMIT}`);
  }
  for (const item of items.slice(0, 8)) {
    if (used >= DAILY_GUILD_AID_LIMIT) {
      skip(ctx, `每日联盟求助已达上限：DAILY_GUILD_AID=${used}/${DAILY_GUILD_AID_LIMIT}`);
      break;
    }
    if (!ctx.rows('ItemCfg').some(row => row.id === item)) {
      skip(ctx, `${item} 不在当前物品表；DAILY_GUILD_AID=${used}/${DAILY_GUILD_AID_LIMIT}`);
      continue;
    }
    const result = await ctx.action('GuildAidAskRequest', { reqItemId: item, type }, {
      // 网关对该静默写入会返回 OkResponse；用同一请求的回包确认，避免依赖不包含本人求助的公开列表。
      response: 'OkResponse',
      label: `发起联盟求助 ${item}（DAILY_GUILD_AID=${used}/${DAILY_GUILD_AID_LIMIT}）`,
    });
    if (!succeeded(result)) break;
    // 当前轮内立即占用已确认的额度，防止计数接口异步刷新时继续越过第 20 次。
    used += 1;
  }
}

/** 确认指定求助已由当前角色帮助，兼容静默写入后计数尚未同步的服务端时序。 */
async function helpAid(ctx, item, type, previousCount) {
  const reqId = idString(item.reqId);
  return ctx.action('GuildAidHelpRequest', { reqId: [reqId], type }, { confirm: async () => {
    const pushed = ctx.pushes.get('SCGuildAidHelp')?.aid;
    // 仅接收 helper 明确是当前角色的推送，避免其他盟友恰好帮助同一条请求造成误确认。
    if (idString(pushed?.reqId) === reqId && idString(pushed?.helper?.playerId) === ctx.roleId) return true;
    const counters = (await ctx.query('CounterInfoRequest')).counters ?? [];
    const currentCount = amount(counters.find(counter => counter.type === 'DAILY_GUILD_AID')?.num);
    if (currentCount > previousCount) return true;
    const currentList = await ctx.query('GuildAidListRequest', { type });
    // 请求列表不再包含该 reqId 说明服务端已消费该条求助；用于计数异步刷新时的业务读回。
    return !(currentList.askItems ?? []).some(aid => idString(aid.reqId) === reqId);
  } });
}

/**
 * 将当前赛季联盟商船的整点补给配置转换为上海时间窗口。
 *
 * 不为缺失或异常的赛季配置猜测兜底时段，避免在服务器未开放补给时提交补货请求。
 *
 * @returns {{ start: string, end: string }[] | null} 当前赛季窗口；配置不完整时为 null。
 */
function guildShipResupplyWindows(ctx) {
  const schedule = ctx.rows('GuildShipParamCfg').find(row => row.season === ctx.season);
  const duration = Number(schedule?.duration);
  if (!Array.isArray(schedule?.time) || !Number.isInteger(duration) || duration <= 0 || !schedule.time.every(hour => Number.isInteger(Number(hour)) && Number(hour) >= 0 && Number(hour) < 24)) return null;
  return schedule.time.map(hour => {
    const startMinute = Number(hour) * 60;
    const endMinute = (startMinute + duration) % (24 * 60);
    const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    return { start: clock(startMinute), end: clock(endMinute) };
  });
}

/** 记录联盟商船赛季配置的实际匹配结果，便于发现错误赛季编号或服务端表变更。 */
function logGuildShipSeasonConfig(ctx, windows) {
  const rows = ctx.rows('GuildShipParamCfg');
  const availableSeasons = [...new Set(rows.map(row => Number(row.season)).filter(Number.isInteger))].sort((a, b) => a - b);
  const configuredSeason = Number(ctx.season);
  const availableText = availableSeasons.length ? availableSeasons.join(',') : '无';
  const schedule = rows.find(row => Number(row.season) === configuredSeason);
  if (!schedule) {
    ctx.record({ label: '赛季配置检查', status: 'error', reason: `设置赛季 ${ctx.season}；可用赛季 ${availableText}；未匹配 GuildShipParamCfg` });
    return;
  }
  if (!windows) {
    ctx.record({ label: '赛季配置检查', status: 'error', reason: `设置赛季 ${ctx.season}；已匹配赛季配置，但 time/duration 无效` });
    return;
  }
  const windowText = windows.map(window => `${window.start}-${window.end}`).join(',');
  ctx.record({ label: '赛季配置检查', status: 'success', reason: `设置赛季 ${ctx.season}；可用赛季 ${availableText}；补给窗口 ${windowText}` });
}

/** 商船仅在当前赛季补给窗口且补给未过期时，按用户筛选补货或应聘船长。 */
async function ships(ctx, options) {
  const windows = guildShipResupplyWindows(ctx);
  logGuildShipSeasonConfig(ctx, windows);
  if (!windows) return skip(ctx, `缺少赛季 ${ctx.season} 的联盟商船补给配置`);
  if (!inWindows(windows, ctx.now())) return skip(ctx, '不在联盟商船补给时段');
  const state = await ctx.query('GuildShipRequest');
  const owned = new Set(state.ownRun?.map(s => s.shipId));
  // preparedEndTime 是服务端给出的本轮补给截止时间；缺失或过期都不冒险发送补货请求。
  let candidates = (state.ship ?? []).filter(s => s.state === ctx.protocol.GuildShipState.GS_STATE_PREPARED && s.preparedEndTime > ctx.now() / 1000 && !owned.has(s.shipId));
  if (!candidates.length) return skip(ctx, '当前没有未过期的联盟商船补给位');
  /** 过滤基于当前配置中的船型品质和服务端奖励，不猜测别名映射。 */
  const matches = ship => {
    const cfg = ctx.rows('GuildShipCfg').find(r => r.shipId === ship.type);
    const reward = costs(ship.reward?.asset, ctx.protocol);
    return (!options.qualities.length || options.qualities.includes(cfg?.quality)) && (!options.rewardItems.length || reward.some(([id]) => options.rewardItems.includes(id))) && (!options.minWaterCoin || reward.some(([id, n]) => id === '水姆币' && n >= options.minWaterCoin));
  };
  if (!options.relaxFilters) candidates = candidates.filter(matches);
  else candidates.sort((a, b) => Number(matches(b)) - Number(matches(a)));
  const heroes = (await ctx.query('AllHeroRequest')).heroes ?? [];
  for (const ship of candidates.slice(0, 6)) {
    let filled = false;
    if (options.crew) for (const cabin of ship.cabin ?? []) {
      if (amount(cabin.player?.playerId)) continue;
      const expenses = costs(cabin.order, ctx.protocol);
      if (expenses.some(([id]) => options.forbiddenMaterials.includes(id)) || !ctx.enough(expenses)) continue;
      const result = await mutate(ctx, 'GuildShipOrderRequest', { shipId: ship.shipId, crewId: cabin.crewId }, 'GuildShipRequest', s => [s.ownRun, s.ship], { expenses });
      if (!succeeded(result)) return;
      filled = true; break;
    }
    if (!filled && options.captain && !amount(ship.leader?.playerId)) {
      const qualifies = ship.leaderCond?.every(cond => heroes.some(h => h.heroId === cond.heroId && h.star >= cond.star && (h.exclusive?.star ?? 0) >= cond.exStar));
      if (qualifies) if (!succeeded(await mutate(ctx, 'GuildShipSeekRequest', { shipId: ship.shipId }, 'GuildShipRequest', s => [s.ownRun, s.ship]))) return;
    }
  }
}
