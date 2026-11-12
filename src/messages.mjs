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

// 游戏配置 SystemChatM 表（config_cn_pack.json）里的系统消息模板；[color=#xxx] 段在页面按原色高亮。
const SYSTEM_CHAT_TEMPLATES = Object.freeze({
  '加入公会': '欢迎[color=#fdb405]{1}[/color]加入联盟',
  '职位变更': '恭喜[color=#fdb405]{1}[/color]成为联盟新任[color=#fdb405]{2}[/color]',
  '城池易帜': '[color=#fdb405]{1}[/color]的最后一击帮助[color=#fdb405]{2}[/color]占领了[color=#fdb405]{3}[/color]',
  '宣战成功': '联盟[color=#fdb405]{1}[/color]{2}[color=#fdb405]{3}[/color]对城市[color=#fdb405]{4}[/color]宣战',
  '系统宣战': '联盟[color=#fdb405]{1}[/color]对城市[color=#fdb405]{2}[/color]宣战',
  '取消宣战': '联盟[color=#fdb405]{1}[/color]{2}[color=#fdb405]{3}[/color]取消了对城市[color=#fdb405]{4}[/color]的宣战',
  '竞技场第一': '[color=#fdb405]{1}[/color]击败[color=#fdb405]{2}[/color]夺得竞技场第[color=#fdb405]{3}[/color]名',
  '国战连杀': '[color=#fdb405]{1}[/color]在{2}城战中斩获[color=#fdb405]{3}[/color]连胜',
  '终结连杀': '[color=#fdb405]{1}[/color]终结了[color=#fdb405]{2}[/color]的连胜',
  '宝藏刷新': '[color=#fdb405]搁浅的货轮[/color]已在世界刷新，请尽快派舰队前往占领',
  '橙宝藏易主': '联盟[color=#fdb405]{1}[/color]正在抢占[color=#fdb405]{2}[/color]',
  '盟友占领宝藏': '[color=#fdb405]{1}[/color]正在抢占[color=#fdb405]{2}[/color]，快来帮我一起占领！',
  '招募英雄': '恭喜[color=#fdb405][b]{1}[/b][/color]招募[color=#fdb405][b]{2}[/b][/color]品质英雄[color=#fdb405][b]{3}[/b][/color]',
  '招募红英雄': '恭喜[color=#fdb405][b]{1}[/b][/color]招募[color=#ff3b49][b]{2}[/b][/color]品质英雄[color=#ff3b49][b]{3}[/b][/color]',
  '宝藏连杀': '[color=#fdb405]{1}[/color]在[color=#fdb405]{2}[/color]中斩获[color=#fdb405]{3}[/color]连胜',
  '货轮第一': '恭喜[color=#fdb405]{1}[/color]一骑绝尘，成功占领万吨货轮',
  '终结连杀宝箱': '恭喜[color=#fdb405]{1}[/color]终结其他玩家连胜，获得[color=#fdb405]惊喜宝箱[/color]',
  '集结': '[color=#fdb405]{1}[/color]下令集结城市[color=#fdb405]{2}[/color]',
  '实物奖励': '恭喜[color=#fdb405]{1}[/color]抽中实物大奖[color=#fdb405]{2}[/color]！',
  '工事损毁': '城市[color=#fdb405]{1}[/color]的工事[color=#fdb405]{2}[/color]耐久归零，已损毁',
  '工事拆除': '[color=#fdb405]{1}[/color]拆除了城市[color=#fdb405]{2}[/color]的工事[color=#fdb405]{3}[/color]',
  '工事发起建造': '[color=#fdb405]{1}[/color]在城市[color=#fdb405]{2}[/color]发起建造工事[color=#fdb405]{3}[/color]，请速速支援',
  '工事完成建造': '[color=#fdb405]{1}[/color]在城市[color=#fdb405]{2}[/color]建造了工事[color=#fdb405]{3}[/color]',
  '尾刀BOSS出现': '[color=#fdb405]{1}[/color]已出现，请尽快派遣舰队前往战斗',
  '尾刀BOSS击杀': '恭喜[color=#fdb405]{1}[/color]完成了最后一击，成功击败[color=#fdb405]{2}[/color]',
  '联盟商船船长': '[color=#fdb405]{1}[/color]已经成为({2})联盟商船船长，快去一起完成订单吧！',
});

// 每个模板 {n} 占位符对应的参数语义：值为 [参数下标, 类型]；未列出的模板参数全部按文本填入。
// 宝藏连杀的 {3} 用第 4 个参数（下标 2 是货轮所在城市编号，游戏模板不展示）。
const SYSTEM_CHAT_PARAM_KINDS = Object.freeze({
  '职位变更': [[0, 'text'], [1, 'role']],
  '城池易帜': [[0, 'guild'], [1, 'text'], [2, 'city']],
  '宣战成功': [[0, 'guild'], [1, 'role'], [2, 'text'], [3, 'city']],
  '系统宣战': [[0, 'guild'], [1, 'city']],
  '取消宣战': [[0, 'guild'], [1, 'role'], [2, 'text'], [3, 'city']],
  '国战连杀': [[0, 'text'], [1, 'city'], [2, 'text']],
  '橙宝藏易主': [[0, 'guild'], [2, 'ship']],
  '盟友占领宝藏': [[0, 'text'], [2, 'ship']],
  '宝藏连杀': [[0, 'text'], [1, 'ship'], [3, 'text']],
  '集结': [[0, 'text'], [1, 'city']],
  '工事损毁': [[0, 'city'], [1, 'text']],
  '工事拆除': [[0, 'text'], [1, 'city'], [2, 'text']],
  '工事发起建造': [[0, 'text'], [1, 'city'], [2, 'text']],
  '工事完成建造': [[0, 'text'], [1, 'city'], [2, 'text']],
  '联盟商船船长': [[0, 'text'], [1, 'ship']],
});

// 联盟职位枚举到中文（GuildTitleCfg 的 title 名称）；未识别的枚举按原文展示。
const GUILD_ROLE_NAMES = Object.freeze({
  PRESIDENT: '盟主',
  VICE_PRESIDENT: '副盟主',
  ELITE: '精英',
  MEMBER: '正式',
  RESERVE: '后备',
});

// 货轮品质枚举到货轮名（联盟任务里 蓝/紫/橙 对应 小型/中型/万吨）。
const MERCHANT_SHIP_NAMES = Object.freeze({
  BLUE: '小型货轮',
  PURPLE: '中型货轮',
  ORANGE: '万吨货轮',
  '蓝': '小型货轮',
  '紫': '中型货轮',
  '橙': '万吨货轮',
});

// 联盟商船的三档规格（GuildShipCfg 的 ship_small/medium/large），正式名称见游戏帮助：
// 史诗商船 2.5 小时、传说商船 5 小时、超凡商船 9 小时。服务端枚举前缀混用（SHIP/SHOP 都有出现），两个家族都映射。
const GUILD_SHIP_NAMES = Object.freeze({
  GUILD_SHIP_S: '史诗商船',
  GUILD_SHIP_M: '传说商船',
  GUILD_SHIP_L: '超凡商船',
  GUILD_SHOP_S: '史诗商船',
  GUILD_SHOP_M: '传说商船',
  GUILD_SHOP_L: '超凡商船',
});

/** 把模板参数按语义转换：城市编号走赛季城市表，联盟编号暂无名称来源只能显示编号。 */
function resolveChatParam(kind, value, ctx) {
  const text = String(value ?? '');
  if (kind === 'city') {
    if (/^\d+$/.test(text)) return ctx?.cityNames?.get(Number(text)) ?? `城 #${text}`;
    return text;
  }
  // 联盟编号优先走四大势力名（ctx.factionNames，赛季实测对照），未知编号按原值展示；
  // 模板自身已带"联盟"字样（如 联盟{1}正在抢占），名称裸填即可。
  if (kind === 'guild') return ctx?.factionNames?.[Number(text)] ?? text;
  if (kind === 'role') return GUILD_ROLE_NAMES[text] ?? text;
  // 搁浅货轮按品质枚举（ORANGE=万吨货轮），联盟商船按规格枚举（GUILD_SHIP_S=史诗商船）。
  if (kind === 'ship') return MERCHANT_SHIP_NAMES[text] ?? GUILD_SHIP_NAMES[text] ?? text;
  return text;
}

/** 按 [color=#xxx]、{n} 拆开模板并填入参数，返回 [{text,color}] 分段；相邻同色段合并。 */
function renderChatTemplate(notice, resolve) {
  const segments = [];
  let plain = '';
  let color = null;
  const flush = () => {
    if (!plain) return;
    const last = segments[segments.length - 1];
    if (last && last.color === color) last.text += plain;
    else segments.push(color ? { text: plain, color } : { text: plain });
    plain = '';
  };
  const pattern = /\[color=(#[0-9a-fA-F]{6})\]|\[\/color\]|\{(\d+)\}|\[\/?b\]/g;
  let cursor = 0;
  for (let match = pattern.exec(notice); match; match = pattern.exec(notice)) {
    plain += notice.slice(cursor, match.index);
    cursor = pattern.lastIndex;
    if (match[1] !== undefined) { flush(); color = match[1]; }
    else if (match[0] === '[/color]') { flush(); color = null; }
    else if (match[2] !== undefined) plain += resolve(Number(match[2]));
    // [b]/[/b] 加粗标记在控制台没有意义，直接丢弃。
  }
  plain += notice.slice(cursor);
  flush();
  return segments.filter((segment) => segment.text);
}

/** 把系统消息按配置模板转成可读分段；未收录的消息返回 null，由调用方走原样拼接。 */
export function formatSystemChat(systemMsgId, params = [], ctx = null) {
  const template = SYSTEM_CHAT_TEMPLATES[systemMsgId];
  if (!template) return null;
  const kinds = SYSTEM_CHAT_PARAM_KINDS[systemMsgId] ?? null;
  return renderChatTemplate(template, (slot) => {
    const entry = kinds?.[slot - 1] ?? [slot - 1, 'text'];
    return resolveChatParam(entry[1], params[entry[0]], ctx);
  });
}

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

/** 将文本消息和系统消息统一成页面可以直接展示的文本；系统消息按配置模板转成可读分段。 */
function normalizeContent(content = {}, ctx = null) {
  const params = Array.isArray(content.systemMsgParams) ? content.systemMsgParams.map(scalarText) : [];
  const text = String(content.text ?? '').trim();
  const systemMsgId = String(content.systemMsgId ?? '').trim();
  const segments = text ? null : (systemMsgId ? formatSystemChat(systemMsgId, params, ctx) : null);
  const displayText = text
    || (segments?.length ? segments.map((segment) => segment.text).join('') : '')
    || [systemMsgId, ...params].filter(Boolean).join(' · ')
    || '（无文本消息）';
  return {
    text: displayText,
    type: Number(content.type ?? 0),
    systemMsgId: systemMsgId || null,
    systemMsgParams: params,
    segments: segments?.length ? segments : null,
    attachment: content.attachment ? {
      url: String(content.attachment.url ?? ''),
      icon: String(content.attachment.icon ?? ''),
      emoji: Number(content.attachment.emoji ?? 0),
    } : null,
  };
}

/** 将世界或联盟频道的一条 ChatMessage 转成安全的页面消息对象。 */
export function normalizeChatMessage(channel, message, ctx = null) {
  const kind = channel === MESSAGE_CHANNELS.world ? 'world' : channel === MESSAGE_CHANNELS.guild ? 'guild' : null;
  if (!kind || !message) return null;
  const content = normalizeContent(message.content, ctx);
  const sender = message.sender ? {
    playerId: scalarText(message.sender.playerId) || null,
    nickname: String(message.sender.nickname ?? '').trim() || null,
    guildTitle: String(message.sender.guildTitle ?? '').trim() || null,
  } : null;
  const at = timestampMs(message.timestamp);
  const id = [kind, message.timestamp ?? '', sender?.playerId ?? sender?.nickname ?? '', content.systemMsgId ?? '', content.text, content.systemMsgParams.join('|')].join(':');
  return { id, kind, at, sender, text: content.text, systemMsgId: content.systemMsgId, systemMsgParams: content.systemMsgParams, segments: content.segments, type: content.type };
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

/** 从服务端推送中提取一条或多条可展示的游戏消息；ctx 提供城市名称等转换上下文。 */
export function messagesFromPush(name, body, ctx = null) {
  if (name === 'SCChatReceive') {
    const message = normalizeChatMessage(body?.channel, body?.message, ctx);
    return message ? [message] : [];
  }
  if (name === 'SCBatchChatReceive') {
    return (Array.isArray(body?.messages) ? body.messages : [])
      .map((entry) => normalizeChatMessage(entry.channel, entry.message, ctx))
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
export async function loadInitialMessages(client, protocol, ctx = null) {
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

  await query('世界', 'ChatRecordRequest', 'ChatRecordResponse', { channel: MESSAGE_CHANNELS.world }, (body) => (Array.isArray(body?.message) ? body.message : []).map((item) => normalizeChatMessage(MESSAGE_CHANNELS.world, item, ctx)));
  await query('联盟', 'ChatRecordRequest', 'ChatRecordResponse', { channel: MESSAGE_CHANNELS.guild }, (body) => (Array.isArray(body?.message) ? body.message : []).map((item) => normalizeChatMessage(MESSAGE_CHANNELS.guild, item, ctx)));
  await query('通知', 'OnlineNoticesRequest', 'OnlineNoticesResponse', {}, (body) => (Array.isArray(body?.notices) ? body.notices : []).map((item) => normalizeNotice(item)));
  await query('私聊', 'PrivateChatListRequest', 'PrivateChatListResponse', {}, (body) => (Array.isArray(body?.chats) ? body.chats : []).map((item) => normalizePrivateChat(item)));
  return { messages, errors };
}
