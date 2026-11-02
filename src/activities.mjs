import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';

const weekNames = { 1: '周战令', 2: '累计充值', 3: '英雄升星', 4: '周抽奖', 5: '周订单', 6: '芯片活动', 7: '周翻牌' };
const serverNow = client => (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
const open = (activity, now) => activity.startTime <= now && now < activity.endTime;
const linkageNames = { 28: '风水罗盘', 29: '酆都法旨', 30: '驱邪除祟' };

function playable(row, sub, now) {
  return open(row, now) && (!sub.openTime || sub.openTime <= now) && (!sub.closeTime || now < sub.closeTime);
}

const rejectedEdicts = new WeakMap();
const tribute = '活动26捞尸人_入场券';

async function solveEdict(client, config, request, allowed, report) {
  const label = '酆都法旨';
  const state = normalize(await request('EdictInfo'));
  let session = state.session;
  if (!session) {
    rejectedEdicts.delete(client);
    if (state.cost?.id !== tribute || state.cost.num !== 1) throw new Error('开局消耗不是 1 份贡品，已跳过');
    const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
    if (!bag.items?.some(item => item.itemId === tribute && item.num >= 1)) {
      report({ label, skipped: true, reason: '贡品不足，等待补充' });
      return;
    }
    if (!allowed()) return;
    session = (await request('EdictStart')).session;
    report({ label: label + ' · 已使用 1 份贡品开局', ok: true });
  }
  const guess = session?.rune;
  if (!Array.isArray(guess) || guess.length !== 4 || !guess.every(Number.isSafeInteger)) {
    throw new Error('当前对局未返回四个符文，已保留对局');
  }
  const signature = guess.join(',');
  if (!allowed() || rejectedEdicts.get(client) === signature) return;
  const reply = normalize(await request('EdictGuess', { guess }));
  if (!reply.success) {
    rejectedEdicts.set(client, signature);
    throw new Error('服务端未确认解符成功，已停止重复提交本组符文');
  }
  rejectedEdicts.delete(client);
  const reward = (reply.reward?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
  report({ label: label + ' · 解符成功，剩余耐心 ' + reply.patience + '，积分 ' + reply.score + (reward ? '，获得' + reward : ''), ok: true });
}

export async function runLinkage(client, config, enabled, report) {
  for (const row of client.festivals ?? []) {
    for (const sub of row.subActivity ?? []) {
      const expel = sub.subActivityType === 30;
      const key = ({ 28: 'compassReward', 29: 'edict', 30: 'evilExpel' })[sub.subActivityType];
      if (!key) continue;
      const allowed = () => enabled(key) && playable(row, sub, serverNow(client));
      if (!allowed()) continue;
      const label = linkageNames[sub.subActivityType];
      const request = (name, fields = {}) => client.request(name + 'Request', { activityId: row.activityId, ...fields }, name + 'Response');
      try {
        if (key === 'edict') {
          await solveEdict(client, config, request, allowed, report);
          continue;
        }
        const state = await request(expel ? 'EvilExpelInfo' : 'CompassWheelInfo');
        let score = (expel ? state.killTotal : state.score) ?? 0;
        let claimed = (expel ? state.claimed : state.claimedId) ?? 0;
        const previousClaimed = claimed;
        for (let left = expel ? state.alive : 0; left > 0 && allowed(); left--) {
          const reply = await request('EvilExpelKill');
          if (!(reply.killTotal > score)) throw new Error('服务端未确认消灭数量增加');
          score = reply.killTotal;
          report({ label: label + ' · 已累计消灭 ' + score + ' 个', ok: true });
        }
        const table = expel ? 'LinkageLSREvilExpelTotalRewardCfg' : 'LinkageLSRCompassWheelScoreRewardCfg';
        const stages = config?.tables?.[table]?.data;
        if (!stages?.length) throw new Error('缺少累计奖励配置');
        while (allowed() && stages.some(stage => (expel ? stage.totalCount : stage.id) > claimed && score >= (expel ? stage.totalCount : stage.score))) {
          const reply = await request(expel ? 'EvilExpelClaim' : 'ClaimCompassWheelReward');
          const next = expel ? reply.claimed : reply.claimedId;
          if (!(next > claimed)) throw new Error('服务端未确认领取档位');
          claimed = next;
          report({ label: expel ? label + ' · 已领取累计消灭 ' + claimed + ' 个奖励' : label + ' · 已领取至第 ' + claimed + ' 档', ok: true });
        }
        if (previousClaimed === claimed && !(expel && state.alive)) {
          report({ label, skipped: true, reason: expel
            ? '暂无邪祟，累计消灭 ' + score + ' 个，已领取至 ' + claimed + ' 个奖励'
            : '当前 ' + score + ' 积分，已领至第 ' + claimed + ' 档，暂无可领取奖励' });
        }
      } catch (error) { report({ label, ok: false, error: error.message }); }
    }
  }
}

async function weekly(client) {
  const reply = await client.request('WeekInfoRequest', {}, 'WeekInfoResponse');
  return (normalize(reply).activityTime ?? []).filter(row => open(row, serverNow(client)));
}

export async function readWeekOrder(client, week) {
  const active = week ?? await weekly(client);
  const needed = new Map();
  if (!active.some(row => row.type === 5)) return { needed, finished: false };
  const order = normalize(await client.request('WeekOrderInfoRequest', {}, 'WeekOrderInfoResponse'));
  for (const item of order.order ?? []) needed.set(item.id, (needed.get(item.id) ?? 0) + item.num);
  return { needed, finished: Boolean(order.isGotFinal) };
}

function lotteryProgress(config, period, info) {
  const stages = config?.tables.WeekLotteryTimesCfg?.data.filter(r => r.periodId === period);
  if (!stages?.length) throw new Error('缺少本期周抽奖次数奖励配置');
  const times = info?.times ?? 0;
  const claimed = info?.gotStage ?? 0;
  const next = stages.filter(r => r.rwdId > claimed).sort((a, b) => a.rwdId - b.rwdId)[0];
  return { times, claimed, required: next?.reqTimes, ready: Boolean(next && times >= next.reqTimes) };
}

export async function activityView(client, festivals = [], config = null) {
  const week = await weekly(client);
  const activities = week.map(row => ({ name: weekNames[row.type] ?? '周活动 ' + row.type, endTime: row.endTime }));
  for (const row of festivals) {
    const linkage = (row.subActivity ?? []).filter(sub => linkageNames[sub.subActivityType]);
    if (linkage.length) {
      for (const sub of linkage) {
        if (playable(row, sub, serverNow(client))) activities.push({ name: '捞尸人联动 · ' + linkageNames[sub.subActivityType], endTime: Math.min(sub.closeTime || row.endTime, row.endTime) });
      }
    }
    if (open(row, serverNow(client))) activities.push({
      name: linkage.length || row.type === '捞尸人联动活动' ? '鄂都诡事（捞尸人联动）'
        : row.type || ({ 1: '五一活动', 2: '端午活动', 3: '人鱼活动' })[row.festival] || '节日活动 ' + row.activityId,
      endTime: row.endTime,
    });
  }
  const lotteryRow = week.find(r => r.type === 4);
  let lottery, lotteryError;
  if (lotteryRow) {
    try {
      const info = await client.request('WeekLotteryInfoRequest', {}, 'WeekLotteryInfoResponse');
      lottery = lotteryProgress(config, lotteryRow.period, info.gotInfo);
    } catch (error) { lotteryError = error.message; }
  }
  if (!week.some(row => row.type === 5)) return { activities, lottery, lotteryError, order: null };
  try {
    const { needed, finished } = await readWeekOrder(client, week);
    const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
    const stock = new Map();
    for (const item of bag.items ?? []) stock.set(item.itemId, (stock.get(item.itemId) ?? 0) + item.num);

    const materials = Array.from(needed, ([id, required]) => {
      const owned = stock.get(id) ?? 0;
      const crop = config?.tables.FarmlandPlantCfg?.data.find(r => r.id === id);
      const seed = crop ? { name: displayMaterial(config, crop.material[0]), count: stock.get(crop.material[0]) ?? 0 } : null;
      return { id, seed, sources: config?.materialSources?.(id) ?? [], name: displayMaterial(config, id), required, owned, missing: Math.max(0, required - owned) };
    });
    return { activities, lottery, lotteryError, order: { materials, finished } };
  } catch (error) {
    return { activities, lottery, lotteryError, order: null, orderError: error.message };
  }
}

const passLocks = new WeakMap();

export async function claimWeekly(client, config, enabled, report, playerLevel) {
  const week = await weekly(client);
  for (const row of week) {
    if (row.type === 4 && enabled('weekTimes')) {
      try {
        const info = await client.request('WeekLotteryInfoRequest', {}, 'WeekLotteryInfoResponse');
        let state = lotteryProgress(config, row.period, info.gotInfo);
        while (state.ready && enabled('weekTimes') && open(row, serverNow(client))) {
          const reply = await client.request('WeekLotteryTimesRewardRequest', {}, 'WeekLotteryTimesRewardResponse');
          const after = lotteryProgress(config, row.period, reply.gotInfo);
          if (after.claimed <= state.claimed) throw new Error('服务端未确认周抽奖次数奖励档位');
          report({ label: '周抽奖次数奖励 · 已领至第 ' + after.claimed + ' 档（累计 ' + after.times + ' 次）', ok: true });
          state = after;
        }
      } catch (error) { report({ label: '周抽奖次数奖励', ok: false, error: error.message }); }
    }
    const key = row.type === 1 ? 'weekPass' : row.type === 4 ? 'weekGift' : null;
    if (!key || !enabled(key)) continue;
    const allowed = () => enabled(key) && open(row, serverNow(client));
    const tables = config?.tables;
    try {
      if (key === 'weekPass') {
        const lock = passLocks.get(client);
        if (lock?.endTime === row.endTime && lock.level === playerLevel && serverNow(client) < lock.retryAt) continue;
        const state = normalize(await client.request('WeekBattlePassInfoRequest', {}, 'WeekBattlePassInfoResponse'));
        if (!tables?.WeekPassTaskCfg || !tables?.WeekBattlePassCfg) throw new Error('缺少周战令配置');
        let score = state.score ?? 0;
        for (const task of state.task ?? []) {
          const cfg = tables.WeekPassTaskCfg.data.find(t => t.taskId === task.taskId);
          if (!allowed()) break;
          if (!cfg || task.isGot || !(task.progress >= cfg.target)) continue;
          const result = await client.request('WeekBattlePassFinishTaskRequest', { taskId: task.taskId }, 'WeekBattlePassFinishTaskResponse');
          score = result.score;
          report({ label: '周战令积分 · ' + cfg.desc, ok: true });
        }
        const ready = tables.WeekBattlePassCfg.data.some(cfg => {
          if (cfg.periodId !== row.period || !(score >= cfg.reqScore)) return false;
          const got = state.got?.find(item => item.stage === cfg.rwdId);
          return (cfg.freeReward?.length && !got?.freeGot) || (state.activePay && cfg.payReward?.length && !got?.payGot);
        });
        if (ready && allowed()) {
          await client.request('WeekBattlePassGotRewardRequest', {}, 'WeekBattlePassGotRewardResponse');
          report({ label: '周战令档位奖励', ok: true });
        }
      } else {
        const cfg = tables?.WeekLotteryPackCfg?.data.find(pack => pack.price === 0 && pack.limitedTimes > 0);
        if (!cfg) throw new Error('缺少周抽奖免费礼包配置');
        const read = async () => (await client.request('WeekLotteryInfoRequest', {}, 'WeekLotteryInfoResponse'))
          .gift?.find(item => item.giftId === cfg.packId)?.gotTimes ?? 0;
        const before = await read();
        if (before >= cfg.limitedTimes || !allowed()) continue;
        await client.sendWatch('WeekLotteryFreePackRequest', {});
        if (await read() <= before) throw new Error('服务端尚未确认礼包领取');
        report({ label: '周抽奖免费礼包', ok: true });
      }
    } catch (error) {
      if (key === 'weekPass' && error.message === 'server prompt: feature locked') {
        const threshold = tables?.ModuleOpenCfg?.data.find(entry => entry.moduleId === '周活动')?.playerLevel;
        const levelHint = playerLevel > 0 && playerLevel < threshold
          ? `（当前 ${playerLevel} 级，周活动 ${threshold} 级开放）` : '';
        passLocks.set(client, { endTime: row.endTime, level: playerLevel, retryAt: serverNow(client) + 1800 });
        report({ label: weekNames[row.type], skipped: true, reason: '账号尚未解锁' + levelHint + '，稍后自动复查' });
      } else {
        report({ label: weekNames[row.type], ok: false, error: error.message });
      }
    }
  }
}
