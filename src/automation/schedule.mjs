// 只为明确要求按跨服比拼日程执行的字段开放日期枚举，其余开关仍使用布尔值。
export const EXECUTION_MODES = {
  'modules.guild.order.enabled': 'monday',
  'modules.pet.enabled': 'tuesday',
  'modules.antique.activate': 'wednesday',
  'modules.antique.upgrade': 'wednesday',
  'modules.antique.suit.activate': 'wednesday',
  'modules.equip.enabled': 'friday',
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** 返回当前连接校正后的服务端毫秒时刻，允许测试注入业务时钟。 */
export function serverTime(ctx) {
  return ctx.now() + (ctx.client.serverClockOffsetMs || 0);
}

/** 将服务端时刻投影到上海星期，不依赖运行机器的本地时区。 */
export function shanghaiWeekday(milliseconds) {
  return WEEKDAYS[new Date(milliseconds + 8 * 3600_000).getUTCDay()];
}

/** 仅解析已经校验的日期枚举；不接受旧布尔值作为执行期兼容分支。 */
export function modeActive(mode, milliseconds) {
  return mode === 'always' || mode === shanghaiWeekday(milliseconds);
}

/** 日期模式只改变当天执行资格，未到执行日也属于已配置的挂机模块。 */
export function moduleConfigured(id, options) {
  return ['pet', 'equip'].includes(id) ? options.enabled !== 'off' : options.enabled;
}

/** 在每个模块批次入口重新核对宠物和装备的执行日。 */
export function moduleActive(id, options, ctx) {
  return ['pet', 'equip'].includes(id) ? modeActive(options.enabled, serverTime(ctx)) : options.enabled;
}

/** 每日培育补做开关独立于宠物总模式，不能被“全部自动项目已暂停”误判关闭。 */
export function hasConfiguredAutomation(settings) {
  return settings.modules.pet.dailyBreedForPass || Object.entries(settings.modules).some(([id, options]) => moduleConfigured(id, options));
}
