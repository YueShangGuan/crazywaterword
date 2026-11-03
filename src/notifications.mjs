/**
 * Send a text notification through the configured WeCom robot webhook.
 *
 * @param {{notifications?: {wecom?: {enabled?: boolean, webhook?: string}}}} settings Per-account notification settings.
 * @param {string} content Text shown in the WeCom message.
 * @param {{fetchImpl?: typeof fetch}} options Optional fetch implementation for tests.
 * @returns {Promise<{sent: boolean, disabled?: boolean}>} Delivery result.
 */
export async function sendWecomTextNotification(settings, content, { fetchImpl = globalThis.fetch } = {}) {
  const wecom = settings?.notifications?.wecom;
  if (!wecom?.enabled) return { sent: false, disabled: true };
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 没有可用的 fetch');

  // 企微机器人只接受 JSON 文本消息；请求体不写入项目日志，避免泄漏 webhook 地址或消息内容。
  const response = await fetchImpl(wecom.webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content } }),
  });
  let result = null;
  try {
    result = await response.json();
  } catch {
    // 非 JSON 响应仍由 HTTP 状态码判断，避免通知异常掩盖连接断线处理。
  }
  if (!response.ok) throw new Error(`企微通知 HTTP ${response.status}`);
  if (result && Number(result.errcode) !== 0) throw new Error(`企微通知失败：${result.errmsg || result.errcode}`);
  return { sent: true };
}
