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
const { defaultSettings, saveSettings, loadSettings, businessDate, loadLedger, validateSettings, accountDirectory, writeJson } = await import('../src/automation/settings.mjs');
const { createContext, idString, validateMessage, withRoleLock } = await import('../src/automation/context.mjs');
const { runAutomation, HANDLERS, handledDailyIds, guardedDailyAction, legacyAction, runPriorityDiscountShop, automationStatus } = await import('../src/automation/service.mjs');
const { resetRepairSpeedUpFallbackState } = await import('../src/automation/world.mjs');
const { pirateDailySweepLimit, pirateSweepProgress } = await import('../src/pirates.mjs');
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

test('ledger persistence retries a transient Windows EPERM rename and removes its temporary file', (t) => {
  const file = path.join(directory, `rename-retry-${++sequence}.json`);
  const originalRename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    attempts++;
    if (attempts < 3) {
      const error = new Error('目标文件暂时被占用');
      error.code = 'EPERM';
      throw error;
    }
    return originalRename.call(fs, source, destination);
  });

  // 防病毒或同步程序短暂锁住目标文件时，账本必须最终落盘，且不能遗留下一轮会误用的临时文件。
  writeJson(file, { persisted: true });

  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { persisted: true });
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp')), []);
});

test('ledger persistence reports a persistent Windows EPERM rename after bounded retries', (t) => {
  const file = path.join(directory, `rename-persistent-${++sequence}.json`);
  const locked = new Error('目标文件持续被占用');
  locked.code = 'EPERM';
  let attempts = 0;
  t.mock.method(fs, 'renameSync', () => {
    attempts++;
    throw locked;
  });

  // 超过短暂占用窗口仍无法替换时，必须中止自动化，避免以内存状态继续执行并重复消耗资源。
  assert.throws(() => writeJson(file, { persisted: false }), error => error === locked);

  assert.equal(attempts, 5);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp')), []);
});

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
  f.settings.modules[id].enabled = ['pet', 'equip'].includes(id) ? 'always' : true; f.ctx.setModule(id);
  try { await setup?.(f); await f.ctx.refreshStock(); await HANDLERS[id](f.ctx, f.settings.modules[id]); return f; }
  finally { f.ctx.dispose(); }
}

/** 构造保持服务端榜单顺序的积分赛对手，测试不得借总战力排序掩盖位置优先级。 */
function leagueRival(playerId, power) {
  return { playerId, nickname: `对手${playerId}`, score: 1000, power };
}

/** 将两支舰队战力转换为 LeagueOtherFormationResponse 可验证的最小阵容。 */
function leagueFormation([first, second]) {
  return [{ power: first }, { power: second }];
}

/**
 * 建立离线积分赛场景：读取、换位和战斗都经真实 Protobuf 往返，绝不连接游戏账号。
 *
 * @param {{initial: Array<object>, refreshed?: Array<object>, refreshTimes?: number, minePower?: number, formations: Record<string, [number, number]>, fights?: Array<{records: Array<{isLWin: boolean}>, finalScore?: number}>, maxActions?: number}} options 固定的榜单、阵容和战果。
 * @returns {Promise<ReturnType<typeof fixture>>} 已跑完 battle 模块的离线上下文。
 */
async function leagueRun({ initial, refreshed = [], refreshTimes = 1, minePower = 1000, formations, fights = [], maxActions = 1 }) {
  const mineId = '9007199254740993';
  const copiedFormations = new Map(Object.entries(formations).map(([id, powers]) => [id, leagueFormation(powers)]));
  // 真实我方协议只带英雄站位；每队放两名英雄，确保实现必须累加英雄战力而非读取虚构的 formation.power。
  const heroes = [];
  let ownFormations = (formations[mineId] ?? []).map((power, index) => {
    const heroPositions = [0, 1].map(part => {
      const heroId = `我方${index + 1}队英雄${part + 1}`;
      heroes.push({ heroId, power: part === 0 ? Math.floor(power / 2) : power - Math.floor(power / 2) });
      return { heroId, pos: { x: part, y: 0 } };
    });
    return { index: index + 1, presetId: 1, heroPositions };
  });
  return moduleRun('battle', {
    maxActions,
    league: { challenge: true, reservePoints: 0, hangupReward: false, danReward: false, passReward: false },
  }, null, {
    player: { playerId: mineId },
    handlers: {
      LeagueInfoRequest: async () => ({ mine: { playerId: mineId, power: minePower }, ownFormations }),
      AllHeroRequest: async () => ({ heroes }),
      // 挑战券和钻石都由服务端资源快照给出，刷新后可断言免费操作没有改变钻石余额。
      AllResourceRequest: async () => ({ list: [{ res: protocol.Resource.LEAGUE_POINT, amount: 3 }, { res: protocol.Resource.RUBY, amount: 1000 }] }),
      LeagueRefreshRivalRequest: async ({ isRefresh }) => isRefresh
        ? { rivals: refreshed, refreshTimes: refreshTimes + 1 }
        : { rivals: initial, refreshTimes },
      LeagueOtherFormationRequest: async ({ playerId }) => {
        // 对自己调用“其他玩家阵容”接口会被真实服务器拒绝；测试必须同样拒绝，防止旧错误回归。
        assert.notEqual(idString(playerId), mineId, 'self formation must come from LeagueInfoRequest');
        return { formation: copiedFormations.get(idString(playerId)) ?? [] };
      },
      LeagueFormationSequenceRequest: async ({ index }) => {
        assert.deepEqual(index, [2, 1]);
        // 服务端换位是持久化位置变更；后续阵容读回必须反映新顺序。
        ownFormations = [...ownFormations].reverse().map((formation, index) => ({ ...formation, index: index + 1 }));
        return {};
      },
      LeagueFightRequest: async ({ playerId }) => {
        const fight = fights.shift();
        assert.ok(fight, 'only an explicitly arranged candidate may be challenged');
        return {
          lPlayer: { playerId: mineId, score: 1000, finalScore: fight.finalScore ?? 1000 },
          rPlayer: { playerId: idString(playerId), score: 1000, finalScore: 1000 },
          records: fight.records,
        };
      },
    },
  });
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
  assert.ok(Object.entries(settings.modules).every(([id, row]) => ['pet', 'equip'].includes(id) ? row.enabled === 'off' : !row.enabled));
  assert.equal(settings.spending.enabled, false);
  assert.equal(settings.spending.dailiesDiscountTickets2x, false);
  assert.equal(settings.spending.clickGoldTimes, 0);
  assert.equal(settings.vipFreeAd, false);
  assert.equal(settings.modules.welfare.weeklyLottery, false);
  assert.equal(settings.modules.welfare.uniqueLottery, false);
  assert.equal(settings.modules.world.merchantShip.enabled, false);
  assert.deepEqual(settings.modules.world.merchantShip.rewardMaterials, []);
  assert.equal(settings.modules.world.pirate.dailySweepLimit, 10);
  assert.deepEqual(settings.modules.world.pirate.sweepTypes, []);
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
  const clickGoldSettings = defaultSettings();
  clickGoldSettings.spending.clickGoldTimes = 3;
  assert.equal(validateSettings(clickGoldSettings).spending.clickGoldTimes, 3);
  clickGoldSettings.spending.clickGoldTimes = 1.5; assert.throws(() => validateSettings(clickGoldSettings), /非负数/);
  clickGoldSettings.spending.clickGoldTimes = -1; assert.throws(() => validateSettings(clickGoldSettings), /非负数/);
  delete clickGoldSettings.spending.clickGoldTimes;
  assert.equal(validateSettings(clickGoldSettings).spending.clickGoldTimes, 0);
  delete clickGoldSettings.spending.dailiesDiscountTickets2x;
  assert.equal(validateSettings(clickGoldSettings).spending.dailiesDiscountTickets2x, false);
  const merchantMaterialSettings = defaultSettings();
  merchantMaterialSettings.modules.world.merchantShip.rewardMaterials = ['精铁'];
  assert.deepEqual(validateSettings(merchantMaterialSettings).modules.world.merchantShip.rewardMaterials, ['精铁']);
  delete merchantMaterialSettings.modules.world.merchantShip.rewardMaterials;
  assert.deepEqual(validateSettings(merchantMaterialSettings).modules.world.merchantShip.rewardMaterials, []);
  merchantMaterialSettings.modules.world.merchantShip.rewardMaterials = [1];
  assert.throws(() => validateSettings(merchantMaterialSettings), /非空字符串数组/);
  settings.modules.hero.heroes = [1]; assert.throws(() => validateSettings(settings), /字符串/);
  settings.modules.hero.heroes = []; settings.modules.world.chipMine.hours = [24]; assert.throws(() => validateSettings(settings), /整数/);
  settings.modules.world.chipMine.hours = []; settings.modules.world.pirate.attackTime.start = '25:00'; assert.throws(() => validateSettings(settings), /HH/);
  settings.modules.world.pirate.attackTime.start = '00:00'; settings.modules.farm.cropKeepStock = { 玉米: -1 }; assert.throws(() => validateSettings(settings), /非负/);
  settings.modules.farm.cropKeepStock = {};
  settings.modules.world.pirate.dailySweepLimit = 5;
  settings.modules.world.pirate.sweepTypes = [{ type: 1, times: 3 }, { type: 2, times: 2 }];
  assert.deepEqual(validateSettings(settings).modules.world.pirate.sweepTypes, [{ type: 1, times: 3 }, { type: 2, times: 2 }]);
  settings.modules.world.pirate.sweepTypes = [{ type: 1, times: 4 }, { type: 1, times: 1 }]; assert.throws(() => validateSettings(settings), /不能重复/);
  settings.modules.world.pirate.sweepTypes = [{ type: 1, times: 0 }]; assert.throws(() => validateSettings(settings), /正整数/);
  settings.modules.world.pirate.sweepTypes = [{ type: 1, times: 4 }]; assert.throws(() => validateSettings(settings), /之和必须等于/);
  settings.modules.world.pirate.sweepTypes = [{ type: 1, times: 5 }]; assert.throws(() => validateSettings(settings, { pirateDailyLimit: 4 }), /不能超过当前角色上限/);
  assert.throws(() => validateSettings(JSON.parse('{"__proto__":{}}')), /禁止/);
});

/** 旧海盗类型 ID 数组首次读取时一次性升级，保留缺少目标时的每类一次与已保存目标。 */
test('settings: migrates legacy pirate sweep type IDs without widening an implicit target', () => {
  const implicitTarget = defaultSettings();
  delete implicitTarget.modules.world.pirate.dailySweepLimit;
  implicitTarget.modules.world.pirate.sweepTypes = [1, 2, 3];
  writeJson(path.join(accountDirectory('legacy-pirate-implicit'), 'settings.json'), implicitTarget);
  assert.deepEqual(loadSettings('legacy-pirate-implicit').modules.world.pirate, {
    ...defaultSettings().modules.world.pirate,
    sweepTypes: [{ type: 1, times: 1 }, { type: 2, times: 1 }, { type: 3, times: 1 }],
    dailySweepLimit: 3,
  });

  const savedTarget = defaultSettings();
  savedTarget.modules.world.pirate.dailySweepLimit = 5;
  savedTarget.modules.world.pirate.sweepTypes = [1, 2, 3];
  writeJson(path.join(accountDirectory('legacy-pirate-target'), 'settings.json'), savedTarget);
  assert.deepEqual(loadSettings('legacy-pirate-target').modules.world.pirate.sweepTypes, [{ type: 1, times: 2 }, { type: 2, times: 2 }, { type: 3, times: 1 }]);
  const persisted = JSON.parse(fs.readFileSync(path.join(accountDirectory('legacy-pirate-target'), 'settings.json'), 'utf8'));
  assert.deepEqual(persisted.modules.world.pirate.sweepTypes, [{ type: 1, times: 2 }, { type: 2, times: 2 }, { type: 3, times: 1 }]);
});

test('automation UI: merchant ship uses form controls instead of a fleet JSON textarea', () => {
  assert.match(PAGE, /data-merchant-ship-fleet/);
  assert.match(PAGE, /添加舰队/);
  assert.match(PAGE, /奖励材料筛选/);
  assert.match(AUTOMATION_SCRIPT, /primitiveArrayEditor\(value\.rewardMaterials, 'rewardMaterials'/);
  assert.doesNotMatch(PAGE, /奖励材料名称/);
  assert.match(PAGE, /请填写每支已勾选商船舰队的建筑 ID/);
  assert.doesNotMatch(PAGE, /merchantShip.*舰队规则（JSON 数组）/);
});

/** 海盗设置使用每日目标前置、对象数组分配和每行次数输入。 */
test('automation UI: pirate sweep exposes per-type counts before saving', () => {
  assert.match(AUTOMATION_SCRIPT, /dailySweepLimit:'每日扫荡次数（目标）'/);
  assert.match(AUTOMATION_SCRIPT, /function pirateSweepEditor\(value, settingPath, dailyInput\)/);
  assert.match(AUTOMATION_SCRIPT, /sweepTypes:'为每种已击败海盗设置明确扫荡次数/);
  assert.match(AUTOMATION_SCRIPT, /海盗类型次数合计/);
  assert.match(AUTOMATION_SCRIPT, /daily\.input\.max/);
  assert.match(AUTOMATION_SCRIPT, /pirateDailySweepMax !== null/);
});

/** 海盗次数输入仅容纳小整数，不能被通用行内输入框样式拉伸。 */
test('automation UI: pirate sweep count input remains compact', () => {
  assert.match(AUTOMATION_SCRIPT, /automation-pirate-sweep-times/);
  assert.match(PAGE, /\.automation-editor-row input\.automation-pirate-sweep-times\[type=number\] \{ flex:0 0 72px; width:72px; \}/);
});

/** 长设置表单在改动后提供固定保存入口，并允许用户不依赖浏览器工具栏返回顶部。 */
test('automation UI: dirty settings expose quick save and back-to-top controls', () => {
  assert.match(PAGE, /id="automation-floating-save"[^>]+hidden>保存设置/);
  assert.match(PAGE, /id="automation-back-to-top"[^>]+hidden>[\s\S]*回到顶部/);
  assert.match(AUTOMATION_SCRIPT, /function updateAutomationBackToTop\(\)[\s\S]*automationSettingsDirty/);
  assert.match(AUTOMATION_SCRIPT, /function scrollAutomationToTop\(\)[\s\S]*prefers-reduced-motion/);
  assert.match(AUTOMATION_SCRIPT, /automation-floating-save'\)\.onclick = saveAutomationSettings/);
});

/** 自动化候选项、已选项与原生下拉框必须跟随控制台浅色主题。 */
test('automation UI: choice editor uses the shared light control style', () => {
  assert.match(PAGE, /\.automation-editor \{[^}]*background:#f8fbfa[^}]*color-scheme:light/s);
  assert.match(PAGE, /\.automation-choice \{[^}]*background:#fff[^}]*color:#2c5054/s);
  assert.match(PAGE, /\.automation-choice\.on \{[^}]*background:#e3f3ee/s);
  assert.match(PAGE, /\.automation-editor select option \{[^}]*background:#fff[^}]*color:#29494e/s);
  assert.doesNotMatch(PAGE, /\.automation-editor \{[^}]*background:#15191f/s);
});

test('automation UI: diamond copy distinguishes balance protection from daily allowances', () => {
  assert.match(AUTOMATION_SCRIPT, /当前角色游戏内钻石余额的下限，不是每日可用额度/);
  assert.match(AUTOMATION_SCRIPT, /10000 会按原值保存/);
  assert.match(AUTOMATION_SCRIPT, /同一账号所有角色每日合计的消费上限/);
  assert.match(AUTOMATION_SCRIPT, /2折英雄藏品券/);
  assert.match(AUTOMATION_SCRIPT, /强烈建议开启/);
  assert.match(AUTOMATION_SCRIPT, /突破钻石购买上限/);
  assert.match(AUTOMATION_SCRIPT, /path\.join\('\.'\) === 'spending' && key === 'modules'/);
});

/** 点金金额由设置接口的实时配置提供，输入变更只更新本地估算，不创建另一条保存逻辑。 */
test('automation UI: click-gold target presents its config price and live diamond estimate', () => {
  assert.match(AUTOMATION_SCRIPT, /function clickGoldTimesField\(value, path\)/);
  assert.match(AUTOMATION_SCRIPT, /clickGoldEstimate\(input\.value, automationClickGoldUnitPrice\)/);
  assert.match(PAGE, /automation-click-gold-estimate/);
  const context = automationFormContext();
  assert.equal(vm.runInContext('clickGoldEstimate("3", 50)', context), '每次 50 钻石 · 预计消耗：3 × 50 = 150 钻石');
  assert.equal(vm.runInContext('clickGoldEstimate("1.5", 50)', context), '请输入有效的非负整数次数');
  assert.equal(vm.runInContext('clickGoldEstimate("3", null)', context), '暂时无法读取每次点金价格');
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
    // 所有模块额度都要交代消费用途，避免“挂机额度为 0”时用户无法找到点金被阻止的原因。
    if (path[0] === 'spending' && path[1] === 'modules') {
      assert.match(copy.note, /应用场景：.+功能：/, `${path.join('.')} must list its spending scenes`);
      assert.doesNotMatch(copy.note, /undefined/);
    }
  }
  for (const [key, note] of Object.entries(ruleCopy)) {
    assert.match(note, /功能：.+影响范围：/, `${key} rule must explain functionality and scope`);
  }
  assert.match(settingCopy(['spending', 'modules', 'afk'], 'afk').note, /应用场景：钻石点金/);
  assert.match(settingCopy(['spending', 'modules', 'battle'], 'battle').note, /英雄经验、强化石、宠物经验.*钻石扫荡/);
  assert.match(settingCopy(['spending', 'modules', 'world'], 'world').note, /维修加速.*行军加速.*贸易船升级/);
});

test('automation UI: merchant ship and trade render as separate world activity groups', () => {
  assert.match(AUTOMATION_SCRIPT, /function merchantShipFields\(value, path\)/);
  assert.match(AUTOMATION_SCRIPT, /function tradeFields\(value, path\)/);
  assert.match(AUTOMATION_SCRIPT, /function worldActivityGroup\(copy, fields\)/);
  assert.match(AUTOMATION_SCRIPT, /group\.appendChild\(el\('summary', null, copy\.title\)\)/);
  assert.match(AUTOMATION_SCRIPT, /pathName === 'modules\.world\.merchantShip'.*worldActivityGroup/s);
  assert.match(AUTOMATION_SCRIPT, /pathName === 'modules\.world\.trade'.*worldActivityGroup/s);
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

/** 总览摘要只识别 color=5 的万吨货轮，并保留今日次数、UID 和奖励资产。 */
test('overview summary: merchant ship keeps reward count and current target', () => {
  const view = summarize({ ok: {
    TreasureLootStatsRequest: { todayRewardTimes: 2 },
    TreasureLootListRequest: {
      treasure: [
        { uid: 7, color: 4, reward: { asset: [{ type: 0, id: '普通宝箱', num: 1 }] } },
        { uid: 8, color: 5, reward: { asset: [{ type: 0, id: '高级宝箱', num: 3 }] } },
      ],
    },
  } });
  assert.deepEqual(view.merchantShip, {
    remainingRewardTimes: 2,
    uid: 8,
    reward: [{ type: 0, id: '高级宝箱', num: 3 }],
  });
});

/** 没有 color=5 目标时，总览仍保留次数并明确为空目标。 */
test('overview summary: merchant ship is absent without color five target', () => {
  const view = summarize({ ok: {
    TreasureLootStatsRequest: { todayRewardTimes: 1 },
    TreasureLootListRequest: { treasure: [{ uid: 9, color: 4 }] },
  } });
  assert.deepEqual(view.merchantShip, { remainingRewardTimes: 1, uid: null, reward: [] });
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
      states: { TradeInfoRequest: { period: 1, cargo: { moveEndTime: fixedNow / 1000 + 600 }, player: { profit } } },
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

/** 总览只在服务端确认海商王活动开放时显示对应卡片。 */
test('overview: trade panel hides when the trade activity is unavailable', () => {
  assert.match(PAGE, /function renderOverviewTrade\(data\)/);
  assert.match(PAGE, /const tradeOpen = Number\(trade\.period\) > 0;/);
  assert.match(PAGE, /card\.hidden = !tradeOpen;/);
  assert.match(PAGE, /if \(!tradeOpen\) \{\s*clear\(card\);\s*return;\s*\}/);
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

/** 桌面总览将中间业务卡置于瀑布流，避免高度较高的状态区拉伸主力英雄卡。 */
test('overview: intermediate panels use an adaptive masonry layout', () => {
  assert.match(PAGE, /class="overview-layout"/);
  assert.match(PAGE, /class="overview-masonry"/);
  assert.match(PAGE, /column-count:2/);
  assert.match(PAGE, /break-inside:avoid/);
  assert.doesNotMatch(PAGE, /overview-grid|overview-status-grid|wide: true/);
});

/** 运行真实页面脚本的纯转换函数；用最小窗口桩承接固定入口初始化，不创建浏览器或游戏连接。 */
function automationFormContext() {
  const element = { hidden: false, classList: { contains: () => false } };
  const context = vm.createContext({
    $: () => element, setInterval: () => {}, structuredClone,
    // 浮动保存和回顶入口在脚本初始化时注册，测试只需提供不会触发真实滚动的页面能力。
    window: { scrollY: 0, addEventListener: () => {}, matchMedia: () => ({ matches: false }), scrollTo: () => {} },
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
    ResourceCfg:[{ id:'GOLD', show_name:'金币' }],
    BuildingUnlockCfg:[{ buildingType:'远征船', buildingId:'2远征船' }],
    GuildTechCfg:[{ techId:10201, name:'生产效率', season:2 }],
    '2_CityCfg':[{ id:3, name:'净水城' }],
  }).map(([name, data]) => [name, { data }])) };
  const options = automationFormOptions(config);
  assert.deepEqual(options.factories, [{ value:'服装厂', label:'服装作坊' }]);
  assert.deepEqual(options.products, [{ value:'衣服', label:'休闲衣服', factory:'服装厂' }]);
  assert.deepEqual(options.fleets, [{ value:'2远征船', label:'2号远征舰队' }]);
  assert.deepEqual(options.rewardMaterials, [{ value:'衣服', label:'休闲衣服' }]);
  assert.deepEqual(options.cities[2], [{ value:3, label:'净水城' }]);
  assert.deepEqual(options.tech, [{ value:10201, label:'生产效率', season:2 }]);
  assert.deepEqual(automationFormOptions(null).fleets, []);
  const context = automationFormContext();
  context.formOptions = options;
  vm.runInContext('automationOptions = formOptions;', context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(editorChoices("items"))', context)), options.tech);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(editorChoices("rewardMaterials"))', context)), options.rewardMaterials);
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

/** 已确认的未决写入必须只读结算，不得因重启后的幂等保护永久停止整个挂机循环。 */
test('uncertain: restarted confirmation settles the original reservation without resubmission', async () => {
  const f = fixture({ handlers: { TrialRaidBuySweepRequest: async () => { throw new Error('timeout'); } } });
  Object.assign(f.settings.spending, { enabled: true, dailyLimit: 100 }); f.settings.spending.modules.battle = 100;
  try {
    await f.ctx.refreshStock();
    assert.equal((await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 25, confirm: async () => false })).status, 'uncertain');
    f.ctx.dispose();
    f.ctx = createContext({ ...f.args, stop: { aborted: false } }); f.ctx.setModule('battle');
    const settled = await f.ctx.action('TrialRaidBuySweepRequest', { raidId: 1 }, { ruby: 25, confirm: async () => true });
    assert.equal(settled.status, 'success');
    assert.equal(settled.verifiedByRead, true);
    assert.equal(f.ctx.stop.aborted, false);
    assert.deepEqual(f.ctx.ledger.pending, {});
    assert.equal(f.client.calls.filter(c => c.name === 'TrialRaidBuySweepRequest').length, 1);
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

/** 已写入但超时的种植需由当前地块状态结算，避免下一轮把相同请求视作重复提交并停止自动化。 */
test('farm: planted field settles a pending plant request before duplicate protection runs', async () => {
  const f = fixture({ states: { OnWaterRequest: { building: [{ buildingId: '1农田', farm: { productId: '玉米' } }] } } });
  f.settings.modules.farm.enabled = true;
  f.settings.modules.farm.plant = true;
  f.settings.modules.farm.cropPriorities = { 玉米: 1 };
  f.settings.modules.farm.cropKeepStock = { 玉米: 5 };
  table(f.ctx, 'FarmlandPlantCfg', [{ id: '玉米', material: ['种子', 1], produceNum: 5 }]);
  const key = 'FarmPlantRequest:{"args":[{"buildingId":"1农田","productId":"玉米"}]}';
  f.ctx.ledger.pending[key] = { token: 'pending-plant', ruby: 0, module: 'farm', date: businessDate(f.args.now()) };
  writeJson(loadLedger(f.args.accountId, f.args.player.playerId).file, f.ctx.ledger);
  f.ctx.dispose();
  f.ctx = createContext(f.args); f.ctx.setModule('farm');
  try {
    await f.ctx.refreshStock();
    await HANDLERS.farm(f.ctx, f.settings.modules.farm);
    assert.deepEqual(f.ctx.ledger.pending, {});
    assert.equal(f.ctx.stop.aborted, false);
    assert.equal(f.client.calls.some(call => call.name === 'FarmPlantRequest'), false);
    assert.equal(f.ctx.results.find(row => row.label === '恢复未确认种植 玉米')?.status, 'success');
  } finally { f.ctx.dispose(); }
});

/** 静默种植首次读回可能早于服务端状态同步；确认窗口只能轮询同一地块，不能重发种植请求。 */
test('farm: delayed OnWater update confirms a single plant request within the polling window', async () => {
  let waterReads = 0;
  const f = await moduleRun('farm', { plant: true, cropPriorities: { 玉米: 1 }, cropKeepStock: { 玉米: 5 } }, ({ ctx, client }) => {
    table(ctx, 'FarmlandPlantCfg', [{ id: '玉米', material: ['种子', 1], produceNum: 5 }]);
    client.items.set('种子', 1);
  }, { states: { OnWaterRequest: { building: [{ buildingId: '1农田', farm: {} }] } }, handlers: {
    FarmPlantRequest: async () => {},
    OnWaterRequest: async (_body, _response, client) => {
      waterReads++;
      // 第一次确认读回仍是旧快照；下一次才反映服务端异步写入的种植状态。
      if (waterReads >= 5) client.states.OnWaterRequest.building[0].farm = { productId: '玉米' };
      return client.states.OnWaterRequest;
    },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'FarmPlantRequest').length, 1);
  assert.equal(f.ctx.results.find(row => row.request === 'FarmPlantRequest')?.status, 'success');
  assert.equal(f.ctx.stop.aborted, false);
  assert.ok(waterReads >= 5);
});

/** 同一地块的不同作物待确认记录也必须阻止写入，但不能终止其他自动化模块。 */
test('farm: pending plant for a different crop blocks the same field without stopping automation', async () => {
  const f = fixture({ states: { OnWaterRequest: { building: [{ buildingId: '1农田', farm: {} }] } } });
  f.settings.modules.farm.enabled = true;
  f.settings.modules.farm.plant = true;
  f.settings.modules.farm.cropPriorities = { 小麦: 1 };
  f.settings.modules.farm.cropKeepStock = { 小麦: 5 };
  table(f.ctx, 'FarmlandPlantCfg', [{ id: '小麦', material: ['小麦种子', 1], produceNum: 5 }]);
  f.client.items.set('小麦种子', 1);
  f.ctx.ledger.pending['FarmPlantRequest:{"args":[{"buildingId":"1农田","productId":"玉米"}]}'] = {
    token: 'pending-corn', ruby: 0, module: 'farm', date: businessDate(f.args.now()),
  };
  try {
    await f.ctx.refreshStock();
    await HANDLERS.farm(f.ctx, f.settings.modules.farm);
    assert.equal(f.client.calls.filter(call => call.name === 'FarmPlantRequest').length, 0);
    assert.equal(f.ctx.stop.aborted, false);
    assert.equal(f.ctx.results.find(row => row.request === 'FarmPlantRequest')?.reason, '该农田上次种植结果未确认，禁止重复提交');
  } finally { f.ctx.dispose(); }
});

// 收益达标的缺料订单保留；经验或金币不达标时，无论是否缺料都必须重刷。
test('resident: shortages skip, while low experience or gold rerolls orders', async () => {
  const f = await moduleRun('resident', { blockedMaterials: ['木材'], orderReward: false }, ({ client }) => client.items.set('木材', 100), { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] } } });
  assert.equal(f.ctx.results.filter(r => r.request === 'FinishWorkerOrderRequest').length, 0);
  const short = await moduleRun('resident', { minExp: 10, minGold: 10, thursdayMinGold: 10, orderReward: false }, ({ ctx }) => {
    table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['EXP', 10], ['GOLD', 10]] }]);
  }, { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] } } });
  assert.equal(short.ctx.results.find(r => r.request === 'DenyOrderRequest'), undefined);
  assert.ok(short.ctx.results.some(r => r.reason === '订单材料不足'));
  for (const owned of [0, 1]) for (const [exp, gold] of [[9, 10], [10, 9]]) {
    const reroll = await moduleRun('resident', { minExp: 10, minGold: 10, thursdayMinGold: 10, orderReward: false }, ({ ctx, client }) => {
      client.items.set('木材', owned);
      table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['EXP', exp], ['GOLD', gold]] }]);
    }, { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] } } });
    assert.equal(reroll.ctx.results.filter(r => r.request === 'DenyOrderRequest' && r.status === 'planned').length, 1);
    assert.equal(reroll.ctx.results.filter(r => r.request === 'FinishWorkerOrderRequest').length, 0);
  }
  const state = { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] };
  const applied = await moduleRun('resident', { minExp: 10, minGold: 10, thursdayMinGold: 10, orderReward: false }, ({ ctx }) => {
    // 实际执行路径也保持零库存，证明缺料不会拦住拒单请求和业务读回确认。
    table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['EXP', 9], ['GOLD', 10]] }]);
  }, { states: { OnWaterRequest: state }, handlers: {
    // 模拟服务端拒单后替换订单，供静默请求的读回确认使用。
    DenyOrderRequest: async (_, _response, client) => { client.states.OnWaterRequest.workerOrder = [{ index: 2, requirements: [{ type: 0, id: '木材', num: 1 }] }]; },
  } });
  assert.equal(applied.ctx.results.find(r => r.request === 'DenyOrderRequest')?.status, 'success');
  assert.equal(applied.client.calls.filter(r => r.name === 'DenyOrderRequest').length, 1);
});

/** 材料过滤只决定是否交单，不能挡住低收益订单的刷新判断。 */
test('resident: reward thresholds precede blocked-material and crop filters', async () => {
  for (const filters of [{ blockedMaterials: ['木材'] }, { skipCropOrders: true }]) {
    const f = await moduleRun('resident', { ...filters, minGold: 10, thursdayMinGold: 10, orderReward: false }, ({ ctx }) => {
      table(ctx, 'FarmlandPlantCfg', [{ id: '木材' }]);
      table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['GOLD', 9]] }]);
    }, { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ type: 0, id: '木材', num: 1 }] }] } } });
    assert.equal(f.ctx.results.filter(row => row.request === 'DenyOrderRequest' && row.status === 'planned').length, 1);
    assert.equal(f.ctx.results.some(row => row.request === 'FinishWorkerOrderRequest'), false);
  }
});

test('resident: special order thresholds use WorkerSpecOrderCfg before rerolling', async () => {
  const f = await moduleRun('resident', { minExp: 0, minGold: 100, thursdayMinGold: 100, orderReward: false }, ({ ctx, client }) => {
    client.items.set('木材', 1);
    table(ctx, 'WorkerSpecOrderCfg', [{ times: '7', reward: [['EXP', 40], ['GOLD', 30]] }]);
  }, { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, isSpecial: true, textId: '7', requirements: [{ type: 0, id: '木材', num: 1 }] }] } } });
  assert.equal(f.ctx.results.filter(r => r.request === 'DenyOrderRequest' && r.status === 'planned').length, 1);
  assert.equal(f.ctx.results.filter(r => r.request === 'FinishWorkerOrderRequest').length, 0);
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

/** VIP 免广告招募直接走招募协议的广告方式，不得误用商店广告领奖接口。 */
for (const [module, antique, id] of [['hero', false, 2], ['antique', true, 7]]) test(`${module}: recruit ad uses the recruitment ad way and confirms its reward`, async () => {
  const group = antique ? 'antique' : 'hero';
  const request = antique ? 'AntiqueRecruitRequest' : 'RecruitStartRequest';
  const response = antique ? 'AntiqueRecruitResponse' : 'RecruitStartResponse';
  const f = await moduleRun(module, { recruit: { free: false, tickets: false, points: false, watchVideo: true, maxDraws: 1 } }, ({ ctx, client }) => {
    table(ctx, 'AdvEffectCfg', [{ id, dailyLimit: 1 }]);
    client.states.RecruitInfoRequest = { [group]: { freeEndTimeSeconds: fixedNow / 1000 + 3600, recruitTimes: 9 } };
    client.states.OnWaterRequest = { adv: [{ id, gotTimes: 0, reward: true }] };
    client.handlers[request] = async (body, actualResponse) => {
      assert.deepEqual(body, antique ? { type: protocol.AntiqueRecruitType.RECRUIT_ANTIQUE, way: protocol.RecruitWay.RECRUIT_ADV } : { way: protocol.RecruitWay.RECRUIT_ADV });
      assert.equal(actualResponse, response);
      // 真实广告状态可能延迟同步；招募回包的次数是本次操作的直接成功证据。
      client.states.RecruitInfoRequest[group].recruitTimes += 1;
      return { recruitData: { ...client.states.RecruitInfoRequest[group] } };
    };
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === request).map(call => ({ name: call.name, body: call.body, response: call.response })), [
    { name: request, body: antique ? { type: protocol.AntiqueRecruitType.RECRUIT_ANTIQUE, way: protocol.RecruitWay.RECRUIT_ADV } : { way: protocol.RecruitWay.RECRUIT_ADV }, response },
  ]);
  assert.equal(f.client.calls.some(call => ['WatchAdvRequest', 'GotAdvRewardRequest'].includes(call.name)), false);
  assert.equal(f.ctx.count(`recruit.adv.${group}`), 1);
  assert.deepEqual(f.ctx.ledger.pending, {});
});

/** 当广告状态尚未回写时，持久化的当日招募计数也必须阻止重复发送广告招募。 */
test('hero: recruit ad local count prevents duplicate requests while ad status is stale', async () => {
  const f = await moduleRun('hero', { recruit: { free: false, tickets: false, points: false, watchVideo: true, maxDraws: 1 } }, ({ ctx, client }) => {
    table(ctx, 'AdvEffectCfg', [{ id: 2, dailyLimit: 1 }]);
    client.states.RecruitInfoRequest = { hero: { freeEndTimeSeconds: fixedNow / 1000 + 3600, recruitTimes: 9 } };
    // 模拟 OnWater 广告次数异步更新，始终保持零。
    client.states.OnWaterRequest = { adv: [{ id: 2, gotTimes: 0, reward: true }] };
    client.handlers.RecruitStartRequest = async (body, response) => {
      assert.deepEqual(body, { way: protocol.RecruitWay.RECRUIT_ADV });
      assert.equal(response, 'RecruitStartResponse');
      client.states.RecruitInfoRequest.hero.recruitTimes += 1;
      return { recruitData: { ...client.states.RecruitInfoRequest.hero } };
    };
  });
  await HANDLERS.hero(f.ctx, f.settings.modules.hero);
  assert.equal(f.client.calls.filter(call => call.name === 'RecruitStartRequest').length, 1);
});

/** 预览只展示广告招募写入，不能保存本地次数或向游戏网关发送请求。 */
test('hero: recruit ad preview does not persist an ad count or send a request', async () => {
  const f = await moduleRun('hero', { recruit: { free: false, tickets: false, points: false, watchVideo: true, maxDraws: 1 } }, ({ ctx, client }) => {
    table(ctx, 'AdvEffectCfg', [{ id: 2, dailyLimit: 1 }]);
    client.states.RecruitInfoRequest = { hero: { freeEndTimeSeconds: fixedNow / 1000 + 3600, recruitTimes: 9 } };
    client.states.OnWaterRequest = { adv: [{ id: 2, gotTimes: 0, reward: true }] };
  }, { dryRun: true });
  assert.equal(f.ctx.results.find(row => row.request === 'RecruitStartRequest')?.status, 'planned');
  assert.equal(f.client.calls.some(call => call.name === 'RecruitStartRequest'), false);
  assert.equal(f.ctx.count('recruit.adv.hero'), 0);
});

test('antique: activate only when exact fragment cost available', async () => {
  const f = await moduleRun('antique', { activate: 'always' }, ({ ctx, client }) => { table(ctx, 'AntiqueBaseCfg', [{ antiqueId: '陶罐', activeFrag: 5 }]); client.items.set('陶罐碎片', 5); }, { dryRun: true });
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

/** 联盟赛必须保留服务端从上到下的榜单顺序，不能重新挑总战力最低的候选。 */
test('battle: league selects the first strict two-win rival in displayed order', async () => {
  const first = leagueRival('101', 900), second = leagueRival('102', 800), third = leagueRival('103', 100), fourth = leagueRival('104', 200);
  const f = await leagueRun({
    initial: [first, second, third, fourth],
    formations: {
      '9007199254740993': [100, 50],
      '101': [110, 10], // 总战力虽低，但强队无法战胜我方强队。
      '102': [90, 40],
      '103': [80, 30],
      '104': [70, 20],
    },
    fights: [{ records: [{ isLWin: true }, { isLWin: true }] }],
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueFightRequest').map(call => call.body.playerId), ['102']);
  assert.equal(f.client.calls.some(call => call.name === 'LeagueFormationSequenceRequest'), false);
  assert.ok(f.client.calls.some(call => call.name === 'AllHeroRequest'));
  assert.equal(f.client.calls.some(call => call.name === 'LeagueOtherFormationRequest' && call.body.playerId === '9007199254740993'), false);
});

/** 我方阵容或英雄快照不完整时停止本轮，不能刷新榜单或用总战力猜测两队战力。 */
test('battle: league stops before rival queries when own formation or hero power is unavailable', async () => {
  for (const [ownFormations, heroes] of [
    [[], []],
    [[{ index: 1, heroPositions: [{ heroId: 'a' }] }, { index: 2, heroPositions: [{ heroId: 'b' }] }], [{ heroId: 'a', power: 100 }]],
    [[{ index: 1, heroPositions: [{ heroId: 'a' }] }, { index: 2, heroPositions: [{ heroId: 'b' }] }], [{ heroId: 'a', power: 100 }, { heroId: 'b' }]],
  ]) {
    const f = await moduleRun('battle', { league: { challenge: true, reservePoints: 0 } }, null, {
      states: { LeagueInfoRequest: { mine: { playerId: '9007199254740993', power: 1000 }, ownFormations }, AllHeroRequest: { heroes } },
      handlers: { AllResourceRequest: async () => ({ list: [{ res: protocol.Resource.LEAGUE_POINT, amount: 3 }] }) },
    });
    assert.equal(f.client.calls.some(call => /LeagueRefreshRival|LeagueOtherFormation|LeagueFight|LeagueFormationSequence/.test(call.name)), false);
    assert.ok(f.ctx.results.some(row => /我方积分赛缺少/.test(row.reason ?? '')));
  }
});

/** 对手强队在 2 号位时，严格两胜分支必须先换位并由阵容读回确认。 */
test('battle: league swaps to strong-versus-strong before a strict challenge', async () => {
  const rival = leagueRival('201', 800);
  const f = await leagueRun({
    initial: [rival, leagueRival('202', 2000), leagueRival('203', 2000), leagueRival('204', 2000)],
    formations: {
      '9007199254740993': [100, 50],
      '201': [40, 90],
    },
    fights: [{ records: [{ isLWin: true }, { isLWin: true }] }],
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueFormationSequenceRequest').map(call => call.body.index), [[2, 1]]);
  assert.equal(f.ctx.results.find(row => row.request === 'LeagueFightRequest')?.status, 'success');
});

/** 严格挑战只有两局都胜才成功；任一单局失败后不能再挑战下一名。 */
test('battle: league stops after a strict challenge is not two wins', async () => {
  const first = leagueRival('301', 800), second = leagueRival('302', 700);
  const f = await leagueRun({
    maxActions: 2,
    initial: [first, second, leagueRival('303', 600), leagueRival('304', 500)],
    formations: {
      '9007199254740993': [100, 50],
      '301': [90, 40], '302': [80, 30], '303': [70, 20], '304': [60, 10],
    },
    fights: [{ records: [{ isLWin: true }, { isLWin: false }] }],
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueFightRequest').map(call => call.body.playerId), ['301']);
  assert.match(f.ctx.results.find(row => row.request === 'LeagueFightRequest')?.status ?? '', /failed/);
});

/** 没有稳赢时只允许 refreshTimes=1 的一次已验证免费刷新，并从刷新榜单首个稳赢候选开始。 */
test('battle: league performs one verified free refresh before selecting a strict winner', async () => {
  const refreshed = leagueRival('401', 800);
  const f = await leagueRun({
    initial: [leagueRival('411', 2000), leagueRival('412', 2000), leagueRival('413', 2000), leagueRival('414', 2000)],
    refreshed: [refreshed, leagueRival('402', 2000), leagueRival('403', 2000), leagueRival('404', 2000)],
    formations: {
      '9007199254740993': [100, 50],
      '401': [90, 40],
    },
    fights: [{ records: [{ isLWin: true }, { isLWin: true }] }],
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueRefreshRivalRequest').map(call => call.body.isRefresh), [false, true]);
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueFightRequest').map(call => call.body.playerId), ['401']);
  assert.equal(f.client.ruby, 1000);
});

/** 非已验证的刷新计数一律不发送 true，防止将“换一批”误当免费操作。 */
test('battle: league refuses a refresh whose free status is not proven', async () => {
  const f = await leagueRun({
    refreshTimes: 2,
    initial: [leagueRival('501', 2000), leagueRival('502', 2000), leagueRival('503', 2000), leagueRival('504', 2000)],
    formations: { '9007199254740993': [100, 50] },
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueRefreshRivalRequest').map(call => call.body.isRefresh), [false]);
  assert.equal(f.client.calls.some(call => call.name === 'LeagueFightRequest'), false);
  assert.ok(f.ctx.results.some(row => row.reason === '积分赛刷新次数未处于已验证的免费档，拒绝刷新'));
  assert.equal(f.ctx.results.some(row => /对手列表不是四名/.test(row.reason ?? '')), false);
});

/** 刷新后没有两胜目标时，平局分支要强打弱、弱打强，并确认最终积分不下降。 */
test('battle: league uses a confirmed no-loss draw after the refreshed list has no strict winner', async () => {
  const draw = leagueRival('601', 2000);
  const f = await leagueRun({
    initial: [leagueRival('611', 2000), leagueRival('612', 2000), leagueRival('613', 2000), leagueRival('614', 2000)],
    refreshed: [draw, leagueRival('602', 2000), leagueRival('603', 2000), leagueRival('604', 2000)],
    formations: {
      '9007199254740993': [100, 50],
      // 强队同在 1 号位，平局策略必须交换到我强打对方弱。
      '601': [110, 40],
      '602': [110, 100], '603': [110, 100], '604': [110, 100],
    },
    fights: [{ records: [{ isLWin: false }, { isLWin: true }], finalScore: 1000 }],
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueFormationSequenceRequest').map(call => call.body.index), [[2, 1]]);
  assert.equal(f.ctx.results.find(row => row.request === 'LeagueFightRequest')?.status, 'success');
});

/** 即使战果是一胜一负，只要本方积分下降，也必须停止而不能把它记为保分平局。 */
test('battle: league rejects a draw response whose final score drops', async () => {
  const f = await leagueRun({
    initial: [leagueRival('711', 2000), leagueRival('712', 2000), leagueRival('713', 2000), leagueRival('714', 2000)],
    refreshed: [leagueRival('701', 2000), leagueRival('702', 2000), leagueRival('703', 2000), leagueRival('704', 2000)],
    formations: {
      '9007199254740993': [100, 50],
      '701': [110, 40],
      '702': [110, 100], '703': [110, 100], '704': [110, 100],
    },
    fights: [{ records: [{ isLWin: false }, { isLWin: true }], finalScore: 999 }],
  });
  assert.equal(f.ctx.results.find(row => row.request === 'LeagueFightRequest')?.status, 'failed');
  assert.ok(f.ctx.results.some(row => row.reason === '对手 对手701 平局后积分下降，停止积分赛挑战'));
});

/** 队内战力相同无法定义强弱队，必须跳过而不能把任意位置当作稳赢。 */
test('battle: league skips tied fleet power instead of guessing a formation', async () => {
  const f = await leagueRun({
    refreshTimes: 2,
    initial: [leagueRival('801', 800), leagueRival('802', 2000), leagueRival('803', 2000), leagueRival('804', 2000)],
    formations: {
      '9007199254740993': [100, 50],
      '801': [90, 90],
    },
  });
  assert.equal(f.client.calls.some(call => call.name === 'LeagueFightRequest'), false);
  assert.ok(f.ctx.results.some(row => row.reason === '对手 对手801缺少两支可区分的舰队战力'));
});

/** 四人列表不完整时不能推断名次收益或尝试刷新、换位、挑战。 */
test('battle: league stops when the server does not return four distinct rivals', async () => {
  const f = await leagueRun({
    initial: [leagueRival('901', 800), leagueRival('902', 700), leagueRival('903', 600)],
    formations: { '9007199254740993': [100, 50] },
  });
  assert.equal(f.client.calls.some(call => call.name === 'LeagueOtherFormationRequest'), false);
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueRefreshRivalRequest').map(call => call.body.isRefresh), [false]);
  assert.ok(f.ctx.results.some(row => row.reason === '积分赛对手列表不是四名不同对手，停止本轮挑战'));
});

/** 即使本轮动作上限大于一，未出现可用候选时也不得重复发送免费刷新。 */
test('battle: league never refreshes more than once per automation run', async () => {
  const f = await leagueRun({
    maxActions: 3,
    initial: [leagueRival('1001', 2000), leagueRival('1002', 2000), leagueRival('1003', 2000), leagueRival('1004', 2000)],
    refreshed: [leagueRival('1011', 2000), leagueRival('1012', 2000), leagueRival('1013', 2000), leagueRival('1014', 2000)],
    formations: { '9007199254740993': [100, 50] },
  });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'LeagueRefreshRivalRequest').map(call => call.body.isRefresh), [false, true]);
});

/** 积分赛临时锁定只跳过本轮，不能把整条挂机循环标记为自动化异常。 */
test('battle: league skips a server score-match lock without stopping automation', async () => {
  const f = fixture({
    handlers: {
      LeagueInfoRequest: async () => {
        const error = new Error('server prompt: score match locked');
        error.prompt = { args: ['score match locked'] };
        throw error;
      },
    },
  });
  f.settings.modules.battle.enabled = true;
  f.settings.modules.battle.league.challenge = true;
  f.ctx.dispose();

  const result = await runAutomation({ ...f.args, selector: 'battle' });

  assert.equal(result.error, null);
  assert.equal(f.client.calls.some(call => call.name === 'LeagueFightRequest'), false);
  assert.ok(result.results.some(row => row.status === 'skipped' && row.reason === '积分赛当前锁定，跳过本轮挑战'));
});

test('world: next trade ship uses lv/upCost; default spending prevents ruby upgrade', async () => {
  const f = await moduleRun('world', { trade: { enabled: true, claim: false, upgrade: true, speedUp: false } }, ({ ctx }) => table(ctx, 'TradeShipCfg', [{ lv: 2, upMoney: 100, upCost: ['RUBY', 30] }]), { dryRun: true, states: { TradeInfoRequest: { period: 1, cargo: { cargoLv: 1 }, player: { coins: 500 } } } });
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
      now: () => Date.parse(time), states: { TradeInfoRequest: { period: 1, cargo: {} } },
    });
    assert.equal(f.client.calls.filter(call => call.name === 'TradeInfoRequest').length, expectedQueries, time);
    if (!expectedQueries) assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /10:00–22:00/);
  }
});

/** 活动关闭的 period=0 空回包必须只产生一次明确跳过，不能继续领奖、升级或交易。 */
test('trade: inactive or missing period stops before rewards, upgrades and transactions', async () => {
  for (const state of [{ period: 0, worldCargo: [] }, { worldCargo: [] }]) {
    const f = await moduleRun('world', { trade: { enabled: true, claim: true, upgrade: true, speedUp: true } }, null, {
      states: { TradeInfoRequest: state },
    });
    assert.deepEqual(f.client.calls.filter(call => /Trade|BattlePass/.test(call.name)).map(call => call.name), ['TradeInfoRequest']);
    assert.deepEqual(f.ctx.results.map(row => row.reason), ['海商王活动未开放']);
  }
});

test('world: pirate sweep treats the server count as used times and honors the configured daily target', async () => {
  const f = await moduleRun('world', {
    pirate: { attack: false, sweep: true, attackTypes: [], sweepTypes: [{ type: 1, times: 1 }, { type: 2, times: 1 }], dailySweepLimit: 2, attackTime: { start: '00:00', end: '00:00' } },
  }, ({ ctx }) => table(ctx, 'VipLevelCfg', [{ level: 7, effects: [['野怪扫荡次数', 15]] }]), { player: { vip: { vipLevel: 7 } }, states: {
    PirateKillRecordRequest: { records: [{ type: 1, maxKilledLevel: 10 }, { type: 2, maxKilledLevel: 10 }, { type: 3, maxKilledLevel: 10 }] },
    AllPirateRequest: { sweepTimes: 0, pirates: [{ uid: 11, type: 1, level: 10, cityId: 1 }, { uid: 12, type: 2, level: 10, cityId: 1 }, { uid: 13, type: 3, level: 10, cityId: 1 }] },
  }, handlers: {
    PirateSweepRequest: async (_, _response, client) => { client.states.AllPirateRequest.sweepTimes += 1; },
  } });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'PirateSweepRequest').map(call => call.body.uid), [11, 12]);
});

/** 海盗类型分配按配置次数执行，不再把次数平均轮换到所有类型。 */
test('world: pirate sweep follows per-type allocation order', async () => {
  const f = await moduleRun('world', {
    pirate: { attack: false, sweep: true, attackTypes: [], sweepTypes: [{ type: 1, times: 2 }, { type: 2, times: 1 }, { type: 3, times: 2 }], dailySweepLimit: 5, attackTime: { start: '00:00', end: '00:00' } },
  }, ({ ctx }) => table(ctx, 'VipLevelCfg', [{ level: 3, effects: [['野怪扫荡次数', 5]] }]), { player: { vip: { vipLevel: 3 } }, states: {
    PirateKillRecordRequest: { records: [{ type: 1, maxKilledLevel: 10 }, { type: 2, maxKilledLevel: 10 }, { type: 3, maxKilledLevel: 10 }] },
    AllPirateRequest: { sweepTimes: 0, pirates: [{ uid: 11, type: 1, level: 10, cityId: 1 }, { uid: 12, type: 2, level: 10, cityId: 1 }, { uid: 13, type: 3, level: 10, cityId: 1 }] },
  }, handlers: {
    PirateSweepRequest: async (_, _response, client) => { client.states.AllPirateRequest.sweepTimes += 1; },
  } });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'PirateSweepRequest').map(call => call.body.uid), [11, 11, 12, 13, 13]);
});

/** 某个配置类型没有目标时，其次数不应转移给其他类型。 */
test('world: pirate sweep does not reallocate a missing type', async () => {
  const f = await moduleRun('world', {
    pirate: { attack: false, sweep: true, attackTypes: [], sweepTypes: [{ type: 1, times: 2 }, { type: 2, times: 3 }], dailySweepLimit: 5, attackTime: { start: '00:00', end: '00:00' } },
  }, ({ ctx }) => table(ctx, 'VipLevelCfg', [{ level: 3, effects: [['野怪扫荡次数', 5]] }]), { player: { vip: { vipLevel: 3 } }, states: {
    PirateKillRecordRequest: { records: [{ type: 1, maxKilledLevel: 10 }, { type: 2, maxKilledLevel: 10 }] },
    AllPirateRequest: { sweepTimes: 0, pirates: [{ uid: 11, type: 1, level: 10, cityId: 1 }] },
  }, handlers: {
    PirateSweepRequest: async (_, _response, client) => { client.states.AllPirateRequest.sweepTimes += 1; },
  } });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'PirateSweepRequest').map(call => call.body.uid), [11, 11]);
});

test('world: pirate sweep stops when the configured daily target has been reached', async () => {
  const f = await moduleRun('world', {
    pirate: { attack: false, sweep: true, attackTypes: [], sweepTypes: [{ type: 1, times: 1 }], dailySweepLimit: 0, attackTime: { start: '00:00', end: '00:00' } },
  }, ({ ctx }) => table(ctx, 'VipLevelCfg', [{ level: 7, effects: [['野怪扫荡次数', 15]] }]), { player: { vip: { vipLevel: 7 } }, states: {
    PirateKillRecordRequest: { records: [{ type: 1, maxKilledLevel: 10 }] },
    AllPirateRequest: { sweepTimes: 0, pirates: [{ uid: 11, type: 1, level: 10, cityId: 1 }] },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'PirateSweepRequest').length, 0);
  assert.ok(f.ctx.results.some(result => result.status === 'skipped' && result.reason === '海盗今日扫荡次数已达到设置上限'));
});

/** VIP 档位提升后，自动化必须以基础次数加配置表额外次数做计划。 */
test('world: pirate sweep uses the current VIP-specific cap', async () => {
  const f = await moduleRun('world', {
    pirate: { attack: false, sweep: true, attackTypes: [], sweepTypes: [{ type: 1, times: 30 }], dailySweepLimit: 30, attackTime: { start: '00:00', end: '00:00' } },
  }, ({ ctx }) => table(ctx, 'VipLevelCfg', [{ level: 12, effects: [['野怪扫荡次数', 20]] }]), { player: { vip: { vipLevel: 12 } }, states: {
    PirateKillRecordRequest: { records: [{ type: 1, maxKilledLevel: 10 }] },
    AllPirateRequest: { sweepTimes: 28, pirates: [{ uid: 11, type: 1, level: 10, cityId: 1 }] },
  }, handlers: {
    PirateSweepRequest: async (_, _response, client) => { client.states.AllPirateRequest.sweepTimes += 1; },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'PirateSweepRequest').length, 2);
});

/** 海盗总上限为基础 10 次加当前角色 VIP 配置的额外次数，sweepTimes 仅表示当天累计已扫次数。 */
test('world: pirate sweep progress uses the base and VIP bonus limit and rejects invalid server counts', () => {
  const tables = { VipLevelCfg: { data: [{ level: 2, effects: [['野怪扫荡次数', 2]] }, { level: 3, effects: [['野怪扫荡次数', 5]] }, { level: 7, effects: [['野怪扫荡次数', 15]] }, { level: 12, effects: [['野怪扫荡次数', 20]] }] } };
  assert.equal(pirateDailySweepLimit(tables, 0), 10);
  assert.equal(pirateDailySweepLimit(tables, 2), 12);
  assert.equal(pirateDailySweepLimit(tables, 3), 15);
  assert.equal(pirateDailySweepLimit(tables, 7), 25);
  assert.equal(pirateDailySweepLimit(tables, 12), 30);
  assert.deepEqual(pirateSweepProgress(0, 30), { dailyLimit: 30, used: 0, remaining: 30 });
  assert.deepEqual(pirateSweepProgress(30, 30), { dailyLimit: 30, used: 30, remaining: 0 });
  assert.throws(() => pirateDailySweepLimit(tables, 8), /没有/);
  assert.throws(() => pirateSweepProgress(31, 30), /无效/);
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

/** 付费点金仅在挂机模块实际启用时接管旧日常 1006，避免关闭挂机后意外屏蔽手动旧流程。 */
test('daily dedup: enabled AFK paid click-gold owns task 1006', () => {
  const settings = defaultSettings();
  settings.spending.clickGoldTimes = 1;
  assert.equal(handledDailyIds(settings).includes(1006), false);
  settings.modules.afk.enabled = true;
  assert.equal(handledDailyIds(settings).includes(1006), true);
  settings.spending.clickGoldTimes = 0;
  assert.equal(handledDailyIds(settings).includes(1006), false);
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
  const completedBatches = [];
  const result = await runLoop(f.client, protocol, { ...f.args, allowMutate: true, automationOnly: true, automationModules: ['cargo'], rounds: 3, everyMs: 1000, stop, sleep: async () => { stop.aborted = true; }, onBatchComplete: categories => completedBatches.push(categories) });
  assert.equal(result.history.length, 1);
  assert.equal(f.client.calls.filter(c => c.name === 'CargoShipsRequest').length, 1);
  assert.deepEqual(completedBatches, [['production', 'fleets', 'cargo', 'world', 'tasks', 'inventory']]);
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
    assert.equal(initialSettingsResponse.value.clickGoldUnitPrice, 50);
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

/** 折扣商品已购时只结算同幂等键的待确认记录，不能重发购买或把外部购买误认成本次结果。 */
test('paid legacy: purchased discount item settles a pending buy through a read-only check', async () => {
  const f = fixture({ states: { DiscountShopRequest: { shopItem: [{ id: 1, price: 100, discount: 0.5, isBuy: true }] } } });
  const key = 'DiscountShopBuyRequest:{"id":1}';
  f.ctx.setModule('dailies');
  f.ctx.ledger.pending[key] = { token: 'pending-discount', ruby: 50, module: 'dailies', date: businessDate(fixedNow) };
  writeJson(loadLedger(f.args.accountId, f.args.player.playerId).file, f.ctx.ledger);
  try {
    await guardedDailyAction(f.ctx, { request: 'DiscountShopBuyRequest', body: { id: 1 }, response: null, note: '购买折扣商品' });
    assert.deepEqual(f.ctx.ledger.pending, {});
    assert.equal(f.ctx.stop.aborted, false);
    assert.equal(f.client.calls.filter(call => call.name === 'DiscountShopBuyRequest').length, 0);
    assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 50);
  } finally { f.ctx.dispose(); }
});

/** 构造折扣商店测试商品，奖励 ID 与协议抓包中的精确字符串保持一致。 */
function discountItem(id, rewardId, price = 100, discount = 0.2, isBuy = false) {
  return { id, reward: { asset: [{ type: 0, id: rewardId, num: 1 }] }, price, discount, isBuy };
}

/** 将分页面折扣商店状态接入内存网关，并只允许测试显式推进刷新次数。 */
function discountShopHandlers(pages) {
  let page = 0;
  return {
    DiscountShopRequest: async () => pages[page],
    DiscountShopRefreshRequest: async () => {
      page++;
      return pages[page];
    },
    DiscountShopBuyRequest: async ({ id }, _response, client) => {
      const item = pages[page].shopItem.find(row => row.id === id);
      item.isBuy = true;
      client.ruby -= Math.floor(item.price * item.discount);
      return {};
    },
  };
}

test('discount tickets: forced target purchases bypass diamond policy and do not refresh when both are present', async () => {
  const pages = [{ refreshCount: 0, shopItem: [discountItem(1, '抽卡券'), discountItem(2, '藏品券'), discountItem(3, '普通商品', 10, 0.5)] }];
  const f = fixture({ states: { DiscountShopRequest: pages[0] }, handlers: discountShopHandlers(pages) });
  Object.assign(f.settings.spending, { dailiesDiscountTickets2x: true, minRubyStock: 10000 }); f.ctx.setModule('dailies');
  const { runDailies } = await import('../src/dailies.mjs');
  try {
    await runDailies(f.client, protocol, { config: f.ctx.config, tasks: [{ task: { id: 1007, title: '折扣商店购买', progress: 0, targetProgress: 1 }, status: 'ready', actions: [] }] }, {
      allowMutate: true, allowPaid: false, claimRewards: false, actionExecutor: step => legacyAction(f.ctx, step), context: f.ctx,
    });
    assert.deepEqual(f.client.calls.filter(call => call.name === 'DiscountShopBuyRequest').map(call => call.body.id), [1, 2]);
    assert.equal(f.client.calls.filter(call => call.name === 'DiscountShopRefreshRequest').length, 0);
    assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 40);
    Object.assign(f.settings.spending, { enabled: true, dailyLimit: 30 }); f.settings.spending.modules.dailies = 30;
    await assert.rejects(guardedDailyAction(f.ctx, { request: 'DiscountShopBuyRequest', body: { id: 3 }, response: null, note: '普通回退' }), /日额度不足/);
  } finally { f.ctx.dispose(); }
});

test('discount tickets: only configured free refreshes are used and both ticket kinds can be bought across pages', async () => {
  const pages = [
    { refreshCount: 0, shopItem: [discountItem(1, '普通商品', 10, 0.5)] },
    { refreshCount: 1, shopItem: [discountItem(2, '抽卡券')] },
    { refreshCount: 2, shopItem: [discountItem(3, '藏品券')] },
  ];
  const f = fixture({ states: { DiscountShopRequest: pages[0] }, handlers: discountShopHandlers(pages) });
  f.settings.spending.dailiesDiscountTickets2x = true; f.ctx.setModule('dailies');
  table(f.ctx, 'ShopRefreshCfg', [{ times: 1, cost: [] }, { times: 2, cost: [] }, { times: 3, cost: [['RUBY', 50]] }]);
  try {
    const result = await runPriorityDiscountShop(f.ctx, step => legacyAction(f.ctx, step));
    assert.equal(result.targetBought, true);
    assert.equal(f.client.calls.filter(call => call.name === 'DiscountShopRefreshRequest').length, 2);
    assert.equal(f.client.calls.some(call => call.name === 'DiscountShopRefreshRequest' && call.body?.cost), false);
    assert.deepEqual(f.client.calls.filter(call => call.name === 'DiscountShopBuyRequest').map(call => call.body.id), [2, 3]);
  } finally { f.ctx.dispose(); }
});

test('discount tickets: no target after free refresh falls back to the cheapest final-page item under normal paid rules', async () => {
  const pages = [
    { refreshCount: 0, shopItem: [discountItem(1, '普通商品', 10, 0.5)] },
    { refreshCount: 1, shopItem: [discountItem(2, '普通商品', 80, 0.5), discountItem(3, '普通商品', 20, 0.5)] },
  ];
  const f = fixture({ states: { DiscountShopRequest: pages[0] }, handlers: discountShopHandlers(pages) });
  Object.assign(f.settings.spending, { enabled: true, dailyLimit: 100, dailiesDiscountTickets2x: true });
  f.settings.spending.modules.dailies = 100; f.ctx.setModule('dailies');
  table(f.ctx, 'ShopRefreshCfg', [{ times: 1, cost: [] }, { times: 2, cost: [['RUBY', 50]] }]);
  try {
    const { runDailies } = await import('../src/dailies.mjs');
    await runDailies(f.client, protocol, { config: f.ctx.config, tasks: [{ task: { id: 1007, title: '折扣商店购买', progress: 0, targetProgress: 1 }, status: 'ready', actions: [] }] }, {
      allowMutate: true, allowPaid: true, claimRewards: false, actionExecutor: step => legacyAction(f.ctx, step), context: f.ctx,
    });
    assert.deepEqual(f.client.calls.filter(call => call.name === 'DiscountShopBuyRequest').map(call => call.body.id), [3]);
    assert.equal(f.client.calls.filter(call => call.name === 'DiscountShopRefreshRequest').length, 1);
    assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 10);
  } finally { f.ctx.dispose(); }
});

test('discount tickets: forced target still skips when the live diamond balance cannot pay', async () => {
  const pages = [{ refreshCount: 0, shopItem: [discountItem(1, '抽卡券', 100, 0.2), discountItem(2, '普通商品', 10, 0.5)] }];
  const f = fixture({ states: { DiscountShopRequest: pages[0] }, handlers: discountShopHandlers(pages) });
  f.client.ruby = 5; f.settings.spending.dailiesDiscountTickets2x = true; f.ctx.setModule('dailies');
  try {
    const result = await runPriorityDiscountShop(f.ctx, step => legacyAction(f.ctx, step));
    assert.equal(result.failed, true);
    assert.equal(f.client.calls.filter(call => call.name === 'DiscountShopBuyRequest').length, 0);
    assert.equal(f.client.calls.filter(call => call.name === 'DiscountShopRefreshRequest').length, 0);
  } finally { f.ctx.dispose(); }
});

/** 挂机付费点金只补足服务端当天 paidTimes 的差额，并以读回后的次数确认一次批量写入。 */
test('afk: paid click-gold reaches the configured target once and charges the AFK budget', async () => {
  const f = await moduleRun('afk', { claim: false, levelUp: false, levelReward: false }, ({ ctx, settings }) => {
    settings.spending.clickGoldTimes = 5;
    Object.assign(settings.spending, { enabled: true, dailyLimit: 200 }); settings.spending.modules.afk = 200;
    table(ctx, 'OfflineParamCfg', [{ paramName: '点金价格', paramValue: 50 }]);
  }, { states: {
    AfkInfoRequest: { afkInfo: {} },
    ClickGoldInfoRequest: { info: { paidTimes: 2, maxPaidTimes: 17 } },
  }, handlers: {
    ClickGoldRequest: async ({ times, free }, response, client) => {
      assert.equal(free, false); assert.equal(response, 'ClickGoldResponse');
      client.states.ClickGoldInfoRequest.info.paidTimes += times;
      client.ruby -= 50 * times;
      return {};
    },
  } });
  assert.deepEqual(f.client.calls.filter(call => call.name === 'ClickGoldRequest').map(call => call.body), [{ times: 3, free: false }]);
  assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].spent, 150);
  assert.equal(f.ctx.ledger.days[businessDate(fixedNow)].modules.afk, 150);
});

/** 已到目标、服务端上限和所有钻石护栏都必须在发包前阻止挂机付费点金。 */
test('afk: paid click-gold skips reached targets, server caps and unavailable diamond budgets', async () => {
  const reached = await moduleRun('afk', { claim: false, levelUp: false, levelReward: false }, ({ settings }) => { settings.spending.clickGoldTimes = 5; }, { states: {
    AfkInfoRequest: { afkInfo: {} }, ClickGoldInfoRequest: { info: { paidTimes: 5, maxPaidTimes: 17 } },
  } });
  assert.equal(reached.client.calls.filter(call => call.name === 'ClickGoldRequest').length, 0);

  const missingPrice = await moduleRun('afk', { claim: false, levelUp: false, levelReward: false }, ({ settings }) => {
    settings.spending.clickGoldTimes = 1;
  }, { states: {
    AfkInfoRequest: { afkInfo: {} }, ClickGoldInfoRequest: { info: { paidTimes: 0, maxPaidTimes: 17 } },
  } });
  assert.equal(missingPrice.client.calls.filter(call => call.name === 'ClickGoldRequest').length, 0);
  assert.equal(missingPrice.ctx.results.find(row => row.label === '付费点金')?.reason, '缺少有效的付费点金价格');

  const capped = await moduleRun('afk', { claim: false, levelUp: false, levelReward: false }, ({ ctx, settings }) => {
    settings.spending.clickGoldTimes = 5;
    Object.assign(settings.spending, { enabled: true, dailyLimit: 100 }); settings.spending.modules.afk = 100;
    table(ctx, 'OfflineParamCfg', [{ paramName: '点金价格', paramValue: 50 }]);
  }, { states: {
    AfkInfoRequest: { afkInfo: {} }, ClickGoldInfoRequest: { info: { paidTimes: 3, maxPaidTimes: 4 } },
  }, handlers: {
    ClickGoldRequest: async ({ times }, _response, client) => { client.states.ClickGoldInfoRequest.info.paidTimes += times; client.ruby -= 50 * times; return {}; },
  } });
  assert.deepEqual(capped.client.calls.filter(call => call.name === 'ClickGoldRequest').map(call => call.body), [{ times: 1, free: false }]);
  assert.match(capped.ctx.results.find(row => row.status === 'skipped')?.reason ?? '', /超过服务端当日上限/);

  for (const [policy, expected] of [
    [{ enabled: false, dailyLimit: 100, moduleLimit: 100, minRubyStock: 0 }, /未开启/],
    [{ enabled: true, dailyLimit: 0, moduleLimit: 100, minRubyStock: 0 }, /额度为 0/],
    [{ enabled: true, dailyLimit: 100, moduleLimit: 0, minRubyStock: 0 }, /额度为 0/],
    [{ enabled: true, dailyLimit: 100, moduleLimit: 100, minRubyStock: 960 }, /保留量/],
  ]) {
    const guarded = await moduleRun('afk', { claim: false, levelUp: false, levelReward: false }, ({ ctx, settings }) => {
      settings.spending.clickGoldTimes = 1;
      Object.assign(settings.spending, { enabled: policy.enabled, dailyLimit: policy.dailyLimit, minRubyStock: policy.minRubyStock }); settings.spending.modules.afk = policy.moduleLimit;
      table(ctx, 'OfflineParamCfg', [{ paramName: '点金价格', paramValue: 50 }]);
    }, { states: {
      AfkInfoRequest: { afkInfo: {} }, ClickGoldInfoRequest: { info: { paidTimes: 0, maxPaidTimes: 17 } },
    } });
    assert.equal(guarded.client.calls.filter(call => call.name === 'ClickGoldRequest').length, 0);
    assert.match(guarded.ctx.results.find(row => row.request === 'ClickGoldRequest')?.reason ?? '', expected);
  }
});

/** 预览不得落盘或发点金包；未确认写入则必须由持久化 pending 阻止下一轮重发。 */
test('afk: paid click-gold preview and uncertain result do not permit a duplicate request', async () => {
  const planned = await moduleRun('afk', { claim: false, levelUp: false, levelReward: false }, ({ ctx, settings }) => {
    settings.spending.clickGoldTimes = 1;
    Object.assign(settings.spending, { enabled: true, dailyLimit: 50 }); settings.spending.modules.afk = 50;
    table(ctx, 'OfflineParamCfg', [{ paramName: '点金价格', paramValue: 50 }]);
  }, { dryRun: true, states: {
    AfkInfoRequest: { afkInfo: {} }, ClickGoldInfoRequest: { info: { paidTimes: 0, maxPaidTimes: 17 } },
  } });
  assert.equal(planned.ctx.results.find(row => row.request === 'ClickGoldRequest')?.status, 'planned');
  assert.equal(planned.client.calls.some(call => call.name === 'ClickGoldRequest'), false);
  assert.equal(fs.existsSync(loadLedger(planned.args.accountId, planned.args.player.playerId).file), false);

  const f = fixture({ states: {
    AfkInfoRequest: { afkInfo: {} }, ClickGoldInfoRequest: { info: { paidTimes: 0, maxPaidTimes: 17 } },
  }, handlers: {
    ClickGoldRequest: async () => { throw new Error('网络超时'); },
  } });
  f.settings.modules.afk.enabled = true;
  f.settings.modules.afk.levelUp = false;
  f.settings.modules.afk.levelReward = false;
  f.settings.spending.clickGoldTimes = 1;
  Object.assign(f.settings.spending, { enabled: true, dailyLimit: 50 }); f.settings.spending.modules.afk = 50;
  table(f.ctx, 'OfflineParamCfg', [{ paramName: '点金价格', paramValue: 50 }]);
  f.ctx.setModule('afk');
  try {
    await f.ctx.refreshStock(); await HANDLERS.afk(f.ctx, f.settings.modules.afk);
    assert.equal(f.client.calls.filter(call => call.name === 'ClickGoldRequest').length, 1);
    assert.equal(Object.keys(f.ctx.ledger.pending).length, 1);
  } finally { f.ctx.dispose(); }

  const retry = createContext(f.args); retry.setModule('afk');
  try {
    await retry.refreshStock(); await HANDLERS.afk(retry, f.settings.modules.afk);
    assert.equal(f.client.calls.filter(call => call.name === 'ClickGoldRequest').length, 1);
    assert.equal(retry.results.find(row => row.request === 'ClickGoldRequest')?.status, 'uncertain');
  } finally { retry.dispose(); }
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

/** 倍率探宝按服务端请求倍率扣除基础材料，不能只凭一倍库存发送必然被拒绝的启动请求。 */
test('museum: start cost scales with the requested exploration factor', async () => {
  for (const [stock, starts] of [[1, 0], [2, 1]]) {
    const f = await moduleRun('museum', { collectRevenue: false, explore: true, factor: 2 }, ({ ctx, client }) => {
      table(ctx, 'MuseumExploreTimeFactorCfg', [{ factor: 2, playerLevel: 1 }]);
      client.items.set('木材', stock);
    }, { states: {
      MuseumInfoRequest: { exploreStages: [{ stageId: 1, expedition: { startTime: 0, endTime: 0, heroIds: [], cost: { asset: [{ type: 0, id: '木材', num: 1 }] } } }] },
      GetFormationRequest: { formation: { heroPositions: [{ heroId: '机器屠夫' }] } },
      AllHeroRequest: { heroes: [{ heroId: '机器屠夫', star: 1, power: 100 }] },
    } });
    assert.equal(f.client.calls.filter(call => call.name === 'MuseumStartExploreRequest').length, starts);
    if (!starts) assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /缺少探宝消耗或库存不足/);
  }
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

/** 单个 VIP 试炼的遗留未确认登记不能重复提交，也不能阻塞其余独立试炼权益。 */
test('trial VIP: persisted registration uncertainty skips only its raid', async () => {
  const f = vipTrialFixture();
  const key = 'WatchAdvRequest:{"type":1,"id":4}';
  f.ctx.ledger.pending[key] = { token: 'pending-vip-registration', ruby: 0, module: 'battle', date: businessDate(fixedNow) };
  writeJson(loadLedger(f.args.accountId, f.args.player.playerId).file, f.ctx.ledger);
  f.ctx.dispose();
  try {
    const result = await runAutomation({ ...f.args, selector: 'battle' });
    assert.equal(result.error, null);
    assert.equal(f.client.calls.filter(call => call.name === 'WatchAdvRequest' && call.body.id === 4).length, 0);
    assert.deepEqual(f.client.calls.filter(call => call.name === 'TrialRaidBuySweepRequest').map(call => call.body.raidId), [2, 3]);
    assert.equal(result.results.some(row => row.label === '试炼 1 VIP免广告登记' && row.status === 'uncertain'), true);
    assert.equal(result.results.some(row => row.module === 'battle' && row.status === 'blocked'), false);
  } finally { f.ctx.dispose(); }
});

/** 新发生的 VIP 登记超时也只保留当前组的锁，后续试炼仍可领取。 */
test('trial VIP: registration timeout preserves the run for later raids', async () => {
  const f = vipTrialFixture();
  f.client.handlers.WatchAdvRequest = async ({ id }, response) => {
    assert.equal(response, 'OkResponse');
    if (id === 4) throw new Error('registration timeout');
    return {};
  };
  f.ctx.dispose();
  try {
    const result = await runAutomation({ ...f.args, selector: 'battle' });
    assert.equal(result.error, null);
    assert.equal(f.client.calls.filter(call => call.name === 'WatchAdvRequest' && call.body.id === 4).length, 1);
    assert.deepEqual(f.client.calls.filter(call => call.name === 'TrialRaidBuySweepRequest').map(call => call.body.raidId), [2, 3]);
    assert.ok(result.ledger.pending['WatchAdvRequest:{"type":1,"id":4}']);
    assert.equal(result.results.some(row => row.label === '试炼 1 VIP免广告登记' && row.status === 'uncertain'), true);
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

/** 工厂收成回包后读回尚未同步时，仅锁住该工厂写入，后续挂机模块仍必须继续执行。 */
test('factory scheduler: uncertain harvest preserves the global automation run', async () => {
  const f = productionFixture({ queue: [], stock: [['木材', 20]] });
  f.client.states.OnWaterRequest.building[0].factory.finishedProducts = [{ type: 0, id: '快料', num: 1 }];
  f.client.handlers.GainFactoryProduceRequest = async () => ({ products: { asset: [] } });
  try {
    await runProduction(f);
    assert.equal(f.client.calls.filter(call => call.name === 'GainFactoryProduceRequest').length, 1);
    assert.equal(f.ctx.stop.aborted, false);
    assert.equal(f.ctx.results.find(row => row.request === 'GainFactoryProduceRequest')?.status, 'uncertain');
    assert.ok(f.ctx.ledger.pending['GainFactoryProduceRequest:{"buildingId":"1食品厂"}']);
    // 工厂为空是只读证据：旧收成已经没有可重复领取的目标，下一轮可安全解除锁。
    f.client.states.OnWaterRequest.building[0].factory.finishedProducts = [];
    await runProduction(f);
    assert.equal(f.ctx.ledger.pending['GainFactoryProduceRequest:{"buildingId":"1食品厂"}'], undefined);
    assert.ok(f.ctx.results.some(row => row.label === '恢复未确认工厂收成 1食品厂' && row.verifiedByRead));
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

test('factory scheduler: keeps game auto-production and appends demand materials behind it', async () => {
  const f = productionFixture({ autoProductId: '长货', queue: [{ idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 }], options: { autoProduce: true } });
  try {
    await runProduction(f);
    const writes = f.client.calls.filter(call => /^(Cancel|Set|Start)Factory/.test(call.name));
    assert.equal(writes.filter(call => call.name === 'CancelFactoryAutoProduceRequest').length, 0);
    assert.equal(writes.filter(call => call.name === 'SetFactoryAutoProduceRequest').length, 0);
    assert.equal(f.client.states.OnWaterRequest.building[0].factory.autoProductId, '长货');
    assert.equal(f.client.states.OnWaterRequest.building[0].factory.factoryQ[0].productId, '长货');
    assert.ok(writes.some(call => call.name === 'StartFactoryProduceRequest'), '需求材料应追加到现有自动生产项之后');
  } finally { f.ctx.dispose(); }
});

test('factory scheduler: full auto-production queue is preserved without reordering', async () => {
  const f = productionFixture({ autoProductId: '长货', queue: [
    { idx: 1, productId: '长货', finishTime: fixedNow / 1000 + 7200 },
    { idx: 2, productId: '长货', finishTime: 0 },
  ], slots: 2, options: { autoProduce: true } });
  try {
    await runProduction(f, [{ id: '快料', need: 1, source: 'resident' }]);
    assert.equal(f.client.calls.filter(call => call.name === 'CancelFactoryProduceRequest').length, 0);
    assert.equal(f.client.calls.filter(call => call.name === 'StartFactoryProduceRequest').length, 0);
    assert.equal(f.client.states.OnWaterRequest.building[0].factory.autoProductId, '长货');
    assert.deepEqual(f.client.states.OnWaterRequest.building[0].factory.factoryQ.map(job => job.productId), ['长货', '长货']);
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

/** 遗留的工厂收成待确认记录只跳过该写入，不能在服务重启后再次停止整个挂机。 */
test('island: pending factory harvest does not abort later automation modules', async () => {
  const f = await moduleRun('island', { collect: false, finish: false }, ({ ctx, settings }) => {
    settings.modules.island.factory.gain = true;
    settings.modules.island.factory.priorityProduce = false;
    ctx.ledger.pending['GainFactoryProduceRequest:{"buildingId":"1食品厂"}'] = {
      token: 'pending-factory-harvest', ruby: 0, module: 'island', date: businessDate(fixedNow),
    };
  }, { states: { OnWaterRequest: { building: [{ buildingId: '1食品厂', level: 1, factory: { finishedProducts: [{ type: 0, id: '食品', num: 1 }] } }] } } });
  assert.equal(f.ctx.stop.aborted, false);
  assert.equal(f.client.calls.filter(call => call.name === 'GainFactoryProduceRequest').length, 0);
  assert.equal(f.ctx.results.find(row => row.request === 'GainFactoryProduceRequest')?.status, 'uncertain');
});

/** 已无待领成品是收成已完成或已被人工领取的充分证据，可移除遗留写入锁。 */
test('island: clears a pending factory harvest once the factory has no finished products', async () => {
  const f = await moduleRun('island', { collect: false, finish: false }, ({ ctx, settings }) => {
    settings.modules.island.factory.gain = true;
    settings.modules.island.factory.priorityProduce = false;
    ctx.ledger.pending['GainFactoryProduceRequest:{"buildingId":"1食品厂"}'] = {
      token: 'finished-factory-harvest', ruby: 0, module: 'island', date: businessDate(fixedNow),
    };
  }, { states: { OnWaterRequest: { building: [{ buildingId: '1食品厂', level: 1, factory: { finishedProducts: [] } }] } } });
  assert.equal(f.ctx.ledger.pending['GainFactoryProduceRequest:{"buildingId":"1食品厂"}'], undefined);
  assert.ok(f.ctx.results.some(row => row.label === '恢复未确认工厂收成 1食品厂' && row.verifiedByRead));
  assert.equal(f.client.calls.filter(call => call.name === 'GainFactoryProduceRequest').length, 0);
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

test('hero raid: priority production finishes the order and claims only the newly reached order reward', async () => {
  const f = await moduleRun('island', { collect: false, finish: false }, ({ ctx, client, settings }) => {
    Object.assign(settings.modules.island.factory, { gain: false, priorityProduce: true });
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

/** 未启用需求优先排产时，海岛模块不能因英雄突袭订单额外扣除已有库存。 */
test('hero raid: disabled priority production leaves the order and materials untouched', async () => {
  const f = await moduleRun('island', { collect: false, finish: false }, ({ ctx, client, settings }) => {
    Object.assign(settings.modules.island.factory, { gain: false, priorityProduce: false });
    ctx.pushes.set('SCHeroRaidOpen', { raid: { raidId: 2001, startTime: fixedNow / 1000 - 1, finishTime: fixedNow / 1000 + 60, order: { orderId: 15, gotOrderId: 14, gotTimes: 11 } } });
    table(ctx, 'HeroRaidOrderCfg', [{ raidId: 2001, orderId: 15, orderList: [['食盐', 2]] }]);
    client.items.set('食盐', 2);
  }, { states: { OnWaterRequest: { building: [], workerOrder: [] } } });
  assert.equal(f.client.calls.filter(call => call.name === 'HeroRaidFinishOrderRequest').length, 0);
  assert.equal(f.client.items.get('食盐'), 2);
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

/** 同一账号连败会停用道具路径，但不能影响另一个账号的维修消费选择。 */
test('world repair: three accelerator failures switch later repairs to priced ruby without affecting another account', async () => {
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

  const other = await moduleRun('world', {
    fleet: { repairSpeedUp: true, repairSpeedUpMinRemainSecs: 20, repairThresholds: [] },
    cityWar: { enabled: true, fleets: [{ enabled: true, buildingId: '1舰队', roles: ['attack'] }] },
  }, ({ client }) => client.items.set('加速器', 1), { states: {
    MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.REPAIRING, durability: 40, maxDura: 100, repairing: { endTs: fixedNow / 1000 + 60 } }] },
  }, handlers: {
    SpeedUpRepairRequest: async ({ speedUp, buildingId }, _response, client) => {
      // 账号 B 必须优先消耗自己的加速器，不能沿用账号 A 的失败回退状态。
      assert.equal(speedUp.type, 2);
      client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === buildingId).repairing.endTs = fixedNow / 1000;
      client.items.set('加速器', 0);
    },
  } });
  assert.deepEqual(other.client.calls.filter(call => call.name === 'SpeedUpRepairRequest').map(call => call.body.speedUp.type), [2]);
  assert.equal(other.client.ruby, 1000);
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

/** 非整点启动也能派遣；每轮查询目标，但跨小时重试仍须等满配置间隔。 */
test('merchant ship: checks the current target every round and preserves its retry interval across hours', async () => {
  let now = Date.parse('2026-10-29T13:57:10+08:00');
  const ships = [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }, { buildingId: '2舰队', state: protocol.FleetState.IDLE }];
  const f = await moduleRun('world', { merchantShip: { enabled: true, retryMinutes: 5, rewardMaterials: [], fleets: [{ enabled: true, buildingId: '1舰队' }, { enabled: true, buildingId: '2舰队' }] } }, null, {
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
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootListRequest').length, beforeRetryLists + 1);

  now += 60_000;
  const retryCtx = createContext(f.args); retryCtx.setModule('world');
  try { await retryCtx.refreshStock(); await HANDLERS.world(retryCtx, f.settings.modules.world); }
  finally { retryCtx.dispose(); }
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 4);

  now = Date.parse('2026-10-29T14:07:10+08:00');
  for (const fleet of ships) fleet.state = protocol.FleetState.IDLE;
  const offHourLists = f.client.calls.filter(call => call.name === 'TreasureLootListRequest').length;
  const offHourCtx = createContext(f.args); offHourCtx.setModule('world');
  try { await offHourCtx.refreshStock(); await HANDLERS.world(offHourCtx, f.settings.modules.world); }
  finally { offHourCtx.dispose(); }
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootListRequest').length, offHourLists + 1);
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 6);
});

/** 使用新上下文读取已落盘调度，模拟下一轮执行或进程重启后的派遣判定。 */
async function rerunMerchantShip(f) {
  const ctx = createContext(f.args); ctx.setModule('world');
  try { await ctx.refreshStock(); await HANDLERS.world(ctx, f.settings.modules.world); }
  finally { ctx.dispose(); }
  return ctx;
}

/** 没有万吨货轮时不能派普通宝藏或启动等待；下一轮出现目标应立即派遣。 */
test('merchant ship: an absent target does not defer a newly appearing color-five ship', async () => {
  const f = await moduleRun('world', { merchantShip: { enabled: true, retryMinutes: 3, rewardMaterials: [], fleets: [{ enabled: true, buildingId: '1舰队' }] } }, null, {
    states: { MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] }, TreasureLootListRequest: { treasure: [{ uid: 48, color: 4 }] } },
    handlers: {
      /** 模拟网关接受派遣后占用舰队，供派遣结果读回确认。 */
      TreasureLootSendFleetsRequest: async (_body, _response, client) => { client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.MOVING; },
    },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 0);
  assert.equal(f.ctx.memory('merchantShip.schedule'), undefined);
  assert.ok(f.ctx.results.some(row => row.reason === '当前未发现万吨货轮'));
  f.client.states.TreasureLootListRequest.treasure.push({ uid: 49, color: 5 });
  await rerunMerchantShip(f);
  assert.deepEqual(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').map(call => call.body), [{ uid: 49, fleetBuildingIds: ['1舰队'] }]);
});

/** 已配置材料时仅 type=0 的命中可派遣；未命中不能消耗该货轮后续可派遣资格。 */
test('merchant ship: reward material filter ignores currency and preserves a nonmatching target for later dispatch', async () => {
  const f = await moduleRun('world', { merchantShip: { enabled: true, retryMinutes: 3, rewardMaterials: ['GOLD', '精铁'], fleets: [{ enabled: true, buildingId: '1舰队' }] } }, null, {
    states: {
      MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] },
      TreasureLootListRequest: { treasure: [{ uid: 49, color: 5, reward: { asset: [{ type: 1, id: 'GOLD', num: 20840 }, { type: 0, id: '宠物经验', num: 8070 }] } }] },
    },
    handlers: {
      /** 模拟网关确认派遣后占用舰队，验证材料随后出现即可立即继续。 */
      TreasureLootSendFleetsRequest: async (_body, _response, client) => { client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.MOVING; },
    },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 0);
  assert.equal(f.ctx.memory('merchantShip.schedule'), undefined);
  assert.match(f.ctx.results.find(row => row.status === 'skipped')?.reason ?? '', /未出现设置材料：GOLD、精铁/);

  f.client.states.TreasureLootListRequest.treasure[0].reward.asset.push({ type: 0, id: '精铁', num: 650 });
  await rerunMerchantShip(f);
  assert.deepEqual(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').map(call => call.body), [{ uid: 49, fleetBuildingIds: ['1舰队'] }]);
});

/** 0 间隔禁止同目标重试，换目标不受上一艘货轮限制；未选舰队不能被自动派出。 */
test('merchant ship: zero retry attempts each target once and a new UID is immediately eligible', async () => {
  const f = await moduleRun('world', { merchantShip: { enabled: true, retryMinutes: 0, rewardMaterials: [], fleets: [{ enabled: true, buildingId: '1舰队' }, { enabled: false, buildingId: '2舰队' }] } }, null, {
    states: { MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }, { buildingId: '2舰队', state: protocol.FleetState.IDLE }] }, TreasureLootListRequest: { treasure: [{ uid: 49, color: 5 }] } },
    handlers: {
      /** 仅改变请求中指定的舰队，避免掩盖派出了未选舰队的错误。 */
      TreasureLootSendFleetsRequest: async ({ fleetBuildingIds }, _response, client) => { client.states.MyFleetsRequest.fleets.find(fleet => fleet.buildingId === fleetBuildingIds[0]).state = protocol.FleetState.MOVING; },
    },
  });
  f.client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.IDLE;
  await rerunMerchantShip(f);
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 1);
  f.client.states.TreasureLootListRequest.treasure[0].uid = 50;
  await rerunMerchantShip(f);
  assert.deepEqual(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').map(call => call.body), [{ uid: 49, fleetBuildingIds: ['1舰队'] }, { uid: 50, fleetBuildingIds: ['1舰队'] }]);
});

/** 全部忙碌不消耗首次派遣资格，旧的小时记录也不能阻止当前目标执行。 */
test('merchant ship: busy fleets remain eligible after returning idle despite a stale hourly schedule', async () => {
  const f = await moduleRun('world', { merchantShip: { enabled: true, retryMinutes: 0, rewardMaterials: [], fleets: [{ enabled: true, buildingId: '1舰队' }] } }, ({ ctx }) => {
    ctx.memory('merchantShip.schedule', { key: '2026-10-29T07', retryAt: 0 });
  }, {
    states: { MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.MOVING }] }, TreasureLootListRequest: { treasure: [{ uid: 49, color: 5 }] } },
    handlers: {
      /** 模拟舰队再次出发后的状态，验证从忙碌恢复空闲确实触发了派遣。 */
      TreasureLootSendFleetsRequest: async (_body, _response, client) => { client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.MOVING; },
    },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 0);
  assert.ok(f.ctx.results.some(row => row.reason === '万吨货轮已出现，所选舰队当前无空闲舰队'));
  f.client.states.MyFleetsRequest.fleets[0].state = protocol.FleetState.IDLE;
  const ctx = await rerunMerchantShip(f);
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 1);
  assert.deepEqual(ctx.memory('merchantShip.schedule'), { targetUid: '49', retryAt: 0 });
});

/** 预览只计划当前目标，不消耗真正执行时的首次派遣资格。 */
test('merchant ship: dry-run leaves the target retry schedule untouched', async () => {
  const f = await moduleRun('world', { merchantShip: { enabled: true, retryMinutes: 3, rewardMaterials: [], fleets: [{ enabled: true, buildingId: '1舰队' }] } }, null, {
    dryRun: true,
    states: { MyFleetsRequest: { fleets: [{ buildingId: '1舰队', state: protocol.FleetState.IDLE }] }, TreasureLootListRequest: { treasure: [{ uid: 49, color: 5 }] } },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'TreasureLootSendFleetsRequest').length, 0);
  assert.ok(f.ctx.results.some(row => row.request === 'TreasureLootSendFleetsRequest' && row.status === 'planned'));
  assert.equal(f.ctx.memory('merchantShip.schedule'), undefined);
});

test('merchant ship: takes configured fleets before same-round repairs can occupy them', async () => {
  const now = () => Date.parse('2026-10-29T15:00:10+08:00');
  const f = await moduleRun('world', {
    merchantShip: { enabled: true, retryMinutes: 0, rewardMaterials: [], fleets: [{ enabled: true, buildingId: '1舰队' }] },
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
    merchantShip: { enabled: true, retryMinutes: 3, rewardMaterials: [], fleets: [{ enabled: true, buildingId: '1舰队' }] },
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

test('city war: online reward reads the server claim count before requesting the next tier', async () => {
  const now = () => Date.parse('2026-10-29T20:45:00+08:00');
  const f = await moduleRun('world', { cityWar: { enabled: true, online: true, reattack: false, fleets: [] } }, null, {
    now,
    states: {
      WarDeclarationRequest: { startTime: now() / 1000 - 1, endTime: now() / 1000 + 60, declarations: [] },
      CounterInfoRequest: { counters: [{ type: 'DAILY_WORLD_ONLINE_RWD', num: 1 }] },
    },
    handlers: {
      GotWorldOnlineRwdRequest: async (_body, _response, client) => {
        client.states.CounterInfoRequest.counters[0].num += 1;
        client.items.set('汽油', (client.items.get('汽油') ?? 0) + 1);
        return { reward: { asset: [{ type: 0, id: '汽油', num: 1 }] } };
      },
    },
  });
  assert.equal(f.client.calls.filter(call => call.name === 'CounterInfoRequest').length, 7);
  assert.equal(f.client.calls.filter(call => call.name === 'GotWorldOnlineRwdRequest').length, 6);
  assert.equal(f.client.states.CounterInfoRequest.counters[0].num, 7);
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
    TradeInfoRequest: { period: 1, cargo: { cargoLv: 1, cityId: 7 }, player: { coins: 0, goods: [{ pid: 11, goodsId: 12, num: 2, buyPrice: 1 }] } },
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
    TradeInfoRequest: { period: 1, cargo: { cargoLv: 1, cityId: 7 }, player: { coins: 0, goods: [{ pid: 1, goodsId: 12, num: 1, buyPrice: 50 }] } },
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
    TradeInfoRequest: { period: 1, cargo: { cityId: 7 }, player: { coins: 0, goods: [{ pid: 11, goodsId: 12, num: 2, buyPrice: 1 }] } },
    TradeCityRequest: { isReport: true, goods: [{ goodsId: 14, stock: 0, price: 10 }] },
  }, handlers: {
    TradeSellRequest: async (_, response, client) => { client.states.TradeInfoRequest.player.coins = 20; client.states.TradeInfoRequest.player.goods = []; return {}; },
  } });
  assert.equal(f.client.calls.filter(call => call.name === 'TradeBuyRequest').length, 0);
  assert.match(f.ctx.results.find(result => result.status === 'skipped')?.reason ?? '', /贸易城市没有库存商品/);
});

test('guild order and tech: daily cap stops recruitment, technology uses remaining current points', async () => {
  const f = await moduleRun('guild', { order: { enabled: 'always', cityIds: [3], dailyLimit: 1 }, tech: { enabled: true, items: [4] } }, ({ ctx, client }) => {
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


const { EXECUTION_MODES, modeActive, serverTime, shanghaiWeekday, hasConfiguredAutomation } = await import('../src/automation/schedule.mjs');
const { claimCrossRank, claimBattlePass, prepareDailyBreed, runFixedRoutines } = await import('../src/automation/routines.mjs');

test('competition settings: disk migration is atomic and one-time; API only accepts each field enum', () => {
  const legacy = defaultSettings();
  for (const location of Object.keys(EXECUTION_MODES)) {
    const keys = location.split('.'), key = keys.pop();
    keys.reduce((node, part) => node[part], legacy)[key] = true;
  }
  legacy.modules.equip.enabled = false;
  legacy.modules.resident.minGold = 1234; delete legacy.modules.resident.thursdayMinGold;
  const file = path.join(accountDirectory('competition-migration'), 'settings.json');
  writeJson(file, legacy);
  const migrated = loadSettings('competition-migration');
  assert.equal(migrated.modules.resident.thursdayMinGold, 1234);
  assert.equal(migrated.modules.pet.enabled, 'always');
  assert.equal(migrated.modules.equip.enabled, 'off');
  assert.equal(JSON.parse(fs.readFileSync(file)).modules.antique.upgrade, 'always');
  const mtime = fs.statSync(file).mtimeMs;
  loadSettings('competition-migration'); assert.equal(fs.statSync(file).mtimeMs, mtime);
  for (const [location, day] of Object.entries(EXECUTION_MODES)) {
    const keys = location.split('.'), key = keys.pop();
    for (const value of ['off', 'always', day]) {
      const settings = defaultSettings(); keys.reduce((node, part) => node[part], settings)[key] = value;
      assert.equal(keys.reduce((node, part) => node[part], validateSettings(settings))[key], value);
      saveSettings('competition-saved', settings);
      assert.equal(keys.reduce((node, part) => node[part], loadSettings('competition-saved'))[key], value);
    }
    for (const value of [true, false, 'sunday', 'bogus']) {
      const settings = defaultSettings(); keys.reduce((node, part) => node[part], settings)[key] = value;
      assert.throws(() => validateSettings(settings), /off/);
    }
  }
  const defaults = defaultSettings();
  assert.equal(defaults.modules.pet.dailyBreedForPass, false);
  assert.equal(defaults.modules.island.factory.mondayGuildPriority, false);
  assert.equal(defaults.modules.resident.thursdayMinGold, 0);
  defaults.modules.pet.enabled = 'tuesday'; assert.equal(hasConfiguredAutomation(defaults), true);
});

test('competition dates: Shanghai midnight and connection clock correction guard every write', async () => {
  let now = Date.parse('2026-11-02T23:59:59+08:00');
  const f = fixture({ now: () => now }); f.ctx.setModule('pet'); f.settings.modules.pet.enabled = 'tuesday';
  assert.equal(shanghaiWeekday(serverTime(f.ctx)), 'monday');
  assert.equal(modeActive('tuesday', serverTime(f.ctx)), false);
  f.client.serverClockOffsetMs = 2000;
  assert.equal(shanghaiWeekday(serverTime(f.ctx)), 'tuesday');
  await f.ctx.refreshStock();
  assert.equal((await f.ctx.action('GetMaturePetRequest', {}, { confirm: async () => true })).status, 'success');
  now = Date.parse('2026-11-03T23:59:59+08:00');
  assert.equal((await f.ctx.action('GetMaturePetRequest', {}, { confirm: async () => true })).status, 'skipped');
  assert.equal(f.client.calls.filter(row => row.name === 'GetMaturePetRequest').length, 1);
  f.ctx.dispose();
});

test('competition dates: off-day pet and equipment remain configured without executing', async () => {
  const f = fixture(); f.settings.modules.pet.enabled = 'tuesday'; f.settings.modules.equip.enabled = 'friday';
  const result = await runAutomation({ ...f.args, settings: f.settings, selector: ['pet', 'equip'] });
  assert.equal(result.error, null);
  assert.deepEqual(result.results.map(row => row.status), ['skipped', 'skipped']);
  assert.equal(hasConfiguredAutomation(f.settings), true);
  assert.equal(f.client.calls.length, 0); f.ctx.dispose();
});

/** 提供分组等级介于两档之间的真实协议快照，验证向下匹配与角色 int64 精度。 */
function crossFixture() {
  const f = fixture({ states: { CrossRankInfoRequest: { roomLevel: 42, subjectId: 1, gotDailyRewardIdx: 0,
    rankList: [{ playerId: '9007199254740993', score: 17000 }] } } });
  f.ctx.setModule('welfare');
  table(f.ctx, 'CrossRankDailyRwdCfg', [1, 41, 45].flatMap(level => [1500, 6000, 12000, 18000].map(needScore => ({ level, subjectId: 1, needScore: level === 45 ? 1 : level === 1 ? needScore / 10 : needScore }))));
  return f;
}

for (const batch of [1, 3]) test(`cross boxes: claim all available tiers with batch size ${batch}`, async () => {
  const f = crossFixture();
  f.client.handlers.GetDailyRewardRequest = async (body, response) => {
    assert.deepEqual(body, {}); assert.equal(response, 'GotRewardResponse');
    f.client.states.CrossRankInfoRequest.gotDailyRewardIdx += batch;
    return {};
  };
  await claimCrossRank(f.ctx);
  assert.equal(f.client.states.CrossRankInfoRequest.gotDailyRewardIdx, 3);
  assert.equal(f.client.calls.filter(row => row.name === 'GetDailyRewardRequest').length, batch === 1 ? 3 : 1);
  await claimCrossRank(f.ctx);
  assert.equal(f.client.calls.filter(row => row.name === 'GetDailyRewardRequest').length, batch === 1 ? 3 : 1);
  f.ctx.dispose();
});

for (const problem of ['missing role', 'missing progress', 'grouping', 'no progress', 'rejected', 'timeout', 'midnight']) test(`cross boxes: safely stop on ${problem}`, async () => {
  const f = crossFixture();
  const state = f.client.states.CrossRankInfoRequest;
  if (problem === 'missing role') state.rankList = [];
  if (problem === 'missing progress') delete state.gotDailyRewardIdx;
  if (problem === 'grouping') state.grouping = true;
  f.client.handlers.GetDailyRewardRequest = async () => {
    if (problem === 'rejected') { const error = new Error('明确拒绝'); error.prompt = true; throw error; }
    if (problem === 'timeout') throw new Error('timeout');
    if (problem === 'midnight') { state.gotDailyRewardIdx = 3; f.client.serverClockOffsetMs = 86400_000; }
    return {};
  };
  await runFixedRoutines(f.ctx, 'after');
  assert.equal(f.client.calls.filter(row => row.name === 'GetDailyRewardRequest').length, ['missing role', 'missing progress', 'grouping'].includes(problem) ? 0 : 1);
  assert.equal(f.ctx.stop.aborted, false);
  if (['no progress', 'timeout'].includes(problem)) {
    await runFixedRoutines(f.ctx, 'after');
    assert.equal(f.client.calls.filter(row => row.name === 'GetDailyRewardRequest').length, 1);
  }
  f.ctx.dispose();
});

/** 周战令夹具每次写只推进一个目标，迫使执行器读回并继续，而非单次请求后返回。 */
function passFixture({ activePay = false, taskProgress = 0 } = {}) {
  const f = fixture({ states: {
    WeekInfoRequest: { activityTime: [{ type: 1, period: 2012, startTime: fixedNow / 1000 - 3600, endTime: fixedNow / 1000 + 86400 }] },
    WeekBattlePassInfoRequest: { score: 0, activePay, got: [], task: [{ taskId: 1003, progress: taskProgress, isGot: false }] },
    OnWaterRequest: { building: [{ buildingId: '1宠物', petBreed: { maxQLength: 2, breedQ: [], maturePets: [] } }] },
  } });
  f.ctx.setModule('welfare');
  table(f.ctx, 'WeekPassTaskCfg', [{ taskId: 1003, type: '培育海兽', target: 1, score: 100, desc: '培育1只海兽' }]);
  table(f.ctx, 'WeekBattlePassCfg', [1, 2, 3].map(rwdId => ({ periodId: 2012, rwdId, reqScore: rwdId * 100, freeReward: [['木材', 1]], payReward: [['木材', 2]] })));
  table(f.ctx, 'BuildingCfg', [{ buildingType: '宠物', name: '宠物' }]);
  return f;
}

for (const activePay of [false, true]) test(`battle pass: all task points and stages; paid activated=${activePay}`, async () => {
  const f = passFixture({ activePay, taskProgress: 1 });
  const state = f.client.states.WeekBattlePassInfoRequest;
  state.task.push({ taskId: 1001, progress: 1, isGot: false }, { taskId: 1002, progress: 1, isGot: false });
  f.ctx.config.tables.WeekPassTaskCfg.data.push(...[1001, 1002].map(taskId => ({ taskId, target: 1, score: 100, desc: String(taskId) })));
  f.client.handlers.WeekBattlePassFinishTaskRequest = async ({ taskId }) => {
    state.task.find(row => row.taskId === taskId).isGot = true; state.score += 100; return { score: state.score };
  };
  f.client.handlers.WeekBattlePassGotRewardRequest = async () => {
    const stage = [1, 2, 3].find(stage => !state.got.some(row => row.stage === stage));
    state.got.push({ stage, freeGot: true, payGot: activePay }); return { got: state.got };
  };
  await claimBattlePass(f.ctx);
  assert.equal(state.score, 300); assert.equal(state.got.length, 3);
  assert.equal(f.client.calls.filter(row => row.name === 'WeekBattlePassFinishTaskRequest').length, 3);
  assert.equal(f.client.calls.filter(row => row.name === 'WeekBattlePassGotRewardRequest').length, 3);
  assert.ok(state.got.every(row => row.payGot === activePay));
  await claimBattlePass(f.ctx);
  assert.equal(f.client.calls.filter(row => row.name === 'WeekBattlePassGotRewardRequest').length, 3); f.ctx.dispose();
});

test('battle pass: task and stage stagnation never resend an uncertain write', async () => {
  for (const phase of ['task', 'stage']) {
    const f = passFixture({ taskProgress: phase === 'task' ? 1 : 0 });
    if (phase === 'stage') f.client.states.WeekBattlePassInfoRequest.score = 100;
    await claimBattlePass(f.ctx); await claimBattlePass(f.ctx);
    const name = phase === 'task' ? 'WeekBattlePassFinishTaskRequest' : 'WeekBattlePassGotRewardRequest';
    assert.equal(f.client.calls.filter(row => row.name === name).length, 1); f.ctx.dispose();
  }
});

/** 配方含缺料低品质、可用蓝色多项和紫色，用于验证可用性与排序规则。 */
function breedFixture() {
  const f = passFixture(); f.settings.modules.pet.dailyBreedForPass = true; f.settings.season = 1;
  // createContext 的 season 是构造时快照，夹具明确给出本场景当前赛季。
  f.ctx.season = 1;
  table(f.ctx, 'PetBreedCfg', [
    { petId: '缺料蓝色', qualityIndex: 1, season: 1, breedTime: 1, cost: [['缺少基因', 1]] },
    { petId: '紫色', qualityIndex: 2, season: 1, breedTime: 1, cost: [['基因', 1]] },
    { petId: '蓝B', qualityIndex: 1, season: 1, breedTime: 10, cost: [['基因', 1]] },
    { petId: '蓝A', qualityIndex: 1, season: 1, breedTime: 10, cost: [['基因', 1]] },
    { petId: '慢蓝', qualityIndex: 1, season: 1, breedTime: 20, cost: [['基因', 1]] },
    { petId: '未开放', qualityIndex: 1, season: 2, breedTime: 0, cost: [['基因', 1]] },
  ]);
  f.client.items.set('基因', 10);
  f.client.handlers.PetBreedRequest = async body => {
    assert.equal(body.universal, false);
    f.client.states.OnWaterRequest.building[0].petBreed.breedQ.push({ idx: 12, petId: body.petId, startTime: fixedNow / 1000, finishTime: fixedNow / 1000 + 10 });
  };
  return f;
}

test('daily breed: pet off still supplements once, lowest available quality and deterministic recipe; survives restart', async () => {
  const f = breedFixture(); assert.equal(f.settings.modules.pet.enabled, 'off');
  await prepareDailyBreed(f.ctx); await prepareDailyBreed(f.ctx);
  assert.deepEqual(f.client.calls.filter(row => row.name === 'PetBreedRequest').map(row => row.body), [{ petId: '蓝A', universal: false }]);
  f.ctx.dispose();
  const restored = createContext(f.args); restored.setModule('welfare'); restored.season = 1;
  await prepareDailyBreed(restored);
  assert.equal(f.client.calls.filter(row => row.name === 'PetBreedRequest').length, 1); restored.dispose();
});

for (const situation of ['complete', 'claimed', 'missing task', 'missing progress', 'full', 'materials', 'closed']) test(`daily breed: skip ${situation}`, async () => {
  const f = breedFixture(), state = f.client.states.WeekBattlePassInfoRequest;
  if (situation === 'complete') state.task[0].progress = 1;
  if (situation === 'claimed') state.task[0].isGot = true;
  if (situation === 'missing task') state.task = [];
  if (situation === 'missing progress') delete state.task[0].progress;
  if (situation === 'full') f.client.states.OnWaterRequest.building[0].petBreed.maxQLength = 0;
  if (situation === 'materials') f.client.items.clear();
  if (situation === 'closed') f.client.states.WeekInfoRequest.activityTime = [];
  await prepareDailyBreed(f.ctx);
  assert.equal(f.client.calls.filter(row => row.name === 'PetBreedRequest' || row.name === 'GetMaturePetRequest').length, 0); f.ctx.dispose();
});

test('daily breed: unresolved intent blocks repeats after restart, late queue confirmation settles without another request', async () => {
  const f = breedFixture(); f.client.handlers.PetBreedRequest = async () => { throw new Error('timeout'); };
  await prepareDailyBreed(f.ctx);
  assert.ok(f.ctx.memory('dailyBreedForPass').intent); f.ctx.dispose();
  const restored = createContext(f.args); restored.setModule('welfare'); restored.season = 1;
  await prepareDailyBreed(restored);
  assert.equal(f.client.calls.filter(row => row.name === 'PetBreedRequest').length, 1);
  f.client.states.OnWaterRequest.building[0].petBreed.breedQ.push({ idx: 99, petId: '蓝A', startTime: fixedNow / 1000, finishTime: fixedNow / 1000 + 10 });
  await prepareDailyBreed(restored);
  assert.equal(restored.memory('dailyBreedForPass').done, true);
  assert.equal(Object.keys(restored.ledger.pending).length, 0);
  assert.equal(f.client.calls.filter(row => row.name === 'PetBreedRequest').length, 1); restored.dispose();
});

test('competition UI: exact enum choices and explanations, supplemental and Thursday controls follow their primary setting', () => {
  const context = automationFormContext();
  const choices = vm.runInContext('executionModes', context);
  assert.deepEqual(Object.keys(choices).sort(), Object.keys(EXECUTION_MODES).sort());
  const { settingCopy } = automationCopyHelpers();
  assert.equal(settingCopy(['modules','antique','upgrade'], 'upgrade').title, '自动升星');
  assert.match(settingCopy(['modules','resident','thursdayMinGold'], 'thursdayMinGold').note, /基地订单日金币奖励越高，比拼积分越多/);
  assert.match(settingCopy(['modules','pet','dailyBreedForPass'], 'dailyBreedForPass').note, /独立于普通宠物/);
  assert.deepEqual(Object.keys(defaultSettings().modules.pet).slice(0, 2), ['enabled','dailyBreedForPass']);
  const keys = Object.keys(defaultSettings().modules.resident); assert.equal(keys.indexOf('thursdayMinGold'), keys.indexOf('minGold') + 1);
});


for (const [day, threshold, accepted] of [
  ['2026-11-04', 100, true], ['2026-11-05', 100, false], ['2026-11-05', 0, true],
]) test(`Thursday orders: replacement gold=${threshold} on ${day}, accepted=${accepted}`, async () => {
  const f = await moduleRun('resident', { orderReward: false, minGold: 10, thursdayMinGold: threshold }, ({ ctx, client }) => {
    client.items.set('木材', 1);
    table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['GOLD', 20]] }]);
  }, { dryRun: true, now: () => Date.parse(`${day}T12:00:00+08:00`), states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ id: '木材', type: 0, num: 1 }] }] } } });
  assert.equal(f.ctx.results.find(row => row.status === 'planned')?.request, accepted ? 'FinishWorkerOrderRequest' : 'DenyOrderRequest');
});

test('Thursday orders: actual special reward uses Thursday threshold instead of ordinary reward estimate', async () => {
  const f = await moduleRun('resident', { orderReward: false, minGold: 1000, thursdayMinGold: 50 }, ({ ctx, client }) => {
    client.items.set('木材', 1);
    table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['GOLD', 1]] }]);
    table(ctx, 'WorkerSpecOrderCfg', [{ times: '7', reward: [['GOLD', 60]] }]);
  }, { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, isSpecial: true, textId: '7', requirements: [{ id: '木材', type: 0, num: 1 }] }] } } });
  assert.equal(f.ctx.results.find(row => row.status === 'planned')?.request, 'FinishWorkerOrderRequest');
});

test('demand sources: preserve guild identity and share stock once, crop shortage stays aggregated', async () => {
  const { demand } = await import('../src/automation/base.mjs');
  const f = fixture({ states: { OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ id: '玉米', type: 0, num: 3 }] }] },
    GuildInfoRequest: { guild: { guildId: '1' } }, GuildOrderRequest: { order: { requirements: [{ id: '玉米', type: 0, num: 4 }] } } } });
  f.client.items.set('玉米', 2); await f.ctx.refreshStock();
  const full = await demand(f.ctx, ['resident', 'guild'], { includeCovered: true });
  assert.deepEqual(full.map(row => [row.source, row.need, row.lack]), [['resident', 3, 1], ['guild', 4, 4]]);
  const crops = await demand(f.ctx, ['resident', 'guild']);
  assert.equal(crops.length, 1); assert.equal(crops[0].lack, 5); f.ctx.dispose();
});

test('legacy task entry: guild and ordinary pet/equipment cannot bypass off-day modes', async () => {
  const f = fixture(); f.settings.modules.guild.enabled = true; f.settings.modules.guild.order.enabled = 'monday';
  f.settings.modules.pet.enabled = 'tuesday'; f.settings.modules.equip.enabled = 'friday';
  f.ctx.setModule('dailies');
  for (const step of [
    { request: 'FinishGuildOrderRequest', body: { cityId: 1 } },
    { request: 'PetBreedRequest', body: { petId: '蓝A', universal: false } },
    { request: 'PickMadeEquipRequest', body: { buildingId: '1装备' } },
  ]) await assert.rejects(legacyAction(f.ctx, step), /执行日期/);
  assert.ok(!f.client.calls.some(row => ['FinishGuildOrderRequest','PetBreedRequest','PickMadeEquipRequest'].includes(row.name)));
  f.ctx.dispose();
});

for (const automationOnly of [false, true]) test(`main loop fixed routines: independence from welfare and standalone exclusion=${automationOnly}`, async () => {
  const { runLoop } = await import('../src/loop.mjs');
  const { automationTasks } = await import('../src/automation.mjs');
  assert.equal(automationTasks.some(row => row.key === 'weekPass'), false);
  const f = breedFixture();
  f.settings.modules.cargo.enabled = true; f.settings.modules.cargo.fill = false; f.settings.modules.cargo.reward = false;
  saveSettings(f.args.accountId, f.settings);
  const now = Date.now() / 1000;
  Object.assign(f.client.states.WeekInfoRequest.activityTime[0], { startTime: Math.floor(now - 60), endTime: Math.floor(now + 3600) });
  f.client.states.CrossRankInfoRequest = { roomLevel: 42, subjectId: 1, gotDailyRewardIdx: 0, rankList: [{ playerId: f.args.player.playerId, score: 1000 }] };
  table(f.ctx, 'CrossRankDailyRwdCfg', [{ subjectId: 1, level: 41, needScore: 10 }]);
  const breed = f.client.handlers.PetBreedRequest;
  f.client.handlers.PetBreedRequest = async body => { await breed(body); f.client.states.WeekBattlePassInfoRequest.task[0].progress = 1; };
  f.client.handlers.GetDailyRewardRequest = async () => { f.client.states.CrossRankInfoRequest.gotDailyRewardIdx = 1; return {}; };
  f.client.handlers.WeekBattlePassFinishTaskRequest = async () => { const state = f.client.states.WeekBattlePassInfoRequest; state.task[0].isGot = true; state.score = 100; return { score: 100 }; };
  f.client.handlers.WeekBattlePassGotRewardRequest = async () => { f.client.states.WeekBattlePassInfoRequest.got = [{ stage: 1, freeGot: true }]; return { got: [{ stage: 1, freeGot: true }] }; };
  f.ctx.dispose();
  await runLoop(f.client, protocol, { accountId: f.args.accountId, player: f.args.player, config: f.args.config,
    allowMutate: true, isEnabled: () => false, automationOnly, automationModules: ['cargo'], rounds: 1 });
  const names = f.client.calls.map(row => row.name);
  assert.ok(names.includes('CargoShipsRequest'));
  assert.equal(names.includes('PetBreedRequest'), !automationOnly);
  assert.equal(names.includes('GetDailyRewardRequest'), !automationOnly);
  assert.equal(names.includes('WeekBattlePassGotRewardRequest'), !automationOnly);
  if (!automationOnly) {
    assert.ok(names.indexOf('PetBreedRequest') < names.indexOf('CargoShipsRequest'));
    assert.ok(names.indexOf('CargoShipsRequest') < names.indexOf('GetDailyRewardRequest'));
  }
});


/** 构造最小 DOM 节点以运行实际标量渲染器，检查控件顺序、类型、选项与回显。 */
function scalarForm(value, path) {
  const context = automationFormContext();
  /** 只实现标量控件需要的标准节点接口，不模拟任何业务保存行为。 */
  function element(tag, className, text) {
    return { tag, className, text, children: [], dataset: {}, attributes: {},
      /** 控件追加后保留真实顺序供断言。 */
      appendChild(child) { this.children.push(child); return child; },
      /** 收集标签与无障碍属性，避免渲染过程跳过标准接口。 */
      setAttribute(key, value) { this.attributes[key] = value; },
    };
  }
  context.el = element;
  /** 原生 Option 的文本和值在本测试中原样保留。 */
  context.Option = function Option(text, value) { return { tag: 'option', text, value }; };
  context.value = value; context.path = path; context.parent = element('div');
  vm.runInContext('settingFields(value, path, parent)', context);
  return context.parent.children.map(label => ({ label, control: label.children.at(-1) }));
}

test('competition UI: renderer produces real selects with correct values, labels, and neighboring fields', () => {
  const pet = scalarForm({ enabled: 'tuesday', dailyBreedForPass: true }, ['modules', 'pet']);
  assert.equal(pet[0].control.tag, 'select'); assert.equal(pet[0].control.value, 'tuesday');
  assert.deepEqual(pet[0].control.children.map(option => [option.value, option.text]), [['off','关闭'],['always','开启'],['tuesday','周二开启']]);
  assert.equal(pet[0].control.dataset.kind, 'string'); assert.equal(pet[1].control.type, 'checkbox');
  assert.equal(pet[1].control.dataset.setting, 'modules.pet.dailyBreedForPass');
  const resident = scalarForm({ minGold: 20, thursdayMinGold: 90 }, ['modules','resident']);
  assert.equal(resident[1].control.dataset.setting, 'modules.resident.thursdayMinGold');
  for (const [path, field, day, title] of [
    [['modules','guild','order'], 'enabled','monday','执行模式'],
    [['modules','equip'], 'enabled','friday','执行模式'],
    [['modules','antique'], 'upgrade','wednesday','自动升星'],
    [['modules','antique','suit'], 'activate','wednesday','激活'],
  ]) {
    const [{ control, label }] = scalarForm({ [field]: day }, path);
    assert.equal(control.tag, 'select'); assert.equal(control.value, day);
    assert.equal(control.children.length, 3); assert.equal(label.children[0].children[0].text, title);
  }
});

test('battle pass: changed score cannot bypass an unresolved stage claim; late readback safely resumes', async () => {
  const f = passFixture(); const state = f.client.states.WeekBattlePassInfoRequest;
  state.score = 100;
  await claimBattlePass(f.ctx);
  state.score = 200;
  await claimBattlePass(f.ctx);
  assert.equal(f.client.calls.filter(row => row.name === 'WeekBattlePassGotRewardRequest').length, 1);
  state.got = [{ stage: 1, freeGot: true }];
  f.client.handlers.WeekBattlePassGotRewardRequest = async () => { state.got.push({ stage: 2, freeGot: true }); return { got: state.got }; };
  await claimBattlePass(f.ctx);
  assert.equal(state.got.length, 2);
  assert.equal(Object.keys(f.ctx.ledger.pending).length, 0); f.ctx.dispose();
});

test('daily breed: corresponding gold costs break quality/time ties without spending diamonds', async () => {
  const f = breedFixture();
  f.client.handlers.AllResourceRequest = async () => ({ list: [{ res: protocol.Resource.GOLD, amount: 9 }, { res: protocol.Resource.RUBY, amount: 1000 }] });
  table(f.ctx, 'PetBreedCfg', [
    { petId: '便宜', qualityIndex: 1, season: 1, breedTime: 10, cost: [['基因', 1], ['GOLD', 2]] },
    { petId: '昂贵', qualityIndex: 1, season: 1, breedTime: 10, cost: [['基因', 1], ['GOLD', 9]] },
    { petId: '买钻石', qualityIndex: 1, season: 1, breedTime: 1, cost: [['RUBY', 1]] },
  ]);
  await prepareDailyBreed(f.ctx);
  assert.equal(f.client.calls.find(row => row.name === 'PetBreedRequest').body.petId, '便宜');
  assert.equal(f.client.ruby, 1000); f.ctx.dispose();
});

test('daily breed: reused queue index with a new server start time confirms a new task', async () => {
  const f = breedFixture(), room = f.client.states.OnWaterRequest.building[0].petBreed;
  room.breedQ.push({ idx: 12, petId: '蓝A', startTime: fixedNow / 1000 - 1000, finishTime: fixedNow / 1000 - 900 });
  await prepareDailyBreed(f.ctx);
  assert.equal(f.ctx.memory('dailyBreedForPass').done, true); f.ctx.dispose();
});

test('special orders: missing actual reward config does not borrow ordinary reward estimates', async () => {
  const f = await moduleRun('resident', { orderReward: false, thursdayMinGold: 50 }, ({ ctx, client }) => {
    client.items.set('木材', 1); table(ctx, 'WorkerOrderCfg', [{ itemId: '木材', reward: [['GOLD', 100]] }]);
  }, { dryRun: true, states: { OnWaterRequest: { workerOrder: [{ index: 1, isSpecial: true, textId: '7', requirements: [{ id: '木材', type: 0, num: 1 }] }] } } });
  assert.equal(f.ctx.results.filter(row => row.status === 'planned').length, 0);
  assert.ok(f.ctx.results.some(row => /缺少特殊订单/.test(row.reason)));
});
