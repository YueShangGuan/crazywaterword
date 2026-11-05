import { LABELS, MODULES, loadLedger, loadSettings, validateSettings, accountSpending, defaultSettings, selectModules } from './settings.mjs';
import { createContext, withRoleLock } from './context.mjs';
import * as base from './base.mjs';
import * as cultivation from './cultivation.mjs';
import { battle } from './battle.mjs';
import { world } from './world.mjs';
import { guild } from './guild.mjs';
import { welfare } from './welfare.mjs';
import { activity } from './activity.mjs';
import { snap } from './snap.mjs';
import { costs, mutate } from './common.mjs';
import { makeTypeResolver } from '../world.mjs';
import { modeActive, serverTime, moduleActive, moduleConfigured } from './schedule.mjs';

export const HANDLERS = Object.fromEntries(MODULES.map(id => [id, base[id] ?? cultivation[id] ?? { battle, world, guild, welfare, activity, snap }[id]]));
const runs = new Map();

/** 查询或停止不发送网关请求，运行结果保留在对应账号本地会话中。 */
export function automationStatus(accountId, roleId) {
  const stored = runs.get(accountId);
  // 切换角色后不能把上一角色的消费或执行结果显示给当前角色。
  const state = stored && (!roleId || stored.roleId === String(roleId)) ? stored : null;
  const currentRole = roleId ?? state?.roleId;
  const budget = currentRole ? accountSpending(accountId, currentRole) : undefined;
  return state ? { running: state.running, mode: state.mode, startedAt: state.startedAt, completedAt: state.completedAt, results: state.results, error: state.error, module: state.module, ledger: state.ledger, budget } : { running: false, results: [], ledger: roleId ? loadLedger(accountId, roleId).ledger : undefined, budget };
}

/**
 * 标记当前自动化为停止状态，并保留停止是否由用户主动触发的来源。
 *
 * @param {string} accountId 当前账号 ID。
 * @param {{manual?: boolean, unexpectedDisconnect?: boolean}} options 停止来源；手动停止和异常断线不应重复触发停止通知。
 * @returns {ReturnType<typeof automationStatus>} 停止后的自动化状态。
 */
export function stopAutomation(accountId, { manual = false, unexpectedDisconnect = false } = {}) {
  const state = runs.get(accountId);
  if (state) {
    state.stop.aborted = true;
    // 安全保护也会设置 aborted；单独记录人工意图，供控制台通知逻辑排除手动停止。
    if (manual) state.stop.manuallyStopped = true;
    // 连接层已有专属断线通知，自动化结束时不能再为同一网络故障重复提醒。
    if (unexpectedDisconnect) state.stop.unexpectedDisconnect = true;
  }
  return automationStatus(accountId);
}

/**
 * 计划和执行使用同一注册表；缺模块或未知选择直接拒绝，防止静默漏跑。
 *
 * @param {object} options 自动化执行参数。
 * @param {string|string[]} [options.selector] 要执行的模块选择器。
 * @param {object} [options.settings] 已解析或待加载的账号设置。
 * @param {Function} [options.onQuery] 成功只读查询回包的回调。
 * @param {Function} [options.onModuleComplete] 单个模块批次结束后的分类刷新回调。
 * @returns {Promise<object>} 自动化运行状态和步骤结果。
 */
export async function runAutomation({ selector = 'all', settings, onModuleComplete, ...args }) {
  const resolved = validateSettings(settings ?? loadSettings(args.accountId));
  const selected = selectModules(selector);
  for (const id of selected) if (!HANDLERS[id]) throw new Error(`自动化模块缺少执行器 ${id}`);
  return withRoleLock(args.accountId, args.player?.playerId, async () => {
    if (runs.get(args.accountId)?.running) throw new Error('这个账号的自动化已经在运行');
    const state = { roleId: String(args.player?.playerId), running: true, mode: args.dryRun ? 'plan' : 'run', startedAt: new Date().toISOString(), results: [], stop: args.stop ?? { aborted: false, manuallyStopped: false }, error: null, module: null };
    runs.set(args.accountId, state);
    let ctx;
    try {
      ctx = createContext({ ...args, settings: resolved, stop: state.stop, onStep: row => { state.results.push(row); args.onStep?.(row); }, onQuery: args.onQuery });
      state.ledger = ctx.ledger;
      for (const id of selected) {
        ctx.assertReady(); state.module = id; ctx.setModule(id);
        const options = resolved.modules[id];
        if (!moduleActive(id, options, ctx)) { ctx.record({ status: moduleConfigured(id, options) ? 'skipped' : 'disabled', label: LABELS[id], reason: '当前执行模式未启用或未到指定星期' }); continue; }
        await ctx.refreshStock();
        try { await HANDLERS[id](ctx, options); }
        catch (error) { state.error = error.message; ctx.record({ status: 'error', reason: error.message }); ctx.assertReady(); }
        // 分类缓存必须等整个模块批次结束后再刷新，避免农田收割后又被后续种植覆盖成中间状态。
        try { await onModuleComplete?.(id, ctx); }
        catch (error) { ctx.record({ status: 'error', reason: `缓存刷新失败：${error.message}` }); }
        const blockedReason = ctx.consumeModuleBlock();
        if (blockedReason) ctx.record({ status: 'blocked', label: LABELS[id], reason: blockedReason });
      }
    } catch (error) { state.error = error.message; }
    finally { ctx?.dispose(); state.running = false; state.module = null; state.completedAt = new Date().toISOString(); }
    return { ...automationStatus(args.accountId), settings: resolved };
  });
}

/**
 * 判断折扣商店商品是否为未购买且不高于 2 折的目标券。
 *
 * @param {object} item 当前折扣商店商品。
 * @returns {'hero'|'antique'|null} 目标券类别；不匹配时返回 null。
 */
function priorityDiscountTicket(item) {
  if (item?.isBuy || !Number.isFinite(item?.discount) || item.discount > 0.2) return null;
  const assetIds = (item.reward?.asset ?? []).map(asset => asset.id);
  if (assetIds.includes('抽卡券')) return 'hero';
  if (assetIds.includes('藏品券')) return 'antique';
  return null;
}

/**
 * 判断指定刷新档位是否免费；收费刷新从流程层直接禁止，避免误触钻石消费。
 *
 * @param {object[]} rows ShopRefreshCfg 配置行。
 * @param {number} refreshCount 即将发送的刷新次数。
 * @returns {boolean} 该档位是否明确配置为空成本。
 */
function freeDiscountRefresh(rows, refreshCount) {
  const tier = rows.find(row => Number(row.times) === Number(refreshCount));
  return Boolean(tier && Array.isArray(tier.cost) && tier.cost.length === 0);
}

/**
 * 执行折扣商店的2折英雄/藏品券优先策略。
 *
 * @param {object} ctx 当前账号自动化上下文。
 * @param {(step: object) => Promise<unknown>} execute 统一旧日常写入执行器。
 * @returns {Promise<{results: object[], targetSeen: boolean, targetBought: boolean, failed: boolean}>} 执行结果及目标券状态。
 */
export async function runPriorityDiscountShop(ctx, execute) {
  const boughtKinds = new Set();
  const results = [];
  let targetSeen = false;
  let shop = await ctx.query('DiscountShopRequest');

  while (shop) {
    const targets = (shop.shopItem ?? [])
      .map(item => ({ item, kind: priorityDiscountTicket(item) }))
      .filter(target => target.kind);
    if (targets.length) targetSeen = true;
    for (const { item, kind } of targets) {
      const step = {
        request: 'DiscountShopBuyRequest',
        body: { id: item.id },
        response: null,
        note: kind === 'hero' ? '强制购买2折英雄招募券' : '强制购买2折藏品券',
        bypassSpendingLimits: true,
      };
      try {
        const body = await execute(step);
        boughtKinds.add(kind);
        results.push({ id: 1007, title: '折扣商店购买', request: step.request, note: step.note, ok: true, body });
      } catch (error) {
        // 目标券出现但余额不足或请求失败时禁止回退购买普通商品，避免把强制目标变成随机消费。
        results.push({ id: 1007, title: '折扣商店购买', request: step.request, note: step.note, ok: false, error: error.message });
        return { results, targetSeen, targetBought: false, failed: true };
      }
    }

    if (boughtKinds.size === 2) break;
    const nextRefreshCount = Number(shop.refreshCount ?? 0) + 1;
    if (!freeDiscountRefresh(ctx.rows('ShopRefreshCfg'), nextRefreshCount)) break;
    const previousRefreshCount = Number(shop.refreshCount ?? 0);
    const refreshStep = { request: 'DiscountShopRefreshRequest', body: {}, response: 'DiscountShopResponse', note: '免费刷新折扣商店' };
    try {
      const refreshed = await execute(refreshStep);
      results.push({ id: 1007, title: '折扣商店购买', request: refreshStep.request, note: refreshStep.note, ok: true, body: refreshed });
      if (!refreshed || Number(refreshed.refreshCount ?? 0) <= previousRefreshCount) break;
      shop = refreshed;
    } catch (error) {
      results.push({ id: 1007, title: '折扣商店购买', request: refreshStep.request, note: refreshStep.note, ok: false, error: error.message });
      return { results, targetSeen, targetBought: false, failed: true };
    }
  }
  return { results, targetSeen, targetBought: boughtKinds.size > 0, failed: false };
}

/**
 * 原有日常付费点金和折扣购买也必须查询当前价格并走持久化额度。
 *
 * @param {object} ctx 当前账号自动化上下文。
 * @param {object} step 待执行的日常动作。
 * @returns {Promise<unknown>} 服务端业务回包。
 */
export async function guardedDailyAction(ctx, step) {
  let ruby = 0, confirm;
  if (step.request === 'ClickGoldRequest' && step.body.free === false) {
    const price = ctx.rows('OfflineParamCfg').find(r => r.paramName === '点金价格')?.paramValue;
    if (!(price > 0)) throw new Error('缺少付费点金价格');
    ruby = price * step.body.times;
    const before = (await ctx.query('ClickGoldInfoRequest')).info?.paidTimes;
    confirm = async () => (await ctx.query('ClickGoldInfoRequest')).info?.paidTimes >= before + step.body.times;
  }
  if (step.request === 'DiscountShopBuyRequest') {
    const key = `${step.request}:${JSON.stringify(step.body)}`;
    const item = (await ctx.query('DiscountShopRequest')).shopItem?.find(s => s.id === step.body.id);
    confirm = async () => (await ctx.query('DiscountShopRequest')).shopItem?.find(s => s.id === step.body.id)?.isBuy === true;
    // 已购商品只可能用于结算本地未确认写入；没有待确认记录时不能把外部购买视为本次成功。
    if (item?.isBuy) {
      if (!ctx.hasPending(key)) throw new Error('当前折扣商品已购买');
      const settled = await ctx.action(step.request, step.body, { confirm, response: step.response, label: step.note, key });
      if (settled.status !== 'success') throw new Error(settled.reason ?? `操作${settled.status}`);
      return settled.value;
    }
    if (!item || !Number.isFinite(item.price) || !Number.isFinite(item.discount)) throw new Error('缺少当前折扣商品价格');
    const goods = item;
    ruby = Math.floor(goods.price * goods.discount);
    if (!(ruby >= 0)) throw new Error('折扣商品价格无效');
  }
  await ctx.refreshStock();
  const result = await ctx.action(step.request, step.body, { ruby, confirm, response: step.response, label: step.note, bypassSpendingLimits: step.bypassSpendingLimits === true });
  if (result.status !== 'success') throw new Error(result.reason ?? `操作${result.status}`);
  return result.value;
}

/** 旧入口与固定日常使用同一角色互斥、未确认记录和查询回调，不能跳过执行规则。 */
export async function gameplaySession({ accountId, client, protocol, config, player, stop, module = 'dailies', onQuery, onStep, initialPushes, work }) {
  return withRoleLock(accountId, player?.playerId, async () => {
    const ctx = createContext({ accountId, client, protocol, config, player, stop, onQuery, onStep, initialPushes, settings: loadSettings(accountId) });
    ctx.setModule(module);
    try { await ctx.refreshStock(); return await work(step => legacyAction(ctx, step), ctx); }
    finally { ctx.dispose(); }
  });
}

/**
 * 执行旧日常计划中的单步请求，并将付费折扣购买、免费刷新统一接入共享上下文。
 *
 * @param {object} ctx 当前账号自动化上下文。
 * @param {object} step 旧日常生成的请求描述。
 * @returns {Promise<unknown>} 服务端业务回包。
 */
export async function legacyAction(ctx, step) {
  if (step.request === 'DiscountShopBuyRequest' || (step.request === 'ClickGoldRequest' && step.body.free === false)) return guardedDailyAction(ctx, step);
  if (step.request === 'DiscountShopRefreshRequest') {
    // 刷新请求没有钻石消费，但必须使用专用回包确认服务端已切换商品页。
    const result = await ctx.action(step.request, step.body ?? {}, { response: 'DiscountShopResponse', label: step.note ?? step.label });
    if (result.status !== 'success') throw new Error(result.reason ?? `操作${result.status}`);
    return result.value;
  }
  if (ctx.settings.modules.island.enabled && ['StartFactoryProduceRequest', 'SetFactoryAutoProduceRequest'].includes(step.request)) {
    // 旧循环仍保留排产能力，但不能重新启用用户已在新设置禁用的工厂。
    const type = makeTypeResolver(ctx.config)(step.body.buildingId);
    const options = ctx.settings.modules.island;
    if (options.disabledBuildings.includes(type) || options.factory.disabledFactories.includes(type)) throw new Error('该工厂已在账号设置中禁用');
  }
  const states = {
    GotAchievementRewardRequest: ['AchievementInfoRequest', s => s.task],
    DrawMainTaskRewardRequest: ['MainTaskInfoRequest', s => s],
    // 支线领取成功后会从 MainTaskInfoResponse.branch 中消失；无专用 Response 时必须读回确认。
    GotBranchTaskRewardRequest: ['MainTaskInfoRequest', s => s.branch],
    GetNextOrderOTDRewardRequest: ['OnWaterRequest', s => s.orderOfTheDay],
    DrawDailyRewardRequest: ['DailyTaskInfoRequest', s => s.dailyRewardClaimed],
    DrawWeeklyRewardRequest: ['DailyTaskInfoRequest', s => s.weeklyRewardClaimed],
    GotFreeDailyPackRequest: ['DailyGiftPackRequest', s => s.drawnPack],
    // 月卡可并存，只观察指定卡种，避免另一张卡的变化误确认本次领取。
    MonthCardDailyRewardRequest: ['MonthCardRequest', s => s.cardItem?.find(card => Number(card.type) === Number(step.body.type))],
    RecruitStartRequest: ['RecruitInfoRequest', s => s.hero],
    ArenaChallengeRequest: ['ArenaInfoRequest', s => s.dailyChallengeTimes],
    // 海盗扫荡没有业务回包，必须以今日已扫次数递增确认，超时后才会保留未确认记录。
    PirateSweepRequest: ['AllPirateRequest', s => s.sweepTimes],
    TrialRaidChallengeRequest: ['TrialRaidInfoRequest', s => s.raid?.passedStage, { raidId: step.body.raidId }],
    MuseumStartExploreRequest: ['MuseumInfoRequest', s => s.exploreStages],
    DenyOrderRequest: ['OnWaterRequest', s => s.workerOrder],
    QuickGotReadEmailRequest: ['EmailBoxRequest', s => s.email, { pageNo: 0 }],
    ChallengeResFieldRequest: ['MyResFieldsRequest', s => s.info],
    GiveUpResFieldRequest: ['MyResFieldsRequest', s => s.info],
  };
  let state = states[step.request];
  if (!state && /Building|Factory|WorkerOrder/.test(step.request)) state = ['OnWaterRequest', s => {
    const ids = Array.isArray(step.body.buildingId) ? step.body.buildingId : [step.body.buildingId];
    return step.body.buildingId ? s.building?.filter(b => ids.includes(b.buildingId)) : s.workerOrder;
  }];
  let expenses = [];
  if (['BuildBuildingRequest', 'UpgradeBuildingRequest'].includes(step.request)) {
    const building = (await ctx.query('OnWaterRequest')).building?.find(b => b.buildingId === step.body.buildingId);
    const type = makeTypeResolver(ctx.config)(step.body.buildingId);
    const row = ctx.rows('BuildingUpgradeCfg').find(r => r.buildingType === type && r.level === (building?.level ?? 0) + 1);
    if (!row) throw new Error('缺少当前建筑升级价格');
    expenses = row.consume;
  }
  if (step.request === 'StartFactoryProduceRequest') {
    const row = ctx.rows('BuildingProduceCfg').find(r => r.itemId === step.body.productId);
    if (!row) throw new Error('缺少当前生产配方');
    expenses = row.costItem;
  }
  if (step.request === 'FinishWorkerOrderRequest') expenses = costs((await ctx.query('OnWaterRequest')).workerOrder?.find(o => o.index === step.body.index)?.requirements, ctx.protocol);
  if (step.request === 'UpgradeAfkLevelRequest') {
    const row = ctx.rows('OfflineCfg').find(r => r.level === step.body.level);
    if (!row) throw new Error('缺少挂机升级价格');
    expenses = [row.consume];
  }
  if (step.body.speedUp) expenses = [['加速器', step.body.speedUp.useNum]];
  if (step.request === 'RecruitStartRequest' && step.body.way === ctx.protocol.RecruitWay.RECRUIT_SINGLE) expenses = [['抽卡券', 1]];
  // 套装激活和升级共用同一协议；旧入口也必须按服务端是否已有套装区分授权。
  const existingSuit = step.request === 'AntiqueSuitLevelUpRequest'
    ? (await ctx.query('AllAntiqueRequest')).suits?.some(suit => suit.id === step.body.id) : false;
  /** 旧任务提交点也使用当前模式，不能从日常入口绕过指定星期或模块总开关。 */
  const allowed = () => {
    const modules = ctx.settings.modules;
    if (step.request === 'FinishGuildOrderRequest') return modules.guild.enabled && modeActive(modules.guild.order.enabled, serverTime(ctx));
    if (['ActivateAntiqueRequest', 'AntiqueStarUpRequest'].includes(step.request)) return modules.antique.enabled
      && modeActive(modules.antique[step.request === 'ActivateAntiqueRequest' ? 'activate' : 'upgrade'], serverTime(ctx));
    if (step.request === 'AntiqueSuitLevelUpRequest') return modules.antique.enabled && (existingSuit
      ? modules.antique.suit.levelUp : modeActive(modules.antique.suit.activate, serverTime(ctx)));
    if (['PetBreedRequest', 'GetMaturePetRequest', 'PetFeedRequest', 'PetLevelUpRequest', 'PetUpgradeFeedRequest', 'PetUpgradeRequest', 'FreePetRequest'].includes(step.request)) return moduleActive('pet', modules.pet, ctx);
    if (['SpeedMakeEquipRequest', 'PickMadeEquipRequest', 'MakeEquipRequest', 'DecomposeEquipRequest'].includes(step.request)) return moduleActive('equip', modules.equip, ctx);
    return true;
  };
  const options = { label: step.note ?? step.label, response: step.response, expenses, allowed };
  let result;
  if (state) result = await mutate(ctx, step.request, step.body, state[0], state[1], { ...options, stateBody: state[2] });
  else result = await ctx.action(step.request, step.body, options);
  if (result.status !== 'success') throw new Error(result.reason ?? `操作${result.status}`);
  return result.value;
}

/** 为旧循环日常任务过滤已启用玩法，避免同轮重复挑战、领取和消费。 */
export function handledDailyIds(settings) {
  const modules = settings.modules;
  const ids = [];
  if (modules.hero.enabled && Object.values(modules.hero.recruit).some(v => v === true)) ids.push(1002);
  if (modules.afk.enabled && modules.afk.claim) ids.push(1004);
  // 挂机模块已按 paidTimes 执行目标次数时，旧日常 1006 不能在同一循环再次发起付费点金。
  if (modules.afk.enabled && settings.spending.clickGoldTimes > 0) ids.push(1006);
  if (modules.battle.enabled) {
    if (modules.battle.stage.enabled) ids.push(1003);
    if (modules.battle.arena.challenge || modules.battle.arena.sweep) ids.push(1005);
    if (Object.values(modules.battle.trial).some(t => t.challenge || t.rubySweep)) ids.push(1009);
    if (modules.battle.league.challenge) ids.push(1017);
  }
  if (modules.world.enabled) {
    if (modules.world.trade.enabled) ids.push(1008);
    if (modules.world.pirate.attack) ids.push(1010);
    if (modules.world.radar.enabled) ids.push(1011);
    if (modules.world.cityWar.enabled) ids.push(1015);
  }
  if (modules.guild.enabled) {
    // 日期模式即使今天不执行，也持有该任务，防止旧日常绕过周一限制。
    if (modules.guild.order.enabled !== 'off') ids.push(1012);
    if (modules.guild.aid.help) ids.push(1013);
    if (modules.guild.aid.ask) ids.push(1014);
  }
  if (modules.museum.enabled && modules.museum.explore) ids.push(1016);
  return ids;
}

/** 单独执行日常时复用已启用玩法，只开放对应任务分支；循环已处理的任务由调用方去重。 */
export async function dailyGameplay(ctx, taskId) {
  if (!handledDailyIds(ctx.settings).includes(taskId)) return null;
  const defaults = defaultSettings().modules, configured = ctx.settings.modules;
  const battle = { ...defaults.battle, stage: { ...defaults.battle.stage, claimReward: false } };
  const selections = {
    1002: ['hero', { ...defaults.hero, recruit: configured.hero.recruit }],
    1003: ['battle', { ...battle, maxActions: 1, stage: { ...configured.battle.stage, claimReward: false } }],
    1004: ['afk', { ...defaults.afk, ...configured.afk, levelUp: false, levelReward: false }],
    1005: ['battle', { ...battle, maxActions: 1, arena: configured.battle.arena }],
    1008: ['world', { ...defaults.world, trade: configured.world.trade }],
    1009: ['battle', { ...battle, maxActions: 1, trial: configured.battle.trial }],
    1010: ['world', { ...defaults.world, pirate: configured.world.pirate }],
    1011: ['world', { ...defaults.world, radar: configured.world.radar }],
    1012: ['guild', { ...defaults.guild, order: configured.guild.order }],
    1013: ['guild', { ...defaults.guild, aid: { ...configured.guild.aid, ask: false, receive: false } }],
    1014: ['guild', { ...defaults.guild, aid: { ...configured.guild.aid, help: false, receive: false } }],
    1015: ['world', { ...defaults.world, cityWar: configured.world.cityWar }],
    1016: ['museum', { ...configured.museum, collectRevenue: false }],
    1017: ['battle', { ...battle, maxActions: 1, league: { ...defaults.battle.league, challenge: configured.battle.league.challenge, reservePoints: configured.battle.league.reservePoints } }],
  };
  const [id, options] = selections[taskId];
  const previous = ctx.moduleId, start = ctx.results.length;
  ctx.setModule(id);
  try {
    await ctx.refreshStock();
    await HANDLERS[id](ctx, options);
    return ctx.results.slice(start);
  } finally { ctx.setModule(previous); }
}
