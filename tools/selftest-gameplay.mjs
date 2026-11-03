// 单元测试只验证计划和调度；真实账号锁、消费与读回确认另由 test/automation.test.mjs 覆盖。

/** 显式注入内存客户端执行器，不访问账号文件或创建真实连接。 */
function execution(client, options = {}) {
  if (!('connected' in client)) client.connected = true;
  return { actionExecutor: step => step.response
    ? client.request(step.request, step.body, step.response)
    : client.sendWatch(step.request, step.body), ...options };
}

/** 单元夹具沿用生产计划，但只把动作交给调用方提供的假客户端。 */
export const runWorld = async (client, protocol, plan, options) => (await import('../src/world.mjs')).runWorld(client, protocol, plan, execution(client, options));
/** 收货后二次交单使用同一内存执行器。 */
export const runWorldRound = async (client, protocol, plan, options) => (await import('../src/world.mjs')).runWorldRound(client, protocol, plan, execution(client, options));
/** 手动交单仍执行生产环境的订单版本和预留校验。 */
export const submitResidentOrder = async (client, protocol, options) => (await import('../src/world.mjs')).submitResidentOrder(client, protocol, execution(client, options));
/** 调度测试不需要真实账号，独立验证开关、冷却和计划。 */
export const runLoop = async (client, protocol, options) => (await import('../src/loop.mjs')).runLoop(client, protocol, execution(client, options));
/** 日常测试只模拟其原有请求响应。 */
export const runDailies = async (client, protocol, survey, options) => (await import('../src/dailies.mjs')).runDailies(client, protocol, survey, execution(client, options));
/** 领奖测试不绕过生产开关和冷却，只替换协议传输。 */
export const claimDailies = async (client, protocol, options) => (await import('../src/dailies.mjs')).claimDailies(client, protocol, execution(client, options));
/** 上游领奖夹具使用显式执行器，避免误读开发者本地账号账本。 */
export const claimRewards = async (client, protocol, config, onResult, enabled, onDeadline, scheduler, player, options) => (await import('../src/claim-rewards.mjs')).claimRewards(client, protocol, config, onResult, enabled, onDeadline, scheduler, player, execution(client, options));
