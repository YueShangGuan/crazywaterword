// 从抓包目录解码全部 Snowball 帧，输出带字段名的完整数据记录。
// 用法: node tools/dump-snowball-capture.mjs <capture-dir> [--ops]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodec } from '../src/codec.mjs';
import { loadProtocol, PROTO_BUNDLE } from '../src/proto.mjs';

const dir = process.argv[2];
const verbose = process.argv.includes('--ops');
if (!dir) {
  console.error('usage: node tools/dump-snowball-capture.mjs <capture-dir> [--ops]');
  process.exit(1);
}

const protocol = loadProtocol(PROTO_BUNDLE);
const codec = createCodec(protocol);

const files = readdirSync(join(dir, 'frames')).filter(f => f.endsWith('.bin')).sort();
for (const file of files) {
  const bytes = readFileSync(join(dir, 'frames', file));
  let decoded;
  try {
    decoded = codec.decode(bytes);
  } catch (error) {
    continue; // 非本协议帧（如 zlib/其它通道）
  }
  if (!/Snowball/i.test(decoded.name)) continue;
  const id = parseInt(file, 10);
  if (!verbose && decoded.name === 'SnowballOpResponse' && id > 1500) continue;
  console.log(`---- #${id} ${decoded.name} seq=${decoded.seq}`);
  console.log(JSON.stringify(decoded.body, (key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value)));
}
