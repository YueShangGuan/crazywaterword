// 主挂机：每日战令培育补做 → 普通模块和现有任务 → 固定领取跨服积分宝箱与勇士战令。
//
// 循环是显式开的：必须同时给 --loop 与 --yes，且每轮都是「先只读探测，再算计划，再执行」，
// 所以第二轮起没有可做的事时计划自然为空，不会重复发同样的请求。
// 被服务端拒过的具体动作记在 rejected 里跨轮传递（runTasks / runWorld 各自维护）。

import { claimCollection, collectFloaters } from './collections.mjs';
import { collectAntiqueFloaters } from './antique-floaters.mjs';
import { serviceCargo } from './cargo.mjs';
import { serviceBoats } from './boats.mjs';
import { sweepTrials } from './trials.mjs';
import { claimGuildWelfare } from './guild.mjs';
import { serviceGuildOrders } from './guild-orders.mjs';
import { serviceRadar } from './radar.mjs';
import { serviceEquipmentCrafting } from './equipment-automation.mjs';
import { serviceMuseum } from './museum.mjs';
import { servicePetBreeding } from './pet-breeding.mjs';
import { fishOnce } from './fishing.mjs';
import { upgradeFishingOnce } from './fishing-upgrade.mjs';
import { serviceAntiqueRecruit } from './antique-recruit.mjs';
import { claimAdShop, beginAdRound } from './ad-shop.mjs';
import { claimAfkAd, claimAdSpeedUps } from './ad-rewards.mjs';
import { claimTournamentDaily, openSeasonChests, claimComicDrama } from './side-rewards.mjs';
import { beautyActivity, militaryRewards } from './seasonal-activities.mjs';
import { merchantActivity } from './merchant-activity.mjs';
import { rewardSchedule } from './reward-schedule.mjs';
import { normalize } from './worlds.mjs';
import { surveyTasks, runTasks } from './tasks.mjs';
import { surveyDailies, runDailies } from './dailies.mjs';
import { surveyWorld, planWorld, runWorldRound, displayBuilding } from './world.mjs';

import { setTimeout as pause } from 'node:timers/promises';
import { claimRewards } from './claim-rewards.mjs';
import { claimWeekly, readWeekOrder, weekSchedule } from './activities.mjs';
import { claimWeeklyRewards, claimVipDaily, weeklyRewardKeys } from './free-rewards.mjs';
import { claimCampaignReports, claimOpenRanks } from './pirate-board.mjs';
import { claimExtraRewards, extraRewardKeys } from './extra-rewards.mjs';
import { serviceGuildAid } from './guild-aid.mjs';
import { serviceHeroGrowth, serviceStageAuto } from './progress-automation.mjs';
import { runTreasureLoot, treasureAutomationEnabled } from './treasure-loot.mjs';
import { exactAutomationId } from './automation-policy.mjs';
import { bridgeFleetReservations, dispatchOrder, dispatchReservationReason } from './fleet-availability.mjs';
import { checkFleetSettlement } from './fleet-settlement.mjs';
import { fleetMaintenanceEnabled, fleetMaintenanceInterval, runFleetMaintenance, watchFleetMaintenance } from './fleet-maintenance.mjs';
import { matchesFollowDeparture, watchTreasureTravel } from './treasure-follow.mjs';
import { runWorldBoss } from './world-boss.mjs';
import { runAllianceRadar } from './alliance-radar.mjs';
import { forgeEnabled, runEquipmentForge } from './equipment-forge.mjs';
import { automationTasks, dailyTaskKey, defaultFishingGoldReserve, worldTaskKey } from './automation.mjs';

const defaultSleep = (ms, signal) => pause(ms, undefined, { signal });
const dailyActionKeys = {
  1002: ['freeRecruit', 'ticketRecruit'], 1005: ['arena'], 1006: ['freeGold', 'paidGold'],
  1007: ['shop'], 1010: ['pirate'],
};

function nextFactoryCheck(buildings, offset, collect) {
  const now = Date.now();
  let next = now + 30_000;
  for (const { factory } of buildings ?? []) {
    if (!factory) continue;
    if (collect && factory.finishedProducts?.length) next = now;
    for (const job of factory.factoryQ ?? []) {
      if (job.finishTime > 0) next = Math.min(next, job.finishTime * 1000 - offset + 250);
    }
  }
  return Math.max(now + 3000, next);
}

import { runFixedRoutines } from './automation/routines.mjs';
import { runAutomation, gameplaySession, handledDailyIds } from './automation/service.mjs';
import { loadSettings, selectLoopModules } from './automation/settings.mjs';
const ISLAND_ACTION_KINDS = new Set(['collectProduct', 'gainFactory', 'finishUpgrade', 'build', 'upgrade', 'speedUpUpgrade', 'startProduce', 'speedUpProduce', 'weekFactory', 'buildSupply']);

/**
 * Decides whether the legacy world runner may execute a planned step.
 *
 * When the island module is enabled, it exclusively owns every building and
 * factory action. Its individual switches then decide which actions run, so a
 * disabled switch cannot be bypassed by the legacy world plan later in the
 * same loop.
 *
 * @param {{kind: string}} step Planned legacy world action.
 * @param {ReturnType<typeof loadSettings>} settings Saved account settings.
 * @returns {boolean} Whether the legacy world runner should retain the step.
 */
export function shouldRunLegacyWorldStep(step, settings) {
  if (step.kind === 'finishOrder' || step.kind === 'denyOrder') return !settings.modules.resident.enabled;
  return !settings.modules.island.enabled || !ISLAND_ACTION_KINDS.has(step.kind);
}

/**
 * 所有已启用新玩法每轮都由统一执行服务处理，旧日常跳过这些玩法以免重复操作。
 *
 * @param {object} client 当前账号游戏连接。
 * @param {object} protocol 当前协议定义。
 * @param {object} options 循环设置和状态回调。
 * @param {Function} [options.onQuery] 成功只读查询回包的回调。
 * @param {Function} [options.onModuleComplete] 新版模块批次结束后的分类刷新回调。
 * @param {Function} [options.onBatchComplete] 旧版任务、日常和海面批次结束后的分类刷新回调。
 * @returns {Promise<object>} 循环历史和每轮执行摘要。
 */
export async function runLoop(client, protocol, {
  config = null,
  player = null,
  adChannel = {},
  accountId,
  actionExecutor,
  automationModules = 'all',
  automationOnly = false,
  initialPushes = new Map(),
  rounds = 1,
  everyMs = 60_000,
  allowMutate = false,
  allowPaid = false,
  allowSpeedUp = false,
  allowReroll = false,
  sleep = defaultSleep,
  stop = { aborted: false },
  isEnabled,
  getFishingGoldReserve = () => defaultFishingGoldReserve,
  isStageBusy = () => false,
  // 上游形状设置与用量账本（第二波领奖族/舰队族）；未注入时相关模块按各自默认关闭。
  getSettings = () => null,
  usageLedger = null,
  schedule = work => work(),
  onRound,
  onStep,
  onMaintenance,
  onQuery = () => {},
  onModuleComplete = async () => {},
  onBatchComplete = async () => {},
} = {}) {
  if (!allowMutate) throw new Error('循环会持续改变账号状态，需要 --yes');
  // CLI 会使用默认 all；循环入口统一规范化，不能让已下架模块从任一入口重新进入执行器。
  const selectedAutomationModules = selectLoopModules(automationModules);
  const rejected = { tasks: new Set(), world: new Set() };
  const history = [];
  const rewards = isEnabled ? rewardSchedule(client) : null;
  // 舰队族：旧版舰队预留桥接到跨任务占用表；巨轮出发/舰队受损推送唤醒轮间调度。
  bridgeFleetReservations(client, getSettings, usageLedger, exactAutomationId(player?.worldId));
  const travel = watchTreasureTravel(client);
  let followWake = null, followPending = false, followVersion = 0;
  let maintenanceAt = 0, maintenancePending = false, maintenanceVersion = 0;
  let treasureAt = 0, radarAt = 0, lastTreasureNotes = '';
  let forgeAt = 0, forgePreference = null, lastForgeNotes = '';
  const unsubscribeFollow = travel.subscribe(fleet => {
    const preferences = getSettings();
    if (stop.aborted || !client.connected || !treasureAutomationEnabled(preferences)
      || !matchesFollowDeparture(fleet, preferences?.treasure, exactAutomationId(player?.playerId), travel.current())) return;
    treasureAt = 0; followPending = true; followVersion++; followWake?.();
  });
  const unsubscribeMaintenance = watchFleetMaintenance(client).subscribe(() => {
    if (stop.aborted || !client.connected || !fleetMaintenanceEnabled(getSettings())) return;
    maintenanceAt = 0; maintenancePending = true; maintenanceVersion++; followWake?.();
  });
  // 出发/受损推送只唤醒现有调度，不在消息回调中并发发协议或绕过舰队优先级。
  async function waitWithFollow(ms, signal) {
    if (followPending || maintenancePending) { followPending = false; maintenancePending = false; return true; }
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    let wake; const changed = new Promise(resolve => { wake = () => resolve(true); followWake = wake; });
    try { return await Promise.race([Promise.resolve(sleep(ms, controller.signal)).then(() => false), changed]); }
    finally { if (followWake === wake) followWake = null; controller.abort(); signal?.removeEventListener('abort', abort); }
  }
  let dailyWait = new Map();
  let lastFishWait;
  let lastFishUpgradeWait;
  let lastGuildWait;
  const serviceWait = new Map();
  const antiqueWait = new Map();
  let residentWait = new Map();
  // rounds <= 0 表示一直跑，靠 stop.aborted（Ctrl-C 或网页停止按钮）退出。
  const total = rounds > 0 ? rounds : Infinity;

  try {
  for (let round = 1; round <= total; round += 1) {
    if (stop.aborted) break;
    const empty = () => ({ planned: 0, results: [] });
    const summary = { round, startedAt: Math.floor(Date.now() / 1000), tasks: empty(), dailies: empty(), world: empty() };
    const settings = accountId ? loadSettings(accountId) : null;
    // 同一玩法启用新模块后，其细分开关拥有唯一执行权；上游独有任务仍由原调度处理。
    const ownership = {
      cargo: 'cargo', farm: 'farm', finishOrder: 'resident', denyOrder: 'resident',
      collect: 'island', finishUpgrade: 'island', build: 'island', buildSupply: 'island',
      startProduce: 'island', weekFactory: 'island', upgrade: 'island', speedUp: 'island',
      autoDive: 'gather', diveEnhance: 'gather', autoSalvage: 'gather', salvageEnhance: 'gather',
      floaters: 'gather', autoFish: 'gather', fishEnhance: 'gather', afk: 'afk',
      freeRecruit: 'hero', ticketRecruit: 'hero', freeAntiqueRecruit: 'antique', antiqueRecruitRewards: 'antique',
      guildWelfare: 'guild', arena: 'battle', pirate: 'world',
      tasks: 'welfare', dailyRewards: 'welfare', chests: 'welfare', gift: 'welfare', mail: 'welfare',
      weekGift: 'welfare', weekTimes: 'welfare',
      // 周订单提交/海商王与用户自建模块同协议，启用对应模块时旧调度让位，避免双跑。
      weekOrderSubmit: 'activity', merchantTrade: 'world', merchantRewards: 'world',
    };
    // 新挑战模块仅在普通试炼开启时处理免费档；VIP 广告扫荡是另一份权益，不能吞掉上游免费扫荡。
    if (settings && Object.values(settings.modules.battle.trial).some(rule => rule.challenge || rule.rubySweep)) ownership.trialSweep = 'battle';
    const enabled = key => !stop.aborted
      && !settings?.modules[ownership[key]]?.enabled
      && (!isEnabled || (isEnabled(key) && rewards.due(key)));
    // 执行中的服务需要读取用户开关本身，不能被本轮刚写入的到期时间误判为关闭。
    const active = key => !stop.aborted && Boolean(isEnabled?.(key));
    const groupEnabled = group => automationTasks.some(task => task.group === group && enabled(task.key));
    const stepLog = phase => entry => onStep?.({ round, phase, ...entry });
    let afkDeadline;
    let factoryDeadline;
    const rememberDeadline = time => { afkDeadline = time; };
    const logReward = (entry, category = '领奖') => stepLog('tasks')({ title: entry.label, ...entry, category });
    const allowDaily = (id, action) => enabled(dailyTaskKey(id, action));
    const allowWorld = kind => enabled(worldTaskKey(kind));
    const attemptedOrders = new Set();
    const harvestOptions = { config, player, accountId, actionExecutor, stop, attemptedOrders, cargoEnabled: () => !!isEnabled && enabled('cargo'),
      finishEnabled: () => allowWorld('finishOrder') };
    function phaseFailure(phase, title, error) {
      if (!client.connected) throw error;
      const entry = { title, ok: false, error: error.message };
      summary[phase].results.push(entry);
      stepLog(phase)(entry);
    }
    const serviceReport = (phase, category) => entry => {
      summary[phase].results.push(entry);
      if (!entry.skipped) summary[phase].planned++;
      const key = entry.key || category;
      if (!entry.skipped || serviceWait.get(key) !== entry.reason) stepLog(phase)({ ...entry, category });
      if (entry.skipped) serviceWait.set(key, entry.reason);
      else serviceWait.delete(key);
    };

    // ---- 舰队族调度（由游戏配置驱动；checkDispatch 也会被轮间唤醒调用）----
    async function checkForge() {
      if (stop.aborted || !forgeEnabled(getSettings()) || (Date.now() < forgeAt && forgePreference === getSettings().forge)) return;
      forgePreference = getSettings().forge;
      try {
        const result = await runEquipmentForge(client, protocol, config, player, { getSettings, ledger: usageLedger,
          enabled: () => !stop.aborted && client.connected && forgeEnabled(getSettings()),
          onStep(entry) { summary.world.planned++; summary.world.results.push(entry); stepLog('world')({ ...entry, category: '装备锻造' }); },
        });
        const text = (result.notes ?? []).join('；'); rewards?.observe('装备锻造', text || '本次已核对，锻造动作结果见日志');
        if (text && text !== lastForgeNotes) stepLog('world')({ title: '装备锻造检查', category: '装备锻造', skipped: true, reason: text });
        lastForgeNotes = text;
      } catch (error) { phaseFailure('world', '装备锻造检查', error); }
      finally { rewards?.expect('装备锻造', rewards.now() + (getSettings()?.forge?.checkEverySeconds ?? 30)); forgeAt = Date.now() + (getSettings()?.forge?.checkEverySeconds ?? 30) * 1000; }
    }
    async function checkDispatch() {
      if (stop.aborted) return;
      if (usageLedger) await checkFleetSettlement(client, player, usageLedger);
      await checkMaintenance();
      await checkForge();
      for (const task of dispatchOrder(getSettings())) {
        if (task === 'radar') await checkRadar();
        if (task === (getSettings()?.treasure.follow ? 'follow' : 'treasure')) await checkTreasure();
        if (task === 'worldBoss' && getSettings()?.worldBoss.enabled) await checkBoss();
      }
    }
    async function checkMaintenance() {
      if (stop.aborted || !fleetMaintenanceEnabled(getSettings())) { watchFleetMaintenance(client).hold([]); onMaintenance?.({ enabled: false, rows: [], reason: '现有自动维修未开启' }); return; }
      if (Date.now() < maintenanceAt) return;
      const version = maintenanceVersion; maintenancePending = false;
      try {
        await runFleetMaintenance(client, player, { getSettings, ledger: usageLedger, enabled: () => !stop.aborted && client.connected && fleetMaintenanceEnabled(getSettings()),
          onView: onMaintenance, onStep: entry => { summary.world.planned++; summary.world.results.push(entry); stepLog('world')({ ...entry, category: '战后维修', taskKey: '舰队战后维修' }); } });
      } catch (error) { onMaintenance?.({ enabled: true, rows: [], reason: error.message }); phaseFailure('world', '战后维修', error); }
      finally { maintenanceAt = version !== maintenanceVersion ? 0 : Date.now() + fleetMaintenanceInterval(getSettings()); }
    }
    async function checkBoss() {
      if (stop.aborted || !getSettings()?.worldBoss.enabled || !rewards?.due('worldBoss')) return;
      try {
        await runWorldBoss(client, config, player, { getSettings, ledger: usageLedger, enabled: () => !stop.aborted && client.connected && getSettings().worldBoss.enabled,
          report: entry => { summary.world.results.push(entry); stepLog('world')({ ...entry, title: entry.label, taskKey: 'worldBoss' }); } });
      } catch (error) { phaseFailure('world', '世界Boss首战', error); }
      finally { rewards?.defer('worldBoss', rewards.now() + Math.ceil(everyMs / 1000)); }
    }
    async function checkTreasure() {
      if (stop.aborted || !treasureAutomationEnabled(getSettings()) || Date.now() < treasureAt) return;
      const checkedFollowVersion = followVersion; followPending = false;
      try {
        await runTreasureLoot(client, protocol, config, player, { getSettings, ledger: usageLedger,
          canUseFleet: id => !dispatchReservationReason(client, getSettings(), getSettings()?.treasure.follow ? 'follow' : 'treasure', id),
          enabled: () => !stop.aborted && client.connected && treasureAutomationEnabled(getSettings()),
          onStep(entry) { summary.world.planned++; summary.world.results.push(entry); stepLog('world')({ ...entry, category: '万吨巨轮', taskKey: '万吨巨轮' }); },
          onNotes(notes) {
            const text = notes.join('；'); rewards?.observe('万吨巨轮', text || '本次已核对，没有待执行的巨轮动作');
            if (text && text !== lastTreasureNotes) stepLog('world')({ title: '巨轮检查', category: '万吨巨轮', skipped: true, reason: text });
            lastTreasureNotes = text;
          },
        });
      } catch (error) { phaseFailure('world', '万吨巨轮检查', error); }
      finally { rewards?.expect('万吨巨轮', rewards.now() + (getSettings()?.treasure?.checkEverySeconds ?? 15)); treasureAt = followVersion !== checkedFollowVersion ? 0 : Date.now() + (getSettings()?.treasure?.checkEverySeconds ?? 15) * 1000; }
    }
    async function checkRadar() {
      if (stop.aborted || !getSettings()?.radar.enabled || Date.now() < radarAt) return;
      try {
        await runAllianceRadar(client, config, player, { getSettings, ledger: usageLedger, canUseFleet: id => !dispatchReservationReason(client, getSettings(), 'radar', id),
          enabled: () => !stop.aborted && client.connected,
          report(entry) { summary.world.results.push(entry); if (!entry.skipped) summary.world.planned++; stepLog('world')({ ...entry, title: entry.label, category: '联盟情报' }); } });
      } catch (error) { phaseFailure('world', '联盟情报', error); }
      finally { rewards?.expect('联盟情报', rewards.now() + (getSettings()?.radar.checkEverySeconds ?? 30)); radarAt = Date.now() + (getSettings()?.radar.checkEverySeconds ?? 30) * 1000; }
    }
    if (stop.aborted || !client.connected) break;

    /** 固定日常只属于主挂机，独立执行和预览不附带培育或领奖。 */
    async function fixedRoutines(phase) {
      if (automationOnly || !accountId || !player?.playerId || stop.aborted) return;
      await gameplaySession({ accountId, client, protocol, config, player, stop, module: 'welfare', onQuery, initialPushes,
        onStep: row => {
          summary.routines ??= [];
          summary.routines.push(row);
          onStep?.({ round, phase: 'tasks', ...row, ok: row.status === 'success', skipped: row.status === 'skipped', error: row.reason });
        }, work: (_execute, ctx) => runFixedRoutines(ctx, phase) });
    }
    await schedule(async () => {
      if (stop.aborted) return;
      await fixedRoutines('before');
      if (settings) {
        summary.automation = await runAutomation({ client, protocol, config, player, accountId, settings,
          selector: selectedAutomationModules, initialPushes, stop,
          // 舰队族/城战内核读取上游形状设置（treasure/radar/cityWar 分组）；未保存时为 null 走旧行为。
          preferences: getSettings?.() ?? null,
          onQuery,
          onModuleComplete,
          onStep: row => onStep?.({ round, phase: 'automation', ...row, ok: row.status === 'success', error: row.reason }) });
        if (summary.automation.error || stop.aborted) return;
      }
      // 独立模块循环不执行上游挂机任务，防止未选择的任务随模块预览/执行一起运行。
      if (automationOnly) return;
      if (!isEnabled && enabled('tasks')) {
        try {
          const survey = await surveyTasks(client, protocol, { config, player });
          summary.tasks.planned = survey.plan.length;
          summary.tasks.results = await runTasks(client, protocol, survey, {
            allowMutate, accountId, player, config, actionExecutor, stop, rejected: rejected.tasks, enabled: () => enabled('tasks'), onStep: stepLog('tasks'),
          });
        } catch (error) { phaseFailure('tasks', '任务检查', error); }
      }
      if (groupEnabled('日常')) {
        try {
          const includeTask = id => !isEnabled || dailyActionKeys[id]?.some(enabled);
          const survey = await surveyDailies(client, protocol, { config, player, includeTask, probeGift: !isEnabled, idle: !!isEnabled });
          const waiting = survey.tasks.filter(({ task, status, reason }) => reason && (
            (task.id === 1002 && status === 'waiting') ||
            ([1005, 1010].includes(task.id) && ['waiting', 'blocked'].includes(status))
          ));
          for (const { task, reason } of waiting) {
            if (dailyWait.get(task.id) !== reason) stepLog('dailies')({ title: task.title, skipped: true, reason });
          }
          dailyWait = new Map(waiting.map(entry => [entry.task.id, entry.reason]));
          summary.dailies.planned = survey.tasks.reduce((n, entry) =>
            n + (entry.actions ?? []).filter(action => allowDaily(entry.task.id, action)).length, 0);
          if (!isEnabled) summary.dailies.planned += (survey.chests?.actions.length ?? 0) + (survey.gift?.actions.length ?? 0);
          if (summary.dailies.planned) {
            summary.dailies.results = await runDailies(client, protocol, survey, {
              allowMutate, allowPaid: isEnabled ? true : allowPaid, claimRewards: !isEnabled, config,
              accountId, player, actionExecutor, stop, handledIds: settings ? handledDailyIds(settings) : [],
              allowAction: allowDaily, onStep: stepLog('dailies'),
            });
          }
          for (const { task, reason } of waiting) summary.dailies.results.push({ id: task.id, skipped: true, reason });
          if (rewards) {
            for (const { task } of survey.tasks) {
              if (!(task.targetProgress > 0 && task.progress >= task.targetProgress)) continue;
              for (const key of dailyActionKeys[task.id] ?? []) rewards.defer(key, survey.daily.dailyResetTime);
            }
            rewards.defer('freeRecruit', survey.freeRecruitAt);
            rewards.defer('freeGold', survey.freeGoldAt);
            for (const entry of summary.dailies.results) {
              if (entry.ok && entry.request === 'RecruitStartRequest') {
                rewards.defer('freeRecruit', entry.body?.recruitData?.freeEndTimeSeconds);
              }
            }
          }
        } catch (error) { phaseFailure('dailies', '日常检查', error); }
      }
      if (isEnabled && groupEnabled('领奖')) {
        const results = await claimRewards(client, protocol, config, logReward, enabled, rememberDeadline, rewards, player, { accountId, actionExecutor, stop });
        summary.tasks = { planned: results.length, results };
      }
      if (isEnabled && enabled('adShop')) {
        await claimAdShop(client, config, { ...adChannel, player, enabled: () => enabled('adShop'),
          schedule: rewards, report(entry) {
            summary.tasks.results.push(entry);
            if (!entry.skipped) summary.tasks.planned++;
            logReward(entry, '领奖');
          } });
      }
      // ---- 第二波领奖族（键默认关闭；与用户自动化模块重叠的键已注明互斥）----
      const adContext = { ...adChannel, player, getSettings, enabled, ledger: usageLedger, scheduler: rewards };
      if (isEnabled && enabled('afkAd')) {
        try {
          beginAdRound(client);
          await claimAfkAd(client, config, { ...adContext, report(entry) {
            summary.tasks.results.push(entry);
            if (!entry.skipped) summary.tasks.planned++;
            logReward(entry, '领奖');
          } });
        } catch (error) { phaseFailure('tasks', '挂机广告收益', error); }
      }
      if (isEnabled && ['adSpeedUpProduce', 'adSpeedUpBuilding', 'adSpeedUpMuseum'].some(enabled)) {
        try {
          beginAdRound(client);
          await claimAdSpeedUps(client, config, { ...adContext, report(entry) {
            summary.tasks.results.push(entry);
            if (!entry.skipped) summary.tasks.planned++;
            logReward(entry, '海面');
          } });
        } catch (error) { phaseFailure('tasks', '广告加速', error); }
      }
      if (isEnabled) {
        const extraServices = [
          ['comicDrama', claimComicDrama],
          ['tournamentDailyGift', claimTournamentDaily],
        ];
        const activityServices = [
          ['armsRaceRewards', militaryRewards],
          ['beautyVotes', beautyActivity], ['beautyGift', beautyActivity],
          ['seasonChest', openSeasonChests],
          ['merchantTrade', merchantActivity], ['merchantRewards', merchantActivity],
        ];
        const serviceReport = (key, label, category) => {
          let reported = false;
          return {
            hook: entry => {
              reported = true;
              const result = { ...entry, taskKey: key };
              summary.tasks.results.push(result);
              if (!entry.skipped) summary.tasks.planned++;
              logReward(result, category);
            },
            done: () => { if (!reported) { summary.tasks.results.push({ taskKey: key, label, skipped: true, reason: '已检查，当前没有可执行的动作' }); } },
          };
        };
        for (const [key, service] of extraServices) {
          if (!enabled(key)) continue;
          const label = automationTasks.find(task => task.key === key)?.label ?? key;
          const wrap = serviceReport(key, label, '免费领奖');
          try {
            await service(client, config, { player, enabled: () => enabled(key), ledger: usageLedger, scheduler: rewards, report: wrap.hook });
            wrap.done();
          } catch (error) { wrap.hook({ label, ok: false, error: error.message }); }
        }
        for (const [key, service] of activityServices) {
          if (!enabled(key)) continue;
          const label = automationTasks.find(task => task.key === key)?.label ?? key;
          const wrap = serviceReport(key, label, '活动');
          try {
            await service(client, config, { ...adChannel, player, key, label, ledger: usageLedger, scheduler: rewards, settings: getSettings, enabled: () => enabled(key), report: wrap.hook });
            wrap.done();
          } catch (error) { wrap.hook({ label, ok: false, error: error.message }); }
        }
      }
      if (isEnabled && enabled('trialSweep')) {
        await sweepTrials(client, config, player?.level ?? 0, () => enabled('trialSweep'), entry => {
          summary.dailies.planned++;
          summary.dailies.results.push(entry);
          stepLog('dailies')({ ...entry, category: '试炼' });
        }, rewards);
      }
      if (isEnabled && enabled('guildWelfare')) {
        try {
          const entry = await claimGuildWelfare(client, config, { player, enabled: () => enabled('guildWelfare'), scheduler: rewards });
          summary.tasks.results.push(entry);
          if (!entry.skipped) summary.tasks.planned++;
          if (!entry.skipped || lastGuildWait !== entry.reason) logReward(entry, '联盟');
          lastGuildWait = entry.reason;
        } catch (error) { phaseFailure('tasks', '联盟福利礼包', error); }
      } else if (!isEnabled?.('guildWelfare')) lastGuildWait = undefined;
      if (isEnabled && groupEnabled('藏品')) {
        try {
          await serviceAntiqueRecruit(client, config, { player, enabled, scheduler: rewards, report(entry) {
            summary.tasks.results.push(entry);
            if (!entry.skipped) summary.tasks.planned++;
            if (!entry.skipped || antiqueWait.get(entry.key) !== entry.reason) logReward(entry, '藏品');
            if (entry.skipped) antiqueWait.set(entry.key, entry.reason);
            else antiqueWait.delete(entry.key);
          } });
        } catch (error) { phaseFailure('tasks', '藏品招募检查', error); }
      }
      for (const key of antiqueWait.keys()) if (!isEnabled(key)) antiqueWait.delete(key);
      if (isEnabled && enabled('fishEnhance')) {
        try {
          const reserve = getFishingGoldReserve();
          const entry = await upgradeFishingOnce(client, config, {
            playerLevel: player?.level, reserveGold: reserve,
            enabled: () => enabled('fishEnhance') && reserve === getFishingGoldReserve(),
          });
          summary.tasks.results.push(entry);
          if (!entry.skipped) summary.tasks.planned++;
          if (!entry.skipped || entry.reason !== lastFishUpgradeWait) logReward(entry, '钓鱼');
          lastFishUpgradeWait = entry.reason;
        } catch (error) { phaseFailure('tasks', '钓具养成', error); }
      } else lastFishUpgradeWait = undefined;
      if (isEnabled && enabled('autoFish')) {
        try {
          const entry = await fishOnce(client, config, () => enabled('autoFish'));
          summary.tasks.results.push(entry);
          if (!entry.skipped) summary.tasks.planned++;
          if (!entry.skipped || entry.reason !== lastFishWait) logReward(entry, '钓鱼');
          lastFishWait = entry.reason;
        } catch (error) { phaseFailure('tasks', '自动钓鱼', error); }
      } else lastFishWait = undefined;
      for (const [key, label] of [['fishBook', '钓鱼图鉴'], ['newbieLogin', '新手七日登录']]) {
        if (!isEnabled || !enabled(key)) continue;
        try {
          await claimCollection(client, config, key, enabled, entry => {
            summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward(entry, key === 'newbieLogin' ? '活动' : '领奖');
          }, rewards);
        } catch (error) { phaseFailure('tasks', label, error); }
      }
      // 酆都捞尸人（罗盘/法旨/驱邪、联动签到与礼包）和走江踏浪已下架，挂机不再执行这些方法。
      if (isEnabled) {
        const rewardReport = group => entry => {
          if (!entry.skipped) summary.tasks.planned++;
          summary.tasks.results.push(entry);
          logReward(entry, group);
        };
        if (weeklyRewardKeys.some(enabled)) {
          try {
            await claimWeeklyRewards(client, config, await weekSchedule(client), enabled, rewardReport('周期活动'), { scheduler: rewards, readOrder: readWeekOrder, player });
          } catch (error) { phaseFailure('tasks', '周活动奖励', error); }
        }
        if (enabled('vipDaily')) await claimVipDaily(client, config, player, enabled, rewardReport('领奖'), rewards);
        if (extraRewardKeys.some(enabled)) await claimExtraRewards(client, config, player, enabled, serviceReport('tasks', '领奖'), rewards, active);
        for (const [key, label, claim] of [['campaignReports', '战报奖励', claimCampaignReports], ['openRankRewards', '开服冲榜', claimOpenRanks]]) {
          if (!enabled(key)) continue;
          try { await claim(client, config, player, enabled, rewardReport('领奖'), rewards); }
          catch (error) { phaseFailure('tasks', label, error); }
        }
      }
      if (isEnabled && groupEnabled('船只')) {
        try {
          await serviceBoats(client, config, enabled, entry => {
            if (!entry.skipped) summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward(entry, '船只');
          });
        } catch (error) { phaseFailure('tasks', '船只检查', error); }
      }
      if (isEnabled && ['weekGift', 'weekTimes'].some(enabled)) {
        try {
          await claimWeekly(client, config, enabled, entry => {
            if (!entry.skipped) summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward(entry, '周期活动');
          }, player?.level, rewards);
        } catch (error) { phaseFailure('tasks', '周活动检查', error); }
      }
      if (groupEnabled('海面')) {
        const usesOrders = allowWorld('finishOrder') || allowWorld('denyOrder');
        const survey = await surveyWorld(client, protocol, { config, player,
          includeCargo: !!isEnabled && enabled('cargo') && (allowWorld('startProduce') || usesOrders),
          includeWeekOrder: usesOrders || allowWorld('startProduce') || allowWorld('weekFactory') || allowWorld('farm') || allowWorld('upgrade') });
        if (isEnabled && (enabled('collect') || enabled('startProduce')))
          factoryDeadline = nextFactoryCheck(survey.factories, client.serverClockOffsetMs || 0, enabled('collect'));
        const plan = planWorld(survey, { config, enabled: allowWorld,
          allowSpeedUp: isEnabled ? enabled('speedUp') : allowSpeedUp,
          allowReroll: isEnabled ? enabled('denyOrder') : allowReroll,
          minOrderExp: isEnabled && enabled('denyOrder') ? null : 0,
        });
        summary.world = { planned: plan.actions.length, population: survey.population + '/' + survey.maxPopulation,
          notes: [...survey.notes, ...plan.notes], results: [] };
        const nextWait = new Map();
        if (isEnabled && allowWorld('finishOrder')) {
          for (const decision of plan.orderDecisions) {
            if (decision.status !== 'reserved' && decision.status !== 'unknown') continue;
            const order = survey.orders.find(o => o.index === decision.index);
            const title = (order?.workerName || '未知居民') + '的订单 #' + decision.index;
            const message = title + ' · ' + decision.reason;
            nextWait.set(decision.index, message);
            if (residentWait.get(decision.index) !== message) stepLog('world')({ title, skipped: true, reason: decision.reason });
          }
        }
        residentWait = nextWait;
        if (isEnabled && enabled('upgrade') && plan.upgradeReasons.length)
          stepLog('world')({ title: '建筑暂不能升级：' + plan.upgradeReasons.join('；'), ok: true });
        if (isEnabled && enabled('floaters')) {
          try {
            // 仓储容量保护（continueWhenFull=false 为上游默认）：拾取前投影库存，原料仓满即停。
            await collectFloaters(client, config, survey.floaters, enabled, entry => {
              summary.world.planned++;
              summary.world.results.push(entry);
              stepLog('world')({ ...entry, title: entry.label });
            }, { settings: { gather: { continueWhenFull: false } } });
          } catch (error) { phaseFailure('world', '漂浮物拾取', error); }
        }
        if (isEnabled && enabled('antiqueFloaters')) {
          try {
            await collectAntiqueFloaters(client, config, { enabled: () => enabled('antiqueFloaters'), ledger: usageLedger,
              report: entry => { summary.world.results.push(entry); if (!entry.skipped) summary.world.planned++; stepLog('world')({ ...entry, title: entry.label, category: '采集与打捞' }); } });
          } catch (error) { phaseFailure('world', '藏品宝箱打捞', error); }
        }
        if (plan.actions.length) {
          const result = await runWorldRound(client, protocol, plan, { ...harvestOptions,
            allowMutate, enabled: allowWorld, rejected: rejected.world, onStep: stepLog('world'),
          });
          summary.world.planned += result.followupCount;
          summary.world.results.push(...result.results);
        }
        if (isEnabled && (allowWorld('startProduce') || enabled('upgrade') || enabled('weekFactory'))) {
          try {
            const after = normalize(await client.request('OnWaterRequest', {}));
            if (enabled('upgrade') || enabled('weekFactory')) {
              summary.world.upgrades = [];
              for (const entry of summary.world.results) {
                if (!['finishUpgrade', 'upgrade', 'weekFactory'].includes(entry.step?.kind)) continue;
                const id = entry.step.body.buildingId;
                const before = survey.buildings.find(b => b.buildingId === id);
                const current = after.building?.find(b => b.buildingId === id);
                const detail = !entry.ok ? entry.error : !current ? '未返回建筑状态' :
                  current.level > before.level ? '已升至 ' + current.level + ' 级' :
                  current.buildStartTime || current.buildFinishTime ? '已开工，当前 ' + before.level + ' 级' :
                  '服务器未确认升级，当前 ' + current.level + ' 级';
                const title = displayBuilding(config, before) + '：' + detail;
                summary.world.upgrades.push(title);
                if (entry.ok) stepLog('world')({ title, ok: true });
              }
            }
            if (allowWorld('startProduce')) {
              factoryDeadline = nextFactoryCheck(after.building, client.serverClockOffsetMs || 0, enabled('collect'));
              summary.world.factories = [];
              for (const b of survey.factories) {
                const factory = after.building?.find(row => row.buildingId === b.buildingId)?.factory;
                const before = b.factory.factoryQ?.length ?? 0;
                const count = factory ? factory.factoryQ?.length ?? 0 : null;
                const reasons = [];
                if (count !== survey.factorySlots) {
                  for (const entry of summary.world.results) {
                    if (!entry.ok && entry.step?.kind === 'startProduce' && entry.step.body.buildingId === b.buildingId)
                      reasons.push(entry.error);
                  }
                  if (plan.factoryReasons.has(b.buildingId)) reasons.push(plan.factoryReasons.get(b.buildingId));
                  const collected = summary.world.results.some(e => e.ok && e.step?.kind === 'gainFactory' && e.step.body.buildingId === b.buildingId);
                  const finished = f => (f?.finishedProducts ?? []).reduce((n, item) => n + Number(item.num), 0);
                  const newlyFinished = finished(factory) - (collected ? 0 : finished(b.factory));
                  if (newlyFinished > 0) reasons.push('核对时已有 ' + newlyFinished + ' 件在本轮完工，腾出了生产格');
                  if (!reasons.length) reasons.push(factory ? '排产后队列数量与计划不一致，下轮重新核对' : '服务端未返回工厂状态');
                }
                const queue = count === null ? '未能核对生产格' : count === survey.factorySlots
                  ? '已排满 ' + count + ' 个生产格'
                  : '正在生产 ' + count + ' 格，空闲 ' + Math.max(0, survey.factorySlots - count) + ' 格';
                const title = displayBuilding(config, b) + '：' + queue + (reasons.length ? '。' + [...new Set(reasons)].join('；') : '');
                summary.world.factories.push(title);
                if (count !== before || count !== survey.factorySlots) stepLog('world')({ title, ok: true });
              }
            }
          } catch (error) { phaseFailure('world', '核对海面建筑状态', error); }
        }
        if (isEnabled && enabled('cargo') && player?.level >= (config?.tables?.CargoUnlockCfg?.data[0]?.playerLevel ?? 9)) {
          try {
            await serviceCargo(client, config, { enabled: () => enabled('cargo'), log(title) {
              const entry = { title, ok: true };
              summary.world.planned++;
              summary.world.results.push(entry);
              stepLog('world')(entry);
            } });
          } catch (error) { phaseFailure('world', '贸易港', error); }
        }
      }
      await fixedRoutines('after');
      // Existing sea orders and production get first use of their materials.
      // Each new service reads fresh state inside the same per-account queue.
      if (isEnabled && enabled('guildOrders')) {
        try {
          await serviceGuildOrders(client, protocol, config, { player, enabled: () => active('guildOrders'),
            scheduler: rewards, report: serviceReport('dailies', '联盟订单') });
        } catch (error) { phaseFailure('dailies', '联盟订单检查', error); }
      }
      if (isEnabled && enabled('guildAidHelp')) {
        await serviceGuildAid(client, protocol, config, { player, enabled: () => active('guildAidHelp'),
          scheduler: rewards, report: serviceReport('dailies', '联盟互助') });
      }
      if (isEnabled && ['equipmentCollect', 'equipmentCraft'].some(enabled) && !forgeEnabled(getSettings())) {
        // 游戏配置启用锻造后由 checkForge 接管（每日次数+金币双预算、分解占用检查），旧开关让位。
        try {
          await serviceEquipmentCrafting(client, config, { player, enabled: active,
            scheduler: rewards, report: serviceReport('world', '装备制造') });
        } catch (error) { phaseFailure('world', '装备厂检查', error); }
      }
      if (isEnabled && ['radarAuto', 'radarRepair'].some(enabled) && !getSettings()?.radar.enabled) {
        // 游戏配置启用联盟情报后由 checkRadar 接管（合服暂停、汽油预算、跨任务占用），旧开关让位。
        try {
          await serviceRadar(client, protocol, config, { player, enabled: active,
            scheduler: rewards, report: serviceReport('dailies', '联盟情报') });
        } catch (error) { phaseFailure('dailies', '联盟情报检查', error); }
      }
      if (isEnabled && enabled('treasureLoot')) {
        // 宝藏派舰已改由游戏配置的巨轮调度接管（settings.treasure.enabled），旧开关保留但不再执行。
        summary.dailies.results.push({ key: 'treasureLoot', label: '世界宝藏派舰', skipped: true, reason: '已改由「游戏配置 → 巨轮调度」接管，请在该处开启' });
      }
      if (isEnabled && ['museumCollect', 'museumExplore'].some(enabled)) {
        try {
          await serviceMuseum(client, protocol, config, { player, enabled: active,
            scheduler: rewards, report: serviceReport('dailies', '博物馆') });
        } catch (error) { phaseFailure('dailies', '博物馆探险检查', error); }
      }
      if (isEnabled && ['petCollect', 'petBreed'].some(enabled)) {
        try {
          await servicePetBreeding(client, protocol, config, { player, enabled: active,
            scheduler: rewards, report: serviceReport('world', '海兽培育') });
        } catch (error) { phaseFailure('world', '海兽培育检查', error); }
      }
      // 先养成再推图，这样同一轮提升的战力能立刻用上。
      if (isEnabled && enabled('heroGrowth')) {
        await serviceHeroGrowth(client, protocol, config, { player, enabled: () => active('heroGrowth'),
          scheduler: rewards, report: serviceReport('dailies', '成长') });
      }
      if (isEnabled && enabled('stageAuto')) {
        await serviceStageAuto(client, config, { player, enabled: () => active('stageAuto'), isBusy: isStageBusy,
          scheduler: rewards, report: serviceReport('dailies', '成长') });
      }
      for (const key of serviceWait.keys()) if (!active(key)) serviceWait.delete(key);
      // 本轮收尾：结算舰队派遣快照并按优先级检查维修/情报/巨轮/Boss（游戏配置驱动）。
      await checkDispatch();
    });
    // 旧版任务、日常和海面动作作为一轮批次完成后统一刷新分类和库存，避免总览读取到中间状态。
    await onBatchComplete(['production', 'fleets', 'cargo', 'world', 'tasks', 'inventory']);
    if (stop.aborted) break;

    history.push(summary);
    if (!Number.isFinite(total) && history.length > 50) history.shift();
    onRound?.(summary);
    if (summary.automation?.error) break;
    if (automationOnly) {
      // 普通停止信号与 AbortSignal 均可使用；分段等待保证界面停止立即生效。
      for (let remaining = everyMs; round < total && remaining > 0 && !stop.aborted; remaining -= 250) await sleep(Math.min(250, remaining));
      continue;
    }
    if (round < total && !stop.aborted) {
      try {
        const signal = stop.signal ?? (typeof stop.addEventListener === 'function' ? stop : undefined);
        const nextRound = Date.now() + everyMs;
        let upgradeAt = Date.now() + 30_000;
        while (isEnabled && !stop.aborted) {
          const afkAt = enabled('afk') ? (afkDeadline ?? Date.now() + 60_000) : Infinity;
          const factoryAt = enabled('collect') || enabled('startProduce') ? factoryDeadline ?? Infinity : Infinity;
          const treasureNext = treasureAutomationEnabled(getSettings()) ? treasureAt : Infinity;
          const radarNext = getSettings()?.radar.enabled ? radarAt : Infinity;
          const maintenanceNext = fleetMaintenanceEnabled(getSettings()) ? maintenanceAt : Infinity;
          const forgeNext = forgeEnabled(getSettings()) ? forgeAt : Infinity;
          const wakeAt = Math.min(maintenanceNext, radarNext, afkAt, factoryAt, enabled('upgrade') ? upgradeAt : Infinity, treasureNext, forgeNext);
          if (wakeAt >= nextRound) break;
          await waitWithFollow(Math.max(0, wakeAt - Date.now()), signal);
          if (Date.now() >= nextRound) break;
          if (Math.min(maintenanceNext, radarNext, treasureNext) <= Date.now()) await schedule(checkDispatch);
          if (forgeNext <= Date.now() && forgeEnabled(getSettings())) await schedule(checkForge);
          if (afkAt <= Date.now() && enabled('afk')) {
            afkDeadline = undefined;
            await schedule(() => enabled('afk') && claimRewards(client, protocol, config, logReward, key => key === 'afk' && enabled(key), rememberDeadline, rewards, player, { accountId, actionExecutor, stop }));
            if (!afkDeadline || afkDeadline <= Date.now()) afkDeadline = Date.now() + 60_000;
          }
          const checkUpgrade = enabled('upgrade') && upgradeAt <= Date.now();
          if ((factoryAt <= Date.now() || checkUpgrade) && Date.now() < nextRound) {
            await schedule(async () => {
              if (!enabled('collect') && !enabled('startProduce') && !enabled('upgrade')) return;
              try {
                const holdForOrders = enabled('startProduce') || enabled('finishOrder') || checkUpgrade;
                const survey = await surveyWorld(client, protocol, { config, player, includeWeekOrder: holdForOrders,
                  includeCargo: enabled('cargo') && holdForOrders });
                const orderRead = !survey.notes.some(note => note.startsWith('本轮未能读取周订单'));
                const allow = kind => {
                  if (kind === 'gainFactory') return enabled('collect');
                  if (kind === 'finishUpgrade') return checkUpgrade && enabled('finishUpgrade');
                  if (kind === 'upgrade') return checkUpgrade && enabled('upgrade') && orderRead;
                  return kind === 'startProduce' && enabled('startProduce') && orderRead;
                };
                const plan = planWorld(survey, { config, enabled: allow });
                const result = await runWorldRound(client, protocol, plan, { ...harvestOptions, allowMutate, enabled: allow, onStep: stepLog('world') });
                summary.world.planned += result.results.length;
                summary.world.results.push(...result.results);
                const state = plan.actions.some(a => allow(a.kind)) ? normalize(await client.request('OnWaterRequest', {})).building : survey.factories;
                factoryDeadline = nextFactoryCheck(state, client.serverClockOffsetMs || 0, enabled('collect'));
              } catch (error) {
                if (stop.aborted) return;
                factoryDeadline = Date.now() + 30_000;
                phaseFailure('world', '定时收货与补产', error);
              }
            });
            if (checkUpgrade) upgradeAt = Date.now() + 30_000;
          }
        }
        while (!stop.aborted && Date.now() < nextRound) {
          const changed = await waitWithFollow(Math.max(0, nextRound - Date.now()), signal);
          if (changed) await schedule(checkDispatch); else break;
        }
      }
      catch (error) { if (!stop.aborted) throw error; }
    }
  }
  } finally {
    unsubscribeFollow();
    unsubscribeMaintenance();
    watchFleetMaintenance(client).hold([]);
    followWake = null;
  }

  return { history, rejected };
}

/**
 * 将单步挂机结果转换为面向控制台的中文说明。
 *
 * @param {object} entry 当前循环步骤结果。
 * @returns {string} 可展示的单步执行说明。
 */
export function formatLoopStep(entry) {
  const category = entry.category ?? ({ tasks: '任务', dailies: '日常', world: '海面' })[entry.phase] ?? '挂机';
  const title = entry.step?.label || entry.title || entry.label;
  const action = [title, entry.note && entry.note !== title ? entry.note : null].filter(Boolean).join(' · ') || '检查任务';
  const message = category + ' · ' + action;
  if (entry.skipped) {
    const reason = entry.reason || entry.error;
    return message + '已跳过' + (reason ? '：' + reason : '');
  }
  if (entry.status === 'reminder') return message + '提醒：' + (entry.reason || '请检查自动化设置');
  if (entry.status === 'uncertain') return message + '待确认，未重复提交：' + (entry.reason || '等待下次只读核对');
  // 主线回包已明确给出胜负；没有错误原因时表示战败而非请求或网络异常。
  if (entry.request === 'ChallengeStageRequest' && entry.status === 'failed' && !entry.error && !entry.reason)
    return message + '已确认战败';
  if (entry.ok === false) return message + '失败：' + (entry.error || '未返回原因');
  if ('sent' in entry) return message + '（已发送）';
  return message;
}

/** 汇总上游任务及新版模块结果，避免模块执行未计入本轮统计。 */
export function formatLoopRound(summary) {
  const results = [...summary.tasks.results, ...summary.dailies.results, ...summary.world.results,
    ...[...(summary.automation?.results ?? []), ...(summary.routines ?? [])].map(row => ({ ok: row.status === 'success', skipped: ['skipped', 'disabled', 'planned'].includes(row.status) }))];
  const skipped = results.filter(entry => entry.skipped).length;
  const failed = results.filter(entry => !entry.skipped && entry.ok === false).length;
  const sent = results.filter(entry => !entry.skipped && entry.ok && 'sent' in entry).length;
  const done = results.filter(entry => !entry.skipped && entry.ok && !('sent' in entry)).length;
  const counts = [];
  if (done) counts.push('完成 ' + done + ' 项');
  if (sent) counts.push('已发送 ' + sent + ' 项');
  if (skipped) counts.push('跳过 ' + skipped + ' 项');
  if (failed) counts.push('失败 ' + failed + ' 项');
  return '挂机第 ' + summary.round + ' 轮结束 · ' + (counts.join('，') || '本轮没有可执行的操作')
    + (summary.world.population ? ' · 人口 ' + summary.world.population : '');
}
