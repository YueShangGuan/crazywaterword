import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../accounts.mjs';

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

/** 新功能首次安装保持关闭，具体消耗参数必须由用户选择。 */
export function defaultSettings() {
  return {
    season: 0,
    // VIP免广告只保存用户意图，真正是否生效由当前连接角色资格决定。
    vipFreeAd: false,
    // 连接异常通知默认关闭，避免新账号在未配置 webhook 时产生外部请求。
    notifications: { wecom: { enabled: false, webhook: '' } },
    spending: { enabled: false, dailyLimit: 0, minRubyStock: 0, modules: Object.fromEntries([...MODULES, 'dailies'].map(id => [id, 0])) },
    modules: {
      island: { enabled: false, collect: true, finish: true, build: false, upgrade: false, speedUp: false, disabledBuildings: [], factory: {
        gain: true, autoProduce: false, products: {}, disabledFactories: [], priorityProduce: false, proposedPriority: ['resident', 'cargo', 'guild'], speedUpForDemand: false,
        // 分档只使用单件实际耗时；库存目标是订单/配方消耗之外的余量，不默认补满仓。
        fastTimeSecs: 300, shortTimeSecs: 600, fastStockLow: 5, fastStockHigh: 10, shortStockLow: 3, shortStockHigh: 5,
        priorityBurstLimit: 3, reorderQueue: true,
      } },
      farm: { enabled: false, harvest: true, plant: false, cropPriorities: {}, cropKeepStock: {}, priorityPlant: false, seedOnDemand: false, speedUp: false, speedUpMaxActions: 8 },
      resident: { enabled: false, orderReward: true, blockedMaterials: [], skipCropOrders: false, minExp: 0, minGold: 0, dailyCap: 0 },
      cargo: { enabled: false, fill: true, reward: true }, choiceEvent: { enabled: false, optionIndex: 1 },
      gather: { enabled: false, fishing: false, maxFishCasts: 12, floater: false, floaterCollectWhenFull: false, openChests: false, maxChests: 20, diving: false, divingEach: 20, salvage: false, salvageEach: 30, enhance: { fishing: false, diving: false, salvage: false }, enhanceTargetLevel: 2 },
      afk: { enabled: false, claim: true, levelUp: false, levelReward: true, claimAfterHours: 0 },
      hero: { enabled: false, heroes: [], levelUp: false, levelUpMaxActions: 1, starUp: false, skillLevelUp: false, skillAdvance: false, exclusiveLevelUp: false, exclusiveStarUp: false, equipEnhance: false, badgeEnhance: false, badgeExpItemNum: 1, appoint: false, positions: [], watchSkillVideo: false, universal: false, fragRecruit: false, recruit: { free: false, tickets: false, points: false, watchVideo: false, maxDraws: 10 } },
      antique: { enabled: false, activate: false, upgrade: false, universal: false, suit: { activate: false, levelUp: false }, recruit: { free: false, tickets: false, points: false, watchVideo: false, maxDraws: 10 } },
      pet: { enabled: false, claim: true, breed: false, breedSpecies: [], breedMinQuality: '', feed: false, decompose: false, decomposeBelowQuality: '', protectedUids: [], universal: false, levelUp: false, levelUpTargetLevel: 2, advance: false, advanceRooms: [] },
      equip: { enabled: false, collect: true, make: false, makeIds: [], universal: false, speedUp: false, speedUpMinRemainSecs: 300, decompose: false, decomposeBelowQuality: '', protectedUids: [] },
      museum: { enabled: false, collectRevenue: true, explore: false, factor: 1, maps: [], speedUp: false, speedUpDailyLimit: 0, speedUpKeepStock: 0 },
      battle: { enabled: false, maxActions: 50, stage: { enabled: false, samePowerRetryCount: 0, claimReward: true }, arena: { sweep: false, challenge: false }, trial: { heroExp: { challenge: false, rubySweep: false }, forge: { challenge: false, rubySweep: false }, petExp: { challenge: false, rubySweep: false } }, league: { challenge: false, reservePoints: 0, hangupReward: false, danReward: false, passReward: false }, expedition: { sweep: false, finalReward: false, freePass: false, challenge: false, challengeStopOnHeroDeath: true, challengeMinTeamHpPct: 40 } },
      world: { enabled: false, report: false, fleet: { repair: false, repairThresholds: [], repairSpeedUp: false, repairSpeedUpMinRemainSecs: 20 }, pirate: { attack: false, sweep: false, attackTypes: [], sweepTypes: [], attackTime: { start: '00:00', end: '00:00' } }, radar: { enabled: false, claim: true, kinds: [], fixed: false }, resField: { enabled: false, factory: 7, oasis: 3, tank: 0 }, chipMine: { enabled: false, hours: [], dailyCap: 0, fleets: [] }, treasureLoot: { enabled: false, hours: [], fleets: [] }, merchantShip: { enabled: false, retryMinutes: 0, fleets: [] }, cityWar: { enabled: false, online: false, reattack: false, fleets: [] }, worldBoss: { enabled: false, attackTimes: 1 }, limitedBoss: { enabled: false, challengeReward: false, fleets: [] }, trade: { enabled: false, claim: false, upgrade: false, speedUp: false, speedUpDailyLimit: 0, profitLimit: 0 } },
      guild: { enabled: false, packs: { guild: false, title: false }, order: { enabled: false, dailyLimit: 20, cityIds: [] }, aid: { receive: false, ask: false, askItems: [], help: false, helpItems: [], helpNicknameKeywords: [], helpMinStock: 30, helpDailyLimit: 50 }, tech: { enabled: false, items: [] }, ship: { captain: false, crew: false, qualities: [], rewardItems: [], minWaterCoin: 0, forbiddenMaterials: [], relaxFilters: false } },
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

/** 递归验证设置结构；动态字典保留作物、英雄、品质等真实业务键。 */
export function validateSettings(value) {
  const template = defaultSettings();
  const numericArrays = new Set(['positions', 'makeIds', 'maps', 'hours', 'attackTypes', 'sweepTypes', 'cityIds', 'items', 'repairThresholds']);
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
    if (Array.isArray(model)) {
      if (!Array.isArray(input)) throw new Error(`${location} 必须是数组`);
      if (input.length > 500) throw new Error(`${location} 条目过多`);
      if (key === 'fleets') return input.map((row, i) => fleet(row, `${location}.${i}`));
      if (key === 'matchWindows') return input.map((row, i) => check(row, { start: '00:00', end: '00:00' }, `${location}.${i}`));
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
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/** 设置文件缺省时只使用关闭的初始值，不读取另一套配置格式。 */
export function loadSettings(accountId) {
  const file = path.join(accountDirectory(accountId), 'settings.json');
  return fs.existsSync(file) ? validateSettings(JSON.parse(fs.readFileSync(file, 'utf8'))) : defaultSettings();
}

/** 保存前执行同一套服务端验证，网页和 CLI 共享规则。 */
export function saveSettings(accountId, value) {
  const settings = validateSettings(value);
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
