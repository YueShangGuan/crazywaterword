import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from '../accounts.mjs';
import { EXECUTION_MODES } from './schedule.mjs';

export const MODULES = ['island', 'farm', 'resident', 'cargo', 'choiceEvent', 'gather', 'afk', 'hero', 'antique', 'pet', 'equip', 'museum', 'battle', 'world', 'guild', 'welfare', 'activity', 'snap'];
export const LABELS = { island: '建筑与工厂', farm: '农田', resident: '居民订单', cargo: '货船', choiceEvent: '选择事件', gather: '采集', afk: '挂机收益', hero: '英雄', antique: '藏品', pet: '宠物', equip: '装备', museum: '博物馆', battle: '挑战', world: '世界', guild: '联盟', welfare: '福利', activity: '活动', snap: '水世界牌' };
// 只限制循环入口；历史设置和单次自动化仍需保留模块 ID 以读取已有账号配置。
const LOOP_DISABLED_MODULES = new Set(['snap']);

/** 网页、CLI 与循环共同验证模块选择，错误选择必须在登录或排队之前拒绝。 */
export function selectModules(selector = 'all') {
  const selected = selector === 'all' ? [...MODULES] : Array.isArray(selector) ? selector : [selector];
  if (!selected.length || selected.some(id => !MODULES.includes(id))) throw new Error('请选择有效自动化模块');
  return [...new Set(selected)];
}

/** 校验循环模块；已下架的水世界牌不再参与循环，显式选择时直接拒绝。 */
export function selectLoopModules(selector = 'all') {
  const selected = selector === 'all' ? MODULES.filter(id => !LOOP_DISABLED_MODULES.has(id)) : selectModules(selector);
  if (selected.some(id => LOOP_DISABLED_MODULES.has(id))) throw new Error('水世界牌已下架，不能加入循环模块');
  return [...new Set(selected)];
}

/**
 * 构造新账号和旧账号补全所需的安全默认设置。
 *
 * @returns {object} 默认关闭消费与自动化写入的完整设置。
 */
export function defaultSettings() {
  return {
    season: 0,
    // VIP免广告只保存用户意图，真正是否生效由当前连接角色资格决定。
    vipFreeAd: false,
    // 连接异常通知默认关闭，避免新账号在未配置 webhook 时产生外部请求。
    notifications: { wecom: { enabled: false, webhook: '' } },
    spending: { enabled: false, dailyLimit: 0, minRubyStock: 0, clickGoldTimes: 0, dailiesDiscountTickets2x: false, modules: Object.fromEntries([...MODULES, 'dailies'].map(id => [id, 0])) },
    modules: {
      island: { enabled: false, collect: true, finish: true, build: false, upgrade: false, speedUp: false, disabledBuildings: [], factory: {
        gain: true, autoProduce: false, products: {}, disabledFactories: [], priorityProduce: false, mondayGuildPriority: false, proposedPriority: ['resident', 'cargo', 'guild'], speedUpForDemand: false,
        // 分档只使用单件实际耗时；库存目标是订单/配方消耗之外的余量，不默认补满仓。
        fastTimeSecs: 300, shortTimeSecs: 600, fastStockLow: 5, fastStockHigh: 10, shortStockLow: 3, shortStockHigh: 5,
        priorityBurstLimit: 3, reorderQueue: true,
      } },
      farm: { enabled: false, harvest: true, plant: false, cropPriorities: {}, cropKeepStock: {}, priorityPlant: false, seedOnDemand: false, speedUp: false, speedUpMaxActions: 8 },
      resident: { enabled: false, orderReward: true, blockedMaterials: [], skipCropOrders: false, minExp: 0, minGold: 0, thursdayMinGold: 0, dailyCap: 0 },
      cargo: { enabled: false, fill: true, reward: true }, choiceEvent: { enabled: false, optionIndex: 1 },
      gather: { enabled: false, fishing: false, maxFishCasts: 12, floater: false, floaterCollectWhenFull: false, openChests: false, maxChests: 20, diving: false, divingEach: 20, salvage: false, salvageEach: 30, enhance: { fishing: false, diving: false, salvage: false }, enhanceTargetLevel: 2 },
      afk: { enabled: false, claim: true, levelUp: false, levelReward: true, claimAfterHours: 0 },
      hero: { enabled: false, heroes: [], levelUp: false, levelUpMaxActions: 1, starUp: false, skillLevelUp: false, skillAdvance: false, exclusiveLevelUp: false, exclusiveStarUp: false, equipEnhance: false, badgeEnhance: false, badgeExpItemNum: 1, appoint: false, positions: [], watchSkillVideo: false, universal: false, fragRecruit: false, recruit: { free: false, tickets: false, points: false, watchVideo: false, maxDraws: 10 } },
      antique: { enabled: false, activate: 'off', upgrade: 'off', universal: false, suit: { activate: 'off', levelUp: false }, recruit: { free: false, tickets: false, points: false, watchVideo: false, maxDraws: 10 } },
      pet: { enabled: 'off', dailyBreedForPass: false, claim: true, breed: false, breedSpecies: [], breedMinQuality: '', feed: false, decompose: false, decomposeBelowQuality: '', protectedUids: [], universal: false, levelUp: false, levelUpTargetLevel: 2, advance: false, advanceRooms: [] },
      equip: { enabled: 'off', collect: true, make: false, makeIds: [], universal: false, speedUp: false, speedUpMinRemainSecs: 300, decompose: false, decomposeBelowQuality: '', protectedUids: [] },
      museum: { enabled: false, collectRevenue: true, explore: false, factor: 1, maps: [], speedUp: false, speedUpDailyLimit: 0, speedUpKeepStock: 0 },
      battle: { enabled: false, maxActions: 50, stage: { enabled: false, samePowerRetryCount: 0, claimReward: true }, arena: { sweep: false, challenge: false }, trial: { heroExp: { challenge: false, rubySweep: false }, forge: { challenge: false, rubySweep: false }, petExp: { challenge: false, rubySweep: false } }, league: { challenge: false, reservePoints: 0, hangupReward: false, danReward: false, passReward: false }, expedition: { sweep: false, finalReward: false, freePass: false, challenge: false, challengeStopOnHeroDeath: true, challengeMinTeamHpPct: 40 } },
      world: { enabled: false, report: false, fleet: { repair: false, repairThresholds: [], repairSpeedUp: false, repairSpeedUpMinRemainSecs: 20 }, pirate: { attack: false, sweep: false, attackTypes: [], sweepTypes: [], dailySweepLimit: 10, attackTime: { start: '00:00', end: '00:00' } }, radar: { enabled: false, claim: true, kinds: [], fixed: false }, resField: { enabled: false, factory: 7, oasis: 3, tank: 0 }, chipMine: { enabled: false, hours: [], dailyCap: 0, fleets: [] }, treasureLoot: { enabled: false, hours: [], fleets: [] }, merchantShip: { enabled: false, retryMinutes: 0, rewardMaterials: [], fleets: [] }, cityWar: { enabled: false, online: false, reattack: false, fleets: [] }, worldBoss: { enabled: false, attackTimes: 1 }, limitedBoss: { enabled: false, challengeReward: false, fleets: [] }, trade: { enabled: false, claim: false, upgrade: false, speedUp: false, speedUpDailyLimit: 0, profitLimit: 0 } },
      guild: { enabled: false, packs: { guild: false, title: false }, order: { enabled: 'off', dailyLimit: 20, cityIds: [] }, aid: { receive: false, ask: false, askItems: [], help: false, helpItems: [], helpNicknameKeywords: [], helpMinStock: 30, helpDailyLimit: 50 }, tech: { enabled: false, items: [] }, ship: { captain: false, crew: false, qualities: [], rewardItems: [], minWaterCoin: 0, forbiddenMaterials: [], relaxFilters: false } },
      welfare: { enabled: false, daily: true, weeklyLottery: false, uniqueLottery: false, dailyTask: true, growth: true, events: true, email: true },
      activity: { enabled: false, edict: { enabled: false }, midAutumn: { enabled: false, signIn: false, freeGift: false, activeReward: false }, blindBox: { enabled: false, freeGift: false, scoreReward: false, play: false, keepCards: 0 }, catcher: { enabled: false, play: false, repeat: false, sweep: false, passReward: false, keepHooks: 0, maxStage: 30, sweepStage: 0 }, workshop: { enabled: false, produce: false, gain: false, speedUp: false, keepStock: 10, keepClaws: 0, speedUpDailyLimit: 0 }, blessing: { enabled: false, boost: false, skinId: 0, boostTimes: 1, claimReward: false, keepKnots: 0 }, weekOrder: { enabled: false, buyMissingMaterials: false, minRubyStock: 0 }, weekLottery: { enabled: false, prize: false, maxDraws: 1 } },
      snap: { enabled: false, pve: false, pvpTrustee: false, giveUpPve: false, cancelMatchmaking: false, freeMatch: false, diamondMatch: false, diamondMatchDailyLimit: 0, matchWindows: [], passReward: false, maxMatches: 10 },
    },
  };
}

/** 用不可逆目录键隔离账号，避免 openId 成为路径或通过日志泄漏。 */
export function accountDirectory(accountId) {
  if (!accountId) throw new Error('自动化需要明确账号');
  return path.join(DATA_DIR, 'automation', createHash('sha256').update(String(accountId)).digest('hex'));
}

/** 上海业务日期与服务器的日限额一致，不使用宿主机默认时区。 */
export function businessDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/** 一次性迁移落盘的日程设置，保留旧开关意图和周四原有金币门槛。 */
function migrateCompetitionSettings(value) {
  const migrated = structuredClone(value);
  let changed = false;
  for (const location of Object.keys(EXECUTION_MODES)) {
    const parts = location.split('.');
    const key = parts.pop();
    const owner = parts.reduce((node, part) => node?.[part], migrated);
    if (owner && typeof owner[key] === 'boolean') {
      owner[key] = owner[key] ? 'always' : 'off';
      changed = true;
    }
  }
  const resident = migrated?.modules?.resident;
  if (resident && !Object.hasOwn(resident, 'thursdayMinGold')) {
    resident.thursdayMinGold = resident.minGold ?? 0;
    changed = true;
  }
  return { value: migrated, changed };
}

/**
 * 将已落盘的旧海盗类型 ID 数组迁移为当前按类型分配次数的对象数组。
 *
 * 旧版没有每日目标时，每种类型只会扫荡一次；迁移必须保留该行为，不能把
 * 新模板的默认目标误当成用户授权的额外扫荡次数。若旧文件已经保存了明确目标，
 * 则按原有类型顺序均分目标，以保留用户选择的总次数。
 *
 * @param {unknown} value 从账号 settings.json 读取的原始设置。
 * @returns {{value: unknown, changed: boolean}} 可继续严格校验的设置及是否已迁移。
 */
function migrateLegacyPirateSweepTypes(value) {
  const pirate = value?.modules?.world?.pirate;
  const legacyTypes = pirate?.sweepTypes;
  // 仅识别历史版本确实保存过的正整数类型列表，其他损坏或未知结构仍交给严格校验报错。
  // 已有目标的空数组已经是当前格式；不能因 every([]) 为真而在每次读取时重复回写。
  if (!Array.isArray(legacyTypes) || (!legacyTypes.length && Object.hasOwn(pirate, 'dailySweepLimit')) || !legacyTypes.every(type => Number.isSafeInteger(type) && type > 0)) return { value, changed: false };

  const migrated = structuredClone(value);
  const nextPirate = migrated.modules.world.pirate;
  // 旧执行逻辑会去重类型；重复项不能在新对象数组中变成重复的扫荡计划。
  const types = [...new Set(legacyTypes)];
  const hasSavedTarget = Object.hasOwn(nextPirate, 'dailySweepLimit');
  const target = hasSavedTarget ? nextPirate.dailySweepLimit : types.length;

  // 目标为 0 时新语义是不扫荡。目标低于类型数时保留前面的类型，避免超出用户已有的总目标。
  const selected = Number.isSafeInteger(target) && target > 0 ? types.slice(0, target) : [];
  const perType = selected.length ? Math.floor(target / selected.length) : 0;
  const remainder = selected.length ? target % selected.length : 0;
  nextPirate.sweepTypes = selected.map((type, index) => ({ type, times: perType + (index < remainder ? 1 : 0) }));
  // 缺失目标代表纯旧版数据，以原来的“一种类型一次”行为补齐，避免意外扩大写请求次数。
  if (!hasSavedTarget) nextPirate.dailySweepLimit = types.length;
  return { value: migrated, changed: true };
}

/** 递归验证设置结构；动态字典保留作物、英雄、品质等真实业务键。 */
export function validateSettings(value, { pirateDailyLimit = null } = {}) {
  const template = defaultSettings();
  const numericArrays = new Set(['positions', 'makeIds', 'maps', 'hours', 'attackTypes', 'cityIds', 'items', 'repairThresholds']);
  /** 只接受普通对象，阻止动态字典中的原型键污染后续表单或预算归属。 */
  function object(input, location) {
    if (!input || Array.isArray(input) || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error(`${location} 必须是普通对象`);
    if (Object.keys(input).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error(`${location} 包含禁止的键`);
  }
  /** 时间配置允许秒精度，与当前水世界牌时间表一致。 */
  function time(input, location) {
    if (typeof input !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(input)) throw new Error(`${location} 必须为 HH:mm 或 HH:mm:ss`);
    return input;
  }
  /** 舰队规则使用明确结构；未配置 buildingId 时按闲置列表分配一艘。 */
  function fleet(input, location) {
    object(input, location);
    const kind = location.split('.')[3];
    const model = { enabled: false, buildingId: '' };
    if (['chipMine', 'treasureLoot'].includes(kind)) Object.assign(model, { levels: 0, emptyOnly: false });
    if (kind === 'treasureLoot') model.helpAlly = false;
    if (kind === 'cityWar') Object.assign(model, { roles: ['attack'], gotoCityId: 0, marchSpeedUp: false });
    const result = check(input, model, location);
    if (result.roles?.some(role => !['attack', 'bounty', 'goto', 'defend'].includes(role))) throw new Error(`${location}.roles 无效`);
    return result;
  }
  /** 按模板补全缺省字段，但拒绝未知键及错误数据类型，避免拼错设置静默失效。 */
  function check(input, model, location) {
    const key = location.split('.').at(-1);
    const executionDay = EXECUTION_MODES[location.replace(/^settings\./, '')];
    if (executionDay) {
      if (!['off', 'always', executionDay].includes(input)) throw new Error(`${location} 执行模式必须为 off、always 或 ${executionDay}`);
      return input;
    }
    if (Array.isArray(model)) {
      if (!Array.isArray(input)) throw new Error(`${location} 必须是数组`);
      if (input.length > 500) throw new Error(`${location} 条目过多`);
      if (key === 'fleets') return input.map((row, i) => fleet(row, `${location}.${i}`));
      if (key === 'matchWindows') return input.map((row, i) => check(row, { start: '00:00', end: '00:00' }, `${location}.${i}`));
      if (key === 'sweepTypes') {
        const seen = new Set();
        return input.map((row, i) => {
          const entry = check(row, { type: 1, times: 1 }, `${location}.${i}`);
          if (entry.type < 1) throw new Error(`${location}.${i}.type 必须为正整数`);
          if (entry.times < 1) throw new Error(`${location}.${i}.times 必须为正整数`);
          if (seen.has(entry.type)) throw new Error(`${location} 不能重复配置海盗类型 ${entry.type}`);
          seen.add(entry.type);
          return entry;
        });
      }
      for (const entry of input) {
        if (numericArrays.has(key)) {
          if (!Number.isSafeInteger(entry) || entry < 0 || (key === 'hours' && entry > 23)) throw new Error(`${location} 必须是有效非负整数数组`);
        } else if (typeof entry !== 'string' || !entry.trim()) throw new Error(`${location} 必须是非空字符串数组（UID 使用十进制字符串）`);
      }
      return structuredClone(input);
    }
    if (model && typeof model === 'object') {
      object(input, location);
      const result = {};
      if (!Object.keys(model).length) {
        for (const [id, entry] of Object.entries(input)) {
          if (!id.trim()) throw new Error(`${location} 的键不能为空`);
          if (key === 'products') { if (typeof entry !== 'string' || !entry.trim()) throw new Error(`${location}.${id} 必须是产品 ID`); }
          else if (!Number.isSafeInteger(entry) || entry < 0) throw new Error(`${location}.${id} 必须是非负整数`);
          result[id] = entry;
        }
        return result;
      }
      for (const key of Object.keys(input)) if (!Object.hasOwn(model, key)) throw new Error(`未知设置 ${location}.${key}`);
      for (const [key, sample] of Object.entries(model)) result[key] = check(input[key] ?? sample, sample, `${location}.${key}`);
      return result;
    }
    if (typeof input !== typeof model) throw new Error(`${location} 类型不正确`);
    if (typeof model === 'number' && (!Number.isFinite(input) || input < 0 || (key !== 'claimAfterHours' && !Number.isSafeInteger(input)))) throw new Error(`${location} 必须为有效非负数`);
    if (['start', 'end'].includes(key)) return time(input, location);
    return input;
  }
  const result = check(value, template, 'settings');
  const pirate = result.modules.world.pirate;
  // 类型分配是每日目标的完整拆分；空数组明确表示不执行海盗扫荡。
  const configuredSweepTotal = pirate.sweepTypes.reduce((total, row) => total + row.times, 0);
  if (pirate.sweepTypes.length && configuredSweepTotal !== pirate.dailySweepLimit)
    throw new Error('海盗扫荡类型次数之和必须等于每日扫荡次数');
  // 在线保存时由服务端传入当前角色上限；离线保存不传该值，保留编辑能力。
  if (pirateDailyLimit !== null && pirate.dailySweepLimit > pirateDailyLimit)
    throw new Error(`每日扫荡次数不能超过当前角色上限 ${pirateDailyLimit} 次`);
  if (![1, 2].includes(result.modules.choiceEvent.optionIndex)) throw new Error('选择事件选项必须为 1 或 2');
  if (result.modules.battle.expedition.challengeMinTeamHpPct > 100) throw new Error('远征最低血量不能超过 100%');
  if (result.modules.island.factory.proposedPriority.some(id => !['resident', 'cargo', 'guild'].includes(id))) throw new Error('需求来源无效');
  const factory = result.modules.island.factory;
  // 两个时间分档和补货水位必须有序，防止表单配置使补货永不停止或档位倒置。
  if (factory.fastTimeSecs > factory.shortTimeSecs) throw new Error('第一档耗时不能超过第二档耗时');
  if (factory.fastStockLow > factory.fastStockHigh || factory.shortStockLow > factory.shortStockHigh) throw new Error('工厂补货低水位不能超过高水位');
  if (factory.priorityBurstLimit < 1) throw new Error('连续优先生产上限必须至少为 1');
  return result;
}

/** 原子替换本地业务记录，避免进程退出留下半份 JSON。 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 唯一临时文件避免异常残留或另一进程的写入复用同一 .tmp，造成非业务并发的互相覆盖。
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    for (const waitMs of [25, 50, 100, 200, 400]) {
      try {
        fs.renameSync(temporary, file);
        return;
      } catch (error) {
        // Windows Defender、同步客户端等可能短暂持有目标文件；只重试已确认的瞬时 EPERM，其他持久化错误必须停止业务链。
        if (error?.code !== 'EPERM' || waitMs === 400) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      }
    }
  } finally {
    // 无论替换成功或重试耗尽，都不保留本次写入的临时账本文件。
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * 读取账号设置，并将已落盘的旧海盗结构和日期开关一次性升级为当前格式。
 *
 * @param {string} accountId 账号标识。
 * @returns {object} 经严格校验后的当前设置。
 */
export function loadSettings(accountId) {
  const file = path.join(accountDirectory(accountId), 'settings.json');
  if (!fs.existsSync(file)) return defaultSettings();
  const legacy = migrateLegacyPirateSweepTypes(JSON.parse(fs.readFileSync(file, 'utf8')));
  const competition = migrateCompetitionSettings(legacy.value);
  const settings = validateSettings(competition.value);
  // 迁移后立即原子回写，后续读取和服务重启都只走当前唯一的设置契约。
  if (legacy.changed || competition.changed) writeJson(file, settings);
  return settings;
}

/** 保存前执行同一套服务端验证，网页和 CLI 共享规则。 */
export function saveSettings(accountId, value, options = {}) {
  const settings = validateSettings(value, options);
  writeJson(path.join(accountDirectory(accountId), 'settings.json'), settings);
  return settings;
}

/** 日记录按角色与日期隔离；未确认的请求保留到跨日后的后续核对。 */
export function loadLedger(accountId, roleId) {
  if (!roleId) throw new Error('自动化需要登录后确认角色 ID');
  const key = createHash('sha256').update(String(roleId)).digest('hex');
  const file = path.join(accountDirectory(accountId), `role-${key}.json`);
  const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { days: {}, pending: {} };
  return { file, ledger };
}

/** 汇总同账号各角色的日消费；角色记录隔离不应成为重置账号总额度的途径。 */
export function accountSpending(accountId, roleId, currentLedger, now = Date.now()) {
  const { file, ledger } = loadLedger(accountId, roleId);
  const directory = accountDirectory(accountId), date = businessDate(now);
  const records = [currentLedger ?? ledger];
  if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
    const candidate = path.join(directory, name);
    // 只读取本功能的角色账本。账号业务文件锁保证正式执行期间其他进程不能同时预留。
    if (/^role-[a-f0-9]{64}\.json$/.test(name) && candidate !== file) records.push(JSON.parse(fs.readFileSync(candidate, 'utf8')));
  }
  const result = { date, spent: 0, held: 0, modules: {}, heldModules: {} };
  for (const record of records) {
    const day = record.days[date];
    result.spent += day?.spent ?? 0;
    for (const [id, num] of Object.entries(day?.modules ?? {})) result.modules[id] = (result.modules[id] ?? 0) + num;
    for (const pending of Object.values(record.pending).filter(p => p.date === date)) {
      result.held += pending.ruby;
      result.heldModules[pending.module] = (result.heldModules[pending.module] ?? 0) + pending.ruby;
    }
  }
  return result;
}
