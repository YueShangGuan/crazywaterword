import { randomUUID } from 'node:crypto';
import { amount } from './context.mjs';
import { skip } from './common.mjs';
import { planProduction, productionEffects, waitingProduction } from './production-planner.mjs';

const MEMORY_KEY = 'factory.production';

/** 以产品的库存、未领取成品和队列总量确认写入，普通生产完成不改变这个总量。 */
function outputCount(water, stock, id) {
  let count = stock.get(id) ?? 0;
  for (const building of water.building ?? []) {
    count += (building.factory?.factoryQ ?? []).filter(job => job.productId === id).length;
    count += (building.factory?.finishedProducts ?? []).filter(item => item.id === id).reduce((sum, item) => sum + amount(item.num), 0);
  }
  return count;
}

/** 按服务端制造位身份寻找具体任务，不用整座工厂发生变化代替目标动作成功。 */
function findJob(water, target) {
  return water.building?.find(building => building.buildingId === target.buildingId)?.factory?.factoryQ
    ?.find(job => job.idx === target.idx && job.productId === target.productId);
}

/**
 * 执行三档排产；每次写后读回水面和真实库存，取消不推算原料返还。
 * 调度状态按角色持久化；写前记录意图，避免取消成功后进程退出使原任务丢失。
 * @param {object} ctx 当前角色的自动化上下文。
 * @param {object} options 工厂设置。
 * @param {object[]} needs 含已被库存覆盖项的完整订单需求。
 * @param {string[]} disabledBuildings 不允许操作的建筑类型。
 * @returns {Promise<void>} 本轮无可执行动作、预览或写入未确认时结束。
 */
export async function scheduleProduction(ctx, options, needs, disabledBuildings = []) {
  const state = structuredClone(ctx.memory(MEMORY_KEY) ?? { restocking: [], streaks: {}, deferred: [], protectedJobs: {} });
  const effectsResponse = await ctx.query('GameEffectRequest');
  // 只合并本轮查询之后收到的效果推送，不能让旧推送覆盖更新的查询快照。
  const effectValues = new Map((effectsResponse.effects ?? []).map(row => [row.id, row.value]));
  /** 多个效果逐项更新，不能用最后一个减时推送覆盖之前收到的速度更新。 */
  const captureEffect = message => {
    if (message.name === 'SCGameEffectUpdate' && message.body.effect) effectValues.set(message.body.effect.id, message.body.effect.value);
  };
  ctx.client.on('message', captureEffect);
  const accelerated = new Set(), warnings = new Set();
  /** 状态变更立即落盘；预览由上下文保证不保存到真实角色账本。 */
  function persist() { ctx.memory(MEMORY_KEY, state); }
  /** 只在产品数量的定向证据成立后结算取消或开工意图。 */
  function finishIntent(water) {
    const intent = state.intent;
    if (intent.kind === 'reorder') {
      state.deferred.push({ buildingId: intent.buildingId, productId: intent.productId, token: intent.token });
    } else {
      state.deferred = state.deferred.filter(entry => entry.token !== intent.token);
      // 恢复低水位的紧急补货不计入让位计数，避免只补三件就让一小时长任务占住生产位。
      state.streaks[intent.buildingId] = intent.tier < 3 && !intent.urgent ? (state.streaks[intent.buildingId] ?? 0) + 1 : 0;
      if (intent.longDue) {
        // 将保底和开工确认一次性落盘，崩溃恢复也不会丢掉新长任务的位置保护。
        const job = water.building?.find(row => row.buildingId === intent.buildingId)?.factory?.factoryQ
          ?.find(job => job.productId === intent.productId && !intent.beforeIndexes.includes(job.idx));
        if (job) state.protectedJobs[intent.buildingId] = { idx: job.idx, productId: job.productId };
      }
    }
    delete state.intent;
    persist();
  }
  /** 断线或崩溃重启后只读核对，不把未知结果当作未发送而重复取消/开工。 */
  async function recoverIntent(water) {
    if (!state.intent) return true;
    const intent = state.intent;
    const count = outputCount(water, ctx.stock, intent.productId);
    const verified = intent.kind === 'reorder' ? !findJob(water, intent) && count < intent.before : count > intent.before;
    if (!verified) {
      skip(ctx, '存在未确认的工厂重排/开工动作，停止排产以避免重复操作', intent.buildingId);
      return false;
    }
    ctx.settlePending(intent.key);
    finishIntent(water);
    return true;
  }
  try {
    let water = await ctx.query('OnWaterRequest');
    if (!await recoverIntent(water)) return;
    // 保留游戏自动生产；需求材料只能在现有队列有空位时追加到队尾，不能关闭自动生产抢占队列。
    for (let iteration = 0; iteration < 200; iteration++) {
      ctx.assertReady();
      water = await ctx.query('OnWaterRequest');
      const plan = planProduction({ config: ctx.config, water, stock: ctx.stock, needs, options, disabledBuildings,
        effects: productionEffects({ effects: [...effectValues].map(([id, value]) => ({ id, value })) }, ctx.protocol), now: ctx.now() / 1000, state });
      state.restocking = plan.restocking;
      for (const [buildingId, protectedJob] of Object.entries(state.protectedJobs)) {
        if (!plan.waiting?.some(job => job.buildingId === buildingId && job.idx === protectedJob.idx && job.productId === protectedJob.productId)) delete state.protectedJobs[buildingId];
      }
      persist();
      for (const warning of plan.warnings) if (!warnings.has(warning)) { warnings.add(warning); skip(ctx, warning); }
      if (options.gain) {
        const building = plan.factories.find(row => row.factory.finishedProducts?.length);
        if (building) {
          const before = building.factory.finishedProducts.reduce((sum, item) => sum + amount(item.num), 0);
          const result = await ctx.action('GainFactoryProduceRequest', { buildingId: building.buildingId }, { label: '领取排产成品并刷新材料', confirmAfterResponse: true, confirm: async () => {
            const current = (await ctx.query('OnWaterRequest')).building?.find(row => row.buildingId === building.buildingId)?.factory;
            return Boolean(current) && (current.finishedProducts ?? []).reduce((sum, item) => sum + amount(item.num), 0) < before;
          } });
          if (result.status !== 'success' || ctx.stop.aborted) return;
          continue;
        }
      }
      const speedTarget = options.speedUpForDemand && (ctx.stock.get('加速器') ?? 0) > 0
        && plan.active?.find(job => job.demand && job.finishTime > ctx.now() / 1000 && !accelerated.has(job.buildingId)
          && plan.factories.some(building => building.buildingId === job.buildingId));
      if (speedTarget) {
        const beforeItems = ctx.stock.get('加速器');
        const result = await ctx.action('SpeedUpFactoryProduceRequest', { buildingId: speedTarget.buildingId, index: speedTarget.idx, speedUp: { type: 2, useNum: 1 } }, {
          label: '为订单在产项使用一个加速器', expenses: [['加速器', 1]], confirm: async () => {
            const current = findJob(await ctx.query('OnWaterRequest'), speedTarget);
            await ctx.refreshStock();
            return (ctx.stock.get('加速器') ?? 0) < beforeItems && (!current || current.finishTime < speedTarget.finishTime);
          },
        });
        if (result.status !== 'success' || ctx.stop.aborted) return;
        accelerated.add(speedTarget.buildingId);
        continue;
      }
      const choice = plan.choices[0];
      if (!choice) return;
      const buildingId = choice.building.buildingId;
      if (choice.kind === 'protect') {
        state.protectedJobs[buildingId] = { idx: choice.task.idx, productId: choice.task.productId };
        state.streaks[buildingId] = 0;
        persist();
        continue;
      }
      if (choice.kind === 'reorder') {
        // 紧贴提交再次读取队列。即使第二生产位或原等待项刚开工，也绝不取消它。
        water = await ctx.query('OnWaterRequest');
        const queue = water.building?.find(row => row.buildingId === buildingId)?.factory?.factoryQ ?? [];
        const position = queue.findIndex(job => job.idx === choice.cancel.idx && job.productId === choice.cancel.productId);
        if (!waitingProduction(queue, position)) continue;
        const key = `factory:cancel:${buildingId}:${choice.cancel.idx}:${choice.cancel.productId}`;
        state.intent = { kind: 'reorder', buildingId, idx: choice.cancel.idx, productId: choice.cancel.productId, token: randomUUID(), key,
          before: outputCount(water, ctx.stock, choice.cancel.productId) };
        if (!ctx.dryRun) persist();
        const result = await ctx.action('CancelFactoryProduceRequest', { buildingId, index: choice.cancel.idx }, { key, label: `重排等待项 ${choice.cancel.productId}`, confirm: async () => {
          const current = await ctx.query('OnWaterRequest');
          await ctx.refreshStock();
          return !findJob(current, state.intent) && outputCount(current, ctx.stock, state.intent.productId) < state.intent.before;
        } });
        if (result.status === 'success') finishIntent(water);
        else if (result.status !== 'uncertain') { delete state.intent; persist(); }
        if (result.status !== 'success' || ctx.stop.aborted) return;
        continue;
      }
      const task = choice.task;
      const key = `factory:start:${buildingId}:${task.productId}`;
      state.intent = { kind: 'start', buildingId, productId: task.productId, tier: task.tier, token: task.deferred?.token, key, longDue: choice.longDue,
        urgent: plan.urgentBuildings.includes(buildingId),
        beforeIndexes: (choice.building.factory.factoryQ ?? []).map(job => job.idx),
        before: outputCount(water, ctx.stock, task.productId) };
      if (!ctx.dryRun) persist();
      let confirmedWater;
      const result = await ctx.action('StartFactoryProduceRequest', { buildingId, productId: task.productId }, { key,
        label: `${task.tier}档生产 ${task.productId}`, expenses: task.recipe.costItem, confirm: async () => {
          const current = await ctx.query('OnWaterRequest');
          await ctx.refreshStock();
          confirmedWater = current;
          return outputCount(current, ctx.stock, task.productId) > state.intent.before;
        },
      });
      if (result.status === 'success') {
        finishIntent(confirmedWater);
      } else if (result.status !== 'uncertain') { delete state.intent; persist(); }
      if (result.status !== 'success' || ctx.stop.aborted) return;
    }
    skip(ctx, '本轮三档排产达到 200 步上限，剩余工作下轮按库存继续');
  } finally {
    ctx.client.off('message', captureEffect);
  }
}
