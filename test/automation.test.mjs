import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { after, test } from 'node:test';
import { loadProtocol } from '../src/proto.mjs';
import { fields } from '../tools/describe.mjs';
import { summarize } from '../src/game.mjs';

// 固定隔离目录，不读取真实账号或活动记录；模拟网关不创建 WebSocket。
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-automation-'));
process.env.CW_DATA_DIR = directory;
const { defaultSettings, saveSettings, loadSettings, businessDate, loadLedger, validateSettings, accountDirectory } = await import('../src/automation/settings.mjs');
const { createContext, idString, validateMessage, withRoleLock } = await import('../src/automation/context.mjs');
const { runAutomation, HANDLERS, handledDailyIds, guardedDailyAction, automationStatus } = await import('../src/automation/service.mjs');
const { resetRepairSpeedUpFallbackState } = await import('../src/automation/world.mjs');
const { inWindows } = await import('../src/automation/common.mjs');
const { placementsFor } = await import('../src/automation/snap.mjs');
const { scheduleProduction } = await import('../src/automation/production.mjs');
const { expeditionHealth, passReady } = await import('../src/automation/battle.mjs');
const { GameClient } = await import('../src/client.mjs');
const { PAGE } = await import('../src/page.mjs');
const { AUTOMATION_SCRIPT } = await import('../src/automation-ui.mjs');
const { automationFormOptions } = await import('../src/automation/form-options.mjs');
const protocol = loadProtocol();
const fixedNow = Date.parse('2026-10-29T12:45:00+08:00');
let sequence = 0;

after(() => { fs.rmSync(directory, { recursive: true, force: true }); });

/** 只补齐当前编码器要求的必填字段，不加入旧版本字段或业务猜测值。 */
function required(name, value = {}) {
  const result = { ...value };
  for (const field of fields(name)) {
    if (result[field.name] === undefined && field.required) {
      if (field.kind === 'message') result[field.name] = required(field.type);
      else result[field.name] = field.type === 'string' ? '' : field.type === 'bool' ? false : 0;
    }
    if (field.kind === 'message' && result[field.name]) result[field.name] = required(field.type, result[field.name]);
    if (field.kind === 'repeated' && protocol[field.type]?.encode && result[field.name]) result[field.name] = result[field.name].map(row => required(field.type, row));
  }
  return result;
}

/** 内存网关校验双向 Protobuf，并显式记录每个业务请求供次数与顺序断言。 */
class Gateway extends EventEmitter {
  /** 状态由每个用例固定提供，禁止外部网络。 */
  constructor(states = {}, handlers = {}) {
    super(); this.connected = true; this.states = states; this.handlers = handlers; this.calls = []; this.items = new Map(); this.ruby = 1000;
    // 与真实 GameClient 一致，允许维修计价用例独立模拟服务器时钟偏差。
    this.serverClockOffsetMs = 0;
  }
  /** 与真实客户端一致地终止测试会话，确保控制台关闭不残留后台任务。 */
  stop() { this.connected = false; this.emit('close', {}); }
  /** 读写都经过当前 game.js 编解码器，字段不匹配立即失败。 */
  async request(name, body, response) {
    validateMessage(protocol[name], body);
    this.calls.push({ name, body, response });
    let data;
    if (this.handlers[name]) data = await this.handlers[name](body, response, this);
    else if (name === 'AllItemRequest') data = { items: [...this.items].map(([itemId, num]) => ({ itemId, num })) };
    else if (name === 'AllResourceRequest') data = { list: [{ res: protocol.Resource.RUBY, amount: this.ruby }] };
    else data = this.states[name] ?? {};
    // 库存和资源也走同一响应编解码，避免测试用普通 Number 掩盖 int64 转换错误。
    return validateMessage(protocol[response], required(response, data));
  }
  /** 静默写入通过显式状态处理器推进，不能自行当作业务成功。 */
  async sendWatch(name, body) {
    validateMessage(protocol[name], body); this.calls.push({ name, body });
    if (this.handlers[name]) await this.handlers[name](body, null, this);
    return { sent: this.calls.length };
  }
}

/** 每个用例得到独立账号和角色，日额度与不确定结果互不污染。 */
function fixture({ settings = defaultSettings(), states, handlers, dryRun = false, now = () => fixedNow, player = {} } = {}) {
  const client = new Gateway(states, handlers), accountId = `fixture-${++sequence}`;
  const args = { client, protocol, config: { tables: {} }, player: { playerId: '9007199254740993', level: 100, mainlineStage: 10, ...player }, accountId, settings, dryRun, now };
  const ctx = createContext(args); ctx.setModule('battle');
  return { client, ctx, args, settings };
}

/** 固定测试表只包含本用例需要的规则，避免依赖本机素材或线上配置变化。 */
function table(ctx, name, rows) { ctx.config.tables[name] = { data: rows }; }

/** 仅模拟工厂生产协议及实际返还，所有读写仍通过真实 protobuf 校验，绝不连接账号。 */
function productionFixture({ queue = [], stock = [['木材', 20]], recipes, options = {}, slots = 4, refund = true, dryRun = false, autoProductId = '' } = {}) {
  recipes ??= [{ buildType: '食品厂', itemId: '快料', produceTime: 60, unlockLevel: 1, costItem: [['木材', 1]] },
    { buildType: '食品厂', itemId: '长货', produceTime: 7200, unlockLevel: 1, costItem: [['木材', 1]] }];
  const f = fixture({ dryRun, states: { OnWaterRequest: { building: [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: structuredClone(queue), autoProductId, finishedProducts: [] } }] } } });
  f.ctx.setModule('island');
  Object.assign(f.settings.modules.island.factory, { priorityProduce: true, fastStockLow: 2, fastStockHigh: 3, shortStockLow: 1, shortStockHigh: 2, priorityBurstLimit: 10, ...options });
  table(f.ctx, 'BuildingCfg', [{ buildingType: '食品厂' }]);
  table(f.ctx, 'BuildingProduceParamCfg', [{ paramName: '制造位上限', paramValue: slots }]);
  table(f.ctx, 'GameParamCfg', [{ paramName: '产品存量初始上限', paramValue: 50 }]);
  table(f.ctx, 'BuildingProduceCfg', recipes);
  for (const [id, num] of stock) f.client.items.set(id, num);
  let nextIndex = 100;
  f.client.handlers.StartFactoryProduceRequest = async body => {
    const factory = f.client.states.OnWaterRequest.building[0].factory;
    const recipe = recipes.find(row => row.itemId === body.productId);
    assert.ok(factory.factoryQ.length < slots, 'scheduler must respect queue capacity');
    for (const [id, num] of recipe.costItem) { assert.ok((f.client.items.get(id) ?? 0) >= num); f.client.items.set(id, f.client.items.get(id) - num); }
    // 只有空队列中的即时配方可直接完成，不能把排在长任务后的零秒项假装已经生产。
    if (!factory.factoryQ.length && recipe.produceTime === 0) factory.finishedProducts.push({ type: 0, id: body.productId, num: 1 });
    else factory.factoryQ.push({ idx: nextIndex++, productId: body.productId, finishTime: factory.factoryQ.length ? 0 : fixedNow / 1000 + recipe.produceTime });
  };
  f.client.handlers.CancelFactoryProduceRequest = async body => {
    const factory = f.client.states.OnWaterRequest.building[0].factory;
    const index = factory.factoryQ.findIndex(job => job.idx === body.index);
    assert.ok(index > 0 && factory.factoryQ[index].finishTime === 0, 'no running lane may be canceled');
    const [job] = factory.factoryQ.splice(index, 1);
    // 测试可以禁用返还，检查调度器不会凭配方虚增库存。
    if (refund) for (const [id, num] of recipes.find(row => row.itemId === job.productId).costItem) f.client.items.set(id, (f.client.items.get(id) ?? 0) + num);
  };
  f.client.handlers.CancelFactoryAutoProduceRequest = async () => { f.client.states.OnWaterRequest.building[0].factory.autoProductId = ''; };
  f.client.handlers.GainFactoryProduceRequest = async () => {
    const factory = f.client.states.OnWaterRequest.building[0].factory;
    const asset = factory.finishedProducts;
    for (const item of asset) f.client.items.set(item.id, (f.client.items.get(item.id) ?? 0) + Number(item.num));
    factory.finishedProducts = [];
    return { products: { asset } };
  };
  return f;
}

/** 同一套上下文进入下一轮，检验持久化水位及队列读回，不直接修改调度内部状态。 */
async function runProduction(f, needs = []) {
  await f.ctx.refreshStock();
  await scheduleProduction(f.ctx, f.settings.modules.island.factory, needs, []);
}

/**
 * Evaluates only the browser script's setting-copy declarations. DOM setup is
 * deliberately excluded so the assertion checks the same copy resolver that
 * the page uses without creating a real page or touching an account.
 *
 * @returns {{settingCopy: (path: string[], key: string) => {title: string, note: string}, ruleCopy: Record<string, string>}} Copy helpers from the UI script.
 */
function automationCopyHelpers() {
  const boundary = AUTOMATION_SCRIPT.indexOf('\nfunction settingText');
  assert.notEqual(boundary, -1, 'setting copy declarations must precede DOM rendering');
  const sandbox = {};
  vm.runInNewContext(`${AUTOMATION_SCRIPT.slice(0, boundary)}\nglobalThis.copyHelpers = { settingCopy, ruleCopy: automationRuleFieldCopy };`, sandbox);
  return sandbox.copyHelpers;
}

/**
 * Collects scalar and collection leaves rendered by the automation settings
 * form so a new setting cannot silently fall back to the generic copy.
 *
 * @param {unknown} value Current settings subtree.
 * @param {string[]} path Path to the subtree.
 * @param {Array<{path: string[], key: string}>} result Accumulated setting leaves.
 * @returns {Array<{path: string[], key: string}>} Rendered setting leaves.
 */
function automationSettingLeaves(value, path = [], result = []) {
  if (Array.isArray(value) || !value || typeof value !== 'object') {
    result.push({ path, key: path.at(-1) });
    return result;
  }
  for (const [key, child] of Object.entries(value)) automationSettingLeaves(child, path.concat(key), result);
  return result;
}

/** 指定模块只开启要验证的分支，其余分支用原始默认关闭值。 */
async function moduleRun(id, changes, setup, options = {}) {
  const f = fixture(options); Object.assign(f.settings.modules[id], changes);
  f.settings.modules[id].enabled = true; f.ctx.setModule(id);
  try { await setup?.(f); await f.ctx.refreshStock(); await HANDLERS[id](f.ctx, f.settings.modules[id]); return f; }
  finally { f.ctx.dispose(); }
}

/** 模拟酆都服务端的扣券、显化和结算状态；所有请求仍通过当前 protobuf 往返校验。 */
function edictFixture({ session = null, tickets = 3, dryRun = false } = {}) {
  const f = fixture({ dryRun });
  f.ctx.setModule('activity');
  f.settings.modules.activity.enabled = true;
  f.settings.modules.activity.edict.enabled = true;
  f.event = { activityId: '9007199254740993', type: '捞尸人联动活动', openTime: fixedNow / 1000 - 100, closeTime: fixedNow / 1000 + 1000 };
  f.ctx.pushes.set('SCAllActivity', { festivalActivities: [f.event] });
  f.edictState = { session, cost: { type: 0, id: '本期酆都入场券', num: 1 } };
  f.client.items.set('本期酆都入场券', tickets);
  // 使用服务端状态推进，禁止只返回成功而未完成显化的测试替身掩盖业务守卫。
  f.client.handlers.EdictInfoRequest = async () => structuredClone(f.edictState);
  f.client.handlers.EdictStartRequest = async () => {
    assert.equal(f.edictState.session, null, '已有局不能重复开局');
    f.client.items.set('本期酆都入场券', f.client.items.get('本期酆都入场券') - 1);
    f.edictState.session = { rune: [4, 2, 3, 1], shown: [0, 0, 0, 0], patience: 100 };
    return { session: structuredClone(f.edictState.session) };
  };
  f.client.handlers.EdictAskRequest = async ({ paperIdx }) => {
    const current = f.edictState.session;
    assert.equal(current.shown[paperIdx], 0, '每张符文最多新增一次显化');
    current.shown[paperIdx] = 1 << paperIdx;
    current.patience -= 5;
    return { cellIdx: paperIdx, patience: current.patience };
  };
  f.client.handlers.EdictGuessRequest = async ({ guess }) => {
    assert.ok(f.edictState.session.shown.every(shown => shown > 0), '必须先逐张显化');
    assert.deepEqual(guess, f.edictState.session.rune);
    f.edictState.session = null;
    f.client.items.set('酆都奖励券', 2);
    return { correct: [true, true, true, true], success: true, score: 80, reward: { asset: [{ type: 0, id: '酆都奖励券', num: 2 }] } };
  };
  return f;
}

/** 离线执行一次活动；释放连接监听器，且不创建 WebSocket 或读取真实账号配置。 */
async function runEdict(f) {
  try { await f.ctx.refreshStock(); await HANDLERS.activity(f.ctx, f.settings.modules.activity); return f; }
  finally { f.ctx.dispose(); }
}

test('settings: defaults off; account isolation; strict arrays, dictionaries and time rules', () => {
  const settings = defaultSettings();
  assert.ok(Object.values(settings.modules).every(row => !row.enabled));
  assert.equal(settings.spending.enabled, false);
  assert.equal(settings.vipFreeAd, false);
  assert.equal(settings.modules.welfare.weeklyLottery, false);
  assert.equal(settings.modules.welfare.uniqueLottery, false);
  assert.equal(settings.modules.world.merchantShip.enabled, false);
  // 旧账号设置没有此字段时，校验器按新功能的安全默认值补成关闭。
  delete settings.modules.welfare.weeklyLottery;
  saveSettings('settings-a', settings); settings.season = 3;
  assert.equal(loadSettings('settings-a').season, 0); assert.equal(loadSettings('settings-a').modules.welfare.weeklyLottery, false);
  assert.equal(loadSettings('settings-b').season, 0);
  // 钻石余额保留量是精确的非负整数，不能因表单或服务端校验被隐式改成 9999。
  settings.spending.minRubyStock = 10000;
  const preservedRubyStock = validateSettings(settings);
  assert.equal(preservedRubyStock.spending.minRubyStock, 10000);
  saveSettings('settings-c', preservedRubyStock);
  assert.equal(loadSettings('settings-c').spending.minRubyStock, 10000);
  settings.modules.hero.heroes = [1]; assert.throws(() => validateSettings(settings), /字符串/);
  settings.modules.hero.heroes = []; settings.modules.world.chipMine.hours = [24]; assert.throws(() => validateSettings(settings), /整数/);
  settings.modules.world.chipMine.hours = []; settings.modules.world.pirate.attackTime.start = '25:00'; assert.throws(() => validateSettings(settings), /HH/);
  settings.modules.world.pirate.attackTime.start = '00:00'; settings.modules.farm.cropKeepStock = { 玉米: -1 }; assert.throws(() => validateSettings(settings), /非负/);
  assert.throws(() => validateSettings(JSON.parse('{"__proto__":{}}')), /禁止/);
});

test('automation UI: merchant ship uses form controls instead of a fleet JSON textarea', () => {
  assert.match(PAGE, /data-merchant-ship-fleet/);
  assert.match(PAGE, /添加舰队/);
  assert.match(PAGE, /请填写每支已勾选商船舰队的建筑 ID/);
  assert.doesNotMatch(PAGE, /merchantShip.*舰队规则（JSON 数组）/);
});

test('automation UI: diamond copy distinguishes balance protection from daily allowances', () => {
  assert.match(AUTOMATION_SCRIPT, /当前角色游戏内钻石余额的下限，不是每日可用额度/);
  assert.match(AUTOMATION_SCRIPT, /10000 会按原值保存/);
  assert.match(AUTOMATION_SCRIPT, /同一账号所有角色在上海自然日内合计的消费上限/);
});

/** 设置说明区分已接通的三类试炼权益和仍待接入的其他广告场景。 */
test('automation UI: VIP免广告 copy documents the confirmed ad scenes', () => {
  assert.match(AUTOMATION_SCRIPT, /VIP免广告/);
  assert.match(AUTOMATION_SCRIPT, /工厂生产广告加速/);
  assert.match(AUTOMATION_SCRIPT, /建筑升级广告加速/);
  assert.match(AUTOMATION_SCRIPT, /英雄广告招募/);
  assert.match(AUTOMATION_SCRIPT, /藏品广告招募/);
  assert.match(AUTOMATION_SCRIPT, /广告商店奖励/);
  assert.match(AUTOMATION_SCRIPT, /VIP 达到 3 级/);
  assert.match(AUTOMATION_SCRIPT, /英雄经验、强化石、宠物经验试炼的每日免广告额外扫荡奖励/);
  assert.match(AUTOMATION_SCRIPT, /无需开启钻石扫荡/);
  assert.match(AUTOMATION_SCRIPT, /暂未接入此开关/);
});

test('automation UI: every rendered setting has specific functionality and scope copy', () => {
  const { settingCopy, ruleCopy } = automationCopyHelpers();
  const settings = defaultSettings();
  const rendered = { season:settings.season, vipFreeAd:settings.vipFreeAd, spending:settings.spending, modules:settings.modules };
  for (const { path, key } of automationSettingLeaves(rendered)) {
    const copy = settingCopy(path, key);
    assert.ok(copy.note, `${path.join('.')} must explain its behavior and scope`);
    assert.doesNotMatch(copy.note, /设置“.+”的值；保存后只影响所属自动化分支/, `${path.join('.')} must not use generic fallback copy`);
  }
  for (const [key, note] of Object.entries(ruleCopy)) {
    assert.match(note, /功能：.+影响范围：/, `${key} rule must explain functionality and scope`);
  }
});

test('automation UI: merchant ship and trade reuse the shared configuration layout', () => {
  assert.match(AUTOMATION_SCRIPT, /function merchantShipFields\(value, path\)/);
  assert.match(AUTOMATION_SCRIPT, /function tradeFields\(value, path\)/);
  assert.match(AUTOMATION_SCRIPT, /settingHeading\(merchantCopy\.title, merchantCopy\.note\)/);
  assert.match(AUTOMATION_SCRIPT, /settingHeading\(tradeCopy\.title, tradeCopy\.note\)/);
  assert.doesNotMatch(AUTOMATION_SCRIPT, /merchant-ship-panel|merchant-ship-heading|merchant-ship-badge/);
  assert.match(PAGE, /\.automation-editor-row > select/);
  assert.doesNotMatch(PAGE, /\.merchant-ship-panel/);
  assert.match(AUTOMATION_SCRIPT, /modules\.world\.trade/);
  assert.match(AUTOMATION_SCRIPT, /group\.open = id === 'world'/);
  for (const field of ['开启海商王', '领取贸易战报、成就和通行证奖励', '自动升级贸易船', '允许航行加速', '每日航行加速次数', '航行加速最低累计利润']) {
    assert.match(AUTOMATION_SCRIPT, new RegExp(field));
  }
});

/** 利润是允许开始加速的下限，说明必须与现有 >= 判断一致，而不是描述成停止上限。 */
test('automation UI: trade profit copy describes the minimum and zero semantics', () => {
  const { settingCopy } = automationCopyHelpers();
  const copy = settingCopy(['modules', 'world', 'trade', 'profitLimit'], 'profitLimit');
  assert.equal(copy.title, '航行加速最低累计利润');
  assert.match(copy.note, /不低于此值时才允许/);
  assert.match(copy.note, /0 表示利润非负时/);
  assert.doesNotMatch(AUTOMATION_SCRIPT, /达到此利润后(?:停止|不)加速|达到(?:此|该)值后(?:不再|停止).*加速/);
});

/** 开关实际允许钻石消费，说明需明确分钟取整和完整额度护栏，不能仍宣称只使用道具。 */
test('automation UI: repair copy explains rounded-minute ruby pricing and guards', () => {
  const { settingCopy } = automationCopyHelpers();
  const copy = settingCopy(['modules', 'world', 'fleet', 'repairSpeedUp'], 'repairSpeedUp');
  assert.match(copy.title, /可使用钻石/);
  assert.match(copy.note, /分钟数向上取整，每分钟 10 钻/);
  assert.match(copy.note, /60 秒 10 钻，61 秒 20 钻/);
  assert.match(copy.note, /完整费用.*总额度、模块额度和余额保留量/);
});

/** 本次只纠正文案；用预览验证门槛以下、等于及高于门槛和零值的现有行为不变。 */
test('trade: profit remains the minimum required for acceleration', async () => {
  for (const [profit, profitLimit, allowed] of [[9999, 10000, false], [10000, 10000, true], [10001, 10000, true], [0, 0, true], [-1, 0, false]]) {
    const f = await moduleRun('world', {
      trade: { enabled: true, claim: false, upgrade: false, speedUp: true, speedUpDailyLimit: 2, profitLimit },
    }, ({ client }) => client.items.set('海商王加速', 1), {
      dryRun: true,
      states: { TradeInfoRequest: { cargo: { moveEndTime: fixedNow / 1000 + 600 }, player: { profit } } },
    });
    const plans = f.ctx.results.filter(result => result.request === 'TradeSpeedRequest');
    assert.equal(plans.length, allowed ? 1 : 0, `profit=${profit}, limit=${profitLimit}`);
    if (allowed) {
      assert.equal(plans[0].status, 'planned');
      assert.equal(plans[0].ruby, 0);
    }
  }
});

test('overview: trade radar keeps readable city, goods and shared-player names', () => {
  const view = summarize({ ok: { TradeGuildRadarRequest: { radar: [{ cityId: 64, specGoodsId: 4005, rareGoodsId: 3004, reportName: '共享人' }] } } }, {
    config: { tables: { CityCfg: { data: [{ id: 64, name: '要塞G3' }] }, TradeGoodsCfg: { data: [{ goodsId: 4005, itemName: '维生素补剂' }, { goodsId: 3004, itemName: '睡袋' }] } } },
  });
  assert.deepEqual(view.tradeRadar, [{ cityId: 64, cityName: '要塞G3', specGoodsId: 4005, specGoodsName: '维生素补剂', rareGoodsId: 3004, rareGoodsName: '睡袋', reportName: '共享人' }]);
  assert.match(PAGE, /trade-radar-disclosure/);
  assert.match(PAGE, /共享人/);
  assert.match(PAGE, /特产/);
  assert.match(PAGE, /紧缺/);
});

test('overview: raw material inventory is separated from top item inventory', () => {
  const view = summarize({ ok: {
    AllItemRequest: { items: [{ itemId: '木材', num: 12 }, { itemId: '鱼', num: 3 }, { itemId: '英雄经验', num: 999 }] },
    GameEffectRequest: { effects: [{ id: 16, value: 8400 }] },
  } }, {
    config: { tables: { ItemCfg: { data: [
      { id: '鱼', type: '原料', sortId: 1 },
      { id: '木材', type: '原料', sortId: 2 },
      { id: '玻璃', type: '原料', sortId: 3 },
      { id: '英雄经验', type: '通用', sortId: 4 },
    ] } } },
  });
  assert.deepEqual(view.materials, [
    { itemId: '鱼', num: 3, capacity: 8400 },
    { itemId: '木材', num: 12, capacity: 8400 },
    { itemId: '玻璃', num: 0, capacity: 8400 },
  ]);
  assert.match(PAGE, /原材料库存（当前 \/ 仓库上限）/);
});

test('overview: crop inventory includes zero values and its base capacity', () => {
  const view = summarize({ ok: { AllItemRequest: { items: [{ itemId: '小麦', num: 12 }] } } }, {
    config: { tables: {
      FarmlandPlantCfg: { data: [{ id: '小麦' }, { id: '玉米' }] },
      GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] },
    } },
  });
  // 产品存量初始上限只限制工厂加工品；农作物基础上限为 250。
  assert.deepEqual(view.crops, [
    { itemId: '小麦', num: 12, capacity: 250 },
    { itemId: '玉米', num: 0, capacity: 250 },
  ]);
  assert.match(PAGE, /农作物库存（当前 \/ 上限）/);
  assert.match(PAGE, /data\.crops/);
});

test('overview: production panel exposes every farm crop and factory queue item', () => {
  const view = summarize({ ok: {
    OnWaterRequest: { building: [
      { buildingId: '1农田', farm: { productId: '玉米', ripeTime: 2000 } },
      { buildingId: '2农田' },
      { buildingId: '1食品厂', factory: {
        autoProductId: '食品',
        factoryQ: [{ idx: 1, productId: '食品', finishTime: 2100 }],
        finishedProducts: [{ type: 0, id: '烤鱼', num: 2 }],
      } },
    ] },
  } }, { config: { tables: { BuildingCfg: { data: [{ buildingType: '农田' }, { buildingType: '食品厂' }] } } } });
  assert.deepEqual(view.buildings.map((building) => ({
    buildingId: building.buildingId,
    farm: building.farm,
    queue: building.factory?.queue,
  })), [
    { buildingId: '1农田', farm: { productId: '玉米', ripeTime: 2000 }, queue: undefined },
    { buildingId: '2农田', farm: { productId: null, ripeTime: null }, queue: undefined },
    { buildingId: '1食品厂', farm: null, queue: [{ idx: 1, productId: '食品', finishTime: 2100 }] },
  ]);
  assert.match(PAGE, /id="overview-production"/);
  assert.match(PAGE, /function renderOverviewProduction\(data\)/);
  assert.match(PAGE, /农田与工厂生产/);
});

/** 运行真实页面脚本的纯转换函数；不创建浏览器或任何游戏连接。 */
function automationFormContext() {
  const context = vm.createContext({
    $: () => ({}), setInterval: () => {}, structuredClone,
    document: { querySelector: () => ({ value:'2' }) },
  });
  vm.runInContext(AUTOMATION_SCRIPT, context);
  vm.runInContext('automationSettings = { season:2 };', context);
  return context;
}

test('automation UI: three columns show read-only JSON and the final embedded script compiles', () => {
  assert.match(PAGE, /grid-template-columns:minmax\(180px,1fr\) minmax\(260px,1\.2fr\) minmax\(200px,280px\)/);
  assert.match(AUTOMATION_SCRIPT, /output\.readOnly = true/);
  assert.match(AUTOMATION_SCRIPT, /JSON 结果/);
  assert.match(AUTOMATION_SCRIPT, /target\[keys\.at\(-1\)\] = editor\.readSetting\(\)/);
  assert.doesNotMatch(AUTOMATION_SCRIPT, /case 'json'|sample\.join\(', '\)|JSON\.parse\(input\.value\)/);
  // 检查最终内嵌脚本，能捕获 String.raw 模板中的转义和插值错误。
  new vm.Script(PAGE.match(/<script>([\s\S]*)<\/script>/)[1]);
});

test('automation UI: fleet form models preserve every current rule field accepted by settings validation', () => {
  const context = automationFormContext();
  for (const kind of ['chipMine','treasureLoot','cityWar','limitedBoss','merchantShip']) {
    const model = JSON.parse(vm.runInContext('JSON.stringify(fleetRuleDefaults("modules.world.' + kind + '.fleets"))', context));
    const settings = defaultSettings(); settings.modules.world[kind].fleets = [model];
    assert.deepEqual(validateSettings(settings).modules.world[kind].fleets, [model]);
    assert.equal(model.enabled, false);
    if (kind === 'cityWar') assert.deepEqual(model.roles, ['attack']);
    if (kind === 'treasureLoot') assert.equal(model.helpAlly, false);
  }
});

test('automation UI: empty, fractional integer and invalid time inputs cannot silently become a valid result', () => {
  const { readEditorInput } = automationFormContext();
  assert.throws(() => readEditorInput({ value:'', checkValidity:() => true }, 'number', '库存'), /非负数/);
  assert.throws(() => readEditorInput({ value:'-1', checkValidity:() => true }, 'number', '库存'), /非负数/);
  assert.throws(() => readEditorInput({ value:'1.5', checkValidity:() => false }, 'number', '库存'), /非负数/);
  assert.throws(() => readEditorInput({ value:'', type:'time', checkValidity:() => false }, 'string', '开始时间'), /有效时间/);
  assert.equal(readEditorInput({ value:'0.5', checkValidity:() => true }, 'number', '挂机时长'), 0.5);
  assert.equal(readEditorInput({ value:'20:01:30', type:'time', checkValidity:() => true }, 'string', '开始时间'), '20:01:30');
  assert.equal(readEditorInput({ value:'9007199254740993' }, 'string', 'UID'), '9007199254740993');
});

test('automation form options: game names map to actual IDs and retain season and factory relationships', () => {
  const config = { tables: Object.fromEntries(Object.entries({
    BuildingCfg:[{ buildingType:'服装厂', name:'服装作坊' }],
    BuildingProduceCfg:[{ buildType:'服装厂', itemId:'衣服' }],
    ItemCfg:[{ id:'衣服', show_name:'休闲衣服' }],
    BuildingUnlockCfg:[{ buildingType:'远征船', buildingId:'2远征船' }],
    GuildTechCfg:[{ techId:10201, name:'生产效率', season:2 }],
    '2_CityCfg':[{ id:3, name:'净水城' }],
  }).map(([name, data]) => [name, { data }])) };
  const options = automationFormOptions(config);
  assert.deepEqual(options.factories, [{ value:'服装厂', label:'服装作坊' }]);
  assert.deepEqual(options.products, [{ value:'衣服', label:'休闲衣服', factory:'服装厂' }]);
  assert.deepEqual(options.fleets, [{ value:'2远征船', label:'2号远征舰队' }]);
  assert.deepEqual(options.cities[2], [{ value:3, label:'净水城' }]);
  assert.deepEqual(options.tech, [{ value:10201, label:'生产效率', season:2 }]);
  assert.deepEqual(automationFormOptions(null).fleets, []);
  const context = automationFormContext();
  context.formOptions = options;
  vm.runInContext('automationOptions = formOptions;', context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(editorChoices("items"))', context)), options.tech);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(editorChoices("cityIds"))', context)), options.cities[2]);
});

// 下架活动只能改变控制台归类，原模块设置路径必须继续存在，才能读取和保存玩家已有配置。
test('automation UI: off-sale activity entries are grouped as historical without changing settings paths', () => {
  assert.match(PAGE, /HISTORICAL_ACTIVITY_KEYS = \['midAutumn', 'blindBox', 'catcher', 'workshop', 'blessing'\]/);
  assert.match(PAGE, /CURRENT_ACTIVITY_KEYS = \['enabled', 'edict', 'weekOrder', 'weekLottery'\]/);
  assert.match(PAGE, /抓捕（海底捞月）/);
  assert.match(PAGE, /历史活动（已下架）/);
  assert.match(PAGE, /settingFields\(data\.settings\.modules\.activity\[key\],\['modules','activity',key\],group\)/);
  assert.match(PAGE, /settingFields\(data\.settings\.modules\.snap,\['modules','snap'\],snap\)/);
  assert.match(PAGE, /input\.checked = id !== 'snap'; input\.disabled = id === 'snap'/);
});

test('loop module selection excludes historical water-world cards', async () => {
  const { selectLoopModules } = await import('../src/automation/settings.mjs');
  assert.ok(!selectLoopModules('all').includes('snap'));
  assert.throws(() => selectLoopModules(['snap']), /水世界牌已下架/);

  // runLoop 是 CLI 的最终安全边界，必须在触碰网关前拒绝已下架模块。
  const { runLoop } = await import('../src/loop.mjs');
  const client = new Gateway();
  await assert.rejects(runLoop(client, protocol, { allowMutate: true, automationOnly: true, automationModules: ['snap'] }), /水世界牌已下架/);
  assert.deepEqual(client.calls, []);
});

// 执行结果的模块 ID 属于内部实现，控制台必须显示对应的中文玩法名。
test('automation UI: execution results translate module IDs to Chinese labels', () => {
  assert.match(PAGE, /antique:'藏品'/);
  assert.match(PAGE, /battle:'挑战'/);
  assert.match(PAGE, /automationModuleLabel\(r\.module\)/);
  assert.match(PAGE, /automationModuleLabel\(data\.module\)/);
});

test('protocol: nested required fields, arrays, enums and int64 preserve current schema', () => {
  assert.throws(() => validateMessage(protocol.FarmPlantRequest, { args: [{ buildingId: '1农田' }] }), /undefined|required/);
  assert.throws(() => validateMessage(protocol.FarmPlantRequest, { args: [{ buildingId: '1农田', productId: '玉米', legacy: 1 }] }), /legacy/);
  const result = validateMessage(protocol.FreePetRequest, { petUid: ['9007199254740993', '9223372036854775807'] });
  assert.deepEqual(result.petUid.map(idString), ['9007199254740993', '9223372036854775807']);
  assert.deepEqual([...validateMessage(protocol.CollectBuildingProductRequest, { buildingId: ['1主城', '2住宅'] }).buildingId], ['1主城', '2住宅']);
  assert.equal(validateMessage(protocol.RecruitStartRequest, { way: protocol.RecruitWay.RECRUIT_FREE }).way, 1);
});

test('budget: disabled and zero global/module allowance send no paid request', async () => {
  const f = fixture();
  try {
    await f.ctx.refreshStock();
    for (const policy of [{ enabled: false, dailyLimit: 100 }, { enabled: true, dailyLimit: 0 }, { enabled: true, dailyLimit: 100 }]) {
      Object.assign(f.settings.spending, policy);
      const r = await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 20 });
      assert.equal(r.status, 'skipped');
    }
    assert.equal(f.client.calls.filter(c => c.name === 'TrialRaidBuySweepRequest').length, 0);
  } finally { f.ctx.dispose(); }
});

test('budget: global + module cap + minimum balance; persisted restart and role isolation', async () => {
  const f = fixture();
  Object.assign(f.settings.spending, { enabled: true, dailyLimit: 100, minRubyStock: 950 }); f.settings.spending.modules.battle = 60;
  f.client.handlers.TrialRaidBuySweepRequest = async (_, response, client) => { client.ruby -= 30; return response ? required(response) : {}; };
  try {
    await f.ctx.refreshStock();
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 30, confirm: async () => f.client.ruby === 970 })).status, 'success');
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 2 }, { ruby: 30 })).status, 'skipped');
    f.settings.spending.minRubyStock = 0;
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 2 }, { ruby: 30, confirm: async () => f.client.ruby === 940 })).status, 'success');
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 3 }, { ruby: 1 })).status, 'skipped');
    assert.equal(loadLedger(f.args.accountId, f.args.player.playerId).ledger.days[businessDate(fixedNow)].spent, 60);
    const restarted = createContext(f.args); restarted.setModule('battle');
    try { await restarted.refreshStock(); assert.equal((await restarted.action('TrialRaidBuySweepRequest', { raidId: 3 }, { ruby: 1 })).status, 'skipped'); }
    finally { restarted.dispose(); }
    assert.deepEqual(loadLedger(f.args.accountId, 'other-role').ledger, { days: {}, pending: {} });
  } finally { f.ctx.dispose(); }
});

test('budget: dry plan simulates cumulative cost without writing ledger or sending actions', async () => {
  const f = fixture({ dryRun: true }); Object.assign(f.settings.spending, { enabled: true, dailyLimit: 50 }); f.settings.spending.modules.battle = 50;
  try {
    await f.ctx.refreshStock();
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 30 })).status, 'planned');
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 2 }, { ruby: 30 })).status, 'skipped');
    assert.deepEqual(loadLedger(f.args.accountId, f.args.player.playerId).ledger, { days: {}, pending: {} });
    assert.equal(f.client.calls.length, 2);
  } finally { f.ctx.dispose(); }
});

test('uncertain: timeout retains reservation across restart and blocks duplicate without retry', async () => {
  const f = fixture({ handlers: { TrialRaidBuySweepRequest: async () => { throw new Error('timeout'); } } });
  Object.assign(f.settings.spending, { enabled: true, dailyLimit: 100 }); f.settings.spending.modules.battle = 100;
  try {
    await f.ctx.refreshStock();
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 25, confirm: async () => false })).status, 'uncertain');
    assert.equal(f.ctx.stop.aborted, true);
    const restart = createContext({ ...f.args, stop: { aborted: false } }); restart.setModule('battle');
    try { await restart.refreshStock(); assert.equal((await restart.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 25 })).status, 'uncertain'); }
    finally { restart.dispose(); }
    assert.equal(f.client.calls.filter(c => c.name === 'TrialRaidBuySweepRequest').length, 1);
    assert.equal(Object.values(loadLedger(f.args.accountId, f.args.player.playerId).ledger.pending)[0].ruby, 25);
  } finally { f.ctx.dispose(); }
});

test('uncertain: timeout read-confirm settles once; rejection releases reserved budget', async () => {
  const f = fixture({ handlers: { TrialRaidBuySweepRequest: async () => { throw new Error('timeout'); } } });
  Object.assign(f.settings.spending, { enabled: true, dailyLimit: 100 }); f.settings.spending.modules.battle = 100;
  try {
    await f.ctx.refreshStock();
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 20, confirm: async () => true })).verifiedByRead, true);
    f.client.handlers.TrialRaidBuySweepRequest = async () => { throw Object.assign(new Error('denied'), { prompt: {} }); };
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 2 }, { ruby: 20 })).status, 'rejected');
    assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 20); assert.deepEqual(f.ctx.ledger.pending, {});
  } finally { f.ctx.dispose(); }
});

test('date: Shanghai midnight resets counts and budgets, pending remains reserved', async () => {
  let now = Date.parse('2026-10-29T23:59:59+08:00'); const f = fixture({ now: () => now });
  try {
    f.ctx.count('x', 1); now += 2000; assert.equal(f.ctx.count('x'), 0);
    assert.equal(businessDate(now), '2026-10-30');
    assert.equal(inWindows([{ start: '23:00', end: '01:00' }], now), true);
  } finally { f.ctx.dispose(); }
});

test('execution: stop, fatal and disconnect prohibit subsequent requests', async () => {
  for (const reason of ['stop', 'fatal', 'close']) {
    const f = fixture();
    try {
      if (reason === 'stop') f.ctx.stop.aborted = true; else f.client.emit(reason, { reason });
      await assert.rejects(() => f.ctx.query('AllItemRequest'));
      await assert.rejects(() => f.ctx.action('DrawAfkRewardRequest'));
      assert.equal(f.client.calls.length, 0);
    } finally { f.ctx.dispose(); }
  }
});

test('execution: same account lock excludes another operation and releases after error', async () => {
  await withRoleLock('lock-account', '1', async () => {
    await assert.rejects(() => withRoleLock('lock-account', '1', async () => {}), /业务/);
    await assert.rejects(() => withRoleLock('lock-account', '2', async () => {}), /占用/);
  });
  await withRoleLock('lock-account', '1', async () => {});
});

test('execution: stale malformed business lock is recovered after its initialization grace period', async () => {
  const accountId = 'malformed-lock', lockFile = path.join(accountDirectory(accountId), 'business.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, '{"pid":');
  await assert.rejects(() => withRoleLock(accountId, '1', async () => {}), /正在初始化/);
  const stale = new Date(Date.now() - 10_000);
  fs.utimesSync(lockFile, stale, stale);
  let entered = false;
  await withRoleLock(accountId, '1', async () => { entered = true; });
  assert.equal(entered, true);
  assert.equal(fs.existsSync(lockFile), false);
});

test('tasks: branch reward is confirmed from the refreshed branch list', async () => {
  const { runTasks } = await import('../src/tasks.mjs');
  const f = fixture({ states: { MainTaskInfoRequest: { branch: [{ taskId: 9, progress: 1 }] } }, handlers: {
    GotBranchTaskRewardRequest: async (_, _response, client) => { client.states.MainTaskInfoRequest.branch = []; },
  } });
  const survey = { plan: [{ kind: 'branch', id: 9, request: 'GotBranchTaskRewardRequest', body: { taskId: 9 }, label: '支线 9' }] };
  try {
    const results = await runTasks(f.client, protocol, survey, { allowMutate: true, accountId: f.args.accountId, player: f.args.player, config: f.args.config });
    assert.equal(results[0].ok, true);
    assert.deepEqual(loadLedger(f.args.accountId, f.args.player.playerId).ledger.pending, {});
  } finally { f.ctx.dispose(); }
});

test('tasks: rejected reward keys persist when a loop supplies the same rejection set next round', async () => {
  const { runTasks } = await import('../src/tasks.mjs');
  const f = fixture(), rejected = new Set();
  const survey = { plan: [{ kind: 'achievement', id: 1, request: 'GotAchievementRewardRequest', body: { id: 1 }, label: '成就 1' }] };
  let attempts = 0;
  const actionExecutor = async () => { attempts++; throw new Error('server prompt'); };
  try {
    await runTasks(f.client, protocol, survey, { allowMutate: true, actionExecutor, rejected });
    const next = await runTasks(f.client, protocol, survey, { allowMutate: true, actionExecutor, rejected });
    assert.equal(attempts, 1);
    assert.equal(next[0].skipped, true);
  } finally { f.ctx.dispose(); }
});

test('client: one in-flight request per connection, queued writes rejected after stop', async () => {
  const client = new GameClient({ protocol }), sent = [];
  client.socket = { readyState: 1, send: () => {}, close: () => {} };
  client.on('frame', frame => sent.push(frame.name));
  const first = client.request('AllItemRequest', {}, 'AllItemResponse', 1000);
  const second = client.request('AllResourceRequest', {}, 'AllResourceResponse', 1000);
  const rejection = assert.rejects(second, /stopped/);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(sent, ['AllItemRequest']);
  const entry = client.pending.shift(); clearTimeout(entry.timer); entry.resolve({ items: [] });
  client.stop(); await first; await rejection;
});

test('service: all disabled modules emit statuses without querying gateway', async () => {
  const f = fixture(); f.ctx.dispose();
  const result = await runAutomation(f.args);
  assert.equal(result.results.length, 18); assert.equal(f.client.calls.length, 0); assert.equal(result.error, null);
  await assert.rejects(() => runAutomation({ ...f.args, selector: 'missing' }), /有效自动化模块/);
  await assert.rejects(() => runAutomation({ ...f.args, selector: [] }), /有效自动化模块/);
});

test('farm: seed cost and nested PlantArg; quiet full plots; insufficient seed skips', async () => {
  for (const seed of [0, 1]) {
    const f = await moduleRun('farm', { plant: true, cropPriorities: { 玉米: 1 }, cropKeepStock: { 玉米: 10 } }, ({ ctx, client }) => {
      table(ctx, 'FarmlandPlantCfg', [{ id: '玉米', material: ['种子', 1], produceNum: 5 }]); client.items.set('种子', seed);
    }, { dryRun: true, states: { OnWaterRequest: { building: [{ buildingId: '1农田', farm: {} }] } } });
    assert.equal(f.ctx.results.filter(r => r.request === 'FarmPlantRequest').length, seed);
    assert.equal(f.client.calls.some(c => c.name === 'FarmPlantRequest'), false);
  }
});

test('farm: empty farmland without farm field is recognized for planting', async () => {
  const f = await moduleRun('farm', { plant: true, cropPriorities: { 玉米: 1 }, cropKeepStock: { 玉米: 5 } }, ({ ctx, client }) => {
    table(ctx, 'BuildingCfg', [{ buildingType: '农田' }]);
    table(ctx, 'FarmlandPlantCfg', [{ id: '玉米', material: ['种子', 1], produceNum: 5 }]);
    client.items.set('种子', 1);
  }, { dryRun: true, states: { OnWaterRequest: { building: [{ buildingId: '1农田' }] } } });
  const planned = f.ctx.results.find(row => row.request === 'FarmPlantRequest');
  assert.equal(planned?.body.args[0].buildingId, '1农田');
  assert.equal(planned?.body.args[0].productId, '玉米');
});

// 缺料订单必须保留；材料齐全但奖励低于配置阈值时才拒单重刷。
test('resident: shortages skip, while low experience or gold rerolls orders', async () => {
  const f = await moduleRun('resident', { blockedMaterials: ['木材'], orderReward: false }, ({ client }) => client.items.set('木材', 100), { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] } } });
  assert.equal(f.ctx.results.filter(r => r.request === 'FinishWorkerOrderRequest').length, 0);
  const short = await moduleRun('resident', { minExp: 10, minGold: 10, orderReward: false }, null, { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] } } });
  assert.equal(short.ctx.results.find(r => r.request === 'DenyOrderRequest'), undefined);
  for (const [exp, gold] of [[9, 10], [10, 9]]) {
    const reroll = await moduleRun('resident', { minExp: 10, minGold: 10, orderReward: false }, ({ ctx, client }) => {
      client.items.set('木材', 1);
      table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['EXP', exp], ['GOLD', gold]] }]);
    }, { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] } } });
    assert.equal(reroll.ctx.results.filter(r => r.request === 'DenyOrderRequest' && r.status === 'planned').length, 1);
    assert.equal(reroll.ctx.results.filter(r => r.request === 'FinishWorkerOrderRequest').length, 0);
  }
  const state = { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] };
  const applied = await moduleRun('resident', { minExp: 10, minGold: 10, orderReward: false }, ({ ctx, client }) => {
    client.items.set('木材', 1);
    table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['EXP', 9], ['GOLD', 10]] }]);
  }, { states: { OnWaterRequest: state }, handlers: {
    // 模拟服务端拒单后替换订单，供静默请求的读回确认使用。
    DenyOrderRequest: async (_, _response, client) => { client.states.OnWaterRequest.workerOrder = [{ index: 2, requirements: [{ type: 0, id: '木材', num: 1 }] }]; },
  } });
  assert.equal(applied.ctx.results.find(r => r.request === 'DenyOrderRequest')?.status, 'success');
  assert.equal(applied.client.calls.filter(r => r.name === 'DenyOrderRequest').length, 1);
});

test('cargo: enum status and 1-based cargo indices, inventory shortage skips', async () => {
  const f = await moduleRun('cargo', {}, ({ client }) => client.items.set('木材', 2), { dryRun: true, states: { CargoShipsRequest: { ship: [{ index: 1, status: protocol.CargoShipStatus.IN_ORDER, orderItem: [{ asset: { type: 0, id: '木材', num: 1 } }, { asset: { type: 0, id: '玻璃', num: 1 } }] }] } } });
  const rows = f.ctx.results.filter(r => r.request === 'FillCargoShipRequest'); assert.equal(rows.length, 1); assert.deepEqual(rows[0].body.cargoIndex, [1]);
});

test('gather: full warehouse excludes raw floaters; chest requires existing key', async () => {
  const f = await moduleRun('gather', { floater: true, openChests: true }, ({ ctx, client }) => { client.items.set('木材', 100); table(ctx, 'ItemCfg', [{ id: '保险箱钥匙' }]); }, { dryRun: true, states: { OnWaterRequest: { floater: [{ floaterId: '木材' }] }, GameEffectRequest: { effects: [{ id: protocol.GameEffectId.RAW_MATERIAL_UPPER_BOUND, value: 100 }] } } });
  assert.equal(f.ctx.results.filter(r => r.request).length, 0);
});

test('afk: accumulated threshold and zero elapsed avoid repeated claims', async () => {
  for (const elapsed of [0, 3601]) {
    const f = await moduleRun('afk', { claimAfterHours: 1, levelReward: false }, null, { dryRun: true, states: { AfkInfoRequest: { afkInfo: { afkStartTime: fixedNow / 1000 - elapsed, afkFinishTime: fixedNow / 1000 + 100 } } } });
    assert.equal(f.ctx.results.filter(r => r.request === 'DrawAfkRewardRequest').length, elapsed ? 1 : 0);
  }
});

test('hero: no selected hero spends no cultivation resources; fragment recruitment uses recruitFrag', async () => {
  const missing = await moduleRun('hero', { levelUp: true }, null, { dryRun: true });
  assert.ok(missing.ctx.results.some(r => /选择英雄/.test(r.reason)));
  const f = await moduleRun('hero', { heroes: ['小布'], fragRecruit: true }, ({ ctx, client }) => { table(ctx, 'HeroCfg', [{ id: '小布', recruitFrag: 10 }]); client.items.set('小布碎片', 10); }, { dryRun: true });
  assert.ok(f.ctx.results.some(r => r.request === 'HeroRecruitRequest' && r.status === 'planned'));
});

test('antique: activate only when exact fragment cost available', async () => {
  const f = await moduleRun('antique', { activate: true }, ({ ctx, client }) => { table(ctx, 'AntiqueBaseCfg', [{ antiqueId: '陶罐', activeFrag: 5 }]); client.items.set('陶罐碎片', 5); }, { dryRun: true });
  assert.equal(f.ctx.results[0].request, 'ActivateAntiqueRequest');
});

test('pet: release requires quality threshold, protects assigned and configured UID', async () => {
  const f = await moduleRun('pet', { claim: false, decompose: true, decomposeBelowQuality: 'PURPLE', protectedUids: ['3'] }, ({ ctx }) => table(ctx, 'PetBreedCfg', [{ petId: '蓝鱼', quality: 'BLUE', qualityIndex: 1 }, { petId: '紫鱼', quality: 'PURPLE', qualityIndex: 2 }]), { dryRun: true, states: { AllPetRequest: { pets: [1, 2, 3].map(uid => ({ uid: String(uid), petId: '蓝鱼' })) }, GetFormationRequest: { formation: { presetId: 1, petUid: '1' } } } });
  const row = f.ctx.results.find(r => r.request === 'FreePetRequest'); assert.deepEqual(row.body.petUid, ['2']);
});

/** 默认 petBreed 状态不代表建筑可培育；满队列时必须在本地跳过，不能触发服务器拒绝。 */
test('pet: full queue ignores default petBreed states on non-pet buildings', async () => {
  const f = await moduleRun('pet', { claim: false, breed: true, breedSpecies: ['测试海兽'], breedMinQuality: 'BLUE' }, ({ ctx, client }) => {
    table(ctx, 'BuildingCfg', [{ buildingType: '宠物', name: '宠物' }, { buildingType: '训练营', name: '训练营' }, { buildingType: '材料厂', name: '材料厂' }]);
    table(ctx, 'PetSpeciesCfg', [{ name: '测试海兽', spId: 1 }]);
    table(ctx, 'PetBreedCfg', [{ petId: '蓝宠物1', spId: 1, season: 0, quality: 'BLUE', qualityIndex: 1, cost: [['木材', 1]] }]);
    client.items.set('木材', 10);
  }, {
    states: {
      OnWaterRequest: {
        building: [
          { buildingId: '1训练营', petBreed: { breedQ: [], maturePets: [], maxQLength: 3 } },
          { buildingId: '1材料厂', petBreed: { breedQ: [], maturePets: [], maxQLength: 3 } },
          { buildingId: '1宠物', petBreed: { breedQ: [1, 2, 3].map(idx => ({ idx, petId: '蓝宠物1', finishTime: fixedNow / 1000 + 60, startTime: fixedNow / 1000 })), maturePets: [], maxQLength: 3 } },
        ],
      },
    },
    handlers: {
      PetBreedRequest: async () => {
        const error = new Error('server prompt: breed queue full');
        error.prompt = { args: ['breed queue full'] };
        throw error;
      },
    },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'PetBreedRequest').length, 0);
  assert.ok(f.ctx.results.some(result => result.status === 'skipped' && result.reason === '宠物培育队列已满'));
});

test('equip: worn and protected equipment excluded; valid idle equipment decomposes', async () => {
  const f = await moduleRun('equip', { decompose: true, decomposeBelowQuality: 'PURPLE', protectedUids: ['3'] }, ({ ctx }) => table(ctx, 'EquipCfg', [{ id: '蓝武器', quality: 'BLUE', qualityIndex: 1 }, { id: '紫武器', quality: 'PURPLE', qualityIndex: 2 }]), { dryRun: true, states: { EquipsRequest: { equip: [1, 2, 3].map(uid => ({ uid: String(uid), equipId: '蓝武器' })) }, AllHeroRequest: { heroes: [{ heroId: '小布', equips: [{ uid: '1', equipId: '蓝武器' }] }] } } });
  assert.deepEqual(f.ctx.results.find(r => r.request === 'DecomposeEquipRequest').body.uid, ['2']);
});

test('museum: completed exploration settles then claims; speed item matches current ID', async () => {
  const f = await moduleRun('museum', { collectRevenue: false, speedUp: true, speedUpDailyLimit: 1 }, ({ client }) => client.items.set('博物馆加速', 1), { dryRun: true, states: { MuseumInfoRequest: { exploreStages: [{ stageId: 1, progress: 0, expedition: { startTime: 1, endTime: fixedNow / 1000 + 100 } }] } } });
  assert.equal(f.ctx.results[0].request, 'MuseumSpeedUpExploreRequest'); assert.equal(f.ctx.results[0].status, 'planned');
});

test('battle: mainline loss and trial loss stop instead of progressing', async () => {
  const f = await moduleRun('battle', { maxActions: 3, stage: { enabled: true, samePowerRetryCount: 0, claimReward: false } }, null, { handlers: { ChallengeStageRequest: async () => ({ stats: { isLeftWin: false } }) } });
  assert.equal(f.client.calls.filter(c => c.name === 'ChallengeStageRequest').length, 1);
  assert.equal(f.ctx.results[0].status, 'failed');
});

/** 已领取的战令奖励可作为旧请求已完成的只读证据，不应再让整轮自动化停机。 */
test('battle: confirmed pending pass reward settles without resubmission', async () => {
  const f = await moduleRun('battle', { stage: { enabled: false, claimReward: true } }, ({ ctx }) => {
    table(ctx, 'PassStagePackCfg', [{ stage: 1, rwdId: 1, needStage: 1, freeReward: [{}] }]);
    ctx.ledger.pending['PassStageGotRewardRequest:{"stage":1}'] = { token: 'pending-pass-reward', ruby: 0, module: 'battle', date: businessDate(fixedNow) };
  }, { states: { PassStageStateRequest: { maxOpenStage: 1 }, PassStageRequest: { activePay: false, got: [{ id: 1, freeGot: true }] } } });
  assert.equal(f.client.calls.filter(c => c.name === 'PassStageGotRewardRequest').length, 0);
  assert.equal(f.ctx.stop.aborted, false);
  assert.deepEqual(f.ctx.ledger.pending, {});
  assert.ok(f.ctx.results.some(result => result.request === 'PassStageGotRewardRequest' && result.verifiedByRead));
});

/** 无专用回包的战令领奖必须读回领取标记，避免正常成功也永久留下未确认记录。 */
test('battle: pass reward confirms through the chapter state', async () => {
  const f = await moduleRun('battle', { stage: { enabled: false, claimReward: true } }, ({ ctx, client }) => {
    table(ctx, 'PassStagePackCfg', [{ stage: 1, rwdId: 1, needStage: 1, freeReward: [{}] }]);
    client.handlers.PassStageGotRewardRequest = async () => { client.states.PassStageRequest.got = [{ id: 1, freeGot: true }]; };
  }, { states: { PassStageStateRequest: { maxOpenStage: 1 }, PassStageRequest: { activePay: false, got: [] } } });
  assert.equal(f.client.calls.filter(c => c.name === 'PassStageGotRewardRequest').length, 1);
  assert.equal(f.ctx.results.find(result => result.request === 'PassStageGotRewardRequest')?.status, 'success');
  assert.deepEqual(f.ctx.ledger.pending, {});
});

/** 旧领奖仍有可领取档位时不能重发；仅结束战斗模块，保留全局流程继续执行。 */
test('battle: unresolved pending pass reward does not stop automation', async () => {
  const f = await moduleRun('battle', { stage: { enabled: false, claimReward: true } }, ({ ctx }) => {
    table(ctx, 'PassStagePackCfg', [{ stage: 1, rwdId: 1, needStage: 1, freeReward: [{}] }]);
    ctx.ledger.pending['PassStageGotRewardRequest:{"stage":1}'] = { token: 'pending-pass-reward', ruby: 0, module: 'battle', date: businessDate(fixedNow) };
  }, { states: { PassStageStateRequest: { maxOpenStage: 1 }, PassStageRequest: { activePay: false, got: [] } } });
  assert.equal(f.client.calls.filter(c => c.name === 'PassStageGotRewardRequest').length, 0);
  assert.equal(f.ctx.stop.aborted, false);
  assert.ok(f.ctx.results.some(result => result.request === 'PassStageGotRewardRequest' && result.status === 'uncertain'));
});

/** 战令领奖未确认只能终止战斗模块，后续独立模块仍可在同一轮安全运行。 */
test('service: unresolved pass reward leaves later modules running', async () => {
  const fleets = [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }];
  const f = fixture({
    states: {
      PassStageStateRequest: { maxOpenStage: 1 },
      PassStageRequest: { activePay: false, got: [] },
      RadarInfoRequest: { radarInfo: { events: [{ uid: '123', eventId: 1, state: protocol.RadarEventState.RADAR_EVENT_INIT }] } },
    },
    handlers: {
      MyFleetsRequest: async () => ({ fleets: structuredClone(fleets) }),
      RadarSendFleetsRequest: async () => { fleets[0].state = protocol.FleetState.MOVING; },
    },
  });
  f.settings.modules.battle.enabled = true;
  f.settings.modules.battle.stage = { enabled: false, claimReward: true };
  f.settings.modules.world.enabled = true;
  f.settings.modules.world.radar = { enabled: true, claim: false, kinds: ['test'], fixed: false };
  table(f.ctx, 'PassStagePackCfg', [{ stage: 1, rwdId: 1, needStage: 1, freeReward: [{}] }]);
  table(f.ctx, 'RadarRandEventCfg', [{ eventId: 1, type: 'test' }]);
  f.ctx.ledger.pending['PassStageGotRewardRequest:{"stage":1}'] = { token: 'pending-pass-reward', ruby: 0, module: 'battle', date: businessDate(fixedNow) };
  // 通过上下文持久化测试账本，确保服务重建连接后走到真实的未确认恢复分支。
  f.ctx.memory('test.pending-pass-reward', true);
  f.ctx.dispose();

  const result = await runAutomation({ ...f.args, selector: ['battle', 'world'] });
  assert.equal(result.error, null);
  assert.equal(f.client.calls.filter(c => c.name === 'PassStageGotRewardRequest').length, 0);
  assert.equal(f.client.calls.filter(c => c.name === 'RadarSendFleetsRequest').length, 1);
  assert.ok(result.ledger.pending['PassStageGotRewardRequest:{"stage":1}']);
});

/** 服务端频控拒绝主线后，战斗模块不得继续进入竞技场或试炼。 */
test('battle: rejected mainline challenge stops later battle branches', async () => {
  const f = await moduleRun('battle', {
    maxActions: 3,
    stage: { enabled: true, samePowerRetryCount: 10, claimReward: false },
    arena: { challenge: false, sweep: false },
    trial: { heroExp: { challenge: true, rubySweep: false }, forge: { challenge: true, rubySweep: false }, petExp: { challenge: true, rubySweep: false } },
  }, null, { handlers: {
    ChallengeStageRequest: async () => {
      // PromptResponse 表示服务端明确拒绝，本次请求没有业务回包。
      const error = new Error('server prompt: too frequent, retry later'); error.prompt = { args: ['too frequent, retry later'] }; throw error;
    },
  } });
  assert.equal(f.client.calls.filter(c => c.name === 'ChallengeStageRequest').length, 1);
  assert.equal(f.client.calls.filter(c => c.name === 'TrialRaidChallengeRequest').length, 0);
  assert.equal(f.ctx.results[0].status, 'rejected');
});

/** 服务端频控拒绝一个试炼后，不能立刻切换其他试炼继续发送挑战请求。 */
test('battle: rejected trial challenge stops the remaining raids', async () => {
  const f = await moduleRun('battle', {
    maxActions: 3,
    stage: { enabled: false, claimReward: false },
    arena: { challenge: false, sweep: false },
    trial: { heroExp: { challenge: true, rubySweep: false }, forge: { challenge: true, rubySweep: false }, petExp: { challenge: true, rubySweep: false } },
  }, ({ ctx, client }) => {
    table(ctx, 'TrialRaidStageCfg', [
      { raidId: 1, stageId: 1002, openLevel: 1 },
      { raidId: 2, stageId: 2002, openLevel: 1 },
      { raidId: 3, stageId: 3002, openLevel: 1 },
    ]);
    client.handlers.TrialRaidInfoRequest = async body => ({ raid: { raidId: body.raidId, passedStage: body.raidId * 1000 + 1 } });
    client.handlers.TrialRaidChallengeRequest = async () => {
      // 只模拟服务端拒绝；测试关注拒绝后的流程边界，而不是战斗结算。
      const error = new Error('server prompt: too frequent, retry later'); error.prompt = { args: ['too frequent, retry later'] }; throw error;
    };
  });
  assert.deepEqual(f.client.calls.filter(c => c.name === 'TrialRaidChallengeRequest').map(c => c.body.raidId), [1]);
  assert.equal(f.ctx.results[0].status, 'rejected');
});

test('battle: arena uses isWin; expedition health counts death and threshold', async () => {
  const f = await moduleRun('battle', { maxActions: 1, stage: { enabled: false, claimReward: false }, arena: { challenge: true, sweep: false } }, ({ client }) => { client.handlers.AllResourceRequest = async () => ({ list: [{ res: protocol.Resource.ARENA_POINT, amount: 1 }] }); }, { states: { ArenaInfoRequest: { myself: { rankNo: 10, power: '100' }, challenges: [{ rankNo: 5, power: '10', id: '9007199254740993' }] } }, handlers: { ArenaChallengeRequest: async () => ({ isWin: true }) } });
  assert.equal(f.ctx.results[0].status, 'success');
  const maximum = new Map([['a', 100], ['b', 100]]); const health = expeditionHealth([{ heroId: 'a', hp: 50 }, { heroId: 'b', hp: 0 }], maximum);
  assert.equal(health.dead, 1); assert.equal(health.percent, 25);
});

test('world: next trade ship uses lv/upCost; default spending prevents ruby upgrade', async () => {
  const f = await moduleRun('world', { trade: { enabled: true, claim: false, upgrade: true, speedUp: false } }, ({ ctx }) => table(ctx, 'TradeShipCfg', [{ lv: 2, upMoney: 100, upCost: ['RUBY', 30] }]), { dryRun: true, states: { TradeInfoRequest: { cargo: { cargoLv: 1 }, player: { coins: 500 } } } });
  assert.ok(f.ctx.results.some(r => r.request === 'TradeCargoUpgradeRequest' && r.status === 'skipped' && /钻石/.test(r.reason)));
});

/** 海商王在窗口外必须在查询船只状态前跳过，避免服务端的 not trade time 拒绝。 */
test('trade: Shanghai 10:00–22:00 window prevents all trade requests outside the range', async () => {
  for (const [time, expectedQueries] of [
    ['2026-10-29T09:59:00+08:00', 0],
    // 进入既有贸易流程后会在处理升级与航行状态前后各读取一次。
    ['2026-10-29T10:00:00+08:00', 2],
    ['2026-10-29T22:00:00+08:00', 0],
  ]) {
    const f = await moduleRun('world', { trade: { enabled: true, claim: false, upgrade: false, speedUp: false } }, null, {
      now: () => Date.parse(time), states: { TradeInfoRequest: { cargo: {} } },
    });
    assert.equal(f.client.calls.filter(call => call.name === 'TradeInfoRequest').length, expectedQueries, time);
    if (!expectedQueries) assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /10:00–22:00/);
  }
});

test('world: pirate sweep uses the server count and stops after the available times are exhausted', async () => {
  const f = await moduleRun('world', {
    pirate: { attack: false, sweep: true, attackTypes: [], sweepTypes: [1, 2, 3], attackTime: { start: '00:00', end: '00:00' } },
  }, null, { states: {
    PirateKillRecordRequest: { records: [{ type: 1, maxKilledLevel: 10 }, { type: 2, maxKilledLevel: 10 }, { type: 3, maxKilledLevel: 10 }] },
    AllPirateRequest: { sweepTimes: 2, pirates: [{ uid: 11, type: 1, level: 10, cityId: 1 }, { uid: 12, type: 2, level: 10, cityId: 1 }, { uid: 13, type: 3, level: 10, cityId: 1 }] },
  }, handlers: {
    PirateSweepRequest: async (_, _response, client) => { client.states.AllPirateRequest.sweepTimes -= 1; },
  } });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'PirateSweepRequest').map(call => call.body.uid), [11, 12]);
  assert.ok(f.ctx.results.some(result => result.status === 'skipped' && result.reason === '海盗可扫荡次数不足，停止本轮扫荡'));
});

test('world: pirate sweep records a diagnostic and sends nothing when the server count is absent', async () => {
  const f = await moduleRun('world', {
    pirate: { attack: false, sweep: true, attackTypes: [], sweepTypes: [1], attackTime: { start: '00:00', end: '00:00' } },
  }, null, { states: {
    PirateKillRecordRequest: { records: [{ type: 1, maxKilledLevel: 10 }] },
    AllPirateRequest: { pirates: [{ uid: 11, type: 1, level: 10, cityId: 1 }] },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'PirateSweepRequest').length, 0);
  assert.ok(f.ctx.results.some(result => result.status === 'skipped' && result.reason === '服务端未返回海盗可扫荡次数，已记录并跳过扫荡'));
});

test('guild: no membership prevents all guild writes', async () => {
  const f = await moduleRun('guild', { packs: { guild: true, title: true } }, null, { dryRun: true });
  assert.ok(f.ctx.results.some(r => /未加入/.test(r.reason))); assert.equal(f.client.calls.filter(c => /Welfare|TitleReward/.test(c.name)).length, 0);
});

test('guild welfare: unchanged packs do not repeat the prompt=35 request, while a new pack is still claimable', async () => {
  const f = fixture({ states: { GuildInfoRequest: { guild: { guildId: '1', welfarePack: [{ id: '101' }] } } } });
  f.settings.modules.guild.enabled = true;
  f.settings.modules.guild.packs.guild = true;
  f.ctx.setModule('guild');
  try {
    await f.ctx.refreshStock();
    await HANDLERS.guild(f.ctx, f.settings.modules.guild);
    await HANDLERS.guild(f.ctx, f.settings.modules.guild);
    f.client.states.GuildInfoRequest.guild.welfarePack.push({ id: '102' });
    await HANDLERS.guild(f.ctx, f.settings.modules.guild);
    assert.equal(f.client.calls.filter(call => call.name === 'GotGuildWelfarePackRequest').length, 2);
    assert.ok(f.ctx.results.some(result => result.status === 'skipped' && result.reason === '联盟福利没有新增礼包'));
  } finally {
    f.ctx.dispose();
  }
});

test('welfare: already claimed daily task sends no duplicate reward request', async () => {
  const f = await moduleRun('welfare', { daily: false, dailyTask: true, growth: false, events: false, email: false }, null, { dryRun: true, states: { DailyTaskInfoRequest: { dailyTask: [{ id: 1001, progress: 1, targetProgress: 1, rewardClaimed: true }] } } });
  assert.equal(f.ctx.results.filter(r => r.request).length, 0);
});

test('activity: expired festival and missing period never spend activity items', async () => {
  const f = await moduleRun('activity', { midAutumn: { enabled: true, signIn: true } }, ({ ctx }) => ctx.pushes.set('SCAllActivity', { festivalActivities: [{ type: '中秋国庆活动', openTime: 1, closeTime: 2 }] }), { dryRun: true });
  assert.ok(f.ctx.results.some(r => /结束/.test(r.reason))); assert.equal(f.ctx.results.filter(r => r.request).length, 0);
});

test('snap: valid placements share energy and obey per-zone card limit', () => {
  const state = { mySide: protocol.SnapSide.SNAP_SIDE_A, round: { round: 1, energy: 3 }, hand: [{ uid: '9007199254740993', heroId: 'a' }, { uid: '2', heroId: 'b' }], zones: [{ zoneIndex: 1, unlocked: true, cardLimit: 1 }] };
  const plan = placementsFor(state, { tables: { GameCardCfg: { data: [{ heroId: 'a', cost: 2, power: 10 }, { heroId: 'b', cost: 2, power: 5 }] } } }, protocol);
  assert.deepEqual(plan.placements, [{ cardUid: '9007199254740993', zoneIndex: 1 }]);
});

test('snap: no active ticket prevents new PVE and diamond match defaults disabled', async () => {
  const f = await moduleRun('snap', { pve: true }, ({ ctx }) => { table(ctx, 'CardGameParamCfg', [{ matchTimeout: 60, matchTime: [['12:30:00', '13:30:00']] }]); ctx.pushes.set('SCAllActivity', {}); }, { dryRun: true });
  assert.ok(f.ctx.results.some(r => /打牌券/.test(r.reason))); assert.equal(f.client.calls.filter(c => /SnapStart/.test(c.name)).length, 0);
});

test('daily dedup: disabled subfeature remains available to old driver', () => {
  const settings = defaultSettings(); settings.modules.hero.enabled = true; settings.modules.battle.enabled = true;
  assert.equal(handledDailyIds(settings).includes(1002), false); assert.equal(handledDailyIds(settings).includes(1003), false);
  settings.modules.hero.recruit.free = true; settings.modules.battle.stage.enabled = true;
  assert.ok(handledDailyIds(settings).includes(1002)); assert.ok(handledDailyIds(settings).includes(1003));
});

/** Ensures disabled island switches cannot be bypassed by the legacy world phase. */
test('loop: enabled island module exclusively owns legacy building actions', async () => {
  const { shouldRunLegacyWorldStep } = await import('../src/loop.mjs');
  const settings = defaultSettings();
  settings.modules.island.enabled = true;
  settings.modules.island.upgrade = false;
  settings.modules.island.build = false;
  settings.modules.island.speedUp = false;
  settings.modules.island.factory.autoProduce = false;
  settings.modules.island.factory.priorityProduce = false;
  settings.modules.island.factory.speedUpForDemand = false;

  for (const kind of ['collectProduct', 'gainFactory', 'finishUpgrade', 'build', 'upgrade', 'speedUpUpgrade', 'startProduce', 'speedUpProduce']) {
    assert.equal(shouldRunLegacyWorldStep({ kind }, settings), false, `${kind} must stay disabled in the legacy world phase`);
  }
  assert.equal(shouldRunLegacyWorldStep({ kind: 'challengeField' }, settings), true, 'resource fields remain owned by the legacy world phase');

  settings.modules.island.enabled = false;
  assert.equal(shouldRunLegacyWorldStep({ kind: 'upgrade' }, settings), true, 'legacy loop retains island actions only when the island module is disabled');
});

// 酆都用例覆盖真实消耗与请求顺序，不能把已经返回答案当作可以省略显化的理由。
test('edict settings: default off, save/reload and current activity UI copy', () => {
  const settings = defaultSettings();
  assert.equal(settings.modules.activity.edict.enabled, false);
  settings.modules.activity.edict.enabled = true;
  saveSettings('edict-settings', settings);
  assert.equal(loadSettings('edict-settings').modules.activity.edict.enabled, true);
  delete settings.modules.activity.edict;
  assert.equal(validateSettings(settings).modules.activity.edict.enabled, false);
  const { settingCopy } = automationCopyHelpers();
  assert.equal(settingCopy(['modules', 'activity', 'edict'], 'edict').title, '酆都捞尸人');
  assert.match(settingCopy(['modules', 'activity', 'edict', 'enabled'], 'enabled').note, /每张符文先显化一次/);
});

test('edict: starts only one round and reveals all four papers before guessing', async () => {
  const f = await runEdict(edictFixture());
  const calls = f.client.calls.filter(call => call.name.startsWith('Edict'));
  assert.deepEqual(calls.map(call => call.name), ['EdictInfoRequest', 'EdictStartRequest',
    'EdictAskRequest', 'EdictAskRequest', 'EdictAskRequest', 'EdictAskRequest', 'EdictInfoRequest', 'EdictGuessRequest']);
  assert.deepEqual(calls.filter(call => call.name === 'EdictAskRequest').map(call => call.body.paperIdx), [0, 1, 2, 3]);
  assert.ok(calls.every(call => call.body.activityId === f.event.activityId), '保留动态 int64 活动编号');
  assert.deepEqual(calls.at(-1).body.guess, [4, 2, 3, 1]);
  assert.equal(f.client.items.get('本期酆都入场券'), 2, '仍有券时本轮也不再开第二局');
  assert.equal(f.edictState.session, null);
  assert.match(f.ctx.results.at(-1).label, /结算成功，功德 80，奖励：酆都奖励券 × 2/);
});

test('edict: resumes partial or fully revealed sessions without another ticket', async () => {
  for (const shown of [[16, 0, 8, 0], [1, 1, 1, 1]]) {
    // 网关会更新传入的会话状态，执行前固定应补齐的符文索引。
    const missing = shown.flatMap((value, index) => value === 0 ? [index] : []);
    const f = await runEdict(edictFixture({ tickets: 0, session: { rune: [4, 2, 3, 1], shown, patience: 80 } }));
    assert.equal(f.client.calls.filter(call => call.name === 'EdictStartRequest').length, 0);
    assert.deepEqual(f.client.calls.filter(call => call.name === 'EdictAskRequest').map(call => call.body.paperIdx), missing);
    assert.equal(f.client.calls.filter(call => call.name === 'EdictGuessRequest').length, 1);
    assert.equal(f.client.items.get('本期酆都入场券'), 0);
  }
});

test('edict: unavailable activities and insufficient or invalid ticket costs never start', async () => {
  for (const scenario of ['closed', 'future', 'wrongEvent', 'invalidId', 'noTicket', 'twoTickets', 'missingCost', 'zeroCost', 'resourceCost']) {
    const f = edictFixture();
    if (scenario === 'closed') f.event.closeTime = fixedNow / 1000;
    if (scenario === 'future') f.event.openTime = fixedNow / 1000 + 1;
    if (scenario === 'wrongEvent') f.event.type = '中秋国庆活动';
    if (scenario === 'invalidId') f.event.activityId = '';
    if (scenario === 'noTicket') f.client.items.set('本期酆都入场券', 0);
    if (scenario === 'twoTickets') { f.edictState.cost.num = 2; f.client.items.set('本期酆都入场券', 1); }
    if (scenario === 'missingCost') delete f.edictState.cost;
    if (scenario === 'zeroCost') f.edictState.cost.num = 0;
    if (scenario === 'resourceCost') f.edictState.cost.type = 1;
    await runEdict(f);
    assert.equal(f.client.calls.filter(call => /^Edict(Start|Ask|Guess)Request$/.test(call.name)).length, 0, scenario);
    assert.ok(f.ctx.results.some(row => row.status === 'skipped'), scenario);
  }
});

test('edict: invalid rune, shown or patience state and low patience stop before writes', async () => {
  const base = { rune: [4, 2, 3, 1], shown: [0, 0, 0, 0], patience: 100 };
  const changes = [{ rune: [4, 2, 3] }, { rune: [4, 2, 3, 4] }, { rune: [4, -1, 3, 2] },
    { rune: [4, 2, 3, 2147483647 + 1] }, { shown: [] }, { shown: [0, 64, 0, 0] }, { shown: [0, -1, 0, 0] },
    { patience: undefined }, { patience: 0 }, { patience: 20 }, { patience: 101 }];
  for (const change of changes) {
    const f = await runEdict(edictFixture({ session: { ...base, ...change } }));
    assert.equal(f.client.calls.filter(call => /^Edict(Start|Ask|Guess)Request$/.test(call.name)).length, 0, JSON.stringify(change));
    assert.ok(f.ctx.results.some(row => row.status === 'skipped'));
  }
});

test('edict: malformed start or reveal responses never advance to guessing', async () => {
  for (const stage of ['start', 'missingCell', 'invalidCell', 'missingPatience', 'wrongPatience']) {
    const f = edictFixture();
    if (stage === 'start') f.client.handlers.EdictStartRequest = async () => ({ session: { rune: [4, 4, 3, 1], shown: [0, 0, 0, 0], patience: 100 } });
    else f.client.handlers.EdictAskRequest = async () => {
      if (stage === 'missingCell') return { patience: 95 };
      if (stage === 'invalidCell') return { cellIdx: 6, patience: 95 };
      if (stage === 'missingPatience') return { cellIdx: 0 };
      return { cellIdx: 0, patience: 100 };
    };
    await runEdict(f);
    assert.equal(f.client.calls.filter(call => call.name === 'EdictGuessRequest').length, 0, stage);
    assert.ok(f.client.calls.filter(call => call.name === 'EdictAskRequest').length <= 1, stage);
    assert.ok(f.ctx.results.some(row => row.status === 'failed'), stage);
  }
});

test('edict: final readback must confirm every reveal, the same rune and matching patience', async () => {
  for (const change of [{ shown: [0, 1, 1, 1] }, { rune: [4, 7, 3, 1] }, { patience: 79 }, { sessionGone: true }]) {
    const f = edictFixture();
    const query = f.client.handlers.EdictInfoRequest;
    f.client.handlers.EdictInfoRequest = async () => {
      const data = await query();
      if (data.session?.shown.every(shown => shown > 0)) {
        if (change.sessionGone) data.session = null;
        else Object.assign(data.session, change);
      }
      return data;
    };
    await runEdict(f);
    assert.equal(f.client.calls.filter(call => call.name === 'EdictAskRequest').length, 4);
    assert.equal(f.client.calls.filter(call => call.name === 'EdictGuessRequest').length, 0);
    assert.match(f.ctx.results.at(-1).reason, /提交前读回未确认/);
  }
});

test('edict: timeouts persist and block another write after restarting the context', async () => {
  for (const request of ['EdictStartRequest', 'EdictAskRequest', 'EdictGuessRequest']) {
    const f = edictFixture();
    const handler = f.client.handlers[request];
    f.client.handlers[request] = async body => { await handler(body); throw new Error('模拟响应超时'); };
    await runEdict(f);
    assert.ok(f.ctx.results.some(row => row.status === 'uncertain'), request);
    const writes = f.client.calls.filter(call => /^Edict(Start|Ask|Guess)Request$/.test(call.name)).length;
    // 在同账号角色重新建上下文，验证持久化账本而不是仅依赖内存停止标志。
    f.ctx = createContext({ ...f.args, initialPushes: f.ctx.pushes }); f.ctx.setModule('activity');
    await runEdict(f);
    assert.equal(f.client.calls.filter(call => /^Edict(Start|Ask|Guess)Request$/.test(call.name)).length, writes, request);
    assert.match(f.ctx.results.at(-1).reason, /上次请求结果未确认/);
  }
});

test('edict: rejected reveal, disconnect and stop never submit later papers or a guess', async () => {
  for (const failure of ['rejected', 'disconnect', 'stop']) {
    const f = edictFixture();
    const handler = f.client.handlers.EdictAskRequest;
    f.client.handlers.EdictAskRequest = async body => {
      if (failure === 'rejected') throw Object.assign(new Error('耐心不足'), { prompt: 1 });
      const response = await handler(body);
      if (failure === 'disconnect') { f.client.connected = false; f.client.emit('close'); }
      if (failure === 'stop') f.ctx.stop.aborted = true;
      return response;
    };
    if (failure === 'rejected') await runEdict(f);
    else await assert.rejects(() => runEdict(f), /自动化已停止|连接/);
    assert.equal(f.client.calls.filter(call => call.name === 'EdictAskRequest').length, 1);
    assert.equal(f.client.calls.filter(call => call.name === 'EdictGuessRequest').length, 0);
  }
});

test('edict: wrong or incomplete guess result is failed and never retried on that session', async () => {
  for (const response of [{ success: false, correct: [true, true, true, true] },
    { success: true, correct: [true, false, true, true] }, { success: true, correct: [true, true, true] }]) {
    const f = edictFixture();
    f.client.handlers.EdictGuessRequest = async () => response;
    await runEdict(f);
    assert.equal(f.ctx.results.at(-1).status, 'failed');
    f.ctx = createContext({ ...f.args, initialPushes: f.ctx.pushes }); f.ctx.setModule('activity');
    await runEdict(f);
    assert.equal(f.client.calls.filter(call => call.name === 'EdictGuessRequest').length, 1);
    assert.match(f.ctx.results.at(-1).reason, /本局竞猜已失败/);
  }
});

test('edict: preview never writes, invents new state or plans a premature guess', async () => {
  for (const session of [null, { rune: [4, 2, 3, 1], shown: [0, 0, 0, 0], patience: 100 },
    { rune: [4, 2, 3, 1], shown: [1, 1, 1, 1], patience: 80 }]) {
    const f = await runEdict(edictFixture({ dryRun: true, session }));
    assert.equal(f.client.calls.filter(call => /^Edict(Start|Ask|Guess)Request$/.test(call.name)).length, 0);
    assert.equal(f.ctx.results.filter(row => row.request === 'EdictGuessRequest').length, 0);
    assert.ok(f.ctx.results.filter(row => row.status === 'planned').length <= 1);
    assert.equal(f.client.items.get('本期酆都入场券'), 3);
  }
});

test('edict: both the activity parent switch and the edict switch gate the service', async () => {
  for (const parentEnabled of [false, true]) {
    const f = edictFixture();
    f.settings.modules.activity.enabled = parentEnabled;
    f.settings.modules.activity.edict.enabled = !parentEnabled;
    try {
      const result = await runAutomation({ ...f.args, selector: 'activity', initialPushes: f.ctx.pushes });
      assert.equal(result.error, null);
      assert.equal(f.client.calls.filter(call => call.name.startsWith('Edict')).length, 0);
    } finally { f.ctx.dispose(); }
  }
});

test('activity: blind-box start/open/finish state advances exactly once per box', async () => {
  const event = { activityId: '9007199254740993', type: '中秋国庆活动', openTime: 1, closeTime: fixedNow / 1000 + 1000, subActivity: [{ subActivityType: 24, openTime: 1, closeTime: fixedNow / 1000 + 1000 }], limitTimeItem: [{ item: '本期_盲盒卡', openTime: 1, closeTime: fixedNow / 1000 + 1000 }] };
  let round = {}, opens = 0;
  const f = await moduleRun('activity', { blindBox: { enabled: true, play: true, freeGift: false, scoreReward: false, keepCards: 0 } }, ({ ctx, client }) => {
    ctx.pushes.set('SCAllActivity', { festivalActivities: [event] }); client.items.set('本期_盲盒卡', 1);
    client.handlers.BlindBoxDetailRequest = async () => ({ round });
    client.handlers.BlindBoxStartRequest = async () => { client.items.set('本期_盲盒卡', 0); round = { prizeType: [1, 2], opened: [] }; return { prizeType: [1, 2] }; };
    client.handlers.BlindBoxOpenRequest = async body => { opens++; round.opened.push({ boxIndex: body.boxIndex }); if (opens === 2) round = {}; return { finished: opens === 2 }; };
  });
  assert.deepEqual(f.client.calls.filter(c => /BlindBox(Start|Open)Request/.test(c.name)).map(c => c.name), ['BlindBoxStartRequest', 'BlindBoxOpenRequest', 'BlindBoxOpenRequest']);
  assert.equal(f.ctx.stop.aborted, false);
});

test('snap: resumes a PVE match and stops round submission immediately after settlement', async () => {
  const state = { mySide: protocol.SnapSide.SNAP_SIDE_A, round: { round: 1, energy: 1 }, hand: [{ uid: '10', heroId: '小布' }], zones: [{ zoneIndex: 1, unlocked: true, cardLimit: 4 }] };
  const f = await moduleRun('snap', { pve: true, maxMatches: 1 }, ({ ctx }) => { table(ctx, 'CardGameParamCfg', [{ matchTimeout: 60 }]); table(ctx, 'GameCardCfg', [{ heroId: '小布', cost: 1, power: 10 }]); }, { states: { SnapInfoRequest: { pveMatch: state } }, handlers: { SnapEndRoundRequest: async () => ({ settlement: { score: 1 } }) } });
  assert.equal(f.client.calls.filter(c => c.name === 'SnapEndRoundRequest').length, 1);
  assert.equal(f.ctx.results[0].status, 'success');
});

test('module chain: fleet consumed by radar is unavailable to subsequent boss', async () => {
  const fleets = [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }];
  const f = await moduleRun('world', { radar: { enabled: true, claim: false, kinds: [1], fixed: false }, worldBoss: { enabled: true, attackTimes: 1 } }, ({ ctx, client }) => {
    table(ctx, 'RadarRandEventCfg', [{ eventId: 1, type: 1 }]);
    client.handlers.MyFleetsRequest = async () => ({ fleets: structuredClone(fleets) });
    client.handlers.RadarSendFleetsRequest = async () => { fleets[0].state = protocol.FleetState.MOVING; };
  }, { states: { RadarInfoRequest: { radarInfo: { events: [{ uid: '123', eventId: 1, state: protocol.RadarEventState.RADAR_EVENT_INIT }] } }, WorldBossInfoRequest: { info: { bossId: 1 } } } });
  assert.ok(f.client.calls.some(c => c.name === 'RadarSendFleetsRequest'));
  assert.equal(f.client.calls.filter(c => c.name === 'ChallengeWorldBossRequest').length, 0);
});

test('world radar: refugee event skips dispatch when the server-provided materials are insufficient', async () => {
  const fleets = [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }];
  const f = await moduleRun('world', { radar: { enabled: true, claim: false, kinds: ['解救难民'], fixed: false } }, ({ ctx, client }) => {
    table(ctx, 'RadarRandEventCfg', [{ eventId: 60001, type: '解救难民' }]);
    client.items.set('木材', 1);
    client.handlers.MyFleetsRequest = async () => ({ fleets: structuredClone(fleets) });
  }, { states: { RadarInfoRequest: { radarInfo: { events: [{ uid: '123', eventId: 60001, state: protocol.RadarEventState.RADAR_EVENT_INIT, refugee: { requirements: [{ type: 0, id: '木材', num: 2 }] } }] } } } });
  assert.equal(f.client.calls.filter(call => call.name === 'RadarSendFleetsRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /物资不足：木材 1\/2/);
});

test('world radar: refugee event without a material list records a diagnostic and skips dispatch', async () => {
  const f = await moduleRun('world', { radar: { enabled: true, claim: false, kinds: ['解救难民'], fixed: false } }, ({ ctx, client }) => {
    table(ctx, 'RadarRandEventCfg', [{ eventId: 60002, type: '解救难民' }]);
    client.handlers.MyFleetsRequest = async () => ({ fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] });
  }, { states: { RadarInfoRequest: { radarInfo: { events: [{ uid: '124', eventId: 60002, state: protocol.RadarEventState.RADAR_EVENT_INIT, refugee: {} }] } } } });
  assert.equal(f.client.calls.filter(call => call.name === 'RadarSendFleetsRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /未下发物资清单/);
});

test('guild aid: daily 20-request cap skips asking before the request is sent', async () => {
  const aid = { receive: false, ask: true, askItems: ['木材'], help: false, helpItems: [], helpNicknameKeywords: [], helpMinStock: 30, helpDailyLimit: 50 };
  const f = await moduleRun('guild', { aid }, ({ ctx }) => table(ctx, 'ItemCfg', [{ id: '木材' }]), { states: { GuildInfoRequest: { guild: { guildId: '1' } }, CounterInfoRequest: { counters: [{ type: 'DAILY_GUILD_AID', num: 20 }] } } });
  assert.equal(f.client.calls.filter(call => call.name === 'GuildAidAskRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /DAILY_GUILD_AID=20\/20/);
});

test('guild aid: OkResponse confirms an ask and the in-round counter prevents a 21st request', async () => {
  const aid = { receive: false, ask: true, askItems: ['木材', '石头'], help: false, helpItems: [], helpNicknameKeywords: [], helpMinStock: 30, helpDailyLimit: 50 };
  const f = await moduleRun('guild', { aid }, ({ ctx }) => table(ctx, 'ItemCfg', [{ id: '木材' }, { id: '石头' }]), { states: { GuildInfoRequest: { guild: { guildId: '1' } }, CounterInfoRequest: { counters: [{ type: 'DAILY_GUILD_AID', num: 19 }] } } });
  const asks = f.client.calls.filter(call => call.name === 'GuildAidAskRequest');
  assert.deepEqual(asks.map(call => [call.body.reqItemId, call.response]), [['木材', 'OkResponse']]);
  assert.equal(f.ctx.results.find(result => result.request === 'GuildAidAskRequest')?.status, 'success');
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /DAILY_GUILD_AID=20\/20/);
});

test('loop: all selected enabled modules execute every round and stop during interval', async () => {
  const { runLoop } = await import('../src/loop.mjs');
  const f = fixture(); f.ctx.dispose();
  f.settings.modules.cargo.enabled = true; saveSettings(f.args.accountId, f.settings);
  const stop = { aborted: false };
  const result = await runLoop(f.client, protocol, { ...f.args, allowMutate: true, automationOnly: true, automationModules: ['cargo'], rounds: 3, everyMs: 1000, stop, sleep: async () => { stop.aborted = true; } });
  assert.equal(result.history.length, 1);
  assert.equal(f.client.calls.filter(c => c.name === 'CargoShipsRequest').length, 1);
});

test('API: settings confirmation, plan/run/status and busy exclusion with fake account only', async () => {
  const { saveStore, upsertAccount } = await import('../src/accounts.mjs');
  const { createConsole } = await import('../src/server.mjs');
  const store = { version: 1, activeId: null, accounts: [] };
  upsertAccount(store, { url: 'wss://offline.invalid/ws', login: { eworldParams: { openId: 'api-fixture' } } }); saveStore(store);
  const consoleApp = createConsole({ port: 0 }); await consoleApp.listen();
  const url = `http://127.0.0.1:${consoleApp.server.address().port}`;
  /** 本地请求只访问测试 HTTP 服务，游戏连接被注入的内存 Gateway 完整替代。 */
  async function api(route, body, accountId = 'api-fixture') {
    const response = await fetch(`${url}${route}?account=${encodeURIComponent(accountId)}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});
    return { status: response.status, value: await response.json() };
  }
  try {
    await api('/api/accounts'); const session = consoleApp.sessions.get('api-fixture');
    session.client = new Gateway(); session.player = { playerId: '7', level: 1 }; session.pushes = new Map();
    const initialSettingsResponse = await api('/api/automation/settings');
    const settings = initialSettingsResponse.value.settings;
    assert.deepEqual(initialSettingsResponse.value.vipAd, {
      connected: true,
      roleLevel: 1,
      vipLevel: null,
      minRoleLevel: 10,
      minVipLevel: 3,
      eligible: false,
    });
    session.player = { playerId: '7', level: 10, vip: { vipLevel: 2 } };
    assert.equal((await api('/api/automation/settings')).value.vipAd.eligible, false);
    session.player = { playerId: '7', level: 10, vip: { vipLevel: 3 } };
    assert.equal((await api('/api/automation/settings')).value.vipAd.eligible, true);
    session.pushes.set('SCVipUpdate', { vipLevel: 4 });
    assert.equal((await api('/api/automation/settings')).value.vipAd.vipLevel, 4);
    session.client = null;
    assert.equal((await api('/api/automation/settings')).value.vipAd.eligible, false);
    session.client = new Gateway();
    session.pushes = new Map();
    session.player = { playerId: '7', level: 10, vip: { vipLevel: 3 } };
    assert.equal((await api('/api/automation/settings', { settings })).status, 400);
    assert.equal((await api('/api/automation/settings', { confirm: true, settings })).status, 200);
    assert.equal((await api('/api/automation/run', { modules: 'all' })).status, 400);
    assert.equal((await api('/api/automation/plan', { modules: 'all' })).value.results.length, 18);
    assert.equal((await api('/api/automation/run', { confirm: true, modules: 'all' })).status, 200);
    assert.equal((await api('/api/automation/status')).value.running, false);
    session.busy = 'test-operation';
    assert.equal((await api('/api/automation/plan', { modules: 'all' })).status, 400);
    assert.equal(session.busy, 'test-operation');
    assert.equal(session.client.calls.length, 0);
    assert.equal((await api('/api/automation/status')).status, 200);
    session.busy = null;
    // 主挂机请求缺少轮数时必须按持续运行处理，不能静默收敛成单轮。
    assert.equal((await api('/api/loop/start', { confirm: true, modules: ['cargo'], everySeconds: 1 })).status, 200);
    assert.equal(session.loop.rounds, 0);
    assert.ok(session.log.some(entry => entry.message.startsWith('自动挂机开始：持续运行')));
    assert.equal((await api('/api/automation/stop', { confirm: true })).status, 200);
    for (let attempts = 0; session.loop.running && attempts < 50; attempts++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(session.loop.running, false);
    assert.equal((await api('/api/loop/start', { confirm: true, modules: ['cargo'], automationOnly: true, rounds: 0, everySeconds: 1 })).status, 200);
    assert.equal((await api('/api/automation/status')).value.running, true);
    assert.equal((await api('/api/automation/stop', { confirm: true })).status, 200);
    for (let attempts = 0; session.loop.running && attempts < 50; attempts++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(session.loop.running, false);
    assert.equal((await api('/api/automation/status')).value.running, false);
    assert.equal((await api('/api/loop/start', { confirm: true, modules: ['snap'], automationOnly: true, rounds: 1, everySeconds: 1 })).status, 400);

    // 删除仅限本机凭证，但必须先让持有该账号 client 的后台链停止，不能遗留写请求。
    upsertAccount(store, { url: 'wss://offline.invalid/ws', login: { eworldParams: { openId: 'api-remove' } } }); saveStore(store);
    await api('/api/accounts');
    const removing = consoleApp.sessions.get('api-remove');
    let clientStopped = false;
    removing.client = { stop: () => { clientStopped = true; } };
    removing.loop.running = true;
    removing.loop.stop = { aborted: false };
    assert.equal((await api('/api/accounts/remove', { confirm: true, id: 'api-remove' }, 'api-remove')).status, 200);
    assert.equal(removing.loop.stop.aborted, true);
    assert.equal(clientStopped, true);
    assert.equal(consoleApp.sessions.has('api-remove'), false);
  } finally { consoleApp.server.closeAllConnections(); await consoleApp.close(); }
});

test('paid legacy: ClickGold and Discount use shared disabled, module and total budgets', async () => {
  const f = fixture({ states: { ClickGoldInfoRequest: { info: { paidTimes: 0 } }, DiscountShopRequest: { shopItem: [{ id: 1, price: 100, discount: 0.5 }] } } });
  table(f.ctx, 'OfflineParamCfg', [{ paramName: '点金价格', paramValue: 20 }]); f.ctx.setModule('dailies');
  const gold = { request: 'ClickGoldRequest', body: { free: false, times: 1 } };
  const discount = { request: 'DiscountShopBuyRequest', body: { id: 1 } };
  f.client.handlers.ClickGoldRequest = async () => { f.client.states.ClickGoldInfoRequest.info.paidTimes++; f.client.ruby -= 20; return {}; };
  f.client.handlers.DiscountShopBuyRequest = async () => { f.client.states.DiscountShopRequest.shopItem[0].isBuy = true; f.client.ruby -= 50; return {}; };
  try {
    await assert.rejects(guardedDailyAction(f.ctx, gold), /未开启/);
    Object.assign(f.settings.spending, { enabled: true, dailyLimit: 80 });
    await assert.rejects(guardedDailyAction(f.ctx, gold), /额度为 0/);
    f.settings.spending.modules.dailies = 60;
    await guardedDailyAction(f.ctx, gold);
    await assert.rejects(guardedDailyAction(f.ctx, discount), /日额度不足/);
    f.settings.spending.modules.dailies = 80;
    await guardedDailyAction(f.ctx, discount);
    assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 70);
    assert.equal(f.client.calls.filter(c => c.name === gold.request).length, 1);
    assert.equal(f.client.calls.filter(c => c.name === discount.request).length, 1);
  } finally { f.ctx.dispose(); }
});

test('manual writes: --yes alone cannot bypass shared account executor', async () => {
  const { runAction } = await import('../src/actions.mjs'); const f = fixture();
  try {
    await assert.rejects(runAction(f.client, protocol, 'upgradeBuilding', { buildingId: '1住宅' }, { allowMutate: true }), /共享执行上下文/);
    assert.equal(f.client.calls.length, 0);
  } finally { f.ctx.dispose(); }
});

test('manual month-card reward requires and confirms the selected card type', async () => {
  const { ACTIONS, buildBody, runAction } = await import('../src/actions.mjs');
  const { legacyAction } = await import('../src/automation/service.mjs');
  assert.throws(() => buildBody(ACTIONS.monthCardDaily), /missing parameter: type/);
  const f = fixture({ states: { MonthCardRequest: { cardItem: [
    { type: 1, gotDailyReward: false },
    { type: 2, gotDailyReward: false },
  ] } }, handlers: {
    // 月卡可并存，测试只更新请求指定的卡，验证读回目标不会依赖其他卡的状态。
    MonthCardDailyRewardRequest: async ({ type }, _response, client) => {
      client.states.MonthCardRequest.cardItem.find(card => card.type === type).gotDailyReward = true;
    },
  } });
  try {
    await runAction(f.client, protocol, 'monthCardDaily', { type: '2' }, { allowMutate: true, actionExecutor: step => legacyAction(f.ctx, step) });
    assert.deepEqual(f.client.calls.filter(call => call.name === 'MonthCardDailyRewardRequest').map(call => call.body), [{ type: 2 }]);
    assert.equal(f.client.states.MonthCardRequest.cardItem.find(card => card.type === 2).gotDailyReward, true);
  } finally { f.ctx.dispose(); }

  const mismatched = fixture({ states: { MonthCardRequest: { cardItem: [
    { type: 1, gotDailyReward: false },
    { type: 2, gotDailyReward: false },
  ] } }, handlers: {
    // 另一张卡变化不能证明 type=2 已领取，避免把不相关的状态变化当作成功。
    MonthCardDailyRewardRequest: async (_body, _response, client) => {
      client.states.MonthCardRequest.cardItem.find(card => card.type === 1).gotDailyReward = true;
    },
  } });
  try {
    await assert.rejects(runAction(mismatched.client, protocol, 'monthCardDaily', { type: 2 }, { allowMutate: true, actionExecutor: step => legacyAction(mismatched.ctx, step) }), /业务状态尚未确认/);
    assert.equal(mismatched.client.states.MonthCardRequest.cardItem.find(card => card.type === 2).gotDailyReward, false);
  } finally { mismatched.ctx.dispose(); }
});

test('confirmed failure: stock refresh error does not create an uncertain duplicate or reserve again', async () => {
  const f = fixture();
  try {
    await f.ctx.refreshStock(); f.client.handlers.AllItemRequest = async () => { throw new Error('disconnected'); };
    const result = await f.ctx.action('ChallengeStageRequest', { stage: 10 }, { accept: () => false });
    assert.equal(result.status, 'failed'); assert.equal(f.ctx.stop.aborted, true);
    assert.deepEqual(f.ctx.ledger.pending, {});
  } finally { f.ctx.dispose(); }
});

test('service status: completed results and ledger never leak into another role', async () => {
  const f = fixture(); f.ctx.dispose();
  await runAutomation(f.args);
  assert.equal(automationStatus(f.args.accountId, 'other-role').results.length, 0);
  assert.equal(automationStatus(f.args.accountId, f.args.player.playerId).results.length, 18);
});

test('pet: sea-building fleet UID and ultra formation are protected; incomplete fleet data blocks release', async () => {
  const states = { OnWaterRequest: { building: [{ buildingId: '1舰队', fleet: { formation: { presetId: 1, petUid: '1' } } }] }, MyFleetsRequest: { fleets: [{ buildingId: '1舰队', petId: '蓝鱼' }] }, UltraInfoRequest: { forms: [{ index: 1, presetId: 1, petUid: '2' }] }, AllPetRequest: { pets: [1, 2, 3].map(uid => ({ uid: String(uid), petId: '蓝鱼' })) } };
  const setup = ({ ctx }) => table(ctx, 'PetBreedCfg', [{ petId: '蓝鱼', quality: 'BLUE', qualityIndex: 1 }, { petId: '紫鱼', quality: 'PURPLE', qualityIndex: 2 }]);
  const options = { claim: false, decompose: true, decomposeBelowQuality: 'PURPLE' };
  const f = await moduleRun('pet', options, setup, { dryRun: true, states });
  assert.deepEqual(f.ctx.results.find(r => r.request === 'FreePetRequest').body.petUid, ['3']);
  const g = await moduleRun('pet', options, setup, { dryRun: true, states: { ...states, OnWaterRequest: {} } });
  assert.equal(g.ctx.results.filter(r => r.request === 'FreePetRequest').length, 0);
  assert.ok(g.ctx.results.some(r => /编队不完整/.test(r.reason)));
});

test('hero: single-level price refreshes inventory and selected hero alone is cultivated', async () => {
  const f = await moduleRun('hero', { heroes: ['小布'], levelUp: true, levelUpMaxActions: 3 }, ({ ctx, client }) => {
    table(ctx, 'HeroCfg', [{ id: '小布', quality: 'BLUE' }]); table(ctx, 'HeroUpgradeCfg', [{ level: 1, reqPlayerLv: 1, exp: 0 }, { level: 2, reqPlayerLv: 1, exp: 5 }, { level: 3, reqPlayerLv: 1, exp: 10 }]);
    client.items.set('英雄经验', 5);
  }, { states: { AllHeroRequest: { heroes: [{ heroId: '小布', level: 1 }, { heroId: '其他', level: 1 }] } }, handlers: { HeroLevelUpRequest: async (_, response, client) => { client.states.AllHeroRequest.heroes[0].level++; client.items.set('英雄经验', 0); return {}; } } });
  assert.deepEqual(f.client.calls.filter(c => c.name === 'HeroLevelUpRequest').map(c => c.body.heroId), ['小布']);
  assert.equal(f.ctx.results[0].status, 'success');
});

test('museum: completed exploration -> reward -> new expedition follows fresh state', async () => {
  const f = await moduleRun('museum', { collectRevenue: false, explore: true }, ({ ctx, client }) => { table(ctx, 'MuseumExploreTimeFactorCfg', [{ factor: 1, playerLevel: 1 }]); client.items.set('木材', 1); }, {
    states: { MuseumInfoRequest: { exploreStages: [{ stageId: 1, progress: 0, expedition: { startTime: 1, endTime: 2 } }] }, GetFormationRequest: { formation: { presetId: 1, heroPositions: [{ heroId: '小布' }] } } },
    handlers: {
      MuseumCompleteExploreRequest: async () => ({ grade: 1, progressGain: 1 }),
      MuseumRewardRequest: async (_, response, client) => { client.states.MuseumInfoRequest.exploreStages[0].expedition = { startTime: 0, endTime: 0, cost: { asset: [{ type: 0, id: '木材', num: 1 }] } }; return {}; },
      MuseumStartExploreRequest: async () => ({ expedition: { startTime: fixedNow / 1000, endTime: fixedNow / 1000 + 10 } }),
    },
  });
  assert.deepEqual(f.client.calls.filter(c => /Museum(Complete|Reward|Start)/.test(c.name)).map(c => c.name), ['MuseumCompleteExploreRequest', 'MuseumRewardRequest', 'MuseumStartExploreRequest']);
});

/** 多个空闲关卡不得重复派出同一英雄；服务端会以 already dispatched 拒绝重复英雄。 */
test('museum: idle stages receive disjoint hero groups', async () => {
  const f = await moduleRun('museum', { collectRevenue: false, explore: true, factor: 1 }, ({ ctx, client }) => { table(ctx, 'MuseumExploreTimeFactorCfg', [{ factor: 1, playerLevel: 1 }]); client.items.set('木材', 2); }, {
    states: {
      MuseumInfoRequest: {
        exploreStages: [
          { stageId: 1, expedition: { startTime: 0, endTime: 0, heroIds: [], cost: { asset: [{ type: 0, id: '木材', num: 1 }] } } },
          { stageId: 2, expedition: { startTime: 0, endTime: 0, heroIds: [], cost: { asset: [{ type: 0, id: '木材', num: 1 }] } } },
        ],
      },
      GetFormationRequest: {
        formation: {
          presetId: 1,
          heroPositions: [{ heroId: '机器屠夫' }, { heroId: '小布' }, { heroId: '海盗王' }],
        },
      },
    },
  });
  const starts = f.client.calls.filter(c => c.name === 'MuseumStartExploreRequest');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map(call => call.body.heroIds), [['机器屠夫'], ['小布', '海盗王']]);
  assert.equal(new Set(starts.flatMap(call => call.body.heroIds)).size, 3);
});

/** 服务端未下发足够探宝材料时，只记录跳过，不发送必然被拒绝的启动请求。 */
test('museum: insufficient expedition cost skips start request', async () => {
  const f = await moduleRun('museum', { collectRevenue: false, explore: true, factor: 1 }, ({ ctx, client }) => {
    table(ctx, 'MuseumExploreTimeFactorCfg', [{ factor: 1, playerLevel: 1 }]);
    client.items.set('木材', 1);
  }, { states: {
    MuseumInfoRequest: { exploreStages: [{ stageId: 1, expedition: { startTime: 0, endTime: 0, heroIds: [], cost: { asset: [{ type: 0, id: '木材', num: 2 }] } } }] },
    GetFormationRequest: { formation: { heroPositions: [{ heroId: '机器屠夫' }] } },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'MuseumStartExploreRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /缺少探宝消耗或库存不足/);
});

/** 已知 conditionId 时优先满足全部条件；不足时仍按职业和星级补齐。 */
test('museum: condition-aware hero selection prefers exact matches and then role/star', async () => {
  const f = await moduleRun('museum', { collectRevenue: false, explore: true, factor: 1 }, ({ ctx, client }) => {
    table(ctx, 'MuseumExploreTimeFactorCfg', [{ factor: 1, playerLevel: 1 }]);
    table(ctx, 'MuseumExpeditionConditionCfg', [{ conditionId: 9001, heroCount: 3, heroStar: 15, heroQualityIndex: 2, careerLimit: '法师', factionLimit: '' }]);
    table(ctx, 'HeroCfg', [
      { id: '法师达标', career: '法师', qualityIndex: 2 },
      { id: '法师低星', career: '法师', qualityIndex: 2 },
      { id: '法师蓝卡', career: '法师', qualityIndex: 1 },
      { id: '战士高星', career: '战士', qualityIndex: 2 },
    ]);
    client.items.set('木材', 1);
  }, {
    states: {
      MuseumInfoRequest: { exploreStages: [{ stageId: 1, expedition: { startTime: 0, endTime: 0, heroIds: [], conditionId: 9001, cost: { asset: [{ type: 0, id: '木材', num: 1 }] } } }] },
      GetFormationRequest: { formation: { heroPositions: [] } },
      AllHeroRequest: { heroes: [
        { heroId: '法师达标', star: 3, power: 10 },
        { heroId: '法师低星', star: 2, power: 100 },
        { heroId: '法师蓝卡', star: 5, power: 200 },
        { heroId: '战士高星', star: 5, power: 999 },
      ] },
    },
  });
  const start = f.client.calls.find(call => call.name === 'MuseumStartExploreRequest');
  assert.deepEqual(start.body.heroIds, ['法师达标', '法师蓝卡', '法师低星']);
});

/** 没有主线编队时仍从 AllHeroResponse 的空闲英雄中组队。 */
test('museum: idle hero list is used when mainline formation is empty', async () => {
  const f = await moduleRun('museum', { collectRevenue: false, explore: true, factor: 1 }, ({ ctx, client }) => { table(ctx, 'MuseumExploreTimeFactorCfg', [{ factor: 1, playerLevel: 1 }]); client.items.set('木材', 1); }, {
    states: {
      MuseumInfoRequest: { exploreStages: [{ stageId: 1, expedition: { startTime: 0, endTime: 0, heroIds: [], cost: { asset: [{ type: 0, id: '木材', num: 1 }] } } }] },
      GetFormationRequest: { formation: { heroPositions: [] } },
      AllHeroRequest: { heroes: [{ heroId: '空闲高战', star: 3, power: 300 }, { heroId: '空闲低战', star: 1, power: 100 }] },
    },
  });
  const start = f.client.calls.find(call => call.name === 'MuseumStartExploreRequest');
  assert.deepEqual(start.body.heroIds, ['空闲高战', '空闲低战']);
});

test('trial: unchanged passed stage means confirmed defeat; no later challenge is sent', async () => {
  const f = await moduleRun('battle', { maxActions: 3, stage: { enabled: false, claimReward: false }, trial: { heroExp: { challenge: true, rubySweep: false }, forge: {}, petExp: {} } }, ({ ctx }) => table(ctx, 'TrialRaidStageCfg', [{ raidId: 1, stageId: 1002, openLevel: 1 }]), { states: { TrialRaidInfoRequest: { raid: { passedStage: 1001 } } } });
  assert.equal(f.client.calls.filter(c => c.name === 'TrialRaidChallengeRequest').length, 1);
  assert.equal(f.ctx.results[0].status, 'failed');
});

// 服务端已返回战斗回包时，读回超时只影响结果展示，不能把已完成请求遗留为禁止重试的待确认记录。
test('trial: response followed by readback failure settles without a pending record', async () => {
  let reads = 0;
  const f = await moduleRun('battle', { maxActions: 1, stage: { enabled: false, claimReward: false }, trial: { heroExp: { challenge: true, rubySweep: false }, forge: {}, petExp: {} } }, ({ ctx, client }) => {
    table(ctx, 'TrialRaidStageCfg', [{ raidId: 1, stageId: 1002, openLevel: 1 }]);
    client.handlers.TrialRaidInfoRequest = async () => {
      if (++reads === 1) return { raid: { passedStage: 1001 } };
      if (reads === 2) throw new Error('readback timeout');
      // 试炼挑战循环结束后还会查询扫荡信息；此查询不属于写后确认。
      return { raid: { passedStage: 0, buySweepTimes: 0 } };
    };
  });
  assert.equal(f.ctx.results[0].status, 'failed');
  assert.match(f.ctx.results[0].reason, /已收到 TrialRaidChallengeResponse/);
  assert.deepEqual(loadLedger(f.args.accountId, f.args.player.playerId).ledger.pending, {});
});

/**
 * 重现 2026-11-03 VIP3 抓包：普通扫荡已用 3 次，广告额外扫荡直接返回奖励。
 * 广告与普通扫荡次数故意不自动更新，用来检验跨轮防重不能依赖未捕获的次数推送。
 */
function vipTrialFixture(options = {}) {
  const f = fixture({ player: { level: 10, vip: { vipLevel: 3 } }, ...options });
  f.settings.vipFreeAd = true;
  f.settings.modules.battle.enabled = true;
  f.settings.modules.battle.stage = { enabled: false, claimReward: false };
  table(f.ctx, 'AdvEffectCfg', [3, 4, 5].map(id => ({ id, dailyLimit: 1 })));
  f.client.states.OnWaterRequest = { adv: [3, 4, 5].map(id => ({ id, gotTimes: 0, reward: true })) };
  f.client.handlers.TrialRaidInfoRequest = async ({ raidId }) => ({ raid: { raidId, passedStage: raidId * 1000 + 1, sweepTimes: 0, buySweepTimes: 3 } });
  f.client.handlers.WatchAdvRequest = async (_, response) => { assert.equal(response, 'OkResponse'); return {}; };
  f.client.handlers.TrialRaidBuySweepRequest = async ({ raidId, useAdvCard }, response) => {
    assert.equal(useAdvCard, true);
    assert.equal(response, 'GotRewardResponse');
    // 奖励类型和数量来自抓包帧 206、220、233，直接奖励无需再发送第二条扫荡 RPC。
    const [id, num] = { 1: ['英雄经验', 590000], 2: ['精铁', 5000], 3: ['宠物经验', 46000] }[raidId];
    return { reward: { asset: [{ type: 0, id, num }, { type: 0, id: '加速器', num: 10 }] } };
  };
  return f;
}

/** 三类独立广告额度在普通扫荡达到上限后仍可领取；关闭钻石消费不会阻止领取。 */
test('trial VIP: captured registration and reward sequence works for all three raids without ruby spending', async () => {
  const f = vipTrialFixture();
  try {
    await HANDLERS.battle(f.ctx, f.settings.modules.battle);
    const writes = f.client.calls.filter(call => ['WatchAdvRequest', 'TrialRaidBuySweepRequest'].includes(call.name));
    assert.deepEqual(writes.map(({ name, body, response }) => ({ name, body, response })), [
      { name: 'WatchAdvRequest', body: { type: 1, id: 4 }, response: 'OkResponse' },
      { name: 'TrialRaidBuySweepRequest', body: { raidId: 1, useAdvCard: true }, response: 'GotRewardResponse' },
      { name: 'WatchAdvRequest', body: { type: 1, id: 3 }, response: 'OkResponse' },
      { name: 'TrialRaidBuySweepRequest', body: { raidId: 2, useAdvCard: true }, response: 'GotRewardResponse' },
      { name: 'WatchAdvRequest', body: { type: 1, id: 5 }, response: 'OkResponse' },
      { name: 'TrialRaidBuySweepRequest', body: { raidId: 3, useAdvCard: true }, response: 'GotRewardResponse' },
    ]);
    assert.equal(f.ctx.results.filter(row => row.status === 'success').length, 6);
    assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 0);
    assert.equal(f.client.calls.filter(call => call.name === 'TrialRaidChallengeRequest').length, 0);
    // 同一角色重建上下文后，即使 OnWater 尚未反映次数变化，也不能再次领取。
    const restarted = createContext(f.args);
    try { await HANDLERS.battle(restarted, f.settings.modules.battle); }
    finally { restarted.dispose(); }
    assert.equal(f.client.calls.filter(call => call.name === 'WatchAdvRequest').length, 3);
    assert.equal(f.client.calls.filter(call => call.name === 'TrialRaidBuySweepRequest').length, 3);
  } finally { f.ctx.dispose(); }
});

/** 资格边界使用真实数字等级；隐藏开关后即使保存值仍开启，也不得登记广告权益。 */
for (const [name, player, enabled] of [
  ['VIP2', { level: 41, vip: { vipLevel: 2 } }, true],
  ['role9', { level: 9, vip: { vipLevel: 3 } }, true],
  ['missing VIP', { level: 41 }, true],
  ['missing role level', { level: undefined, vip: { vipLevel: 3 } }, true],
  ['string VIP', { level: 41, vip: { vipLevel: '3' } }, true],
  ['switch off', { level: 41, vip: { vipLevel: 3 } }, false],
]) test(`trial VIP: ${name} does not register or claim ad sweeps`, async () => {
  const f = vipTrialFixture({ player });
  f.settings.vipFreeAd = enabled;
  try {
    await HANDLERS.battle(f.ctx, f.settings.modules.battle);
    assert.equal(f.client.calls.filter(call => ['WatchAdvRequest', 'TrialRaidBuySweepRequest'].includes(call.name)).length, 0);
  } finally { f.ctx.dispose(); }
});

/** 最新推送可提升或撤销本轮资格，不能仅依赖登录时的 VIP 值。 */
test('trial VIP: live VIP updates override the login snapshot', async () => {
  for (const [login, pushed, expected] of [[2, 3, 3], [3, 2, 0]]) {
    const f = vipTrialFixture({ player: { level: 41, vip: { vipLevel: login } } });
    f.client.emit('message', { name: 'SCVipUpdate', body: { vipLevel: pushed } });
    try {
      await HANDLERS.battle(f.ctx, f.settings.modules.battle);
      assert.equal(f.client.calls.filter(call => call.name === 'TrialRaidBuySweepRequest').length, expected);
    } finally { f.ctx.dispose(); }
  }
});

/** 缺失服务端额度、已用尽额度或尚未通关，都必须在登记之前跳过。 */
test('trial VIP: server caps, missing counters, missing config and locked raids prevent writes', async () => {
  const f = vipTrialFixture();
  f.client.states.OnWaterRequest.adv = [{ id: 4, gotTimes: 1, reward: false }];
  f.client.handlers.TrialRaidInfoRequest = async ({ raidId }) => ({ raid: { raidId, passedStage: raidId === 3 ? 0 : raidId * 1000 + 1 } });
  try {
    await HANDLERS.battle(f.ctx, f.settings.modules.battle);
    assert.ok(f.ctx.results.some(row => /缺少服务端广告次数/.test(row.reason)));
    table(f.ctx, 'AdvEffectCfg', []);
    await HANDLERS.battle(f.ctx, f.settings.modules.battle);
    assert.ok(f.ctx.results.some(row => /缺少广告额度配置/.test(row.reason)));
    assert.equal(f.client.calls.filter(call => ['WatchAdvRequest', 'TrialRaidBuySweepRequest'].includes(call.name)).length, 0);
  } finally { f.ctx.dispose(); }
});

/** 已开启免广告也必须受挑战模块总开关约束，不能从其他模块悄悄触发。 */
test('trial VIP: disabled battle module never sends ad requests', async () => {
  const f = vipTrialFixture();
  f.settings.modules.battle.enabled = false;
  f.ctx.dispose();
  const result = await runAutomation({ ...f.args, selector: 'battle' });
  assert.equal(result.error, null);
  assert.equal(f.client.calls.length, 0);
});

/** 计划展示完整的协议顺序，但不得消耗服务器额度或保存本地尝试次数。 */
test('trial VIP: dry run plans the pair without writes or persistent attempt reservations', async () => {
  const f = vipTrialFixture({ dryRun: true });
  try {
    await HANDLERS.battle(f.ctx, f.settings.modules.battle);
    assert.equal(f.ctx.results.filter(row => row.status === 'planned').length, 6);
    assert.equal(f.client.calls.filter(call => ['WatchAdvRequest', 'TrialRaidBuySweepRequest'].includes(call.name)).length, 0);
    assert.equal(f.ctx.count('trial.vipAdSweep.1'), 0);
    assert.equal(fs.existsSync(loadLedger(f.args.accountId, f.args.player.playerId).file), false);
  } finally { f.ctx.dispose(); }
});

/** 登记或领奖异常后重建整个执行器，验证持久化记录阻止下一轮再次发送。 */
for (const mode of ['registration rejected', 'registration timeout', 'sweep timeout', 'empty reward']) {
  test(`trial VIP: ${mode} stops the pair and does not retry after restart`, async () => {
    const f = vipTrialFixture();
    f.client.handlers.TrialRaidInfoRequest = async ({ raidId }) => ({ raid: { raidId, passedStage: raidId === 1 ? 1029 : 0, buySweepTimes: 3 } });
    if (mode.startsWith('registration')) f.client.handlers.WatchAdvRequest = async () => {
      const error = new Error(mode);
      if (mode.endsWith('rejected')) error.prompt = {};
      throw error;
    };
    else f.client.handlers.TrialRaidBuySweepRequest = async () => {
      if (mode === 'sweep timeout') throw new Error(mode);
      return { reward: { asset: [] } };
    };
    f.ctx.dispose();
    const first = await runAutomation({ ...f.args, selector: 'battle' });
    const expected = mode === 'registration rejected' ? 'rejected' : mode === 'empty reward' ? 'failed' : 'uncertain';
    assert.ok(first.results.some(row => row.status === expected));
    const second = await runAutomation({ ...f.args, selector: 'battle' });
    assert.equal(second.error, null);
    assert.equal(f.client.calls.filter(call => call.name === 'WatchAdvRequest').length, 1);
    assert.equal(f.client.calls.filter(call => call.name === 'TrialRaidBuySweepRequest').length, mode.startsWith('registration') ? 0 : 1);
  });
}

// 配置表按目标等级取消耗，但服务端字段是本次升级幅度，160 级升一次必须发送 1 而非 161。
test('afk: upgrade sends a one-level increment while pricing the next level', async () => {
  const current = { level: 1, afkStartTime: 1, afkFinishTime: 2, rewardedLevel: 0 };
  const f = await moduleRun('afk', { claim: false, levelUp: true, levelReward: false }, ({ ctx, client }) => {
    ctx.config.afkMaxLevel = () => 2;
    table(ctx, 'OfflineCfg', [{ level: 2, consume: ['挂机徽章', 1] }]);
    client.items.set('挂机徽章', 1);
    client.handlers.AfkInfoRequest = async () => ({ afkInfo: current });
    client.handlers.UpgradeAfkLevelRequest = async (body) => {
      assert.deepEqual(body, { level: 1 });
      current.level = 2;
      return { level: 2 };
    };
  });
  assert.equal(f.client.calls.filter(c => c.name === 'UpgradeAfkLevelRequest').length, 1);
  assert.equal(f.ctx.results[0].status, 'success');
});

test('expedition: persisted cycle health blocks low HP after restart; missing baseline also skips', async () => {
  const f = fixture({ states: { ExpeditionInfoRequest: { raidId: 1, passedStage: 1, endTime: fixedNow / 1000 + 100, hero: [{ heroId: '小布', hp: '30' }] } } });
  const options = f.settings.modules.battle; options.stage.claimReward = false; options.expedition.challenge = true;
  f.ctx.memory(`expedition.1.${fixedNow / 1000 + 100}`, { 小布: 100 }); f.ctx.dispose();
  const restarted = createContext(f.args); restarted.setModule('battle');
  try { await restarted.refreshStock(); await HANDLERS.battle(restarted, options); assert.ok(restarted.results.some(r => /最低血量/.test(r.reason))); assert.equal(f.client.calls.filter(c => c.name === 'ExpeditionChallengeRequest').length, 0); }
  finally { restarted.dispose(); }
});

test('gather: dive and salvage quantities respect current material yield and warehouse capacity', async () => {
  const f = await moduleRun('gather', { diving: true, salvage: true, divingEach: 20, salvageEach: 30 }, ({ ctx, client }) => {
    table(ctx, 'DiveItemsDefinitionCfg', [{ produce: ['海藻', 1] }]); table(ctx, 'GarbageProductionCfg', [{ id: '塑料垃圾1', production: ['塑料', 2] }]);
    client.items.set('海藻', 95); client.items.set('塑料', 94);
  }, { dryRun: true, states: { OnWaterRequest: { divingLevel: { level: 1 }, salvageLevel: { level: 1 } }, GameEffectRequest: { effects: [{ id: protocol.GameEffectId.RAW_MATERIAL_UPPER_BOUND, value: 100 }] } } });
  assert.deepEqual(f.ctx.results.find(r => r.request === 'DivingRequest').body.reward.asset, [{ type: 0, id: '海藻', num: 5 }]);
  assert.deepEqual(f.ctx.results.find(r => r.request === 'EndSalvageRequest').body.pickedFloaters, [{ floaterId: '塑料垃圾1', num: 3 }]);
});

test('guild ship: chosen current quality and rewards permit exact stocked cabin order only', async () => {
  const f = await moduleRun('guild', { ship: { captain: false, crew: true, qualities: ['BLUE'], rewardItems: ['水姆币'], minWaterCoin: 5, forbiddenMaterials: [], relaxFilters: false } }, ({ ctx, client }) => { ctx.season = 1; table(ctx, 'GuildShipParamCfg', [{ season: 1, time: [12], duration: 60 }]); table(ctx, 'GuildShipCfg', [{ shipId: 2, quality: 'BLUE' }]); client.items.set('木材', 5); }, { dryRun: true, states: { GuildInfoRequest: { guild: { guildId: '1' } }, GuildShipRequest: { ship: [{ shipId: 1, type: 2, state: protocol.GuildShipState.GS_STATE_PREPARED, preparedEndTime: fixedNow / 1000 + 60, reward: { asset: [{ type: 0, id: '水姆币', num: 5 }] }, cabin: [{ crewId: 1, order: [{ type: 0, id: '木材', num: 5 }] }] }] } } });
  assert.deepEqual(f.ctx.results.find(r => r.request === 'GuildShipOrderRequest').body, { shipId: 1, crewId: 1 });
});

/** 补给窗口未开放时，不读取商船列表，更不能发送补货写请求。 */
test('guild ship: outside the current-season resupply window sends no ship request', async () => {
  const f = await moduleRun('guild', { ship: { captain: false, crew: true, qualities: [], rewardItems: [], minWaterCoin: 0, forbiddenMaterials: [], relaxFilters: false } }, ({ ctx }) => { ctx.season = 1; table(ctx, 'GuildShipParamCfg', [{ season: 1, time: [12], duration: 30 }]); }, { dryRun: true, states: { GuildInfoRequest: { guild: { guildId: '1' } }, GuildShipRequest: { ship: [] } } });
  assert.equal(f.client.calls.filter(call => call.name === 'GuildShipRequest' || call.name === 'GuildShipOrderRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /不在联盟商船补给时段/);
  assert.ok(f.ctx.results.some(result => result.label === '赛季配置检查' && result.status === 'success' && /设置赛季 1；可用赛季 1/.test(result.reason)));
});

/** 错误赛季编号必须在日志中暴露可用赛季，同时继续阻止联盟商船请求。 */
test('guild ship: invalid season is diagnosed before any ship request', async () => {
  const f = await moduleRun('guild', { ship: { captain: false, crew: true, qualities: [], rewardItems: [], minWaterCoin: 0, forbiddenMaterials: [], relaxFilters: false } }, ({ ctx }) => {
    ctx.season = 6000;
    table(ctx, 'GuildShipParamCfg', [{ season: 1, time: [12], duration: 30 }, { season: 6, time: [18], duration: 30 }]);
  }, { dryRun: true, states: { GuildInfoRequest: { guild: { guildId: '1' } } } });
  assert.equal(f.client.calls.filter(call => call.name === 'GuildShipRequest' || call.name === 'GuildShipOrderRequest').length, 0);
  assert.ok(f.ctx.results.some(result => result.label === '赛季配置检查' && result.status === 'error' && /设置赛季 6000；可用赛季 1,6；未匹配/.test(result.reason)));
});

/** 服务器补给截止时间已过时，保留只读查询但不再提交 GuildShipOrderRequest。 */
test('guild ship: expired prepared slot skips the resupply write', async () => {
  const f = await moduleRun('guild', { ship: { captain: false, crew: true, qualities: [], rewardItems: [], minWaterCoin: 0, forbiddenMaterials: [], relaxFilters: false } }, ({ ctx, client }) => { ctx.season = 1; table(ctx, 'GuildShipParamCfg', [{ season: 1, time: [12], duration: 60 }]); client.items.set('木材', 5); }, { dryRun: true, states: {
    GuildInfoRequest: { guild: { guildId: '1' } },
    GuildShipRequest: { ship: [{ shipId: 1, type: 1, state: protocol.GuildShipState.GS_STATE_PREPARED, preparedEndTime: fixedNow / 1000 - 1, cabin: [{ crewId: 1, order: [{ type: 0, id: '木材', num: 5 }] }] }] },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'GuildShipOrderRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /没有未过期的联盟商船补给位/);
});

/** 构造本期开放的节庆推送，只设置用例需要的子活动。 */
function festival(ctx, type) {
  const event = { activityId: '9007199254740993', type: '中秋国庆活动', openTime: fixedNow / 1000 - 10, closeTime: fixedNow / 1000 + 3600, season: 1, subActivity: [{ subActivityType: type, openTime: fixedNow / 1000 - 10, closeTime: fixedNow / 1000 + 3600 }], limitTimeItem: [] };
  ctx.pushes.set('SCAllActivity', { festivalActivities: [event] }); return event;
}

test('catcher: start reward IDs are stored and end once; orphan resumed stage safely skips', async () => {
  const f = await moduleRun('activity', { catcher: { enabled: true, play: true, maxStage: 1 } }, ({ ctx, client }) => {
    const event = festival(ctx, 7); event.limitTimeItem.push({ item: '本期_捞月钩', openTime: 1, closeTime: fixedNow / 1000 + 100 });
    table(ctx, 'MinigameMinerStageCfg', [{ stage: 1, items: ['1001,1', '2001,1'] }]); table(ctx, 'MinigameMinerItemsCfg', [{ id: 1001, hp: 1 }, { id: 2001, hp: 0 }]); client.items.set('本期_捞月钩', 1);
  }, { states: { CatcherInfoRequest: { stage: [{ stage: 1, unlockDay: 1, maxStar: 0 }] } }, handlers: { CatcherStartRequest: async (_, response, client) => { client.items.set('本期_捞月钩', 0); client.states.CatcherInfoRequest.currentStage = 1; return { rewardItem: [{ id: 11 }] }; }, CatcherEndRequest: async (_, response, client) => { client.states.CatcherInfoRequest.currentStage = 0; client.states.CatcherInfoRequest.stage[0].maxStar = 3; return { star: 3, maxStar: 3 }; } } });
  const end = f.client.calls.find(c => c.name === 'CatcherEndRequest'); assert.deepEqual(end.body.hookedRewardIds, [11]); assert.deepEqual(end.body.hookedStarIds, [2001]);
  assert.equal(f.client.calls.filter(c => c.name === 'CatcherStartRequest').length, 1);
  const g = await moduleRun('activity', { catcher: { enabled: true, play: true, maxStage: 1 } }, ({ ctx }) => { festival(ctx, 7); table(ctx, 'MinigameMinerStageCfg', [{ stage: 1, items: [] }]); }, { states: { CatcherInfoRequest: { currentStage: 1, stage: [{ stage: 1, unlockDay: 1, maxStar: 0 }] } } });
  assert.ok(g.ctx.results.some(r => /开局奖励记录/.test(r.reason))); assert.equal(g.client.calls.filter(c => c.name === 'CatcherEndRequest').length, 0);
});

test('workshop: configured recipe reserves claws and queues only up to stock target', async () => {
  const f = await moduleRun('activity', { workshop: { enabled: true, produce: true, gain: false, speedUp: false, keepStock: 1, keepClaws: 5 } }, ({ ctx, client }) => {
    const event = festival(ctx, 0); event.limitTimeItem.push(...['_捞月钩', '_爪钩'].map(suffix => ({ item: '本期' + suffix, openTime: 1, closeTime: fixedNow / 1000 + 100 })));
    table(ctx, 'BuildingCfg', [{ buildingType: '活动工厂' }]); table(ctx, 'BuildingProduceCfg', [{ buildType: '活动工厂', itemId: '本期_捞月钩', unlockLevel: 1, costItem: [['本期_爪钩', 10]] }]); table(ctx, 'BuildingProduceParamCfg', [{ paramName: '制造位上限', paramValue: 5 }]); client.items.set('本期_爪钩', 15);
  }, { states: { OnWaterRequest: { building: [{ buildingId: '1活动工厂', level: 1, factory: {} }] } }, handlers: { StartFactoryProduceRequest: async (_, response, client) => { client.items.set('本期_爪钩', 5); client.states.OnWaterRequest.building[0].factory.factoryQ = [{ idx: 1, productId: '本期_捞月钩' }]; return {}; } } });
  assert.equal(f.client.calls.filter(c => c.name === 'StartFactoryProduceRequest').length, 1);
});

test('blessing: boosts selected skin with existing knots and claims the reached tier', async () => {
  const f = await moduleRun('activity', { blessing: { enabled: true, boost: true, skinId: 1, boostTimes: 1, keepKnots: 1, claimReward: true } }, ({ ctx, client }) => {
    const event = festival(ctx, 25); event.limitTimeItem.push({ item: '本期_福运结', openTime: 1, closeTime: fixedNow / 1000 + 100 }); table(ctx, 'NationalDayCelebrateCfg', [{ skinId: 1, season: 1, stageId: 1, heartValue: 10 }]); client.items.set('本期_福运结', 2);
  }, { states: { CelebrationDetailRequest: { skin: [{ skinId: 1, curHeart: 0, claimedTier: 0 }] } }, handlers: { CelebrationBoostRequest: async (_, response, client) => { client.items.set('本期_福运结', 1); client.states.CelebrationDetailRequest.skin[0].curHeart = 10; return {}; }, ClaimCelebrationRewardRequest: async (_, response, client) => { client.states.CelebrationDetailRequest.skin[0].claimedTier = 1; return {}; } } });
  assert.equal(f.client.calls.filter(c => c.name === 'CelebrationBoostRequest').length, 1); assert.equal(f.client.calls.filter(c => c.name === 'ClaimCelebrationRewardRequest').length, 1);
});

test('week order: exact missing materials purchased within both caps then submitted once', async () => {
  const f = await moduleRun('activity', { weekOrder: { enabled: true, buyMissingMaterials: true, minRubyStock: 0 } }, ({ ctx, settings }) => {
    table(ctx, 'WeekOrderPeriodCfg', [{ periodId: 1 }]); table(ctx, 'ItemPriceCfg', [{ itemId: '木材', rubyPrice: 3 }]); Object.assign(settings.spending, { enabled: true, dailyLimit: 10 }); settings.spending.modules.activity = 6;
  }, { states: { WeekInfoRequest: { activityTime: [{ period: 1, startTime: 1, endTime: fixedNow / 1000 + 10 }] }, WeekOrderInfoRequest: { order: [{ type: 0, id: '木材', num: 2 }] } }, handlers: { CommonBuyGoodsRequest: async (_, response, client) => { client.items.set('木材', 2); client.ruby -= 6; return {}; }, FinishWeekOrderRequest: async (_, response, client) => { client.items.set('木材', 0); client.states.WeekOrderInfoRequest.order = []; return {}; } } });
  assert.equal(f.client.calls.filter(c => c.name === 'CommonBuyGoodsRequest').length, 1); assert.equal(f.client.calls.filter(c => c.name === 'FinishWeekOrderRequest').length, 1); assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 6);
});

test('snap PVP: resumed round plays legal placements and stops at settlement without a fresh match', async () => {
  const state = { mySide: protocol.SnapSide.SNAP_SIDE_A, round: { round: 1, energy: 1 }, hand: [{ uid: '10', heroId: '小布' }], zones: [{ zoneIndex: 1, unlocked: true, cardLimit: 4 }] };
  const f = await moduleRun('snap', { freeMatch: true, maxMatches: 1 }, ({ ctx }) => { table(ctx, 'CardGameParamCfg', [{ matchTime: [['12:00', '13:00']] }]); table(ctx, 'GameCardCfg', [{ heroId: '小布', cost: 1, power: 10 }]); }, { states: { SnapInfoRequest: { pvpMatch: { matchId: '1', state } } }, handlers: { SnapEndRoundRequest: async () => ({ result: { settlement: {} } }) } });
  assert.deepEqual(f.client.calls.find(c => c.name === 'SnapEndRoundRequest').body.placements, [{ cardUid: '10', zoneIndex: 1 }]); assert.equal(f.client.calls.filter(c => c.name === 'SnapStartMatchmakingRequest').length, 0);
});

test('snap diamond: current price charged once; explicit daily match count prevents another run', async () => {
  const f = await moduleRun('snap', { diamondMatch: true, diamondMatchDailyLimit: 1, maxMatches: 2 }, ({ ctx, settings }) => { table(ctx, 'CardGameParamCfg', [{ matchTimeout: 5, matchTime: [['12:00', '13:00']] }]); Object.assign(settings.spending, { enabled: true, dailyLimit: 30 }); settings.spending.modules.snap = 30; }, { states: { SnapInfoRequest: { pvpInfo: { remainFree: 0, diamondPrice: 10 } } }, handlers: { SnapStartMatchmakingRequest: async (_, response, client) => { client.ruby -= 10; return { reason: 1 }; } } });
  assert.equal(f.client.calls.filter(c => c.name === 'SnapStartMatchmakingRequest').length, 1); assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 10); assert.equal(f.ctx.count('snap.diamond'), 1);
});

test('snap cancellation: empty matchmaking queue sends no write and creates no uncertain record', async () => {
  const f = await moduleRun('snap', { cancelMatchmaking: true }, ({ ctx }) => table(ctx, 'CardGameParamCfg', [{}]), { states: { SnapInfoRequest: { pvpInfo: { matchId: '0' } } } });
  assert.equal(f.client.calls.filter(c => c.name === 'SnapCancelMatchmakingRequest').length, 0); assert.deepEqual(f.ctx.ledger.pending, {});
});

test('island: disabling a factory cancels auto production without scheduling another product', async () => {
  const f = await moduleRun('island', { collect: false, finish: false, factory: { gain: false, autoProduce: true, priorityProduce: false, disabledFactories: ['食品厂'] } }, ({ ctx }) => table(ctx, 'BuildingCfg', [{ buildingType: '食品厂' }]), { states: { OnWaterRequest: { building: [{ buildingId: '1食品厂', level: 1, factory: { autoProductId: '食品' } }] } }, handlers: { CancelFactoryAutoProduceRequest: async (_, response, client) => { client.states.OnWaterRequest.building[0].factory.autoProductId = ''; return {}; } } });
  assert.equal(f.client.calls.filter(c => c.name === 'CancelFactoryAutoProduceRequest').length, 1); assert.equal(f.client.calls.filter(c => c.name === 'StartFactoryProduceRequest').length, 0);
});

test('choice event: configured choice uses Long64 UID and confirms the event disappears', async () => {
  const f = await moduleRun('choiceEvent', { optionIndex: 2 }, ({ ctx }) => ctx.pushes.set('SCChoiceEventUpdate', { events: [{ uid: '9007199254740993' }] }), { handlers: { SelectChoiceRequest: async (_, response, client) => { client.emit('message', { name: 'SCChoiceEventUpdate', body: { events: [] } }); } } });
  assert.deepEqual(f.client.calls.find(c => c.name === 'SelectChoiceRequest').body, { uid: '9007199254740993', optionIndex: 2 }); assert.equal(f.ctx.results[0].status, 'success');
});

test('choice event: an unconfirmed UID blocks resubmission after the configured option changes', async () => {
  const f = fixture({ handlers: { SelectChoiceRequest: async () => { throw new Error('choice timeout'); } } });
  f.ctx.setModule('choiceEvent'); f.ctx.pushes.set('SCChoiceEventUpdate', { events: [{ uid: { low: 1, high: 2097152, unsigned: true } }] });
  try {
    await f.ctx.refreshStock();
    await HANDLERS.choiceEvent(f.ctx, { optionIndex: 1 });
    assert.equal(f.ctx.results[0].status, 'uncertain');
    assert.deepEqual(Object.keys(f.ctx.ledger.pending), ['SelectChoiceRequest:9007199254740993']);

    // 重新登录后改用另一侧，仍必须沿用同一 UID 锁，不能绕过未确认记录。
    const restartedPushes = new Map(f.ctx.pushes);
    // 重启后的协议读回可能把同一个 int64 UID 表示成十进制字符串，锁键仍须一致。
    restartedPushes.set('SCChoiceEventUpdate', { events: [{ uid: '9007199254740993' }] });
    const restarted = createContext({ ...f.args, stop: { aborted: false }, initialPushes: restartedPushes }); restarted.setModule('choiceEvent');
    try {
      await restarted.refreshStock();
      await HANDLERS.choiceEvent(restarted, { optionIndex: 2 });
      assert.equal(f.client.calls.filter(c => c.name === 'SelectChoiceRequest').length, 1);
      assert.equal(restarted.results[0].status, 'uncertain');
      assert.match(restarted.results[0].reason, /上次结果未确认/);
    } finally { restarted.dispose(); }
  } finally { f.ctx.dispose(); }
});

test('choice event: a fresh empty update settles the persisted UID without resubmitting', async () => {
  const f = fixture({ handlers: { SelectChoiceRequest: async () => { throw new Error('choice timeout'); } } });
  f.ctx.setModule('choiceEvent'); f.ctx.pushes.set('SCChoiceEventUpdate', { events: [{ uid: '9007199254740993' }] });
  try {
    await f.ctx.refreshStock();
    await HANDLERS.choiceEvent(f.ctx, { optionIndex: 1 });
    assert.ok(loadLedger(f.args.accountId, f.args.player.playerId).ledger.pending['SelectChoiceRequest:9007199254740993']);

    // 重登时只接受新的服务端推送作为结算证据，旧快照仍保留时不得清除 pending。
    f.client.handlers.OnWaterRequest = async (_, response, client) => {
      client.emit('message', { name: 'SCChoiceEventUpdate', body: { events: [] } });
      return {};
    };
    const restarted = createContext({ ...f.args, stop: { aborted: false }, initialPushes: new Map(f.ctx.pushes) }); restarted.setModule('choiceEvent');
    try {
      await restarted.refreshStock();
      await HANDLERS.choiceEvent(restarted, { optionIndex: 2 });
      assert.equal(f.client.calls.filter(c => c.name === 'SelectChoiceRequest').length, 1);
      assert.deepEqual(loadLedger(f.args.accountId, f.args.player.playerId).ledger.pending, {});
      assert.ok(restarted.results.some(row => row.request === 'SelectChoiceRequest' && row.verifiedByRead));
    } finally { restarted.dispose(); }
  } finally { f.ctx.dispose(); }
});

test('service: uncertain choice event isolates its module and still executes world radar', async () => {
  const fleets = [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }];
  const f = fixture({
    states: {
      RadarInfoRequest: { radarInfo: { events: [{ uid: '123', eventId: 1, state: protocol.RadarEventState.RADAR_EVENT_INIT }] } },
    },
    handlers: {
      SelectChoiceRequest: async () => { throw new Error('choice timeout'); },
      MyFleetsRequest: async () => ({ fleets: structuredClone(fleets) }),
      RadarSendFleetsRequest: async () => { fleets[0].state = protocol.FleetState.MOVING; },
    },
  });
  f.ctx.pushes.set('SCChoiceEventUpdate', { events: [{ uid: '9007199254740993' }] });
  f.settings.modules.choiceEvent.enabled = true;
  f.settings.modules.world.enabled = true;
  f.settings.modules.world.radar = { enabled: true, claim: false, kinds: ['test'], fixed: false };
  table(f.ctx, 'RadarRandEventCfg', [{ eventId: 1, type: 'test' }]);
  const initialPushes = new Map(f.ctx.pushes);
  f.ctx.dispose();
  const result = await runAutomation({ ...f.args, initialPushes, selector: 'all' });
  assert.equal(result.error, null);
  assert.equal(f.client.calls.filter(c => c.name === 'SelectChoiceRequest').length, 1);
  assert.equal(f.client.calls.filter(c => c.name === 'RadarSendFleetsRequest').length, 1);
  assert.ok(result.results.some(row => row.module === 'choiceEvent' && row.status === 'blocked'));
  assert.ok(result.results.some(row => row.module === 'world' && row.request === 'RadarSendFleetsRequest' && row.status === 'success'));
  assert.ok(result.ledger.pending['SelectChoiceRequest:9007199254740993']);
});

test('pet training: served pet levels to the configured target and no further', async () => {
  const f = await moduleRun('pet', { claim: false, levelUp: true, levelUpTargetLevel: 2 }, ({ ctx, client }) => { table(ctx, 'PetLevelCfg', [{ level: 2, playerLevel: 1, cost: ['宠物经验', 10] }]); client.items.set('宠物经验', 10); }, { states: { OnWaterRequest: { building: [{ buildingId: '1战备室', petServe: { petUid: '1' } }] }, AllPetRequest: { pets: [{ uid: '1', petId: '蓝鱼', level: 1 }] } }, handlers: { PetLevelUpRequest: async (_, response, client) => { client.states.AllPetRequest.pets[0].level = 2; client.items.set('宠物经验', 0); return {}; } } });
  assert.equal(f.client.calls.filter(c => c.name === 'PetLevelUpRequest').length, 1); assert.equal(f.ctx.results[0].status, 'success');
});

test('equipment: only selected current-season recipe with sufficient materials is crafted', async () => {
  const f = await moduleRun('equip', { make: true, makeIds: [1001] }, ({ ctx, client }) => { ctx.season = 1; table(ctx, 'BuildingEquipMakeCfg', [{ makeId: 1001, season: 1, costItem: [['蓝武器材料', 5]] }, { makeId: 1002, season: 2, costItem: [] }]); client.items.set('蓝武器材料', 5); }, { dryRun: true, states: { OnWaterRequest: { building: [{ buildingId: '1打造台', equipMaking: {} }] } } });
  assert.deepEqual(f.ctx.results.find(r => r.request === 'MakeEquipRequest').body, { buildingId: '1打造台', makeId: 1001, universal: false });
});

test('guild aid: preserves stock threshold, skips own request and helps the selected ally once', async () => {
  const aid = { receive: false, ask: false, help: true, helpItems: ['木材'], helpNicknameKeywords: ['盟友'], helpMinStock: 30, helpDailyLimit: 1 };
  const f = await moduleRun('guild', { aid }, ({ client }) => client.items.set('木材', 31), { states: { GuildInfoRequest: { guild: { guildId: '1' } }, GuildAidListRequest: { askItems: [{ reqId: '1', reqItemId: '木材', endTime: fixedNow / 1000 + 1, asker: { playerId: '9007199254740993', nickname: '盟友自己' } }, { reqId: '2', reqItemId: '木材', endTime: fixedNow / 1000 + 1, asker: { playerId: '2', nickname: '盟友' } }] }, CounterInfoRequest: { counters: [{ type: 'DAILY_GUILD_AID', num: '0' }] } }, handlers: { GuildAidHelpRequest: async (_, response, client) => { client.states.CounterInfoRequest.counters[0].num = '1'; client.items.set('木材', 30); } } });
  assert.deepEqual(f.client.calls.find(c => c.name === 'GuildAidHelpRequest').body.reqId, ['2']); assert.equal(f.ctx.results[0].status, 'success');
});

test('guild aid: confirms a silent help write when the requested aid disappears before its daily counter refreshes', async () => {
  const aid = { receive: false, ask: false, help: true, helpItems: ['木材'], helpNicknameKeywords: [], helpMinStock: 30, helpDailyLimit: 1 };
  const f = await moduleRun('guild', { aid }, ({ client }) => client.items.set('木材', 31), { states: { GuildInfoRequest: { guild: { guildId: '1' } }, GuildAidListRequest: { askItems: [{ reqId: '2', reqItemId: '木材', endTime: fixedNow / 1000 + 1, asker: { playerId: '2', nickname: '盟友' } }] }, CounterInfoRequest: { counters: [{ type: 'DAILY_GUILD_AID', num: '0' }] } }, handlers: { GuildAidHelpRequest: async (_, response, client) => { client.states.GuildAidListRequest.askItems = []; client.items.set('木材', 30); } } });
  assert.equal(f.ctx.results[0].status, 'success'); assert.deepEqual(f.ctx.ledger.pending, {});
});

test('guild aid: accepts the current role SCGuildAidHelp push as an immediate confirmation', async () => {
  const aid = { receive: false, ask: false, help: true, helpItems: ['木材'], helpNicknameKeywords: [], helpMinStock: 30, helpDailyLimit: 1 };
  const f = await moduleRun('guild', { aid }, ({ client }) => client.items.set('木材', 31), { states: { GuildInfoRequest: { guild: { guildId: '1' } }, GuildAidListRequest: { askItems: [{ reqId: '2', reqItemId: '木材', endTime: fixedNow / 1000 + 1, asker: { playerId: '2', nickname: '盟友' } }] }, CounterInfoRequest: { counters: [{ type: 'DAILY_GUILD_AID', num: '0' }] } }, handlers: { GuildAidHelpRequest: async (_, response, client) => { client.emit('message', { name: 'SCGuildAidHelp', body: { aid: { reqId: '2', helper: { playerId: '9007199254740993' } } } }); client.items.set('木材', 30); } } });
  assert.equal(f.ctx.results[0].status, 'success'); assert.deepEqual(f.ctx.ledger.pending, {});
});

test('guild aid: another member SCGuildAidHelp push cannot confirm this role action', async () => {
  const aid = { receive: false, ask: false, help: true, helpItems: ['木材'], helpNicknameKeywords: [], helpMinStock: 30, helpDailyLimit: 1 };
  const f = await moduleRun('guild', { aid }, ({ client }) => client.items.set('木材', 31), { states: { GuildInfoRequest: { guild: { guildId: '1' } }, GuildAidListRequest: { askItems: [{ reqId: '2', reqItemId: '木材', endTime: fixedNow / 1000 + 1, asker: { playerId: '2', nickname: '盟友' } }] }, CounterInfoRequest: { counters: [{ type: 'DAILY_GUILD_AID', num: '0' }] } }, handlers: { GuildAidHelpRequest: async (_, response, client) => client.emit('message', { name: 'SCGuildAidHelp', body: { aid: { reqId: '2', helper: { playerId: '3' } } } }) } });
  assert.equal(f.ctx.results[0].status, 'uncertain'); assert.equal(f.ctx.stop.aborted, true);
});

test('world ratios: releases only surplus existing fields and leaves unknown field types untouched', async () => {
  const f = await moduleRun('world', { resField: { enabled: true, factory: 1, oasis: 0, tank: 0 } }, ({ ctx }) => { ctx.season = 1; table(ctx, 'ResFieldTypeCfg', [{ season: 1, type: 1, product: ['公会科技点', 1] }, { season: 1, type: 2, product: ['种子', 1] }, { season: 1, type: 3, product: ['汽油', 1] }]); }, { dryRun: true, states: { MyResFieldsRequest: { info: { maxNum: 3, fields: [{ gridIdx: 1, type: 2 }, { gridIdx: 2, type: 99 }] } } } });
  assert.deepEqual(f.ctx.results.filter(r => r.request === 'GiveUpResFieldRequest').map(r => r.body.resFieldGridIdx), [1]);
});

test('catcher resume: persisted reward IDs are used after context restart without another hook', async () => {
  const f = fixture({ states: { CatcherInfoRequest: { currentStage: 1, stage: [{ stage: 1, unlockDay: 1, maxStar: 0 }] } } });
  const event = festival(f.ctx, 7); f.ctx.memory(`catcher.${event.activityId}.1`, [11]);
  table(f.ctx, 'MinigameMinerStageCfg', [{ stage: 1, items: [] }]); f.ctx.dispose();
  const ctx = createContext({ ...f.args, initialPushes: f.ctx.pushes }); ctx.setModule('activity');
  f.client.handlers.CatcherEndRequest = async (_, response, client) => { client.states.CatcherInfoRequest.currentStage = 0; client.states.CatcherInfoRequest.stage[0].maxStar = 3; return {}; };
  try {
    await ctx.refreshStock(); await HANDLERS.activity(ctx, { ...f.settings.modules.activity, catcher: { enabled: true, play: true, maxStage: 1 } });
    assert.deepEqual(f.client.calls.find(c => c.name === 'CatcherEndRequest').body.hookedRewardIds, [11]); assert.equal(f.client.calls.filter(c => c.name === 'CatcherStartRequest').length, 0);
  } finally { ctx.dispose(); }
});

test('factory scheduler: independent low-stock replenishment fills high watermark once across a restart', async () => {
  const f = productionFixture();
  try {
    await runProduction(f);
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 3);
    assert.equal(f.client.states.OnWaterRequest.building[0].factory.factoryQ.length, 3);
    const restarted = createContext(f.args); restarted.setModule('island');
    try { await restarted.refreshStock(); await scheduleProduction(restarted, f.settings.modules.island.factory, [], []); }
    finally { restarted.dispose(); }
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 3);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: fast materials jump waiting long output; both running lanes stay intact', async () => {
  const running = [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }, { idx: 2, productId: '长货', finishTime: fixedNow / 1000 + 7100 }];
  const f = productionFixture({ queue: [...running, { idx: 3, productId: '长货', finishTime: 0 }], slots: 6 });
  try {
    await runProduction(f, [{ id: '长货', need: 3, source: 'resident' }]);
    const queue = f.client.states.OnWaterRequest.building[0].factory.factoryQ;
    assert.deepEqual(queue.slice(0, 2), running);
    assert.deepEqual(queue.slice(2).map(job => job.productId), ['快料', '快料', '快料', '长货']);
    assert.deepEqual(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').map(call => call.body.index), [3]);
    assert.deepEqual(f.ctx.memory('factory.production').deferred, []);
    await runProduction(f, [{ id: '长货', need: 3, source: 'resident' }]);
    assert.equal(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').length, 1);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: preserve a short prefix while moving new short material ahead of the long suffix', async () => {
  const f = productionFixture({ queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 },
    { idx: 2, productId: '快料', finishTime: 0 }, { idx: 3, productId: '长货', finishTime: 0 }], slots: 5 });
  try {
    await runProduction(f);
    const queue = f.client.states.OnWaterRequest.building[0].factory.factoryQ;
    assert.deepEqual(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').map(call => call.body.index), [3]);
    assert.equal(queue[1].idx, 2);
    assert.deepEqual(queue.map(job => job.productId), ['长货', '快料', '快料', '快料', '长货']);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: no assumed material refund after canceling a waiting task', async () => {
  const f = productionFixture({ queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }, { idx: 2, productId: '长货', finishTime: 0 }],
    stock: [['木材', 1]], slots: 2, refund: false });
  try {
    await runProduction(f);
    assert.equal(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').length, 1);
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 1);
    assert.equal(f.client.items.get('木材'), 0);
    assert.equal(f.ctx.memory('factory.production').deferred.length, 1, 'unaffordable canceled work remains persisted');
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: unrelated factory changes cannot confirm a failed cancellation', async () => {
  const f = productionFixture({ queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }, { idx: 2, productId: '长货', finishTime: 0 }], slots: 2 });
  f.client.handlers.CancelFactoryProduceRequest = async () => {
    // 完成时间变化不是目标被取消的证据，目标仍然留在原制造位。
    f.client.states.OnWaterRequest.building[0].factory.factoryQ[0].finishTime--;
  };
  try {
    await runProduction(f);
    assert.equal(f.ctx.stop.aborted, true);
    assert.ok(f.ctx.results.some(row => row.request === 'CancelFactoryProduceRequest' && row.status === 'uncertain'));
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 0);
    assert.equal(f.ctx.memory('factory.production').intent.kind, 'reorder');
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: re-read protects a waiting task that starts just before cancellation', async () => {
  const f = productionFixture({ queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }, { idx: 2, productId: '长货', finishTime: 0 }], slots: 2 });
  let reads = 0;
  f.client.handlers.OnWaterRequest = async () => {
    const water = f.client.states.OnWaterRequest;
    if (++reads === 3) water.building[0].factory.factoryQ[1].finishTime = fixedNow / 1000 + 7200;
    return water;
  };
  try {
    await runProduction(f);
    assert.equal(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').length, 0);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: long guarantee is not displaced by short work on the next round', async () => {
  const f = productionFixture({ queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }], slots: 6,
    options: { priorityBurstLimit: 2, fastStockHigh: 5 } });
  const needs = [{ id: '长货', need: 2, source: 'resident' }];
  try {
    await runProduction(f, needs);
    const queue = f.client.states.OnWaterRequest.building[0].factory.factoryQ;
    assert.deepEqual(queue.slice(1).map(job => job.productId), ['快料', '快料', '快料', '快料', '长货']);
    assert.equal(f.ctx.memory('factory.production').protectedJobs['1食品厂'].productId, '长货');
    await runProduction(f, needs);
    assert.equal(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').length, 0);
    assert.equal(queue[5].productId, '长货');
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: instant output is collected and unlocks its downstream order', async () => {
  const recipes = [{ buildType: '食品厂', itemId: '快料', produceTime: 0, unlockLevel: 1, costItem: [['木材', 1]] },
    { buildType: '食品厂', itemId: '长货', produceTime: 7200, unlockLevel: 1, costItem: [['快料', 2]] }];
  const f = productionFixture({ recipes });
  try {
    await runProduction(f, [{ id: '长货', need: 1, source: 'resident' }]);
    const starts = f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').map(call => call.body.productId);
    assert.deepEqual(starts, ['快料', '快料', '快料', '快料', '快料', '长货']);
    assert.equal(f.client.items.get('快料'), 3, 'two consumed by order and three kept as shared surplus');
    assert.equal(f.client.calls.filter(call => call.name === 'GainFactoryProduceRequest').length, 5);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: preview does not cancel or persist simulated deferred jobs', async () => {
  const f = productionFixture({ dryRun: true, queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }, { idx: 2, productId: '长货', finishTime: 0 }], slots: 2 });
  try {
    await runProduction(f);
    assert.equal(f.client.calls.filter(call => /^(Cancel|Start)Factory/.test(call.name)).length, 0);
    assert.ok(f.ctx.results.some(row => row.request === 'CancelFactoryProduceRequest' && row.status === 'planned'));
    assert.deepEqual(f.ctx.memory('factory.production').deferred, []);
    assert.equal(fs.existsSync(loadLedger(f.args.accountId, f.ctx.roleId).file), false);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: takes over game auto-production once without enabling two competing schedulers', async () => {
  const f = productionFixture({ autoProductId: '长货', options: { autoProduce: true } });
  try {
    await runProduction(f);
    const writes = f.client.calls.filter(call => /^(Cancel|Set|Start)Factory/.test(call.name));
    assert.equal(writes[0].name, 'CancelFactoryAutoProduceRequest');
    assert.equal(writes.filter(call => call.name === 'CancelFactoryAutoProduceRequest').length, 1);
    assert.equal(writes.filter(call => call.name === 'SetFactoryAutoProduceRequest').length, 0);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: restart settles a confirmed cancellation and restores its saved intent exactly once', async () => {
  const f = productionFixture({ queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }], slots: 6 });
  const key = 'factory:cancel:1食品厂:2:长货';
  f.ctx.ledger.pending[key] = { token: 'pending', ruby: 0, module: 'island', date: businessDate(fixedNow) };
  f.ctx.memory('factory.production', { restocking: [], streaks: {}, deferred: [], protectedJobs: {},
    intent: { kind: 'reorder', buildingId: '1食品厂', idx: 2, productId: '长货', before: 2, token: 'canceled', key } });
  try {
    await runProduction(f, [{ id: '长货', need: 2, source: 'resident' }]);
    assert.equal(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').length, 0);
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest' && call.body.productId === '长货').length, 1);
    assert.deepEqual(f.ctx.memory('factory.production').deferred, []);
    assert.equal(f.ctx.memory('factory.production').intent, undefined);
    assert.equal(f.ctx.ledger.pending[key], undefined);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: restart confirms deferred start without duplicating it or losing the long guarantee', async () => {
  const f = productionFixture({ queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }, { idx: 101, productId: '长货', finishTime: 0 }] });
  const key = 'factory:start:1食品厂:长货';
  f.ctx.memory('factory.production', { restocking: [], streaks: {}, deferred: [{ token: 'canceled', buildingId: '1食品厂', productId: '长货' }], protectedJobs: {},
    intent: { kind: 'start', buildingId: '1食品厂', productId: '长货', before: 1, token: 'canceled', tier: 3, key, longDue: true, beforeIndexes: [1] } });
  try {
    await runProduction(f, [{ id: '长货', need: 2, source: 'resident' }]);
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest' && call.body.productId === '长货').length, 0);
    assert.equal(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').length, 0);
    assert.equal(f.ctx.memory('factory.production').protectedJobs['1食品厂'].idx, 101);
    assert.deepEqual(f.ctx.memory('factory.production').deferred, []);
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: real demand speeds only an enabled running lane once per factory', async () => {
  const queue = [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }, { idx: 2, productId: '长货', finishTime: fixedNow / 1000 + 7200 }];
  for (const disabled of [false, true]) {
    const f = productionFixture({ queue, stock: [['加速器', 3]], options: { speedUpForDemand: true, disabledFactories: disabled ? ['食品厂'] : [], fastStockLow: 0, fastStockHigh: 0 } });
    f.client.handlers.SpeedUpFactoryProduceRequest = async body => {
      f.client.states.OnWaterRequest.building[0].factory.factoryQ.find(job => job.idx === body.index).finishTime -= 60;
      f.client.items.set('加速器', f.client.items.get('加速器') - 1);
    };
    try {
      await runProduction(f, [{ id: '长货', need: 2, source: 'resident' }]);
      assert.equal(f.client.calls.filter(call => call.name === 'SpeedUpFactoryProduceRequest').length, disabled ? 0 : 1);
      assert.equal(f.client.ruby, 1000);
    } finally { f.ctx.dispose(); }
  }
});

test('factory scheduler: consecutive speed and reduction updates both participate in dynamic tier calculation', async () => {
  const f = productionFixture({ recipes: [{ buildType: '食品厂', itemId: '快料', produceTime: 1800, unlockLevel: 1, costItem: [['木材', 1]] }] });
  let reads = 0;
  f.client.handlers.OnWaterRequest = async () => {
    if (++reads === 2) {
      f.client.emit('message', { name: 'SCGameEffectUpdate', body: { effect: { id: protocol.GameEffectId.PRODUCE_SPEED_UP, value: 1 } } });
      f.client.emit('message', { name: 'SCGameEffectUpdate', body: { effect: { id: protocol.GameEffectId.PRODUCE_TIME_REDUCTION, value: 1200 } } });
    }
    return f.client.states.OnWaterRequest;
  };
  try {
    await runProduction(f);
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 3, '(1800 - 1200) / 2 is first-tier 300 seconds');
    assert.ok(f.ctx.results.filter(row => row.request === 'StartFactoryProduceRequest').every(row => row.label.startsWith('1档')));
    assert.equal(f.client.listenerCount('message'), 1, 'scheduler effect listener must be released');
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: explicit cancel rejection does not create a fictitious deferred task', async () => {
  const f = productionFixture({ queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }, { idx: 2, productId: '长货', finishTime: 0 }], slots: 2 });
  f.client.handlers.CancelFactoryProduceRequest = async () => {
    const error = new Error('target already running'); error.prompt = { args: ['target already running'] }; throw error;
  };
  try {
    await runProduction(f);
    assert.equal(f.ctx.stop.aborted, false);
    assert.deepEqual(f.ctx.memory('factory.production').deferred, []);
    assert.equal(f.ctx.memory('factory.production').intent, undefined);
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 0);
  } finally { f.ctx.dispose(); }
});

test('factory demand: queued and finished output cover demand; remaining slots fill once across rounds', async () => {
  const f = await moduleRun('island', { collect: false, finish: false }, ({ ctx, client, settings }) => {
    Object.assign(settings.modules.island.factory, { gain: false, priorityProduce: true, proposedPriority: ['resident'] });
    table(ctx, 'BuildingCfg', [{ buildingType: '食品厂' }]); table(ctx, 'BuildingProduceParamCfg', [{ paramName: '制造位上限', paramValue: 4 }]); table(ctx, 'GameParamCfg', [{ paramName: '产品存量初始上限', paramValue: 50 }]);
    table(ctx, 'BuildingProduceCfg', [{ buildType: '食品厂', itemId: '食品', unlockLevel: 1, produceTime: 7200, costItem: [['木材', 2]] }]);
    client.items.set('食品', 1); client.items.set('木材', 6);
  }, { states: { OnWaterRequest: { building: [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [{ idx: 1, productId: '食品' }], finishedProducts: [{ type: 0, id: '食品', num: '1' }] } }], workerOrder: [{ index: 1, requirements: [{ type: 0, id: '食品', num: '6' }] }] } }, handlers: {
    StartFactoryProduceRequest: async (_, response, client) => {
      const queue = client.states.OnWaterRequest.building[0].factory.factoryQ;
      queue.push({ idx: queue.length + 1, productId: '食品' }); client.items.set('木材', client.items.get('木材') - 2);
    },
  } });
  assert.equal(f.client.calls.filter(c => c.name === 'StartFactoryProduceRequest').length, 3);
  assert.equal(f.client.items.get('木材'), 0);
  const restarted = createContext(f.args); restarted.setModule('island');
  try {
    await restarted.refreshStock(); await HANDLERS.island(restarted, f.settings.modules.island);
    assert.equal(f.client.calls.filter(c => c.name === 'StartFactoryProduceRequest').length, 3);
  } finally { restarted.dispose(); }
});

/** 成品已达到服务端库存上限时，本地必须跳过排产，不能依赖 storage full 拒绝停止。 */
test('island: full product storage skips factory production before the write', async () => {
  const f = await moduleRun('island', { collect: false, finish: false }, ({ ctx, client, settings }) => {
    Object.assign(settings.modules.island.factory, { gain: false, autoProduce: true, priorityProduce: false, products: { 食品厂: '食品' } });
    table(ctx, 'BuildingCfg', [{ buildingType: '食品厂' }]);
    table(ctx, 'BuildingProduceParamCfg', [{ paramName: '制造位上限', paramValue: 1 }]);
    table(ctx, 'GameParamCfg', [{ paramName: '产品存量初始上限', paramValue: 50 }]);
    table(ctx, 'BuildingProduceCfg', [{ buildType: '食品厂', itemId: '食品', unlockLevel: 1, costItem: [['木材', 1]] }]);
    client.items.set('食品', 50); client.items.set('木材', 1);
  }, {
    states: { OnWaterRequest: { building: [{ buildingId: '1食品厂', level: 1, factory: {} }] } },
    handlers: {
      SetFactoryAutoProduceRequest: async (_, _response, client) => { client.states.OnWaterRequest.building[0].factory.autoProductId = '食品'; },
      StartFactoryProduceRequest: async () => {
        const error = new Error('server prompt: storage full');
        error.prompt = { args: ['storage full'] };
        throw error;
      },
    },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 0);
  assert.ok(f.ctx.results.some(result => result.status === 'skipped' && result.reason === '食品 产品库存已满'));
});

test('factory demand: current hero raid order joins scheduling, while an expired activity does not', async () => {
  const active = await moduleRun('island', { collect: false, finish: false }, ({ ctx, client, settings }) => {
    Object.assign(settings.modules.island.factory, { gain: false, priorityProduce: true, proposedPriority: ['resident'] });
    ctx.pushes.set('SCHeroRaidOpen', { raid: { raidId: 2001, startTime: fixedNow / 1000 - 1, finishTime: fixedNow / 1000 + 60, order: { orderId: 15 } } });
    table(ctx, 'BuildingCfg', [{ buildingType: '食品厂' }]); table(ctx, 'BuildingProduceParamCfg', [{ paramName: '制造位上限', paramValue: 2 }]); table(ctx, 'GameParamCfg', [{ paramName: '产品存量初始上限', paramValue: 50 }]);
    table(ctx, 'BuildingProduceCfg', [{ buildType: '食品厂', itemId: '食盐', unlockLevel: 1, produceTime: 7200, costItem: [['木材', 1]] }]);
    table(ctx, 'HeroRaidOrderCfg', [{ raidId: 2001, orderId: 15, orderList: [['食盐', 2]] }]);
    client.items.set('木材', 2);
  }, { states: { OnWaterRequest: { building: [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [] } }], workerOrder: [] } }, handlers: {
    StartFactoryProduceRequest: async (_, response, client) => {
      client.states.OnWaterRequest.building[0].factory.factoryQ.push({ idx: 1, productId: '食盐' });
      client.items.set('木材', client.items.get('木材') - 1);
    },
  } });
  assert.equal(active.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 2);
  assert.equal(active.client.calls.filter(call => call.name === 'HeroRaidFinishOrderRequest').length, 0);
  assert.equal(active.client.calls.some(call => call.name === 'LoginFinishRequest'), false);

  const expired = await moduleRun('island', { collect: false, finish: false }, ({ ctx, client, settings }) => {
    Object.assign(settings.modules.island.factory, { gain: false, priorityProduce: true, proposedPriority: ['resident'] });
    ctx.pushes.set('SCHeroRaidOpen', { raid: { raidId: 2001, startTime: fixedNow / 1000 - 60, finishTime: fixedNow / 1000 - 1, order: { orderId: 15 } } });
    table(ctx, 'BuildingCfg', [{ buildingType: '食品厂' }]); table(ctx, 'BuildingProduceParamCfg', [{ paramName: '制造位上限', paramValue: 2 }]); table(ctx, 'GameParamCfg', [{ paramName: '产品存量初始上限', paramValue: 50 }]);
    table(ctx, 'BuildingProduceCfg', [{ buildType: '食品厂', itemId: '食盐', unlockLevel: 1, produceTime: 7200, costItem: [['木材', 1]] }]);
    table(ctx, 'HeroRaidOrderCfg', [{ raidId: 2001, orderId: 15, orderList: [['食盐', 2]] }]);
    // 保证不是库存不足导致跳过，从而只验证活动过期守卫。
    client.items.set('食盐', 2); client.items.set('木材', 2);
  }, { states: { OnWaterRequest: { building: [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [] } }], workerOrder: [] } } });
  assert.equal(expired.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 0);
  // 即使订单物品充足，过期活动也不能向服务端提交完成订单。
  assert.equal(expired.client.calls.filter(call => call.name === 'HeroRaidFinishOrderRequest').length, 0);
});

test('hero raid: enough products finish the order and claim only the newly reached order reward', async () => {
  const f = await moduleRun('island', { collect: false, finish: false }, ({ ctx, client, settings }) => {
    Object.assign(settings.modules.island.factory, { gain: false, priorityProduce: false });
    ctx.pushes.set('SCHeroRaidOpen', { raid: { raidId: 2001, startTime: fixedNow / 1000 - 1, finishTime: fixedNow / 1000 + 60, order: { orderId: 15, gotOrderId: 14, gotTimes: 11 } } });
    table(ctx, 'HeroRaidOrderCfg', [{ raidId: 2001, orderId: 15, orderList: [['食盐', 2]] }]);
    table(ctx, 'HeroRaidOrderRewardCfg', [{ raidId: 2001, orderCount: 12 }]);
    client.items.set('食盐', 2);
  }, { states: { OnWaterRequest: { building: [], workerOrder: [] } }, handlers: {
    HeroRaidFinishOrderRequest: async (_, response, client) => {
      client.items.set('食盐', 0);
      return { order: { orderId: 16, gotOrderId: 15, gotTimes: 12 }, reward: { asset: [{ type: 0, id: '宠物1蓝基因', num: 20 }] } };
    },
    HeroRaidGotOrderRewardRequest: async () => ({ order: { orderId: 16, gotOrderId: 15, gotTimes: 12 }, reward: { asset: [{ type: 0, id: '英雄副本抽卡券', num: 1 }] } }),
  } });
  assert.deepEqual(f.client.calls.filter(call => /HeroRaid(FinishOrder|GotOrderReward)Request/.test(call.name)).map(call => call.name), ['HeroRaidFinishOrderRequest', 'HeroRaidGotOrderRewardRequest']);
  assert.deepEqual(f.client.calls.find(call => call.name === 'HeroRaidFinishOrderRequest').body, { raidId: 2001 });
  assert.deepEqual(f.client.calls.find(call => call.name === 'HeroRaidGotOrderRewardRequest').body, { raidId: 2001 });
  assert.equal(f.ctx.pushes.get('SCHeroRaidOpen').raid.order.orderId, 16);
});

test('account budget: another role shares spent and pending totals while retaining its own records', async () => {
  const f = fixture({ handlers: { TrialRaidBuySweepRequest: async () => ({}) } });
  Object.assign(f.settings.spending, { enabled: true, dailyLimit: 80 }); f.settings.spending.modules.battle = 70;
  try {
    await f.ctx.refreshStock();
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 50, confirm: async () => true })).status, 'success');
    const second = createContext({ ...f.args, player: { ...f.args.player, playerId: 'second-role' } }); second.setModule('battle');
    try {
      await second.refreshStock();
      assert.equal((await second.action('TrialRaidBuySweepRequest', { raidId: 2 }, { ruby: 21 })).status, 'skipped');
      f.client.handlers.TrialRaidBuySweepRequest = async () => { throw new Error('timeout'); };
      assert.equal((await second.action('TrialRaidBuySweepRequest', { raidId: 2 }, { ruby: 20, confirm: async () => false })).status, 'uncertain');
      assert.equal(second.ledger.days[businessDate(fixedNow)].spent, 0);
      const third = createContext({ ...f.args, player: { ...f.args.player, playerId: 'third-role' } }); third.setModule('battle');
      try { await third.refreshStock(); assert.equal((await third.action('TrialRaidBuySweepRequest', { raidId: 3 }, { ruby: 1 })).status, 'skipped'); }
      finally { third.dispose(); }
    } finally { second.dispose(); }
  } finally { f.ctx.dispose(); }
});

test('exclusive: current star caps level, selected hero advances only after cap unlocks', async () => {
  const f = await moduleRun('hero', { heroes: ['甲'], exclusiveLevelUp: true }, ({ ctx, client }) => {
    table(ctx, 'ExclusiveUpgradeCfg', [{ level: 2, heroStar: 1, cost: [['专武材料', 1]] }]); table(ctx, 'ExclusiveStarCfg', [{ star: 0, unlockLv: 1 }]); client.items.set('专武材料', 1);
  }, { states: { AllHeroRequest: { heroes: [{ heroId: '甲', star: 1, exclusive: { level: 1, star: 0 } }] } }, handlers: {
    HeroExclusiveLevelUpRequest: async (_, response, client) => { const hero = client.states.AllHeroRequest.heroes[0]; hero.exclusive.level++; client.items.set('专武材料', 0); return { nextHero: hero }; },
  } });
  assert.equal(f.client.calls.filter(c => c.name === 'HeroExclusiveLevelUpRequest').length, 0);
  table(f.ctx, 'ExclusiveStarCfg', [{ star: 0, unlockLv: 2 }]);
  const restarted = createContext(f.args); restarted.setModule('hero');
  try { await restarted.refreshStock(); await HANDLERS.hero(restarted, f.settings.modules.hero); }
  finally { restarted.dispose(); }
  assert.equal(f.client.calls.filter(c => c.name === 'HeroExclusiveLevelUpRequest').length, 1);
  assert.equal(f.client.calls.find(c => c.name === 'HeroExclusiveLevelUpRequest').response, 'HeroExclusiveNextUpResponse');
});

test('lottery: enabled reward-only mode claims progress without spending an existing ticket', async () => {
  const f = await moduleRun('activity', { weekLottery: { enabled: true, prize: false, maxDraws: 1 } }, ({ ctx, client }) => {
    ctx.pushes.set('SCAllActivity', {}); table(ctx, 'WeekLotteryPeriodCfg', [{ periodId: 7 }]); table(ctx, 'WeekLotteryTimesCfg', [{ periodId: 7, rwdId: 1, reqTimes: 2 }]); client.items.set('周转盘币', 10);
  }, { states: { WeekInfoRequest: { activityTime: [{ period: 7, startTime: fixedNow / 1000 - 1, endTime: fixedNow / 1000 + 1 }] }, WeekLotteryInfoRequest: { gotInfo: { gotStage: 0, times: 2 } } }, handlers: {
    WeekLotteryTimesRewardRequest: async (_, response, client) => { client.states.WeekLotteryInfoRequest.gotInfo.gotStage = 1; return {}; },
  } });
  assert.equal(f.client.calls.filter(c => c.name === 'WeekLotteryTimesRewardRequest').length, 1);
  assert.equal(f.client.calls.filter(c => c.name === 'WeekLotteryPrizeRequest').length, 0); assert.equal(f.client.items.get('周转盘币'), 10);
});

test('daily gameplay: enabled AFK executor preserves the accumulated threshold and excludes upgrades', async () => {
  const { runDailies } = await import('../src/dailies.mjs');
  const f = fixture({ states: { AfkInfoRequest: { afkInfo: { level: 1, afkStartTime: fixedNow / 1000 - 600, afkFinishTime: fixedNow / 1000 + 3600 } } } });
  Object.assign(f.settings.modules.afk, { enabled: true, claim: true, claimAfterHours: 24, levelUp: true });
  saveSettings(f.args.accountId, f.settings);
  const survey = { config: f.ctx.config, tasks: [{ task: { id: 1004, title: '挂机' }, status: 'ready', actions: [{ request: 'DrawAfkRewardRequest', body: {} }] }] };
  try {
    await runDailies(f.client, protocol, survey, { allowMutate: true, claimRewards: false, accountId: f.args.accountId, player: f.args.player });
    assert.equal(f.client.calls.filter(c => ['DrawAfkRewardRequest', 'UpgradeAfkLevelRequest'].includes(c.name)).length, 0);
    assert.equal(f.client.calls.filter(c => c.name === 'AfkInfoRequest').length, 1);
  } finally { f.ctx.dispose(); }
});

test('world repair: only an idle damaged fleet below its threshold repairs; speed consumes one item', async () => {
  resetRepairSpeedUpFallbackState();
  const f = await moduleRun('world', {
    fleet: { repair: true, repairThresholds: [80, 80, 0], repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20 },
    // 维修加速现在以城战规则中的明确舰队为准，此例只允许第二舰队加速。
    cityWar: { enabled: true, fleets: [{ enabled: true, buildingId: '2舰队', roles: ['attack'] }] },
  }, ({ client }) => client.items.set('加速器', 1), { states: {
    MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE, durability: 40, maxDura: 100 }, { buildingId: '2舰队', state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: fixedNow / 1000 + 60 } }, { buildingId: '3舰队', state: protocol.FleetState.IDLE, durability: 10, maxDura: 100 }] },
  }, handlers: {
    RepairFleetRequest: async ({ buildingId }, response, client) => { client.states.MyFleetsRequest.fleets.find(f => f.buildingId === buildingId).state = protocol.FleetState.REPAIRING; },
    SpeedUpRepairRequest: async ({ buildingId }, response, client) => { client.states.MyFleetsRequest.fleets.find(f => f.buildingId === buildingId).repairing.endTs = fixedNow / 1000; client.items.set('加速器', 0); },
  } });
  assert.deepEqual(f.client.calls.filter(c => c.name === 'RepairFleetRequest').map(c => c.body.buildingId), ['1舰队']);
  assert.deepEqual(f.client.calls.filter(c => c.name === 'SpeedUpRepairRequest').map(c => c.body.buildingId), ['2舰队']);
  assert.match(f.ctx.results.find(result => result.label === '维修加速结果 2舰队')?.reason ?? '', /加速器/);
});

test('world repair: short remaining time is logged and skipped before the speedup request', async () => {
  resetRepairSpeedUpFallbackState();
  const now = () => Date.parse('2026-10-29T20:00:00+08:00');
  const f = await moduleRun('world', {
    fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20, repairThresholds: [] },
    cityWar: { enabled: true, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] },
  }, null, {
    now,
    states: {
      MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: now() / 1000 + 10 } }] },
    },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'SpeedUpRepairRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.label === '维修加速检查 1舰队')?.reason ?? '', /低于门槛 20 秒/);
});

/** 道具被明确拒绝后按整分钟计价回退，61 秒应预留并结算 20 钻而不是 1 钻。 */
test('world repair: rejected accelerator retries with the full rounded-minute ruby cost', async () => {
  resetRepairSpeedUpFallbackState();
  const f = await moduleRun('world', {
    fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20, repairThresholds: [] },
    // 回退机制只验证已列入城战配置的目标舰队。
    cityWar: { enabled: true, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] },
  }, ({ client, settings }) => { client.items.set('加速器', 1); Object.assign(settings.spending, { enabled: true, dailyLimit: 20 }); settings.spending.modules.world = 20; }, { states: {
    MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: fixedNow / 1000 + 61 } }] },
  }, handlers: {
    SpeedUpRepairRequest: async ({ speedUp, buildingId }, response, client) => {
      if (speedUp.type === 2) throw Object.assign(new Error('仅支持钻石加速'), { prompt: true });
      client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === buildingId).repairing.endTs = fixedNow / 1000;
      client.ruby -= 20;
    },
  } });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'SpeedUpRepairRequest').map(call => call.body.speedUp.type), [2, 1]);
  assert.equal(f.client.ruby, 980);
  assert.equal(f.ctx.ledger.days[businessDate(fixedNow)]?.spent, 20);
  assert.equal(f.ctx.results.find(result => result.request === 'SpeedUpRepairRequest' && result.status === 'success')?.ruby, 20);
  assert.deepEqual(f.ctx.ledger.pending, {});
  assert.match(f.ctx.results.find(result => result.label === '维修加速回退 1舰队')?.reason ?? '', /服务器拒绝/);
  assert.equal(f.ctx.results.find(result => result.label === '维修加速结果 1舰队')?.status, 'success');
  resetRepairSpeedUpFallbackState();
});

/** 固定期望覆盖整分钟边界，预览与真实执行必须使用同一费用，不能先乘 10 再取整。 */
test('world repair: ruby costs ten per started minute in live and dry-run modes', async () => {
  for (const dryRun of [false, true]) {
    for (const [seconds, expectedRuby, offsetMs = 0] of [[1, 10], [59, 10], [60, 10], [61, 20], [120, 20], [121, 30], [3600, 600], [121, 20, 60000], [61, 30, -60000]]) {
      resetRepairSpeedUpFallbackState();
      const f = await moduleRun('world', {
        fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 0, repairThresholds: [] },
        cityWar: { enabled: true, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] },
      }, ({ settings, client }) => {
        Object.assign(settings.spending, { enabled: true, dailyLimit: 1000 });
        settings.spending.modules.world = 1000;
        client.serverClockOffsetMs = offsetMs;
      }, { dryRun, states: {
        MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: fixedNow / 1000 + seconds } }] },
      }, handlers: {
        SpeedUpRepairRequest: async ({ speedUp, buildingId }, _response, client) => {
          assert.deepEqual(speedUp, { type: 1, useNum: 0 });
          client.ruby -= expectedRuby;
          client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === buildingId).repairing.endTs = fixedNow / 1000;
        },
      } });
      const result = f.ctx.results.find(row => row.request === 'SpeedUpRepairRequest');
      assert.equal(result?.status, dryRun ? 'planned' : 'success', `${seconds}s, offset=${offsetMs}, dryRun=${dryRun}`);
      assert.equal(result.ruby, expectedRuby);
      assert.equal(f.ctx.ledger.days[businessDate(fixedNow)]?.spent, expectedRuby);
      assert.equal(f.ctx.ledger.days[businessDate(fixedNow)]?.modules.world, expectedRuby);
      assert.equal(f.ctx.stock.get('RUBY'), 1000 - expectedRuby);
      assert.equal(f.client.ruby, dryRun ? 1000 : 1000 - expectedRuby);
      assert.equal(f.client.calls.filter(call => call.name === 'SpeedUpRepairRequest').length, dryRun ? 0 : 1);
      assert.deepEqual(f.ctx.ledger.pending, {});
    }
  }
});

/** 无道具与拒绝后的两条钻石路径，都必须按 61 秒的完整 20 钻通过各项护栏。 */
test('world repair: full ruby cost is guarded before direct and fallback requests', async () => {
  const policies = [
    { enabled: false, dailyLimit: 100, moduleLimit: 100, minRubyStock: 0, balance: 1000, reason: /消费未开启/ },
    { enabled: true, dailyLimit: 19, moduleLimit: 100, minRubyStock: 0, balance: 1000, reason: /日额度不足/ },
    { enabled: true, dailyLimit: 100, moduleLimit: 19, minRubyStock: 0, balance: 1000, reason: /日额度不足/ },
    { enabled: true, dailyLimit: 100, moduleLimit: 100, minRubyStock: 981, balance: 1000, reason: /保留量/ },
    { enabled: true, dailyLimit: 100, moduleLimit: 100, minRubyStock: 0, balance: 19, reason: /资源不足/ },
  ];
  for (const dryRun of [false, true]) {
    // 预览不会真实尝试道具，也就不会触发拒绝回退；该模式只检查无道具的直接钻石路径。
    for (const rejectItem of dryRun ? [false] : [false, true]) {
      for (const policy of policies) {
        resetRepairSpeedUpFallbackState();
        const f = await moduleRun('world', {
          fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20, repairThresholds: [] },
          cityWar: { enabled: true, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] },
        }, ({ settings, client }) => {
          Object.assign(settings.spending, { enabled: policy.enabled, dailyLimit: policy.dailyLimit, minRubyStock: policy.minRubyStock });
          settings.spending.modules.world = policy.moduleLimit;
          client.ruby = policy.balance;
          if (rejectItem) client.items.set('加速器', 1);
        }, { dryRun, states: {
          MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.REPAIRING, repairing: { endTs: fixedNow / 1000 + 61 } }] },
        }, handlers: {
          SpeedUpRepairRequest: async () => { throw Object.assign(new Error('仅支持钻石加速'), { prompt: true }); },
        } });
        assert.equal(f.client.calls.some(call => call.name === 'SpeedUpRepairRequest' && call.body.speedUp.type === 1), false);
        const result = f.ctx.results.find(row => row.label === '钻石维修加速 1舰队');
        assert.equal(result?.status, 'skipped');
        assert.match(result.reason, policy.reason);
        assert.equal(f.client.ruby, policy.balance);
        assert.equal(f.ctx.ledger.days[businessDate(fixedNow)]?.spent ?? 0, 0);
        assert.deepEqual(f.ctx.ledger.pending, {});
      }
    }
  }
  resetRepairSpeedUpFallbackState();
});

/** 旧列表可能在处理前一支舰队时过期，计价必须紧贴提交读取该舰队的最新剩余时间。 */
test('world repair: ruby pricing refreshes the fleet before reserving its cost', async () => {
  resetRepairSpeedUpFallbackState();
  let reads = 0;
  const f = await moduleRun('world', {
    fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20, repairThresholds: [] },
    cityWar: { enabled: true, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] },
  }, ({ settings }) => {
    Object.assign(settings.spending, { enabled: true, dailyLimit: 20 });
    settings.spending.modules.world = 20;
  }, { states: {
    MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.REPAIRING, repairing: { endTs: fixedNow / 1000 + 121 } }] },
  }, handlers: {
    MyFleetsRequest: async (_body, _response, client) => {
      reads += 1;
      if (reads === 2) client.states.MyFleetsRequest.fleets[0].repairing.endTs = fixedNow / 1000 + 61;
      return structuredClone(client.states.MyFleetsRequest);
    },
    SpeedUpRepairRequest: async (_body, _response, client) => {
      client.ruby -= 20;
      client.states.MyFleetsRequest.fleets[0].repairing.endTs = fixedNow / 1000;
    },
  } });
  assert.equal(f.ctx.results.find(row => row.request === 'SpeedUpRepairRequest')?.ruby, 20);
  assert.equal(f.client.ruby, 980);
});

/** 刷新后舰队消失、维修结束或低于门槛时，不能沿用旧列表的有效时间发起扣钻。 */
test('world repair: missing, expired or short refreshed repair state prevents ruby spending', async () => {
  for (const refreshed of ['missing', 'expired', 'below-threshold']) {
    resetRepairSpeedUpFallbackState();
    let reads = 0;
    const f = await moduleRun('world', {
      fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20, repairThresholds: [] },
      cityWar: { enabled: true, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] },
    }, ({ settings }) => {
      Object.assign(settings.spending, { enabled: true, dailyLimit: 100 });
      settings.spending.modules.world = 100;
    }, { states: {
      MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.REPAIRING, repairing: { endTs: fixedNow / 1000 + 61 } }] },
    }, handlers: {
      MyFleetsRequest: async (_body, _response, client) => {
        reads += 1;
        if (reads === 2) {
          if (refreshed === 'missing') client.states.MyFleetsRequest.fleets = [];
          else client.states.MyFleetsRequest.fleets[0].repairing.endTs = fixedNow / 1000 + (refreshed === 'expired' ? 0 : 10);
        }
        return structuredClone(client.states.MyFleetsRequest);
      },
    } });
    assert.equal(f.client.calls.filter(call => call.name === 'SpeedUpRepairRequest').length, 0);
    assert.equal(f.ctx.results.find(row => row.label === '维修加速结果 1舰队')?.status, 'skipped');
    assert.equal(f.client.ruby, 1000);
    assert.deepEqual(f.ctx.ledger.pending, {});
  }
});

/** 停用已多次失败的道具路径后，仍须逐舰队计算并结算钻石费用。 */
test('world repair: three accelerator failures switch later repairs to priced ruby', async () => {
  resetRepairSpeedUpFallbackState();
  const fleets = Array.from({ length: 4 }, (_, index) => ({ buildingId: `${index + 1}舰队`, state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: fixedNow / 1000 + 60 } }));
  const f = await moduleRun('world', {
    fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20, repairThresholds: [] },
    // 此回退用例需让四支测试舰队都显式成为可维修加速的城战舰队。
    cityWar: { enabled: true, fleets: fleets.map(fleet => ({ enabled: true, buildingId: fleet.buildingId, roles: ['attack'] })) },
  }, ({ client, settings }) => { client.items.set('加速器', 4); Object.assign(settings.spending, { enabled: true, dailyLimit: 40 }); settings.spending.modules.world = 40; }, { states: { MyFleetsRequest: { fleets } }, handlers: {
    SpeedUpRepairRequest: async ({ speedUp, buildingId }, response, client) => {
      if (speedUp.type === 2) throw Object.assign(new Error('仅支持钻石加速'), { prompt: true });
      client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === buildingId).repairing.endTs = fixedNow / 1000;
      client.ruby -= 10;
    },
  } });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'SpeedUpRepairRequest').map(call => call.body.speedUp.type), [2, 1, 2, 1, 2, 1, 1]);
  assert.equal(f.client.ruby, 960);
  assert.equal(f.ctx.ledger.days[businessDate(fixedNow)]?.spent, 40);
  assert.match(f.ctx.results.find(result => result.label === '维修加速路径 4舰队')?.reason ?? '', /累计失败 3\/3/);
  assert.equal(f.ctx.results.find(result => result.label === '维修加速结果 4舰队')?.status, 'success');
  resetRepairSpeedUpFallbackState();
});

test('chip mine: current reward cap prevents dispatch; valid free slot uses the configured fleet once', async () => {
  const options = { enabled: true, hours: [], dailyCap: 1, fleets: [{ enabled: true, buildingId: '1舰队', levels: 2, emptyOnly: false }] };
  const states = { ChipMineRewardRequest: { rewardInfo: { myRewardTimes: 1 } }, MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] }, ChipMineListRequest: { chipMines: [{ gridId: 8, color: 2, occupiedNum: 1, positionNum: 2 }] }, ChipMineRequest: { positionNum: 2, occupiedPositions: [{ index: 0 }], fightTimes: 0, maxFightTimes: 1 } };
  const f = await moduleRun('world', { chipMine: options }, null, { states });
  assert.equal(f.client.calls.filter(c => c.name === 'ChipMineSendFleetRequest').length, 0);
  f.client.states.ChipMineRewardRequest.rewardInfo.myRewardTimes = 0;
  f.client.handlers.ChipMineSendFleetRequest = async (_, response, client) => { client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.MOVING; };
  const ctx = createContext(f.args); ctx.setModule('world');
  try { await ctx.refreshStock(); await HANDLERS.world(ctx, f.settings.modules.world); }
  finally { ctx.dispose(); }
  assert.deepEqual(f.client.calls.find(c => c.name === 'ChipMineSendFleetRequest').body, { gridId: 8, index: 1, fleetId: '1舰队' });
});

test('treasure: own guild is excluded and a dispatched fleet cannot be used for another target', async () => {
  const f = await moduleRun('world', { treasureLoot: { enabled: true, hours: [], fleets: [{ enabled: true, buildingId: '1舰队', levels: 2, emptyOnly: false, helpAlly: false }, { enabled: true, buildingId: '1舰队', levels: 2, emptyOnly: false, helpAlly: false }] } }, null, { states: {
    TradeInfoRequest: { worldCargo: [{ playerId: '9007199254740993', guildIdx: 3 }] }, MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] }, TreasureLootListRequest: { treasure: [{ uid: 1, color: 2, ownerGuildIdx: 3, ownerFleetNum: 1 }, { uid: 2, color: 2, ownerGuildIdx: 4, ownerFleetNum: 1 }] },
  }, handlers: { TreasureLootSendFleetsRequest: async (_, response, client) => { client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.MOVING; } } });
  assert.deepEqual(f.client.calls.filter(c => c.name === 'TreasureLootSendFleetsRequest').map(c => c.body.uid), [2]);
});

test('merchant ship: only the hourly 万吨货轮 check dispatches selected fleets and then retries on its interval', async () => {
  let now = Date.parse('2026-10-29T13:00:10+08:00');
  const ships = [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }, { buildingId: '2舰队', state: protocol.FleetState.IDLE }];
  const f = await moduleRun('world', { merchantShip: { enabled: true, retryMinutes: 5, fleets: [{ enabled: true, buildingId: '1舰队' }, { enabled: true, buildingId: '2舰队' }] } }, null, {
    now: () => now,
    states: { MyFleetsRequest: { fleets: ships }, TreasureLootListRequest: { treasure: [{ uid: 49, color: 5 }, { uid: 50, color: 4 }] } },
    handlers: { TreasureLootSendFleetsRequest: async ({ fleetBuildingIds }, _response, client) => { client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === fleetBuildingIds[0]).state = protocol.FleetState.MOVING; } },
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').map(call => call.body), [{ uid: 49, fleetBuildingIds: ['1舰队'] }, { uid: 49, fleetBuildingIds: ['2舰队'] }]);

  now += 4 * 60_000;
  for (const fleet of ships) fleet.state = protocol.FleetState.IDLE;
  const beforeRetryDispatches = f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length;
  const beforeRetryLists = f.client.calls.filter(call => call.name === 'TreasureLootListRequest').length;
  const beforeRetryCtx = createContext(f.args); beforeRetryCtx.setModule('world');
  try { await beforeRetryCtx.refreshStock(); await HANDLERS.world(beforeRetryCtx, f.settings.modules.world); }
  finally { beforeRetryCtx.dispose(); }
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, beforeRetryDispatches);
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootListRequest').length, beforeRetryLists);

  now += 60_000;
  const retryCtx = createContext(f.args); retryCtx.setModule('world');
  try { await retryCtx.refreshStock(); await HANDLERS.world(retryCtx, f.settings.modules.world); }
  finally { retryCtx.dispose(); }
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 4);

  now = Date.parse('2026-10-29T14:01:00+08:00');
  for (const fleet of ships) fleet.state = protocol.FleetState.IDLE;
  const offHourLists = f.client.calls.filter(call => call.name === 'TreasureLootListRequest').length;
  const offHourCtx = createContext(f.args); offHourCtx.setModule('world');
  try { await offHourCtx.refreshStock(); await HANDLERS.world(offHourCtx, f.settings.modules.world); }
  finally { offHourCtx.dispose(); }
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootListRequest').length, offHourLists);
});

test('merchant ship: takes configured fleets before same-round repairs can occupy them', async () => {
  const now = () => Date.parse('2026-10-29T15:00:10+08:00');
  const f = await moduleRun('world', {
    merchantShip: { enabled: true, retryMinutes: 0, fleets: [{ enabled: true, buildingId: '1舰队' }] },
    fleet: { repair: true, repairThresholds: [80], repairSpeedUp: false, repairSpeedUpMinRemainSecs: 20 },
  }, null, {
    now,
    states: {
      MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE, durability: 40, maxDura: 100 }] },
      TreasureLootListRequest: { treasure: [{ uid: 49, color: 5 }] },
    },
    handlers: { TreasureLootSendFleetsRequest: async ({ fleetBuildingIds }, _response, client) => { client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === fleetBuildingIds[0]).state = protocol.FleetState.MOVING; } },
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').map(call => call.body), [{ uid: 49, fleetBuildingIds: ['1舰队'] }]);
  assert.equal(f.client.calls.filter(call => call.name === 'RepairFleetRequest').length, 0);
});

test('merchant ship: Shanghai city-war hour reserves fleets for city-war dispatch', async () => {
  const now = () => Date.parse('2026-10-29T20:00:10+08:00');
  const f = await moduleRun('world', {
    merchantShip: { enabled: true, retryMinutes: 3, fleets: [{ enabled: true, buildingId: '1舰队' }] },
    cityWar: { enabled: true, online: false, reattack: true, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] },
  }, null, {
    now,
    states: {
      TreasureLootListRequest: { treasure: [{ uid: 49, color: 5 }] },
      WarDeclarationRequest: { startTime: now() / 1000 - 1, endTime: now() / 1000 + 60, assembleCityId: 3, declarations: [{ cityId: 9 }] },
      MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] },
    },
    handlers: {
      SetAssembleCityRequest: async ({ cityId }, _response, client) => { client.emit('message', { name: 'SCAssembleCity', body: { cityId } }); },
      MoveFleetsToCityRequest: async (_, _response, client) => { client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.MOVING; },
    },
  });
  // 城战时段不能读取或派遣商船，以免抢占城战所需的唯一闲置舰队。
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootListRequest').length, 0);
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 0);
  assert.deepEqual(f.client.calls.find(call => call.name === 'MoveFleetsToCityRequest')?.body, { buildingId: ['1舰队'], cityId: 9 });
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /城战时段保留舰队/);
});

test('city war: assembly precedes movement; an attacked city is not attacked again after restart', async () => {
  const now = () => Date.parse('2026-10-29T20:45:00+08:00');
  const f = await moduleRun('world', { cityWar: { enabled: true, online: false, reattack: false, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] } }, null, { states: {
    WarDeclarationRequest: { startTime: now() / 1000 - 1, endTime: now() / 1000 + 60, assembleCityId: 3, declarations: [{ cityId: 9 }] }, MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] },
  }, handlers: {
    SetAssembleCityRequest: async ({ cityId }, response, client) => { client.emit('message', { name: 'SCAssembleCity', body: { cityId } }); return { cityId }; },
    MoveFleetsToCityRequest: async (_, response, client) => { client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.MOVING; },
  }, now });
  const writes = f.client.calls.filter(c => ['SetAssembleCityRequest', 'MoveFleetsToCityRequest'].includes(c.name));
  assert.deepEqual(writes.map(c => c.name), ['SetAssembleCityRequest', 'MoveFleetsToCityRequest']); assert.equal(writes[1].body.cityId, 9);
  f.client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.IDLE;
  const ctx = createContext({ ...f.args, initialPushes: f.ctx.pushes }); ctx.setModule('world');
  try { await ctx.refreshStock(); await HANDLERS.world(ctx, f.settings.modules.world); }
  finally { ctx.dispose(); }
  assert.equal(f.client.calls.filter(c => c.name === 'MoveFleetsToCityRequest').length, 1);
});

test('city war: a busy preceding fleet does not block a later configured fleet', async () => {
  const now = () => Date.parse('2026-10-29T20:45:00+08:00');
  const f = await moduleRun('world', {
    cityWar: {
      enabled: true,
      online: false,
      reattack: true,
      fleets: [
        { enabled: true, buildingId: '1舰队', roles: ['attack'] },
        { enabled: true, buildingId: '2舰队', roles: ['attack'] },
      ],
    },
  }, null, {
    now,
    states: {
      WarDeclarationRequest: { startTime: now() / 1000 - 1, endTime: now() / 1000 + 60, assembleCityId: 3, declarations: [{ cityId: 9 }] },
      // 第一舰队正行军，回归用例应验证它不会阻断配置中的第二舰队出征。
      MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.MOVING }, { buildingId: '2舰队', state: protocol.FleetState.IDLE }] },
    },
    handlers: {
      SetAssembleCityRequest: async ({ cityId }, _response, client) => { client.emit('message', { name: 'SCAssembleCity', body: { cityId } }); },
      MoveFleetsToCityRequest: async ({ buildingId }, _response, client) => { client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === buildingId[0]).state = protocol.FleetState.MOVING; },
    },
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'MoveFleetsToCityRequest').map(call => call.body), [{ buildingId: ['2舰队'], cityId: 9 }]);
});

test('world repair: speedup is limited to explicitly configured city-war fleets', async () => {
  resetRepairSpeedUpFallbackState();
  const f = await moduleRun('world', {
    fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20, repairThresholds: [] },
    cityWar: {
      enabled: true,
      fleets: [
        { enabled: true, buildingId: '1舰队', roles: ['attack'] },
        { enabled: true, buildingId: '2舰队', roles: ['attack'] },
      ],
    },
  }, ({ client }) => { client.items.set('加速器', 3); }, {
    states: {
      MyFleetsRequest: {
        fleets: [
          { buildingId: '1舰队', state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: fixedNow / 1000 + 60 } },
          { buildingId: '2舰队', state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: fixedNow / 1000 + 60 } },
          { buildingId: '3舰队', state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: fixedNow / 1000 + 60 } },
        ],
      },
    },
    handlers: {
      SpeedUpRepairRequest: async ({ buildingId }, _response, client) => { client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === buildingId).repairing.endTs = fixedNow / 1000; },
    },
  });
  // 未列入城战规则的第三舰队即使正在维修，也不能触发加速请求。
  assert.deepEqual(f.client.calls.filter(call => call.name === 'SpeedUpRepairRequest').map(call => call.body.buildingId), ['1舰队', '2舰队']);
  resetRepairSpeedUpFallbackState();
});

test('city war: captured march speedup sends only buildingId after movement confirmation', async () => {
  const now = () => Date.parse('2026-10-29T20:45:00+08:00');
  const f = await moduleRun('world', {
    cityWar: { enabled: true, online: false, reattack: false, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'], marchSpeedUp: true }] },
  }, ({ settings }) => {
    Object.assign(settings.spending, { enabled: true, dailyLimit: 100 });
    settings.spending.modules.world = 100;
  }, {
    now,
    states: {
      WarDeclarationRequest: { startTime: now() / 1000 - 1, endTime: now() / 1000 + 60, assembleCityId: 3, declarations: [{ cityId: 9 }] },
      MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] },
    },
    handlers: {
      SetAssembleCityRequest: async ({ cityId }, _response, client) => { client.emit('message', { name: 'SCAssembleCity', body: { cityId } }); },
      MoveFleetsToCityRequest: async (_, _response, client) => {
        const fleet = client.states.MyFleetsRequest.fleets[0];
        fleet.state = protocol.FleetState.MOVING;
        // WorldFleet 使用抓包协议中的 moveEndTs 字段；未知的 moving 嵌套字段会被读回校验拒绝。
        fleet.moveEndTs = now() / 1000 + 60;
      },
      SpeedUpFleetRequest: async ({ buildingId }, _response, client) => {
        assert.equal(buildingId, '1舰队');
        client.states.MyFleetsRequest.fleets[0].moveEndTs = now() / 1000 + 30;
      },
    },
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'SpeedUpFleetRequest').map(call => call.body), [{ buildingId: '1舰队' }]);
  assert.equal(f.client.calls.filter(call => call.name === 'SpeedUpFleetRequest').length, 1);
  assert.equal(f.client.calls.find(call => call.name === 'SpeedUpFleetRequest') && f.ctx.results.some(result => result.request === 'SpeedUpFleetRequest' && result.status === 'success'), true);
  assert.match(f.ctx.results.find(result => result.label === '行军加速判定 1舰队')?.reason ?? '', /已确认/);
  assert.match(f.ctx.results.find(result => result.label === '行军加速结果 1舰队')?.reason ?? '', /结束时间更新/);
});

test('city war: only the fleet marked for march speedup uses diamonds', async () => {
  const now = () => Date.parse('2026-10-29T20:45:00+08:00');
  const f = await moduleRun('world', {
    cityWar: {
      enabled: true,
      online: false,
      reattack: true,
      fleets: [
        { enabled: true, buildingId: '1舰队', roles: ['attack'], marchSpeedUp: true },
        { enabled: true, buildingId: '2舰队', roles: ['attack'], marchSpeedUp: false },
      ],
    },
  }, ({ settings }) => {
    Object.assign(settings.spending, { enabled: true, dailyLimit: 100 });
    settings.spending.modules.world = 100;
  }, {
    now,
    states: {
      WarDeclarationRequest: { startTime: now() / 1000 - 1, endTime: now() / 1000 + 60, assembleCityId: 3, declarations: [{ cityId: 9 }] },
      MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }, { buildingId: '2舰队', state: protocol.FleetState.IDLE }] },
    },
    handlers: {
      SetAssembleCityRequest: async ({ cityId }, _response, client) => { client.emit('message', { name: 'SCAssembleCity', body: { cityId } }); },
      MoveFleetsToCityRequest: async ({ buildingId }, _response, client) => {
        const fleet = client.states.MyFleetsRequest.fleets.find(row => row.buildingId === buildingId[0]);
        fleet.state = protocol.FleetState.MOVING;
        fleet.moveEndTs = now() / 1000 + 60;
      },
      SpeedUpFleetRequest: async ({ buildingId }, _response, client) => { client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === buildingId).moveEndTs = now() / 1000 + 30; },
    },
  });
  // 两支舰队都能派出，但只有规则明确开启的第一支舰队会使用钻石加速。
  assert.deepEqual(f.client.calls.filter(call => call.name === 'MoveFleetsToCityRequest').map(call => call.body.buildingId), [['1舰队'], ['2舰队']]);
  assert.deepEqual(f.client.calls.filter(call => call.name === 'SpeedUpFleetRequest').map(call => call.body.buildingId), ['1舰队']);
  assert.match(f.ctx.results.find(result => result.label === '行军加速判定 2舰队')?.reason ?? '', /未开启/);
});

test('city war: online reward does not query or request outside Shanghai 20:00–21:00', async () => {
  const f = await moduleRun('world', { cityWar: { enabled: true, online: true, reattack: false, fleets: [] } }, null, { now: () => Date.parse('2026-10-29T19:59:00+08:00') });
  assert.equal(f.client.calls.filter(c => c.name === 'WarDeclarationRequest').length, 0);
  assert.equal(f.client.calls.filter(c => c.name === 'GotWorldOnlineRwdRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /20:00–21:00/);
});

test('battle pass: item id marks a free reward as already claimed', () => {
  const state = { score: 100, activePay: false, got: [{ id: 1, freeGot: true, payGot: false }] };
  const rows = [{ rwdId: 1, reqScore: 100, freeReward: [['木材', 1]], payReward: [] }];
  assert.equal(passReady(state, rows), false);
});

test('trade pass: only the current trade period may trigger a reward request', async () => {
  const f = await moduleRun('world', { trade: { enabled: true, claim: true, upgrade: false, speedUp: false } }, ({ ctx }) => {
    table(ctx, 'TradePassCfg', [
      { period: 1, rwdId: 2, reqScore: 100, freeReward: [['木材', 1]], payReward: [] },
      { period: 2, rwdId: 1, reqScore: 100, freeReward: [['木材', 1]], payReward: [] },
    ]);
  }, { states: {
    TradeInfoRequest: { period: 2, cargo: { moveEndTime: fixedNow / 1000 + 3600 } },
    BattlePassRequest: { score: 100, activePay: false, got: [{ id: 1, freeGot: true, payGot: false }] },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'BattlePassGotRewardRequest').length, 0);
});

test('trade: shares an unreported city, fills the cheapest cargo, and prioritizes the highest-margin scarcity city', async () => {
  const f = await moduleRun('world', { trade: { enabled: true, claim: false, upgrade: false, speedUp: false } }, ({ ctx }) => { table(ctx, 'TradeShipCfg', [{ lv: 1, capacity: 1000 }]); table(ctx, 'TradeGoodsCfg', [{ goodsId: 14, capacity: 1 }]); }, { states: {
    TradeInfoRequest: { cargo: { cargoLv: 1, cityId: 7 }, player: { coins: 0, goods: [{ pid: 11, goodsId: 12, num: 2, buyPrice: 1 }] } },
    TradeCityRequest: { isReport: false, goods: [{ goodsId: 12, stock: 0, price: 20 }, { goodsId: 13, stock: 0, price: 20 }, { goodsId: 14, stock: 1, price: 10 }] },
    TradeGuildRadarRequest: { radar: [{ cityId: 9, specGoodsId: 12, rareGoodsId: 13 }, { cityId: 10, specGoodsId: 13, rareGoodsId: 14 }] },
  }, handlers: {
    TradeCityReportRequest: async (_, response, client) => { client.states.TradeCityRequest.isReport = true; return {}; },
    TradeSellRequest: async (_, response, client) => { client.states.TradeInfoRequest.player.coins = 20; client.states.TradeInfoRequest.player.goods = []; return {}; },
    TradeBuyRequest: async ({ goodsId, buyNum }, response, client) => { client.states.TradeInfoRequest.player.coins -= buyNum * 10; client.states.TradeInfoRequest.player.goods = [{ pid: 14, goodsId, num: buyNum, buyPrice: 10 }, { pid: 13, goodsId: 13, num: 5, buyPrice: 10 }]; return {}; },
    TradeMoveRequest: async ({ cityId, mvToCityId }) => ({ cargo: { cityId, moveToCityId: mvToCityId, moveEndTime: fixedNow / 1000 + 3600 } }),
  } });
  const writes = f.client.calls.filter(c => ['TradeCityReportRequest', 'TradeSellRequest', 'TradeBuyRequest', 'TradeMoveRequest'].includes(c.name));
  assert.deepEqual(writes.map(c => c.name), ['TradeCityReportRequest', 'TradeSellRequest', 'TradeBuyRequest', 'TradeMoveRequest']);
  assert.deepEqual(writes[2].body, { cityId: 7, goodsId: 14, buyNum: 1 });
  assert.deepEqual(writes[3].body, { cityId: 7, mvToCityId: 9 });
});

test('trade: fallback movement excludes cities whose specialty is already in the cargo', async () => {
  const f = await moduleRun('world', { trade: { enabled: true, claim: false, upgrade: false, speedUp: false } }, ({ ctx }) => { table(ctx, 'TradeShipCfg', [{ lv: 1, capacity: 1000 }]); table(ctx, 'TradeGoodsCfg', [{ goodsId: 14, capacity: 1 }]); }, { states: {
    TradeInfoRequest: { cargo: { cargoLv: 1, cityId: 7 }, player: { coins: 0, goods: [{ pid: 1, goodsId: 12, num: 1, buyPrice: 50 }] } },
    TradeCityRequest: { isReport: true, goods: [{ goodsId: 14, stock: 1, price: 10 }] },
    TradeGuildRadarRequest: { radar: [{ cityId: 8, specGoodsId: 14, rareGoodsId: 15 }, { cityId: 9, specGoodsId: 12, rareGoodsId: 16 }, { cityId: 10, specGoodsId: 13, rareGoodsId: 17 }] },
  }, handlers: {
    TradeSellRequest: async (_, response, client) => { client.states.TradeInfoRequest.player.coins = 10; client.states.TradeInfoRequest.player.goods = []; return {}; },
    TradeBuyRequest: async ({ goodsId, buyNum }, response, client) => { client.states.TradeInfoRequest.player.goods = [{ pid: 1, goodsId, num: buyNum, buyPrice: 10 }]; return {}; },
    TradeMoveRequest: async ({ cityId, mvToCityId }) => ({ cargo: { cityId, moveToCityId: mvToCityId, moveEndTime: fixedNow / 1000 + 3600 } }),
  } });
  const move = f.client.calls.find(c => c.name === 'TradeMoveRequest');
  assert.ok([9, 10].includes(move.body.mvToCityId));
});

/** 服务器声明库存为 0 时，跳过购买而不是让 TradeBuyRequest 触发 stock not enough。 */
test('trade: empty city stock skips buying without sending TradeBuyRequest', async () => {
  const f = await moduleRun('world', { trade: { enabled: true, claim: false, upgrade: false, speedUp: false } }, null, { states: {
    TradeInfoRequest: { cargo: { cityId: 7 }, player: { coins: 0, goods: [{ pid: 11, goodsId: 12, num: 2, buyPrice: 1 }] } },
    TradeCityRequest: { isReport: true, goods: [{ goodsId: 14, stock: 0, price: 10 }] },
  }, handlers: {
    TradeSellRequest: async (_, response, client) => { client.states.TradeInfoRequest.player.coins = 20; client.states.TradeInfoRequest.player.goods = []; return {}; },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'TradeBuyRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /贸易城市没有库存商品/);
});

test('guild order and tech: daily cap stops recruitment, technology uses remaining current points', async () => {
  const f = await moduleRun('guild', { order: { enabled: true, cityIds: [3], dailyLimit: 1 }, tech: { enabled: true, items: [4] } }, ({ ctx, client }) => {
    table(ctx, 'GuildTechCfg', [{ techId: 4, season: 0, techPointCost: 10, techPointCostGrowth: 5 }]); client.items.set('公会科技点', 15); client.items.set('木材', 1);
  }, { states: {
    GuildInfoRequest: { guild: { guildId: '1' } }, GuildCityInfoRequest: { cities: [{ cityId: 3, recommended: true }] }, CounterInfoRequest: { counters: [{ type: 'DAILY_FINISH_GUILD_ORDER', num: '0' }] }, GuildOrderRequest: { order: { requirements: [{ type: 0, id: '木材', num: '1' }] } }, GuildTechInfoRequest: { tech: [{ techId: 4, level: 1 }, { techId: 5, level: 1 }] },
  }, handlers: {
    FinishGuildOrderRequest: async (_, response, client) => { client.states.CounterInfoRequest.counters[0].num = '1'; client.items.set('木材', 0); return {}; },
    UpgradeGuildTechRequest: async (_, response, client) => { client.items.set('公会科技点', 0); return {}; },
  } });
  assert.equal(f.client.calls.filter(c => c.name === 'FinishGuildOrderRequest').length, 1);
  assert.deepEqual(f.client.calls.filter(c => c.name === 'UpgradeGuildTechRequest').map(c => c.body.techId), [4]); assert.equal(f.client.items.get('公会科技点'), 0);
});

test('welfare: existing valid entitlements and free rewards claim once; expired cards are untouched', async () => {
  const f = await moduleRun('welfare', { daily: true, dailyTask: false, growth: false, events: true, email: false }, ({ ctx, client }) => {
    ctx.pushes.set('SCAllActivity', { sevenDayLogin: { day: 3, isGot: false } }); table(ctx, 'VipFreeCfg', [{ level: 1 }]);
    client.handlers.MonthCardDailyRewardRequest = async ({ type }) => { client.states.MonthCardRequest.cardItem.find(c => c.type === type).gotDailyReward = true; };
    client.handlers.SeasonCardGotDailyRequest = async () => { client.states.SeasonCardRequest.gotDaily = true; };
    client.handlers.GotFreeDailyPackRequest = async () => { client.states.DailyGiftPackRequest.drawnPack = ['赠礼']; };
    client.handlers.GotChannelRewardRequest = async () => { client.states.ChannelRewardInfoRequest.rewardInfo[0].received = true; };
    client.handlers.ComicDramaGotDailyRequest = async () => { client.states.MainTaskInfoRequest.comicDrama.gotDaily = true; };
    client.handlers.GotVipDailyRewardRequest = client.handlers.DrawNewbieLoginRewardRequest = async () => { client.items.set('木材', (client.items.get('木材') ?? 0) + 1); };
  }, { player: { vip: { vipLevel: 1 } }, states: {
    MonthCardRequest: { cardItem: [{ type: 1, endTime: fixedNow / 1000 + 1, gotDailyReward: false }, { type: 2, endTime: fixedNow / 1000 - 1, gotDailyReward: false }] }, SeasonCardRequest: { isPaid: true, gotDaily: false }, DailyGiftPackRequest: {}, ChannelRewardInfoRequest: { rewardInfo: [{ rewardId: 'a', received: false }] }, WeekUniqueLotteryRequest: { gotFree: true }, MainTaskInfoRequest: { comicDrama: { gotDaily: false, isRead: true } },
  } });
  assert.deepEqual(f.client.calls.filter(c => c.name === 'MonthCardDailyRewardRequest').map(c => c.body.type), [1]);
  const ctx = createContext({ ...f.args, initialPushes: f.ctx.pushes }); ctx.setModule('welfare');
  try { await ctx.refreshStock(); await HANDLERS.welfare(ctx, f.settings.modules.welfare); }
  finally { ctx.dispose(); }
  for (const name of ['MonthCardDailyRewardRequest', 'SeasonCardGotDailyRequest', 'GotFreeDailyPackRequest', 'GotChannelRewardRequest', 'ComicDramaGotDailyRequest', 'GotVipDailyRewardRequest', 'DrawNewbieLoginRewardRequest']) assert.equal(f.client.calls.filter(c => c.name === name).length, 1, name);
});

/** 未阅读当日漫画时只跳过领取，避免服务端返回“not read”。 */
test('welfare: unread comic drama is not claimed', async () => {
  const f = await moduleRun('welfare', { daily: true, dailyTask: false, growth: false, events: false, email: false }, null, {
    states: {
      MonthCardRequest: { cardItem: [] },
      SeasonCardRequest: { isPaid: false, gotDaily: false },
      DailyGiftPackRequest: { drawnPack: ['赠礼'] },
      ChannelRewardInfoRequest: { rewardInfo: [] },
      WeekLotteryInfoRequest: { gift: [] },
      MainTaskInfoRequest: { comicDrama: { gotDaily: false, isRead: false } },
    },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'ComicDramaGotDailyRequest').length, 0);
  assert.equal(f.client.calls.filter(call => call.name === 'WeekLotteryInfoRequest').length, 0);
});

/** 周抽奖免费礼包必须显式开启，且不依赖日奖开关。 */
test('welfare: weekly lottery free pack has an independent default-off switch', async () => {
  const f = await moduleRun('welfare', { daily: false, weeklyLottery: true, uniqueLottery: false, dailyTask: false, growth: false, events: false, email: false }, ({ ctx }) => {
    table(ctx, 'WeekLotteryPackCfg', [{ packId: 1000, price: 0, limitedTimes: 1 }]);
  }, { dryRun: true, states: { WeekLotteryInfoRequest: { gift: [{ giftId: 1000, gotTimes: 0 }] } } });
  assert.equal(f.client.calls.filter(call => call.name === 'WeekLotteryInfoRequest').length, 1);
  assert.equal(f.ctx.results.filter(result => result.request === 'WeekLotteryFreePackRequest' && result.status === 'planned').length, 1);
});

test('welfare: unique weekly lottery is independently enabled by its own switch', async () => {
  const f = await moduleRun('welfare', { daily: false, uniqueLottery: true, dailyTask: false, growth: false, events: false, email: false }, null, { states: {
    WeekUniqueLotteryRequest: { gotFree: false },
  }, handlers: {
    GotUniqueLotteryFreeRequest: async (_, response, client) => { client.items.set('木材', 1); return response ? {} : undefined; },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'WeekUniqueLotteryRequest').length, 1);
  assert.equal(f.client.calls.filter(call => call.name === 'GotUniqueLotteryFreeRequest').length, 1);
});

test('farm priority: an order crop wins over a higher-priority ordinary stock target', async () => {
  const f = await moduleRun('farm', { harvest: false, plant: true, priorityPlant: true, cropPriorities: { 甲: 1, 乙: 2 }, cropKeepStock: { 甲: 10 } }, ({ ctx, client }) => {
    table(ctx, 'FarmlandPlantCfg', [{ id: '甲', material: ['种子', 1], produceNum: 1 }, { id: '乙', material: ['种子', 1], produceNum: 1 }]); client.items.set('种子', 1);
  }, { dryRun: true, states: { OnWaterRequest: { building: [{ buildingId: '1农田', farm: {} }], workerOrder: [{ index: 1, requirements: [{ type: 0, id: '乙', num: '1' }] }] } } });
  assert.equal(f.ctx.results.find(r => r.request === 'FarmPlantRequest').body.args[0].productId, '乙');
});

test('farm seed demand: multiple empty plots do not queue duplicate seeds for a one-crop shortage', async () => {
  const f = await moduleRun('farm', { harvest: false, plant: true, seedOnDemand: true, cropPriorities: { 玉米: 1 }, cropKeepStock: { 玉米: 1 } }, ({ ctx, client }) => {
    table(ctx, 'FarmlandPlantCfg', [{ id: '玉米', material: ['玉米种子', 1], produceNum: 1 }]); table(ctx, 'BuildingCfg', [{ buildingType: '种子厂' }]);
    table(ctx, 'BuildingProduceParamCfg', [{ paramName: '制造位上限', paramValue: 2 }]); table(ctx, 'BuildingProduceCfg', [{ buildType: '种子厂', itemId: '玉米种子', unlockLevel: 1, costItem: [['木材', 1]] }]); client.items.set('木材', 3);
  }, { states: { OnWaterRequest: { building: [{ buildingId: '1种子厂', level: 1, factory: {} }, ...[1, 2, 3].map(i => ({ buildingId: i + '农田', farm: {} }))] } }, handlers: {
    StartFactoryProduceRequest: async (_, response, client) => { client.states.OnWaterRequest.building[0].factory.factoryQ = [{ productId: '玉米种子', idx: 1 }]; client.items.set('木材', 2); },
  } });
  assert.equal(f.client.calls.filter(c => c.name === 'StartFactoryProduceRequest').length, 1);
  assert.equal(f.client.calls.filter(c => c.name === 'FarmPlantRequest').length, 0);
});

test('legacy factory: manual and old-loop scheduling respect an enabled module factory exclusion', async () => {
  const { legacyAction } = await import('../src/automation/service.mjs');
  const f = fixture(); f.settings.modules.island.enabled = true; f.settings.modules.island.factory.disabledFactories = ['食品厂'];
  table(f.ctx, 'BuildingCfg', [{ buildingType: '食品厂' }]);
  try {
    await assert.rejects(() => legacyAction(f.ctx, { request: 'StartFactoryProduceRequest', body: { buildingId: '1食品厂', productId: '食品' } }), /禁用/);
    assert.equal(f.client.calls.length, 0);
  } finally { f.ctx.dispose(); }
});
