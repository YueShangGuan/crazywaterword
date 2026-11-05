import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, validateSettings } from '../src/automation/settings.mjs';
import { planProduction, productionEffects, productionSeconds, waitingProduction } from '../src/automation/production-planner.mjs';

/** 构造完全离线的配方和库存，不加载账号、本地游戏配置或网关。 */
function scenario({ recipes, queue = [], stock = [], needs = [], options = {}, state = {}, slots = 6 } = {}) {
  recipes ??= [recipe('快料', 60), recipe('中料', 500), recipe('长货', 7200)];
  const types = [...new Set(recipes.map(row => row.buildType))];
  return {
    config: { tables: {
      BuildingCfg: { data: types.map(buildingType => ({ buildingType })) },
      BuildingProduceCfg: { data: recipes },
      BuildingProduceParamCfg: { data: [{ paramName: '制造位上限', paramValue: slots }] },
      GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] },
    } },
    water: { building: types.map(type => ({ buildingId: `1${type}`, level: 1, factory: { factoryQ: type === types[0] ? queue : [] } })) },
    stock: new Map(stock), needs, effects: { speed: 0, reduction: 0 }, now: 1000, state,
    options: { ...defaultSettings().modules.island.factory, fastStockLow: 2, fastStockHigh: 4, shortStockLow: 1, shortStockHigh: 2, ...options },
  };
}

/** 配方时间显式给出，防止缺字段的假数据被误判成即时生产。 */
function recipe(itemId, produceTime, costItem = [['木材', 1]], buildType = '食品厂') {
  return { itemId, produceTime, costItem, buildType, unlockLevel: 1 };
}

/** 禁用常备库存时，仅比较订单及原料依赖，不混入额外补货任务。 */
function demandOnly() {
  return { fastStockLow: 0, fastStockHigh: 0, shortStockLow: 0, shortStockHigh: 0 };
}

test('production time: fixed reduction precedes speed division, and missing times are not instant', () => {
  assert.equal(productionSeconds({ produceTime: 1800 }, { reduction: 180, speed: 0.23 }), 1318);
  assert.equal(productionSeconds({ produceTime: 90 }, { reduction: 180, speed: 0.23 }), 0);
  assert.equal(productionSeconds({}), Infinity);
  const protocol = { GameEffectId: { PRODUCE_SPEED_UP: 1, PRODUCE_TIME_REDUCTION: 2 } };
  assert.deepEqual(productionEffects({ effects: [{ id: 1, value: 0.23 }] }, protocol, { effect: { id: 2, value: 180 } }), { speed: 0.23, reduction: 180 });
});

test('production tiers: threshold boundaries use single-item duration, not queue ETA', () => {
  const input = scenario({ recipes: [recipe('快料', 300), recipe('中料', 600), recipe('长货', 601)], stock: [['木材', 50]],
    needs: [{ id: '长货', need: 1, source: 'resident' }], queue: [{ idx: 1, productId: '长货', finishTime: 8200 }] });
  input.needs[0].need = 2;
  const plan = planProduction(input);
  assert.equal(plan.tasks.find(task => task.productId === '快料').tier, 1);
  assert.equal(plan.tasks.find(task => task.productId === '中料').tier, 2);
  assert.equal(plan.tasks.find(task => task.productId === '长货').tier, 3);
  assert.ok(plan.tasks.find(task => task.productId === '快料').eta > 300);
  assert.equal(plan.choices[0].task.productId, '快料');
});

test('stock watermarks: low triggers, high stops, and hysteresis survives between rounds', () => {
  const input = scenario({ recipes: [recipe('快料', 60)], stock: [['快料', 1], ['木材', 50]] });
  assert.equal(planProduction(input).tasks.length, 3);
  input.stock.set('快料', 2);
  assert.equal(planProduction(input).tasks.length, 0, 'equal to low is not below low');
  input.stock.set('快料', 3); input.state.restocking = ['快料'];
  assert.equal(planProduction(input).tasks.length, 1);
  input.stock.set('快料', 4);
  assert.deepEqual(planProduction(input).restocking, []);
});

test('stock watermarks: queued and uncollected output cover the target without repeated production', () => {
  const input = scenario({ recipes: [recipe('快料', 60)], stock: [['快料', 1], ['木材', 50]], state: { restocking: ['快料'] },
    queue: [{ idx: 1, productId: '快料', finishTime: 2000 }, { idx: 2, productId: '快料', finishTime: 0 }] });
  input.water.building[0].factory.finishedProducts = [{ id: '快料', num: 1 }];
  assert.equal(planProduction(input).tasks.length, 0);
  assert.equal(planProduction(input).choices.length, 0);
});

test('shared ingredients: two factories cannot admit the same unit of raw material', () => {
  const plan = planProduction(scenario({ recipes: [recipe('长货甲', 7200), recipe('长货乙', 7200, [['木材', 1]], '服装厂')],
    stock: [['木材', 1]], needs: [{ id: '长货甲', need: 1, source: 'resident' }, { id: '长货乙', need: 1, source: 'cargo' }], options: demandOnly() }));
  assert.equal(plan.tasks.filter(task => task.ready).length, 1);
  assert.equal(plan.choices.length, 1);
  assert.equal(plan.allocations.filter(row => row.id === '木材' && row.kind === 'stock').reduce((sum, row) => sum + row.num, 0), 1);
});

test('shared ingredients: protect every order output before expanding earlier order recipes', () => {
  const plan = planProduction(scenario({ recipes: [recipe('长货', 7200, [['快料', 1]]), recipe('快料', 60)], stock: [['快料', 1], ['木材', 1]],
    needs: [{ id: '长货', need: 1, source: 'resident' }, { id: '快料', need: 1, source: 'cargo' }], options: demandOnly() }));
  assert.equal(plan.tasks.find(task => task.productId === '长货').ready, false);
  assert.equal(plan.choices[0].task.productId, '快料');
  assert.equal(plan.allocations.find(row => row.id === '快料' && row.kind === 'stock').owner, 'demand:cargo:快料');
});

test('shared ingredients: buffers cover downstream consumption plus surplus, not just order item counts', () => {
  const plan = planProduction(scenario({ recipes: [recipe('长货', 7200, [['快料', 2]]), recipe('快料', 60)], stock: [['快料', 3], ['木材', 20]],
    needs: [{ id: '长货', need: 2, source: 'resident' }] }));
  assert.equal(plan.tasks.filter(task => task.productId === '快料').length, 5, 'four consumed by orders plus four surplus, minus three owned');
  assert.equal(plan.choices[0].task.productId, '快料');
});

test('material admission: short buffers can take scarce raw stock before long demand', () => {
  const plan = planProduction(scenario({ recipes: [recipe('长货', 7200), recipe('快料', 60)], stock: [['木材', 1]],
    needs: [{ id: '长货', need: 1, source: 'resident' }] }));
  assert.equal(plan.choices[0].task.productId, '快料');
  assert.equal(plan.tasks.filter(task => task.ready).length, 1);
});

test('material admission: incomplete recipes cannot hold partial stock and block a complete short recipe', () => {
  const plan = planProduction(scenario({ recipes: [recipe('长货', 7200, [['木材', 1], ['未知材料', 1]]), recipe('快料', 60)], stock: [['木材', 1]],
    needs: [{ id: '长货', need: 1, source: 'resident' }] }));
  assert.equal(plan.choices[0].task.productId, '快料');
  assert.equal(plan.tasks.find(task => task.productId === '长货').ready, false);
});

test('reordering: both active month-card lanes and unknown first job stay protected', () => {
  const queue = [{ idx: 1, productId: '长货', finishTime: 8200 }, { idx: 2, productId: '长货', finishTime: 8000 }, { idx: 3, productId: '长货', finishTime: 0 }];
  const plan = planProduction(scenario({ stock: [['木材', 10]], queue, slots: 3 }));
  assert.equal(plan.choices[0].kind, 'reorder');
  assert.equal(plan.choices[0].cancel.idx, 3);
  assert.equal(plan.active.length, 2);
  assert.equal(waitingProduction([{ finishTime: 0 }], 0), false);
  assert.equal(waitingProduction(queue, 1), false);
});

test('reordering: correctly placed waiting products do not block filling remaining slots', () => {
  const input = scenario({ recipes: [recipe('快料', 60)], stock: [['木材', 10]], state: { restocking: ['快料'] },
    queue: [{ idx: 1, productId: '快料', finishTime: 1100 }, { idx: 2, productId: '快料', finishTime: 0 }] });
  const plan = planProduction(input);
  assert.equal(plan.choices[0].kind, 'start');
  assert.equal(plan.tasks.length, 2);
});

test('reordering: an already-prioritized short prefix cannot hide a blocked short suffix', () => {
  const plan = planProduction(scenario({ stock: [['木材', 20]], queue: [{ idx: 1, productId: '长货', finishTime: 8000 },
    { idx: 2, productId: '快料', finishTime: 0 }, { idx: 3, productId: '长货', finishTime: 0 }] }));
  assert.equal(plan.choices[0].kind, 'reorder');
  assert.equal(plan.choices[0].cancel.idx, 3, 'the correct short prefix is not canceled');
});

test('stock dependencies: medium-tier replenishment must also retain a fast-material surplus', () => {
  const plan = planProduction(scenario({ recipes: [recipe('快料', 60), recipe('中料', 500, [['快料', 2]])],
    stock: [['快料', 2], ['木材', 20]] }));
  assert.ok(plan.restocking.includes('快料'), 'medium buffer consumes two existing fast inputs and needs two more');
  assert.equal(plan.tasks.filter(task => task.productId === '快料').length, 6, 'four medium inputs and four surplus minus two stocked');
  assert.equal(plan.choices[0].task.productId, '快料');
});

test('long-job fairness: after a short burst, reserve long demand and protect its existing prefix', () => {
  const input = scenario({ recipes: [recipe('长货', 7200), recipe('快料', 60)], stock: [['木材', 1], ['快料', 2]],
    needs: [{ id: '长货', need: 1, source: 'resident' }], state: { restocking: ['快料'], streaks: { '1食品厂': 3 } } });
  assert.equal(planProduction(input).choices[0].task.productId, '长货');
  input.water.building[0].factory.factoryQ = [{ idx: 1, productId: '快料', finishTime: 1050 }, { idx: 2, productId: '快料', finishTime: 0 }, { idx: 3, productId: '长货', finishTime: 0 }];
  assert.equal(planProduction(input).choices[0].kind, 'protect');
  input.state.protectedJobs = { '1食品厂': { idx: 3, productId: '长货' } };
  const plan = planProduction(input);
  assert.ok(plan.choices.every(choice => choice.kind !== 'reorder'), 'shorts cannot displace a protected long job next round');
});

test('long-job fairness: critical low-stock recovery precedes the burst guarantee', () => {
  const plan = planProduction(scenario({ recipes: [recipe('长货', 7200), recipe('快料', 60)], stock: [['木材', 1]],
    needs: [{ id: '长货', need: 1, source: 'resident' }], state: { streaks: { '1食品厂': 3 } } }));
  assert.equal(plan.choices[0].task.productId, '快料');
  assert.deepEqual(plan.urgentBuildings, ['1食品厂']);
});

test('long-job fairness: impossible critical restocking cannot block an otherwise ready long order', () => {
  const plan = planProduction(scenario({ recipes: [recipe('长货', 7200), recipe('快料', 60, [['缺少原料', 1]])], stock: [['木材', 1]],
    needs: [{ id: '长货', need: 1, source: 'resident' }], state: { streaks: { '1食品厂': 3 } } }));
  assert.equal(plan.choices[0].task.productId, '长货');
  assert.deepEqual(plan.urgentBuildings, []);
});

test('deferred jobs: attach one canceled intent to an existing gap without duplicating it', () => {
  const plan = planProduction(scenario({ recipes: [recipe('长货', 7200)], stock: [['木材', 1]], options: demandOnly(),
    needs: [{ id: '长货', need: 1, source: 'resident' }], state: { deferred: [{ buildingId: '1食品厂', productId: '长货', token: 'saved' }] } }));
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.choices[0].task.deferred.token, 'saved');
});

test('invalid config: missing production duration cannot trigger zero-time replenishment', () => {
  const plan = planProduction(scenario({ recipes: [recipe('坏配方', undefined)], stock: [['木材', 100]] }));
  assert.equal(plan.choices.length, 0);
  assert.match(plan.warnings[0], /缺少有效生产时间/);
});

test('reordering: unknown waiting recipes cannot be canceled and silently lost', () => {
  const plan = planProduction(scenario({ recipes: [recipe('快料', 60)], stock: [['木材', 100]], slots: 2,
    queue: [{ idx: 1, productId: '未知旧任务', finishTime: 5000 }, { idx: 2, productId: '未知旧任务', finishTime: 0 }] }));
  assert.equal(plan.choices.length, 0);
  assert.ok(plan.warnings.some(warning => warning.includes('保持原队列')));
});

test('factory boundaries: disabled, locked and activity recipes do not receive ordinary production', () => {
  const input = scenario({ recipes: [recipe('快料', 60), recipe('锁定配方', 60), recipe('活动产物', 0, [], '活动工厂')] });
  input.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  input.stock.set('木材', 10);
  input.options.disabledFactories = ['食品厂'];
  assert.equal(planProduction(input).choices.length, 0);
  input.options.disabledFactories = [];
  assert.deepEqual([...new Set(planProduction(input).tasks.map(task => task.productId))], ['快料']);
});

test('queue policy: reordering can be disabled without disabling replenishment in free slots', () => {
  const input = scenario({ stock: [['木材', 50]], options: { reorderQueue: false }, slots: 2,
    queue: [{ idx: 1, productId: '长货', finishTime: 5000 }, { idx: 2, productId: '长货', finishTime: 0 }] });
  assert.equal(planProduction(input).choices.length, 0);
  input.config.tables.BuildingProduceParamCfg.data[0].paramValue = 3;
  assert.equal(planProduction(input).choices[0].kind, 'start');
});

test('factory settings: reject inverted tiers, inverted watermarks, and disabled fairness', () => {
  for (const changes of [{ fastTimeSecs: 601 }, { fastStockLow: 11 }, { shortStockLow: 6 }, { priorityBurstLimit: 0 }]) {
    const settings = defaultSettings(); Object.assign(settings.modules.island.factory, changes);
    assert.throws(() => validateSettings(settings));
  }
  const settings = defaultSettings(); settings.modules.island.factory.fastTimeSecs = 0;
  assert.equal(validateSettings(settings).modules.island.factory.fastTimeSecs, 0);
});


test('Monday guild: shared ingredients and dependencies precede other orders and buffers', () => {
  const input = scenario({ recipes: [recipe('快料', 60), recipe('募兵货', 7200, [['中料', 1]]), recipe('中料', 500)],
    stock: [['木材', 1]], needs: [{ id: '快料', need: 1, source: 'resident' }, { id: '募兵货', need: 1, source: 'guild' }] });
  input.guildPriority = true;
  const plan = planProduction(input);
  assert.equal(plan.choices[0].task.productId, '中料');
  assert.equal(plan.choices[0].task.guildPriority, true);
  assert.equal(plan.tasks.filter(task => task.ready).length, 1);
  assert.equal(plan.allocations.filter(row => row.id === '木材' && row.kind === 'stock').reduce((sum, row) => sum + row.num, 0), 1);
  input.guildPriority = false;
  assert.equal(planProduction(input).choices[0].task.productId, '快料');
});

test('Monday guild: guild dependencies can use stock claimed by a later ordinary order; inventory is exclusive', () => {
  const input = scenario({ recipes: [recipe('募兵货', 7200, [['快料', 1]]), recipe('快料', 60)], stock: [['快料', 1]],
    needs: [{ id: '快料', need: 1, source: 'resident' }, { id: '募兵货', need: 1, source: 'guild' }], options: demandOnly() });
  input.guildPriority = true;
  const plan = planProduction(input);
  assert.equal(plan.choices[0].task.productId, '募兵货');
  assert.equal(plan.allocations.filter(row => row.id === '快料' && row.kind === 'stock').length, 1);
});

test('Monday guild: full automatic queues and protected waiting jobs stay protected', () => {
  for (const automatic of [false, true]) {
    const input = scenario({ recipes: [recipe('募兵货', 7200), recipe('快料', 60)], stock: [['木材', 2]], slots: 2,
      queue: [{ idx: 1, productId: '快料', finishTime: 1100 }, { idx: 2, productId: '快料', finishTime: 0 }],
      needs: [{ id: '募兵货', need: 1, source: 'guild' }], options: demandOnly(),
      state: { protectedJobs: { '1食品厂': { idx: 2, productId: '快料' } } } });
    input.guildPriority = true; input.water.building[0].factory.autoProductId = automatic ? '快料' : '';
    assert.equal(planProduction(input).choices.length, 0);
  }
});


test('Monday guild: partially supplied guild recipe reserves ingredients from ordinary ready tasks', () => {
  const input = scenario({ recipes: [recipe('募兵货', 7200, [['木材', 1], ['铁矿', 1]]), recipe('普通货', 60)],
    stock: [['木材', 1]], needs: [{ id: '普通货', need: 1, source: 'resident' }, { id: '募兵货', need: 1, source: 'guild' }], options: demandOnly() });
  input.guildPriority = true;
  assert.equal(planProduction(input).choices.length, 0, 'wood stays reserved for the incomplete guild recipe');
  input.guildPriority = false;
  assert.equal(planProduction(input).choices[0].task.productId, '普通货', 'ordinary admission policy resumes on other days');
});
