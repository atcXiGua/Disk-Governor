'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { anyRunning } = require('./procs');

function globToRe(pattern) {
  const p = String(pattern).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp('^' + out + '$', 'i');
}

function compileRules(patterns) {
  return (patterns || []).map(p => ({ src: p, re: globToRe(p) }));
}

function matchedBy(rules, absPath) {
  for (const r of rules) {
    if (r.re.test(absPath)) return r.src;
  }
  return null;
}

function normAbs(p) {
  return String(p).replace(/\\/g, '/');
}

const TIER_LABEL = { L0: 'L0 禁动', L1: 'L1 可再生', L2: 'L2 有代价', L3: 'L3 仅迁移' };

class Planner {
  constructor(config) {
    this.cfg = config;
    this.wl = compileRules(config.whitelist);
    this.ex = compileRules(config.exclude);
  }

  reload(config) {
    this.cfg = config;
    this.wl = compileRules(config.whitelist);
    this.ex = compileRules(config.exclude);
  }

  check(absPath, cat) {
    const abs = normAbs(absPath);
    if (cat && cat.tier === 'L0') return { block: true, reason: 'L0 禁动区域，策略禁止文件级删除' };
    if (cat && cat.tier === 'L3') return { block: true, reason: 'L3 不可再生，只允许迁移' };
    const w = matchedBy(this.wl, abs);
    if (w) return { block: true, reason: '命中白名单：' + w };
    const e = matchedBy(this.ex, abs);
    if (e) return { block: true, reason: '命中排除规则：' + e };
    return { block: false };
  }

  build(scan, ids) {
    const catMap = new Map(scan.classified.map(c => [c.id, c]));
    const want = Array.isArray(ids) ? ids : [];
    const items = [];
    const blocked = [];
    const rejected = [];
    const byCat = [];
    const catRequires = {};

    for (const id of want) {
      const cat = catMap.get(id);
      if (!cat) { rejected.push({ id, reason: '报告中没有该类目' }); continue; }
      if (cat.tier === 'L0') { rejected.push({ id, name: cat.name, reason: TIER_LABEL.L0 + '，不允许进入清理清单' }); continue; }
      if (cat.tier === 'L3' || cat.kind === 'migrate') { rejected.push({ id, name: cat.name, reason: TIER_LABEL.L3 + '，只能迁移不能删除' }); continue; }
      if (cat.kind === 'hold') { rejected.push({ id, name: cat.name, reason: '本轮不可清（文件仍热）' }); continue; }
      if (cat.regenerable !== true) { rejected.push({ id, name: cat.name, reason: '未声明可再生，策略禁止清理' }); continue; }
      if (cat.selectable === false) { rejected.push({ id, name: cat.name, reason: cat.blockReason || '该类目当前不可选' }); continue; }

      const proc = cat.requires && cat.requires.noProcess
        ? anyRunning(cat.requires.noProcess, true)
        : { blocked: false, names: [] };
      if (proc.blocked) {
        rejected.push({ id, name: cat.name, reason: '进程 ' + proc.names.join('、') + ' 正在运行' });
        continue;
      }

      const entry = { id, name: cat.name, tier: cat.tier, risk: cat.risk, bytes: 0, count: 0, blockedCount: 0 };
      catRequires[id] = (cat.requires && cat.requires.noProcess) ? cat.requires.noProcess.slice() : [];
      for (const f of scan.fileIndex.get(id) || []) {
        const abs = scan.root + f.p;
        const v = this.check(abs, cat);
        if (v.block) {
          blocked.push({ path: abs, size: f.s, reason: v.reason });
          entry.blockedCount++;
          continue;
        }
        const lastTouch = Math.max(f.m, f.a || 0);
        items.push({
          path: abs,
          size: f.s,
          cat: id,
          catName: cat.name,
          tier: cat.tier,
          risk: cat.risk,
          days: Math.floor((Date.now() - lastTouch) / 86400000),
          why: cat.id + ' · ' + cat.tier + ' · 最后活动 ' + Math.floor((Date.now() - lastTouch) / 86400000) + ' 天前'
        });
        entry.bytes += f.s;
        entry.count++;
      }
      if (entry.count || entry.blockedCount) byCat.push(entry);
    }

    const totalBytes = items.reduce((s, i) => s + i.size, 0);
    const maxBytes = Number(this.cfg.thresholds && this.cfg.thresholds.maxPlanBytes) || 0;

    return {
      planId: 'p' + Date.now().toString(36),
      createdAt: new Date().toISOString(),
      scope: scan.root,
      categories: want,
      items,
      blocked,
      rejected,
      byCat,
      catRequires,
      totalBytes,
      totalCount: items.length,
      oversize: maxBytes > 0 && totalBytes > maxBytes,
      maxBytes
    };
  }

  async exists(absPath) {
    try { await fsp.access(absPath, fs.constants.F_OK); return true; } catch { return false; }
  }

  async inUse(absPath) {
    let fh;
    try {
      fh = await fsp.open(absPath, 'r+');
      await fh.close();
      return false;
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') return true;
      return false;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  async dryRun(plan) {
    const res = {
      mode: 'dryrun', total: plan.items.length, bytes: 0,
      skippedGone: 0, skippedInUse: 0, skippedByProcess: 0,
      byCat: [], samples: []
    };
    const catAgg = new Map();
    for (const it of plan.items) {
      if (!(await this.exists(it.path))) { res.skippedGone++; continue; }
      const busy = await this.inUse(it.path);
      if (busy) { res.skippedInUse++; continue; }
      res.bytes += it.size;
      let a = catAgg.get(it.cat);
      if (!a) { a = { id: it.cat, name: it.catName, tier: it.tier, bytes: 0, count: 0 }; catAgg.set(it.cat, a); }
      a.bytes += it.size;
      a.count++;
      if (res.samples.length < 40) res.samples.push({ path: it.path, size: it.size, cat: it.catName });
    }
    res.byCat = [...catAgg.values()];
    res.freed = res.bytes;
    res.note = '试运行不移动任何文件，只做存在性与占用检测';
    return res;
  }

  async apply(plan, backupRoot, mode) {
    if (mode !== 'move') return this.dryRun(plan);

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dstRoot = path.join(backupRoot, stamp);
    const moved = [];
    const failed = [];
    const procSkipped = [];
    let bytes = 0;

    // 执行前按类目重新验一次进程条件，防止「生成清单时已退出、执行时又打开」
    const catBlocked = new Set();
    const catMap = new Map();
    for (const c of plan.byCat) catMap.set(c.id, c);
    for (const [id, c] of catMap) {
      const cat = plan.catRequires && plan.catRequires[id];
      if (cat && cat.length) {
        const p = anyRunning(cat, true);
        if (p.blocked) {
          catBlocked.add(id);
          procSkipped.push({ cat: id, reason: '进程 ' + p.names.join('、') + ' 正在运行' });
        }
      }
    }

    for (const it of plan.items) {
      if (catBlocked.has(it.cat)) { failed.push({ path: it.path, reason: '对应进程正在运行' }); continue; }
      const v = this.check(it.path, it);
      if (v.block) { failed.push({ path: it.path, reason: v.reason }); continue; }
      if (!(await this.exists(it.path))) { failed.push({ path: it.path, reason: '文件已不存在' }); continue; }
      if (await this.inUse(it.path)) { failed.push({ path: it.path, reason: '文件正被占用' }); continue; }

      const rel = it.path.replace(/^[A-Za-z]:\\/, '');
      const target = path.join(dstRoot, it.cat, rel);
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.rename(it.path, target);
      } catch (e) {
        if (e.code === 'EXDEV') {
          try {
            await fsp.copyFile(it.path, target);
            await fsp.unlink(it.path);
          } catch (e2) {
            failed.push({ path: it.path, reason: '跨卷移动失败：' + e2.code });
            continue;
          }
        } else {
          failed.push({ path: it.path, reason: '移动失败：' + e.code });
          continue;
        }
      }

      // 关键校验：只有源路径真的消失了，才计入成功
      if (await this.exists(it.path)) {
        failed.push({ path: it.path, reason: '源文件仍在原处，未计入' });
        continue;
      }
      moved.push({ src: it.path, dst: target, size: it.size, cat: it.cat });
      bytes += it.size;
    }

    if (moved.length) {
      const esc = s => '"' + String(s).replace(/"/g, '""') + '"';
      const csv = ['src,dst,bytes,cat']
        .concat(moved.map(m => [esc(m.src), esc(m.dst), m.size, esc(m.cat)].join(',')))
        .join('\r\n');
      await fsp.mkdir(dstRoot, { recursive: true });
      await fsp.writeFile(path.join(dstRoot, '_移动清单.csv'), '\uFEFF' + csv, 'utf8');
      await fsp.writeFile(path.join(dstRoot, '_还原.ps1'), restoreScript(), 'utf8');
    }

    let free = 0;
    try {
      const st = fs.statfsSync(plan.scope.endsWith('\\') ? plan.scope : plan.scope + '\\');
      free = st.bavail * st.bsize;
    } catch {}

    return {
      mode: 'move',
      moved: moved.length,
      failed: failed.length,
      failedList: failed.slice(0, 40),
      procSkipped,
      bytes,
      freed: bytes,
      backup: dstRoot,
      freeAfter: free,
      hasRestore: moved.length > 0
    };
  }
}

function restoreScript() {
  return '\uFEFF' +
`# 按 _移动清单.csv 把文件原样搬回
# 用法：右键 → 使用 PowerShell 运行
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csv = Import-Csv (Join-Path $here '_移动清单.csv')
$ok = 0; $bad = 0
foreach ($r in $csv) {
  if (Test-Path -LiteralPath $r.dst) {
    $dir = Split-Path -Parent $r.src
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Move-Item -LiteralPath $r.dst -Destination $r.src -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $r.src) { $ok++ } else { $bad++; Write-Host ("失败: " + $r.dst) }
  } else { $bad++ }
}
Write-Host ("还原完成：成功 " + $ok + " 个，失败 " + $bad + " 个")
`;
}

module.exports = { Planner, globToRe, matchedBy, restoreScript };
