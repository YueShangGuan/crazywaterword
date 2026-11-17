import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exactAutomationId } from './automation-policy.mjs';

const defaultPreset = 1;
const fleetType = '远征船';
const careers = ['坦克', '战士', '法师', '射手'];
const STATE_VERSION = 1;
const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const dataDirectory = () => process.env.CW_DATA_DIR ? path.resolve(process.env.CW_DATA_DIR) : path.resolve(import.meta.dirname, '../data');
const stateFile = () => path.join(dataDirectory(), 'automation-boss-teams.json');

/** 与舰队列表和首次编队工具一致的展示名。 */
export const fleetName = buildingId => {
  const number = String(buildingId).match(/^(\d+)/)?.[1];
  return number ? `远征舰队 ${number} 队` : '远征舰队';
};

/** preset 1 的合法站位，顺序与客户端首次编队一致（x 大者在前）。 */
function presetSeats(config) {
  return rows(config, 'FormationTypePositionCfg').filter(row => row.id === defaultPreset)
    .filter(row => Array.isArray(row.position) && row.position.length === 2 && row.position.every(Number.isSafeInteger))
    .sort((a, b) => b.position[0] - a.position[0])
    .map(row => ({ x: row.position[0], y: row.position[1] }));
}

/** 已解锁的编队人数上限，由主线进度决定。 */
function heroCapacity(config, player) {
  return rows(config, 'FormationHeroNumCfg').reduce((max, row) =>
    player?.mainlineStage > row.mainlineStage ? Math.max(max, row.heroNum) : max, 0);
}

/** 按职业固定顺序把名单英雄落进 preset 1 站位，规则与首次编队工具相同。 */
function assignSeats(config, heroIds) {
  const seats = presetSeats(config);
  const career = new Map(rows(config, 'HeroCfg').map(row => [row.id, row.career]));
  const ordered = [...heroIds].sort((a, b) =>
    careers.indexOf(career.get(a)) - careers.indexOf(career.get(b)) || a.localeCompare(b));
  return ordered.map((heroId, index) => ({ heroId, pos: { x: seats[index].x, y: seats[index].y } }));
}

/** 站位集合比较；presetId 与每个英雄的坐标都一致才算同一编队。 */
function formationSignature(formation) {
  return JSON.stringify([formation?.presetId ?? 0, (formation?.heroPositions ?? [])
    .map(p => [p.heroId, p.pos?.x, p.pos?.y]).sort((a, b) => a[0].localeCompare(b[0]))]);
}

/**
 * 编队保存排序器：给出每支舰队的目标编队，输出一份服务器可接受的保存顺序。
 *
 * 一次保存只要求「目标里的英雄当前都空闲（或就在本队）」；保存会同时释放该队
 * 原有的英雄。互相等待（例如 1 队要 2 队的 X、2 队要 1 队的 Y）时，对其中一支
 * 舰队先保存「当前编队 − 被需要的英雄」完成下阵腾位，再按序落到各自目标。
 * 不允许保存空编队（协议未验证）；腾位会清空某队时明确报错。
 *
 * @param {Map<string, {presetId: number, heroPositions: Array<{heroId: string, pos: {x: number, y: number}}>}>>} targets 每支舰队的目标编队。
 * @param {Map<string, object|null>} currentByDock 全部海面舰队的当前编队。
 * @param {{movable?: Set<string>|null, nameOf?: (buildingId: string) => string}} options movable 限制本轮允许保存的舰队（恢复时排除在途舰队）。
 * @returns {{ok: true, saves: Array<{buildingId: string, formation: object}>} | {ok: false, reason: string}} 保存计划。
 */
export function planFormationSaves(targets, currentByDock, { movable = null, nameOf = fleetName } = {}) {
  // heroId → 当前所在舰队；保存目标编队时同步更新这份占用关系。
  const placed = new Map();
  for (const [dock, formation] of currentByDock) for (const p of formation?.heroPositions ?? []) placed.set(p.heroId, dock);
  const pending = new Map(targets);
  const saves = [];
  const commit = (dock, formation) => {
    for (const [hero, holder] of [...placed]) if (holder === dock) placed.delete(hero);
    for (const p of formation.heroPositions) placed.set(p.heroId, dock);
    saves.push({ buildingId: dock, formation });
  };
  while (pending.size) {
    let progressed = false;
    for (const [dock, formation] of [...pending]) {
      if (!formation.heroPositions.every(p => !placed.has(p.heroId) || placed.get(p.heroId) === dock)) continue;
      commit(dock, formation); pending.delete(dock); progressed = true;
    }
    if (!pending.size) break;
    if (progressed) continue;
    // 保存互相等待：从未完成的舰队里挑一位「被其他舰队目标需要」的英雄先下阵。
    let acted = false;
    for (const [dock, formation] of [...pending]) {
      if (movable && !movable.has(dock)) continue;
      const holders = [...placed].filter(([, holder]) => holder === dock).map(([hero]) => hero);
      const wanted = holders.filter(hero => [...pending].some(([other, job]) => other !== dock && job.heroPositions.some(p => p.heroId === hero)));
      if (!wanted.length) continue;
      const positionOf = new Map((currentByDock.get(dock)?.heroPositions ?? []).map(p => [p.heroId, p.pos]));
      const keep = holders.filter(hero => !wanted.includes(hero)).map(heroId => ({ heroId, pos: positionOf.get(heroId) }));
      if (!keep.length) return { ok: false, reason: `${nameOf(dock)} 下阵 ${wanted.join('、')} 后没有剩余英雄，无法腾位（不允许保存空编队）` };
      commit(dock, { presetId: currentByDock.get(dock)?.presetId ?? defaultPreset, heroPositions: keep });
      acted = true;
      break;
    }
    if (!acted) return { ok: false, reason: '名单英雄互相占用成环且无法腾位，请调整队伍名单' };
  }
  return { ok: true, saves };
}

/**
 * 由队伍名单推导编队目标并生成保存计划。
 *
 * 名单舰队的目标是名单编队；占用名单英雄的非名单舰队先把这些英雄下阵（目标为
 * 当前编队减去被需英雄）。同时校验跨名单重复、编队位上限、英雄拥有性（传入
 * owned 时）与被触碰舰队的空闲状态（传入 fleets 时）。
 *
 * @param {object} config 本地配置表。
 * @param {object} player 当前角色（用于编队位容量）。
 * @param {Array<{buildingId: string, heroes: string[]}>} teams 已校验的名单设置。
 * @param {Array<{buildingId: string, level: number, fleet?: {formation?: object}}>} docks 海面建筑。
 * @param {{owned?: Set<string>|null, fleets?: Array<object>|null}} options 英雄归属与舰队状态。
 * @returns {{ok: true, saves: Array, touched: Array<{buildingId: string, formation: object|null}>, fleetIds: string[]} | {ok: false, reason: string}} 计划或失败原因。
 */
export function planBossTeams(config, player, teams, docks, { owned = null, fleets = null } = {}) {
  if (!Array.isArray(teams) || !teams.length) return { ok: false, reason: '请先在队伍名单中选择舰队和英雄' };
  const heroNames = new Map(rows(config, 'HeroCfg').map(row => [row.id, row.name]));
  const heroName = id => heroNames.get(id) ?? id;
  const dockByBuildingId = new Map((docks ?? []).filter(dock => dock.level > 0 && dock.buildingId?.endsWith(fleetType)).map(dock => [dock.buildingId, dock]));
  const seats = presetSeats(config);
  const capacity = heroCapacity(config, player);
  if (!capacity || !seats.length) return { ok: false, reason: '缺少默认舰队阵型或编队位配置，无法应用名单' };
  const wantedHeroes = new Map();
  for (const team of teams) {
    if (!dockByBuildingId.has(team.buildingId)) return { ok: false, reason: `${fleetName(team.buildingId)} 尚未建成，无法应用名单` };
    if (owned) {
      const missing = team.heroes.filter(hero => !owned.has(hero)).map(heroName);
      if (missing.length) return { ok: false, reason: `${fleetName(team.buildingId)} 名单中的英雄不存在或未拥有：${missing.join('、')}` };
    }
    for (const hero of team.heroes) {
      if (wantedHeroes.has(hero)) return { ok: false, reason: `英雄 ${heroName(hero)} 同时出现在 ${fleetName(wantedHeroes.get(hero))} 和 ${fleetName(team.buildingId)} 的名单中` };
      wantedHeroes.set(hero, team.buildingId);
    }
  }
  const currentByDock = new Map([...dockByBuildingId.keys()].map(buildingId => [buildingId, dockByBuildingId.get(buildingId).fleet?.formation ?? null]));
  const targets = new Map();
  const limit = Math.min(capacity, seats.length);
  for (const team of teams) {
    if (team.heroes.length > limit) return { ok: false, reason: `${fleetName(team.buildingId)} 名单 ${team.heroes.length} 人，超过当前解锁的编队位 ${limit}` };
    targets.set(team.buildingId, { presetId: defaultPreset, heroPositions: assignSeats(config, team.heroes) });
  }
  // 占用名单英雄的非名单舰队：目标编队为「当前编队 − 被需英雄」，打完 Boss 后恢复完整原编队。
  for (const [buildingId, formation] of currentByDock) {
    if (targets.has(buildingId) || !formation?.heroPositions?.length) continue;
    const wanted = formation.heroPositions.map(p => p.heroId).filter(hero => wantedHeroes.has(hero));
    if (!wanted.length) continue;
    const keep = formation.heroPositions.filter(p => !wanted.includes(p.heroId));
    if (!keep.length) return { ok: false, reason: `${heroName(wanted[0])} 在 ${fleetName(buildingId)} 编队中，但下阵后该队没有剩余英雄，无法腾位` };
    targets.set(buildingId, { presetId: formation.presetId ?? defaultPreset, heroPositions: keep });
  }
  // 换阵只能在空闲舰队上进行；行军、战斗、维修或驻外的舰队等回港后才能应用名单。
  if (fleets) for (const buildingId of targets.keys()) {
    const fleet = fleets.find(row => row.buildingId === buildingId);
    if (!fleet || fleet.state !== 1 || fleet.autoFight?.isOn || fleet.treasureLootUid || fleet.chipWar?.rewardTs) {
      return { ok: false, reason: `${fleetName(buildingId)} 正在执行其他任务，返航后才能应用队伍名单` };
    }
  }
  const plan = planFormationSaves(targets, currentByDock, { nameOf: fleetName });
  if (!plan.ok) return plan;
  const touched = [...targets.keys()].map(buildingId => ({ buildingId, formation: currentByDock.get(buildingId) }));
  return { ok: true, saves: plan.saves, touched, fleetIds: teams.map(team => team.buildingId) };
}

function readStateFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (parsed?.version === STATE_VERSION && plainObject(parsed.worlds)) return { worlds: parsed.worlds };
  } catch (error) {
    if (error.code !== 'ENOENT') return { worlds: {}, error: `无法读取世界Boss队伍恢复记录：${error.message}` };
  }
  return { worlds: {} };
}

function writeStateFile(worlds) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  const temporary = `${stateFile()}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: STATE_VERSION, worlds }, null, 2), 'utf8');
    fs.renameSync(temporary, stateFile());
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** 读取某个世界的待恢复记录；没有记录或字段异常时返回 null。 */
export function pendingBossTeamRestore(worldId) {
  const entry = readStateFile().worlds[worldId];
  return entry && Array.isArray(entry.fleets) && entry.fleets.length ? entry : null;
}

function saveBossTeamState(worldId, fleets) {
  const state = readStateFile();
  state.worlds[worldId] = { appliedAt: Date.now(), fleets };
  writeStateFile(state.worlds);
}

function clearBossTeamState(worldId) {
  const state = readStateFile();
  if (!Object.hasOwn(state.worlds, worldId)) return;
  delete state.worlds[worldId];
  writeStateFile(state.worlds);
}

async function saveFormation(client, buildingId, formation) {
  await client.sendWatch('FleetSaveFormationRequest', { buildingId, formation });
  const after = (await client.request('OnWaterRequest', {}, 'OnWaterResponse')).building?.find(dock => dock.buildingId === buildingId);
  if (!after || formationSignature(after.fleet?.formation) !== formationSignature(formation)) {
    throw new Error(`服务端未确认 ${fleetName(buildingId)} 的编队变更`);
  }
}

/**
 * 把已应用的编队回滚到快照原状（应用阶段失败时使用，此时舰队尚未出征）。
 * @returns {Promise<true|string>} true 表示全部回滚成功，字符串为未完成原因。
 */
async function rollbackFormations(client, touched, applied) {
  if (!applied.length) return true;
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  const docks = (water.building ?? []).filter(dock => dock.level > 0 && dock.buildingId?.endsWith(fleetType));
  const currentByDock = new Map(docks.map(dock => [dock.buildingId, dock.fleet?.formation ?? null]));
  const targets = new Map(touched
    .filter(row => row.formation && applied.some(save => save.buildingId === row.buildingId))
    .map(row => [row.buildingId, row.formation]));
  if (!targets.size) return true;
  const plan = planFormationSaves(targets, currentByDock);
  if (!plan.ok) return plan.reason;
  try { for (const save of plan.saves) await saveFormation(client, save.buildingId, save.formation); }
  catch (error) { return error.message; }
  return true;
}

/**
 * 首战前应用队伍名单：校验、按序保存编队并落盘待恢复记录。
 *
 * 任一步失败都会用同一排序器回滚已应用的编队（此时舰队尚未出征，可安全回写），
 * 然后返回失败原因，由调用方跳过本次派遣。
 *
 * @param {object} client 已连接的游戏客户端。
 * @param {object} config 本地配置表。
 * @param {object} player 当前角色。
 * @param {object} settings 当前账号自动化设置。
 * @param {{report?: (entry: object) => void}} options 日志回调。
 * @returns {Promise<{ok: boolean, reason?: string}>} 应用结果。
 */
export async function applyBossTeams(client, config, player, settings, { report = () => {} } = {}) {
  const teams = settings.worldBoss?.teams ?? [];
  const [water, own, rosterReply] = await Promise.all([
    client.request('OnWaterRequest', {}, 'OnWaterResponse'),
    client.request('MyFleetsRequest', {}, 'MyFleetsResponse'),
    client.request('AllHeroRequest', {}, 'AllHeroResponse'),
  ]);
  const docks = (water.building ?? []).filter(dock => dock.level > 0 && dock.buildingId?.endsWith(fleetType));
  const owned = new Set((rosterReply.heroes ?? []).map(hero => hero.heroId));
  if (!owned.size) return { ok: false, reason: '无法读取英雄列表，未应用队伍名单' };
  const plan = planBossTeams(config, player, teams, docks, { owned, fleets: own.fleets });
  if (!plan.ok) return plan;
  const applied = [];
  for (const save of plan.saves) {
    try {
      await saveFormation(client, save.buildingId, save.formation);
      applied.push(save);
    } catch (error) {
      const restored = await rollbackFormations(client, plan.touched, applied);
      const suffix = restored === true ? '，已回滚原编队' : restored ? `；回滚未完成：${restored}` : '';
      report({ label: '世界Boss队伍名单', ok: false, status: 'failed', error: error.message + suffix });
      return { ok: false, reason: error.message + suffix };
    }
  }
  // 只有原本就有编队的舰队需要恢复；原本没有编队的舰队保留名单编队并明确说明。
  const restoreFleets = plan.touched.filter(row => row.formation);
  saveBossTeamState(exactAutomationId(player.worldId), restoreFleets);
  const kept = plan.touched.length - restoreFleets.length;
  const docksTouched = [...new Set(plan.saves.map(save => fleetName(save.buildingId)))].join('、');
  report({
    label: '世界Boss队伍名单', ok: true, status: 'success',
    reason: `已切换 ${docksTouched} 的编队${kept ? `；${kept} 支舰队原本没有编队，名单编队将保留` : ''}，打完Boss回港后自动恢复`,
  });
  return { ok: true };
}

// 恢复失败按世界记录最后一次原因，原因不变时不再重复上报，避免每轮刷日志。
const recoverFailureMemo = new Map();
function noteRecoverFailure(worldId, reason, report) {
  if (recoverFailureMemo.get(worldId) === reason) return true;
  recoverFailureMemo.set(worldId, reason);
  report({ label: '世界Boss队伍恢复', ok: false, status: 'failed', error: `${reason}；舰队空闲后会自动重试` });
  return true;
}

/**
 * 恢复世界Boss首战前被改动的编队；由挂机循环每轮调用，直到记录清空。
 *
 * 只有回港空闲的舰队参与本轮恢复；在途舰队等下一轮。恢复同样通过排序器执行，
 * 支持把互换过的多支舰队换回原位。全部恢复完成后删除该世界的记录。
 *
 * @param {object} client 已连接的游戏客户端。
 * @param {object} config 本地配置表。
 * @param {object} player 当前角色。
 * @param {{report?: (entry: object) => void}} options 日志回调。
 * @returns {Promise<boolean>} 是否存在待恢复记录（含本轮已恢复）。
 */
export async function recoverBossTeams(client, config, player, { report = () => {} } = {}) {
  const worldId = exactAutomationId(player?.worldId);
  const read = readStateFile();
  const record = read.worlds[worldId];
  if (!Array.isArray(record?.fleets) || !record.fleets.length) return false;
  if (read.error) return noteRecoverFailure(worldId, read.error, report);
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  const own = await client.request('MyFleetsRequest', {}, 'MyFleetsResponse');
  const docks = (water.building ?? []).filter(dock => dock.level > 0 && dock.buildingId?.endsWith(fleetType));
  const currentByDock = new Map(docks.map(dock => [dock.buildingId, dock.fleet?.formation ?? null]));
  const idleFleet = buildingId => {
    const fleet = (own.fleets ?? []).find(row => row.buildingId === buildingId);
    return Boolean(fleet && fleet.state === 1 && !fleet.autoFight?.isOn && !fleet.treasureLootUid && !fleet.chipWar?.rewardTs);
  };
  const restoreTargets = new Map();
  for (const row of record.fleets) {
    if (row.formation && currentByDock.has(row.buildingId) && idleFleet(row.buildingId)) restoreTargets.set(row.buildingId, row.formation);
  }
  if (!restoreTargets.size) return true;
  const plan = planFormationSaves(restoreTargets, currentByDock, { movable: new Set(restoreTargets.keys()) });
  if (!plan.ok) return noteRecoverFailure(worldId, plan.reason, report);
  for (const save of plan.saves) {
    try { await saveFormation(client, save.buildingId, save.formation); }
    catch (error) { return noteRecoverFailure(worldId, `${fleetName(save.buildingId)}：${error.message}`, report); }
  }
  const restoredNames = [...restoreTargets.keys()].map(fleetName).join('、');
  const remaining = record.fleets.filter(row => !restoreTargets.has(row.buildingId));
  if (remaining.length) saveBossTeamState(worldId, remaining);
  else clearBossTeamState(worldId);
  recoverFailureMemo.delete(worldId);
  report({
    label: '世界Boss队伍恢复', ok: true, status: 'success',
    reason: `${restoredNames} 已恢复原编队${remaining.length ? `；${remaining.map(row => fleetName(row.buildingId)).join('、')} 回港后继续恢复` : '；全部恢复完成'}`,
  });
  return true;
}
