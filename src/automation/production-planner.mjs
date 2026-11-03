import { makeTypeResolver } from '../world.mjs';
import { amount } from './context.mjs';

/**
 * 复用客户端 FactoryUtil.produceFinalTime：先减固定秒数，再除以速度倍率。
 * @param {object} recipe 当前配方。
 * @param {{speed: number, reduction: number}} effects 当前角色的服务端生产效果。
 * @returns {number} 单件实际秒数；缺少生产时间时返回 Infinity，不能误判为即时商品。
 */
export function productionSeconds(recipe, effects = { speed: 0, reduction: 0 }) {
  if (!Number.isFinite(recipe?.produceTime) || recipe.produceTime < 0) return Infinity;
  return Math.ceil(Math.max(0, recipe.produceTime - effects.reduction) / (1 + effects.speed));
}

/**
 * 按客户端取消按钮的规则识别等待项；所有有完成时间的项和首项均受保护。
 * 月卡第二生产位同样带 finishTime，不能简单把数组第二项当作可取消任务。
 * @param {object[]} queue 当前服务器队列，保持服务器顺序。
 * @param {number} position 项目在该快照中的位置。
 * @returns {boolean} 是否明确处于尚未开工状态。
 */
export function waitingProduction(queue, position) {
  return position > 0 && queue[position]?.finishTime === 0;
}

/**
 * 将服务端效果快照与本连接最新单项更新合并；未出现的效果按客户端定义取零。
 * @param {object} response GameEffectResponse。
 * @param {object} protocol 当前协议枚举。
 * @param {object|undefined} update SCGameEffectUpdate。
 * @returns {{speed: number, reduction: number}} 速度比例和固定减时秒数。
 */
export function productionEffects(response, protocol, update) {
  const values = new Map((response.effects ?? []).map(row => [row.id, row.value]));
  if (update?.effect) values.set(update.effect.id, update.effect.value);
  return {
    speed: values.get(protocol.GameEffectId.PRODUCE_SPEED_UP) ?? 0,
    reduction: values.get(protocol.GameEffectId.PRODUCE_TIME_REDUCTION) ?? 0,
  };
}

/**
 * 根据三档耗时、订单配方依赖及共享库存生成下一步动作，不接触网关。
 * 每份现货/在产量只分配一次；库存水位按分配后的余量计算，避免别的商品拿走同一原料。
 * 等待项保留原任务身份，取消后由 deferred 持久化接续，不丢失原队列意图。
 * @param {object} input 当前水面、库存、完整需求、配置、效果和上轮调度状态。
 * @returns {object} 下一步排产/重排/加速候选、材料分配及库存补货状态。
 */
export function planProduction({ config, water, stock, needs, options, disabledBuildings = [], effects, now, state = {} }) {
  /** 只读当前配置包；缺表必须由下面的有效性检查显式阻止排产。 */
  function rows(name) { return config?.tables?.[name]?.data ?? []; }
  const resolve = makeTypeResolver(config);
  const slots = rows('BuildingProduceParamCfg').find(row => row.paramName === '制造位上限')?.paramValue;
  const stockCap = rows('GameParamCfg').find(row => row.paramName === '产品存量初始上限')?.paramValue;
  const warnings = [];
  if (!(slots > 0) || !(stockCap > 0)) return { warnings: ['缺少当前制造位上限或产品库存上限'], choices: [], allocations: [], restocking: [], tasks: [], active: [], waiting: [], factories: [], urgentBuildings: [] };
  const factories = (water.building ?? []).filter(building => building.factory && resolve(building.buildingId) && resolve(building.buildingId) !== '活动工厂'
    && !disabledBuildings.includes(resolve(building.buildingId)) && !options.disabledFactories.includes(resolve(building.buildingId)));
  const recipes = new Map();
  for (const row of rows('BuildingProduceCfg')) {
    if (!factories.some(building => resolve(building.buildingId) === row.buildType && building.level >= row.unlockLevel)) continue;
    // 限时配方由对应活动执行器判断开放时间，普通工厂调度不接管。
    if (row.limitType) continue;
    if (!Array.isArray(row.costItem) || !Number.isFinite(productionSeconds(row, effects))) { warnings.push(`${row.itemId} 缺少有效生产时间或配方`); continue; }
    recipes.set(row.itemId, row);
  }
  /** 单件耗时决定补货档位；等待时间另记 ETA，长队不能把短料错误降档。 */
  function tierOf(id) {
    const seconds = productionSeconds(recipes.get(id), effects);
    if (seconds <= options.fastTimeSecs) return 1;
    if (seconds <= options.shortTimeSecs) return 2;
    return 3;
  }
  const supply = new Map(), totals = new Map(stock), waiting = [], active = [];
  const allocations = [], tasks = [], restocking = [], factoryTimes = new Map(), urgentProducts = new Set();
  const plannedCounts = new Map();
  /** 每批产出保留来源、可用时刻及数量，分配后从该批扣减。 */
  function addSupply(id, num, eta, kind, job) {
    if (!(num > 0)) return;
    if (!supply.has(id)) supply.set(id, []);
    supply.get(id).push({ id, num, eta, kind, job });
  }
  for (const [id, num] of stock) addSupply(id, num, 0, 'stock');
  for (const building of water.building ?? []) {
    const queue = building.factory?.factoryQ ?? [];
    const running = queue.filter((job, index) => !waitingProduction(queue, index));
    // 服务端已开工项目给出各自完成时间；未知首项按其配方估计，但仍禁止取消。
    const lanes = running.map(job => job.finishTime > 0 ? Math.max(0, job.finishTime - now) : productionSeconds(recipes.get(job.productId), effects));
    if (!lanes.length) lanes.push(0);
    for (const [index, job] of queue.entries()) {
      const isWaiting = waitingProduction(queue, index);
      const seconds = productionSeconds(recipes.get(job.productId), effects);
      let eta = job.finishTime > 0 ? Math.max(0, job.finishTime - now) : seconds;
      if (isWaiting) {
        // 月卡的并行生产位取最早空闲的一条，而不是把两个在产项串行相加。
        const lane = lanes.indexOf(Math.min(...lanes));
        eta = lanes[lane] += seconds;
      }
      const entry = { ...job, buildingId: building.buildingId, position: index, eta, seconds, tier: tierOf(job.productId), usedBy: [] };
      (isWaiting ? waiting : active).push(entry);
      addSupply(job.productId, 1, eta, 'queue', entry);
      totals.set(job.productId, (totals.get(job.productId) ?? 0) + 1);
    }
    factoryTimes.set(building.buildingId, Math.min(...lanes));
    for (const product of building.factory?.finishedProducts ?? []) {
      const num = amount(product.num);
      addSupply(product.id, num, 0, 'finished');
      totals.set(product.id, (totals.get(product.id) ?? 0) + num);
    }
  }
  for (const lots of supply.values()) lots.sort((a, b) => a.eta - b.eta);

  /** 从共享库存池领取现货/在产批次；已入队配方扣过的原料不再展开消耗。 */
  function takeSupply(id, quantity, owner) {
    const result = [];
    for (const lot of supply.get(id) ?? []) {
      const num = Math.min(quantity, lot.num);
      if (!num) continue;
      lot.num -= num; quantity -= num;
      const allocation = { id, num, owner, eta: lot.eta, kind: lot.kind, job: lot.job };
      allocations.push(allocation); result.push(allocation);
      if (lot.job) lot.job.usedBy.push(owner);
    }
    return { result, missing: quantity };
  }

  /** 已有产出只分配一次，缺口再递归展开；配方循环和不可生产的叶子明确阻断开工。 */
  function allocate(id, quantity, owner, path = []) {
    const taken = takeSupply(id, quantity, owner);
    const result = taken.result;
    quantity = taken.missing;
    if (!quantity) return result;
    const recipe = recipes.get(id);
    if (!recipe || path.includes(id)) {
      if (path.includes(id)) warnings.push(`生产配方存在循环：${[...path, id].join(' → ')}`);
      const allocation = { id, num: quantity, owner, eta: Infinity, kind: 'missing' };
      allocations.push(allocation); result.push(allocation);
      return result;
    }
    // 单品库存上限约束本次展开规模；剩余订单在产出消耗后的后续轮次继续满足。
    const count = Math.min(quantity, Math.max(0, stockCap - (totals.get(id) ?? 0) - (plannedCounts.get(id) ?? 0)));
    for (let unit = 0; unit < count; unit++) {
      const task = createTask(recipe, owner, path);
      result.push({ id, num: 1, owner, eta: task.eta, kind: 'planned', task });
    }
    if (count < quantity) result.push({ id, num: quantity - count, owner, eta: Infinity, kind: 'missing' });
    return result;
  }

  /** 为一件待开工产品分配独占原料，并估算依赖链和工厂等待后的可用时间。 */
  function createTask(recipe, owner, path = []) {
    const task = { key: `task:${tasks.length}`, productId: recipe.itemId, recipe, owner, tier: tierOf(recipe.itemId), inputs: [], order: tasks.length };
    tasks.push(task);
    plannedCounts.set(recipe.itemId, (plannedCounts.get(recipe.itemId) ?? 0) + 1);
    for (const [id, num] of recipe.costItem) task.inputs.push(...allocate(id, num, task.key, [...path, recipe.itemId]));
    task.seconds = productionSeconds(recipe, effects);
    const buildings = factories.filter(building => resolve(building.buildingId) === recipe.buildType && building.level >= recipe.unlockLevel);
    const available = Math.min(...buildings.map(building => factoryTimes.get(building.buildingId) ?? 0));
    task.eta = Math.max(available, ...task.inputs.map(input => input.eta), 0) + task.seconds;
    return task;
  }

  /** 展开有界缺口；净需求分配与下面按优先级执行的现货准入分开，避免长任务先占住所有材料。 */
  function planMissing(id, quantity, owner, force = false) {
    for (let unit = 0; unit < Math.min(quantity, stockCap); unit++) {
      if (force) createTask(recipes.get(id), owner);
      else allocate(id, 1, owner);
    }
  }

  // 先保护所有订单已有的成品，再分配任何订单的配方，避免早处理的配方吃掉晚处理订单的现货。
  const missingNeeds = needs.map(need => ({ ...need, ...takeSupply(need.id, need.need, `demand:${need.source}:${need.id}`) }));
  for (const need of missingNeeds) planMissing(need.id, need.missing, `demand:${need.source}:${need.id}`);
  const bufferIds = [...recipes.keys()].sort((a, b) => tierOf(a) - tierOf(b));
  /** 后面的补货配方也会消耗前面的短料，迭代到不再触发新水位，防止先开中长品才发现短料断供。 */
  function planBuffers() {
    for (let pass = 0; pass < bufferIds.length; pass++) {
      let added = false;
      for (const id of bufferIds) {
        const tier = tierOf(id);
        if (tier === 3 || restocking.includes(id)) continue;
        const low = Math.min(stockCap, tier === 1 ? options.fastStockLow : options.shortStockLow);
        const high = Math.min(stockCap, tier === 1 ? options.fastStockHigh : options.shortStockHigh);
        const lots = supply.get(id) ?? [];
        const free = lots.reduce((sum, lot) => sum + lot.num, 0);
        const onHand = lots.filter(lot => lot.kind === 'stock' || lot.kind === 'finished').reduce((sum, lot) => sum + lot.num, 0);
        if (free < low) urgentProducts.add(id);
        // 触发后补到高水位；已在队列中的产出抵扣缺口，跨轮不重复下单。
        if (high > 0 && (free < low || ((state.restocking ?? []).includes(id) && onHand < high))) {
          restocking.push(id); added = true;
          const taken = takeSupply(id, high, `stock:${id}`);
          planMissing(id, taken.missing, `stock:${id}`);
        }
      }
      if (!added) break;
    }
  }
  planBuffers();
  const deferred = [...(state.deferred ?? [])];
  for (const entry of deferred) {
    const recipe = recipes.get(entry.productId);
    if (!recipe || !factories.some(building => building.buildingId === entry.buildingId)) continue;
    // 已取消的任务优先接续本轮已有同品缺口，避免「原队列任务 + 订单缺口」重复安排。
    const task = tasks.find(task => task.productId === entry.productId && !task.deferred);
    if (task) task.deferred = entry;
    else {
      const start = tasks.length;
      planMissing(entry.productId, 1, `deferred:${entry.token}`, true);
      if (tasks[start]) tasks[start].deferred = entry;
    }
  }
  planBuffers();
  const taskByKey = new Map(tasks.map(task => [task.key, task]));
  /** 队列原料通过父任务追溯真实订单，不能把任意 task: 用途都算成订单。 */
  function ownerForDemand(owner) {
    if (owner.startsWith('demand:')) return true;
    const parent = taskByKey.get(owner);
    return parent ? ownerForDemand(parent.owner) : false;
  }
  for (const task of tasks) task.demand = ownerForDemand(task.owner);
  for (const job of active) job.demand = job.usedBy.some(ownerForDemand);
  const admission = new Map(stock);
  for (const allocation of allocations) if (allocation.kind === 'stock' && allocation.owner.startsWith('demand:')) {
    admission.set(allocation.id, (admission.get(allocation.id) ?? 0) - allocation.num);
  }
  /** 保护仅持续到目标实际开工或离队；不能让旧制造位索引永久冻结工厂。 */
  function hasProtectedWaiting(buildingId) {
    const protectedJob = state.protectedJobs?.[buildingId];
    return waiting.some(job => job.buildingId === buildingId && job.idx === protectedJob?.idx && job.productId === protectedJob?.productId);
  }
  /** 保底只影响本工厂；已保护的长任务开工前不再开启下一轮抢占。 */
  function isLongDue(task, building) {
    return task.recipe.buildType === resolve(building.buildingId) && task.recipe.unlockLevel <= building.level
      && (!task.deferred || task.deferred.buildingId === building.buildingId) && !hasProtectedWaiting(building.buildingId) && !urgentBuildings.has(building.buildingId)
      && task.demand && task.tier === 3 && (state.streaks?.[building.buildingId] ?? 0) >= options.priorityBurstLimit;
  }
  /** 只有能追加或确实能提到等待队首的任务，才能预留本轮有限现货。 */
  function canAdmit(task) {
    return factories.some(building => {
      if (task.recipe.buildType !== resolve(building.buildingId) || task.recipe.unlockLevel > building.level
        || (task.deferred && task.deferred.buildingId !== building.buildingId)) return false;
      if ((building.factory.factoryQ?.length ?? 0) < slots) return true;
      if (hasProtectedWaiting(building.buildingId)) return false;
      const first = waiting.find(job => job.buildingId === building.buildingId);
      return options.reorderQueue && first && task.tier < first.tier;
    });
  }
  // 低水位是安全库存，不属于可让步的高水位补货。只有原料齐全且能排入的紧急短料才阻止长单保底。
  const urgentBuildings = new Set();
  for (const task of tasks) {
    if (!urgentProducts.has(task.productId) || !canAdmit(task) || (totals.get(task.productId) ?? 0) >= stockCap) continue;
    const required = new Map();
    for (const [id, num] of task.recipe.costItem) required.set(id, (required.get(id) ?? 0) + num);
    if (![...required].every(([id, num]) => (admission.get(id) ?? 0) >= num)) continue;
    for (const building of factories) if (resolve(building.buildingId) === task.recipe.buildType && building.level >= task.recipe.unlockLevel
      && (!task.deferred || task.deferred.buildingId === building.buildingId)) urgentBuildings.add(building.buildingId);
  }
  const readyOrder = [...tasks].sort((a, b) => Number(factories.some(building => isLongDue(b, building))) - Number(factories.some(building => isLongDue(a, building)))
    || a.tier - b.tier || Number(b.demand) - Number(a.demand) || a.order - b.order);
  for (const task of readyOrder) {
    const required = new Map();
    for (const [id, num] of task.recipe.costItem) required.set(id, (required.get(id) ?? 0) + num);
    // 净需求用于算要补多少；准入分配用于决定现在谁拿材料。每份现货只给一个完整可执行任务。
    task.ready = canAdmit(task) && (totals.get(task.productId) ?? 0) < stockCap
      && [...required].every(([id, num]) => (admission.get(id) ?? 0) >= num);
    if (task.ready) for (const [id, num] of required) admission.set(id, admission.get(id) - num);
  }
  const choices = [];
  for (const building of factories) {
    const queue = building.factory.factoryQ ?? [];
    const candidates = tasks.filter(task => task.ready && task.recipe.buildType === resolve(building.buildingId) && task.recipe.unlockLevel <= building.level
      && (!task.deferred || task.deferred.buildingId === building.buildingId) && (totals.get(task.productId) ?? 0) < stockCap);
    for (const job of waiting.filter(job => job.buildingId === building.buildingId)) {
      candidates.push({ ...job, queued: true, demand: job.usedBy.some(ownerForDemand), order: job.position, productId: job.productId });
    }
    const streak = state.streaks?.[building.buildingId] ?? 0;
    const protectedWaiting = hasProtectedWaiting(building.buildingId);
    const longDue = !protectedWaiting && !urgentBuildings.has(building.buildingId) && streak >= options.priorityBurstLimit && candidates.some(task => task.demand && task.tier === 3);
    // 每连续安排若干短料，就给已具备材料的长订单一个开工机会；其余按档位和需求顺序。
    candidates.sort((a, b) => (longDue ? Number(b.demand && b.tier === 3) - Number(a.demand && a.tier === 3) || Number(Boolean(b.queued)) - Number(Boolean(a.queued)) : 0)
      || a.tier - b.tier || Number(b.demand) - Number(a.demand) || a.order - b.order);
    let best = candidates[0];
    if (!best) continue;
    const buildingWaiting = waiting.filter(job => job.buildingId === building.buildingId);
    if (longDue && best.queued) {
      // 保护整个既有前缀，让已排好的短料先完成；不能为了保底把刚插入的短料又全部取消。
      choices.push({ kind: 'protect', building, task: best, longDue });
      continue;
    }
    if (!longDue && !protectedWaiting && options.reorderQueue) {
      // 头部已有短料不代表后面排好了：在整个等待后缀找倒置，只取消挡路后缀，不动正确前缀。
      const promotion = candidates.find(candidate => {
        const displaced = buildingWaiting.filter(job => candidate.tier < job.tier && (!candidate.queued || job.position < candidate.position));
        return displaced.reduce((sum, job) => sum + job.seconds, 0) >= 30;
      });
      if (promotion) {
        const cancel = buildingWaiting.at(-1);
        // 无法按当前配置恢复的原任务不能取消；排队里有未知配方时宁可等待，不丢用户任务。
        if (recipes.get(cancel.productId)?.buildType === resolve(building.buildingId)) {
          choices.push({ kind: 'reorder', building, task: promotion, cancel, longDue });
          continue;
        }
        warnings.push(`${cancel.productId} 等待项缺少可恢复配方，保持原队列`);
      }
    }
    // 已排好位置的等待项不能挡住剩余空位；只从尚未提交的候选中选择追加任务。
    best = candidates.find(task => !task.queued);
    if (best && queue.length < slots) choices.push({ kind: 'start', building, task: best, longDue: longDue && best.demand && best.tier === 3 });
  }
  // 可执行的长订单保底先获得原料和生产位，其余优先安排短料；每一步写后都会重新规划。
  choices.sort((a, b) => Number(b.longDue) - Number(a.longDue) || a.task.tier - b.task.tier || Number(b.task.demand) - Number(a.task.demand) || a.task.order - b.task.order);
  return { choices, restocking, allocations, tasks, active, waiting, factories, urgentBuildings: [...urgentBuildings], warnings: [...new Set(warnings)] };
}
