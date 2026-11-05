import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';
import { createHmac, randomBytes } from 'node:crypto';
import { registerFleetReservations, isFleetReserved, hasOtherFleetReservations, observeFleetReservations } from './fleet-reservations.mjs';

// A map refresh can still contain a swept target, including after a lost reply.
const dailySweepAttempts = new WeakMap();
function sweepAttempts(client, resetTime, now) {
  if (!client) return new Map();
  const day = resetTime || Math.floor((now + 8 * 3600) / 86400);
  if (dailySweepAttempts.get(client)?.day !== day) dailySweepAttempts.set(client, { day, ids: new Map() });
  return dailySweepAttempts.get(client).ids;
}

function canSweepAgain(last, used, progress) {
  return !last || (last.confirmed && used > last.used && progress > last.progress);
}

const sweepBonus = effects => effects?.find(([name]) => name === '野怪扫荡次数')?.[1] ?? 0;
const sweepOpenLevel = config => config?.tables?.ModuleOpenCfg?.data?.find(row => row.moduleId === '世界')?.playerLevel;
const hasCardBonus = config => config?.tables?.MonthCardCfg?.data?.some(row => sweepBonus(row.effectList) > 0);

export const pirateSweepProbes = [
  ['PirateKillRecordRequest', {}, (_probe, { config, player }) => player?.level >= sweepOpenLevel(config)],
  ['AllPirateRequest', {}, probe => probe('PirateKillRecordRequest')?.records?.some(r => r.maxKilledLevel > 0)],
  ['MonthCardRequest', {}, (probe, { config }) => probe('AllPirateRequest')?.pirates?.length && hasCardBonus(config)],
];

export function planPirateSweeps({ task, probe, player, config, now, client, dailyResetTime }) {
  if (task.progress >= task.targetProgress) return { status: 'done' };
  const blocked = reason => ({ status: 'blocked', reason });
  const tables = config?.tables;
  const gate = sweepOpenLevel(config);
  if (!gate || !player?.level) return blocked('无法确认世界开放等级');
  if (player.level < gate) return blocked('角色 ' + gate + ' 级开放世界海盗');
  const records = probe('PirateKillRecordRequest')?.records;
  if (!Array.isArray(records)) return blocked('未能读取个人海盗首杀记录');
  if (!records.some(r => r.maxKilledLevel > 0)) return blocked('还没有个人海盗首杀，请在「活动 → 海盗首杀」选择目标和舰队手动出征');
  const map = probe('AllPirateRequest');
  if (!Array.isArray(map?.pirates) || !Number.isSafeInteger(map.sweepTimes) || map.sweepTimes < 0) return blocked('未能确认地图目标或今日已用扫荡次数');
  const base = tables.PirateParamCfg?.data?.find(r => r.paramName === '每日野怪扫荡次数')?.paramValue;
  if (!Number.isSafeInteger(base) || base < 0) return blocked('缺少每日野怪扫荡次数配置');
  const vip = tables.VipLevelCfg?.data?.find(r => r.level === player.vip?.vipLevel);
  const cards = probe('MonthCardRequest')?.cardItem ?? [];
  // MonthCardModel.effect uses server time and treats -1 as permanent.
  const cardBonus = cards.reduce((sum, c) => {
    const id = { 1: '普通月卡', 2: '高级月卡' }[c.type];
    return sum + (c.endTime === -1 || c.endTime > now ? sweepBonus(tables.MonthCardCfg?.data?.find(r => r.id === id)?.effectList) : 0);
  }, 0);
  const available = base + sweepBonus(vip?.effects) + cardBonus - map.sweepTimes;
  if (!Number.isSafeInteger(available) || available <= 0) return blocked('今日可确认的海盗扫荡次数已用完');
  const world = normalize(player.worldId);
  const configs = tables.WorldPirateCfg?.data?.filter(row => Number(row.season) === Math.floor(world / 1e6) % 1000);
  if (!configs?.length) return blocked('无法确认本赛季海盗配置');
  const attempts = sweepAttempts(client, dailyResetTime, now);
  const counts = new Map();
  for (const p of map.pirates) counts.set(p.uid, (counts.get(p.uid) ?? 0) + 1);
  const eligible = map.pirates.filter(p => Number.isSafeInteger(p.uid) && p.uid > 0 && counts.get(p.uid) === 1
    && Number.isSafeInteger(p.cityId) && p.cityId > 0 && Number.isSafeInteger(p.level) && p.level > 0
    && records.some(r => r.type === p.type && r.maxKilledLevel >= p.level)
    && configs.some(r => r.type === p.type && r.level === p.level));
  if (!eligible.length) return blocked('地图暂无已首杀且可明确识别的同类海盗目标');
  const remaining = task.targetProgress - task.progress;
  const choices = eligible.filter(p => canSweepAgain(attempts.get(p.uid), map.sweepTimes, task.progress))
    .sort((a, b) => b.level - a.level || Number(attempts.has(a.uid)) - Number(attempts.has(b.uid)) || a.uid - b.uid)
    .slice(0, Math.min(remaining, available));
  if (!choices.length) return blocked('当前目标均已尝试，等待新目标或服务端进度');
  const actions = choices.map(p => ({
    request: 'PirateSweepRequest', body: { uid: p.uid, cityId: p.cityId }, type: p.type, level: p.level,
    observedUsed: map.sweepTimes, observedProgress: task.progress, response: null,
    cost: '扫荡次数 ×1', note: '扫荡' + (configs.find(r => r.type === p.type && r.level === p.level).showName || '海盗') + ' ' + p.level + ' 级',
  }));
  return actions.length < remaining ? { status: 'partial', reason: '本轮可扫荡 ' + actions.length + '/' + remaining + ' 次', actions }
    : { status: 'ready', actions };
}

/**
 * 在提交扫荡前重新核验任务进度、首杀资格和当日次数，防止旧计划消耗已变化的扫荡额度。
 *
 * 生产调用必须传入 actionExecutor，使写入经过账号锁、未确认记录和读回确认；未传入时仅保留给独立协议夹具。
 *
 * @param {{ client: object, survey: object, action: object, timeout: number, allowAction: Function, config: object, actionExecutor?: (step: object) => Promise<unknown> }} options 扫荡动作与最新状态校验参数。
 * @returns {Promise<{skipped?: boolean, reason?: string, body?: object}>} 已确认的扫荡结果或跳过原因。
 */
export async function runPirateSweep({ client, survey, action, timeout, allowAction, config, actionExecutor }) {
  const read = name => client.request(name + 'Request', {}, name + 'Response', timeout);
  const daily = await read('DailyTaskInfo');
  const task = daily?.dailyTask?.find(row => row.id === 1010);
  if (!task || task.progress >= task.targetProgress || daily.dailyResetTime !== survey.daily.dailyResetTime)
    return { skipped: true, reason: '每日任务已完成或已刷新' };
  const records = await read('PirateKillRecord');
  if (!records?.records?.some(r => r.type === action.type && r.maxKilledLevel >= action.level))
    return { skipped: true, reason: '该类海盗的个人首杀记录未确认' };
  const map = await read('AllPirate');
  // The guaranteed base/VIP quota is usable even if optional card benefits cannot be read.
  const cards = hasCardBonus(config) ? await read('MonthCard').catch(() => null) : null;
  const state = { PirateKillRecordRequest: records, AllPirateRequest: map, MonthCardRequest: cards };
  const now = (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
  const fresh = planPirateSweeps({ task, probe: name => state[name], player: survey.player, client, config, now, dailyResetTime: daily.dailyResetTime });
  if (!fresh.actions?.some(a => a.body.uid === action.body.uid && a.body.cityId === action.body.cityId && a.type === action.type && a.level === action.level))
    return { skipped: true, reason: fresh.reason || '地图目标已变化，请刷新' };
  if (!allowAction(1010, action)) return { skipped: true, reason: '海盗扫荡已关闭' };
  const attempts = sweepAttempts(client, daily.dailyResetTime, now);
  if (!canSweepAgain(attempts.get(action.body.uid), action.observedUsed, action.observedProgress))
    return { skipped: true, reason: '该扫荡计划已经执行，请刷新' };
  const attempt = { used: map.sweepTimes, progress: task.progress, confirmed: false };
  attempts.set(action.body.uid, attempt);
  // 统一执行器会把 AllPirate 的次数变化作为写入确认，避免无回包协议在超时后被重复发送。
  if (actionExecutor) await actionExecutor(action);
  else await client.sendWatch('PirateSweepRequest', action.body, { window: 400 });
  const after = await read('AllPirate');
  if (!Number.isSafeInteger(after?.sweepTimes) || after.sweepTimes <= map.sweepTimes) throw new Error('服务端未确认扫荡次数增加，已停止重复尝试此目标');
  attempt.confirmed = true;
  return { body: { sweepTimes: after.sweepTimes } };
}

const PIRATE_SWEEP_VIP_EFFECT = '野怪扫荡次数';
// 非 VIP 角色已实测每天拥有 10 次基础扫荡；VipLevelCfg 配置的是在此基础上的额外次数。
const PIRATE_BASE_DAILY_SWEEP_LIMIT = 10;

/**
 * 从当前 CDN 配置和当前角色 VIP 等级读取海盗扫荡日总上限。
 *
 * @param {Record<string, {data?: object[]}>|null|undefined} tables 当前客户端使用的配置表。
 * @param {unknown} vipLevel 当前角色最新的 VIP 等级。
 * @returns {number} 该角色当天可扫荡的海盗次数上限。
 */
export function pirateDailySweepLimit(tables, vipLevel) {
  if (!Number.isSafeInteger(vipLevel) || vipLevel < 0) throw new Error('未能读取当前角色的 VIP 等级');
  // VIP0 没有配置行，直接使用所有角色共有的基础次数。
  if (vipLevel === 0) return PIRATE_BASE_DAILY_SWEEP_LIMIT;
  const vip = tables?.VipLevelCfg?.data?.find((row) => row.level === vipLevel);
  const effect = vip?.effects?.find(([name]) => name === PIRATE_SWEEP_VIP_EFFECT);
  const bonus = effect?.[1];
  // 每个 VIP 档位的额外次数由客户端下发的配置定义；缺失时不能沿用上一档或猜测加成。
  if (!Number.isSafeInteger(bonus) || bonus < 0) throw new Error('当前 VIP 等级没有海盗扫荡次数配置');
  return PIRATE_BASE_DAILY_SWEEP_LIMIT + bonus;
}

/**
 * 将服务端累计的海盗扫荡次数转换为角色当天可展示、可执行的额度。
 *
 * @param {unknown} sweepTimes 服务端返回的今日已扫荡次数。
 * @param {unknown} dailyLimit 根据当前角色 VIP 配置读取的当日上限。
 * @returns {{dailyLimit: number, used: number, remaining: number}} 当日上限、已使用和剩余次数。
 */
export function pirateSweepProgress(sweepTimes, dailyLimit) {
  // 缺失或超出当日上限的响应不能猜测为可扫荡，避免协议变化后重复发送写请求。
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0) throw new Error('当前角色海盗扫荡上限无效');
  if (!Number.isSafeInteger(sweepTimes) || sweepTimes < 0 || sweepTimes > dailyLimit)
    throw new Error('服务端返回的海盗今日已扫荡次数无效');
  return { dailyLimit, used: sweepTimes, remaining: dailyLimit - sweepTimes };
}

// WorldIdRule.getSeason in the game client.
export async function pirateTracker(client, config, player) {
  const worldId = normalize(player?.worldId);
  if (!(worldId > 0)) throw new Error('未取得角色世界编号');
  const season = Math.floor(worldId / 1e6) % 1000;
  const required = config?.tables.ModuleOpenCfg?.data.find(row => row.moduleId === '世界')?.playerLevel;
  const rows = config?.tables.WorldPirateCfg?.data.filter(r => Number(r.season) === season);
  if (!required || !rows?.length) throw new Error('缺少本赛季海盗配置');
  const locked = player.level < required;
  let records, pirates;
  const errors = [];
  if (!locked) {
    for (const [req, field] of [['PirateKillRecord', 'records'], ['AllPirate', 'pirates']]) {
      try {
        const reply = await client.request(req + 'Request', {}, req + 'Response');
        if (field === 'records') records = reply.records ?? [];
        else pirates = reply.pirates ?? [];
      } catch (error) { errors.push(error.message); }
    }
  }
  const targets = [];
  for (const type of new Set(rows.map(r => r.type))) {
    const cleared = records ? records.find(r => r.type === type)?.maxKilledLevel ?? 0 : null;
    const levels = rows.filter(r => r.type === type).sort((a, b) => a.level - b.level);
    const row = levels.find(r => r.level > (cleared ?? 0)) ?? levels.at(-1);
    targets.push({ name: row.showName, level: row.level, cleared, finished: cleared !== null && cleared >= row.level,
      power: row.power, soil: row.firstKillReward.find(([id]) => id === '有机土壤')?.[1] ?? 0,
      materials: row.firstKillReward.map(([id, n]) => displayMaterial(config, id) + ' ×' + n).join('、'),
      visible: pirates ? pirates.filter(p => p.type === type && p.level === row.level).length : null });
  }
  return { season, required, locked, targets, errors };
}

// Tokens bind the displayed map target and fleet formation to this game connection.
// Advance the revision on each send so replaying an old click cannot spend fuel twice.
const huntSessions = new WeakMap();
function huntSession(client) {
  let session = huntSessions.get(client);
  if (session) return session;
  session = { secret: randomBytes(32), revision: 0, pending: new Map() };
  huntSessions.set(client, session);
  registerFleetReservations(client, 'pirate', buildingId => [...session.pending.values()].some(flight => flight.buildingId === buildingId),
    () => session.pending.size > 0);
  function update(flight, status, text, finished = false) {
    if (flight.result?.status === status) return;
    if (finished) session.pending.delete(flight.uid);
    flight.result = { status, label: flight.label + ' · ' + text };
    flight.report?.(flight.result);
  }
  function record(record) {
    for (const flight of session.pending.values()) {
      if (record?.type === flight.type && record.maxKilledLevel >= flight.level)
        update(flight, 'won', '已确认首杀，记录已更新', true);
    }
  }
  session.record = record;
  function observeFleet(fleet) {
    for (const flight of session.pending.values()) {
      if (fleet.buildingId !== flight.buildingId || ![2, 3].includes(fleet.state)) continue;
      const movingToTarget = fleet.targetGridIdx === flight.grid && fleet.targetCityId === flight.city;
      const atTarget = fleet.state === 3 && fleet.curGridIdx === flight.grid && fleet.cityId === flight.city;
      if (movingToTarget || atTarget) {
        flight.ownMovement = true;
        if (!flight.endSeen) update(flight, 'started', '舰队已向目标出征');
      }
    }
  }
  session.observeFleet = observeFleet;
  client.on?.('message', ({ name, body }) => {
    if (name === 'SCPirateKillRecordUpdate') { record(body.record); return; }
    if (name === 'SCMyFleetUpdate') {
      for (const fleet of body.fleets ?? []) observeFleet(fleet);
      return;
    }
    const flight = session.pending.get(body?.uid);
    if (!flight) return;
    // World battle pushes identify the target, not the participant. The selected
    // fleet's movement or our own kill record provides the account-specific evidence.
    if (name === 'SCPirateCampaignBegin' && !flight.endSeen && !flight.ownMovement) update(flight, 'pending', '目标已开战，等待舰队状态');
    if (name === 'SCPirateCampaignEnd') {
      flight.endSeen = true;
      if (body.isWin === true) update(flight, 'ended', '目标战斗已胜，等待个人首杀记录');
      else if (body.isWin === false && flight.ownMovement) update(flight, 'lost', '目标战斗未获胜', true);
      else if (body.isWin === false) update(flight, 'unknown', '目标战斗已结束，尚未确认本队战果');
    }
  });
  return session;
}

function huntKey(session, parts) {
  return createHmac('sha256', session.secret).update(JSON.stringify([session.revision, ...parts])).digest('hex');
}

async function inspectHunt(client, config, player, enterMap = false) {
  const session = huntSession(client);
  const world = normalize(player?.worldId);
  const tables = config?.tables ?? {};
  const required = tables.ModuleOpenCfg?.data?.find(r => r.moduleId === '世界')?.playerLevel;
  const view = { locked: true, required, targets: [], fleets: [], fuel: null, fuelPerFleet: null, reason: '' };
  const targets = new Map(), fleets = new Map();
  const snapshot = { view, targets, fleets, revision: session.revision };
  if (!required || !player?.level || !world) { view.reason = '无法确认世界入口是否已开放'; return snapshot; }
  if (player.level < required) { view.reason = '世界在角色 ' + required + ' 级开放'; return snapshot; }
  view.locked = false;
  const season = Math.floor(world / 1e6) % 1000;
  const scenario = player.scenarioId || 1;
  const configRows = tables.WorldPirateCfg?.data?.filter(row => Number(row.season) === season);
  if (!configRows?.length) { view.reason = '缺少本赛季海盗配置'; return snapshot; }
  const buildings = (await client.request('OnWaterRequest', {}, 'OnWaterResponse')).building;
  const { stage } = await client.request('SeasonTaskStageRequest', {}, 'SeasonTaskStageResponse');
  const stages = tables[scenario + '_SeasonTaskCfg']?.data;
  const stageCap = stage === 0 ? Infinity : stages?.find(r => Number(r.season) === season && r.stage === stage)?.maxPirateLevel;
  if (!stageCap) view.reason = '无法确认当前赛季阶段的海盗等级上限';

  const merge = await client.request('UniteWorldsPlanRequest', {}, 'UniteWorldsPlanResponse');
  const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const sameDay = (a, b) => Math.floor((a + 28800) / 86400) === Math.floor((b + 28800) / 86400);
  if (!merge || !Array.isArray(merge.worldIds)) view.reason = '无法确认合服安排';
  else if ((merge.matchMaking || (merge.worldIds.length && merge.executeTs > 0)) &&
    (now >= (merge.executeTs ?? 0) - 3600 || sameDay(now, merge.executeTs))) view.reason = '合服匹配或执行期间，暂不能出征';

  const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
  if (!Array.isArray(bag.items)) view.reason ||= '无法确认汽油库存';
  else view.fuel = bag.items.find(item => item.itemId === '汽油')?.num ?? 0;
  view.fuelPerFleet = tables.WorldParamCfg?.data?.find(row => row.paramName === '打野怪消耗汽油')?.paramValue ?? null;
  if (!Number.isSafeInteger(view.fuelPerFleet) || view.fuelPerFleet <= 0) view.reason ||= '缺少海盗出征的汽油消耗配置';
  else if (!Number.isSafeInteger(view.fuel) || view.fuel < 0) view.reason ||= '无法确认汽油库存';
  else if (view.fuel !== null && view.fuel < view.fuelPerFleet) view.reason ||= '汽油不足，派一支舰队需要 ' + view.fuelPerFleet + ' 汽油';

  if (enterMap && !view.reason) await client.request('WorldInfoRequest', { screenCenter: { x: 0, y: 0 } }, 'WorldInfoResponse');
  const records = (await client.request('PirateKillRecordRequest', {}, 'PirateKillRecordResponse')).records;
  const map = (await client.request('AllPirateRequest', {}, 'AllPirateResponse')).pirates;
  const own = normalize(await client.request('MyFleetsRequest', {}, 'MyFleetsResponse')).fleets;
  if (![records, map, own, buildings].every(Array.isArray)) { view.reason = '未取得完整的海盗、舰队或建筑状态'; return snapshot; }
  records.forEach(session.record);
  own.forEach(session.observeFleet);
  if (Number.isSafeInteger(view.fuel)) observeFleetReservations(client, { fleets: own, fuel: view.fuel });
  const cities = tables[scenario + '_CityCfg']?.data ?? [];
  const places = new Map();
  const counts = new Map();
  for (const pirate of map) counts.set(pirate.uid, (counts.get(pirate.uid) ?? 0) + 1);
  for (const pirate of [...map].sort((a, b) => a.cityId - b.cityId || a.uid - b.uid)) {
    const cleared = records.find(r => r.type === pirate.type)?.maxKilledLevel ?? 0;
    const cfg = configRows.find(r => r.type === pirate.type && r.level === pirate.level);
    if (!cfg || pirate.level !== cleared + 1 || !(pirate.uid > 0 && pirate.cityId > 0) || !Number.isInteger(pirate.gridIdx) || pirate.gridIdx < 0) continue;
    const key = huntKey(session, ['pirate', world, pirate.uid, pirate.cityId, pirate.gridIdx, pirate.type, pirate.level]);
    const cityName = cities.find(c => c.id === pirate.cityId)?.name || '当前海域';
    const place = cityName + '/' + pirate.type + '/' + pirate.level;
    const number = (places.get(place) ?? 0) + 1;
    places.set(place, number);
    const target = { targetKey: key, name: cfg.showName, level: cfg.level, power: cfg.power, location: cityName + ' · 第 ' + number + ' 处',
      reason: counts.get(pirate.uid) !== 1 ? '地图返回重复目标，请刷新' : session.pending.has(pirate.uid) ? '已有出征请求，等待战果' :
        pirate.level > stageCap ? '当前赛季阶段尚未开放此等级' : '' };
    view.targets.push(target);
    targets.set(key, { pirate, target });
  }
  for (const fleet of own) {
    const building = buildings.find(b => b.buildingId === fleet.buildingId);
    const positions = building?.fleet?.formation?.heroPositions ?? [];
    const ids = positions.map(p => p.heroId).filter(Boolean);
    const formation = building?.fleet?.formation;
    const key = huntKey(session, ['fleet', world, fleet.buildingId, positions.map(p => [p.heroId, normalize(p.pos)]), formation?.presetId, normalize(formation?.petUid)]);
    const held = isFleetReserved(client, fleet.buildingId);
    const reason = held ? '已派出或尚待确认' : hasOtherFleetReservations(client, 'pirate') ? '情报或维修正在确认舰队与汽油，请稍后再出征' :
      !/^\d+远征船$/.test(fleet.buildingId) ? '无法确认远征舰队建筑' : !(building?.level > 0) ? '舰队建筑尚未建成' :
      !ids.length ? '请先在「远征舰队编队」查看并保存这支舰队的首次编队' : fleet.state !== 1 ? '舰队未闲置' :
      fleet.treasureLootUid || fleet.chipWar?.rewardTs || fleet.curGridIdx > 0 ? '舰队正在驻守地块或执行其他任务' :
      !(fleet.durability > 0) ? '舰队没有耐久，请先修理' : fleet.autoFight?.isOn ? '舰队已开启自动作战' : '';
    const number = /^([1-9]\d*)远征船$/.exec(fleet.buildingId)?.[1];
    const option = { key, name: number ? '远征舰队 ' + number + ' 队' : '远征舰队', power: fleet.power ?? null,
      durability: fleet.durability ?? 0, heroes: ids.map(id => tables.HeroCfg?.data?.find(h => h.id === id)?.name || '已编队英雄'), reason };
    view.fleets.push(option);
    fleets.set(key, { fleet, option });
  }
  if (!view.targets.length) view.reason ||= '地图上暂无可首杀的下一等级海盗';
  if (!view.fleets.length) view.reason ||= buildings.some(b => b.level > 0 && /^\d+远征船$/.test(b.buildingId))
    ? '远征舰队已建成，世界地图尚未列出出征队伍，请查看「远征舰队编队」' : '尚无出征舰队，请先建成远征舰队并编入英雄';
  return snapshot;
}

export async function pirateHuntOptions(client, config, player) {
  return (await inspectHunt(client, config, player)).view;
}

export async function startPirateHunt(client, config, player, { targetKey, fleetKey, enabled = () => true, report }) {
  if (!enabled()) throw new Error('账号已暂停，出征已取消');
  const { view, targets, fleets, revision } = await inspectHunt(client, config, player, true);
  const session = huntSession(client);
  if (view.reason) throw new Error(view.reason);
  const selection = targets.get(targetKey), troop = fleets.get(fleetKey);
  if (!selection || !troop || revision !== session.revision) throw new Error('目标或舰队状态已变化，请刷新后重新选择');
  const { pirate, target } = selection;
  if (session.pending.has(pirate.uid) || target.reason) throw new Error(target.reason || '该目标已经派出舰队');
  if (troop.option.reason) throw new Error(troop.option.reason);
  if (isFleetReserved(client, troop.fleet.buildingId)) throw new Error('舰队已派出或尚待确认，请等待当前操作结束');
  if (hasOtherFleetReservations(client, 'pirate')) throw new Error('情报或维修正在确认舰队与汽油，请稍后再出征');
  if (!enabled()) throw new Error('账号已暂停，出征已取消');
  const flight = { uid: pirate.uid, type: pirate.type, level: pirate.level, grid: pirate.gridIdx, city: pirate.cityId,
    buildingId: troop.fleet.buildingId, label: troop.option.name + ' 讨伐' + target.name + ' ' + target.level + ' 级' };
  session.pending.set(pirate.uid, flight);
  session.revision++;
  let unknown = false;
  try {
    await client.sendWatch('ChallengePirateRequest', { uid: pirate.uid, fleetBuildingIds: [flight.buildingId], cityId: pirate.cityId }, { window: 600 });
  } catch (error) {
    if (error.prompt && error.request === 'ChallengePirateRequest' && !flight.result) {
      session.pending.delete(pirate.uid);
      throw error;
    }
    unknown = true;
  }
  flight.report = report;
  return flight.result ?? { status: unknown ? 'unknown' : 'sent', label: flight.label +
    (unknown ? ' · 发送结果未知，等待服务器确认，已阻止重复出征' : ' · 请求已发送，等待服务器确认出征') };
}
