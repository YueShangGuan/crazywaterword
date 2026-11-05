import { amount, idString } from './context.mjs';
import { businessDate } from './settings.mjs';
import { serverTime } from './schedule.mjs';
import { makeTypeResolver } from '../world.mjs';
import { skip } from './common.mjs';

/** 当前连接校时后的业务日，用于区分每日权益和防重复记录。 */
function date(ctx) { return businessDate(serverTime(ctx)); }

/** 周期边界在每次写入前重查，结束时刻不包含在开放区间内。 */
function periodOpen(ctx, period) {
  const now = serverTime(ctx) / 1000;
  return period.startTime <= now && now < period.endTime;
}

/** 只在明确解锁且服务端下发有效周期时处理周战令，不推算历史周期。 */
async function battlePeriod(ctx) {
  const threshold = ctx.rows('ModuleOpenCfg').find(row => row.moduleId === '周活动')?.playerLevel;
  if (threshold > ctx.player.level) { skip(ctx, '勇士战令尚未解锁'); return null; }
  const state = await ctx.query('WeekInfoRequest');
  const period = state.activityTime?.find(row => row.type === 1 && periodOpen(ctx, row));
  if (!period) skip(ctx, '勇士战令未开放或缺少当前周期');
  return period;
}

/** 配置按分组等级向下匹配；本角色缺席榜单时不能用零分或其他玩家替代。 */
function crossProgress(ctx, state) {
  if (state.grouping) throw new Error('跨服比拼正在分组');
  if (!(state.roomLevel > 0) || !(state.subjectId > 0) || !Object.hasOwn(state, 'gotDailyRewardIdx')) throw new Error('跨服比拼未开放或状态不足');
  const mine = state.rankList?.find(row => idString(row.playerId) === ctx.roleId);
  if (!mine || !Object.hasOwn(mine, 'score')) throw new Error('跨服榜单缺少本角色积分');
  const rows = ctx.rows('CrossRankDailyRwdCfg').filter(row => row.subjectId === state.subjectId && row.level <= state.roomLevel);
  const level = Math.max(...rows.map(row => row.level));
  const tiers = rows.filter(row => row.level === level).sort((a, b) => a.needScore - b.needScore);
  if (!tiers.length) throw new Error('缺少当前分组的积分宝箱配置');
  const claimed = state.gotDailyRewardIdx;
  if (!Number.isInteger(claimed) || claimed < 0 || claimed > tiers.length) throw new Error('积分宝箱领取档位无效');
  return { claimed, earned: tiers.filter(row => amount(mine.score) >= row.needScore).length, tiers };
}

/** 每次领取后读回进度，兼容服务端一次合并领取或逐次领取，停滞时立即结束链路。 */
export async function claimCrossRank(ctx) {
  const threshold = ctx.rows('ModuleOpenCfg').find(row => row.moduleId === '每日跨服比拼')?.playerLevel;
  const days = ctx.rows('CrossRankParamCfg').find(row => row.paramName === '每日跨服比拼开启')?.paramValue;
  if (threshold > ctx.player.level || (ctx.season <= 1 && days > 0 && ctx.player.worldOpenTime > 0
    && Math.floor((serverTime(ctx) - ctx.player.worldOpenTime * 1000) / 86400_000) + 1 < days)) return skip(ctx, '跨服比拼尚未开放');
  const today = date(ctx);
  let state = await ctx.query('CrossRankInfoRequest');
  for (let iteration = 0; iteration < 100; iteration++) {
    const before = crossProgress(ctx, state);
    if (before.claimed >= before.earned) return skip(ctx, '跨服积分宝箱当前已全部领取或积分未达标');
    const subject = state.subjectId, settleTime = state.settleTime;
    const allowed = () => date(ctx) === today && (!settleTime || serverTime(ctx) / 1000 < settleTime);
    if (!allowed()) return skip(ctx, '跨服积分宝箱已跨日或进入结算，下一轮重新查询');
    let after;
    /** 定向确认同一天同主题的领取档位，不把跨日重置或重新分组当作成功。 */
    const confirm = async () => {
      after = await ctx.query('CrossRankInfoRequest');
      return allowed() && after.subjectId === subject && after.roomLevel === state.roomLevel
        && crossProgress(ctx, after).claimed > before.claimed;
    };
    const result = await ctx.action('GetDailyRewardRequest', {}, {
      response: 'GotRewardResponse', label: `跨服积分宝箱 · 领取第 ${before.claimed + 1}–${before.earned} 档`,
      key: `cross:${today}:${subject}:${state.roomLevel}:${before.claimed}`, allowed,
      confirm, confirmAfterResponse: true, continueAfterUncertain: true, blockModuleOnUncertain: false,
    });
    if (result.status !== 'success') return;
    ctx.record({ status: 'success', label: `跨服积分宝箱 · 实际已领至第 ${after.gotDailyRewardIdx} 档` });
    state = after;
  }
  skip(ctx, '跨服积分宝箱达到单轮安全上限，下一轮重查');
}

/** 只列出当前积分达到且未领取的已有权益，未激活付费战令时绝不请求付费资格。 */
function passRewards(ctx, period, state) {
  return ctx.rows('WeekBattlePassCfg').filter(row => row.periodId === period.period && state.score >= row.reqScore)
    .flatMap(row => {
      const got = state.got?.find(item => item.stage === row.rwdId);
      return [row.freeReward?.length && !got?.freeGot ? `${row.rwdId}:free` : null,
        state.activePay && row.payReward?.length && !got?.payGot ? `${row.rwdId}:pay` : null].filter(Boolean);
    });
}

/** 已有权益标记是未决档位领取的定向证据，积分上涨不能代替领取成功。 */
function passRewardGot(state, key) {
  const [stage, kind] = key.split(':');
  return state.got?.some(item => item.stage === Number(stage) && item[kind === 'free' ? 'freeGot' : 'payGot']);
}

/** 任务积分和档位各自反复查询；每次必须证明领取状态推进，不用旧积分推算后续奖励。 */
export async function claimBattlePass(ctx) {
  const period = await battlePeriod(ctx);
  if (!period) return;
  const taskRows = ctx.rows('WeekPassTaskCfg');
  if (!taskRows.length || !ctx.rows('WeekBattlePassCfg').length) return skip(ctx, '缺少勇士战令任务或档位配置');
  const today = date(ctx), allowed = () => periodOpen(ctx, period) && date(ctx) === today;
  let state = await ctx.query('WeekBattlePassInfoRequest');
  // 可领列表会随积分变化；先恢复同周期未决空请求，不能用新列表生成新键绕过旧请求保护。
  const rewardPrefix = `passReward:${period.period}:${period.startTime}:`;
  for (const key of Object.keys(ctx.ledger.pending).filter(key => key.startsWith(rewardPrefix))) {
    if (!key.slice(rewardPrefix.length).split(',').some(item => passRewardGot(state, item))) return skip(ctx, '勇士战令档位存在未确认领取，等待只读核对');
    ctx.settlePending(key);
  }
  for (let iteration = 0; iteration < 100 && allowed(); iteration++) {
    const task = state.task?.find(item => !item.isGot && taskRows.some(cfg => cfg.taskId === item.taskId && cfg.target > 0 && amount(item.progress) >= cfg.target));
    if (!task) break;
    const cfg = taskRows.find(row => row.taskId === task.taskId);
    let after;
    /** 只有任务已领取且积分增加才推进，避免服务端进度滞后时重复请求同一任务。 */
    const confirm = async () => {
      after = await ctx.query('WeekBattlePassInfoRequest');
      return allowed() && Boolean(after.task?.find(item => item.taskId === task.taskId)?.isGot) && after.score > state.score;
    };
    const result = await ctx.action('WeekBattlePassFinishTaskRequest', { taskId: task.taskId }, {
      label: `勇士战令任务积分 · ${cfg.desc}`, allowed,
      key: `passTask:${period.period}:${period.startTime}:${today}:${task.taskId}`,
      confirm, confirmAfterResponse: true, continueAfterUncertain: true, blockModuleOnUncertain: false,
    });
    if (result.status !== 'success') return;
    ctx.record({ status: 'success', label: `勇士战令任务积分 · 实际增加 ${after.score - state.score} 分，当前 ${after.score} 分` });
    state = after;
  }
  // 积分领取完成后必须重新读取最新积分，不能沿用领取前的档位快照。
  state = await ctx.query('WeekBattlePassInfoRequest');
  for (let iteration = 0; iteration < 100 && allowed(); iteration++) {
    const ready = passRewards(ctx, period, state);
    if (!ready.length) return skip(ctx, '勇士战令当前已达标权益已全部领取');
    let after;
    /** 即使响应合并了多档，也逐项比较 free/pay 标记，必须至少有一个目标权益消失。 */
    const confirm = async () => {
      after = await ctx.query('WeekBattlePassInfoRequest');
      return allowed() && ready.some(key => passRewardGot(after, key));
    };
    const result = await ctx.action('WeekBattlePassGotRewardRequest', {}, {
      label: `勇士战令档位 · 领取 ${ready.join('、')}`, allowed,
      key: `passReward:${period.period}:${period.startTime}:${ready.join(',')}`,
      confirm, confirmAfterResponse: true, continueAfterUncertain: true, blockModuleOnUncertain: false,
    });
    if (result.status !== 'success') return;
    const remaining = new Set(passRewards(ctx, period, after));
    ctx.record({ status: 'success', label: `勇士战令档位 · 实际领取 ${ready.filter(key => !remaining.has(key)).join('、')}` });
    state = after;
  }
}

/** 仅读取真实培育室队列；普通建筑默认 petBreed 字段不能用于判断容量。 */
function breedRoom(ctx, water) {
  const types = new Set(ctx.rows('BuildingCfg').filter(row => row.name === '宠物').map(row => row.buildingType));
  const resolve = makeTypeResolver(ctx.config);
  return water.building?.find(building => types.has(resolve(building.buildingId)) && building.petBreed);
}

/** 队列槽位可能重用，必须联合服务端起止时间识别同一培育任务。 */
function breedJobKey(job) { return JSON.stringify([job.idx, job.petId, job.startTime, job.finishTime]); }

/** 从新加入的服务端队列任务确认每日补做，不能以战令进度或任意队列变化代替。 */
function breedConfirmed(water, intent) {
  return water.building?.find(building => building.buildingId === intent.buildingId)?.petBreed?.breedQ
    ?.some(job => job.petId === intent.petId && !intent.before.includes(breedJobKey(job)));
}

/** 每日补做独立于普通宠物模式；先持久化意图，再提交一次，重启后只读核对未决结果。 */
export async function prepareDailyBreed(ctx) {
  if (!ctx.settings.modules.pet.dailyBreedForPass) return;
  const today = date(ctx), memoryKey = 'dailyBreedForPass';
  let record = structuredClone(ctx.memory(memoryKey) ?? {});
  if (record.intent) {
    const water = await ctx.query('OnWaterRequest');
    if (!breedConfirmed(water, record.intent)) return skip(ctx, '每日培育上次提交结果未确认，保留意图并禁止重复培育');
    ctx.settlePending(record.intent.key);
    record = { date: record.intent.date, done: true };
    ctx.memory(memoryKey, record);
  }
  if (record.date === today && record.done) return skip(ctx, '今天已补做一次勇士战令海兽培育');
  const period = await battlePeriod(ctx);
  if (!period) return;
  const cfg = ctx.rows('WeekPassTaskCfg').find(row => row.type === '培育海兽');
  const state = await ctx.query('WeekBattlePassInfoRequest');
  const task = state.task?.find(row => row.taskId === cfg?.taskId);
  if (!(cfg?.target > 0) || !task || !Object.hasOwn(task, 'progress')) return skip(ctx, '缺少勇士战令海兽培育任务状态或目标，不补做');
  if (task.isGot || amount(task.progress) >= cfg.target) return skip(ctx, '勇士战令海兽培育任务已达标');
  await ctx.refreshStock();
  const water = await ctx.query('OnWaterRequest'), room = breedRoom(ctx, water);
  if (!room || !(room.petBreed.maxQLength > (room.petBreed.breedQ?.length ?? 0))) return skip(ctx, '每日培育缺少真实培育室空位，下一轮重查');
  // 只用配方对应现有材料；排除任何钻石配方，绝不领取成熟海兽、使用万能材料或加速腾位。
  const recipes = ctx.rows('PetBreedCfg').filter(row => row.season <= ctx.season && row.qualityIndex > 0
    && Number.isFinite(row.breedTime) && row.cost?.length && !row.cost.some(([id]) => id === 'RUBY') && ctx.enough(row.cost));
  /** 同品质优先短耗时、低金币和稳定配方 ID，确保多轮选择一致。 */
  const gold = row => row.cost.filter(([id]) => id === 'GOLD').reduce((sum, [, num]) => sum + num, 0);
  recipes.sort((a, b) => a.qualityIndex - b.qualityIndex || a.breedTime - b.breedTime || gold(a) - gold(b) || a.petId.localeCompare(b.petId));
  const recipe = recipes[0];
  if (!recipe) return skip(ctx, '每日培育对应材料不足，下一轮重查');
  const intent = { date: today, buildingId: room.buildingId, petId: recipe.petId,
    before: (room.petBreed.breedQ ?? []).map(breedJobKey), key: `dailyBreed:${today}` };
  const allowed = () => date(ctx) === today && periodOpen(ctx, period);
  if (!allowed()) return;
  // 意图先于网络发送落盘，确保崩溃窗口也不能提交第二只。
  ctx.memory(memoryKey, { intent });
  const result = await ctx.action('PetBreedRequest', { petId: recipe.petId, universal: false }, {
    label: `每日勇士战令 · 培育 ${recipe.petId}`, expenses: recipe.cost, response: null, key: intent.key, allowed,
    confirm: async () => breedConfirmed(await ctx.query('OnWaterRequest'), intent),
    continueAfterUncertain: true, blockModuleOnUncertain: false,
  });
  if (result.status === 'success') ctx.memory(memoryKey, { date: today, done: true });
  // 明确拒绝或提交前跳过没有发生写入，可以在下轮重查；未知结果必须保留意图。
  else if (['rejected', 'skipped', 'planned'].includes(result.status)) ctx.memory(memoryKey, {});
}

/** 固定日常在共享角色锁内独立运行；某个奖励链停滞不影响另一种权益的检查。 */
export async function runFixedRoutines(ctx, phase) {
  for (const work of phase === 'before' ? [prepareDailyBreed] : [claimCrossRank, claimBattlePass]) {
    if (ctx.stop.aborted) break;
    try { await work(ctx); }
    catch (error) {
      if (!ctx.client.connected || ctx.stop.aborted) throw error;
      ctx.record({ status: 'skipped', label: { prepareDailyBreed: '每日海兽培育', claimCrossRank: '跨服积分宝箱', claimBattlePass: '勇士战令' }[work.name], reason: error.message });
    }
  }
}
