// 扫描抓包目录，统计所有消息类型，并导出城战/舰队相关帧。
// 用法: node tools/analyze-citywar-capture.mjs <capture-dir> [--dump]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodec } from '../src/codec.mjs';
import { loadProtocol, PROTO_BUNDLE } from '../src/proto.mjs';

const dir = process.argv[2];
const dump = process.argv.includes('--dump');
if (!dir) {
  console.error('usage: node tools/analyze-citywar-capture.mjs <capture-dir> [--dump]');
  process.exit(1);
}

const protocol = loadProtocol(PROTO_BUNDLE);
const codec = createCodec(protocol);

// 时间戳来自 events.jsonl（id 对应 frames/000000NN.bin）
const events = new Map();
for (const line of readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const e = JSON.parse(line);
    if (e.id && e.capturedAt) events.set(e.id, e);
  } catch { /* 忽略坏行 */ }
}

const CITYWAR = /^(DeclareWar|CancelDeclareWar|WarDeclaration|SCWarDeclaration|SCAssembleCity|SetAssembleCity|SCCityWarTime|SCCityDefNum|GuildCityInfo|DispGuildCity|CityFortInfo|CityState|WorldCity|SCity|CityDefence|CityRecruitDefence|DefenceFleetInfo|CampaignCityWar)/;
const FLEET = /^(MyFleets|SCMyFleet|MoveFleetsToCity|SpeedUpFleet|WorldFleet|FleetState|FleetPower|SCMyFleetPower|RepairFleet|SetFleetAutoFight|FleetFormation|FleetSaveFormation|FleetRepairParam)/;
const SEND_FLEET = /(SendFleet)/;

const tally = new Map();
const hits = [];
const files = readdirSync(join(dir, 'frames')).filter(f => f.endsWith('.bin')).sort();
let failed = 0;

for (const file of files) {
  const id = parseInt(file, 10);
  const bytes = readFileSync(join(dir, 'frames', file));
  let decoded;
  try {
    decoded = codec.decode(bytes);
  } catch {
    failed++;
    continue;
  }
  tally.set(decoded.name, (tally.get(decoded.name) || 0) + 1);
  if (CITYWAR.test(decoded.name) || FLEET.test(decoded.name) || SEND_FLEET.test(decoded.name)) {
    hits.push({ id, name: decoded.name, seq: decoded.seq, dir: events.get(id)?.direction, at: events.get(id)?.capturedAt, body: decoded.body });
  }
}

console.log(`total frames: ${files.length}, undecoded: ${failed}, matched: ${hits.length}`);
console.log('\n=== 消息类型统计 (前 60) ===');
[...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).forEach(([n, c]) => console.log(`${String(c).padStart(4)}  ${n}`));

console.log('\n=== 城战/舰队命中帧 ===');
for (const h of hits) {
  const t = h.at ? h.at.slice(11, 23) : '?';
  console.log(`#${h.id} [${t}] ${h.dir || '?'} ${h.name} seq=${h.seq}`);
}

if (dump) {
  const lines = hits.map(h => {
    const t = h.at ? h.at : '';
    return `---- #${h.id} ${t} ${h.dir} ${h.name} seq=${h.seq}\n` +
      JSON.stringify(h.body, (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v));
  });
  writeFileSync(join(dir, 'citywar-fleet-dump.txt'), lines.join('\n'));
  console.log(`\ndumped to ${join(dir, 'citywar-fleet-dump.txt')}`);
}
