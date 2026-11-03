import { amount, idString } from './context.mjs';
import { costs, idleFleets, inWindows, mutate, repeat, rewardAction, skip, succeeded } from './common.mjs';
import { claimPass } from './battle.mjs';

const SPEED_UP_RUBY_TYPE = 1;
const SPEED_UP_ITEM_TYPE = 2;
const REPAIR_RUBY_PER_MINUTE = 10;
const SPEED_UP_FLEET_RUBY_COST = 30;
const REPAIR_SPEED_UP_ITEM_FAILURE_LIMIT = 3;
// 海商王服务端仅在上海时间 10:00 至 21:59 接受交易及相关操作。
const TRADE_EXECUTION_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

// 累计失败后不再重复尝试加速器；钻石路径仍须逐舰队计价并通过消费护栏。
const repairSpeedUpFallback = { itemFailures: 0, skipItem: false };

/**
 * 清空维修加速的进程级回退状态，供测试或明确重置运行环境时使用。
 *
 * @returns {void}
 */
export function resetRepairSpeedUpFallbackState() {
  repairSpeedUpFallback.itemFailures = 0;
  repairSpeedUpFallback.skipItem = false;
}

/**
 * 记录加速器失败次数；达到阈值后不再尝试加速器，改走受预算保护的钻石路径。
 *
 * @returns {{itemFailures: number, skipItem: boolean}} 当前道具失败保护状态。
 */
function noteRepairSpeedUpItemFailure() {
  repairSpeedUpFallback.itemFailures += 1;
  if (repairSpeedUpFallback.itemFailures >= REPAIR_SPEED_UP_ITEM_FAILURE_LIMIT) repairSpeedUpFallback.skipItem = true;
  return { ...repairSpeedUpFallback };
}

/**
 * 将加速请求的最终状态转成一条不带请求体的可读日志，避免重复计入已发送请求。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {string} label 日志标签。
 * @param {object} result 加速请求结果。
 * @param {string} successReason 已确认成功时的摘要。
 * @returns {object} 写入上下文的日志结果。
 */
function logSpeedUpResult(ctx, label, result, successReason) {
  const reason = result.status === 'success'
    ? successReason
    : result.status === 'planned'
      ? '已生成预览计划，未发送真实请求'
      : result.reason ?? `请求结果为 ${result.status}`;
  return ctx.record({ label, status: result.status, ...(reason ? { reason } : {}) });
}

/**
 * 刷新维修快照，按同步后的服务器时间与整分钟规则预留费用，再提交钻石加速。
 *
 * @param {object} ctx 当前自动化上下文。
 * @param {object} fleet 待加速的维修舰队，仅以 buildingId 定位最新状态。
 * @param {number} minRemainSecs 允许加速的最短剩余秒数。
 * @returns {Promise<object>} 受完整费用护栏约束的钻石加速结果。
 */
async function speedUpRepairWithRuby(ctx, fleet, minRemainSecs) {
  // 前一支舰队或道具尝试可能耗时，不能用进入模块时的旧列表给当前请求定价。
  const current = (await ctx.query('MyFleetsRequest')).fleets?.find(row => row.buildingId === fleet.buildingId);
  // 结束时间属于服务器时钟；扣除客户端已同步的时差，避免本机时钟偏快导致少预留一档。
  const remainingSecs = Number(current?.repairing?.endTs) - (ctx.now() + ctx.client.serverClockOffsetMs) / 1000;
  if (current?.state !== ctx.protocol.FleetState.REPAIRING || !Number.isFinite(remainingSecs)) {
    return skip(ctx, '缺少有效维修状态或结束时间，无法计算钻石费用', `维修加速结果 ${fleet.buildingId}`);
  }
  if (remainingSecs <= 0) return skip(ctx, '维修已结束，无需钻石加速', `维修加速结果 ${fleet.buildingId}`);
  // 刷新期间可能已进入不值得加速的短尾段，不能仅按旧列表的门槛结果继续扣钻。
  if (remainingSecs < minRemainSecs) return skip(ctx, `剩余 ${Math.floor(remainingSecs)} 秒，低于门槛 ${minRemainSecs} 秒`, `维修加速结果 ${fleet.buildingId}`);

  // 先向上取整分钟数，再乘每分钟 10 钻：60 秒为 10 钻，61 秒为 20 钻。
  const minutes = Math.ceil(remainingSecs / 60);
  const ruby = minutes * REPAIR_RUBY_PER_MINUTE;
  ctx.record({ label: `维修加速计价 ${fleet.buildingId}`, status: ctx.dryRun ? 'planned' : 'success', reason: `剩余 ${Math.ceil(remainingSecs)} 秒，按 ${minutes} 分钟计费，共 ${ruby} 钻石` });
  const before = JSON.stringify(current);
  // 计价和成功确认共用这份快照；请求保持 useNum=0，由服务端动态扣费，本地先预留全额。
  const result = await ctx.action('SpeedUpRepairRequest', { buildingId: fleet.buildingId, speedUp: { type: SPEED_UP_RUBY_TYPE, useNum: 0 } }, {
    expenses: [['RUBY', ruby]],
    label: `钻石维修加速 ${fleet.buildingId}`,
    confirm: async () => JSON.stringify((await ctx.query('MyFleetsRequest')).fleets?.find(row => row.buildingId === fleet.buildingId)) !== before,
  });
  logSpeedUpResult(ctx, `维修加速结果 ${fleet.buildingId}`, result, '已确认维修结束时间更新（钻石）');
  return result;
}

/**
 * 优先使用现有加速器维修舰队，无道具或道具明确失败后按整分钟计价使用钻石。
 *
 * @param {object} ctx 当前自动化上下文。
 * @param {object} fleet 待加速的维修舰队。
 * @param {number} minRemainSecs 允许加速的最短剩余秒数。
 * @returns {Promise<object>} 加速器结果或受完整费用护栏保护的钻石结果。
 */
async function speedUpRepair(ctx, fleet, minRemainSecs) {
  const item = { buildingId: fleet.buildingId, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum: 1 } };
  // 预览模式只登记计划，真实运行才把路径选择记为已执行。
  const decisionStatus = ctx.dryRun ? 'planned' : 'success';

  // 无道具或道具路径已停用时直接进入统一计价入口，不能跳过预算检查。
  if (repairSpeedUpFallback.skipItem || (ctx.stock.get('加速器') ?? 0) <= 0) {
    const reason = repairSpeedUpFallback.skipItem
      ? `加速器累计失败 ${repairSpeedUpFallback.itemFailures}/${REPAIR_SPEED_UP_ITEM_FAILURE_LIMIT}，已停用道具路径，改用钻石`
      : '加速器库存为 0，改用钻石';
    ctx.record({ label: `维修加速路径 ${fleet.buildingId}`, status: decisionStatus, reason });
    return speedUpRepairWithRuby(ctx, fleet, minRemainSecs);
  }

  ctx.record({ label: `维修加速路径 ${fleet.buildingId}`, status: decisionStatus, reason: `使用加速器，当前库存 ${ctx.stock.get('加速器') ?? 0}` });
  const itemResult = await mutate(ctx, 'SpeedUpRepairRequest', item, 'MyFleetsRequest', s => s.fleets?.find(f => f.buildingId === fleet.buildingId), {
    expenses: [['加速器', 1]],
    label: `加速器维修加速 ${fleet.buildingId}`,
  });
  if (!['rejected', 'failed'].includes(itemResult.status)) {
    logSpeedUpResult(ctx, `维修加速结果 ${fleet.buildingId}`, itemResult, '已确认维修结束时间更新（加速器）');
    return itemResult;
  }

  const fallback = noteRepairSpeedUpItemFailure();
  // 只有明确拒绝或业务失败才可更换费用类型；未确认写入仍由上面的分支直接返回。
  ctx.record({
    label: `维修加速回退 ${fleet.buildingId}`,
    status: decisionStatus,
    reason: `加速器${itemResult.status === 'rejected' ? '被服务器拒绝' : '业务失败'}；累计失败 ${fallback.itemFailures}/${REPAIR_SPEED_UP_ITEM_FAILURE_LIMIT}${fallback.skipItem ? '，后续不再尝试加速器' : ''}`,
  });
  return speedUpRepairWithRuby(ctx, fleet, minRemainSecs);
}

/**
 * 按客户端协议提交一次钻石行军加速，并用舰队快照确认行军结束时间发生变化。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {object} fleet 已确认正在行军的舰队。
 * @returns {Promise<object>} 网关回包或状态读回结果。
 */
async function speedUpFleet(ctx, fleet) {
  // 行军请求只携带 buildingId；钻石消耗通过资源预算和抓包确认的 30 钻统一记账。
  return mutate(ctx, 'SpeedUpFleetRequest', { buildingId: fleet.buildingId }, 'MyFleetsRequest',
    state => state.fleets?.find(row => row.buildingId === fleet.buildingId), {
      expenses: [['RUBY', SPEED_UP_FLEET_RUBY_COST]],
      label: `钻石行军加速 ${fleet.buildingId}`,
    });
}

/** 每个派遣前刷新舰队；未确认派遣会锁定后续动作，避免跨玩法占用同船。 */
async function dispatch(ctx, request, body, fleets, options = {}) {
  const ids = fleets.map(f => f.buildingId);
  return mutate(ctx, request, body, 'MyFleetsRequest', s => s.fleets?.filter(f => ids.includes(f.buildingId)), options);
}

/** 上海小时列表由账号设置决定，不依赖运行电脑时区。 */
function hourAllowed(ctx, hours) {
  return !hours.length || hours.includes(Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(ctx.now())));
}

/** 世界玩法逐项查询最新舰队，任何派遣的不确定结果均停止本模块。 */
export async function world(ctx, options) {
  if (options.report) {
    const reports = await ctx.query('CampaignReportsRequest', { pageNo: 0 });
    const campaignId = reports.reports?.filter(r => !r.received && r.rewards).map(r => idString(r.uid)) ?? [];
    if (campaignId.length) await mutate(ctx, 'QuickGotCampaignReportRequest', { campaignId, all: true }, 'CampaignReportsRequest', s => s.reports?.map(r => [idString(r.uid), r.received]), { stateBody: { pageNo: 0 } });
  }
  // 万吨货轮在整点出现且由用户指定舰队抢占；必须早于维修等会改变舰队状态的操作。
  if (options.merchantShip.enabled) await merchantShip(ctx, options.merchantShip);
  // 维修加速只针对城战中已明确指定的舰队，避免同一开关意外消耗其他舰队的加速资源。
  const cityWarRepairFleetIds = new Set(options.cityWar.fleets.filter(rule => rule.enabled && rule.buildingId).map(rule => rule.buildingId));
  if (options.fleet.repair || options.fleet.repairSpeedUp) {
    const state = await ctx.query('MyFleetsRequest');
    if (options.fleet.repairSpeedUp && cityWarRepairFleetIds.size === 0) {
      ctx.record({ label: '维修加速检查', status: 'skipped', reason: '未配置启用的城战维修加速舰队' });
    }
    for (const [index, fleet] of (state.fleets ?? []).entries()) {
      const threshold = options.fleet.repairThresholds[index];
      if (options.fleet.repair && threshold > 0 && fleet.state === ctx.protocol.FleetState.IDLE && fleet.durability < threshold && fleet.durability < fleet.maxDura) await dispatch(ctx, 'RepairFleetRequest', { buildingId: fleet.buildingId }, [fleet]);
      if (options.fleet.repairSpeedUp && cityWarRepairFleetIds.has(fleet.buildingId)) {
        // 门槛检查和钻石计价使用同一服务器时钟，避免时差导致误跳过或低估剩余分钟。
        const remaining = Number(fleet.repairing?.endTs) - (ctx.now() + ctx.client.serverClockOffsetMs) / 1000;
        const minRemainSecs = Number(options.fleet.repairSpeedUpMinRemainSecs);
        if (fleet.state !== ctx.protocol.FleetState.REPAIRING) {
          ctx.record({ label: `维修加速检查 ${fleet.buildingId}`, status: 'skipped', reason: `当前状态 ${fleet.state ?? '未知'}，未确认正在维修` });
        } else if (!Number.isFinite(remaining)) {
          ctx.record({ label: `维修加速检查 ${fleet.buildingId}`, status: 'skipped', reason: '缺少有效维修结束时间，无法确认剩余时长' });
        } else if (!Number.isFinite(minRemainSecs)) {
          ctx.record({ label: `维修加速检查 ${fleet.buildingId}`, status: 'skipped', reason: '维修加速门槛配置无效，未提交请求' });
        } else if (remaining < minRemainSecs) {
          ctx.record({ label: `维修加速检查 ${fleet.buildingId}`, status: 'skipped', reason: `剩余 ${Math.max(0, Math.floor(remaining))} 秒，低于门槛 ${minRemainSecs} 秒` });
        } else {
          ctx.record({ label: `维修加速检查 ${fleet.buildingId}`, status: ctx.dryRun ? 'planned' : 'success', reason: `剩余 ${Math.floor(remaining)} 秒，达到门槛 ${minRemainSecs} 秒，准备加速` });
          await speedUpRepair(ctx, fleet, minRemainSecs);
        }
      }
    }
  }
  if (options.pirate.attack || options.pirate.sweep) await pirates(ctx, options.pirate);
  if (options.radar.enabled) await radar(ctx, options.radar);
  if (options.resField.enabled) await fields(ctx, options.resField);
  if (options.chipMine.enabled) await chipMine(ctx, options.chipMine);
  if (options.treasureLoot.enabled) await treasure(ctx, options.treasureLoot);
  if (options.cityWar.enabled) await cityWar(ctx, options.cityWar);
  if (options.worldBoss.enabled) {
    const state = (await ctx.query('WorldBossInfoRequest')).info;
    if (state) {
      const ready = ctx.rows('WorldBossDamageRewardCfg').some(r => r.season === ctx.season && r.bossId === state.bossId && r.level > state.gotRewardLevel && r.damage <= amount(state.bestDamage));
      if (ready) await mutate(ctx, 'WorldBossGetDamageRewardRequest', {}, 'WorldBossInfoRequest', s => s.info?.gotRewardLevel);
      await repeat(ctx, options.worldBoss.attackTimes, async () => {
        if (ctx.count('worldBoss.attack') >= options.worldBoss.attackTimes) return false;
        const fleets = (await idleFleets(ctx)).slice(0, 1);
        if (!fleets.length) return false;
        const result = await dispatch(ctx, 'ChallengeWorldBossRequest', { bossId: state.bossId, fleetBuildingIds: fleets.map(f => f.buildingId) }, fleets);
        if (result.status === 'success') ctx.count('worldBoss.attack', 1);
        return succeeded(result);
      });
    }
  }
  if (options.limitedBoss.enabled) {
    const open = await ctx.query('LimitedBossOpenRequest');
    const state = (await ctx.query('LimitedBossInfoRequest')).bossInfo;
    const rewardReady = ctx.rows('LimitedBossChallengeRewardCfg').some(r => r.season === ctx.season && r.challengeTimes > (open.rewardInfo?.myGotRewardLevel ?? 0) && r.challengeTimes <= open.rewardInfo?.myTroopsNum);
    if (options.limitedBoss.challengeReward && rewardReady) await mutate(ctx, 'LimitedBossGetRewardRequest', {}, 'LimitedBossOpenRequest', s => s.rewardInfo);
    const now = ctx.now() / 1000;
    if (state && open.activityStartTs <= now && open.activityEndTs > now && state.todayStartTs <= now && state.todayEndTs > now && amount(state.leftHp) > 0) {
      const fleets = (await idleFleets(ctx)).filter(f => options.limitedBoss.fleets.some(rule => rule.enabled && rule.buildingId === f.buildingId));
      if (fleets.length) await dispatch(ctx, 'LimitedBossSendFleetsRequest', { fleetBuildingIds: fleets.map(f => f.buildingId) }, fleets);
    } else skip(ctx, '限时 Boss 当前不可挑战');
  }
  if (options.trade.enabled) await trade(ctx, options.trade);
}

const TEN_THOUSAND_TON_SHIP_COLOR = 5;
// 城战在线奖只在服务器常规城战窗口领取；20:59 为最后一个允许分钟，避免 21:00 后发起无效请求。
const CITY_WAR_EXECUTION_WINDOW = [{ start: '20:00', end: '20:59' }];

/**
 * Returns the current Shanghai hour key and minute so the ship event follows the
 * game schedule instead of the computer's local timezone.
 *
 * @param {import('./context.mjs').AutomationContext} ctx Current execution context.
 * @returns {{key: string, minute: number}} Shanghai hour identity and minute.
 */
function merchantShipPeriod(ctx) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(ctx.now()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`, minute: Number(parts.minute) };
}

/**
 * Schedules the next retry only within the current Shanghai hour. The retained
 * schedule survives loop restarts, which prevents duplicate dispatches during
 * the opening minute and preserves AutoJs's configurable recapture interval.
 *
 * @param {import('./context.mjs').AutomationContext} ctx Current execution context.
 * @param {{key: string, retryMinutes: number}} attempt Attempt identity and interval.
 */
function scheduleMerchantShipRetry(ctx, { key, retryMinutes }) {
  if (ctx.dryRun) return;
  const now = ctx.now();
  const retryAt = retryMinutes > 0 ? now + retryMinutes * 60_000 : 0;
  // China has no daylight-saving change; epoch hour boundaries remain Shanghai hour boundaries.
  const hourEndsAt = Math.floor(now / 3_600_000 + 1) * 3_600_000;
  ctx.memory('merchantShip.schedule', { key, retryAt: retryAt < hourEndsAt ? retryAt : 0 });
}

/**
 * Sends the configured expedition ships to the currently listed 万吨货轮.
 * Capture 20261029-180249 proves this UI event is TreasureLoot color 5 and is
 * dispatched through TreasureLootSendFleetsRequest, not a separate merchant API.
 *
 * @param {import('./context.mjs').AutomationContext} ctx Current execution context.
 * @param {{retryMinutes: number, fleets: Array<{enabled: boolean, buildingId: string}>}} options Saved account settings.
 */
async function merchantShip(ctx, options) {
  // 城战和万吨货轮都会占用远征船；城战窗口内保留全部闲置舰队给联盟行动。
  if (inWindows(CITY_WAR_EXECUTION_WINDOW, ctx.now())) return skip(ctx, '城战时段保留舰队，不派遣万吨货轮');
  const period = merchantShipPeriod(ctx);
  const saved = ctx.memory('merchantShip.schedule');
  const dueAtHourStart = saved?.key !== period.key && period.minute === 0;
  const dueForRetry = saved?.key === period.key && saved.retryAt > 0 && ctx.now() >= saved.retryAt;
  if (!dueAtHourStart && !dueForRetry) return;

  const selected = options.fleets.filter(rule => rule.enabled && rule.buildingId);
  if (!selected.length) {
    skip(ctx, '搁浅商船未配置出征舰队');
    scheduleMerchantShipRetry(ctx, { key: period.key, retryMinutes: options.retryMinutes });
    return;
  }
  const state = await ctx.query('TreasureLootListRequest');
  const target = state.treasure?.find(ship => ship.color === TEN_THOUSAND_TON_SHIP_COLOR);
  if (!target) {
    skip(ctx, '本时段未发现万吨货轮');
    scheduleMerchantShipRetry(ctx, { key: period.key, retryMinutes: options.retryMinutes });
    return;
  }
  for (const rule of selected) {
    const fleet = (await idleFleets(ctx)).find(row => row.buildingId === rule.buildingId);
    if (!fleet) continue;
    const result = await dispatch(ctx, 'TreasureLootSendFleetsRequest', { uid: target.uid, fleetBuildingIds: [fleet.buildingId] }, [fleet]);
    if (!succeeded(result)) {
      scheduleMerchantShipRetry(ctx, { key: period.key, retryMinutes: options.retryMinutes });
      return;
    }
  }
  scheduleMerchantShipRetry(ctx, { key: period.key, retryMinutes: options.retryMinutes });
}

/**
 * 海盗挑战只选已解锁最高一档，扫荡只选已有击败记录且服务端明确给出剩余次数的目标。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 自动化执行上下文。
 * @param {object} options 当前账号的海盗自动化设置。
 * @returns {Promise<void>}
 */
async function pirates(ctx, options) {
  if (!inWindows([options.attackTime], ctx.now())) return skip(ctx, '不在海盗执行时段');
  const records = (await ctx.query('PirateKillRecordRequest')).records ?? [];
  const state = await ctx.query('AllPirateRequest');
  const reportedSweepTimes = state.sweepTimes;
  // 扫荡次数是服务端实时限额。字段缺失时不能把默认值猜成可扫荡，避免重复触发拒绝。
  if (options.sweep && (!Object.hasOwn(state, 'sweepTimes') || !Number.isInteger(reportedSweepTimes))) {
    skip(ctx, '服务端未返回海盗可扫荡次数，已记录并跳过扫荡');
    return;
  }
  let remainingSweepTimes = reportedSweepTimes;
  for (const type of new Set([...options.attackTypes, ...options.sweepTypes])) {
    const killed = records.find(r => r.type === type)?.maxKilledLevel;
    if (killed === undefined) { skip(ctx, `海盗类型 ${type} 缺少击败记录`); continue; }
    const targets = (state.pirates ?? []).filter(p => p.type === type);
    if (options.attack && options.attackTypes.includes(type)) {
      const target = targets.filter(p => p.level <= killed + 1).sort((a, b) => b.level - a.level)[0];
      const fleets = await idleFleets(ctx);
      if (target && fleets.length) if (!succeeded(await dispatch(ctx, 'ChallengePirateRequest', { uid: target.uid, cityId: target.cityId, fleetBuildingIds: fleets.map(f => f.buildingId) }, fleets))) return;
    }
    if (options.sweep && options.sweepTypes.includes(type)) {
      // 同一轮可配置多个海盗类型；次数耗尽后不能再向后续类型继续发扫荡请求。
      if (remainingSweepTimes <= 0) {
        skip(ctx, '海盗可扫荡次数不足，停止本轮扫荡');
        return;
      }
      const target = targets.filter(p => p.level <= killed).sort((a, b) => b.level - a.level)[0];
      if (target) {
        const result = await mutate(ctx, 'PirateSweepRequest', { uid: target.uid, cityId: target.cityId }, 'AllPirateRequest', s => s.sweepTimes);
        // 成功回读才消耗本轮配额；被拒绝或状态未确认时立即停止，不能尝试其他类型。
        if (!succeeded(result)) return;
        remainingSweepTimes -= 1;
      }
    }
  }
}

/** 雷达只领取已完成条目，派遣仅处理所选类型的初始事件。 */
async function radar(ctx, options) {
  let state = (await ctx.query('RadarInfoRequest')).radarInfo;
  if (!state) return skip(ctx, '雷达尚未开放');
  const eventKind = e => ctx.rows('RadarRandEventCfg').find(r => r.eventId === e.eventId)?.type;
  if (options.claim) for (const event of state.events ?? []) if (event.state === ctx.protocol.RadarEventState.RADAR_EVENT_FINISHED && options.kinds.includes(eventKind(event))) await mutate(ctx, 'RadarGetRewardRequest', { uid: idString(event.uid) }, 'RadarInfoRequest', s => s.radarInfo?.events);
  state = (await ctx.query('RadarInfoRequest')).radarInfo;
  const events = (state.events ?? []).filter(e => options.kinds.includes(eventKind(e)));
  if (options.fixed && state.fixedEvent) events.push({ ...state.fixedEvent, uid: '0' });
  for (const event of events) {
    if (event.state !== ctx.protocol.RadarEventState.RADAR_EVENT_INIT) continue;
    const fleets = (await idleFleets(ctx)).slice(0, 1);
    if (!fleets.length) break;
    const materials = radarMaterials(ctx, event);
    if (!materials.ok) {
      skip(ctx, `雷达事件 ${event.eventId}（${eventKind(event) ?? '未知类型'}）${materials.reason}`);
      continue;
    }
    const materialLog = materials.expenses.length ? `；物资 ${formatRadarMaterials(ctx, materials.expenses)}` : '；无协议物资消耗';
    const result = await dispatch(ctx, 'RadarSendFleetsRequest', { uid: idString(event.uid), fleetBuildingIds: fleets.map(f => f.buildingId) }, fleets, {
      expenses: materials.expenses,
      label: `雷达派遣 ${event.eventId}（${eventKind(event) ?? '未知类型'}）${materialLog}`,
    });
    if (!succeeded(result)) break;
  }
}

/**
 * 将雷达“解救难民”事件随状态下发的物资清单转换为库存预检费用。
 *
 * 雷达静态表只描述事件类型；实际材料位于 RadarEvent.refugee.requirements。
 * 清单缺失或无法换算时不发送派遣，避免再次依赖服务器的 product not enough 才发现缺料。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {object} event 当前雷达事件。
 * @returns {{ ok: boolean, expenses?: Array<[string, number]>, reason?: string }} 可派遣的消耗或跳过原因。
 */
function radarMaterials(ctx, event) {
  // 仅难民事件协议定义 requirements；海盗、资源采集和固定事件不携带材料清单。
  if (!event.refugee) return { ok: true, expenses: [] };
  const requirements = event.refugee.requirements;
  // 先验证服务端字段形状，再转换资产；缺失/异常字段必须产生日志并安全跳过，而不是让转换异常中断自动化。
  if (!Array.isArray(requirements) || !requirements.length) return { ok: false, reason: '未下发物资清单，已跳过派遣' };
  const expenses = costs(requirements, ctx.protocol);
  if (expenses.length !== requirements.length || !expenses.every(([item, count]) => item && Number.isFinite(count) && count > 0)) {
    return { ok: false, reason: `物资清单无法解析：${JSON.stringify(requirements)}` };
  }
  if (!ctx.enough(expenses)) return { ok: false, reason: `物资不足：${formatRadarMaterials(ctx, expenses)}` };
  return { ok: true, expenses };
}

/**
 * 输出雷达物资的需求与当前库存，作为派遣前检查和跳过记录的诊断信息。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {Array<[string, number]>} expenses 已换算的物资需求。
 * @returns {string} 便于操作日志直接定位缺料项的文本。
 */
function formatRadarMaterials(ctx, expenses) {
  return expenses.map(([item, count]) => `${item} ${ctx.stock.get(item) ?? 0}/${count}`).join('，');
}

/** 按实际资源田类型分配权重，未知类型保留并报告，避免错误放弃。 */
async function fields(ctx, options) {
  const info = (await ctx.query('MyResFieldsRequest')).info;
  if (!info?.maxNum) return skip(ctx, '没有已开放资源田容量');
  const types = new Map();
  for (const row of ctx.rows('ResFieldTypeCfg').filter(r => r.season === ctx.season)) {
    const product = row.product?.[0];
    if (product === '公会科技点') types.set(row.type, options.factory);
    if (product === '种子') types.set(row.type, options.oasis);
    if (product === '汽油') types.set(row.type, options.tank);
  }
  if (types.size !== 3) return skip(ctx, '当前资源田类型配置不完整');
  const total = [...types.values()].reduce((s, v) => s + v, 0);
  const targets = new Map([...types].map(([t, w]) => [t, total > 0 ? Math.round(info.maxNum * w / total) : 0]));
  while ([...targets.values()].reduce((s, n) => s + n, 0) > info.maxNum) for (const type of [...targets.keys()].reverse()) if (targets.get(type) > 0) { targets.set(type, targets.get(type) - 1); break; }
  for (const [type, target] of targets) {
    const owned = (info.fields ?? []).filter(f => f.type === type);
    for (const field of owned.slice(target)) await mutate(ctx, 'GiveUpResFieldRequest', { resFieldGridIdx: field.gridIdx }, 'MyResFieldsRequest', s => s.info?.fields);
  }
}

/** 硅矿按用户配置品质挑选空位，次数同时受服务器与本地每日上限约束。 */
async function chipMine(ctx, options) {
  if (!hourAllowed(ctx, options.hours)) return;
  const reward = await ctx.action('ChipMineRewardRequest');
  if (options.dailyCap > 0 && amount(reward.value?.rewardInfo?.myRewardTimes) >= options.dailyCap) return;
  for (const rule of options.fleets.filter(f => f.enabled)) {
    const fleets = (await idleFleets(ctx)).filter(f => !rule.buildingId || rule.buildingId === f.buildingId).slice(0, 1);
    if (!fleets.length || (options.dailyCap > 0 && ctx.count('chipMine.dispatch') >= options.dailyCap)) break;
    const mines = (await ctx.query('ChipMineListRequest')).chipMines ?? [];
    const mine = mines.filter(m => m.color === rule.levels && m.occupiedNum < m.positionNum && (!rule.emptyOnly || m.occupiedNum === 0)).sort((a, b) => a.occupiedNum - b.occupiedNum)[0];
    if (!mine) continue;
    const detail = await ctx.query('ChipMineRequest', { gridId: mine.gridId });
    if (detail.fightTimes >= detail.maxFightTimes) continue;
    const index = Array.from({ length: detail.positionNum }, (_, i) => i).find(i => !detail.occupiedPositions?.some(p => p.index === i));
    if (index === undefined) continue;
    const result = await dispatch(ctx, 'ChipMineSendFleetRequest', { gridId: mine.gridId, index, fleetId: fleets[0].buildingId }, fleets);
    if (result.status === 'success') ctx.count('chipMine.dispatch', 1);
    if (!succeeded(result)) break;
  }
}

/** 宝藏掠夺保留品质、归属和舰队偏好，服务端状态刷新后再派下一队。 */
async function treasure(ctx, options) {
  if (!hourAllowed(ctx, options.hours)) return;
  // 当前协议只有索引列表，没有声明其偏移；从本角色贸易船的世界条目读取联盟索引。
  const ownCargo = (await ctx.query('TradeInfoRequest')).worldCargo?.find(c => idString(c.playerId) === ctx.roleId);
  const mine = ownCargo?.guildIdx;
  const used = new Set();
  for (const rule of options.fleets.filter(f => f.enabled)) {
    const fleets = (await idleFleets(ctx)).filter(f => !rule.buildingId || f.buildingId === rule.buildingId).slice(0, 1);
    if (!fleets.length) break;
    const state = await ctx.query('TreasureLootListRequest');
    if (mine === undefined && !rule.helpAlly && !rule.emptyOnly) { skip(ctx, '无法确认己方联盟索引，跳过非空宝藏掠夺'); continue; }
    const target = state.treasure?.find(t => t.color === rule.levels && !used.has(t.uid) && (!rule.emptyOnly || (t.ownerFleetNum === 0 && t.ownerGuildIdx === 0)) && (rule.helpAlly || t.ownerGuildIdx !== mine));
    if (target) {
      const result = await dispatch(ctx, 'TreasureLootSendFleetsRequest', { uid: target.uid, fleetBuildingIds: fleets.map(f => f.buildingId) }, fleets);
      if (!succeeded(result)) break;
      used.add(target.uid);
    }
  }
}

/** 城战仅在上海时间 20:00–21:00 且服务器确认开放后执行，城市记录按角色业务日隔离。 */
async function cityWar(ctx, options) {
  if (!inWindows(CITY_WAR_EXECUTION_WINDOW, ctx.now())) return skip(ctx, '不在城战执行时段（上海时间 20:00–21:00）');
  // 先以服务端宣战状态二次确认，防止活动临时调整时在线奖请求被拒绝。
  const war = await ctx.query('WarDeclarationRequest');
  if (!(war.startTime <= ctx.now() / 1000 && war.endTime > ctx.now() / 1000)) return skip(ctx, '不在城战时段');
  if (options.online && !ctx.count('cityWar.online')) {
    const result = await rewardAction(ctx, 'GotWorldOnlineRwdRequest');
    if (result.status === 'success' || result.status === 'rejected') ctx.count('cityWar.online', 1);
  }
  if (war.assembleCityId && ctx.pushes.get('SCAssembleCity')?.cityId !== war.assembleCityId && options.fleets.some(f => f.enabled)) {
    // 集结城市由本次宣战状态提供，等待明确集结推送后才继续派遣。
    await ctx.action('SetAssembleCityRequest', { cityId: war.assembleCityId }, { response: 'SCAssembleCity', confirm: async () => ctx.pushes.get('SCAssembleCity')?.cityId === war.assembleCityId });
  }
  for (const rule of options.fleets.filter(f => f.enabled)) {
    const fleet = (await idleFleets(ctx)).find(f => !rule.buildingId || rule.buildingId === f.buildingId);
    // 已派出或维修中的前序舰队不能阻塞后续已配置舰队的城战派遣。
    if (!fleet) continue;
    for (const role of rule.roles ?? []) {
      const cityId = role === 'goto' ? rule.gotoCityId : role === 'defend' ? war.assembleCityId : war.declarations?.find(d => options.reattack || !ctx.count(`cityWar.${d.cityId}`))?.cityId;
      if (!cityId) continue;
      if (role === 'defend') {
        // 募防改变城市守军列表，不是派遣此舰队；确认必须读取城市防守状态。
        await mutate(ctx, 'CityRecruitDefenceRequest', { cityId }, 'CityDefenceRequest', s => s.fleets, { stateBody: { cityId } });
      } else {
        const result = await dispatch(ctx, 'MoveFleetsToCityRequest', { buildingId: [fleet.buildingId], cityId }, [fleet]);
        if (succeeded(result)) {
          ctx.count(`cityWar.${cityId}`, 1);
          // 只有移动已确认后才允许提交行军加速，避免把未派出的舰队误扣钻石。
          if (rule.marchSpeedUp) {
            // 预览的派遣只有 planned 状态，不能在日志中冒充已确认的真实行军。
            const movementLogStatus = result.status === 'planned' ? 'planned' : 'success';
            ctx.record({ label: `行军加速判定 ${fleet.buildingId}`, status: movementLogStatus, reason: result.status === 'planned' ? '已生成派遣计划，舰队规则已开启行军加速' : '派遣已确认，舰队规则已开启行军加速' });
            const speedResult = await speedUpFleet(ctx, fleet);
            logSpeedUpResult(ctx, `行军加速结果 ${fleet.buildingId}`, speedResult, '已确认行军结束时间更新');
          } else {
            ctx.record({ label: `行军加速判定 ${fleet.buildingId}`, status: 'skipped', reason: '派遣已确认，但舰队规则未开启行军加速' });
          }
        } else {
          ctx.record({ label: `行军加速判定 ${fleet.buildingId}`, status: 'skipped', reason: `派遣结果为 ${result.status}，未确认舰队正在行军` });
        }
      }
      break;
    }
  }
}

const TRADE_SCARCITY_MARGIN = 0.3;

/**
 * 从联盟商情选择贸易船的下一城：优先把预计收益最高的货物送往紧缺城市。
 *
 * 商情的 rareGoodsId 是紧缺商品、specGoodsId 是城市特产；两者均来自当前
 * TradeGuildRadarResponse，不能用旧配置表或城市名称猜测。所有货物都没有紧缺
 * 目的地时，排除会产出船舱货物的城市，再从余下城市中随机选择一座。
 */
function tradeDestination(currentCityId, goods, radar) {
  const cargo = goods.filter(good => amount(good.num) > 0 && amount(good.buyPrice) > 0);
  // 0.3 是游戏贸易收益系数；显式参与排序，避免把“按预期收益”退化为编号排序。
  const ranked = [...cargo].sort((a, b) => amount(b.num) * amount(b.buyPrice) * TRADE_SCARCITY_MARGIN - amount(a.num) * amount(a.buyPrice) * TRADE_SCARCITY_MARGIN);
  for (const goods of ranked) {
    const target = radar.find(row => row.cityId !== currentCityId && row.rareGoodsId === goods.goodsId);
    if (target) return { cityId: target.cityId, label: `迁往紧缺商品 ${goods.goodsId} 的城市` };
  }
  const goodsIds = new Set(cargo.map(goods => goods.goodsId));
  const cities = [...new Set(radar.filter(row => row.cityId !== currentCityId && !goodsIds.has(row.specGoodsId)).map(row => row.cityId))];
  if (!cities.length) return null;
  // 没有紧缺匹配时只避开会自产船舱货物的城市，其余目的地按用户要求随机选择。
  return { cityId: cities[Math.floor(Math.random() * cities.length)], label: '迁往非船舱特产城市' };
}

/**
 * 根据当前船等级和已装货物计算可购买的剩余舱容。
 *
 * TradeGoodsCfg.capacity 是单件货物占用的舱容，TradeShipCfg.capacity 是整艘船的
 * 总舱容；两者必须同时参与计算，否则金币足够时仍可能提交超过船舱上限的购买量。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {object} state 最新 TradeInfoResponse 状态。
 * @returns {number|null} 剩余舱容；配置缺失时返回 null。
 */
function tradeRemainingCapacity(ctx, state) {
  const level = amount(state.cargo?.cargoLv);
  const ship = ctx.rows('TradeShipCfg').find(row => amount(row.lv) === level);
  if (!ship || !Number.isFinite(Number(ship.capacity))) return null;
  const used = (state.player?.goods ?? []).reduce((total, goods) => {
    const cfg = ctx.rows('TradeGoodsCfg').find(row => amount(row.goodsId) === amount(goods.goodsId));
    return total + amount(goods.num) * Number(cfg?.capacity ?? 0);
  }, 0);
  return Math.max(0, Number(ship.capacity) - used);
}

/**
 * 当前贸易船到港后先共享城市商情，卖空旧货、用贸易金币买满最低价商品，再按联盟商情迁船。
 *
 * TradeCityReportRequest 没有专用回包，必须用 TradeCityResponse.isReport 读回确认；
 * TradeMoveRequest 则以最新抓包确认的 TradeMoveResponse.cargo 作为状态闭环。
 * 贸易玩法只在服务端允许的上海时间 10:00–22:00 执行，避免发送会被拒绝的请求。
 */
async function trade(ctx, options) {
  // 在首次 TradeInfoRequest 前拦截，保证关闭窗口内不会产生任何贸易协议请求。
  if (!hourAllowed(ctx, TRADE_EXECUTION_HOURS)) return skip(ctx, '不在贸易执行时段（上海时间 10:00–22:00）');
  let state = await ctx.query('TradeInfoRequest');
  if (options.claim) {
    if (ctx.rows('TradeDayRewardCfg').some(r => r.id > state.gotReportRwdId && r.roleNum <= state.guildReportNum)) await ctx.action('GotTradeReportRequest', {}, { response: 'GotTTradeReportResponse', confirm: async () => (await ctx.query('TradeInfoRequest')).gotReportRwdId > state.gotReportRwdId });
    if (ctx.rows('TradeAchieveRewardCfg').some(r => r.rewardId > state.gotAchieveRwdId && r.target <= state.player?.profit)) await mutate(ctx, 'GotTradeAchievementRequest', {}, 'TradeInfoRequest', s => s.gotAchieveRwdId);
    // TradePassCfg 包含多个历史贸易周期；只能用本次 TradeInfoResponse 的周期判断可领奖励。
    const passRows = ctx.rows('TradePassCfg').filter(row => row.period === state.period);
    await claimPass(ctx, ctx.protocol.BattlePassType.BP_TRADE, 'TradePassCfg', passRows);
  }
  if (options.upgrade) {
    const cfg = ctx.rows('TradeShipCfg').find(r => r.lv === state.cargo?.cargoLv + 1);
    // 升级同时消耗贸易金币和配置资产；贸易金币不属于 AllResource，单独核验。
    if (cfg && state.player?.coins >= cfg.upMoney) await mutate(ctx, 'TradeCargoUpgradeRequest', {}, 'TradeInfoRequest', s => s.cargo?.cargoLv, { expenses: cfg.upCost.length ? [cfg.upCost] : [] });
    else skip(ctx, '缺少下一贸易船等级或升级消耗');
  }
  state = await ctx.query('TradeInfoRequest');
  if (state.cargo?.moveEndTime > ctx.now() / 1000) {
    // 利润配置是允许启动加速的最低累计收益，不是达到后停止加速的上限。
    if (options.speedUp && options.speedUpDailyLimit > ctx.count('trade.speed') && state.player?.profit >= options.profitLimit) {
      const result = await ctx.action('TradeSpeedRequest', { useNum: 1 }, { expenses: [['海商王加速', 1]] });
      if (result.status === 'success') ctx.count('trade.speed', 1);
    }
    return;
  }
  const cityId = state.cargo?.cityId;
  if (!cityId) return skip(ctx, '贸易船没有当前城市');
  let city = await ctx.query('TradeCityRequest', { cityId });
  if (!city.isReport) {
    const shared = await mutate(ctx, 'TradeCityReportRequest', { cityId }, 'TradeCityRequest', value => value.isReport, { stateBody: { cityId } });
    if (!succeeded(shared)) return;
    city = await ctx.query('TradeCityRequest', { cityId });
  }
  for (const goods of state.player?.goods ?? []) if (goods.num > 0) if (!succeeded(await ctx.action('TradeSellRequest', { cityId, pid: goods.pid, sellNum: goods.num }))) return;
  // 城市商品库存来自刚查询的 TradeCityResponse；库存为 0 时不发送必然被拒绝的购买请求。
  const target = city.goods?.filter(g => amount(g.price) > 0 && amount(g.stock) > 0).sort((a, b) => amount(a.price) - amount(b.price))[0];
  if (!target) return skip(ctx, '贸易城市没有库存商品');
  state = await ctx.query('TradeInfoRequest');
  const remainingCapacity = tradeRemainingCapacity(ctx, state);
  if (remainingCapacity === null) return skip(ctx, '缺少当前贸易船舱容配置');
  const targetCfg = ctx.rows('TradeGoodsCfg').find(row => amount(row.goodsId) === amount(target.goodsId));
  const unitCapacity = Number(targetCfg?.capacity);
  if (!Number.isFinite(unitCapacity) || unitCapacity <= 0) return skip(ctx, '缺少当前商品舱容配置');
  // 购买量同时受金币、服务器库存和剩余舱容限制，避免提交服务端必然拒绝的数量。
  const buyNum = Math.min(
    Math.floor(amount(state.player?.coins) / amount(target.price)),
    amount(target.stock),
    Math.floor(remainingCapacity / unitCapacity),
  );
  if (buyNum <= 0) return skip(ctx, '贸易金币不足以购买当前有库存商品');
  if (!succeeded(await ctx.action('TradeBuyRequest', { cityId, goodsId: target.goodsId, buyNum }))) return;
  state = await ctx.query('TradeInfoRequest');
  const goods = state.player?.goods ?? [];
  if (!goods.some(item => amount(item.num) > 0)) return skip(ctx, '贸易船没有可迁运货物');
  const destination = tradeDestination(cityId, goods, (await ctx.query('TradeGuildRadarRequest')).radar ?? []);
  if (!destination) return skip(ctx, '联盟商情没有可用迁船城市');
  await ctx.action('TradeMoveRequest', { cityId, mvToCityId: destination.cityId }, {
    label: destination.label,
    accept: value => value.cargo?.cityId === cityId && value.cargo?.moveToCityId === destination.cityId && value.cargo?.moveEndTime > ctx.now() / 1000,
  });
}
