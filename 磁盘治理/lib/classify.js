'use strict';
const { anyRunning } = require('./procs');

const DAY = 86400000;
const HOUR = 3600000;

const TIER_ORDER = ['L1', 'L2', 'L3', 'L0'];

const TIER_META = {
  L0: {
    label: '禁动',
    risk: 'protected',
    desc: '删了会导致系统或程序损坏，或属于唯一数据副本。工具只报告，永不清除'
  },
  L1: {
    label: '可再生·零代价',
    risk: 'safe',
    desc: '程序或网络可以完整重建，重建过程用户基本无感知'
  },
  L2: {
    label: '可再生·有代价',
    risk: 'caution',
    desc: '能重建，但要重新下载、重建索引或丢失历史，需要逐项确认'
  },
  L3: {
    label: '仅迁移',
    risk: 'migrate',
    desc: '不可再生。只能移到其他盘，绝不能删除'
  }
};

const OTHER = {
  id: 'other', name: '常规文件', tier: 'L3', kind: 'other',
  regenerable: false, selectable: false,
  basis: '未命中任何规则', advice: '不在清理范围内，仅用于统计'
};

function normKey(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function segmentsOf(key) {
  return key.split('/').filter(Boolean);
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  const e = name.substring(i).toLowerCase();
  return e.length > 12 ? '' : e;
}

function resolveVal(v, th) {
  if (typeof v === 'string' && v[0] === '@') {
    const n = Number(th[v.slice(1)]);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasSeg(c, seg) {
  for (const s of c.segs) if (s === seg) return true;
  return false;
}

const RE_CACHE = new Map();
function reOf(p) {
  let r = RE_CACHE.get(p);
  if (!r) { r = new RegExp(p, 'i'); RE_CACHE.set(p, r); }
  return r;
}

function testMatch(m, c) {
  if (!m) return false;
  if (m.any) {
    let ok = false;
    for (const sub of m.any) { if (testMatch(sub, c)) { ok = true; break; } }
    if (!ok) return false;
  }
  if (m.pathAny && !m.pathAny.some(s => c.key.indexOf(s) >= 0)) return false;
  if (m.pathAll && !m.pathAll.every(s => c.key.indexOf(s) >= 0)) return false;
  if (m.notPathAny && m.notPathAny.some(s => c.key.indexOf(s) >= 0)) return false;
  if (m.segAny && !m.segAny.some(s => hasSeg(c, s))) return false;
  if (m.segEndsWith && !m.segEndsWith.some(s => c.segs.some(g => g.endsWith(s)))) return false;
  if (m.ext && m.ext.indexOf(c.ext) < 0) return false;
  if (m.nameRegex && !reOf(m.nameRegex).test(c.name)) return false;
  return true;
}

function fmtHours(h) {
  if (h == null) return '';
  if (h < 48) return Math.round(h) + ' 小时';
  return Math.round(h / 24) + ' 天';
}

function evalRequires(rule, f, ctx) {
  const r = rule.requires || {};
  const minH = resolveVal(r.minAgeHours, ctx.th);
  const minD = resolveVal(r.minAgeDays, ctx.th);
  const lastTouch = ctx.useAtime ? Math.max(f.m, f.a || 0) : f.m;
  const ageH = (ctx.now - lastTouch) / HOUR;

  let ageFail = false;
  if (minH != null && ageH < minH) ageFail = true;
  if (minD != null && ageH < minD * 24) ageFail = true;

  let procBlock = null;
  if (r.noProcess && r.noProcess.length) {
    const p = anyRunning(r.noProcess, ctx.forceProc);
    if (p.blocked) procBlock = { names: p.names, unknown: false };
    else if (p.unknown) procBlock = null;
  }
  return { ageFail, procBlock, ageH, minH, minD };
}

function prepare(config) {
  const disabled = new Set(config.disabledRules || []);
  return (config.rules || [])
    .filter(r => r && r.id && !disabled.has(r.id))
    .map(r => Object.assign({}, r, {
      tier: r.tier || 'L2',
      kind: r.kind || 'clean',
      regenerable: r.regenerable === true
    }));
}

function classify(files, ctx, topN) {
  topN = topN || 400;
  const rules = ctx.rules || [];
  const map = new Map();

  for (const f of files) {
    const abs = ctx.root + f.p;
    const key = normKey(abs);
    const name = f.p.substring(f.p.lastIndexOf('\\') + 1) || f.p;
    const c = { key, segs: segmentsOf(key), name, ext: extOf(name), re: null };

    let hit = null;
    let blockReason = null;

    for (const rule of rules) {
      if (rule.scope === 'system' && !ctx.isSystem) continue;
      if (!testMatch(rule.match, c)) continue;
      const rq = evalRequires(rule, f, ctx);
      if (rq.procBlock) {
        hit = rule;
        blockReason = '进程 ' + rq.procBlock.names.join('、') + ' 正在运行，本轮跳过';
        break;
      }
      if (rq.ageFail) continue;
      hit = rule;
      break;
    }

    if (!hit) hit = OTHER;
    f.c = hit.id;

    let g = map.get(hit.id);
    if (!g) {
      g = {
        rule: hit, bytes: 0, count: 0, items: [],
        requiresMet: !blockReason, blockReason: blockReason || null
      };
      map.set(hit.id, g);
    }
    g.bytes += f.s;
    g.count++;
    if (blockReason && g.requiresMet) { g.requiresMet = false; g.blockReason = blockReason; }
    if (hit.kind !== 'other') {
      g.items.push(f);
      if (g.items.length > topN * 3) {
        g.items.sort((x, y) => y.s - x.s);
        g.items.length = topN;
      }
    }
  }

  const out = [];
  for (const [id, g] of map) {
    if (id === 'other') continue;
    const rule = g.rule;
    const meta = TIER_META[rule.tier] || TIER_META.L2;
    g.items.sort((x, y) => y.s - x.s);
    const items = g.items.slice(0, topN).map(f => {
      const lastTouch = ctx.useAtime ? Math.max(f.m, f.a || 0) : f.m;
      return {
        path: ctx.root + f.p,
        rel: f.p,
        size: f.s,
        mtime: f.m,
        days: Math.floor((ctx.now - lastTouch) / DAY),
        why: rule.id + ' · ' + rule.tier + ' · 最后活动 ' + Math.floor((ctx.now - lastTouch) / DAY) + ' 天前'
      };
    });

    const baseSelectable = rule.selectable !== false &&
      rule.kind === 'clean' &&
      rule.regenerable === true &&
      (rule.tier === 'L1' || rule.tier === 'L2');
    const selectable = baseSelectable && g.requiresMet;

    const ev = ['规则 ' + rule.id, meta.label];
    const reqParts = [];
    const minH = resolveVal((rule.requires || {}).minAgeHours, ctx.th);
    const minD = resolveVal((rule.requires || {}).minAgeDays, ctx.th);
    if (minH != null) reqParts.push('最后活动 ≥ ' + fmtHours(minH));
    if (minD != null) reqParts.push('最后活动 ≥ ' + minD + ' 天');
    if ((rule.requires || {}).noProcess) reqParts.push('进程 ' + rule.requires.noProcess.join('/') + ' 未运行');
    if (reqParts.length) ev.push(reqParts.join(' 且 '));
    const evidenceCore = ev.join(' · ');
    ev.push(g.requiresMet ? '前置条件满足' : '前置条件不满足 → ' + g.blockReason);

    out.push({
      id,
      name: rule.name,
      tier: rule.tier,
      tierLabel: meta.label,
      risk: meta.risk,
      kind: rule.kind,
      regenerable: rule.regenerable,
      baseSelectable,
      selectable,
      basis: rule.basis,
      advice: rule.advice,
      evidence: ev.join(' · '),
      evidenceCore,
      bytes: g.bytes,
      count: g.count,
      items,
      truncated: g.count > items.length,
      requiresMet: g.requiresMet,
      blockReason: g.blockReason,
      requires: rule.requires || {}
    });
  }

  out.sort((a, b) => {
    const t = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
    return t !== 0 ? t : b.bytes - a.bytes;
  });
  return out;
}

module.exports = {
  classify, prepare, TIER_META, TIER_ORDER, OTHER, normKey, extOf, fmtHours
};
