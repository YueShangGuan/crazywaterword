import { surveyWorld, planWorld, makeTypeResolver } from '../world.mjs';
import { amount, idString } from './context.mjs';
import { costs, repeat, succeeded, skip, awaitPush, mutate, reconcileFactoryHarvestPending } from './common.mjs';
import { openDays } from './activity.mjs';
import { scheduleProduction } from './production.mjs';
import { serverTime, shanghaiWeekday } from './schedule.mjs';

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
 * 汇总居民、货船、联盟和当前英雄突袭的实际需求，按来源顺序分配同一份库存。
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
  const plan = planWorld(survey, { config: ctx.config, allowSpeedUp: options.speedUp });
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
  // 英雄突袭只有当前活动推送有效时才贡献缺口。
  const needs = f.priorityProduce ? await demand(ctx, [...new Set([...f.proposedPriority, ...(f.mondayGuildPriority ? ['guild'] : []), 'heroRaid'])], { includeCovered: true }) : [];
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
 * @param {object} ctx 自动化上下文。
 * @param {object} water 最新 OnWater 快照。
 * @returns {void} 只结算能由相同地块和作物明确证明的待确认请求。
 */
function reconcileFarmPlantPending(ctx, water) {
  const prefix = 'FarmPlantRequest:';
  for (const key of Object.keys(ctx.ledger.pending).filter(entry => entry.startsWith(prefix))) {
    const plant = pendingFarmPlant(key);
    if (!plant) continue;
    const farm = water.building?.find(building => building.buildingId === plant.buildingId)?.farm;
    // 同一地块当前正种植同一作物，才足以证明之前的请求已经被服务端接受。
    if (farm?.productId === plant.productId && ctx.settlePending(key)) {
      ctx.record({ request: 'FarmPlantRequest', label: `恢复未确认种植 ${plant.productId}`, status: 'success', verifiedByRead: true });
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
    const days = openDays(ctx.player.worldOpenTime, ctx.now());
    const tier = ctx.rows('OrderDailyRewardCfg').filter(r => r.season === ctx.season && r.worldOpenDays <= days).sort((a, b) => a.reqNum - b.reqNum).find(r => r.reqNum > (o?.rewardedNum ?? 0));
    if (!tier || tier.reqNum > (o?.orderNum ?? 0)) return false;
    return succeeded(await ctx.action('GetNextOrderOTDRewardRequest', {}, { confirm: async () => (await ctx.query('OnWaterRequest')).orderOfTheDay?.rewardedNum > o.rewardedNum }));
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

/** 采集沿用参考项目的真实请求链，次数受设置及服务端资源共同约束。 */
export async function gather(ctx, options) {
  const water = await ctx.query('OnWaterRequest');
  if (options.floater) {
    const effects = await ctx.query('GameEffectRequest');
    const capacity = effects.effects?.find(e => e.id === ctx.protocol.GameEffectId.RAW_MATERIAL_UPPER_BOUND)?.value;
    if (!options.floaterCollectWhenFull && !(capacity > 0)) skip(ctx, '缺少当前仓库容量，跳过普通浮漂');
    const ids = (water.floater ?? []).filter(f => options.floaterCollectWhenFull || f.floaterId.includes('宝箱') || (capacity > 0 && (ctx.stock.get(f.floaterId) ?? 0) < capacity)).map(f => f.floaterId);
    for (let i = 0; i < ids.length; i += 20) await ctx.action('PickUpFloaterRequest', { floaterId: ids.slice(i, i + 20) });
  }
  if (options.fishing) await repeat(ctx, options.maxFishCasts, async () => { const result = await ctx.action('StartFishingRequest'); if (result.value?.fishId > 0) return succeeded(await ctx.action('GainBigFishRequest', {}, { response: 'GainBigResponse' })); return succeeded(result); });
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

/**
 * 按当天服务端付费次数补足用户的钻石点金目标，并将实际花费归属挂机模块。
 *
 * 免费次数不属于此目标；写入前读取 ClickGoldInfo，回包后再次读取 paidTimes，避免单一回包或旧快照导致重复扣钻。
 *
 * @param {object} ctx 自动化上下文。
 * @returns {Promise<void>} 未配置、已达目标、缺少服务端状态或写入结束后返回。
 */
async function paidClickGold(ctx) {
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
  const ruby = price * times;
  if (!Number.isSafeInteger(ruby)) {
    skip(ctx, '付费点金钻石消耗无效', '付费点金');
    return;
  }
  const expectedPaidTimes = paidTimes + times;
  await ctx.action('ClickGoldRequest', { times, free: false }, {
    label: `付费点金 x${times}`,
    ruby,
    response: 'ClickGoldResponse',
    confirmAfterResponse: true,
    // ClickGoldResponse 只能证明协议回包已收到；只有 paidTimes 增长才证明当天次数和扣钻动作已落到服务端状态。
    confirm: async () => Number((await ctx.query('ClickGoldInfoRequest')).info?.paidTimes) >= expectedPaidTimes,
  });
}

/** 挂机领取使用累计时长，等级上限和等级奖励来自当前配置。 */
export async function afk(ctx, options) {
  const state = await ctx.query('AfkInfoRequest'); const info = state.afkInfo;
  if (!info) return skip(ctx, '没有挂机状态');
  if (options.claim && info.afkStartTime > 0 && Math.min(ctx.now() / 1000, info.afkFinishTime) - info.afkStartTime >= Math.max(1, options.claimAfterHours * 3600)) await ctx.action('DrawAfkRewardRequest');
  if (options.levelUp) await repeat(ctx, 50, async () => {
    const current = (await ctx.query('AfkInfoRequest')).afkInfo;
    if (current.level >= ctx.config.afkMaxLevel(ctx.player.mainlineStage)) return false;
    const row = ctx.rows('OfflineCfg').find(r => r.level === current.level + 1);
    if (!row?.consume?.length) return false;
    // 协议字段表示本次增加的等级数；消耗仍按将要到达的下一等级配置计算。
    return succeeded(await ctx.action('UpgradeAfkLevelRequest', { level: 1 }, { expenses: [row.consume] }));
  });
  if (options.levelReward) await repeat(ctx, 50, async () => { const current = (await ctx.query('AfkInfoRequest')).afkInfo; const next = ctx.config.nextAfkRewardLevel(current.rewardedLevel); if (!next || next > current.level) return false; return succeeded(await ctx.action('DrawAfkLevelRewardRequest', { level: next })); });
  await paidClickGold(ctx);
}
