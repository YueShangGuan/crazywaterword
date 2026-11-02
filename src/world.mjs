// 海面世界的只读探测与计划器：收成品、竣工、建造新建筑、交居民订单、按订单缺口排产、余料升级建筑。
//
// 所有事实都来自客户端自身的调用点与配置表，没有推测：
// - buildingId 形如 "1食品厂" / "1A民居" / "1指标楼A"，即 <序号><可选字母><建筑类型>，
//   类型按最长后缀去比 BuildingCfg.buildingType（58 种）。
// - 人口不是协议字段，是客户端算出来的：初始人口 + Σ BuildingUpgradeCfg[建筑类型][当前等级].effect 里的
//   「人口增加」；人口上限 = GameParamCfg 初始人口上限 + Σ「人口上限」。所以升级前的人口校验
//   可以离线复算（WaterModel._refreshPopulation 同款规则）。
// - 工厂队列上限 = BuildingProduceParamCfg 制造位上限（6），成品存量上限 = GameParamCfg 产品存量初始上限（50）。
// - 加速只花「加速器」：SpeedUpCostParam{type:2, useNum}（SpeedUpCost.SPEED_UP_ITEM=2）。
//   type=1 是钻石、type=3 是广告，本模块永不使用。
//
// 交互原则与 tasks.mjs 一致：先只读探测，再算出计划，显式授权后才逐条执行；
// 没有配套 Response 的写请求走 client.sendWatch()。

import fs from 'node:fs';
import path from 'node:path';
import { SERVER, assetUrl } from '../tools/sync-art.mjs';
import { randomUUID } from 'node:crypto';
import { normalize } from './worlds.mjs';
import { readWeekOrder } from './activities.mjs';
import { RESOURCE, displayMaterial } from './config.mjs';

export const SPEED_UP_ITEM = '加速器';
export const SPEED_UP_ITEM_TYPE = 2;
const STOCK_PARAM = '产品存量初始上限';
const SLOTS_PARAM = '制造位上限';
const POPULATION_PARAM = '初始人口上限';

function rowsOf(config, name) {
  return config?.tables?.[name]?.data ?? [];
}

// 这些常量散在几张 param 表里（人口/存量在 GameParamCfg，制造位在 BuildingProduceParamCfg），
// 名字不重复，所以统一按名字查。
function paramOf(config, name) {
  for (const table of ['GameParamCfg', 'BuildingProduceParamCfg']) {
    const row = rowsOf(config, table).find((r) => r.paramName === name);
    if (row) return row.paramValue ?? 0;
  }
  return 0;
}

function indexBy(config, name, key) {
  const out = new Map();
  for (const row of rowsOf(config, name)) out.set(row[key], row);
  return out;
}

// effect 是一组 [名字, 数值]，人口与上限都从这里累加。
function sumEffect(effect, name) {
  let total = 0;
  for (const entry of effect ?? []) {
    if (entry?.[0] === name) total += Number(entry[1] ?? 0);
  }
  return total;
}

// <序号><可选字母><建筑类型> 里抠出类型：取能匹配上的最长后缀。
export function makeTypeResolver(config) {
  const types = [...new Set(rowsOf(config, 'BuildingCfg').map((r) => r.buildingType))]
    .sort((a, b) => b.length - a.length);
  return (buildingId) => types.find((type) => buildingId.endsWith(type)) ?? null;
}

// 活动页和挂机共用游戏配方；同类工厂优先使用等级最高的一座。
export function weekFactoryInfo(config, itemId, buildings) {
  const recipe = rowsOf(config, 'BuildingProduceCfg').find(row => row.itemId === itemId);
  if (!recipe) return null;
  const type = recipe.buildType;
  const best = buildings?.filter(b => b.type === type).sort((a, b) => b.level - a.level
    || Number(b.buildFinishTime > 0) - Number(a.buildFinishTime > 0))[0];
  return {
    type, name: rowsOf(config, 'BuildingCfg').find(row => row.buildingType === type)?.name || type,
    required: recipe.unlockLevel, level: buildings ? (best?.level ?? 0) : null,
    buildingId: best?.buildingId, constructing: best?.buildFinishTime > 0,
  };
}

export function upgradeRow(config, buildingType, level) {
  return rowsOf(config, 'BuildingUpgradeCfg').find((r) => r.buildingType === buildingType && r.level === level) ?? null;
}

export function topLevel(config, buildingType) {
  return rowsOf(config, 'BuildingUpgradeCfg')
    .filter((r) => r.buildingType === buildingType)
    .reduce((max, r) => Math.max(max, r.level), 0);
}

// 只读探测：一次拉齐海面状态、库存、资源田、舰队。
export async function surveyWorld(client, protocol, { config = null, player = null, includeWeekOrder = true, includeCargo = false, timeout = 8000 } = {}) {
  const get = async (name) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      return normalize(await client.request(name, {}, responseName, timeout));
    } catch {
      return null;
    }
  };

  const water = await get('OnWaterRequest');
  if (!water) throw new Error('拿不到 OnWaterResponse，无法探测海面');
  const [itemList, resourceList, resFields, fleets] = await Promise.all([
    get('AllItemRequest'),
    get('AllResourceRequest'),
    get('MyResFieldsRequest'),
    get('MyFleetsRequest'),
  ]);

  // 道具和资源合到一张库存表里，消耗项的 id 有的是道具名（木材）、有的是资源名（GOLD）。
  const stock = new Map();
  const addStock = (id, num) => stock.set(id, (stock.get(id) ?? 0) + Number(num ?? 0));
  for (const item of itemList?.items ?? []) addStock(item.itemId ?? item.id, item.num ?? item.count);
  for (const entry of resourceList?.list ?? []) addStock(RESOURCE[entry.res] ?? String(entry.res), entry.amount);

  const resolveType = makeTypeResolver(config);
  const notes = [];

  // 人口 / 人口上限：客户端同款累加，只算已建成的（level > 0）。
  let population = paramOf(config, '初始人口');
  let futurePopulation = population;
  let maxPopulation = paramOf(config, POPULATION_PARAM);
  const buildings = [];
  for (const raw of water.building ?? []) {
    const buildingId = raw.buildingId;
    const type = resolveType(buildingId);
    const level = raw.level ?? 0;
    const current = upgradeRow(config, type, level);
    population += sumEffect(current?.effect, '人口增加');
    const future = raw.buildStartTime > 0 ? upgradeRow(config, type, level + 1) : current;
    futurePopulation += sumEffect(future?.effect, '人口增加');
    maxPopulation += sumEffect(current?.effect, '人口上限');
    if (!type) notes.push(`建筑 ${buildingId} 的类型没在 BuildingCfg 里匹配上，跳过`);
    buildings.push({
      buildingId,
      type,
      level,
      farm: raw.farm ?? null,
      factory: raw.factory ?? null,
      product: (raw.product?.asset ?? []).map((a) => ({ id: a.id, num: Number(a.num ?? 0) })),
      buildStartTime: raw.buildStartTime ?? 0,
      buildFinishTime: raw.buildFinishTime ?? 0,
      auto: raw.auto === true,
      population: sumEffect(current?.effect, '人口增加'),
    });
  }

  // WaterModel creates level-0 building models locally after the level and
  // prerequisite checks. Unbuilt plots of any category can be absent from the reply.
  const levels = new Map(buildings.map(b => [b.buildingId, b.level]));
  for (const row of rowsOf(config, 'BuildingUnlockCfg')) {
    if (levels.has(row.buildingId) || row.playerLevel > (player?.level ?? 1)) continue;
    if (!(row.condition ?? []).every(([id, lv]) => (levels.get(id) ?? 0) >= lv)) continue;
    buildings.push({ buildingId: row.buildingId, type: row.buildingType, level: 0,
      factory: null, product: [], buildStartTime: 0, buildFinishTime: 0, population: 0 });
  }

  const orderCfg = indexBy(config, 'WorkerOrderCfg', 'itemId');
  const specOrderCfg = indexBy(config, 'WorkerSpecOrderCfg', 'times');
  const have = (id) => stock.get(id) ?? 0;

  const orders = (water.workerOrder ?? []).map((raw) => {
    const requirements = (raw.requirements ?? []).map((r) => ({ id: r.id, num: Number(r.num ?? 0) }));
    const missing = requirements
      .map((r) => ({ id: r.id, num: Math.max(0, r.num - have(r.id)) }))
      .filter((r) => r.num > 0);
    // 订单经验：特殊订单看 WorkerSpecOrderCfg（times 就是 textId），普通订单按需求项累加。
    let rewardExp = null;
    if (raw.isSpecial) {
      const row = specOrderCfg.get(raw.textId) ?? specOrderCfg.get(String(raw.textId));
      rewardExp = Number((row?.reward ?? []).find((x) => x[0] === 'EXP')?.[1] ?? 0) || null;
    } else {
      let total = 0;
      let known = requirements.length > 0;
      for (const r of requirements) {
        const row = orderCfg.get(r.id);
        const exp = (row?.reward ?? []).find((x) => x[0] === 'EXP')?.[1];
        if (exp === undefined) known = false;
        else total += Number(exp) * r.num;
      }
      rewardExp = known ? total : null;
    }
    return {
      index: raw.index,
      workerId: raw.workerId,
      textId: raw.textId,
      isSpecial: raw.isSpecial === true,
      refreshTime: raw.refreshTime ?? 0,
      requirements,
      missing,
      rewardExp,
    };
  });

  let weekOrder = new Map();
  const cargoOrder = new Map();
  if (includeWeekOrder && itemList && protocol.WeekInfoRequest && protocol.WeekOrderInfoRequest) {
    try {
      const { needed, finished } = await readWeekOrder(client);
      if (!finished) weekOrder = needed;
      if (includeCargo && player?.level >= (config?.tables?.CargoUnlockCfg?.data[0]?.playerLevel ?? 9)) {
        const ships = await get('CargoShipsRequest');
        if (!ships) notes.push('本轮未能读取贸易港货单');
        for (const ship of ships?.ship ?? []) {
          if ((ship.status ?? 0) !== 0) continue;
          for (const { filled, asset } of ship.orderItem ?? []) {
            if (!filled && asset?.num > 0) cargoOrder.set(asset.id, (cargoOrder.get(asset.id) ?? 0) + Number(asset.num));
          }
        }
      }
    } catch (error) {
      notes.push('本轮未能读取周订单：' + error.message);
    }
  }
  const factories = buildings.filter((b) => b.factory);
  const resFieldInfo = resFields?.info ?? null;

  return {
    now: Math.floor(Date.now() / 1000),
    serverNow: Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000),
    player,
    stock,
    have,
    buildings,
    factories,
    orders,
    weekOrder,
    cargoOrder,
    orderOfTheDay: water.orderOfTheDay ?? { orderNum: 0, rewardedNum: 0 },
    autoProduceEndTime: water.autoProduceEndTime ?? 0,
    autoProduceForever: water.autoProduceForever === true,
    floaters: water.floater ?? [],
    floaterCount: (water.floater ?? []).length,
    population,
    futurePopulation,
    maxPopulation,
    autoFarming: water.autoFarming === true,
    stockCap: paramOf(config, STOCK_PARAM),
    factorySlots: paramOf(config, SLOTS_PARAM),
    resFields: resFieldInfo ? normalize(resFieldInfo) : null,
    fleets: fleets ? normalize(fleets.fleets ?? []) : null,
    worldOpenLevel: rowsOf(config, 'ModuleOpenCfg').find(r => r.moduleId === '世界')?.playerLevel,
    notes,
  };
}

// 计划：收成品 → 竣工 → 建造 → 交单 → 排产 → 余料升级 → 加速。每步都只排「客户端确实会发的请求」。
export function planWorld(survey, {
  config = null,
  allowSpeedUp = false,
  allowReroll = false,
  minOrderExp = 0,
  maxUpgrades = Infinity,
  enabled = () => true,
} = {}) {
  const { now, have } = survey;
  const name = id => displayMaterial(config, id);
  const actions = [];
  const notes = [];
  const reserved = new Map();
  const reserve = (id, num) => reserved.set(id, (reserved.get(id) ?? 0) + Number(num ?? 0));
  const free = (id) => have(id) - (reserved.get(id) ?? 0);

  // 给手动交周订单留出已有库存，在产和待收的成品也计入缺口。
  const weeklyGap = new Map();
  if (enabled('startProduce') || enabled('weekFactory') || enabled('farm') || enabled('upgrade')) {
    for (const [id, required] of survey.weekOrder ?? []) {
      const held = Math.min(required, have(id));
      if (held > 0) reserve(id, held);
      weeklyGap.set(id, required - held);
    }
  }
  const cargoGap = new Map();
  for (const [id, required] of survey.cargoOrder ?? []) {
    const held = Math.min(required, free(id));
    reserve(id, held);
    cargoGap.set(id, required - held);
  }
  const credit = (id, num) => {
    const weekly = Math.min(weeklyGap.get(id) ?? 0, num);
    if (weekly) weeklyGap.set(id, weeklyGap.get(id) - weekly);
    if (cargoGap.has(id)) cargoGap.set(id, Math.max(0, cargoGap.get(id) - (num - weekly)));
  };
  for (const { factory } of survey.factories) {
    for (const item of factory.finishedProducts ?? []) credit(item.id, item.num);
    for (const job of factory.factoryQ ?? []) credit(job.productId, 1);
  }

  const factoryTargets = new Map();
  if (enabled('weekFactory')) {
    for (const [id, gap] of weeklyGap) {
      if (gap <= 0) continue;
      const target = weekFactoryInfo(config, id, survey.buildings);
      if (!target || target.level >= target.required) continue;
      if ((factoryTargets.get(target.type)?.required ?? 0) < target.required) factoryTargets.set(target.type, target);
    }
  }
  // 1. 收成品：工厂走 GainFactoryProduce，非工厂建筑的囤积产物一次性批量收。
  for (const b of survey.factories) {
    if (enabled('gainFactory') && (b.factory.finishedProducts ?? []).length > 0) {
      actions.push({
        kind: 'gainFactory',
        request: 'GainFactoryProduceRequest',
        response: 'GainFactoryProduceResponse',
        body: { buildingId: b.buildingId },
        label: `收成品 ${b.buildingId}`,
      });
    }
  }
  const collectible = survey.buildings.filter((b) => !b.factory && b.product.length > 0).map((b) => b.buildingId);
  if (enabled('collectProduct') && collectible.length > 0) {
    actions.push({
      kind: 'collectProduct',
      request: 'CollectBuildingProductRequest',
      response: 'CollectBuildingProductResponse',
      body: { buildingId: collectible },
      label: `收建筑产物 ${collectible.join(',')}`,
    });
  }

  // 2. 竣工：建造时间已过的建筑先收尾，收尾后它才能继续升级。
  const finishing = new Set();
  for (const b of survey.buildings) {
    if (enabled('finishUpgrade') && b.buildFinishTime > 0 && b.buildFinishTime <= now) {
      finishing.add(b.buildingId);
      actions.push({
        kind: 'finishUpgrade',
        request: 'FinishUpgradeBuildingRequest',
        response: null,
        body: { buildingId: b.buildingId },
        label: `竣工 ${b.buildingId}`,
      });
    }
  }

  // 3. 建造：OnWaterResponse 里 level=0 的建筑是空位——要么「已解锁但没盖」，要么正在盖。
  //    客户端的分支很明确（subpackages/main/game.js 的 _toBuildOrUpgradeRequest）：
  //    `0 == t.level ? BuildBuildingRequest : UpgradeBuildingRequest`，所以建造这一条与升级不是同一个请求。
  //    首建门槛、前置建筑和材料取自每个具体地块的 BuildingUnlockCfg。
  const builds = [];
  const unlocks = indexBy(config, 'BuildingUnlockCfg', 'buildingId');
  const levels = new Map(survey.buildings.map(b => [b.buildingId, b.level]));
  let plannedPopulation = survey.futurePopulation ?? survey.population;
  for (const b of survey.buildings) {
    if (!enabled('build')) break;
    if (!b.type || b.level !== 0) continue;
    // buildFinishTime 在将来 = 正在盖，重复发只会被拒；等它到了由上面的竣工步骤收尾。
    if (b.buildStartTime > 0 || b.buildFinishTime > now) continue;
    // 本轮刚排了竣工的，收尾后它就是 level 1 了，同一轮再发建造必被拒。
    if (finishing.has(b.buildingId)) continue;
    const row = unlocks.get(b.buildingId);
    if (!row) continue;
    if (!(row.condition ?? []).every(([id, lv]) => (levels.get(id) ?? 0) >= lv)) {
      notes.push(`${b.buildingId} 建造有额外条件 ${JSON.stringify(row.condition)}，跳过`);
      continue;
    }
    if (row.curPeople > survey.population) {
      notes.push(`${b.buildingId} 需要人口 ${row.curPeople}，当前 ${survey.population}`);
      continue;
    }
    if (row.playerLevel > (survey.player?.level ?? 1)) {
      notes.push(`${b.buildingId} 建造要等级 ${row.playerLevel}，当前 ${survey.player?.level ?? 1}，先推主线`);
      continue;
    }
    const consume = (row.consume ?? []).map(([id, n]) => ({ id, num: Number(n) }));
    if (!consume.every((c) => free(c.id) >= c.num)) {
      const short = consume.filter((c) => free(c.id) < c.num).map((c) => `${name(c.id)} ${free(c.id)}/${c.num}` + (config?.materialSources?.(c.id)?.length ? `（来源：${config.materialSources(c.id).join("、")}）` : "")).join(' ');
      notes.push(`${b.buildingId} 建造材料不足（${short}），不买材料，等下一轮`);
      continue;
    }
    const effect = upgradeRow(config, b.type, 1)?.effect;
    builds.push({ building: b, row, consume, gain: sumEffect(effect, '人口增加'), capacity: sumEffect(effect, '人口上限') });
  }
  const upgradeReasons = [];
  const typeLevels = new Map();
  for (const b of survey.buildings) typeLevels.set(b.type, Math.max(typeLevels.get(b.type) ?? 0, b.level));
  let upgradeCount = 0;
  planUpgrades(true);
  builds.sort((a, b) => Number(b.row.category === '指标') - Number(a.row.category === '指标')
    || Number(b.gain > 0) - Number(a.gain > 0)
    || a.row.playerLevel - b.row.playerLevel || a.building.buildingId.localeCompare(b.building.buildingId));
  const priorityPlots = new Set();
  for (const target of factoryTargets.values()) {
    if (target.level || target.constructing) continue;
    const plot = builds.find(u => u.building.type === target.type);
    if (plot) priorityPlots.add(plot.building.buildingId);
  }
  builds.sort((a, b) => Number(priorityPlots.has(b.building.buildingId)) - Number(priorityPlots.has(a.building.buildingId)));
  for (const u of builds) {
    if (u.gain && plannedPopulation + u.gain > survey.maxPopulation) {
      notes.push(`${u.building.buildingId} 增加 ${u.gain} 人，需上限 ${plannedPopulation + u.gain}，当前上限 ${survey.maxPopulation}；先建指标建筑`);
      continue;
    }
    if (!u.consume.every(c => free(c.id) >= c.num)) {
      notes.push(`${u.building.buildingId} 建材已预留给本轮其他地块，下一轮重新检查`);
      continue;
    }
    plannedPopulation += u.gain;
    for (const c of u.consume) reserve(c.id, c.num);
    actions.push({
      kind: 'build',
      request: 'BuildBuildingRequest',
      response: null,
      body: { buildingId: u.building.buildingId },
      label: `建造 ${u.building.buildingId}（需等级 ${u.row.playerLevel}）`
        + (priorityPlots.has(u.building.buildingId) ? `，周订单需要 ${factoryTargets.get(u.building.type).required} 级` : '')
        + (u.capacity ? `，竣工后人口上限 +${u.capacity}` : '')
        + (u.gain ? `，竣工后人口 +${u.gain}` : ''),
    });
  }

  // 4. 交居民订单：材料齐就交；不齐时按开关决定要不要拒绝重刷。
  for (const order of survey.orders) {
    const buildable = order.requirements.every((r) => free(r.id) >= r.num);
    if (buildable) {
      if (!enabled('finishOrder')) continue;
      for (const r of order.requirements) reserve(r.id, r.num);
      actions.push({
        kind: 'finishOrder',
        request: 'FinishWorkerOrderRequest',
        response: 'FinishWorkerOrderResponse',
        body: { index: order.index },
        label: `交订单 #${order.index}（经验 ${order.rewardExp ?? '?'}）`,
      });
      continue;
    }
    const short = order.requirements.filter(m => free(m.id) < m.num).map(m => `${name(m.id)} ${free(m.id)}/${m.num}`).join(' ');
    if (order.requirements.some(m => weeklyGap.has(m.id) || cargoGap.has(m.id)) && order.requirements.every(m => have(m.id) >= m.num)) {
      notes.push(`订单 #${order.index} 材料已预留，等待补货`);
    } else if (!allowReroll) {
      notes.push(`订单 #${order.index} 材料不足（${short}），未开 --reroll，保留`);
    } else if (minOrderExp === null || (order.rewardExp ?? 0) < minOrderExp) {
      actions.push({
        kind: 'denyOrder',
        request: 'DenyOrderRequest',
        response: null,
        body: { index: order.index },
        label: `拒绝材料不足的订单 #${order.index}（${short}）`,
      });
    } else {
      notes.push(`订单 #${order.index} 材料不足（${short}），保留等待生产`);
    }
  }

  // 5. 排产：按订单缺口挑配方，缺得多的先产；已设自动生产的工厂不覆盖。
  const demand = new Map();
  for (const order of survey.orders) {
    for (const m of order.missing) demand.set(m.id, (demand.get(m.id) ?? 0) + m.num);
    // 周订单预留的库存不能同时用于居民订单。
    for (const m of order.requirements) {
      if (!weeklyGap.has(m.id)) continue;
      const held = Math.min(have(m.id), survey.weekOrder.get(m.id));
      const extra = Math.min(m.num, have(m.id)) - Math.min(m.num, have(m.id) - held);
      if (extra > 0) demand.set(m.id, (demand.get(m.id) ?? 0) + extra);
    }
  }
  if (enabled('farm') && !survey.autoFarming) {
    const crops = rowsOf(config, 'FarmlandPlantCfg');
    const planted = new Map();
    const plots = survey.buildings.filter(b => b.type === '农田' && b.level > 0 && !b.buildStartTime && !b.buildFinishTime);
    const serverNow = survey.serverNow ?? now;
    for (const b of plots) {
      const crop = crops.find(r => r.id === b.farm?.productId);
      if (!crop) continue;
      planted.set(crop.id, (planted.get(crop.id) ?? 0) + crop.produceNum);
      if (b.farm.ripeTime > 0 && b.farm.ripeTime < serverNow) actions.push({
        kind: 'farm', request: 'FarmHarvestRequest', response: 'FarmHarvestResponse',
        body: { buildingId: [b.buildingId] }, label: '农田收获 ' + name(crop.id),
      });
    }
    const shortage = id => Math.max(0, (weeklyGap.get(id) ?? 0) + (demand.get(id) ?? 0) - (planted.get(id) ?? 0));
    const projected = id => have(id) + (planted.get(id) ?? 0);
    for (const crop of crops) {
      if (shortage(crop.id) > 0 && free(crop.material[0]) < crop.material[1])
        notes.push(name(crop.id) + ' 订单缺 ' + shortage(crop.id) + '，种植需要' + name(crop.material[0]));
    }
    for (const b of plots.filter(b => !b.farm?.productId)) {
      const choices = crops.filter(r => free(r.material[0]) >= r.material[1]
        && projected(r.id) < survey.stockCap * 5 && (!weeklyGap.has(r.id) || shortage(r.id) > 0));
      choices.sort((a, b) => shortage(b.id) - shortage(a.id) || projected(a.id) - projected(b.id) || a.time - b.time);
      const crop = choices[0];
      if (!crop) continue;
      reserve(crop.material[0], crop.material[1]);
      const need = shortage(crop.id);
      planted.set(crop.id, (planted.get(crop.id) ?? 0) + crop.produceNum);
      actions.push({ kind: 'farm', request: 'FarmPlantRequest', response: null,
        body: { args: [{ buildingId: b.buildingId, productId: crop.id }] },
        label: '农田播种 ' + name(crop.id) + (need ? '（订单缺 ' + need + '）' : ''),
      });
    }
  }
  const incoming = new Map();
  const addIncoming = (id, num) => incoming.set(id, (incoming.get(id) ?? 0) + num);
  const projectedStock = id => have(id) + (incoming.get(id) ?? 0);
  for (const { factory } of survey.factories) {
    for (const job of factory.factoryQ ?? []) addIncoming(job.productId, 1);
    for (const item of factory.finishedProducts ?? []) addIncoming(item.id, Number(item.num));
  }
  const factoryReasons = new Map();
  const produceRows = rowsOf(config, 'BuildingProduceCfg');
  for (const b of survey.factories) {
    if (!enabled('startProduce')) break;
    if (b.factory.autoProductId && survey.autoProduceEndTime > (survey.serverNow ?? now)) {
      factoryReasons.set(b.buildingId, `游戏自动生产 ${name(b.factory.autoProductId)} 已开启`);
      notes.push(`${b.buildingId} 已设自动生产 ${name(b.factory.autoProductId)}，不覆盖`);
      continue;
    }
    const queue = b.factory.factoryQ ?? [];
    if (queue.length >= survey.factorySlots) continue;
    for (let slot = queue.length; slot < survey.factorySlots; slot++) {
      const reasons = [];
      const cand = produceRows.filter(row => {
        if (row.buildType !== b.type || row.unlockLevel > b.level) return false;
        const id = row.itemId;
        let reason;
        if (projectedStock(id) >= survey.stockCap)
          reason = '库存、待收和在产合计已达 ' + survey.stockCap;
        else {
          const missing = (row.costItem ?? []).filter(([item, n]) => free(item) < n);
          if (missing.length) reason = missing.map(([item, n]) => name(item) + '可用 ' + free(item) + '/' + n).join('、');
        }
        if (reason) reasons.push(name(id) + '：' + reason);
        return !reason;
      });
      if (!cand.length) {
        factoryReasons.set(b.buildingId, reasons.join('；') || '当前等级没有已解锁的生产配方');
        break;
      }
      const best = cand.sort((a, b2) => (weeklyGap.get(b2.itemId) ?? 0) - (weeklyGap.get(a.itemId) ?? 0)
        || (cargoGap.get(b2.itemId) ?? 0) - (cargoGap.get(a.itemId) ?? 0)
        || (demand.get(b2.itemId) ?? 0) - (demand.get(a.itemId) ?? 0)
        || projectedStock(a.itemId) - projectedStock(b2.itemId)
        || a.produceTime - b2.produceTime)[0];
      for (const [id, n] of best.costItem ?? []) reserve(id, n);
      const need = demand.get(best.itemId) ?? 0;
      const weeklyNeed = weeklyGap.get(best.itemId) ?? 0;
      const cargoNeed = cargoGap.get(best.itemId) ?? 0;
      const projected = projectedStock(best.itemId);
      addIncoming(best.itemId, 1);
      if (need > 0 && !weeklyNeed && !cargoNeed) demand.set(best.itemId, need - 1);
      credit(best.itemId, 1);
      actions.push({
        kind: 'startProduce',
        request: 'StartFactoryProduceRequest',
        response: null,
        body: { buildingId: b.buildingId, productId: best.itemId },
        label: `排产 ${b.buildingId} → ${name(best.itemId)}（${best.produceTime}s${weeklyNeed ? `，周订单缺 ${weeklyNeed}` : cargoNeed ? `，贸易港缺 ${cargoNeed}` : need ? `，居民订单缺 ${need}` : `，补库存，预计已有 ${projected}`}）`,
      });
    }
  }

  // 6. 余料升级建筑：把订单与排产占用的材料扣掉之后再比升级消耗，按人口需求升序（便宜的先生效）。
  planUpgrades(false);

  function planUpgrades(priority) {
    const upgrades = [];
    for (const b of survey.buildings) {
      const target = factoryTargets.get(b.type);
      const forOrder = target?.buildingId === b.buildingId && b.level < target.required;
      if (forOrder !== priority || (!priority && !enabled('upgrade'))) continue;
      if (b.level <= 0) continue;
      if (!b.type) { upgradeReasons.push(b.buildingId + '未找到建筑类型'); continue; }
      if (b.buildStartTime > 0 || b.buildFinishTime > 0) {
        upgradeReasons.push(b.buildingId + '已有施工任务，本轮先检查竣工'); continue;
      }
      const next = b.level + 1;
      const row = upgradeRow(config, b.type, next);
      if (!row) {
        const max = topLevel(config, b.type);
        upgradeReasons.push(b.buildingId + (max && b.level >= max ? '已达最高 ' + max + ' 级' : '缺少下一级配置'));
        continue;
      }
      const unmet = (row.condition ?? []).find(([type, lv]) => (typeLevels.get(type) ?? 0) < lv);
      if (unmet) { upgradeReasons.push(b.buildingId + '需要' + unmet[0] + ' ' + unmet[1] + '级'); continue; }
      if (row.playerLevel > (survey.player?.level ?? 1)) { upgradeReasons.push(b.buildingId + '需要角色 ' + row.playerLevel + ' 级'); continue; }
      if (row.curPeople > survey.population) { upgradeReasons.push(b.buildingId + '需要人口 ' + row.curPeople + '，当前 ' + survey.population); continue; }
      const consume = (row.consume ?? []).map(([id, num]) => ({ id, num: Number(num) }));
      const gain = Math.max(0, sumEffect(row.effect, '人口增加') - (b.population ?? 0));
      upgrades.push({ building: b, row, consume, gain, costTime: row.costTime ?? 0 });
    }
    upgrades.sort((a, b) => a.row.curPeople - b.row.curPeople || a.costTime - b.costTime);
    for (const u of upgrades) {
      if (upgradeCount >= maxUpgrades) {
        notes.push(`${u.building.buildingId} 本轮升级额度用完，下一轮再升`);
        continue;
      }
      if (u.gain && plannedPopulation + u.gain > survey.maxPopulation) {
        upgradeReasons.push(u.building.buildingId + '升级后人口超过上限 ' + survey.maxPopulation);
        continue;
      }
      const short = u.consume.filter(c => free(c.id) < c.num);
      if (short.length) {
        upgradeReasons.push(u.building.buildingId + '缺' + short.map(c => name(c.id) + ' ×' + (c.num - free(c.id))).join('、'));
        continue;
      }
      upgradeCount++;
      plannedPopulation += u.gain;
      for (const c of u.consume) reserve(c.id, c.num);
      actions.push({
        kind: priority ? 'weekFactory' : 'upgrade',
        request: 'UpgradeBuildingRequest',
        response: null,
        body: { buildingId: u.building.buildingId },
        label: `升级 ${u.building.buildingId} ${u.building.level}->${u.building.level + 1}（${u.costTime}s，人口 ${u.row.curPeople}）`
          + (priority ? `，周订单需要 ${factoryTargets.get(u.building.type).required} 级` : ''),
      });
    }
  }

  // 7. 加速：只花「加速器」，而且只对真的在等的建造/生产用。
  if (allowSpeedUp) {
    const speeders = Number(have(SPEED_UP_ITEM));
    let left = speeders;
    for (const b of survey.buildings) {
      if (b.buildFinishTime <= now) continue;
      const minutes = Math.ceil((b.buildFinishTime - now) / 60);
      if (minutes <= 0 || left <= 0) continue;
      const useNum = Math.max(1, Math.min(minutes, left));
      left -= useNum;
      actions.push({
        kind: 'speedUpUpgrade',
        request: 'SpeedUpUpgradeBuildingRequest',
        response: null,
        body: { buildingId: b.buildingId, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum } },
        label: `加速建造 ${b.buildingId} 用 ${useNum} 个${name(SPEED_UP_ITEM)}`,
      });
    }
    for (const b of survey.factories) {
      for (const job of b.factory.factoryQ ?? []) {
        if (job.finishTime <= now || left <= 0) continue;
        const minutes = Math.ceil((job.finishTime - now) / 60);
        if (minutes <= 0) continue;
        const useNum = Math.max(1, Math.min(minutes, left));
        left -= useNum;
        actions.push({
          kind: 'speedUpProduce',
          request: 'SpeedUpFactoryProduceRequest',
          response: null,
          body: { buildingId: b.buildingId, index: job.idx, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum } },
          label: `加速生产 ${b.buildingId} 用 ${useNum} 个${name(SPEED_UP_ITEM)}`,
        });
      }
    }
    if (left === speeders) notes.push(`${SPEED_UP_ITEM} 有 ${speeders} 个，但没有等待中的建造或生产`);
  }

  return { actions, notes, factoryReasons, upgradeReasons, reserved: [...reserved].filter(([, n]) => n > 0) };
}

export function stepKey(step) {
  const target = step.body?.buildingId ?? step.body?.index ?? '';
  return `${step.kind}:${Array.isArray(target) ? target.join('+') : target}`;
}

// 逐条执行。同类动作失败就跳过该类的剩余动作；被服务端拒过的具体动作记进 rejected，
// 循环模式下后续轮次不再重发（否则每轮都会骚扰一次同一个必败请求）。
export async function runWorld(client, protocol, plan, {
  allowMutate = false,
  window = 400,
  timeout = 15000,
  rejected = new Set(),
  onStep,
  enabled = () => true,
} = {}) {
  if (!allowMutate) throw new Error('海面自动化会改变账号状态，需要 --yes');
  const results = [];
  const blocked = new Set();
  const failedRecipes = new Set();
  for (const step of plan.actions) {
    if (!enabled(step.kind)) continue;
    const key = stepKey(step);
    const recipe = step.kind === 'startProduce' ? JSON.stringify(step.body) : null;
    if (recipe && failedRecipes.has(recipe)) continue;
    let entry;
    if (rejected.has(key)) entry = { step, ok: false, skipped: true, error: '刚被服务端拒过，跳过' };
    else if (blocked.has(step.kind)) entry = { step, ok: false, skipped: true, error: `同类动作已失败，本轮不再尝试` };
    else if (!protocol[step.request]) entry = { step, ok: false, error: `协议表里没有 ${step.request}` };
    else {
      try {
        if (step.response && protocol[step.response]) {
          const body = await client.request(step.request, step.body, step.response, timeout);
          entry = { step, ok: true, body };
        } else {
          // 没有配套 Response：静默即成功，回包是 PromptResponse 就是被拒。
          const sent = await client.sendWatch(step.request, step.body, { window });
          entry = { step, ok: true, sent };
        }
      } catch (error) {
        if (recipe) failedRecipes.add(recipe);
        // Each plot has independent prerequisites. A failed build must not
        // suppress other plots, or prevent a later fresh survey from retrying it.
        if (!['build', 'farm', 'upgrade', 'weekFactory', 'startProduce'].includes(step.kind)) {
          rejected.add(key);
          blocked.add(step.kind);
        }
        entry = { step, ok: false, error: error.message };
      }
    }
    results.push(entry);
    onStep?.(entry);
    if (entry.ok) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { results, rejected, blocked: [...blocked] };
}

// --- 资源田 ------------------------------------------------------------------
//
// 「哪些 gridIdx 是田、是什么类型」不在协议里也不在 591 张配置表里，只在 CDN bundle world_map 的
// JsonAsset 里。地图首次读取时自动缓存到 work/cdn/，编码是 resType * 10000 + cityId。
// 占田（ChallengeResFieldRequest）要求「该田所属城是我方城 + 有闲置且 durability > 0 的舰队」，
// 账号没有舰队时这一步必然失败，所以本模块只做只读报告 + 显式手动占田/放弃，不做无人值守的自动占田。

export const MAP_DIR = path.resolve(import.meta.dirname, '../work/cdn');

export function mapPath(scenarioId) {
  return path.join(MAP_DIR, `world_map.world_map${scenarioId > 0 ? scenarioId : 1}.json`);
}

const mapLoads = new Map();

// 版本来自游戏包 src/settings.0afbd.json 的 assets.bundleVers.world_map。
async function fetchMap(file, scenarioId) {
  const getJson = async url => {
    const reply = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!reply.ok) throw new Error('地图下载失败（HTTP ' + reply.status + '）');
    return reply.json();
  };
  const cfg = await getJson(SERVER + 'remote/world_map/config.2ca75.json');
  const entry = Object.entries(cfg.paths).find(([, row]) => row[0] === 'world_map' + scenarioId && cfg.types[row[1]] === 'cc.JsonAsset');
  if (!entry) throw new Error('游戏资源中没有场景 ' + scenarioId + ' 的地图');
  const raw = await getJson(assetUrl('world_map', cfg, Number(entry[0]), 'cc.JsonAsset'));
  const map = parseMap(raw, file, scenarioId);
  fs.mkdirSync(MAP_DIR, { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(raw));
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return map;
}

export function loadMapAsset(id) {
  const scenarioId = id > 0 ? id : 1;
  if (!Number.isSafeInteger(scenarioId)) throw new Error('地图场景编号无效');
  if (!mapLoads.has(scenarioId)) {
    const file = mapPath(scenarioId);
    const job = (async () => {
      try { return parseMap(JSON.parse(fs.readFileSync(file, 'utf8')), file, scenarioId); }
      catch { return fetchMap(file, scenarioId); }
    })().catch(error => { mapLoads.delete(scenarioId); throw error; });
    mapLoads.set(scenarioId, job);
  }
  return mapLoads.get(scenarioId);
}

function parseMap(raw, file, scenarioId) {
  const data = raw?.[5]?.[0]?.[2];
  if (!Array.isArray(data?.mapData) || !data.mapInfo?.width || data.mapData.length !== data.mapInfo.width * data.mapInfo.height)
    throw new Error('地图格子数据不完整');
  const { mapInfo, cityInfo, mapData } = data;
  return {
    file,
    scenarioId: scenarioId > 0 ? scenarioId : 1,
    width: mapInfo?.width ?? 0,
    height: mapInfo?.height ?? 0,
    cityInfo,
    fieldCount: mapData.reduce((n, v) => n + (Math.floor(v / 10000) % 10 ? 1 : 0), 0),
    fieldAt(gridIdx) {
      const v = mapData[gridIdx];
      if (v === undefined) return null;
      const resType = Math.floor(v / 10000) % 10;
      if (!resType) return null;
      return { gridIdx, resType, cityId: v % 1000 };
    },
  };
}

// 舰队状态：1=IDLE 2=MOVING 3=BATTLING 4=REPAIRING 5=QUEUING（客户端 FleetState 枚举）。
export function idleFleets(survey) {
  return (survey.fleets ?? []).filter((f) => Number(f.state) === 1 && Number(f.durability) > 0);
}

export function formatFieldReport(survey, map, mapError) {
  const lines = [];
  const info = survey.resFields;
  const fields = info?.fields ?? [];
  const locked = survey.player?.level > 0 && survey.player.level < survey.worldOpenLevel;
  if (locked) lines.push(`世界玩法 ${survey.worldOpenLevel} 级开放，当前角色 ${survey.player.level} 级`);
  lines.push(info ? `已占资源田 ${fields.length}/${info.maxNum ?? '?'}` : '未取得资源田信息');
  for (const f of fields) {
    const at = map?.fieldAt(f.gridIdx);
    lines.push(`  gridIdx=${f.gridIdx} cityId=${f.cityId} type=${f.type}${at ? ` (地图: 城 ${at.cityId} 类型 ${at.resType})` : ''}`);
  }
  const idle = idleFleets(survey);
  if (!survey.fleets) lines.push('未取得舰队信息，可稍后刷新');
  else if (survey.fleets.length) lines.push(`舰队 ${survey.fleets.length} 支，其中闲置可用 ${idle.length} 支${idle.length ? `（${idle.map(f => f.buildingId).join('、')}）` : ''}`);
  else if (!locked) lines.push('当前账号暂无舰队');
  if (map) lines.push(`场景 ${map.scenarioId} · 地图 ${map.width}×${map.height}，资源田 ${map.fieldCount} 块，城池 ${Object.keys(map.cityInfo ?? {}).length} 座`);
  else lines.push('本次未取得场景地图' + (mapError ? '：' + mapError : ''));
  return lines.join('\n');
}

// 手动占田：显式给 gridIdx，舰队要么点名要么自动挑闲置的；条件不满足就直接拒绝，不发请求。
export function planFieldOccupy(survey, gridIdx, { fleetBuildingIds = [] } = {}) {
  const info = survey.resFields;
  if (survey.player?.level < survey.worldOpenLevel) return { error: `世界玩法 ${survey.worldOpenLevel} 级开放` };
  if (!info || !survey.fleets) return { error: '未取得资源田或舰队状态，请刷新后重试' };
  if (info && (info.fields ?? []).length >= (info.maxNum ?? 0)) {
    return { error: `已占 ${info.fields.length}/${info.maxNum} 块田，达到上限` };
  }
  const idle = idleFleets(survey);
  const picks = fleetBuildingIds.length > 0 ? fleetBuildingIds : idle.slice(0, 1).map((f) => f.buildingId);
  if (picks.length === 0) {
    return { error: '没有闲置且耐久>0 的舰队可派，占田会被服务端拒绝' };
  }
  const known = new Set((survey.fleets ?? []).map((f) => f.buildingId));
  const unknown = picks.filter((id) => !known.has(id));
  if (unknown.length > 0) return { error: `舰队 ${unknown.join(',')} 不在 MyFleetsResponse 里` };
  return {
    action: {
      kind: 'challengeField',
      request: 'ChallengeResFieldRequest',
      response: null,
      body: { resFieldGridIdx: Number(gridIdx), fleetBuildingIds: picks },
      label: `占田 gridIdx=${gridIdx} 派 ${picks.join(',')}`,
    },
  };
}

export function planFieldGiveUp(survey, gridIdx) {
  const owned = (survey.resFields?.fields ?? []).some((f) => Number(f.gridIdx) === Number(gridIdx));
  if (!owned) return { error: `gridIdx=${gridIdx} 不在我已占的田里` };
  return {
    action: {
      kind: 'giveUpField',
      request: 'GiveUpResFieldRequest',
      response: null,
      body: { resFieldGridIdx: Number(gridIdx) },
      label: `放弃资源田 gridIdx=${gridIdx}`,
    },
  };
}

export function formatWorldPlan(survey, plan) {
  const lines = [];
  lines.push(`人口 ${survey.population}/${survey.maxPopulation}  库存 ${survey.stock.size} 种  工厂 ${survey.factories.length} 栋  订单 ${survey.orders.length} 条`);
  if (survey.futurePopulation > survey.population) lines.push(`民居施工完成后人口 ${survey.futurePopulation}`);
  if (survey.resFields) {
    const fields = survey.resFields.fields ?? [];
    lines.push(`资源田 ${fields.length}/${survey.resFields.maxNum ?? '?'}${fields.length ? `  已占 ${fields.map((f) => f.gridIdx).join(',')}` : ''}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of [...survey.notes, ...plan.notes]) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
