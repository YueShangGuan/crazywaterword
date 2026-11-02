import { readWeekOrder } from './activities.mjs';
import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';
import { SPEED_UP_ITEM, SPEED_UP_ITEM_TYPE } from './world.mjs';

export async function serviceCargo(client, config, { enabled, log, testSpeedUp = false }) {
  const ships = async () => normalize(await client.request('CargoShipsRequest', {})).ship ?? [];
  const initial = await ships();
  let available;
  let speedUsed = false;
  for (const ship of initial) {
    if (!enabled()) break;
    const index = ship.index;
    const label = '贸易港 ' + index + ' 号船';
    let state = ship;
    if ((state.status ?? 0) === 0) {
      if (!available) {
        const [inventory, order] = await Promise.all([
          client.request('AllItemRequest', {}).then(normalize), readWeekOrder(client, undefined, config),
        ]);
        available = new Map((inventory.items ?? []).map(item => [item.itemId, Number(item.num)]));
        if (!order.finished) for (const [id, num] of order.needed) available.set(id, (available.get(id) ?? 0) - num);
      }
      const slots = [], labels = [];
      for (const [i, slot] of (state.orderItem ?? []).entries()) {
        const { id, num } = slot.asset ?? {};
        if (slot.filled || !(num > 0) || (available.get(id) ?? 0) < num) continue;
        slots.push(i + 1);
        labels.push(displayMaterial(config, id) + ' ×' + num);
        available.set(id, available.get(id) - num);
      }
      if (slots.length && enabled()) {
        await client.request('FillCargoShipRequest', { shipIndex: index, cargoIndex: slots });
        log(label + '交货：' + labels.join('、'));
        state = (await ships()).find(s => s.index === index);
      }
    }
    if (state?.status === 1 && testSpeedUp && !speedUsed && enabled()) {
      const stock = normalize(await client.request('AllItemRequest', {})).items ?? [];
      if (stock.some(item => item.itemId === SPEED_UP_ITEM && item.num > 0) &&
          state.arriveTime > (Date.now() + (client.serverClockOffsetMs || 0)) / 1000 && enabled()) {
        speedUsed = true;
        await client.sendWatch('SpeedUpShipRequest', { index, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum: 1 } });
        state = (await ships()).find(s => s.index === index);
        log(label + '测试加速 1 次，' + (state?.status === 2 ? '已到港' : '当前仍在运输'));
      }
    }
    if (state?.status === 2 && enabled()) {
      const result = normalize(await client.request('DrawShipRewardRequest', { index }));
      const rewards = (result.reward?.asset ?? []).map(a => displayMaterial(config, a.id) + ' ×' + a.num);
      log(label + '已收货' + (rewards.length ? '：' + rewards.join('、') : ''));
    }
  }
}
