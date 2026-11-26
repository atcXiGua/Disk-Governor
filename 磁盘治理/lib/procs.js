'use strict';
const { execSync } = require('child_process');

let procCache = { at: 0, ok: false, names: new Set() };
let atimeCache = null;

function pname(s) {
  return String(s || '').trim().toLowerCase();
}

function listProcesses(force) {
  const now = Date.now();
  if (!force && procCache.at && now - procCache.at < 3000) return procCache;
  if (process.env.DISKGOV_NO_PROC === '1') {
    procCache = { at: now, ok: true, names: new Set() };
    return procCache;
  }
  try {
    const out = execSync('tasklist /FO CSV /NH', {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 16 * 1024 * 1024
    });
    const names = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line || line[0] !== '"') continue;
      const end = line.indexOf('","');
      if (end < 0) continue;
      names.add(pname(line.slice(1, end)));
    }
    procCache = { at: now, ok: true, names };
  } catch (e) {
    procCache = { at: now, ok: false, names: new Set(), error: String(e && e.message || e) };
  }
  return procCache;
}

function anyRunning(list, force) {
  if (!list || !list.length) return { blocked: false, names: [], unknown: false };
  const p = listProcesses(force);
  if (!p.ok) return { blocked: false, names: [], unknown: true };
  const hit = list.filter(n => p.names.has(pname(n)));
  return { blocked: hit.length > 0, names: hit, unknown: false };
}

// Windows 默认关闭「最后访问时间」更新，此时 atime 不可信，年龄只能按 mtime 算
function atimeState() {
  if (atimeCache) return atimeCache;
  let disabled = null;
  try {
    const out = execSync('fsutil behavior query disablelastaccess', {
      encoding: 'utf8', windowsHide: true, timeout: 4000
    });
    const m = out.match(/=\s*(\d)/);
    if (m) disabled = m[1] !== '0';
  } catch { disabled = null; }
  atimeCache = {
    disabled,
    reliable: disabled === false,
    note: disabled === true
      ? '系统已关闭最后访问时间更新，年龄按修改时间计算'
      : disabled === false
        ? '最后访问时间可用，年龄取修改与访问时间中较新者'
        : '无法查询访问时间策略，年龄按修改时间计算'
  };
  return atimeCache;
}

module.exports = { listProcesses, anyRunning, atimeState };
