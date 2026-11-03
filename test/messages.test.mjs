import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MESSAGE_LIMIT,
  appendMessage,
  createMessageStore,
  loadInitialMessages,
  messagesFromPush,
  normalizeChatMessage,
  normalizeNotice,
  normalizePrivateChat,
  snapshotMessages,
} from '../src/messages.mjs';

/** 验证世界和联盟频道使用协议 channel 正确分组，并保留系统消息参数。 */
test('messages: chat channels normalize into world and guild tabs', () => {
  const world = normalizeChatMessage(1, { content: { text: '世界发言' }, timestamp: 100 });
  const guild = normalizeChatMessage(2, { sender: { nickname: '盟友' }, content: { systemMsgId: '加入公会', systemMsgParams: ['小明'] }, timestamp: 101 });
  assert.equal(world.kind, 'world');
  assert.equal(world.text, '世界发言');
  assert.equal(guild.kind, 'guild');
  assert.match(guild.text, /加入公会/);
  assert.match(guild.text, /小明/);
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
