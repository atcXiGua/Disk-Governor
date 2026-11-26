#!/usr/bin/env node
/**
 * pack.js — 零依赖 zip 打包器
 *
 * 为什么不用 Compress-Archive / tar：
 *   两者在 Windows 上按系统 ANSI（简体中文为 GBK）写入文件名，且不置 UTF-8 标志位。
 *   结果是在非中文 Windows 上解压，`启动.cmd` 之类的文件名会变成乱码。
 *   本脚本始终以 UTF-8 编码文件名并置通用标志位 bit 11（EFS），跨系统解压一致。
 *
 * 用法：
 *   node scripts/pack.js <源目录> <输出.zip>
 *
 * 说明：
 *   - 不压缩目录条目，只打包普通文件
 *   - 跳过 .git / node_modules / dist 以及以 . 开头的隐藏文件
 *   - 单文件与总大小均需小于 4GB（不使用 zip64）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

function walk(root, relative, out) {
  const abs = path.join(root, relative);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(root, rel, out);
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.')) continue;
      out.push(rel);
    }
  }
  return out;
}

function main() {
  const [srcArg, outArg] = process.argv.slice(2);
  if (!srcArg || !outArg) {
    console.error('用法: node scripts/pack.js <源目录> <输出.zip>');
    process.exit(1);
  }

  const src = path.resolve(srcArg);
  const out = path.resolve(outArg);
  if (!fs.existsSync(src)) {
    console.error(`源目录不存在: ${src}`);
    process.exit(1);
  }

  const files = walk(src, '', []).sort();
  if (files.length === 0) {
    console.error('源目录为空，未生成 zip');
    process.exit(1);
  }

  const chunks = [];
  const central = [];
  let offset = 0;
  const FLAG_UTF8 = 0x0800;
  const METHOD_DEFLATE = 8;

  for (const rel of files) {
    const abs = path.join(src, rel);
    const data = fs.readFileSync(abs);
    const name = Buffer.from(rel, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // 极少数情况下 deflate 后反而更大，此时退回 store
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const { time, day } = dosTime(fs.statSync(abs).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(useDeflate ? METHOD_DEFLATE : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(useDeflate ? METHOD_DEFLATE : 0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 30);
    cd.writeUInt32LE(0, 34);
    cd.writeUInt16LE(0, 38);
    cd.writeUInt16LE(0, 40);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const cdBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([...chunks, cdBuffer, eocd]));

  const sizeMB = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`已生成 ${out}`);
  console.log(`  文件数 ${files.length}  大小 ${sizeMB} MB  文件名编码 UTF-8`);
}

main();
