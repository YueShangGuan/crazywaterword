// 城战接续的事件入口：把 SCMyFleetUpdate 推送里的「非闲置 → 闲置」状态迁移转成唤醒信号。
// 只当门铃不当证据：这里不读协议、不发请求，唤醒后的决策仍由自动化轮内的城战段完成。
const watchers = new WeakMap();

/** 城战执行窗（上海时间），与 automation/world.mjs 的 CITY_WAR_EXECUTION_WINDOW 保持一致。 */
const CITY_WAR_WINDOW = [{ start: '20:00', end: '20:59' }];

/** 上海时间的城战窗口判断；唤醒前置闸，窗口外推送一律忽略。 */
export function cityWarWindowActive(now = Date.now()) {
  const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(now)).split(':').map(Number);
  const current = hour * 60 + minute;
  return CITY_WAR_WINDOW.some(({ start, end }) => {
    const convert = text => { const [h, m] = String(text).split(':').map(Number); return h * 60 + m; };
    return current >= convert(start) && current <= convert(end);
  });
}

/**
 * 监听本人舰队的空闲迁移。战斗期间的耐久推送 state 不变，不会触发；
 * 每个连接只挂一份监听，重复调用返回同一实例（与 watchFleetMaintenance 同款）。
 *
 * @param {object} client 已连接的游戏客户端。
 * @returns {{ subscribe: (fn: (fleet: {buildingId: string, from: number}) => void) => () => boolean, current: () => Map<string, number> }}
 */
export function watchCityWarIdle(client) {
  if (watchers.has(client)) return watchers.get(client);
  const lastState = new Map(), listeners = new Set();
  const notify = fleet => { for (const listener of listeners) listener(fleet); };
  const onMessage = ({ name, body }) => {
    if (name !== 'SCMyFleetUpdate' || !Array.isArray(body?.fleets)) return;
    for (const fleet of body.fleets) {
      const id = fleet?.buildingId, state = fleet?.state;
      if (!id || !Number.isInteger(state)) continue;
      const before = lastState.get(id);
      lastState.set(id, state);
      // 首次见到（before undefined）只播种不唤醒，避免重连批量回放造成假触发。
      if (state !== 1 || before === undefined || before === 1) continue;
      notify({ buildingId: id, from: before });
    }
  };
  const onClosed = () => lastState.clear();
  client.on?.('message', onMessage);
  client.on?.('close', onClosed);
  const watcher = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    current: () => new Map(lastState),
  };
  watchers.set(client, watcher);
  return watcher;
}
