'use strict';
const fs = require('fs');
const fsp = fs.promises;

const ALWAYS_SKIP = new Set([
  '$recycle.bin', 'system volume information', '$winreagent',
  'config.msi', 'recovery', '$sysreset'
]);

const MAX_DEPTH = 64;

function driveInfo(p) {
  const root = p.endsWith('\\') ? p : p + '\\';
  try {
    const st = fs.statfsSync(root);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { root, total, used: total - free, free };
  } catch {
    return { root, total: 0, used: 0, free: 0 };
  }
}

async function scanDrive(scope, opts, emit) {
  const info = driveInfo(scope);
  const root = info.root;
  const maxFiles = opts.maxFiles || 1500000;
  const userSkip = new Set((opts.skipDirs || []).map(s => String(s).toLowerCase()));

  const files = [];
  let dirs = 0;
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  let denied = 0;
  let depthLimited = 0;
  const t0 = Date.now();
  let lastEmit = 0;
  let curDir = '';

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    if (scanned >= maxFiles) { truncated = true; break; }
    const { dir, depth } = stack.pop();
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      denied++;
      continue;
    }
    dirs++;
    curDir = dir;

    const filePaths = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const full = dir + e.name;
      if (e.isDirectory()) {
        const low = e.name.toLowerCase();
        if (ALWAYS_SKIP.has(low) || userSkip.has(low)) continue;
        if (depth + 1 > MAX_DEPTH) { depthLimited++; continue; }
        stack.push({ dir: full + '\\', depth: depth + 1 });
      } else if (e.isFile()) {
        filePaths.push(full);
      }
    }

    const CONC = 32;
    for (let i = 0; i < filePaths.length; i += CONC) {
      const chunk = filePaths.slice(i, i + CONC);
      const sts = await Promise.all(chunk.map(async f => {
        try {
          const st = await fsp.stat(f);
          return st.isFile() ? { f, st } : null;
        } catch { return null; }
      }));
      for (const r of sts) {
        if (!r) { denied++; continue; }
        files.push({
          p: r.f.substring(root.length),
          s: r.st.size,
          m: r.st.mtimeMs,
          a: r.st.atimeMs,
          b: r.st.birthtimeMs
        });
        scanned++;
        bytes += r.st.size;
      }
      const now = Date.now();
      if (emit && now - lastEmit > 350) {
        lastEmit = now;
        emit({ scanned, dirs, bytes, current: curDir });
      }
    }
  }

  if (emit) emit({ scanned, dirs, bytes, current: curDir, done: true });
  return {
    root, files, dirs, scanned, bytes, truncated, denied, depthLimited,
    durationMs: Date.now() - t0,
    diskTotal: info.total, diskUsed: info.used, diskFree: info.free
  };
}

function topDirOf(relPath) {
  const i = relPath.indexOf('\\');
  return i > 0 ? relPath.substring(0, i) : relPath;
}

function extOf(relPath) {
  const base = relPath.substring(relPath.lastIndexOf('\\') + 1);
  const i = base.lastIndexOf('.');
  if (i <= 0) return '(无扩展名)';
  const e = base.substring(i).toLowerCase();
  return e.length > 12 ? '(其他)' : e;
}

function ageBucket(days) {
  if (days < 30) return '30 天内';
  if (days < 180) return '1-6 个月';
  if (days < 365) return '6-12 个月';
  if (days < 730) return '1-2 年';
  return '2 年以上';
}

module.exports = { scanDrive, driveInfo, topDirOf, extOf, ageBucket };
