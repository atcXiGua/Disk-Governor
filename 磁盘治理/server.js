'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const { scanDrive, driveInfo } = require('./lib/scan');
const { classify, prepare, TIER_META, TIER_ORDER } = require('./lib/classify');
const { findDuplicates, findSimilar } = require('./lib/dedupe');
const { buildReport, fmtBytes } = require('./lib/report');
const { Planner } = require('./lib/plan');
const { atimeState, anyRunning } = require('./lib/procs');

const ROOT = __dirname;
const UI = path.join(ROOT, 'ui.html');
const CFG_PATH = path.join(ROOT, 'config.json');
const HIST_PATH = path.join(ROOT, 'history.json');
const PORT_BASE = 7790;

let config = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
if (!config.backupRoot) config.backupRoot = 'D:\\磁盘治理备份';
if (!Array.isArray(config.disabledRules)) config.disabledRules = [];

const planner = new Planner(config);
const jobs = new Map();
const reports = new Map();
const plans = new Map();

function saveConfig() {
  fs.writeFileSync(CFG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); } catch { return []; }
}
function pushHistory(rec) {
  const list = readHistory();
  list.unshift(rec);
  try { fs.writeFileSync(HIST_PATH, JSON.stringify(list.slice(0, 50), null, 2), 'utf8'); } catch {}
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function body(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

function normScope(s) {
  if (!s) return config.scope;
  let p = String(s).trim().replace(/\//g, '\\');
  if (/^[A-Za-z]:$/.test(p)) p += '\\';
  if (!p.endsWith('\\')) p += '\\';
  return p;
}

async function runJob(job, scope, deep) {
  try {
    job.phase = 'scan';
    job.scope = scope;
    job.startedAt = Date.now();

    const info = driveInfo(scope);
    if (!info.total) {
      job.error = '无法读取该路径所在磁盘：' + scope;
      job.done = true;
      return;
    }

    const detail = await scanDrive(scope, {
      maxFiles: config.thresholds.maxFiles,
      skipDirs: config.skipDirs
    }, (p) => {
      job.scanned = p.scanned;
      job.dirs = p.dirs;
      job.bytes = p.bytes;
      job.current = p.current;
    });

    job.phase = 'classify';
    const at = atimeState();
    const ctx = {
      root: detail.root,
      now: Date.now(),
      th: config.thresholds,
      rules: prepare(config),
      isSystem: /^[A-Za-z]:\\$/.test(scope),
      useAtime: at.reliable === true,
      atime: at
    };
    const classified = classify(detail.files, ctx, 400);
    job.classified = classified.length;

    const fileIndex = new Map();
    for (const f of detail.files) {
      let arr = fileIndex.get(f.c);
      if (!arr) { arr = []; fileIndex.set(f.c, arr); }
      arr.push(f);
    }

    let dup = { groups: [], wastedBytes: 0, groupCount: 0 };
    if (deep) {
      job.phase = 'dup';
      job.dupDone = 0;
      dup = await findDuplicates(detail.files, detail.root, config.thresholds, (p) => {
        job.dupDone = p.done;
        job.dupTotal = p.total;
      });
    }

    job.phase = 'similar';
    const similar = findSimilar(detail.files, detail.root, config.thresholds);

    job.phase = 'report';
    const report = buildReport(detail, ctx, classified, dup, similar);

    const rid = 'r' + Date.now().toString(36);
    reports.set(rid, { rid, report, classified, fileIndex, root: detail.root, createdAt: Date.now() });
    while (reports.size > 3) reports.delete(reports.keys().next().value);

    job.reportId = rid;
    job.summary = {
      files: detail.scanned,
      bytes: detail.bytes,
      durationMs: Date.now() - job.startedAt,
      deep,
      reclaimable: report.estimate.reclaimableBytes,
      l1: report.estimate.l1Bytes,
      l2: report.estimate.l2Bytes,
      l3: report.estimate.l3Bytes,
      dupWasted: report.duplicates.wastedBytes
    };
    job.phase = 'done';
    job.done = true;
    job.elapsed = Date.now() - job.startedAt;
  } catch (e) {
    job.error = String(e && e.stack || e);
    job.done = true;
    job.phase = 'error';
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(UI);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }

    if (p === '/api/health') {
      return json(res, 200, { ok: true, scope: config.scope, version: 2 });
    }

    if (p === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        ok: true, config, tiers: TIER_META, tierOrder: TIER_ORDER,
        drives: listDrives(), atime: atimeState()
      });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const b = await body(req);
      if (Array.isArray(b.whitelist)) config.whitelist = b.whitelist.filter(x => typeof x === 'string');
      if (Array.isArray(b.exclude)) config.exclude = b.exclude.filter(x => typeof x === 'string');
      if (Array.isArray(b.disabledRules)) config.disabledRules = b.disabledRules.filter(x => typeof x === 'string');
      if (b.backupRoot && typeof b.backupRoot === 'string') config.backupRoot = b.backupRoot;
      if (b.thresholds && typeof b.thresholds === 'object') {
        for (const k of Object.keys(config.thresholds)) {
          const v = Number(b.thresholds[k]);
          if (Number.isFinite(v) && v >= 0) config.thresholds[k] = v;
        }
      }
      saveConfig();
      planner.reload(config);
      return json(res, 200, { ok: true, config });
    }

    if (p === '/api/strategy') {
      return json(res, 200, {
        ok: true,
        tiers: TIER_META,
        tierOrder: TIER_ORDER,
        rules: (config.rules || []).map(r => ({
          id: r.id, name: r.name, tier: r.tier, kind: r.kind,
          regenerable: r.regenerable === true,
          selectable: r.selectable !== false && r.kind === 'clean' && r.tier !== 'L0' && r.tier !== 'L3',
          requires: r.requires || {},
          basis: r.basis, advice: r.advice,
          disabled: (config.disabledRules || []).indexOf(r.id) >= 0
        })),
        thresholdKeys: config.thresholds
      });
    }

    if (p === '/api/scan' && req.method === 'POST') {
      const b = await body(req);
      const scope = normScope(b.scope);
      if (!/^[A-Za-z]:\\/.test(scope) && !/^\\\\/.test(scope)) {
        return json(res, 400, { ok: false, error: '请传入合法的盘符或绝对路径' });
      }
      const jobId = 'j' + Date.now().toString(36);
      const job = { jobId, phase: 'queued', done: false, scanned: 0, dirs: 0, bytes: 0, current: '' };
      jobs.set(jobId, job);
      while (jobs.size > 12) jobs.delete(jobs.keys().next().value);
      runJob(job, scope, !!b.deep);
      return json(res, 200, { ok: true, jobId });
    }

    if (p.startsWith('/api/job/')) {
      const job = jobs.get(p.split('/').pop());
      if (!job) return json(res, 404, { ok: false, error: '任务不存在' });
      return json(res, 200, Object.assign({ ok: true }, job));
    }

    if (p === '/api/report') {
      const rec = reports.get(url.searchParams.get('id'));
      if (!rec) return json(res, 404, { ok: false, error: '报告已过期，请重新扫描' });
      return json(res, 200, { ok: true, report: rec.report });
    }

    if (p === '/api/recheck' && req.method === 'POST') {
      const b = await body(req);
      const rec = reports.get(b.reportId);
      if (!rec) return json(res, 404, { ok: false, error: '报告已过期，请重新扫描' });
      let changed = 0;
      for (const c of rec.classified) {
        const rq = c.requires || {};
        if (!rq.noProcess || !rq.noProcess.length) continue;
        const r = anyRunning(rq.noProcess, true);
        const met = !r.blocked;
        if (met !== c.requiresMet) changed++;
        c.requiresMet = met;
        c.blockReason = met ? null : '进程 ' + r.names.join('、') + ' 正在运行，本轮跳过';
        c.selectable = c.baseSelectable && met;
        c.evidence = c.evidenceCore + ' · ' + (met ? '前置条件满足' : '前置条件不满足 → ' + c.blockReason);
      }
      const cats = rec.classified;
      const nowB = cats.filter(c => c.selectable).reduce((s, c) => s + c.bytes, 0);
      const pendB = cats.filter(c => c.baseSelectable && !c.requiresMet).reduce((s, c) => s + c.bytes, 0);
      Object.assign(rec.report.estimate, {
        nowBytes: nowB, nowHuman: fmtBytes(nowB),
        pendingBytes: pendB, pendingHuman: fmtBytes(pendB)
      });
      rec.report.categories = cats;
      return json(res, 200, {
        ok: true, changed,
        nowHuman: fmtBytes(nowB), pendingHuman: fmtBytes(pendB),
        estimate: rec.report.estimate
      });
    }

    if (p === '/api/plan' && req.method === 'POST') {
      const b = await body(req);
      const rec = reports.get(b.reportId);
      if (!rec) return json(res, 404, { ok: false, error: '报告已过期，请重新扫描' });
      const ids = Array.isArray(b.categories) ? b.categories : [];
      if (!ids.length) return json(res, 400, { ok: false, error: '请至少选择一个可清理类目' });

      const plan = planner.build({ root: rec.root, classified: rec.classified, fileIndex: rec.fileIndex }, ids);

      if (!plan.totalCount) {
        return json(res, 400, {
          ok: false,
          error: '所选类目没有可清理的文件',
          rejected: plan.rejected,
          blockedCount: plan.blocked.length
        });
      }
      if (plan.oversize && b.force !== true) {
        return json(res, 413, {
          ok: false,
          error: `本次清单 ${fmtBytes(plan.totalBytes)}，超过单次上限 ${fmtBytes(plan.maxBytes)}。请分阶段执行，或传 force: true 明确确认`,
          oversize: true, totalBytes: plan.totalBytes, maxBytes: plan.maxBytes
        });
      }

      plans.set(plan.planId, { plan, createdAt: Date.now() });
      while (plans.size > 8) plans.delete(plans.keys().next().value);

      const preview = plan.items.slice(0, 500).map(i => ({
        path: i.path, size: i.size, tier: i.tier, catName: i.catName, days: i.days, why: i.why
      }));
      return json(res, 200, {
        ok: true, planId: plan.planId, scope: plan.scope,
        totalBytes: plan.totalBytes, totalCount: plan.totalCount,
        byCat: plan.byCat, rejected: plan.rejected,
        blockedCount: plan.blocked.length,
        blocked: plan.blocked.slice(0, 60),
        items: preview,
        truncated: plan.items.length > preview.length,
        backupRoot: config.backupRoot
      });
    }

    if (p === '/api/clean' && req.method === 'POST') {
      const b = await body(req);
      const rec = plans.get(b.planId);
      if (!rec) return json(res, 404, { ok: false, error: '清单已过期，请重新生成' });
      const mode = b.mode === 'move' ? 'move' : 'dryrun';
      if (mode === 'move' && b.confirm !== true) {
        return json(res, 400, { ok: false, error: '执行移动需要显式确认（confirm: true）' });
      }
      const result = await planner.apply(rec.plan, config.backupRoot, mode);
      result.ok = true;
      if (mode === 'move' && result.moved) {
        pushHistory({
          at: new Date().toISOString(),
          scope: rec.plan.scope,
          moved: result.moved,
          failed: result.failed,
          freed: result.freed,
          freedHuman: fmtBytes(result.freed),
          backup: result.backup,
          cats: rec.plan.byCat.map(c => c.name),
          freeAfter: result.freeAfter,
          freeAfterHuman: fmtBytes(result.freeAfter)
        });
      }
      return json(res, 200, result);
    }

    if (p === '/api/history') {
      return json(res, 200, { ok: true, list: readHistory() });
    }

    if (p === '/api/open' && req.method === 'POST') {
      const b = await body(req);
      if (typeof b.path === 'string' && b.path) {
        spawn('explorer.exe', [b.path], { detached: true, windowsHide: true }).unref();
      }
      return json(res, 200, { ok: true });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    json(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

function listDrives() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const letter = String.fromCharCode(c) + ':';
    try {
      const st = fs.statfsSync(letter + '\\');
      if (st.blocks > 0) out.push({ id: letter, total: st.blocks * st.bsize, free: st.bavail * st.bsize });
    } catch {}
  }
  return out;
}

function listen(port, attempt = 0) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && attempt < 10) return listen(port + 1, attempt + 1);
    console.error('start failed:', e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const u = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  Disk Governor v2 started');
    console.log('  ' + u);
    console.log('');
    console.log('  Close this window to stop.');
    console.log('');
    if (!process.env.DISKGOV_NO_OPEN) {
      spawn('cmd.exe', ['/c', 'start', '', u], { detached: true, windowsHide: true }).unref();
    }
  });
}

listen(PORT_BASE);
