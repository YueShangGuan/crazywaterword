/** 每个消息频道在内存中保留的最大消息数。 */
export const MESSAGE_LIMIT = 100;

/** 游戏消息面板使用的四个频道及其协议频道映射。 */
export const MESSAGE_CHANNELS = Object.freeze({
  world: 1,
  guild: 2,
  notice: null,
  private: null,
});

const MESSAGE_KINDS = Object.freeze(['world', 'notice', 'private', 'guild']);

/** 创建一个只存在于当前 Node.js 进程的账号消息缓存。 */
export function createMessageStore() {
  return {
    world: [],
    notice: [],
    private: [],
    guild: [],
    ids: {
      world: new Set(),
      notice: new Set(),
      private: new Set(),
      guild: new Set(),
    },
  };
}

/** 把 protobufjs 未安装 Long 时产生的 int64 对象转换为稳定字符串。 */
function scalarText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && typeof value.low === 'number' && typeof value.high === 'number') {
    const unsigned = value.unsigned !== false;
    const low = BigInt(value.low >>> 0);
    const high = BigInt(unsigned ? value.high >>> 0 : value.high);
    return String((high << 32n) + low);
  }
  return String(value);
}

/** 返回可供页面显示的时间戳；游戏协议的时间字段使用 Unix 秒。 */
function timestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return number < 100000000000 ? number * 1000 : number;
}

/** 将文本消息和系统消息统一成页面可以直接展示的文本。 */
function normalizeContent(content = {}) {
  const params = Array.isArray(content.systemMsgParams) ? content.systemMsgParams.map(scalarText) : [];
  const text = String(content.text ?? '').trim();
  const systemMsgId = String(content.systemMsgId ?? '').trim();
  const displayText = text || [systemMsgId, ...params].filter(Boolean).join(' · ') || '（无文本消息）';
  return {
    text: displayText,
    type: Number(content.type ?? 0),
    systemMsgId: systemMsgId || null,
    systemMsgParams: params,
    attachment: content.attachment ? {
      url: String(content.attachment.url ?? ''),
      icon: String(content.attachment.icon ?? ''),
      emoji: Number(content.attachment.emoji ?? 0),
    } : null,
  };
}

/** 将世界或联盟频道的一条 ChatMessage 转成安全的页面消息对象。 */
export function normalizeChatMessage(channel, message) {
  const kind = channel === MESSAGE_CHANNELS.world ? 'world' : channel === MESSAGE_CHANNELS.guild ? 'guild' : null;
  if (!kind || !message) return null;
  const content = normalizeContent(message.content);
  const sender = message.sender ? {
    playerId: scalarText(message.sender.playerId) || null,
    nickname: String(message.sender.nickname ?? '').trim() || null,
    guildTitle: String(message.sender.guildTitle ?? '').trim() || null,
  } : null;
  const at = timestampMs(message.timestamp);
  const id = [kind, message.timestamp ?? '', sender?.playerId ?? sender?.nickname ?? '', content.systemMsgId ?? '', content.text, content.systemMsgParams.join('|')].join(':');
  return { id, kind, at, sender, text: content.text, systemMsgId: content.systemMsgId, systemMsgParams: content.systemMsgParams, type: content.type };
}

/** 将私聊列表中的最近摘要转成私聊 tab 消息。 */
export function normalizePrivateChat(chat) {
  const record = chat?.record;
  if (!record) return null;
  const peer = chat.peer ? {
    playerId: scalarText(chat.peer.playerId) || null,
    nickname: String(chat.peer.nickname ?? '').trim() || null,
    guildTitle: String(chat.peer.guildTitle ?? '').trim() || null,
  } : null;
  const emoji = Number(record.emoji ?? 0);
  const message = String(record.message ?? '').trim();
  const text = message || (emoji ? `表情 #${emoji}` : '（无文本消息）');
  const at = timestampMs(record.timestamp);
  const id = ['private', peer?.playerId ?? peer?.nickname ?? '', record.timestamp ?? '', record.side ?? '', record.type ?? '', message, emoji].join(':');
  return { id, kind: 'private', at, sender: peer, text, systemMsgId: null, systemMsgParams: [], type: Number(record.type ?? 0), side: Number(record.side ?? 0), emoji };
}

/** 将公告按中文优先规则转成通知 tab 消息。 */
export function normalizeNotice(notice) {
  if (!notice) return null;
  const contents = Array.isArray(notice.content) ? notice.content : [];
  const preferred = contents.find((entry) => /^zh(?:-CN)?$/i.test(String(entry.language ?? '')))
    ?? contents.find((entry) => String(entry.content ?? '').trim())
    ?? null;
  const text = String(preferred?.content ?? '').trim() || `公告 ${String(notice.noticeId ?? '')}`;
  const at = timestampMs(notice.startTime || notice.endTime);
  const id = ['notice', notice.noticeId ?? '', notice.startTime ?? '', notice.endTime ?? '', text].join(':');
  return {
    id,
    kind: 'notice',
    at,
    sender: { nickname: '系统' },
    text,
    systemMsgId: String(notice.noticeId ?? '').trim() || null,
    systemMsgParams: [],
    type: 0,
    startTime: timestampMs(notice.startTime),
    endTime: timestampMs(notice.endTime),
    showPlace: Number(notice.showPlace ?? 0),
  };
}

/** 从服务端推送中提取一条或多条可展示的游戏消息。 */
export function messagesFromPush(name, body) {
  if (name === 'SCChatReceive') {
    const message = normalizeChatMessage(body?.channel, body?.message);
    return message ? [message] : [];
  }
  if (name === 'SCBatchChatReceive') {
    return (Array.isArray(body?.messages) ? body.messages : [])
      .map((entry) => normalizeChatMessage(entry.channel, entry.message))
      .filter(Boolean);
  }
  if (name === 'SCPrivateChatMessage') {
    const message = normalizePrivateChat(body?.record);
    return message ? [message] : [];
  }
  if (name === 'SCNotice') {
    return (Array.isArray(body?.notice) ? body.notice : [])
      .map((entry) => normalizeNotice(entry))
      .filter(Boolean);
  }
  return [];
}

/** 写入一条消息并按频道执行去重和 100 条内存上限。 */
export function appendMessage(store, message) {
  if (!message || !MESSAGE_KINDS.includes(message.kind)) return false;
  const list = store[message.kind];
  const ids = store.ids[message.kind];
  if (ids.has(message.id)) return false;
  ids.add(message.id);
  list.push(message);
  list.sort((left, right) => left.at - right.at);
  while (list.length > MESSAGE_LIMIT) {
    const removed = list.shift();
    if (removed) ids.delete(removed.id);
  }
  return true;
}

/** 返回不包含 Set 的 JSON 安全快照，防止内部缓存结构泄露到 HTTP 响应。 */
export function snapshotMessages(store) {
  return Object.fromEntries(MESSAGE_KINDS.map((kind) => [kind, store[kind].map((message) => ({ ...message }))]));
}

/** 登录后加载四类只读历史消息；单类失败只记录错误，不阻断实时消息接收。 */
export async function loadInitialMessages(client, protocol) {
  const messages = [];
  const errors = [];
  const query = async (label, request, response, body, map) => {
    if (!protocol[request] || !protocol[response]) {
      errors.push({ source: label, error: `缺少协议类型 ${request}/${response}` });
      return;
    }
    try {
      const result = await client.request(request, body, response);
      for (const item of map(result)) if (item) messages.push(item);
    } catch (error) {
      errors.push({ source: label, error: error.message });
    }
  };

  await query('世界', 'ChatRecordRequest', 'ChatRecordResponse', { channel: MESSAGE_CHANNELS.world }, (body) => (Array.isArray(body?.message) ? body.message : []).map((item) => normalizeChatMessage(MESSAGE_CHANNELS.world, item)));
  await query('联盟', 'ChatRecordRequest', 'ChatRecordResponse', { channel: MESSAGE_CHANNELS.guild }, (body) => (Array.isArray(body?.message) ? body.message : []).map((item) => normalizeChatMessage(MESSAGE_CHANNELS.guild, item)));
  await query('通知', 'OnlineNoticesRequest', 'OnlineNoticesResponse', {}, (body) => (Array.isArray(body?.notices) ? body.notices : []).map((item) => normalizeNotice(item)));
  await query('私聊', 'PrivateChatListRequest', 'PrivateChatListResponse', {}, (body) => (Array.isArray(body?.chats) ? body.chats : []).map((item) => normalizePrivateChat(item)));
  return { messages, errors };
}
