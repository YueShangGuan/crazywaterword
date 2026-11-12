import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MESSAGE_LIMIT,
  appendMessage,
  createMessageStore,
  formatSystemChat,
  loadInitialMessages,
  messagesFromPush,
  normalizeChatMessage,
  normalizeNotice,
  normalizePrivateChat,
  snapshotMessages,
} from '../src/messages.mjs';

/** 验证世界和联盟频道使用协议 channel 正确分组，系统消息按模板转成可读文本。 */
test('messages: chat channels normalize into world and guild tabs', () => {
  const world = normalizeChatMessage(1, { content: { text: '世界发言' }, timestamp: 100 });
  const guild = normalizeChatMessage(2, { sender: { nickname: '盟友' }, content: { systemMsgId: '加入公会', systemMsgParams: ['小明'] }, timestamp: 101 });
  assert.equal(world.kind, 'world');
  assert.equal(world.text, '世界发言');
  assert.equal(guild.kind, 'guild');
  assert.equal(guild.text, '欢迎小明加入联盟');
  assert.equal(guild.segments.length, 3);
  assert.deepEqual(guild.segments[0], { text: '欢迎' });
  assert.deepEqual(guild.segments[1], { text: '小明', color: '#fdb405' });
  assert.deepEqual(guild.segments[2], { text: '加入联盟' });
});

/** 验证系统消息模板会翻译城市编号、货轮品质与职位枚举，并保留配置里的高亮分段。 */
test('messages: system chat templates resolve city ids, ship grades and roles', () => {
  const ctx = {
    cityNames: new Map([[61, '营地G0'], [4, '营地A3']]),
    factionNames: { 1: '太阳岛', 2: '铁锈湾', 3: '风栖港', 4: '水之都' },
  };
  const streak = normalizeChatMessage(1, { content: { systemMsgId: '国战连杀', systemMsgParams: ['威呀', '61', '5', '0', '4', '0', '1'] }, timestamp: 100 }, ctx);
  assert.equal(streak.text, '威呀在营地G0城战中斩获5连胜');
  assert.deepEqual(streak.segments, [
    { text: '威呀', color: '#fdb405' },
    { text: '在营地G0城战中斩获' },
    { text: '5', color: '#fdb405' },
    { text: '连胜' },
  ]);
  const seize = formatSystemChat('橙宝藏易主', ['2', '47', 'ORANGE'], ctx);
  assert.equal(seize.map((segment) => segment.text).join(''), '联盟铁锈湾正在抢占万吨货轮');
  const seizeFallback = formatSystemChat('橙宝藏易主', ['9', '47', 'ORANGE']);
  assert.equal(seizeFallback.map((segment) => segment.text).join(''), '联盟9正在抢占万吨货轮');
  const treasureStreak = formatSystemChat('宝藏连杀', ['梦千世界', 'ORANGE', '47', '5', '0', '2', '0']);
  assert.equal(treasureStreak.map((segment) => segment.text).join(''), '梦千世界在万吨货轮中斩获5连胜');
  const declare = formatSystemChat('宣战成功', ['1', 'VICE_PRESIDENT', '哈哈有辱斯文', '78'], ctx);
  assert.equal(declare.map((segment) => segment.text).join(''), '联盟太阳岛副盟主哈哈有辱斯文对城市城 #78宣战');
  const ship = normalizeChatMessage(2, { content: { systemMsgId: '货轮第一', systemMsgParams: ['梦千世界'] }, timestamp: 101 });
  assert.equal(ship.text, '恭喜梦千世界一骑绝尘，成功占领万吨货轮');
  const captainSmall = formatSystemChat('联盟商船船长', ['乱世霸蛮荒0955', 'GUILD_SHIP_S']);
  assert.equal(captainSmall.map((segment) => segment.text).join(''), '乱世霸蛮荒0955已经成为(史诗商船)联盟商船船长，快去一起完成订单吧！');
  const captainMedium = formatSystemChat('联盟商船船长', ['沙场点兵4576', 'GUILD_SHOP_M']);
  assert.equal(captainMedium.map((segment) => segment.text).join(''), '沙场点兵4576已经成为(传说商船)联盟商船船长，快去一起完成订单吧！');
  const captainLarge = formatSystemChat('联盟商船船长', ['啵啵萝卜', 'GUILD_SHOP_L']);
  assert.equal(captainLarge.map((segment) => segment.text).join(''), '啵啵萝卜已经成为(超凡商船)联盟商船船长，快去一起完成订单吧！');
});

/** 验证未收录的系统消息仍按 "编号 · 参数" 原样拼接，不抛错也不产生分段。 */
test('messages: unknown system message ids keep the raw joined fallback', () => {
  const unknown = normalizeChatMessage(1, { content: { systemMsgId: '未知消息', systemMsgParams: ['甲', '乙'] }, timestamp: 100 });
  assert.equal(unknown.text, '未知消息 · 甲 · 乙');
  assert.equal(unknown.segments, null);
});

/** 验证批量推送会拆成多条消息，私聊和通知也会得到安全显示文本。 */
test('messages: push batches, private records and notices normalize safely', () => {
  const batch = messagesFromPush('SCBatchChatReceive', {
    messages: [
      { channel: 1, message: { content: { text: '一' }, timestamp: 100 } },
      { channel: 2, message: { content: { text: '二' }, timestamp: 101 } },
    ],
  });
  const privateMessage = messagesFromPush('SCPrivateChatMessage', {
    record: { peer: { nickname: '好友' }, record: { message: '你好', timestamp: 102 } },
  });
  const notice = normalizeNotice({ noticeId: 'n1', content: [{ language: 'zh-CN', content: '维护公告' }] });
  assert.deepEqual(batch.map((entry) => entry.kind), ['world', 'guild']);
  assert.equal(normalizePrivateChat({ peer: { nickname: '好友' }, record: { message: '你好', timestamp: 102 } }).text, '你好');
  assert.equal(privateMessage[0].kind, 'private');
  assert.equal(notice.text, '维护公告');
});

/** 验证每个频道独立去重并限制在最近 100 条，快照不会暴露内部 Set。 */
test('messages: each tab keeps only its latest 100 unique entries', () => {
  const store = createMessageStore();
  for (let index = 0; index < MESSAGE_LIMIT + 5; index += 1) {
    appendMessage(store, { id: `m${index}`, kind: 'world', at: index, text: String(index) });
  }
  assert.equal(store.world.length, MESSAGE_LIMIT);
  assert.equal(store.world[0].id, 'm5');
  assert.equal(appendMessage(store, { id: 'm5', kind: 'world', at: 5, text: 'duplicate' }), false);
  assert.deepEqual(Object.keys(snapshotMessages(store)), ['world', 'notice', 'private', 'guild']);
  assert.equal(snapshotMessages(store).world.length, MESSAGE_LIMIT);
});

/** 验证登录后的四类历史查询按只读顺序执行，单类失败不会阻断其他类别。 */
test('messages: initial history queries are isolated by category', async () => {
  const calls = [];
  const client = {
    request: async (name, body) => {
      calls.push({ name, body });
      if (name === 'ChatRecordRequest' && body.channel === 2) throw new Error('没有联盟');
      if (name === 'ChatRecordRequest') return { message: [{ content: { text: '历史世界' }, timestamp: 100 }] };
      if (name === 'OnlineNoticesRequest') return { notices: [{ noticeId: 'n1', content: [{ language: 'zh-CN', content: '公告' }] }] };
      return { chats: [{ peer: { nickname: '好友' }, record: { message: '私聊历史', timestamp: 101 } }] };
    },
  };
  const protocol = Object.fromEntries([
    'ChatRecordRequest', 'ChatRecordResponse', 'OnlineNoticesRequest', 'OnlineNoticesResponse',
    'PrivateChatListRequest', 'PrivateChatListResponse',
  ].map((name) => [name, {}]));
  const result = await loadInitialMessages(client, protocol);
  assert.deepEqual(calls.map((call) => call.name), ['ChatRecordRequest', 'ChatRecordRequest', 'OnlineNoticesRequest', 'PrivateChatListRequest']);
  assert.deepEqual(result.messages.map((message) => message.kind), ['world', 'notice', 'private']);
  assert.deepEqual(result.errors.map((error) => error.source), ['联盟']);
});
