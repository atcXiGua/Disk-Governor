'use strict';
const fsp = require('fs').promises;
const crypto = require('crypto');

const HEAD_BYTES = 128 * 1024;
const RISKY_SEG = ['temp', 'tmp', 'downloads', 'appdata\\local\\temp'];

async function hashFile(absPath, limit) {
  const h = crypto.createHash('md5');
  let fh;
  try {
    fh = await fsp.open(absPath, 'r');
    const buf = Buffer.allocUnsafe(1024 * 512);
    let read = 0;
    while (true) {
      const want = limit ? Math.min(buf.length, limit - read) : buf.length;
      if (want <= 0) break;
      const { bytesRead } = await fh.read(buf, 0, want, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
      read += bytesRead;
      if (limit && read >= limit) break;
    }
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return h.digest('hex');
}

function riskScore(rel) {
  const low = rel.toLowerCase();
  let s = 0;
  for (const seg of RISKY_SEG) if (low.indexOf('\\' + seg + '\\') >= 0) s += 2;
  s += (low.match(/\\/g) || []).length * 0.01;
  return s;
}

// 保留建议：先排除「临时/下载」这类本来就会被清的位置，再留修改时间最早的那份（通常是原件）
function suggestKeep(entries) {
  let best = 0;
  let bestScore = Infinity;
  entries.forEach((e, i) => {
    const score = riskScore(e.rel) + (e.mtime / 1e13);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

async function findDuplicates(files, root, th, onProgress) {
  const minSize = (th.dupMinMB || 1) * 1048576;
  const maxGroup = th.dupMaxGroupSize || 12;

  const bySize = new Map();
  for (const f of files) {
    if (f.s < minSize) continue;
    let arr = bySize.get(f.s);
    if (!arr) { arr = []; bySize.set(f.s, arr); }
    arr.push(f);
  }

  const candidates = [];
  for (const [size, arr] of bySize) {
    if (arr.length < 2) continue;
    if (arr.length > 60) continue;
    candidates.push({ size, arr });
  }
  candidates.sort((a, b) => b.size * b.arr.length - a.size * a.arr.length);

  const groups = [];
  let done = 0;
  for (const c of candidates) {
    done++;
    if (onProgress && done % 5 === 0) {
      onProgress({ phase: 'dup', done, total: candidates.length, groups: groups.length });
    }
    const stage1 = new Map();
    for (const f of c.arr) {
      const h = await hashFile(root + f.p, HEAD_BYTES);
      if (!h) continue;
      let a = stage1.get(h);
      if (!a) { a = []; stage1.set(h, a); }
      a.push(f);
    }
    for (const [, arr] of stage1) {
      if (arr.length < 2) continue;
      let finalGroups;
      if (c.size <= HEAD_BYTES * 2) {
        finalGroups = [arr];
      } else {
        const stage2 = new Map();
        for (const f of arr.slice(0, maxGroup)) {
          const h = await hashFile(root + f.p, 0);
          if (!h) continue;
          let a = stage2.get(h);
          if (!a) { a = []; stage2.set(h, a); }
          a.push(f);
        }
        finalGroups = [...stage2.values()].filter(a => a.length > 1);
      }
      for (const g of finalGroups) {
        const entries = g.map(f => ({
          path: root + f.p,
          rel: f.p,
          size: f.s,
          mtime: f.m,
          days: Math.floor((Date.now() - f.m) / 86400000)
        })).sort((x, y) => y.days - x.days);
        const keepIdx = suggestKeep(entries);
        groups.push({
          size: c.size,
          count: entries.length,
          wasted: c.size * (entries.length - 1),
          keep: entries[keepIdx].path,
          files: entries,
          note: '保留建议仅供参考：已优先排除 Temp/Downloads 中的副本，保留修改时间最早的一份'
        });
      }
    }
  }

  groups.sort((a, b) => b.wasted - a.wasted);
  const wastedBytes = groups.reduce((s, g) => s + g.wasted, 0);
  return { groups, wastedBytes, groupCount: groups.length, autoClean: false };
}

const NOISE = [
  /[（(]\s*\d+\s*[)）]/g,
  /[-_ ]?(副本|copy|备份|backup)\s*\d*/gi,
  /\b(final|最新|new|old|旧|新)\b/gi,
  /[_\-\s]?\d{8}/g,
  /[_\-\s]?\d{4}[-_.]\d{1,2}[-_.]\d{1,2}/g,
  /\s+/g
];

function normalizeName(fileName) {
  let base = fileName.toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.substring(0, dot);
  for (const n of NOISE) base = base.replace(n, '');
  base = base.replace(/[-_]{2,}/g, '_').replace(/^[-_]+|[-_]+$/g, '');
  return base;
}

function findSimilar(files, root, th) {
  const minCount = th.similarMinCount || 3;
  const minTotal = (th.similarMinMB || 20) * 1048576;
  const map = new Map();

  for (const f of files) {
    if (f.s < 1024) continue;
    const base = f.p.substring(f.p.lastIndexOf('\\') + 1);
    const key = normalizeName(base);
    if (!key || key.length < 3) continue;
    let g = map.get(key);
    if (!g) { g = []; map.set(key, g); }
    g.push(f);
  }

  const groups = [];
  for (const [key, arr] of map) {
    if (arr.length < minCount) continue;
    const total = arr.reduce((s, f) => s + f.s, 0);
    if (total < minTotal) continue;
    groups.push({
      key,
      count: arr.length,
      totalBytes: total,
      files: arr.sort((a, b) => b.s - a.s).slice(0, 20).map(f => ({
        path: root + f.p,
        rel: f.p,
        size: f.s,
        mtime: f.m,
        days: Math.floor((Date.now() - f.m) / 86400000)
      }))
    });
  }
  groups.sort((a, b) => b.totalBytes - a.totalBytes);
  return groups.slice(0, 40);
}

module.exports = { findDuplicates, findSimilar, normalizeName };
