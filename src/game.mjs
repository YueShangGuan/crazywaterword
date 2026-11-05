import { normalize } from './worlds.mjs';
import { makeTypeResolver } from './world.mjs';
import { pirateDailySweepLimit, pirateSweepProgress } from './pirates.mjs';

// The read-only state queries the real client fires immediately after login, in the
// order it sends them. Taken verbatim from a capture of the game entering its main UI.
// Every one of these is a pure query: none of them mutates account state.
export const ENTRY_QUERIES = [
  { name: 'AllItemRequest' },
  { name: 'AllResourceRequest' },
  { name: 'AllHeroRequest' },
  { name: 'GetFormationRequest', body: { module: 1 } },
  { name: 'EmailBoxRequest', body: { pageNo: 0 } },
  { name: 'EquipsRequest' },
  { name: 'BadgesRequest' },
  { name: 'RecruitInfoRequest' },
  { name: 'AchievementInfoRequest' },
  { name: 'DailyTaskInfoRequest' },
  { name: 'DailyGiftPackRequest' },
  { name: 'MainTaskInfoRequest' },
  { name: 'GuideInfoRequest' },
  { name: 'AfkInfoRequest' },
  { name: 'MonthCardRequest' },
  { name: 'AllAntiqueRequest' },
  { name: 'OnWaterRequest' },
  { name: 'FishEncyclopediaRequest' },
  { name: 'CargoShipsRequest' },
  { name: 'TreasureLootStatsRequest' },
  { name: 'TreasureLootListRequest' },
  { name: 'TradeInfoRequest' },
  { name: 'TradeGuildRadarRequest' },
  { name: 'AppointInfoRequest' },
  { name: 'ChatRecordRequest', body: { channel: 1 } },
  { name: 'GameEffectRequest' },
  { name: 'AllGuildAbstractionRequest' },
  { name: 'MyFleetsRequest' },
  { name: 'PirateKillRecordRequest' },
  { name: 'MyResFieldsRequest' },
  { name: 'GuildTechInfoRequest' },
  { name: 'GuildOrderRequest' },
  { name: 'MyFormationPresetRequest' },
  { name: 'SeasonTaskStageRequest' },
  { name: 'WorldBossInfoRequest' },
  { name: 'LimitedBossOpenRequest' },
  { name: 'AllPetRequest' },
  { name: 'SeasonRankInfoRequest' },
  { name: 'WeekInfoRequest' },
  { name: 'PassStageStateRequest' },
  { name: 'WeekOrderInfoRequest' },
  { name: 'CounterInfoRequest' },
  { name: 'RadarInfoRequest' },
  { name: 'EnvSkinListRequest' },
  { name: 'ChannelRewardInfoRequest' },
  { name: 'LimitTicketRequest' },
  { name: 'SeasonCardRequest' },
  { name: 'AllPirateRequest' },
  { name: 'PlayerFrameRequest' },
  { name: 'ChurnInfoRequest' },
  { name: 'UltraOpenRequest' },
  { name: 'BlackListRequest' },
];

// These two have no matching `*Response` type in the protocol table: the server answers
// with a push instead (`SCRedPoint`) or a generic `OkResponse`. Sending them with the
// request/response helper would just burn a timeout, so they go out fire-and-forget.
export const ENTRY_SIGNALS = [{ name: 'ExitWorldMapRequest' }, { name: 'RedPointRequest' }];

function responseNameOf(name) {
  return `${name.slice(0, -'Request'.length)}Response`;
}

/** 总览逐条读取，避免 Prompt 与并发业务请求串扰；单项不可读时保留错误证据。 */
export async function collectState(client, protocol, { timeout = 15000, onResult = null, includeChat = true, queries = ENTRY_QUERIES, signals = ENTRY_SIGNALS } = {}) {
  const ok = {};
  const failed = {};

  for (const signal of signals) {
    // 登录视图同步信号也排队，不能与后面的只读查询抢占 Prompt 归属。
    if (protocol[signal.name]) await client.sendWatch(signal.name, signal.body || {}, { window: 100 });
  }

  for (const query of queries) {
    // 总览刷新不重复拉取聊天历史；控制台登录阶段会单独加载世界和联盟记录。
    if (!includeChat && query.name === 'ChatRecordRequest') continue;
    const response = responseNameOf(query.name);
    if (!protocol[query.name] || !protocol[response]) {
      failed[query.name] = `no protocol type for ${protocol[query.name] ? response : query.name}`;
      continue;
    }
    await client
        .request(query.name, query.body || {}, response, timeout)
        .then((body) => {
          ok[query.name] = normalize(body);
          if (onResult) onResult(query.name, body, null);
        })
        .catch((error) => {
          failed[query.name] = error.message;
          if (onResult) onResult(query.name, null, error);
        });
    if (!client.connected || client.stopping) break;
  }

  return { ok, failed };
}

const asArray = (value) => (Array.isArray(value) ? value : []);
const CROP_STORAGE_BASE_CAPACITY = 250;
const CROP_STORAGE_VIP_EFFECT = '加工品存量上限';
const CROP_STORAGE_VIP_EFFECT_UNIT = 5;

/**
 * 根据当前 VIP 等级计算农作物库存上限。
 * 游戏基础上限为 250；VIP 配置里的“加工品存量上限”数值以 5 个库存位为单位，
 * 同一特权同时适用于工厂加工品和农作物。
 *
 * @param {object|null} config 游戏配置表。
 * @param {number} vipLevel 当前角色的 VIP 等级。
 * @returns {number} 当前角色可持有的单种农作物上限。
 */
export function cropStorageCapacity(config, vipLevel = 0) {
  const level = Math.max(0, Math.trunc(Number(vipLevel) || 0));
  const vipConfig = (config?.tables?.VipLevelCfg?.data ?? [])
    .filter((row) => Number(row.level) <= level)
    .sort((a, b) => Number(b.level) - Number(a.level))[0];
  const effect = asArray(vipConfig?.effects).find(([effectId]) => effectId === CROP_STORAGE_VIP_EFFECT);
  const bonus = Math.max(0, Number(effect?.[1]) || 0) * CROP_STORAGE_VIP_EFFECT_UNIT;
  return CROP_STORAGE_BASE_CAPACITY + bonus;
}

/** 将资源/道具奖励压成状态页可直接展示的短结构。 */
function summarizeAssets(value) {
  return asArray(value).map((asset) => ({
    type: asset.type,
    id: asset.id,
    num: asset.num,
  }));
}

/** 将舰队协议状态转换成页面使用的中文状态摘要。 */
function summarizeFleet(fleet) {
  const stateText = { 1: '闲置', 2: '移动中', 3: '战斗中', 4: '维修中', 5: '排队中' };
  // 目标类型只在部分服务端版本返回；保留显式字段，缺失时由页面根据目标城市/坐标展示可核对的目标。
  const target = fleet.target ?? {};
  return {
    buildingId: fleet.buildingId,
    state: fleet.state,
    stateText: stateText[fleet.state] ?? `状态${fleet.state ?? '-'}`,
    durability: fleet.durability,
    maxDura: fleet.maxDura,
    cityId: fleet.cityId,
    targetCityId: fleet.targetCityId,
    moveStartTs: fleet.moveStartTs,
    moveEndTs: fleet.moveEndTs,
    repairEndTs: fleet.repairing?.endTs ?? fleet.repairEndTs ?? null,
    targetGridIdx: fleet.targetGridIdx,
    power: fleet.power,
    targetType: fleet.targetType ?? target.type ?? null,
    targetName: fleet.targetName ?? target.name ?? null,
    owner: fleet.owner?.nickname ?? null,
  };
}

/** 将货船订单压成数量、完成数和到达时间，避免总览直接暴露整份奖励协议。 */
function summarizeCargoShip(ship, index) {
  const orderItems = asArray(ship.orderItem);
  return {
    index: index + 1,
    status: ship.status,
    orderCount: orderItems.length,
    filledCount: orderItems.filter((item) => item.filled).length,
    endTime: ship.endTime ?? null,
  };
}

/** 将万吨货轮奖励压成总览可直接展示的资产列表。 */
function summarizeMerchantShip(state) {
  // 万吨货轮沿用世界宝藏列表中的 color=5 标记，其他宝藏不能进入该卡片。
  const treasure = asArray(state?.TreasureLootListRequest?.treasure)
    .find((entry) => Number(entry.color) === 5);
  const stats = state?.TreasureLootStatsRequest;
  return {
    remainingRewardTimes: stats?.todayRewardTimes ?? null,
    uid: treasure?.uid ?? null,
    reward: treasure ? summarizeAssets(treasure.reward?.asset) : [],
  };
}

/** 从本地配置表建立海商王城市与商品的展示名称，协议仍保留原始 ID 供自动化使用。 */
function tradeDisplayNames(config, scenarioId = 0) {
  const cityRows = config?.tables?.[`${scenarioId}_CityCfg`]?.data ?? config?.tables?.CityCfg?.data ?? [];
  const cityNames = new Map(cityRows.map((row) => [row.id, row.name]));
  const goodsNames = new Map((config?.tables?.TradeGoodsCfg?.data ?? []).map((row) => [row.goodsId, row.itemName ?? row.itemId]));
  return { cityNames, goodsNames };
}

/**
 * 将登录后的只读响应归并成总览和状态页使用的玩家视角快照。
 * @param {{ok?: Record<string, object>}} state 已归一化的协议响应。
 * @param {{now?: number, config?: object|null, scenarioId?: number, rawMaterialUpperBoundId?: number, cropVipLevel?: number, pirateVipLevel?: number|null}} options 当前时间、配置表、世界场景、容量及海盗扫荡所用的角色 VIP 等级。
 * @returns {object} 可供 CLI、网页总览和自动化模块复用的状态摘要。
 */
export function summarize(state, { now = Date.now() / 1000, config = null, scenarioId = 0, rawMaterialUpperBoundId = 16, cropVipLevel = 0, pirateVipLevel = null } = {}) {
  const q = state.ok || {};
  const pirateSweepTimes = q.AllPirateRequest?.sweepTimes;
  let pirateSweep = null;
  // 总览允许角色身份、配置或计数缺失；显示为不可用而非套用固定 15 次，自动化写入仍会保守跳过。
  if (q.AllPirateRequest) {
    try { pirateSweep = pirateSweepProgress(pirateSweepTimes, pirateDailySweepLimit(config?.tables, pirateVipLevel)); }
    catch { /* 海盗状态卡片使用“次数未返回”提示，不让单项异常影响其他总览数据。 */ }
  }
  const water = q.OnWaterRequest || {};
  const afk = q.AfkInfoRequest?.afkInfo;
  const daily = q.DailyTaskInfoRequest;
  const achievement = q.AchievementInfoRequest;
  const email = q.EmailBoxRequest;
  const resFields = q.MyResFieldsRequest?.info;
  const items = asArray(q.AllItemRequest?.items);
  const heroes = asArray(q.AllHeroRequest?.heroes);
  const buildings = asArray(water.building);
  const resolveBuildingType = makeTypeResolver(config);
  const monthCard = asArray(q.MonthCardRequest?.cardItem);
  const { cityNames, goodsNames } = tradeDisplayNames(config, scenarioId);
  const merchantShip = summarizeMerchantShip(q);

  const tasksDone = (list) => asArray(list).filter((task) => task.progress >= task.targetProgress);
  const claimable = (list) =>
    tasksDone(list).filter((task) => !task.rewardClaimed).length;

  /**
   * 从配置表识别原材料，并补齐当前没有库存记录的原材料为 0，便于总览面板稳定展示。
   * 原材料分类由游戏配置维护，避免把加工品、礼包和活动道具误算进原料库存。
   */
  // 仓库上限由当前账号的效果状态决定，不能只使用配置表里的初始值；没有效果回包时保留空值。
  const materialCapacity = q.GameEffectRequest?.effects
    ?.find((effect) => effect.id === rawMaterialUpperBoundId)?.value ?? null;
  const materials = (config?.tables?.ItemCfg?.data ?? [])
    .filter((row) => row.type === '原料')
    .map((row) => ({
      itemId: row.id,
      num: items.find((item) => (item.itemId ?? item.id) === row.id)?.num ?? 0,
      capacity: materialCapacity,
      sortId: row.sortId ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.sortId - b.sortId)
    .map(({ sortId, ...item }) => item);

  // GameParamCfg 的 50 仅限制工厂成品；农作物从 250 起，并叠加当前 VIP 的专属容量效果。
  // 即使当前库存没有该作物也补 0，使总览稳定展示全部可种植作物。
  const cropCapacity = cropStorageCapacity(config, cropVipLevel);
  const crops = (config?.tables?.FarmlandPlantCfg?.data ?? []).map((row) => ({
    itemId: row.id,
    num: items.find((item) => (item.itemId ?? item.id) === row.id)?.num ?? 0,
    capacity: cropCapacity,
  }));

  return {
    resources: asArray(q.AllResourceRequest?.list).map((entry) => ({
      res: entry.res,
      amount: entry.amount,
      name: config ? config.resourceName(entry.res) : undefined,
    })),
    items: {
      kinds: items.length,
      total: items.reduce((sum, item) => sum + item.num, 0),
      top: [...items].sort((a, b) => b.num - a.num).slice(0, 12),
    },
    materials,
    crops,
    heroes: {
      count: heroes.length,
      power: heroes.reduce((sum, hero) => sum + hero.power, 0),
      list: heroes
        .map((hero) => ({ heroId: hero.heroId, level: hero.level, star: hero.star, power: hero.power, skinId: hero.skinId }))
        .sort((a, b) => b.power - a.power),
      formation: asArray(q.GetFormationRequest?.formation?.heroPositions).map((slot) => ({ heroId: slot.heroId, x: slot.pos?.x, y: slot.pos?.y })),
      appointed: asArray(q.AppointInfoRequest?.heroes).map((slot) => ({ heroId: slot.heroId, posId: slot.posId })),
    },
    afk: afk
      ? {
          level: afk.level,
          startTime: afk.afkStartTime,
          finishTime: afk.afkFinishTime,
          rewardedLevel: afk.rewardedLevel,
          capped: afk.afkFinishTime > 0 && now >= afk.afkFinishTime,
          pendingLevels: Math.max((afk.level ?? 0) - (afk.rewardedLevel ?? 0), 0),
        }
      : null,
    clickGold: q.AfkInfoRequest?.clickGoldInfo ?? null,
    daily: daily
      ? {
          tasks: asArray(daily.dailyTask).length,
          done: tasksDone(daily.dailyTask).length,
          claimable: claimable(daily.dailyTask),
          dailyActivity: daily.dailyActivity,
          weeklyActivity: daily.weeklyActivity,
          dailyRewardClaimed: asArray(daily.dailyRewardClaimed),
          resetTime: daily.dailyResetTime,
        }
      : null,
    achievements: achievement
      ? {
          total: asArray(achievement.task).length,
          done: tasksDone(achievement.task).length,
          claimable: claimable(achievement.task),
        }
      : null,
    email: email
      ? {
          total: email.total,
          unclaimed: asArray(email.email).filter((mail) => !mail.got).length,
          subjects: asArray(email.email).filter((mail) => !mail.got).slice(0, 8).map((mail) => mail.subject),
        }
      : null,
    buildings: buildings.map((building) => ({
      buildingId: building.buildingId,
      level: building.level,
      auto: building.auto,
      building: building.buildFinishTime ? { start: building.buildStartTime, finish: building.buildFinishTime } : null,
      // 空闲农田的 OnWater 回包没有 farm 字段；按配置识别后仍输出空状态，避免总览漏计地块。
      farm: building.farm || resolveBuildingType(building.buildingId) === '农田'
        ? {
            productId: building.farm?.productId ?? null,
            ripeTime: building.farm?.ripeTime ?? null,
          }
        : null,
      factory: building.factory
        ? {
            autoProductId: building.factory.autoProductId,
            // 队列只展示生产识别所需字段，保留完成时间用于总览倒计时提示。
            queue: asArray(building.factory.factoryQ).map((job) => ({
              idx: job.idx,
              productId: job.productId,
              finishTime: job.finishTime ?? null,
            })),
            finished: summarizeAssets(building.factory.finishedProducts),
          }
        : null,
      product: summarizeAssets(building.product?.asset),
      equipMaking: building.equipMaking ?? null,
    })),
    water: {
      autoProduceEndTime: water.autoProduceEndTime,
      autoProduceForever: water.autoProduceForever,
      autoFarming: water.autoFarming,
      fishingLevel: water.fishingLevel?.level,
      salvageLevel: water.salvageLevel?.level,
      divingLevel: water.divingLevel?.level,
      orderOfTheDay: water.orderOfTheDay ?? null,
      floaterCount: asArray(water.floater).length,
      workerOrderCount: asArray(water.workerOrder).length,
    },
    resFields: resFields
      ? { count: asArray(resFields.fields).length, max: resFields.maxNum, fields: asArray(resFields.fields) }
      : null,
    fleets: asArray(q.MyFleetsRequest?.fleets).length,
    fleetList: asArray(q.MyFleetsRequest?.fleets).map(summarizeFleet),
    guild: asArray(q.AllGuildAbstractionRequest?.guilds).map((entry) => ({ id: entry.id, level: entry.level })),
    counters: asArray(q.CounterInfoRequest?.counters),
    recruit: q.RecruitInfoRequest ?? null,
    dailyGift: q.DailyGiftPackRequest
      ? { drawnPack: asArray(q.DailyGiftPackRequest.drawnPack), resetTime: q.DailyGiftPackRequest.resetTime }
      : null,
    antiques: q.AllAntiqueRequest ? { count: asArray(q.AllAntiqueRequest.antiques).length, masterLv: q.AllAntiqueRequest.masterLv, suits: asArray(q.AllAntiqueRequest.suits).length } : null,
    pets: asArray(q.AllPetRequest?.pets).length,
    equips: asArray(q.EquipsRequest?.equip).length,
    pirates: q.AllPirateRequest
      ? {
          count: asArray(q.AllPirateRequest.pirates).length,
          sweep: pirateSweep,
          list: asArray(q.AllPirateRequest.pirates).map((pirate) => ({
            uid: pirate.uid,
            type: pirate.type,
            level: pirate.level,
            gridIdx: pirate.gridIdx,
            cityId: pirate.cityId,
          })),
        }
      : null,
    worldBoss: q.WorldBossInfoRequest?.info ?? null,
    radar: q.RadarInfoRequest?.radarInfo
      ? {
          level: q.RadarInfoRequest.radarInfo.level,
          exp: q.RadarInfoRequest.radarInfo.exp,
          storedNum: q.RadarInfoRequest.radarInfo.storedNum,
          nextRefreshTime: q.RadarInfoRequest.radarInfo.nextRefreshTime,
          events: asArray(q.RadarInfoRequest.radarInfo.events).map((event) => ({
            uid: event.uid,
            eventId: event.eventId,
            color: event.color,
            state: event.state,
            gridIdx: event.gridIdx,
          })),
        }
      : null,
    cargoList: asArray(q.CargoShipsRequest?.ship).map(summarizeCargoShip),
    merchantShip,
    trade: q.TradeInfoRequest
      ? {
          period: q.TradeInfoRequest.period,
          player: q.TradeInfoRequest.player
            ? {
                coins: q.TradeInfoRequest.player.coins,
                maxCoins: q.TradeInfoRequest.player.maxCoins,
                profit: q.TradeInfoRequest.player.profit,
                buySpeedTimes: q.TradeInfoRequest.player.buySpeedTimes,
                goods: asArray(q.TradeInfoRequest.player.goods).map((goods) => ({
                  pid: goods.pid,
                  goodsId: goods.goodsId,
                  num: goods.num,
                  buyPrice: goods.buyPrice,
                  cityId: goods.cityId,
                })),
              }
            : null,
          cargo: q.TradeInfoRequest.cargo
            ? {
                cargoLv: q.TradeInfoRequest.cargo.cargoLv,
                cityId: q.TradeInfoRequest.cargo.cityId,
                moveStartTime: q.TradeInfoRequest.cargo.moveStartTime,
                moveEndTime: q.TradeInfoRequest.cargo.moveEndTime,
                moveToCityId: q.TradeInfoRequest.cargo.moveToCityId,
              }
            : null,
          gotAchieveRwdId: q.TradeInfoRequest.gotAchieveRwdId,
          gotReportRwdId: q.TradeInfoRequest.gotReportRwdId,
          guildReportNum: q.TradeInfoRequest.guildReportNum,
          guildTask: q.TradeInfoRequest.guildTask
            ? {
                profit: q.TradeInfoRequest.guildTask.profit,
                tradeTimes: q.TradeInfoRequest.guildTask.tradeTimes,
                gotTaskId: asArray(q.TradeInfoRequest.guildTask.gotTaskId),
              }
            : null,
          worldCargoCount: asArray(q.TradeInfoRequest.worldCargo).length,
        }
      : null,
    tradeRadar: asArray(q.TradeGuildRadarRequest?.radar).map((entry) => ({
      cityId: entry.cityId,
      cityName: cityNames.get(entry.cityId) ?? null,
      specGoodsId: entry.specGoodsId,
      specGoodsName: goodsNames.get(entry.specGoodsId) ?? null,
      rareGoodsId: entry.rareGoodsId,
      rareGoodsName: goodsNames.get(entry.rareGoodsId) ?? null,
      reportName: entry.reportName,
    })),
    guildTech: asArray(q.GuildTechInfoRequest?.tech).map((tech) => ({ id: tech.id, level: tech.level, exp: tech.exp })),
    guildOrder: q.GuildOrderRequest?.order
      ? { requirements: summarizeAssets(q.GuildOrderRequest.order.requirements), nextRefreshTime: q.GuildOrderRequest.order.nextRefreshTime }
      : null,
    season: q.SeasonRankInfoRequest ?? null,
    week: asArray(q.WeekInfoRequest?.activityTime),
    pass: q.PassStageStateRequest ?? null,
    weekOrder: q.WeekOrderInfoRequest
      ? { count: asArray(q.WeekOrderInfoRequest.order).length, isGotFinal: q.WeekOrderInfoRequest.isGotFinal }
      : null,
    monthCard: monthCard.map((card) => ({ type: card.type, active: card.endTime > now, endTime: card.endTime, gotDailyReward: card.gotDailyReward })),
    guide: q.GuideInfoRequest?.guide ?? null,
    guideDone: asArray(q.GuideInfoRequest?.triggerGuideId).length,
    mainTask: q.MainTaskInfoRequest?.task
      ? {
          taskId: q.MainTaskInfoRequest.task.taskId,
          progress: q.MainTaskInfoRequest.task.progress,
          targetProgress: q.MainTaskInfoRequest.task.targetProgress,
          rewardClaimed: q.MainTaskInfoRequest.task.rewardClaimed,
        }
      : null,
    cargo: asArray(q.CargoShipsRequest?.ship).length,
    fish: q.FishEncyclopediaRequest
      ? { count: asArray(q.FishEncyclopediaRequest.fishList).length, rewardId: q.FishEncyclopediaRequest.rewardId }
      : null,
  };
}

const clock = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleString() : '-');

/** 将状态摘要渲染为 CLI 和调试日志共用的文本。 */
export function formatState(view) {
  const lines = [];
  lines.push(`资源:`);
  for (const entry of view.resources) lines.push(`  ${entry.name ? `${entry.name} ` : ''}res=${entry.res} amount=${entry.amount}`);
  lines.push(`道具: ${view.items.kinds} 种 / ${view.items.total} 个`);
  for (const item of view.items.top) lines.push(`  ${item.itemId} x${item.num}`);
  lines.push(`英雄: ${view.heroes.count} 个, 总战力 ${view.heroes.power}`);
  for (const hero of view.heroes.list) lines.push(`  ${hero.heroId} lv${hero.level} ${hero.star}星 战力${hero.power}`);
  lines.push(`  上阵: ${view.heroes.formation.map((slot) => `${slot.heroId}(${slot.x},${slot.y})`).join(' ')}`);
  if (view.afk) {
    lines.push(`挂机: 等级${view.afk.level} 开始${clock(view.afk.startTime)} 封顶${clock(view.afk.finishTime)}`);
    lines.push(`  已封顶=${view.afk.capped} 已领等级=${view.afk.rewardedLevel} 待领等级=${view.afk.pendingLevels}`);
  }
  if (view.daily) {
    lines.push(`每日任务: ${view.daily.done}/${view.daily.tasks} 完成, ${view.daily.claimable} 个可领奖, 活跃度 ${view.daily.dailyActivity}`);
    lines.push(`  重置 ${clock(view.daily.resetTime)}`);
  }
  if (view.achievements) lines.push(`成就: ${view.achievements.done}/${view.achievements.total} 完成, ${view.achievements.claimable} 个可领奖`);
  if (view.email) lines.push(`邮件: ${view.email.total} 封, ${view.email.unclaimed} 封未领附件`);
  lines.push(`水上建筑 ${view.buildings.length} 座:`);
  for (const building of view.buildings) {
    const bits = [
      building.level ? `lv${building.level}` : '未建',
      building.auto ? '自动' : '',
      building.building ? `建造中至 ${clock(building.building.finish)}` : '',
      building.factory ? `工厂产出 ${JSON.stringify(building.factory.finished)}` : '',
    ].filter(Boolean);
    lines.push(`  ${building.buildingId} ${bits.join(' ')}`);
  }
  const pirateSweep = view.pirates?.sweep;
  lines.push(`世界: 资源田 ${view.resFields?.count ?? 0}/${view.resFields?.max ?? 0} 舰队 ${view.fleets} 货船 ${view.cargo} 海盗 ${view.pirates?.count ?? 0}(${pirateSweep ? `扫荡已用${pirateSweep.used}/${pirateSweep.dailyLimit}，剩余${pirateSweep.remaining}` : '扫荡次数未返回'})`);
  lines.push(`  自动生产至 ${clock(view.water.autoProduceEndTime)} 永久=${view.water.autoProduceForever} 自动种植=${view.water.autoFarming}`);
  lines.push(`  钓鱼lv${view.water.fishingLevel ?? '-'} 打捞lv${view.water.salvageLevel ?? '-'} 潜水lv${view.water.divingLevel ?? '-'}`);
  if (view.worldBoss) lines.push(`  世界Boss bossId=${view.worldBoss.bossId} 最高伤害=${view.worldBoss.bestDamage} 已领档位=${view.worldBoss.gotRewardLevel}`);
  lines.push(`公会候选: ${JSON.stringify(view.guild.map((entry) => entry.id))}`);
  lines.push(`每日计数: ${view.counters.map((counter) => `${counter.type}=${counter.num}`).join(' ')}`);
  lines.push(`招募: 英雄${view.recruit?.hero?.recruitTimes ?? '-'}次 下次保底${view.recruit?.hero?.nextLuck ?? '-'} | 藏品${view.recruit?.antique?.recruitTimes ?? '-'}次`);
  lines.push(`藏品 ${view.antiques?.count ?? 0} 件 大师lv${view.antiques?.masterLv ?? '-'} | 宠物 ${view.pets} | 装备 ${view.equips} | 月卡 ${JSON.stringify(view.monthCard)}`);
  lines.push(`新手引导: ${JSON.stringify(view.guide)} | 主线 ${JSON.stringify(view.mainTask)}`);
  if (view.fish) lines.push(`鱼类图鉴: ${JSON.stringify(view.fish)}`);
  return lines.join('\n');
}

