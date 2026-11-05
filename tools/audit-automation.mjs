import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadProtocol } from '../src/proto.mjs';
import { fields } from './describe.mjs';
import { validateMessage } from '../src/automation/context.mjs';

const root = path.resolve(import.meta.dirname, '..');
const protocol = loadProtocol();
const equivalents = {
  AutoAppointRequest: { target: 'AppointHeroRequest', reason: '按显式选择的英雄与位置逐条委任；不让服务端自动选择未授权英雄' },
  RadarGetAllRewardsRequest: { target: 'RadarGetRewardRequest', reason: '按当前事件状态与用户选择类型逐条领取，避免领取被排除类型' },
};
// 当前协议存在异名响应和同请求的不同玩法响应，必须显式列出并一并往返核对。
const responseNames = {
  // 跨服积分宝箱响应与请求不共享前缀，以抓包验证的 GotRewardResponse 为准。
  GetDailyRewardRequest: ['GotRewardResponse'],
  GainBigFishRequest: ['GainBigResponse'],
  GotTradeReportRequest: ['GotTTradeReportResponse'],
  HeroExclusiveLevelUpRequest: ['HeroExclusiveNextUpResponse'],
  HeroExclusiveStarUpRequest: ['HeroExclusiveNextUpResponse'],
  LeagueFormationSequenceRequest: ['LeagueFormationResponse'],
  SetAssembleCityRequest: ['SCAssembleCity'],
  SnapStartRequest: ['SnapMatchStateResponse'],
  SnapGiveUpRequest: ['SnapMatchStateResponse'],
  SnapStartMatchmakingRequest: ['SCSnapMatchmakingFinished'],
  SnapCancelMatchmakingRequest: ['SCSnapMatchmakingFinished'],
  SnapEndRoundRequest: ['SnapEndRoundResponse', 'SCSnapPvpRoundResult'],
};

/** 递归枚举本项目 Node 源码，不读取开发者工作区之外的文件。 */
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : file.endsWith('.mjs') && !entry.name.startsWith('selftest') ? [file] : [];
  });
}

/** 以行号保存请求的实际源码出现位置；该索引只证明实现入口存在，不替代业务测试。 */
function references(list) {
  const out = new Map();
  for (const file of list) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) for (const match of line.matchAll(/["'](\w+Request)["']/g)) {
      if (!out.has(match[1])) out.set(match[1], []);
      out.get(match[1]).push(`${path.relative(root, file).replaceAll('\\', '/')}:${index + 1}`);
    }
  }
  return out;
}

/** 从当前字段表构造最小可编码样本，数字 ID 用超过安全整数上限的十进制串。 */
function sample(name, depth = 0) {
  if (depth > 12) throw new Error(`协议递归过深 ${name}`);
  const body = {};
  for (const field of fields(name)) {
    assert.notEqual(field.kind, 'unknown', `${name}.${field.name} 未提取类型`);
    const value = field.kind === 'message' || (field.kind === 'repeated' && protocol[field.type]?.encode) ? sample(field.type, depth + 1)
      : field.type === 'string' ? 'fixture' : field.type === 'bool' ? true : /64$/.test(field.type) ? '9007199254740993' : 1;
    body[field.name] = field.kind === 'repeated' ? [value] : value;
  }
  return body;
}

/** 逐项记录已审查请求字段、响应和目标执行入口，并用当前生成器完成编码/解码验证。 */
export function audit() {
  // 参考范围固定在已审查并提交的索引中；新克隆不应依赖开发者的相邻仓库才能离线验证。
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/automation-protocol.json'), 'utf8'));
  const source = new Map(manifest.map(entry => [entry.request, entry.reference]));
  const targets = references(files(path.join(root, 'src')));
  // 三类采集强化由同一执行器按当前表名展开，索引显式列出展开后的协议名。
  for (const name of ['FishingLevelUpRequest', 'DivingLevelUpRequest', 'SalvageLevelUpRequest']) targets.set(name, ['src/automation/base.mjs:gather']);
  const entries = [];
  for (const [request, evidence] of [...source].sort(([a], [b]) => a.localeCompare(b))) {
    assert.ok(protocol[request], `缺少参考请求 ${request}`);
    validateMessage(protocol[request], sample(request));
    const response = `${request.slice(0, -7)}Response`;
    const responses = responseNames[request] ?? (protocol[response] ? [response] : []);
    for (const name of responses) { assert.ok(protocol[name], `缺少响应 ${name}`); validateMessage(protocol[name], sample(name)); }
    const equivalent = equivalents[request];
    const implementation = targets.get(equivalent?.target ?? request);
    assert.ok(implementation?.length, `缺少执行入口 ${request}`);
    entries.push({ request, reference: evidence, implementation, equivalent: equivalent?.reason, fields: fields(request), response: responses[0] ?? null, responses });
  }
  assert.equal(entries.length, 224, '参考请求清单发生变化，需要重新审查功能范围');
  return entries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = audit();
  if (process.argv.includes('--write')) {
    // 生成审查索引不接触参考源码，也不访问任何账号或游戏连接。
    fs.writeFileSync(path.join(root, 'docs/automation-protocol.json'), `${JSON.stringify(entries, null, 2)}\n`);
    const rows = entries.map(e => `| ${e.request} | ${e.reference[0]} | ${e.implementation[0]} | ${e.responses.join(' / ') || '推送或业务读回'} | ${e.equivalent ?? '当前编解码器校验通过'} |`);
    fs.writeFileSync(path.join(root, 'docs/automation-requests.md'), `# 参考请求逐项核对\n\n此表是源码入口与协议字段索引，业务验收见 automation-coverage.md；不代表真实网关验收。完整字段见 automation-protocol.json。\n\n| 请求 | 参考位置 | 目标入口 | 响应或状态确认 | 说明 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`);
  }
  console.log(`automation protocol audit: ${entries.length} requests round-tripped; ${Object.keys(equivalents).length} deliberate equivalent flows`);
}
