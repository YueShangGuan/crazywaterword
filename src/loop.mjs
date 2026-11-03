// 自动循环：每轮依次跑 任务领取 → 日常（含任务奖励与活跃度宝箱） → 海面（收成品/竣工/建造/交单/排产/升级）。
//
// 循环是显式开的：必须同时给 --loop 与 --yes，且每轮都是「先只读探测，再算计划，再执行」，
// 所以第二轮起没有可做的事时计划自然为空，不会重复发同样的请求。
// 被服务端拒过的具体动作记在 rejected 里跨轮传递（runTasks / runWorld 各自维护）。

import { claimCollection, collectFloaters } from './collections.mjs';
import { serviceCargo } from './cargo.mjs';
import { serviceBoats } from './boats.mjs';
import { sweepTrials } from './trials.mjs';
import { claimGuildWelfare } from './guild.mjs';
import { fishOnce } from './fishing.mjs';
import { upgradeFishingOnce } from './fishing-upgrade.mjs';
import { serviceAntiqueRecruit } from './antique-recruit.mjs';
import { claimAdShop } from './ad-shop.mjs';
import { rewardSchedule } from './reward-schedule.mjs';
import { normalize } from './worlds.mjs';
import { surveyTasks, runTasks } from './tasks.mjs';
import { surveyDailies, runDailies } from './dailies.mjs';
import { surveyWorld, planWorld, runWorldRound, displayBuilding } from './world.mjs';

import { setTimeout as pause } from 'node:timers/promises';
import { claimRewards } from './claim-rewards.mjs';
import { claimWeekly, runLinkage } from './activities.mjs';
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

import { runAutomation, handledDailyIds } from './automation/service.mjs';
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

/** 所有已启用新玩法每轮都由统一执行服务处理，旧日常跳过这些玩法以免重复操作。 */
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
  schedule = work => work(),
  onRound,
  onStep,
} = {}) {
  if (!allowMutate) throw new Error('循环会持续改变账号状态，需要 --yes');
  // CLI 会使用默认 all；循环入口统一规范化，不能让已下架模块从任一入口重新进入执行器。
  const selectedAutomationModules = selectLoopModules(automationModules);
  const rejected = { tasks: new Set(), world: new Set() };
  const history = [];
  const rewards = isEnabled ? rewardSchedule(client) : null;
  let lastRecruitWait;
  let lastFishWait;
  let lastFishUpgradeWait;
  let lastGuildWait;
  const antiqueWait = new Map();
  let residentWait = new Map();
  // rounds <= 0 表示一直跑，靠 stop.aborted（Ctrl-C 或网页停止按钮）退出。
  const total = rounds > 0 ? rounds : Infinity;

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
      weekGift: 'welfare', weekTimes: 'welfare', weekPass: 'welfare',
      evilExpel: 'activity', edict: 'activity', compassReward: 'activity',
    };
    // 新挑战模块仅在普通试炼开启时处理免费档；VIP 广告扫荡是另一份权益，不能吞掉上游免费扫荡。
    if (settings && Object.values(settings.modules.battle.trial).some(rule => rule.challenge || rule.rubySweep)) ownership.trialSweep = 'battle';
    const enabled = key => !stop.aborted
      && !settings?.modules[ownership[key]]?.enabled
      && (!isEnabled || (isEnabled(key) && rewards.due(key)));
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
    if (stop.aborted || !client.connected) break;

    await schedule(async () => {
      if (stop.aborted) return;
      if (settings) {
        summary.automation = await runAutomation({ client, protocol, config, player, accountId, settings,
          selector: selectedAutomationModules, initialPushes, stop,
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
          const recruit = survey.tasks.find(entry => entry.task.id === 1002 && entry.status === 'waiting');
          if (recruit && recruit.reason !== lastRecruitWait) {
            stepLog('dailies')({ title: recruit.task.title, skipped: true, reason: recruit.reason });
          }
          lastRecruitWait = recruit?.reason;
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
          if (recruit) summary.dailies.results.push({ id: 1002, skipped: true, reason: recruit.reason });
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
      if (isEnabled && ['evilExpel', 'compassReward', 'edict'].some(enabled)) {
        await runLinkage(client, config, enabled, entry => {
          if (!entry.skipped) summary.tasks.planned++;
          summary.tasks.results.push(entry);
          logReward(entry, '活动');
        });
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
      if (isEnabled && ['weekPass', 'weekGift', 'weekTimes'].some(enabled)) {
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
            await collectFloaters(client, config, survey.floaters, enabled, entry => {
              summary.world.planned++;
              summary.world.results.push(entry);
              stepLog('world')({ ...entry, title: entry.label });
            });
          } catch (error) { phaseFailure('world', '漂浮物拾取', error); }
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
    });
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
          const wakeAt = Math.min(afkAt, factoryAt, enabled('upgrade') ? upgradeAt : Infinity);
          if (wakeAt >= nextRound) break;
          await sleep(Math.max(0, wakeAt - Date.now()), signal);
          if (Date.now() >= nextRound) break;
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
        if (!stop.aborted) await sleep(Math.max(0, nextRound - Date.now()), signal);
      }
      catch (error) { if (!stop.aborted) throw error; }
    }
  }

  return { history, rejected };
}

export function formatLoopStep(entry) {
  const category = entry.category ?? ({ tasks: '任务', dailies: '日常', world: '海面' })[entry.phase] ?? '挂机';
  const title = entry.step?.label || entry.title || entry.label;
  const action = [title, entry.note && entry.note !== title ? entry.note : null].filter(Boolean).join(' · ') || '检查任务';
  const message = category + ' · ' + action;
  if (entry.skipped) {
    const reason = entry.reason || entry.error;
    return message + '已跳过' + (reason ? '：' + reason : '');
  }
  if (entry.ok === false) return message + '失败：' + (entry.error || '未返回原因');
  if ('sent' in entry) return message + '（已发送）';
  return message;
}

/** 汇总上游任务及新版模块结果，避免模块执行未计入本轮统计。 */
export function formatLoopRound(summary) {
  const results = [...summary.tasks.results, ...summary.dailies.results, ...summary.world.results,
    ...(summary.automation?.results ?? []).map(row => ({ ok: row.status === 'success', skipped: ['skipped', 'disabled', 'planned'].includes(row.status) }))];
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
