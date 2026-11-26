'use strict';
const { topDirOf, extOf, ageBucket } = require('./scan');
const { TIER_META, TIER_ORDER } = require('./classify');

const DAY = 86400000;
const MB = 1048576;
const GB = 1073741824;

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 2) + ' ' + u[i];
}

const STAGE_SETS = [
  {
    stage: '一', title: '零风险项',
    ids: ['updater', 'temp', 'kernel_dump', 'app_crash_dumps', 'pkg_cache', 'thumbcache', 'inetcache', 'win_update'],
    action: '直接清，清了不影响任何功能'
  },
  {
    stage: '二', title: '客户端与浏览器缓存',
    ids: ['sodamusic_cache', 'wechat_cache', 'electron_cache', 'browser_cache', 'vscode_cache'],
    action: '先退出对应程序再清，重新打开会自行重建'
  },
  {
    stage: '三', title: '索引、日志与构建产物',
    ids: ['ide_cache', 'logs', 'cache_generic', 'build_output', 'old_installers'],
    action: '有重建代价，逐项确认后再清'
  }
];

function buildReport(detail, ctx, classified, dup, similar) {
  const files = detail.files;
  const now = ctx.now;

  const byTop = new Map();
  const byExt = new Map();
  const byAge = new Map();
  const tierOfCat = new Map();
  for (const c of classified) tierOfCat.set(c.id, c.tier);

  for (const f of files) {
    const t = topDirOf(f.p);
    byTop.set(t, (byTop.get(t) || 0) + f.s);
    const e = f.ext || extOf(f.p);
    byExt.set(e, (byExt.get(e) || 0) + f.s);
    const lastTouch = ctx.useAtime ? Math.max(f.m, f.a || 0) : f.m;
    byAge.set(ageBucket((now - lastTouch) / DAY), (byAge.get(ageBucket((now - lastTouch) / DAY)) || 0) + f.s);
  }

  const top = (map, n) => [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ key: k, bytes: v, human: fmtBytes(v) }));

  const tiers = TIER_ORDER.map(t => ({ tier: t, ...TIER_META[t], bytes: 0, count: 0, cats: [] }));
  const tierMap = new Map(tiers.map(t => [t.tier, t]));
  let l1 = 0, l2 = 0, l3 = 0, l0 = 0, hold = 0, nowBytes = 0, pendingBytes = 0;
  for (const c of classified) {
    const t = tierMap.get(c.tier);
    if (!t) continue;
    t.bytes += c.bytes;
    t.count += c.count;
    t.cats.push({ id: c.id, name: c.name, bytes: c.bytes, count: c.count, selectable: c.selectable });
    if (c.selectable) nowBytes += c.bytes;
    else if ((c.tier === 'L1' || c.tier === 'L2') && c.baseSelectable && !c.requiresMet) pendingBytes += c.bytes;
    if (c.tier === 'L1') l1 += c.bytes;
    else if (c.tier === 'L2') { l2 += c.bytes; if (c.kind === 'hold') hold += c.bytes; }
    else if (c.tier === 'L3') l3 += c.bytes;
    else l0 += c.bytes;
  }

  const catBytes = new Map(classified.map(c => [c.id, c.bytes]));
  const catMapById = new Map(classified.map(c => [c.id, c]));
  for (const t of tiers) t.human = fmtBytes(t.bytes);

  // 预算表：按策略文档的五个阶段，集合互斥，不会重复计数
  const budget = STAGE_SETS.map(s => {
    const bytes = s.ids.reduce((acc, id) => acc + (catBytes.get(id) || 0), 0);
    const hit = s.ids.filter(id => catBytes.get(id));
    const pend = s.ids.filter(id => {
      const c = catMapById.get(id);
      return c && !c.requiresMet;
    });
    const pendBytes = pend.reduce((acc, id) => acc + (catBytes.get(id) || 0), 0);
    return {
      stage: s.stage, title: s.title, action: s.action,
      ids: hit, bytes, human: fmtBytes(bytes),
      pendingIds: pend, pendingBytes: pendBytes, pendingHuman: fmtBytes(pendBytes),
      inTool: true
    };
  });
  budget.push({
    stage: '四', title: '系统组件清理',
    action: 'Dism /Online /Cleanup-Image /StartComponentCleanup（需管理员，不是文件级删除，工具不做）',
    ids: [], bytes: 0, human: '2–4 GB', estLow: 2 * GB, estHigh: 4 * GB,
    inTool: false, manual: true
  });
  budget.push({
    stage: '五', title: '迁移不可再生内容',
    action: '桌面/下载/微信文件改存储位置到 D 盘，右键属性→位置→移动',
    ids: [], bytes: l3, human: fmtBytes(l3),
    inTool: false, manual: true
  });

  let acc = detail.diskFree;
  for (const b of budget) {
    const add = b.manual ? (b.estLow != null ? b.estLow : b.bytes) : b.bytes;
    acc += add;
    b.freeAfter = acc;
    b.freeAfterHuman = fmtBytes(acc);
  }

  const bigFiles = files
    .filter(f => {
      if (f.s < ctx.th.bigFileMB * MB) return false;
      const t = tierOfCat.get(f.c);
      return !t || t === 'L3';
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map(f => {
      const lastTouch = ctx.useAtime ? Math.max(f.m, f.a || 0) : f.m;
      return {
        path: ctx.root + f.p, rel: f.p, size: f.s, human: fmtBytes(f.s),
        mtime: f.m, days: Math.floor((now - lastTouch) / DAY), cat: f.c
      };
    });

  const staleFiles = files
    .filter(f => {
      const lastTouch = ctx.useAtime ? Math.max(f.m, f.a || 0) : f.m;
      if ((now - lastTouch) / DAY < ctx.th.staleDays) return false;
      if (f.s < 10 * MB) return false;
      const t = tierOfCat.get(f.c);
      return !t || t === 'L3';
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map(f => {
      const lastTouch = ctx.useAtime ? Math.max(f.m, f.a || 0) : f.m;
      return {
        path: ctx.root + f.p, rel: f.p, size: f.s, human: fmtBytes(f.s),
        mtime: f.m, days: Math.floor((now - lastTouch) / DAY), cat: f.c
      };
    });

  // 处理顺序：L1 → L2 → 人工项，每一类一步
  const steps = [];
  let n = 1;
  for (const t of ['L1', 'L2']) {
    for (const c of classified.filter(x => x.tier === t).sort((a, b) => b.bytes - a.bytes)) {
      if (!c.bytes) continue;
      steps.push({
        step: n++, tier: c.tier, tierLabel: TIER_META[c.tier].label,
        category: c.name, risk: c.risk, bytes: c.bytes, human: fmtBytes(c.bytes),
        action: c.requiresMet ? c.advice : (c.blockReason || c.advice),
        selectable: c.selectable, manual: false
      });
    }
  }
  steps.push({
    step: n++, tier: 'L2', tierLabel: '人工', category: '系统组件清理', risk: 'caution',
    bytes: 0, human: '2–4 GB', manual: true,
    action: '管理员 PowerShell 执行 Dism /Online /Cleanup-Image /StartComponentCleanup；不要加 /ResetBase，加了无法回滚已装更新'
  });
  const migrate = classified.filter(x => x.tier === 'L3' && x.bytes);
  for (const c of migrate) {
    steps.push({
      step: n++, tier: 'L3', tierLabel: TIER_META.L3.label, category: c.name,
      risk: 'migrate', bytes: c.bytes, human: fmtBytes(c.bytes), manual: true,
      action: c.advice
    });
  }
  if (dup && dup.wastedBytes) {
    steps.push({
      step: n++, tier: 'L2', tierLabel: '人工', category: '完全重复文件', risk: 'caution',
      bytes: dup.wastedBytes, human: fmtBytes(dup.wastedBytes), manual: true,
      action: `共 ${dup.groupCount} 组。每组只保留一份，界面给了保留建议，但必须人工确认后自行处理`
    });
  }
  steps.push({
    step: n++, tier: 'L1', tierLabel: '验收', category: '观察 24 小时', risk: 'safe',
    bytes: 0, human: '—', manual: true,
    action: '清完先正常用一天，确认常用软件、登录态、IDE 都正常，再处理下一阶段。这一步不能跳过'
  });

  const reclaimable = l1 + l2 - hold;

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    scope: ctx.root,
    atime: ctx.atime || { note: '未检测' },
    probe: {
      durationMs: detail.durationMs,
      files: detail.scanned,
      dirs: detail.dirs,
      bytes: detail.bytes,
      scannedHuman: fmtBytes(detail.bytes),
      denied: detail.denied,
      depthLimited: detail.depthLimited || 0,
      truncated: detail.truncated,
      maxFiles: ctx.th.maxFiles
    },
    overview: {
      disk: {
        total: detail.diskTotal, used: detail.diskUsed, free: detail.diskFree,
        usedPct: detail.diskTotal ? +(detail.diskUsed / detail.diskTotal * 100).toFixed(1) : 0,
        freeHuman: fmtBytes(detail.diskFree), totalHuman: fmtBytes(detail.diskTotal)
      },
      scannedBytes: detail.bytes,
      scannedHuman: fmtBytes(detail.bytes),
      byTopDir: top(byTop, 10),
      byExt: top(byExt, 15),
      byAge: top(byAge, 6)
    },
    tiers,
    estimate: {
      l1Bytes: l1, l2Bytes: l2, l3Bytes: l3, l0Bytes: l0, holdBytes: hold,
      nowBytes, pendingBytes,
      reclaimableBytes: reclaimable,
      l1Human: fmtBytes(l1), l2Human: fmtBytes(l2), l3Human: fmtBytes(l3),
      l0Human: fmtBytes(l0), holdHuman: fmtBytes(hold),
      nowHuman: fmtBytes(nowBytes), pendingHuman: fmtBytes(pendingBytes),
      reclaimableHuman: fmtBytes(reclaimable),
      note: '可立即清理 = 当前所有前置条件都满足的 L1+L2；另有部分类目必须先关闭对应程序，单独统计'
    },
    categories: classified,
    budget,
    hints: {
      bigFiles,
      staleFiles,
      bigThresholdMB: ctx.th.bigFileMB,
      staleDays: ctx.th.staleDays,
      note: '「大文件」与「长期未用」只是线索，不是清理理由。已从清理候选集中剔除，只出现在这里供你判断'
    },
    duplicates: dup ? {
      wastedBytes: dup.wastedBytes,
      wastedHuman: fmtBytes(dup.wastedBytes),
      groupCount: dup.groupCount,
      autoClean: false,
      note: '重复文件不自动清理。哪份该留取决于内容，工具给的保留建议仅供参考',
      groups: dup.groups.slice(0, 40)
    } : { wastedBytes: 0, wastedHuman: '0 B', groupCount: 0, autoClean: false, groups: [], note: '未做深度扫描' },
    similar: {
      groups: similar || [],
      note: '相似文件名仅作合并提示，report_v2 与 report_v3 往往都要留，不建议整组删除'
    },
    order: steps,
    thresholds: ctx.th
  };
}

module.exports = { buildReport, fmtBytes };
