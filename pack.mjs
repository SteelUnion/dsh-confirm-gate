// 按白名单打包，不靠 git 导出，也不依赖记忆里的文件名列表。
//
// 为什么要有这个脚本：dist/README.md 早先写着「打包脚本在 default-workspace\」，
// 但那个脚本并不存在 —— 每次发版都是手敲 Compress-Archive 并靠记忆列文件。
// 那样的产物不可复现：换个人、换一天，包里的东西可能就不一样。
//
// 用法：node pack.mjs
// 版本号从 package.json 读，输出到 dist/dsh-confirm-gate-v<version>.zip。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

/**
 * 白名单：包内文件，顺序固定（顺序影响哈希，固定才能复现）。
 * 加文件必须改这里，不允许通配 —— 通配会让 .git、docs、dist 悄悄漏进去。
 */
const INCLUDE = [
  'lib/index.js',
  'test/integration.mjs',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
];

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version.trim() === '') {
  console.error('package.json 里没有可用的 version');
  process.exit(1);
}

const name = `dsh-confirm-gate-v${version}.zip`;
const outPath = join(DIST, name);

// ---- 收集并校验 ----
const entries = [];
for (const rel of INCLUDE) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`缺少文件：${rel}`);
    process.exit(1);
  }
  entries.push({ rel, data: readFileSync(abs) });
}

// package.json 的版本必须和包名一致，避免打出「文件名 v0.1.1、包内 0.1.0」这种包
const inner = JSON.parse(entries.find((e) => e.rel === 'package.json').data.toString('utf8'));
if (inner.version !== version) {
  console.error(`版本不一致：文件名用 ${version}，package.json 是 ${inner.version}`);
  process.exit(1);
}

// ---- 最小 ZIP 写入 ----
// 不引第三方依赖（本包运行时依赖为零，构建也应如此）。
function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

// DOS 时间戳固定为 1980-01-01，让同样的输入得到同样的字节（可复现）
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const locals = [];
const centrals = [];
let offset = 0;

for (const { rel, data } of entries) {
  const nameBuf = Buffer.from(rel, 'utf8');
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 name flag
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + compressed.length;
}

const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const zip = Buffer.concat([...locals, centralBuf, end]);

mkdirSync(DIST, { recursive: true });
writeFileSync(outPath, zip);

console.log(`打包完成：dist/${name}`);
console.log(`  版本    ${version}`);
console.log(`  大小    ${zip.length} B`);
console.log(`  文件    ${entries.length} 个`);
for (const { rel, data } of entries) {
  console.log(`    ${rel.padEnd(24)} ${data.length} B`);
}
