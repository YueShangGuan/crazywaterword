import { displayMaterial } from './config.mjs';
import { toNumber } from './client.mjs';
import { hasOtherFleetReservations, isFleetReserved, registerFleetReservations } from './fleet-reservations.mjs';
import { freeFleet, normalizeFleet, radarFuelReserve } from './radar.mjs';
import { gameplayOpenDay, worldOpenDays } from './extra-rewards.mjs';

const key = 'treasureLoot';
const label = '世界宝藏';
const OWNER = 'treasureLoot';
const WAR_HOUR = 20;
const MIN_DURABILITY = 0.8;
const sessions = new WeakMap();

const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const param = (config, table, name) => rows(config, table).find(row => row.paramName === name)?.paramValue;
const beijingHour = time => new Date((time + 8 * 3600) * 1000).getUTCHours();

function stateFor(client) {
  if (!sessions.has(client)) {
    const session = { fleets: new Map(), refused: new Map() };
    sessions.set(client, session);
    registerFleetReservations(client, OWNER, id => session.fleets.has(id), () => session.fleets.size > 0,
      snapshot => settle(session, snapshot.fleets.map(normalizeFleet)));
  }
  return sessions.get(client);
}

// 返航且确认出征过才释放，只看到空闲不算结果，防止回包丢失后重复派遣。
function settle(session, fleets) {
  for (const [id, pending] of session.fleets) {
    const fleet = fleets.find(row => row.buildingId === id);
    if (!fleet) continue;
    if (fleet.treasureLootUid === pending.uid || !freeFleet(fleet)) pending.seen = true;
    if (pending.seen && freeFleet(fleet)) session.fleets.delete(id);
  }
}

// 只去无主或本盟的宝藏，不主动和其他联盟交战。
export function pickTreasure(treasures, guildIdx, refused = new Map(), now = 0) {
  return treasures.filter(row => row.progress < 100 && (row.ownerGuildIdx === 0 || row.ownerGuildIdx === guildIdx)
    && !(refused.get(row.uid) > now))
    .sort((a, b) => b.color - a.color || a.progress - b.progress)[0] ?? null;
}

export function pickTreasureFleet(fleets, client) {
  return fleets.filter(fleet => freeFleet(fleet) && !isFleetReserved(client, fleet.buildingId)
    && fleet.durability >= fleet.maxDura * MIN_DURABILITY)
    .sort((a, b) => toNumber(b.power ?? 0) - toNumber(a.power ?? 0))[0] ?? null;
}

async function readFleets(client) {
  const raw = (await client.request('MyFleetsRequest', {}, 'MyFleetsResponse'))?.fleets;
  const items = (await client.request('AllItemRequest', {}, 'AllItemResponse'))?.items;
  if (!Array.isArray(raw) || !Array.isArray(items)) throw new Error('未能读取舰队和库存');
  const fleets = raw.map(normalizeFleet);
  const fuel = items.filter(item => item.itemId === '汽油').reduce((sum, item) => sum + toNumber(item.num), 0);
  return { fleets, fuel };
}

export async function serviceTreasureLoot(client, config, { player, enabled = () => false, report = () => {}, scheduler } = {}) {
  const finish = entry => { report({ key, label, ...entry }); };
  const skip = reason => finish({ skipped: true, reason });
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!enabled()) return;
  const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const required = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '世界宝藏')?.playerLevel;
  if (!(player?.level >= required)) { later(3600); return skip('世界宝藏 ' + required + ' 级开放'); }
  const openDay = gameplayOpenDay(config, player, '世界宝藏');
  const days = worldOpenDays(player, now);
  if (!(openDay > 0) || days === null || days < openDay) { later(3600); return skip('本区服尚未开放世界宝藏'); }
  const guildId = toNumber(player?.guildId);
  if (!(guildId > 0)) { later(1800); return skip('当前账号未加入联盟'); }
  if (beijingHour(now) === WAR_HOUR) { later(600); return skip('20:00-21:00 城战期间不派遣'); }
  const session = stateFor(client);
  try {
    const guild = await client.request('GuildInfoRequest', {}, 'GuildInfoResponse');
    const title = rows(config, 'GuildTitleCfg').find(row => row.title === guild?.myTitle);
    if (title?.treasureLoot !== 1) { later(1800); return skip('当前联盟职级不能占领宝藏'); }
    const stats = await client.request('TreasureLootStatsRequest', {}, 'TreasureLootStatsResponse');
    const limit = param(config, 'TreasureLootParamCfg', '每日宝藏奖励次数');
    if (!(limit > 0) || !Number.isSafeInteger(stats?.todayRewardTimes)) throw new Error('无法确认今日宝藏奖励次数');
    if (stats.todayRewardTimes >= limit) { later(3600); return skip('今日 ' + limit + ' 次宝藏奖励已用完'); }
    const { fleets, fuel } = await readFleets(client);
    settle(session, fleets);
    if (hasOtherFleetReservations(client, OWNER)) { later(120); return skip('其他玩法的舰队或汽油扣除尚未确认'); }
    if (session.fleets.size) { later(120); return skip('上次派遣的舰队尚未返回'); }
    const out = fleets.filter(fleet => fleet.treasureLootUid > 0).length;
    if (out + stats.todayRewardTimes >= limit) { later(600); return skip('已派出的舰队足够领完今日奖励次数'); }
    const cost = param(config, 'WorldParamCfg', '进攻宝藏消耗汽油');
    if (!(cost > 0)) throw new Error('缺少宝藏汽油消耗配置');
    if (fuel - cost < radarFuelReserve) { later(600); return skip('派遣后需保留 ' + radarFuelReserve + ' 汽油，当前 ' + fuel); }
    const treasures = (await client.request('TreasureLootListRequest', {}, 'TreasureLootListResponse'))?.treasure;
    if (!Array.isArray(treasures)) throw new Error('未能读取宝藏列表');
    const target = pickTreasure(treasures, guildId % 1000, session.refused, now);
    if (!target) { later(300); return skip('当前没有无主或本盟的宝藏'); }
    const fleet = pickTreasureFleet(fleets, client);
    if (!fleet) { later(300); return skip('没有空闲且耐久不低于 80% 的舰队'); }
    if (!enabled()) return;
    const id = fleet.buildingId;
    session.fleets.set(id, { uid: target.uid, seen: false });
    try {
      await client.sendWatch('TreasureLootSendFleetsRequest', { uid: target.uid, fleetBuildingIds: [id] }, { window: 500 });
    } catch (error) {
      if (error.prompt) {
        session.fleets.delete(id);
        session.refused.set(target.uid, now + 1800);
      }
      later(300);
      return finish({ ok: false, error: id + ' 出征：' + error.message });
    }
    const after = (await client.request('MyFleetsRequest', {}, 'MyFleetsResponse'))?.fleets ?? [];
    settle(session, after.map(normalizeFleet));
    if (!session.fleets.get(id)?.seen) {
      later(300);
      return finish({ ok: false, error: '服务端未确认 ' + id + ' 出征，已暂停重复派遣这支舰队' });
    }
    later(120);
    const rewards = (target.reward?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + toNumber(item.num)).join('、');
    finish({ ok: true, label: label + ' · ' + id + ' 已前往宝藏 #' + target.uid + '，汽油 ' + cost + (rewards ? '，奖励 ' + rewards : '') });
  } catch (error) {
    later(300);
    if (client.promptNames?.[error.prompt?.prompt] === 'NO_GUILD') return skip('当前账号未加入联盟');
    finish({ ok: false, error: error.message });
  }
}
