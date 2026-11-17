import { surveyWorld, planWorld, makeTypeResolver } from '../world.mjs';
import { nextOrderTier } from '../tasks.mjs';
import { amount, idString } from './context.mjs';
import { costs, discardExpiredVipRegistration, repeat, succeeded, skip, awaitPush, mutate, reconcileFactoryHarvestPending } from './common.mjs';
import { scheduleProduction } from './production.mjs';
import { moduleActive, serverTime, shanghaiWeekday } from './schedule.mjs';

/**
 * 仅从当前连接的活动推送读取仍在进行中的英雄突袭订单，防止过期活动或上一连接的状态进入排产。
 *
 * @param {object} ctx 自动化上下文。
 * @returns {Promise<{raid: object, order: object}|null>} 当前活动状态与订单配置；没有可用订单时返回 null。
 */
async function activeHeroRaidOrder(ctx) {
  if (!ctx.pushes.has('SCHeroRaidOpen')) {
    // 英雄突袭没有独立查询请求，只能通过登录完成信号让服务端重推当前连接的活动状态。
    await awaitPush(ctx, ['SCHeroRaidOpen'], () => ctx.client.sendWatch('LoginFinishRequest', {}, { window: 100 }), 1500);
  }
  const raid = ctx.pushes.get('SCHeroRaidOpen')?.raid;
  const now = ctx.now() / 1000;
  if (!raid?.raidId || raid.startTime > now || raid.finishTime <= now || !raid.order?.orderId) return null;
  const order = ctx.rows('HeroRaidOrderCfg').find(row => row.raidId === raid.raidId && row.orderId === raid.order.orderId);
  if (!order?.orderList?.length) {
    skip(ctx, `英雄突袭订单配置不存在：活动 ${raid.raidId}、订单 ${raid.order.orderId}`);
    return null;
  }
  return { raid, order };
}

/**
 * 完成材料已齐全的当前英雄突袭订单，并在本次完成动作跨过订单档位时领取对应奖励。
 *
 * 当前协议没有已领奖档位的只读字段，所以只处理本次服务端确认完成后新达到的档位，避免对历史档位重复发领奖请求。
 *
 * @param {object} ctx 自动化上下文。
 * @returns {Promise<void>} 当前订单不可完成、预览或本次处理结束后返回。
 */
async function completeHeroRaidOrder(ctx) {
  const current = await activeHeroRaidOrder(ctx);
  if (!current || !ctx.enough(current.order.orderList)) return;
  const before = current.raid.order;
  const result = await ctx.action('HeroRaidFinishOrderRequest', { raidId: current.raid.raidId }, {
    response: 'HeroRaidOrderResponse',
    label: `完成英雄突袭订单 #${before.orderId}`,
    expenses: current.order.orderList,
    // 同一订单不能把旧回包当作完成证据；至少要更新完成次数或已完成订单 ID。
    accept: response => Boolean(response?.order) && (response.order.gotTimes > before.gotTimes || response.order.gotOrderId !== before.gotOrderId),
  });
  if (result.status !== 'success') return;

  const next = result.value.order;
  // 完成回包给出下一张订单；保留同一活动元数据供本轮后续排产读取。
  ctx.pushes.set('SCHeroRaidOpen', { raid: { ...current.raid, order: next } });
  const reward = ctx.rows('HeroRaidOrderRewardCfg')
    .filter(row => row.raidId === current.raid.raidId && row.orderCount > before.gotTimes && row.orderCount <= next.gotTimes)
    .sort((left, right) => left.orderCount - right.orderCount)[0];
  if (!reward) return;
  await ctx.action('HeroRaidGotOrderRewardRequest', { raidId: current.raid.raidId }, {
    response: 'HeroRaidOrderResponse',
    label: `领取英雄突袭订单 ${reward.orderCount} 次奖励`,
    // 奖励响应必须包含实际资产，不能把仅返回订单状态误报为领奖成功。
    accept: response => (response?.reward?.asset?.length ?? 0) > 0,
  });
}

/**
 * 汇总居民、货船、联盟、当前英雄突袭和海兽喂养的实际需求，按来源顺序分配同一份库存。
 *
 * @param {object} ctx 自动化上下文。
 * @param {string[]} sources 需要参与汇总的业务来源。
 * @param {{includeCovered?: boolean}} options 排产器需要完整需求来保护已经齐备的订单库存。
 * @returns {Promise<Array<{id: string, need: number, source: string, lack: number}>>} 默认仅返回缺口；includeCovered 时包含已有库存覆盖的需求。
 */
export async function demand(ctx, sources = ['resident', 'cargo', 'guild'], { includeCovered = false } = {}) {
  const needs = new Map();
  /** 同来源合并数量，跨来源保留身份，让周一优先级能沿配方依赖继承。 */
  const add = (assets, source) => { for (const [id, count] of costs(assets, ctx.protocol)) { const key = `${source}:${id}`, row = needs.get(key) ?? { id, need: 0, source }; row.need += count; needs.set(key, row); } };
  for (const source of sources) {
    try {
      if (source === 'resident') { const water = await ctx.query('OnWaterRequest'); for (const order of water.workerOrder ?? []) if (!order.refreshTime || order.refreshTime <= ctx.now() / 1000) add(order.requirements, source); }
      if (source === 'cargo') { const state = await ctx.query('CargoShipsRequest'); for (const ship of state.ship ?? []) for (const item of ship.orderItem ?? []) if (!item.filled) add([item.asset], source); }
      if (source === 'guild' && amount((await ctx.query('GuildInfoRequest')).guild?.guildId)) { const state = await ctx.query('GuildOrderRequest'); add(state.order?.requirements, source); }
      if (source === 'heroRaid') {
        const current = await activeHeroRaidOrder(ctx);
        if (current) add(current.order.orderList.map(([id, num]) => ({ type: 0, id, num })), source);
      }
      if (source === 'petFeed') {
        const water = await ctx.query('OnWaterRequest');
        for (const building of water.building ?? []) for (const job of building.petBreed?.breedQ ?? []) {
          // 只为仍在培育且服务端还列出喂养材料的任务补产；已喂满或到点待成熟的队列没有喂养动作。
          if (job.feedRequirements?.length && job.finishTime > ctx.now() / 1000) add(job.feedRequirements, source);
        }
      }
    } catch (error) { skip(ctx, `${source} 需求不可用：${error.message}`); }
  }
  const pending = new Map();
  const water = await ctx.query('OnWaterRequest');
  for (const building of water.building ?? []) {
    // 一份配方产出一件；队列和未领取成品都能覆盖订单，跨轮不能再次安排同一缺口。
    for (const job of building.factory?.factoryQ ?? []) pending.set(job.productId, (pending.get(job.productId) ?? 0) + 1);
    for (const [id, num] of costs(building.factory?.finishedProducts, ctx.protocol)) pending.set(id, (pending.get(id) ?? 0) + num);
  }
  // 库存及在产只分配一次；农田只关心总缺口，排产则需要保留每个来源。
  const supply = new Map(ctx.stock), missing = new Map();
  for (const [id, num] of pending) supply.set(id, (supply.get(id) ?? 0) + num);
  const result = [...needs.values()].map(row => {
    const used = Math.min(row.need, supply.get(row.id) ?? 0);
    supply.set(row.id, (supply.get(row.id) ?? 0) - used);
    const entry = { ...row, lack: row.need - used };
    const total = missing.get(row.id) ?? { ...entry, need: 0, lack: 0 };
    total.need += entry.need; total.lack += entry.lack; missing.set(row.id, total);
    return entry;
  });
  return includeCovered ? result : [...missing.values()].filter(row => row.lack > 0);
}

// 2026-11-02/03 抓包确认：广告加速先发 WatchAdvRequest{type:1,id}，再发
// SpeedUpCostParam{type:3,useNum:0}；id=6 是工厂生产，id=8 是建筑升级。
// 每次广告固定减少 30 分钟，因此只对严格超过 30 分钟的任务使用，避免浪费当天次数。
const AD_SPEED_UP_MIN_REMAIN_SECS = 30 * 60;
const AD_SPEED_UP_SECONDS = 30 * 60;
const AD_SPEED_UP_AD_IDS = { building: 8, factory: 6 };

/** 读取广告加速的每日上限；缺表或额度无效时返回 null。 */
function adSpeedUpLimit(ctx, id) {
  const limit = ctx.rows('AdvEffectCfg').find(row => row.id === id)?.dailyLimit;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

/** 只对严格大于 30 分钟的任务使用广告加速，29 分钟不处理、31 分钟处理。 */
function adSpeedUpTarget(finishTime, nowSecs) {
  return Number.isFinite(finishTime) && finishTime > nowSecs + AD_SPEED_UP_MIN_REMAIN_SECS;
}

/**
 * 从当前海面快照筛出可加速的建造或生产目标，并按结束时间从早到晚排列。
 *
 * @param {object} ctx 自动化上下文。
 * @param {object} survey 当前海面快照。
 * @param {object} options 已验证的海岛模块设置。
 * @param {'building'|'factory'} kind 广告加速类别。
 * @param {number} nowSecs 服务端当前秒级时间。
 * @returns {Array<{buildingId: string, finishTime: number, key: string, building?: object, job?: object}>} 可加速目标。
 */
function adSpeedUpTargets(ctx, survey, options, kind, nowSecs) {
  const resolver = makeTypeResolver(ctx.config);
  if (kind === 'building') {
    return survey.buildings
      .filter(building => adSpeedUpTarget(building.buildFinishTime, nowSecs))
      .filter(building => {
        const type = resolver(building.buildingId);
        return type !== '活动工厂' && !options.disabledBuildings.includes(type);
      })
      .sort((left, right) => left.buildFinishTime - right.buildFinishTime)
      .map(building => ({ buildingId: building.buildingId, building, finishTime: building.buildFinishTime, key: `building:${building.buildingId}` }));
  }
  const targets = [];
  const disabledFactories = options.factory?.disabledFactories ?? [];
  for (const building of survey.factories) {
    const type = resolver(building.buildingId);
    if (type === '活动工厂' || options.disabledBuildings.includes(type) || disabledFactories.includes(type)) continue;
    for (const job of building.factory?.factoryQ ?? []) {
      if (!adSpeedUpTarget(job.finishTime, nowSecs)) continue;
      targets.push({ buildingId: building.buildingId, job, finishTime: job.finishTime, key: `factory:${building.buildingId}:${job.idx}` });
    }
  }
  return targets.sort((left, right) => left.finishTime - right.finishTime);
}

/**
 * 用 VIP 免广告权益执行每日建筑/生产广告加速。
 *
 * 本地按北京时间记录当天已用次数；满额后不再读取广告次数或发送请求，跨天后计数自动归零。
 * 服务端广告次数可能包含手动使用，因此只在更大时同步到本地，避免重复消耗同一份权益。
 *
 * @param {object} ctx 自动化上下文。
 * @param {object} options 已验证的海岛模块设置。
 * @param {object} survey 当前海面快照，包含广告次数。
 * @returns {Promise<void>} 所有可执行广告加速处理完毕后返回。
 */
async function adSpeedUps(ctx, options, survey) {
  if (!options.adSpeedUp) return;
  const type = ctx.protocol.AdvType?.ADV_EFFECT;
  if (type === undefined) return skip(ctx, '当前协议缺少广告类型');
  const vipLevel = Number(ctx.pushes.get('SCVipUpdate')?.vipLevel ?? ctx.player?.vip?.vipLevel);
  // VIP 3 的免广告权益适用于建造和生产；角色等级不单独设门槛，未开放建筑时自然没有目标。
  if (!(Number.isSafeInteger(vipLevel) && vipLevel >= 3))
    return skip(ctx, '免广告加速需要 VIP 3 级');
  const nowSecs = (ctx.now() + (ctx.client.serverClockOffsetMs || 0)) / 1000;
  const adv = Array.isArray(survey.adv) ? survey.adv : [];
  const date = ctx.businessDate();
  const jobs = [
    { kind: 'building', id: AD_SPEED_UP_AD_IDS.building, countKey: 'island.adSpeedUp.building', request: 'SpeedUpUpgradeBuildingRequest', label: '建造' },
    { kind: 'factory', id: AD_SPEED_UP_AD_IDS.factory, countKey: 'island.adSpeedUp.factory', request: 'SpeedUpFactoryProduceRequest', label: '生产' },
  ];
  for (const job of jobs) {
    job.limit = adSpeedUpLimit(ctx, job.id);
    job.used = ctx.count(job.countKey);
    // 本地已达到当天上限时不再读取服务端广告次数；只有仍可能有剩余次数时才同步。
    if (job.limit > 0 && job.used >= job.limit) continue;
    const serverUsed = amount(adv.find(row => row.id === job.id)?.gotTimes);
    if (Number.isSafeInteger(serverUsed) && serverUsed > job.used) {
      if (!ctx.dryRun) ctx.count(job.countKey, serverUsed - job.used);
      job.used = serverUsed;
    }
  }
  for (const job of jobs) {
    if (!(job.limit > 0)) { skip(ctx, `缺少广告加速额度配置（${job.label}）`); continue; }
    // 今天已经用满时只读本地计数，不再查广告次数或发送请求。
    while (job.used < job.limit) {
      // 每次加速后重新挑选结束时间最早的可加速目标；同一目标仍在 30 分钟以上时可连续使用。
      const target = adSpeedUpTargets(ctx, survey, options, job.kind, nowSecs)[0];
      if (!target) break;
      const registered = await ctx.action('WatchAdvRequest', { type, id: job.id }, {
        response: 'OkResponse',
        label: `${job.label}广告加速登记`,
        key: `island.adSpeedUp.watch:${date}:${job.id}:${job.used + 1}`,
        continueAfterUncertain: true,
        blockModuleOnUncertain: false,
        // 广告登记零消耗；超时后重复登记不会消耗每日次数。
        lockOnUncertain: false,
        allowed: () => ctx.businessDate() === date,
      });
      if (!succeeded(registered)) break;
      const body = job.kind === 'building'
        ? { buildingId: target.buildingId, speedUp: { type: 3, useNum: 0 } }
        : { buildingId: target.buildingId, index: target.job.idx, speedUp: { type: 3, useNum: 0 } };
      const result = await ctx.action(job.request, body, {
        response: 'OkResponse',
        label: `免广告加速${job.label} ${target.buildingId}`,
        key: `island.adSpeedUp.speed:${date}:${job.kind}:${job.used + 1}:${target.key}`,
        continueAfterUncertain: true,
        blockModuleOnUncertain: false,
        allowed: () => ctx.businessDate() === date,
      });
      if (!succeeded(result)) break;
      if (!ctx.dryRun) ctx.count(job.countKey, 1);
      job.used++;
      // 服务端每次固定减少 30 分钟；同步本地快照后，后续普通加速器计划不会重复计算这段时间。
      target.finishTime -= AD_SPEED_UP_SECONDS;
      if (job.kind === 'building') target.building.buildFinishTime = target.finishTime;
      else target.job.finishTime = target.finishTime;
    }
  }
}

/**
 * 按当前海岛状态执行建筑与工厂动作，将有效英雄突袭订单纳入共享库存三档排产。
 *
 * @param {object} ctx 自动化上下文。
 * @param {object} options 已验证的海岛模块设置。
 * @returns {Promise<void>} 所有可执行建筑和工厂动作处理完毕后返回。
 */
export async function island(ctx, options) {
  // 先只读结算空待领工厂的遗留收成，避免上轮已完成的收成永久阻断后续排产。
  await reconcileFactoryHarvestPending(ctx);
  const survey = await surveyWorld({ request: (name, body, response) => ctx.query(name, body, response) }, ctx.protocol, { config: ctx.config, player: ctx.player });
  // 免广告加速先于普通加速器执行，免费次数优先；同步快照后再生成加速器计划。
  await adSpeedUps(ctx, options, survey);
  const plan = planWorld(survey, { config: ctx.config, allowSpeedUp: options.speedUp, upgradePriority: options.upgradePriority });
  const enabledKinds = { collectProduct: options.collect, gainFactory: options.factory.gain, finishUpgrade: options.finish, build: options.build, upgrade: options.upgrade, speedUpUpgrade: options.speedUp };
  const resolver = makeTypeResolver(ctx.config);
  for (const step of plan.actions) {
    if (!enabledKinds[step.kind]) continue;
    const ids = Array.isArray(step.body.buildingId) ? step.body.buildingId : [step.body.buildingId];
    if (ids.some(id => options.disabledBuildings.includes(resolver(id)))) continue;
    const type = resolver(ids[0]);
    const level = survey.buildings.find(b => b.buildingId === ids[0])?.level;
    const row = ctx.rows('BuildingUpgradeCfg').find(r => r.buildingType === type && r.level === level + 1);
    const expenses = ['build', 'upgrade'].includes(step.kind) ? row?.consume : step.body.speedUp ? [['加速器', step.body.speedUp.useNum]] : [];
    if (['build', 'upgrade'].includes(step.kind) && !expenses) { skip(ctx, '缺少建筑消耗配置'); continue; }
    await mutate(ctx, step.request, step.body, 'OnWaterRequest', s => s.building?.filter(b => ids.includes(b.buildingId)), {
      label: step.label,
      response: step.response,
      expenses,
      // 成品收取读回滞后时只保留该写入的幂等锁，不能中断同一轮的其他挂机模块。
      continueAfterUncertain: step.kind === 'gainFactory',
    });
  }
  const f = options.factory;
  // 英雄突袭订单属于需求优先排产的一部分；关闭该排产时不能仅因进入海岛模块就额外消耗库存。
  if (f.priorityProduce) await completeHeroRaidOrder(ctx);
  // 预读募兵供跨午夜策略切换；排产器只在周一纳入额外来源，其他日期保持保存的来源顺序。
  // 英雄突袭只有当前活动推送有效时才贡献缺口；海兽喂养只在宠物执行日为培育队列补产材料。
  const petOptions = ctx.settings.modules.pet;
  const petFeedSource = petOptions.feed && moduleActive('pet', petOptions, ctx) ? ['petFeed'] : [];
  const needs = f.priorityProduce ? await demand(ctx, [...new Set([...f.proposedPriority, ...(f.mondayGuildPriority ? ['guild'] : []), 'heroRaid', ...petFeedSource])], { includeCovered: true }) : [];
  const water = await ctx.query('OnWaterRequest');
  for (const building of water.building ?? []) {
    if (!building.factory) continue;
    const type = resolver(building.buildingId);
    // 活动工厂由独立模块管理，不能被普通工厂消耗活动材料。
    if (type === '活动工厂' || options.disabledBuildings.includes(type)) continue;
    if (f.disabledFactories.includes(type)) {
      if (building.factory.autoProductId) await ctx.action('CancelFactoryAutoProduceRequest', { buildingId: building.buildingId }, { confirm: async () => !(await ctx.query('OnWaterRequest')).building?.find(b => b.buildingId === building.buildingId)?.factory?.autoProductId });
      continue;
    }
    // 三档调度负责需求排产，不再重复设置自动生产；已有游戏自动生产由服务端继续维护。
    if (f.priorityProduce || !f.autoProduce) continue;
    const select = s => s.building?.find(b => b.buildingId === building.buildingId)?.factory;
    const cap = ctx.rows('BuildingProduceParamCfg').find(r => r.paramName === '制造位上限')?.paramValue;
    if (!(cap > 0)) { skip(ctx, '缺少当前制造位上限', building.buildingId); continue; }
    const stockCap = ctx.rows('GameParamCfg').find(r => r.paramName === '产品存量初始上限')?.paramValue;
    if (!(stockCap > 0)) { skip(ctx, '缺少当前产品库存上限', building.buildingId); continue; }
    await repeat(ctx, cap, async () => {
      // 上一动作可能完成队列、消耗材料或改变自动生产，下一份必须按读回状态安排。
      const factory = select(await ctx.query('OnWaterRequest'));
      if (!factory) return false;
      const selected = f.products?.[type] ?? factory.autoProductId;
      const recipe = ctx.rows('BuildingProduceCfg').find(r => r.buildType === type && r.itemId === selected);
      if (!recipe || recipe.unlockLevel > building.level || !Array.isArray(recipe.costItem) || !ctx.enough(recipe.costItem)) return false;
      if (factory.autoProductId !== selected) {
        if (!succeeded(await mutate(ctx, 'SetFactoryAutoProduceRequest', { buildingId: building.buildingId, productId: selected }, 'OnWaterRequest', select))) return false;
      }
      const queue = factory.factoryQ ?? [];
      if (queue.length) return false;
      // 服务器在成品库存满时拒绝开工；读回当前库存后直接跳过，避免把拒绝当作排产控制流。
      if ((ctx.stock.get(selected) ?? 0) >= stockCap) {
        skip(ctx, `${selected} 产品库存已满`, building.buildingId);
        return false;
      }
      await mutate(ctx, 'StartFactoryProduceRequest', { buildingId: building.buildingId, productId: selected }, 'OnWaterRequest', select, { expenses: recipe.costItem });
      return false;
    });
  }
  if (f.priorityProduce) await scheduleProduction(ctx, f, needs, options.disabledBuildings);
}

/**
 * 从账本键还原待确认种植的地块和作物。
 *
 * @param {string} key 待确认请求的幂等键。
 * @returns {{buildingId: string, productId: string}|null} 可验证的种植目标；格式异常时返回 null。
 */
function pendingFarmPlant(key) {
  const prefix = 'FarmPlantRequest:';
  if (!key.startsWith(prefix)) return null;
  try {
    const [plant] = JSON.parse(key.slice(prefix.length)).args ?? [];
    return plant?.buildingId && plant?.productId ? plant : null;
  } catch { return null; }
}

/**
 * 找出同一块农田的所有待确认种植，作物不同也不能绕过地块级重复提交保护。
 *
 * @param {object} ctx 自动化上下文。
 * @param {string} buildingId 农田建筑 ID。
 * @returns {string[]} 同一农田的待确认请求键。
 */
function pendingFarmPlantKeys(ctx, buildingId) {
  return Object.keys(ctx.ledger.pending).filter(key => pendingFarmPlant(key)?.buildingId === buildingId);
}

/**
 * 用当前农田状态确认曾超时的种植请求，防止已落地的种植记录永久阻断后续自动化。
 *
 * 同一作物仍在生长时结算；跨业务日的记录早已不可能还在途中，而地块当前空着或已换作物，
 * 说明那次种植已不在生效状态，继续保留锁只会让这块田永远不能自动种植，按作废解除。
 *
 * @param {object} ctx 当前自动化上下文。
 * @param {object} water 最新 OnWater 快照。
 * @returns {void} 只处理能由地块当前状态判断的待确认请求。
 */
function reconcileFarmPlantPending(ctx, water) {
  const prefix = 'FarmPlantRequest:';
  const today = ctx.businessDate();
  for (const key of Object.keys(ctx.ledger.pending).filter(entry => entry.startsWith(prefix))) {
    const plant = pendingFarmPlant(key);
    if (!plant) continue;
    const pending = ctx.ledger.pending[key];
    const farm = water.building?.find(building => building.buildingId === plant.buildingId)?.farm;
    // 同一地块当前正种植同一作物，才足以证明之前的请求已经被服务端接受。
    if (farm?.productId === plant.productId) {
      if (ctx.settlePending(key)) ctx.record({ request: 'FarmPlantRequest', label: `恢复未确认种植 ${plant.productId}`, status: 'success', verifiedByRead: true });
      continue;
    }
    // 看不到该农田时不猜测；当天记录仍按地块级重复提交保护保留。
    if (!farm || pending.date === today) continue;
    if (ctx.discardPending(key)) {
      ctx.record({ request: 'FarmPlantRequest', label: `解除跨日未确认种植 ${plant.productId}`, status: 'skipped',
        reason: `地块 ${plant.buildingId} 已不在种植该作物，旧记录不再阻止今天的种植` });
    }
  }
}

/**
 * 在有限窗口内轮询农田快照，等待静默种植请求写入服务端状态。
 *
 * FarmPlantRequest 没有专用响应；首次 OnWater 读回可能早于异步落库，短暂轮询可以避免把已接受的请求误记为未确认。
 *
 * @param {object} ctx 自动化上下文。
 * @param {string} buildingId 目标农田建筑 ID。
 * @param {string} productId 目标作物 ID。
 * @returns {Promise<boolean>} 当前农田明确显示目标作物时返回 true。
 */
async function confirmFarmPlant(ctx, buildingId, productId) {
  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      // 静默写入后的状态同步有延迟；等待后重读，不重新发送写请求。
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const farm = (await ctx.query('OnWaterRequest')).building?.find(building => building.buildingId === buildingId)?.farm;
    if (farm?.productId === productId) return true;
  }
  return false;
}

/**
 * 农田按照实际产量、背包和在田数量计算备货，缺种子时只排真实配方。
 *
 * @param {object} ctx 自动化上下文。
 * @param {object} options 已验证的农田模块设置。
 * @returns {Promise<void>} 收割、种植和加速处理完毕后返回。
 */
export async function farm(ctx, options) {
  let water = await ctx.query('OnWaterRequest');
  reconcileFarmPlantPending(ctx, water);
  const now = ctx.now() / 1000;
  const ripe = (water.building ?? []).filter(b => b.farm?.productId && b.farm.ripeTime <= now);
  if (options.harvest && ripe.length) await ctx.action('FarmHarvestRequest', { buildingId: ripe.map(b => b.buildingId) });
  if (!ctx.dryRun) water = await ctx.query('OnWaterRequest');
  // 服务端对空闲农田会省略 farm 字段；通过建筑配置识别这类空田，同时保留已有 farm 状态的识别。
  const resolveType = makeTypeResolver(ctx.config);
  const isFarmBuilding = building => Boolean(building.farm) || resolveType(building.buildingId) === '农田';
  const plots = (water.building ?? []).filter(isFarmBuilding);
  const shortages = options.priorityPlant ? await demand(ctx) : [];
  const inField = new Map();
  for (const b of plots) if (b.farm?.productId) { const cfg = ctx.rows('FarmlandPlantCfg').find(r => r.id === b.farm.productId); inField.set(b.farm.productId, (inField.get(b.farm.productId) ?? 0) + (cfg?.produceNum ?? 0)); }
  if (options.plant) {
    if (water.autoFarming) await ctx.action('SetAutoFarmingRequest', { isOn: false }, { confirm: async () => !(await ctx.query('OnWaterRequest')).autoFarming });
    const crops = ctx.rows('FarmlandPlantCfg').filter(r => Number(options.cropPriorities[r.id]) > 0).sort((a, b) => Number(options.cropPriorities[a.id]) - Number(options.cropPriorities[b.id]));
    for (const plot of plots.filter(b => !b.farm?.productId)) {
      // 订单缺口先于普通备货；各组内部再使用用户设置的作物优先级。
      const crop = crops.find(r => shortages.some(n => n.id === r.id && n.lack > (inField.get(r.id) ?? 0)))
        ?? crops.find(r => Number(options.cropKeepStock[r.id]) > (ctx.stock.get(r.id) ?? 0) + (inField.get(r.id) ?? 0));
      if (!crop) break;
      const pendingKeys = pendingFarmPlantKeys(ctx, plot.buildingId);
      if (pendingKeys.length) {
        // 账本曾以作物区分种植键；此处按地块汇总，避免改作物后对同一块空田再次发包。
        ctx.record({ request: 'FarmPlantRequest', label: `农田 ${plot.buildingId}`, status: 'uncertain', reason: '该农田上次种植结果未确认，禁止重复提交' });
        continue;
      }
      if (!ctx.enough([crop.material])) {
        if (options.seedOnDemand) {
          const recipe = ctx.rows('BuildingProduceCfg').find(r => r.itemId === crop.material[0]);
          const resolver = makeTypeResolver(ctx.config);
          const disabled = ctx.settings.modules.island.factory.disabledFactories;
          const current = await ctx.query('OnWaterRequest');
          const cap = ctx.rows('BuildingProduceParamCfg').find(r => r.paramName === '制造位上限')?.paramValue;
          const factory = recipe && cap > 0 && !disabled.includes(recipe.buildType) && !ctx.settings.modules.island.disabledBuildings.includes(recipe.buildType)
            && current.building?.find(b => resolver(b.buildingId) === recipe.buildType && b.level >= recipe.unlockLevel && b.factory && (b.factory.factoryQ?.length ?? 0) < cap);
          const need = Math.max(shortages.find(n => n.id === crop.id)?.lack ?? 0, (options.cropKeepStock[crop.id] ?? 0) - (ctx.stock.get(crop.id) ?? 0)) - (inField.get(crop.id) ?? 0);
          // 空田同样可能缺少 farm 字段，必须按建筑类型统计，否则种子补充计划会误判为空田数。
          const emptyPlots = current.building?.filter(b => isFarmBuilding(b) && !b.farm?.productId).length ?? 0;
          const seedTarget = crop.produceNum > 0 ? Math.min(emptyPlots, Math.ceil(Math.max(0, need) / crop.produceNum)) * crop.material[1] : 0;
          // 缺种子时只补足计划种植所需数量，现有队列和成品也要抵扣，不能每块空田重复排同一缺口。
          const pendingSeeds = (current.building ?? []).reduce((sum, b) => sum + (b.factory?.factoryQ?.filter(q => q.productId === crop.material[0]).length ?? 0)
            + costs(b.factory?.finishedProducts, ctx.protocol).filter(([id]) => id === crop.material[0]).reduce((n, [, count]) => n + count, 0), 0);
          if (factory && (ctx.stock.get(crop.material[0]) ?? 0) + pendingSeeds < seedTarget && ctx.enough(recipe.costItem)) {
            const result = await mutate(ctx, 'StartFactoryProduceRequest', { buildingId: factory.buildingId, productId: recipe.itemId }, 'OnWaterRequest', s => s.building?.find(b => b.buildingId === factory.buildingId)?.factory, { expenses: recipe.costItem });
            if (ctx.dryRun && succeeded(result)) return skip(ctx, '缺种子，先完成生产后重新规划种植');
          }
        }
        skip(ctx, `${crop.id} 缺少种子`); continue;
      }
      const result = await mutate(ctx, 'FarmPlantRequest', { args: [{ buildingId: plot.buildingId, productId: crop.id }] }, 'OnWaterRequest', s => s.building?.find(b => b.buildingId === plot.buildingId)?.farm, {
        expenses: [crop.material],
        confirm: async () => confirmFarmPlant(ctx, plot.buildingId, crop.id),
        // 种植未知只隔离当前农田；不同地块和后续独立模块仍可继续处理。
        continueAfterUncertain: true,
      });
      if (succeeded(result)) inField.set(crop.id, (inField.get(crop.id) ?? 0) + crop.produceNum);
    }
  }
  if (options.speedUp) for (const plot of plots.filter(b => b.farm?.productId && b.farm.ripeTime > now).sort((a, b) => a.farm.ripeTime - b.farm.ripeTime).slice(0, options.speedUpMaxActions)) {
    if ((ctx.stock.get('加速器') ?? 0) <= 0) break;
    await mutate(ctx, 'FarmSpeedUpRequest', { buildingId: plot.buildingId, param: { type: 2, useNum: 1 } }, 'OnWaterRequest', s => s.building?.find(b => b.buildingId === plot.buildingId)?.farm, { expenses: [['加速器', 1]] });
  }
}

/** 居民订单先按经验和金币重刷低收益订单，收益达标后再检查材料过滤与库存。 */
export async function resident(ctx, options) {
  const water = await ctx.query('OnWaterRequest');
  const crops = new Set(ctx.rows('FarmlandPlantCfg').map(r => r.id));
  let done = amount(water.orderOfTheDay?.orderNum);
  for (const order of water.workerOrder ?? []) {
    if (order.refreshTime > ctx.now() / 1000 || (options.dailyCap > 0 && done >= options.dailyCap)) continue;
    const needed = costs(order.requirements, ctx.protocol);
    const rewards = new Map();
    // 特殊订单的奖励由 textId/times 直接索引，不按普通订单材料重复累加，否则阈值判断会偏离服务端实际奖励。
    const special = order.isSpecial
      ? ctx.rows('WorkerSpecOrderCfg').find(row => String(row.times) === String(order.textId))
      : null;
    // 特殊订单缺配置时不能套用普通订单奖励，避免误交或误刷新。
    if (order.isSpecial && !special?.reward?.length) { skip(ctx, '缺少特殊订单实际奖励配置', `订单 ${order.index}`); continue; }
    if (special) for (const [resource, num] of special.reward ?? []) rewards.set(resource, (rewards.get(resource) ?? 0) + num);
    else for (const [id, quantity] of needed) for (const [resource, num] of ctx.rows('WorkerOrderCfg').find(r => r.itemId === id)?.reward ?? []) rewards.set(resource, (rewards.get(resource) ?? 0) + num * quantity);
    // 收益不达标的订单不值得等待备料，必须在材料过滤和库存检查之前拒单重刷。
    // 基地订单日金币越高比拼积分越多，周四专用门槛替换普通门槛，0 不限制。
    /** 读到实际提交点的上海星期，避免跨午夜沿用旧门槛。 */
    const minGold = () => shanghaiWeekday(serverTime(ctx)) === 'thursday' ? options.thursdayMinGold : options.minGold;
    if ((rewards.get('EXP') ?? 0) < options.minExp || (rewards.get('GOLD') ?? 0) < minGold()) {
      await mutate(ctx, 'DenyOrderRequest', { index: order.index }, 'OnWaterRequest', state => state.workerOrder, { allowed: () => (rewards.get('EXP') ?? 0) < options.minExp || (rewards.get('GOLD') ?? 0) < minGold() });
      continue;
    }
    if (needed.some(([id]) => options.blockedMaterials.includes(id) || (options.skipCropOrders && crops.has(id)))) continue;
    // 只有收益达标的缺料订单才保留，等待后续生产补齐材料。
    if (!ctx.enough(needed)) { skip(ctx, '订单材料不足', `订单 ${order.index}`); continue; }
    const result = await ctx.action('FinishWorkerOrderRequest', { index: order.index }, { expenses: needed, allowed: () => (rewards.get('GOLD') ?? 0) >= minGold() });
    if (succeeded(result)) done++;
  }
  if (options.orderReward) await repeat(ctx, 20, async () => {
    const state = await ctx.query('OnWaterRequest'); const o = state.orderOfTheDay;
    // 档位赛季由游戏客户端按 worldId 推导（WorkerOrderUtil），与设置的“当前赛季”（地图场景）
    // 不是同一概念；按设置过滤会把档位表锁死在错误分组上（如设置填 1 时永远看不到 45 档）。
    // 登录快照缺 worldId/开服时间导致档组解析不出来时，当天首次用全表并集探测一次。
    const probeKey = 'resident.orderReward.probe';
    const tier = nextOrderTier(ctx.config, { orderNum: amount(o?.orderNum), rewardedNum: amount(o?.rewardedNum), player: ctx.player, now: serverTime(ctx) / 1000, probe: !ctx.count(probeKey) });
    if (tier.tier === null || !tier.claimable) return false;
    const result = await ctx.action('GetNextOrderOTDRewardRequest', {}, { confirm: async () => (await ctx.query('OnWaterRequest')).orderOfTheDay?.rewardedNum > o.rewardedNum });
    // 探测请求被拒（或结果未确认）说明档组确实无从确认，当天不再重发；真实档位走正常解析路径。
    if (tier.probed && !succeeded(result)) ctx.count(probeKey, 1);
    return succeeded(result);
  });
}

/** 货船逐舱按真实需求装填，舱位使用客户端的 1-based 索引。 */
export async function cargo(ctx, options) {
  const state = await ctx.query('CargoShipsRequest');
  for (const ship of state.ship ?? []) {
    if (options.reward && ship.status === ctx.protocol.CargoShipStatus.ARRIVED) await ctx.action('DrawShipRewardRequest', { index: ship.index });
    if (!options.fill || ship.status !== ctx.protocol.CargoShipStatus.IN_ORDER) continue;
    for (const [index, item] of (ship.orderItem ?? []).entries()) if (!item.filled && ctx.enough(costs([item.asset], ctx.protocol))) await ctx.action('FillCargoShipRequest', { shipIndex: ship.index, cargoIndex: [index + 1] }, { expenses: costs([item.asset], ctx.protocol) });
  }
}

/**
 * 重启后核对选择事件的未确认记录，只在新推送明确移除事件时结算账本。
 * 没有新状态证据时保留 pending，确保改选另一侧也不会重复提交同一 UID。
 */
async function reconcileChoicePending(ctx) {
  const prefix = 'SelectChoiceRequest:';
  const pending = Object.keys(ctx.ledger.pending).filter(key => key.startsWith(prefix));
  if (!pending.length) return;
  const updates = await awaitPush(ctx, ['SCChoiceEventUpdate'], () => ctx.query('OnWaterRequest'), 1500);
  const current = updates.at(-1)?.body ?? ctx.pushes.get('SCChoiceEventUpdate');
  if (!current || !Array.isArray(current.events)) return;
  const active = new Set(current.events.map(event => idString(event.uid)));
  for (const key of pending) {
    const uid = key.slice(prefix.length);
    if (uid && !active.has(uid) && ctx.settlePending(key)) {
      ctx.record({ request: 'SelectChoiceRequest', label: '恢复未确认选择事件', status: 'success', verifiedByRead: true });
    }
  }
}

/** 选择事件只执行配置选项；未确认时隔离本模块，避免阻断世界雷达等独立玩法。 */
export async function choiceEvent(ctx, options) {
  if (![1, 2].includes(options.optionIndex)) return skip(ctx, '选择事件选项必须为 1 或 2');
  await reconcileChoicePending(ctx);
  const messages = ctx.pushes.has('SCChoiceEventUpdate') ? [{ body: ctx.pushes.get('SCChoiceEventUpdate') }] : await awaitPush(ctx, ['SCChoiceEventUpdate'], () => ctx.query('OnWaterRequest'), 1500);
  for (const message of messages) for (const event of message.body.events ?? []) {
    // 选择事件只有推送，没有专用查询；需要后续推送明确移除此事件才能确认。
    // 锁键只使用事件 UID，避免改选项后绕过上次未确认结果的重复提交保护。
    const result = await ctx.action('SelectChoiceRequest', { uid: event.uid, optionIndex: options.optionIndex }, { key: `SelectChoiceRequest:${idString(event.uid)}`, continueAfterUncertain: true, confirm: async () => {
      await ctx.query('OnWaterRequest');
      const current = ctx.pushes.get('SCChoiceEventUpdate');
      return current !== message.body && !current?.events?.some(e => idString(e.uid) === idString(event.uid));
    } });
    if (result.status === 'uncertain') return;
  }
}

/**
 * 解除历史遗留的抛竿未确认记录。
 *
 * 抛竿没有消耗，也没有可读回的状态字段，无法证明服务端是否执行过这一竿；
 * 保留跨轮锁只会让钓鱼永久停摆，因此按“本竿作废、下一轮重新抛竿”解除。
 *
 * @param {object} ctx 当前账号自动化上下文。
 * @returns {void}
 */
function reconcileFishingCastPending(ctx) {
  const prefix = 'StartFishingRequest:';
  for (const key of Object.keys(ctx.ledger.pending).filter(entry => entry.startsWith(prefix))) {
    if (ctx.discardPending(key)) ctx.record({ request: 'StartFishingRequest', label: '解除上次未确认的抛竿', status: 'skipped', reason: '抛竿没有消耗和可读回状态，旧记录按本竿作废处理' });
  }
}

/**
 * 执行采集、钓鱼和采集设施强化；每次写入仍受当前账号的幂等保护。
 *
 * @param {object} ctx 当前账号自动化上下文。
 * @param {object} options 当前采集模块设置。
 * @returns {Promise<void>} 无可执行动作或采集批次完成后返回。
 */
export async function gather(ctx, options) {
  const water = await ctx.query('OnWaterRequest');
  if (options.floater) {
    const effects = await ctx.query('GameEffectRequest');
    const capacity = effects.effects?.find(e => e.id === ctx.protocol.GameEffectId.RAW_MATERIAL_UPPER_BOUND)?.value;
    if (!options.floaterCollectWhenFull && !(capacity > 0)) skip(ctx, '缺少当前仓库容量，跳过普通浮漂');
    const ids = (water.floater ?? []).filter(f => options.floaterCollectWhenFull || f.floaterId.includes('宝箱') || (capacity > 0 && (ctx.stock.get(f.floaterId) ?? 0) < capacity)).map(f => f.floaterId);
    for (let i = 0; i < ids.length; i += 20) await ctx.action('PickUpFloaterRequest', { floaterId: ids.slice(i, i + 20) });
  }
  if (options.fishing) {
    reconcileFishingCastPending(ctx);
    await repeat(ctx, options.maxFishCasts, async () => {
      // 抛竿零消耗，超时只停止本轮抛竿；跨轮锁会让一次丢包永久关闭钓鱼。
      const result = await ctx.action('StartFishingRequest', {}, { continueAfterUncertain: true, blockModuleOnUncertain: false, lockOnUncertain: false });
      if (!succeeded(result)) return false;
      // 收线同样是零消耗声明；超时只放弃本轮，不能让一次丢包结束持续挂机。
      if (result.value?.fishId > 0) return succeeded(await ctx.action('GainBigFishRequest', {}, { response: 'GainBigResponse', continueAfterUncertain: true, blockModuleOnUncertain: false, lockOnUncertain: false }));
      return true;
    });
  }
  if (options.openChests) await repeat(ctx, options.maxChests, async () => {
    if (!ctx.rows('ItemCfg').some(r => r.id === '保险箱钥匙') || (ctx.stock.get('保险箱钥匙') ?? 0) < 1) return false;
    return succeeded(await ctx.action('AntiqueRecruitRequest', { type: ctx.protocol.AntiqueRecruitType.RECRUIT_DIVE, way: ctx.protocol.RecruitWay.RECRUIT_SINGLE }, { expenses: [['保险箱钥匙', 1]] }));
  });
  if (options.diving || options.salvage) {
    const capacity = (await ctx.query('GameEffectRequest')).effects?.find(e => e.id === ctx.protocol.GameEffectId.RAW_MATERIAL_UPPER_BOUND)?.value;
    if (!(capacity > 0)) skip(ctx, '缺少仓库容量，跳过潜水与拾荒');
    else {
      if (options.diving) {
        const known = new Set(ctx.rows('DiveItemsDefinitionCfg').map(r => r.produce?.[0]));
        const asset = ['海藻', '金属', '玻璃'].filter(id => known.has(id)).map(id => ({ type: 0, id, num: Math.min(options.divingEach, Math.max(0, capacity - (ctx.stock.get(id) ?? 0))) })).filter(a => a.num > 0);
        if (asset.length && water.divingLevel) await ctx.action('DivingRequest', { reward: { asset } });
        else skip(ctx, '潜水未开放、满仓或缺少当前产出配置');
      }
      if (options.salvage) {
        const pickedFloaters = ['塑料垃圾1', '木材垃圾1', '布垃圾1'].map(floaterId => {
          const product = ctx.rows('GarbageProductionCfg').find(r => r.id === floaterId)?.production;
          // 垃圾数量换算为实际产物容量，不能把垃圾数当作材料数。
          const room = product?.[1] > 0 ? Math.floor(Math.max(0, capacity - (ctx.stock.get(product[0]) ?? 0)) / product[1]) : 0;
          return { floaterId, num: Math.min(options.salvageEach, room) };
        }).filter(row => row.num > 0);
        if (pickedFloaters.length && water.salvageLevel) await ctx.action('EndSalvageRequest', { pickedFloaters });
        else skip(ctx, '拾荒未开放、满仓或缺少当前产出配置');
      }
    }
  }
  for (const [key, prefix, table] of [['fishing', 'Fishing', 'FishLevelCfg'], ['diving', 'Diving', 'DiveLevelCfg'], ['salvage', 'Salvage', 'SalvageLevelCfg']]) if (options.enhance[key]) await repeat(ctx, 8, async () => {
    const state = await ctx.query('OnWaterRequest'), level = state[`${key}Level`]?.level;
    if (level === undefined || level >= options.enhanceTargetLevel) return false;
    const row = ctx.rows(table).find(r => r.level === level);
    if (!row?.cost?.length) { skip(ctx, '缺少当前采集强化消耗'); return false; }
    return succeeded(await mutate(ctx, `${prefix}LevelUpRequest`, {}, 'OnWaterRequest', s => s[`${key}Level`], { expenses: [row.cost] }));
  });
}

// 客户端付费点金批量上限（十连按钮）；单请求超过该次数会被服务端以 BUSINESS_BLOCKING 拒绝。
const PAID_GOLD_BATCH = 10;

/**
 * 先用完当天的免费点金，再按服务端付费次数补足用户的钻石点金目标，并将实际花费归属挂机模块。
 *
 * 免费次数不花钻石，必须先于付费；挂机收益模块接管日常 1006 后旧日常不再执行，所以免费次数也要在这里用掉。
 * 写入前读取 ClickGoldInfo，付费回包后再次读取 paidTimes，避免单一回包或旧快照导致重复扣钻。
 *
 * @param {object} ctx 自动化上下文。
 * @returns {Promise<void>} 未配置、已达目标、缺少服务端状态或写入结束后返回。
 */
async function serviceClickGold(ctx) {
  const target = ctx.settings.spending.clickGoldTimes;
  if (!Number.isSafeInteger(target) || target <= 0) return;

  await ctx.refreshStock();
  const info = (await ctx.query('ClickGoldInfoRequest')).info;
  const paidTimes = Number(info?.paidTimes);
  const maxPaidTimes = Number(info?.maxPaidTimes);
  if (!Number.isSafeInteger(paidTimes) || paidTimes < 0 || !Number.isSafeInteger(maxPaidTimes) || maxPaidTimes < paidTimes) {
    skip(ctx, '服务端未返回有效的付费点金次数或当日上限', '付费点金');
    return;
  }

  // 免费点金上限来自 OfflineParamCfg，已用次数是服务端 freeTimes；先领完免费次数再花钻石。
  const freeLimit = Number(ctx.rows('OfflineParamCfg').find(row => row.paramName === '免费点金次数')?.paramValue);
  if (Number.isSafeInteger(freeLimit) && freeLimit > 0) {
    const recorded = Number(info?.freeTimes);
    // 解码器对缺省字段会给出 0；次数无效时按未用过处理，服务端拒绝免费点金时不会扣钻。
    const freeTimes = Number.isSafeInteger(recorded) && recorded > 0 ? recorded : 0;
    for (let left = freeLimit - freeTimes; left > 0; left -= 1) {
      // 免费点金客户端固定 times:1 一次一发；没有钻石消耗，超时只放弃本轮，下一轮按 freeTimes 重新判断。
      const result = await ctx.action('ClickGoldRequest', { times: 1, free: true }, {
        label: '免费点金 x1',
        response: 'ClickGoldResponse',
        continueAfterUncertain: true,
        blockModuleOnUncertain: false,
        lockOnUncertain: false,
      });
      if (!succeeded(result)) break;
    }
  }

  if (paidTimes >= target) return;

  const price = Number(ctx.rows('OfflineParamCfg').find(row => row.paramName === '点金价格')?.paramValue);
  if (!Number.isSafeInteger(price) || price <= 0) {
    skip(ctx, '缺少有效的付费点金价格', '付费点金');
    return;
  }

  const requested = target - paidTimes;
  const times = Math.min(requested, maxPaidTimes - paidTimes);
  if (times <= 0) {
    skip(ctx, `付费点金目标 ${target} 次未完成：服务端当日上限 ${maxPaidTimes} 次已用完`, '付费点金');
    return;
  }
  if (times < requested) {
    // 目标高于服务端当日上限时，只提交已被服务端明确允许的次数，不能把拒绝当作正常流程。
    skip(ctx, `付费点金目标 ${target} 次超过服务端当日上限 ${maxPaidTimes} 次，本次最多执行 ${times} 次`, '付费点金');
  }

  // 客户端批量最多十连；一次发送超过 10 次会被服务端以 BUSINESS_BLOCKING 拒绝（实测 17 连），
  // 无法整除的余数按客户端同样支持的“点金一次”逐次补足。
  let cursor = paidTimes;
  const limit = paidTimes + times;
  while (cursor < limit) {
    const batch = limit - cursor >= PAID_GOLD_BATCH ? PAID_GOLD_BATCH : 1;
    const ruby = price * batch;
    if (!Number.isSafeInteger(ruby)) {
      skip(ctx, '付费点金钻石消耗无效', '付费点金');
      return;
    }
    const expectedPaidTimes = cursor + batch;
    const result = await ctx.action('ClickGoldRequest', { times: batch, free: false }, {
      label: `付费点金 x${batch}`,
      ruby,
      response: 'ClickGoldResponse',
      confirmAfterResponse: true,
      // ClickGoldResponse 只能证明协议回包已收到；只有 paidTimes 增长才证明当天次数和扣钻动作已落到服务端状态。
      confirm: async () => Number((await ctx.query('ClickGoldInfoRequest')).info?.paidTimes) >= expectedPaidTimes,
    });
    if (!succeeded(result)) return;
    cursor = expectedPaidTimes;
  }
}

// 2026-11-11 抓包：挂机广告奖励走 WatchAdvRequest{type:ADV_EFFECT,id:1} 登记后
// DrawAfkRewardRequest{useAdvCard:true} 领取；AdvEffectCfg id=1 每日 1 次，免广告权益免去播放。
const AFK_AD_ID = 1;

/** 与挑战模块试炼扫荡同一条资格线：用户勾选 VIP免广告、角色 10 级、VIP 3 级且连接在线。 */
function vipAfkAdEnabled(ctx) {
  // 本轮收到的 VIP 推送优先于登录快照，避免升档或降档后继续使用过期资格。
  const vipLevel = ctx.pushes.get('SCVipUpdate')?.vipLevel ?? ctx.player?.vip?.vipLevel;
  return ctx.settings.vipFreeAd === true && ctx.client.connected
    && Number.isSafeInteger(ctx.player.level) && ctx.player.level >= 10
    && Number.isSafeInteger(vipLevel) && vipLevel >= 3;
}

/**
 * 用 VIP 免广告权益领取挂机广告额外奖励（每日 1 次）。
 *
 * 抓包确认该领取不依赖挂机累计时长：普通领取后立即执行也能拿到完整额外奖励。
 * 广告额度与其他玩法彼此独立，服务端 gotTimes 是当日是否已领取的唯一权威；
 * 本地尝试次数只防同一轮内的重复提交，登记锁跨业务日由公共释放逻辑处理。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @returns {Promise<void>} 领取完成或跳过后返回。
 */
async function vipAfkAdDraw(ctx) {
  const type = ctx.protocol.AdvType?.ADV_EFFECT;
  const rule = ctx.rows('AdvEffectCfg').find(row => row.id === AFK_AD_ID);
  if (type === undefined || !Number.isSafeInteger(rule?.dailyLimit) || rule.dailyLimit <= 0) return skip(ctx, '挂机广告缺少额度配置');
  const state = (await ctx.query('OnWaterRequest')).adv?.find(row => row.id === AFK_AD_ID);
  if (!Number.isSafeInteger(state?.gotTimes) || state.gotTimes < 0) return skip(ctx, '挂机广告缺少服务端次数');
  const countKey = 'afk.vipAdDraw';
  const registrationKey = `WatchAdvRequest:${JSON.stringify({ type, id: AFK_AD_ID })}`;
  discardExpiredVipRegistration(ctx, registrationKey);
  // 领取键带业务日：未确认记录只在当天回放（写前快照已落盘，回放绝不重发），
  // 跨天换成新键、旧记录由跨日释放逻辑作废，不会永久封死每天的领取。
  const drawKey = `DrawAfkRewardRequest:${ctx.businessDate()}:${JSON.stringify({ useAdvCard: true })}`;
  const drawOptions = {
    response: 'DrawAfkRewardResponse', label: '挂机 VIP免广告额外奖励',
    accept: value => value?.reward?.assetPackage?.asset?.some(asset => amount(asset.num) > 0) === true
      || (value?.reward?.badge?.length ?? 0) > 0,
    // 回包丢失时按写前后的 gotTimes 证明领取已生效；服务端重置归零后旧记录不可回放，
    // 所以回放核验只在当天有效，这正是业务日键的目的。
    beforeState: JSON.stringify(state.gotTimes),
    replayConfirm: async stored => {
      const after = (await ctx.query('OnWaterRequest')).adv?.find(row => row.id === AFK_AD_ID);
      return Number.isSafeInteger(after?.gotTimes) && JSON.stringify(after.gotTimes) !== stored;
    },
    continueAfterUncertain: true, blockModuleOnUncertain: false,
  };
  if (ctx.hasPending(drawKey)) {
    // 登记已在创建该记录的一轮成功，这里只回放领取，不再重发登记。
    await ctx.action('DrawAfkRewardRequest', { useAdvCard: true }, drawOptions);
    return;
  }
  if (state.gotTimes >= rule.dailyLimit || ctx.count(countKey) >= rule.dailyLimit) return;
  // 只读查询期间也可能收到 VIP 更新，写入前再次核对当前资格。
  if (!vipAfkAdEnabled(ctx)) return;
  // 先保存尝试次数：进程退出、登记拒绝或空奖励回包后，本日也不能重发同一组请求。
  if (!ctx.dryRun) ctx.count(countKey, 1);
  const registered = await ctx.action('WatchAdvRequest', { type, id: AFK_AD_ID }, {
    response: 'OkResponse', label: '挂机 VIP免广告登记',
    key: registrationKey,
    // 登记与挂机奖励彼此独立；账本仍锁定当前登记，继续执行不会重复发这条请求。
    continueAfterUncertain: true, blockModuleOnUncertain: false,
  });
  if (!succeeded(registered)) return;
  if (!vipAfkAdEnabled(ctx)) return;
  // VIP 免去播放，仍须登记广告权益；抓包的实际成功证据是带奖励内容的回包。
  await ctx.action('DrawAfkRewardRequest', { useAdvCard: true }, drawOptions);
}

/** 挂机领取使用累计时长，等级上限和等级奖励来自当前配置。 */
export async function afk(ctx, options) {
  const state = await ctx.query('AfkInfoRequest'); const info = state.afkInfo;
  if (!info) return skip(ctx, '没有挂机状态');
  if (options.claim && info.afkStartTime > 0 && Math.min(ctx.now() / 1000, info.afkFinishTime) - info.afkStartTime >= Math.max(1, options.claimAfterHours * 3600)) await ctx.action('DrawAfkRewardRequest');
  if (vipAfkAdEnabled(ctx)) await vipAfkAdDraw(ctx);
  if (options.levelUp) await repeat(ctx, 50, async () => {
    const current = (await ctx.query('AfkInfoRequest')).afkInfo;
    if (current.level >= ctx.config.afkMaxLevel(ctx.player.mainlineStage)) return false;
    const row = ctx.rows('OfflineCfg').find(r => r.level === current.level + 1);
    if (!row?.consume?.length) return false;
    // 协议字段表示本次增加的等级数；消耗仍按将要到达的下一等级配置计算。
    return succeeded(await ctx.action('UpgradeAfkLevelRequest', { level: 1 }, { expenses: [row.consume] }));
  });
  if (options.levelReward) await repeat(ctx, 50, async () => { const current = (await ctx.query('AfkInfoRequest')).afkInfo; const next = ctx.config.nextAfkRewardLevel(current.rewardedLevel); if (!next || next > current.level) return false; return succeeded(await ctx.action('DrawAfkLevelRewardRequest', { level: next })); });
  await serviceClickGold(ctx);
}
