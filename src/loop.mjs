// 自动循环：每轮依次跑 任务领取 → 日常（含任务奖励与活跃度宝箱） → 海面（收成品/竣工/建造/交单/排产/升级）。
//
// 循环是显式开的：必须同时给 --loop 与 --yes，且每轮都是「先只读探测，再算计划，再执行」，
// 所以第二轮起没有可做的事时计划自然为空，不会重复发同样的请求。
// 被服务端拒过的具体动作记在 rejected 里跨轮传递（runTasks / runWorld 各自维护）。

import { claimCollection, collectFloaters } from './collections.mjs';
import { serviceCargo } from './cargo.mjs';
import { serviceBoats } from './boats.mjs';
import { sweepTrials } from './trials.mjs';
import { normalize } from './worlds.mjs';
import { surveyTasks, runTasks } from './tasks.mjs';
import { surveyDailies, runDailies } from './dailies.mjs';
import { surveyWorld, planWorld, runWorld } from './world.mjs';

import { setTimeout as pause } from 'node:timers/promises';
import { claimRewards } from './claim-rewards.mjs';
import { claimWeekly, runLinkage } from './activities.mjs';
import { automationTasks, dailyTaskKey, worldTaskKey } from './automation.mjs';

const defaultSleep = (ms, signal) => pause(ms, undefined, { signal });

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

export async function runLoop(client, protocol, {
  config = null,
  player = null,
  rounds = 1,
  everyMs = 60_000,
  allowMutate = false,
  allowPaid = false,
  allowSpeedUp = false,
  allowReroll = false,
  sleep = defaultSleep,
  stop = { aborted: false },
  isEnabled,
  schedule = work => work(),
  onRound,
  onStep,
} = {}) {
  if (!allowMutate) throw new Error('循环会持续改变账号状态，需要 --yes');
  const rejected = { tasks: new Set(), world: new Set() };
  const history = [];
  // rounds <= 0 表示一直跑，靠 stop.aborted（Ctrl-C 或网页停止按钮）退出。
  const total = rounds > 0 ? rounds : Infinity;

  for (let round = 1; round <= total; round += 1) {
    if (stop.aborted) break;
    const empty = () => ({ planned: 0, results: [] });
    const summary = { round, startedAt: Math.floor(Date.now() / 1000), tasks: empty(), dailies: empty(), world: empty() };
    const enabled = key => !stop.aborted && (isEnabled ? isEnabled(key) : true);
    const groupEnabled = group => automationTasks.some(task => task.group === group && enabled(task.key));
    const stepLog = phase => entry => onStep?.({ round, phase, ...entry });
    let afkDeadline;
    let factoryDeadline;
    const rememberDeadline = time => { afkDeadline = time; };
    const logReward = entry => stepLog('tasks')({ title: entry.label, ...entry });
    const allowDaily = (id, action) => enabled(dailyTaskKey(id, action));
    const allowWorld = kind => enabled(worldTaskKey(kind));
    function phaseFailure(phase, title, error) {
      if (!client.connected) throw error;
      const entry = { title, ok: false, error: error.message };
      summary[phase].results.push(entry);
      stepLog(phase)(entry);
    }

    await schedule(async () => {
      if (stop.aborted) return;
      if (!isEnabled && enabled('tasks')) {
        try {
          const survey = await surveyTasks(client, protocol, { config });
          summary.tasks.planned = survey.plan.length;
          summary.tasks.results = await runTasks(client, protocol, survey, {
            allowMutate, enabled: () => enabled('tasks'), onStep: stepLog('tasks'),
          });
        } catch (error) { phaseFailure('tasks', '任务检查', error); }
      }
      if (groupEnabled('日常')) {
        try {
          const includeTask = (id) => !isEnabled || (id === 1002 && enabled('freeRecruit')) ||
            (id === 1006 && enabled('freeGold')) || enabled(dailyTaskKey(id, { body: {} }));
          const survey = await surveyDailies(client, protocol, { config, player, includeTask, probeGift: !isEnabled });
          summary.dailies.planned = survey.tasks.reduce((n, entry) =>
            n + (entry.actions ?? []).filter(action => allowDaily(entry.task.id, action)).length, 0);
          if (!isEnabled) summary.dailies.planned += (survey.chests?.actions.length ?? 0) + (survey.gift?.actions.length ?? 0);
          if (summary.dailies.planned) {
            summary.dailies.results = await runDailies(client, protocol, survey, {
              allowMutate, allowPaid: isEnabled ? true : allowPaid, claimRewards: !isEnabled, config,
              allowAction: allowDaily, onStep: stepLog('dailies'),
            });
          }
        } catch (error) { phaseFailure('dailies', '日常检查', error); }
      }
      if (isEnabled && groupEnabled('领奖')) {
        const results = await claimRewards(client, protocol, config, logReward, enabled, rememberDeadline);
        summary.tasks = { planned: results.length, results };
      }
      if (isEnabled && enabled('trialSweep')) {
        await sweepTrials(client, config, player?.level ?? 0, () => enabled('trialSweep'), entry => {
          summary.dailies.planned++;
          summary.dailies.results.push(entry);
          stepLog('dailies')(entry);
        });
      }
      for (const [key, label] of [['fishBook', '钓鱼图鉴'], ['newbieLogin', '新手七日登录']]) {
        if (!isEnabled || !enabled(key)) continue;
        try {
          await claimCollection(client, config, key, enabled, entry => {
            summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward(entry);
          });
        } catch (error) { phaseFailure('tasks', label, error); }
      }
      if (isEnabled && ['evilExpel', 'compassReward', 'edict'].some(enabled)) {
        await runLinkage(client, config, enabled, entry => {
          if (!entry.skipped) summary.tasks.planned++;
          summary.tasks.results.push(entry);
          logReward(entry);
        });
      }
      if (isEnabled && groupEnabled('船只')) {
        try {
          await serviceBoats(client, config, enabled, entry => {
            if (!entry.skipped) summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward(entry);
          });
        } catch (error) { phaseFailure('tasks', '船只检查', error); }
      }
      if (isEnabled && ['weekPass', 'weekGift', 'weekTimes'].some(enabled)) {
        try {
          await claimWeekly(client, config, enabled, entry => {
            if (!entry.skipped) summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward(entry);
          }, player?.level);
        } catch (error) { phaseFailure('tasks', '周活动检查', error); }
      }
      if (groupEnabled('海面')) {
        const survey = await surveyWorld(client, protocol, { config, player, includeCargo: !!isEnabled && enabled('cargo') && allowWorld('startProduce'), includeWeekOrder: allowWorld('startProduce') || allowWorld('weekFactory') || allowWorld('farm') || allowWorld('upgrade') });
        if (isEnabled && (enabled('collect') || enabled('startProduce')))
          factoryDeadline = nextFactoryCheck(survey.factories, client.serverClockOffsetMs || 0, enabled('collect'));
        const plan = planWorld(survey, { config, enabled: allowWorld,
          allowSpeedUp: isEnabled ? enabled('speedUp') : allowSpeedUp,
          allowReroll: isEnabled ? enabled('denyOrder') : allowReroll,
          minOrderExp: isEnabled && enabled('denyOrder') ? null : 0,
        });
        summary.world = { planned: plan.actions.length, population: survey.population + '/' + survey.maxPopulation,
          notes: [...survey.notes, ...plan.notes], results: [] };
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
          const result = await runWorld(client, protocol, plan, {
            allowMutate, enabled: allowWorld, rejected: rejected.world, onStep: stepLog('world'),
          });
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
                const title = id + '：' + detail;
                summary.world.upgrades.push(title);
                stepLog('world')({ title, ok: true });
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
                const title = b.buildingId + ' 生产格 ' + before + ' → ' + (count ?? '?') + '/' + survey.factorySlots +
                  (reasons.length ? '，' + [...new Set(reasons)].join('；') : '，已排满');
                summary.world.factories.push(title);
                stepLog('world')({ title, ok: true });
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
    if (round < total && !stop.aborted) {
      try {
        const signal = typeof stop.addEventListener === 'function' ? stop : undefined;
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
            await schedule(() => enabled('afk') && claimRewards(client, protocol, config, logReward, key => key === 'afk' && enabled(key), rememberDeadline));
            if (!afkDeadline || afkDeadline <= Date.now()) afkDeadline = Date.now() + 60_000;
          }
          const checkUpgrade = enabled('upgrade') && upgradeAt <= Date.now();
          if ((factoryAt <= Date.now() || checkUpgrade) && Date.now() < nextRound) {
            await schedule(async () => {
              if (!enabled('collect') && !enabled('startProduce') && !enabled('upgrade')) return;
              try {
                const survey = await surveyWorld(client, protocol, { config, player, includeWeekOrder: enabled('startProduce') || checkUpgrade,
                  includeCargo: enabled('cargo') && (enabled('startProduce') || checkUpgrade) });
                const orderRead = !survey.notes.some(note => note.startsWith('本轮未能读取周订单'));
                const allow = kind => {
                  if (kind === 'gainFactory') return enabled('collect');
                  if (kind === 'finishUpgrade') return checkUpgrade && enabled('finishUpgrade');
                  if (kind === 'upgrade') return checkUpgrade && enabled('upgrade') && orderRead;
                  return kind === 'startProduce' && enabled('startProduce') && orderRead;
                };
                const plan = planWorld(survey, { config, enabled: allow });
                await runWorld(client, protocol, plan, { allowMutate, enabled: allow, onStep: stepLog('world') });
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

export function formatLoopRound(summary) {
  const ok = (results) => results.filter((entry) => entry.ok).length;
  const failed = (results) => results.filter((entry) => entry.ok === false && !entry.skipped).length;
  const line = (name, part) => `  ${name} 计划 ${part.planned}，成功 ${ok(part.results)}，失败 ${failed(part.results)}`;
  return [
    `第 ${summary.round} 轮`,
    line('任务', summary.tasks),
    line('日常', summary.dailies),
    summary.world.population ? `${line('海面', summary.world)}  人口 ${summary.world.population}` : '海面 已暂停',
  ].join('\n');
}
