// 城战手动派遣：只负责“把一支闲置舰队派往指定城市”，目标合法性由服务端路由校验。
// 现有自动化仍按自己的规则运行；这里的手动目标只影响本次派遣。

import { normalize } from './worlds.mjs';
import { isFleetReserved } from './fleet-reservations.mjs';

export const FLEET_STATE_TEXT = { 1: '闲置', 2: '行军', 3: '交战', 4: '维修', 5: '排队' };

async function readFleets(client, protocol, timeout) {
  if (!protocol?.MyFleetsRequest || !protocol?.MyFleetsResponse) throw new Error('协议缺少 MyFleets 查询');
  const body = normalize(await client.request('MyFleetsRequest', {}, 'MyFleetsResponse', timeout));
  return Array.isArray(body?.fleets) ? body.fleets : [];
}

/**
 * 派遣一支闲置舰队到城战目标城市。
 *
 * @param {object} client 已连接的游戏客户端。
 * @param {object} protocol 协议表。
 * @param {object} options 舰队、目标与等待参数。
 * @returns {Promise<{ok:boolean, confirmed:boolean, message:string}>} 派遣结果；未读回时 confirmed 为 false。
 */
export async function dispatchCityWarFleet(client, protocol, {
  buildingId, cityId, role = 'attack', timeout = 8000,
} = {}) {
  if (!client?.connected) throw new Error('账号未连接，请先连接游戏');
  const fleetId = String(buildingId ?? '').trim();
  const target = Number(cityId);
  if (!fleetId) throw new Error('请选择要派遣的舰队');
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error('请选择城战目标城市');

  const fleets = await readFleets(client, protocol, timeout);
  const fleet = fleets.find((row) => String(row.buildingId) === fleetId);
  if (!fleet) throw new Error('舰队不存在，请刷新舰队状态');
  const state = Number(fleet.state);
  if (state === 2 && Number(fleet.targetCityId) === target) {
    return { ok: true, confirmed: true, message: `${fleetId} 已在前往目标城市的路上` };
  }
  if (state !== 1) {
    throw new Error(`${fleetId} 当前${FLEET_STATE_TEXT[state] ?? `状态 ${state}`}，只有闲置舰队可以派遣`);
  }
  if (Number(fleet.durability) <= 0) throw new Error(`${fleetId} 耐久为 0，请先维修`);
  if (isFleetReserved(client, fleetId)) throw new Error(`${fleetId} 正被自动化任务占用，请先停止相关任务`);
  if (Number(fleet.cityId) === target) {
    return { ok: true, confirmed: true, message: `${fleetId} 已经在目标城市` };
  }

  const action = role === 'defend' ? '驻防' : '进攻';
  const before = JSON.stringify(fleet);
  await client.sendWatch('MoveFleetsToCityRequest', { buildingId: [fleetId], cityId: target }, { window: 800 });

  const deadline = Date.now() + Math.max(1000, Math.min(15000, Number(timeout) || 8000));
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!client.connected) break;
    let current = null;
    try {
      current = (await readFleets(client, protocol, timeout)).find((row) => String(row.buildingId) === fleetId);
    } catch {
      continue;
    }
    if (!current) continue;
    if (Number(current.targetCityId) === target) {
      return { ok: true, confirmed: true, message: `${fleetId} 已出发${action}目标城市` };
    }
    if (Number(current.cityId) === target && Number(current.state) !== 1) {
      return { ok: true, confirmed: true, message: `${fleetId} 已抵达目标城市` };
    }
    if (JSON.stringify(current) !== before) {
      return { ok: true, confirmed: true, message: `${fleetId} 已提交${action}派遣` };
    }
  }
  return { ok: false, confirmed: false, message: `${fleetId} 派遣结果未确认，请刷新舰队状态后核对` };
}
