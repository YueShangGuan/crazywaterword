import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';

const task = 'guildWelfare';
const title = '联盟福利礼包';
const claiming = new WeakSet();
const lastClaims = new WeakMap();
const skipped = reason => ({ label: title, skipped: true, reason });

// Guild/player IDs are int64, so don't identify accounts by a rounded double.
function idText(value) {
  if (value && typeof value.low === 'number' && typeof value.high === 'number') {
    return ((BigInt(value.high) << 32n) + BigInt(value.low >>> 0)).toString();
  }
  if (typeof value === 'bigint' || Number.isSafeInteger(value) || (typeof value === 'string' && /^\d+$/.test(value))) return String(value);
  return null;
}

function notJoined() { return { state: 'notJoined', reason: '当前账号未加入联盟' }; }
function isNoGuild(client, error) { return client.promptNames?.[error.prompt?.prompt] === 'NO_GUILD'; }

async function guildStatus(client, config, player) {
  const required = config?.tables?.ModuleOpenCfg?.data?.find(row => row.moduleId === '联盟')?.playerLevel;
  if (!(required > 0 && player?.level > 0)) return { state: 'unknown', reason: '无法确认联盟开放条件' };
  if (player.level < required) return { state: 'locked', reason: '联盟在角色 ' + required + ' 级开放，当前 ' + player.level + ' 级' };
  const id = idText(player.guildId);
  if (id === '0') return notJoined();
  if (id === null) return { state: 'unknown', reason: '无法确认当前账号的联盟身份' };
  let response;
  try {
    response = await client.request('GuildInfoRequest', {}, 'GuildInfoResponse');
  } catch (error) {
    if (isNoGuild(client, error)) return notJoined();
    throw error;
  }
  const guild = response?.guild;
  if (idText(guild?.guildId) !== id || idText(player.guildId) !== id) {
    return { state: 'unknown', reason: '联盟信息已变化，请稍后重新查看' };
  }
  const recorded = lastClaims.get(client);
  const times = Array.isArray(guild.welfarePack) ? guild.welfarePack.map(pack => pack.createTime) : null;
  const pending = Number.isSafeInteger(guild.gotWelfareTime) && guild.gotWelfareTime >= 0 && times?.every(t => Number.isSafeInteger(t) && t > 0)
    ? times.filter(t => t > Math.max(guild.gotWelfareTime, recorded?.id === id ? recorded.time : 0)) : null;
  return { state: 'member', id, name: guild.name || '当前联盟', level: guild.level ?? null, memberCount: guild.memberCount ?? null,
    welfareCount: pending?.length ?? null, pending };
}

export async function readGuild(client, config, player) {
  const { pending, ...status } = await guildStatus(client, config, player);
  const view = { ...status, requests: [] };
  if (status.state !== 'member') return view;
  try {
    const reply = await client.request('GuildAidListRequest', { type: 0 }, 'GuildAidListResponse');
    if (idText(player.guildId) !== status.id) return { state: 'unknown', reason: '联盟信息已变化，请重新查看', requests: [] };
    if (!Array.isArray(reply?.askItems)) throw new Error('服务器未返回联盟求助列表');
    const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
    // GuildHelpPop budgets one unit of reqItemId per request (including "help all").
    for (const row of reply.askItems) {
      if (!row.reqItemId || !(row.endTime >= now) || idText(row.asker?.playerId) === idText(player.playerId)) continue;
      view.requests.push({ requester: row.asker?.nickname || '联盟成员', material: displayMaterial(config, row.reqItemId),
        quantity: 1, endTime: row.endTime });
    }
  } catch (error) {
    if (isNoGuild(client, error)) return { ...notJoined(), requests: [] };
    view.aidError = error.message;
  }
  return view;
}

export async function claimGuildWelfare(client, config, { player, enabled = () => true, scheduler } = {}) {
  if (!enabled()) return skipped('已暂停');
  if (scheduler && !scheduler.due(task)) return skipped('等待下次检查');
  if (claiming.has(client)) return skipped('正在核对联盟福利');
  const recheck = seconds => scheduler?.defer(task, scheduler.now() + seconds);
  claiming.add(client);
  try {
    const status = await guildStatus(client, config, player);
    if (status.state !== 'member') {
      recheck(status.state === 'unknown' ? 180 : 1800);
      return skipped(status.reason);
    }
    if (status.welfareCount === null) throw new Error('无法确认联盟福利的领取记录');
    if (!status.welfareCount) { recheck(300); return skipped('当前没有新的联盟福利礼包'); }
    if (!enabled() || idText(player.guildId) !== status.id) return skipped('账号或联盟状态已变化');
    const result = normalize(await client.request('GotGuildWelfarePackRequest', {}, 'GotGuildWelfarePackResponse'));
    const confirmed = Number.isSafeInteger(result?.lastGotTime) && status.pending.filter(t => t <= result.lastGotTime).length;
    if (!confirmed || !result?.reward?.asset?.length) throw new Error('服务端未确认联盟福利的领取时间和奖励');
    lastClaims.set(client, { id: status.id, time: result.lastGotTime });
    const rewards = result.reward.asset.map(item => displayMaterial(config, item.id) + ' ×' + item.num);
    if (confirmed === status.welfareCount) recheck(300);
    return { label: title + ' · 已领取，获得' + rewards.join('、'), ok: true };
  } catch (error) {
    if (isNoGuild(client, error)) { recheck(1800); return skipped(notJoined().reason); }
    recheck(180);
    throw error;
  } finally {
    claiming.delete(client);
  }
}
