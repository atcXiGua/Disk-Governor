'use strict';
process.env.DISKGOV_NO_PROC = '1';

const fs = require('fs');
const path = require('path');
const { classify, prepare } = require('./lib/classify');
const { Planner } = require('./lib/plan');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const now = Date.now();
const H = 3600000;
const D = 86400000;

function file(rel, size, ageH) {
  return { p: rel, s: size, m: now - ageH * H, a: now - ageH * H };
}

const CASES = [
  ['Windows\\System32\\kernel32.dll', 'sys_core', '系统 DLL'],
  ['Windows\\WinSxS\\amd64\\abc.dll', 'sys_core', 'WinSxS'],
  ['Windows\\Installer\\5a3f.msi', 'sys_core', 'Installer 数据库'],
  ['Program Files\\SomeApp\\a.exe', 'program_files', '程序本体'],
  ['Program Files (x86)\\Steam\\steam.exe', 'program_files', 'x86 程序'],
  ['Windows\\System32\\DriverStore\\FileRepository\\nv\\a.sys', 'driver_store', '驱动仓库'],
  ['Users\\zoom\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Local Storage\\leveldb\\000003.log', 'browser_profile_data', 'Local Storage（含登录态）'],
  ['Users\\zoom\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies', 'browser_profile_data', 'Cookies'],
  ['Users\\zoom\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data', 'browser_profile_data', '保存的密码'],
  ['Users\\zoom\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\IndexedDB\\https_x.indexeddb.leveldb\\a.ldb', 'browser_profile_data', 'IndexedDB'],
  ['Users\\zoom\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_0001', 'browser_cache', '纯缓存'],
  ['Users\\zoom\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Service Worker\\CacheStorage\\abc', 'browser_cache', 'SW 缓存'],
  ['Users\\zoom\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache\\js\\a', 'browser_cache', 'Code Cache'],
  ['Users\\zoom\\Desktop\\note.txt', 'user_docs', '桌面'],
  ['Users\\zoom\\Documents\\report.docx', 'user_docs', '文档'],
  ['Users\\zoom\\.ssh\\id_rsa', 'key_secret', '私钥'],
  ['Users\\zoom\\WorkBuddy\\proj\\a.md', 'tool_data', '项目数据'],
  ['Users\\zoom\\AppData\\Local\\Temp\\old.tmp', 'temp', '100h 临时文件'],
  ['Users\\zoom\\AppData\\Local\\Temp\\new.tmp', 'temp_recent', '1h 临时文件'],
  ['Windows\\Temp\\x.tmp', 'temp', '系统 Temp'],
  ['Users\\zoom\\AppData\\Roaming\\SodaMusic\\LunaCacheV2\\a.mflac', 'sodamusic_cache', '音乐缓存'],
  ['Users\\zoom\\AppData\\Local\\JetBrains\\IntelliJIdea2023.2\\caches\\c.dat', 'ide_cache', 'IDEA 索引'],
  ['Users\\zoom\\AppData\\Local\\JetBrains\\IntelliJIdea2023.2\\config\\options\\a.xml', 'other', 'IDEA 配置（必须不动）'],
  ['Users\\zoom\\proj\\node_modules\\a\\b.js', 'build_output', '依赖目录'],
  ['Users\\zoom\\Downloads\\setup.exe', 'old_installers', '200 天的安装包'],
  ['Users\\zoom\\Downloads\\doc.pdf', 'user_docs', '下载的文档'],
  ['Users\\zoom\\AppData\\Local\\app-updater\\pending\\1.2.3.exe', 'updater', '更新器包'],
  ['Windows\\LiveKernelReports\\WATCHDOG-1.dmp', 'kernel_dump', '内核转储'],
  ['Users\\zoom\\AppData\\Local\\CrashDumps\\a.dmp', 'app_crash_dumps', '崩溃转储（>7天）'],
  ['Users\\zoom\\AppData\\Roaming\\Tencent\\xwechat\\msg\\file\\a.pdf', 'wechat_files', '聊天文件'],
  ['Users\\zoom\\AppData\\Roaming\\Tencent\\xwechat\\all_users\\config\\cache\\x.dat', 'wechat_cache', '微信缓存'],
  ['Windows\\SoftwareDistribution\\Download\\a.cab', 'win_update', '更新包'],
  ['Users\\zoom\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_256.db', 'thumbcache', '缩略图'],
  ['Users\\zoom\\AppData\\Roaming\\Code\\Cache\\a', 'vscode_cache', 'VS Code 缓存'],
  ['Users\\zoom\\AppData\\Roaming\\SomeApp\\Cache\\a.dat', 'electron_cache', 'Electron 缓存']
];

const AGE = {
  'Users\\zoom\\AppData\\Local\\Temp\\old.tmp': 100,
  'Users\\zoom\\AppData\\Local\\Temp\\new.tmp': 1,
  'Windows\\Temp\\x.tmp': 100,
  'Users\\zoom\\AppData\\Local\\JetBrains\\IntelliJIdea2023.2\\caches\\c.dat': 50,
  'Users\\zoom\\proj\\node_modules\\a\\b.js': 400,
  'Users\\zoom\\Downloads\\setup.exe': 200 * 24,
  'Users\\zoom\\Downloads\\doc.pdf': 200 * 24,
  'Users\\zoom\\AppData\\Local\\app-updater\\pending\\1.2.3.exe': 48,
  'Windows\\LiveKernelReports\\WATCHDOG-1.dmp': 48,
  'Users\\zoom\\AppData\\Local\\CrashDumps\\a.dmp': 400,
  'Windows\\SoftwareDistribution\\Download\\a.cab': 48,
  'Users\\zoom\\AppData\\Roaming\\Tencent\\xwechat\\all_users\\config\\cache\\x.dat': 48,
  'Users\\zoom\\AppData\\Roaming\\SomeApp\\Cache\\a.dat': 48,
  'Users\\zoom\\AppData\\Local\\Temp\\old.log': 200
};

const files = CASES.map(([rel]) => file(rel, 5 * 1048576, AGE[rel] != null ? AGE[rel] : 30));
// 补一个「同一临时目录里的旧日志」，应该仍然算 temp
files.push(file('Users\\zoom\\AppData\\Local\\Temp\\old.log', 2 * 1048576, 200));

const ctx = {
  root: 'C:\\',
  now,
  th: cfg.thresholds,
  rules: prepare(cfg),
  isSystem: true,
  useAtime: false
};

const classified = classify(files, ctx, 400);
const got = new Map();
for (const f of files) got.set(f.p, f.c);

let pass = 0;
let fail = 0;
const fails = [];
for (const [rel, expect, label] of CASES) {
  const actual = got.get(rel);
  if (actual === expect) pass++;
  else { fail++; fails.push(`${label}\n    ${rel}\n    期望 ${expect}，实际 ${actual}`); }
}
const extra = got.get('Users\\zoom\\AppData\\Local\\Temp\\old.log');
if (extra === 'temp') pass++; else { fail++; fails.push('临时目录里的旧日志 期望 temp，实际 ' + extra); }

console.log('=== 规则匹配自测 ===');
console.log(`通过 ${pass} / ${pass + fail}`);
if (fails.length) { console.log('\n失败项:'); for (const f of fails) console.log('  · ' + f); }

// 分层一致性：可清理 ⇒ 可再生 且 属于 L1/L2
console.log('\n=== 分层一致性 ===');
let bad = 0;
for (const c of classified) {
  if (c.selectable && (!c.regenerable || (c.tier !== 'L1' && c.tier !== 'L2'))) {
    bad++; console.log('  ✗ 违反约束: ' + c.id + ' tier=' + c.tier + ' regenerable=' + c.regenerable);
  }
}
console.log(bad ? `  ✗ ${bad} 项违反` : '  ✓ 所有可清理类目均为 L1/L2 且可再生');

// 清单生成：L0 / L3 / hold 必须被服务端拒绝
console.log('\n=== 清单门禁 ===');
const fileIndex = new Map();
for (const f of files) {
  let a = fileIndex.get(f.c); if (!a) { a = []; fileIndex.set(f.c, a); }
  a.push(f);
}
const planner = new Planner(cfg);
const ledger = { root: 'C:\\', classified, fileIndex };
const p1 = planner.build(ledger, ['sys_core', 'user_docs', 'key_secret', 'temp_recent']);
console.log('  请求 L0/L3/hold 四类 → 可清理 ' + p1.totalCount + ' 个，拒绝 ' + p1.rejected.length + ' 个');
for (const r of p1.rejected) console.log('    × ' + (r.name || r.id) + ' —— ' + r.reason);
const p2 = planner.build(ledger, ['temp', 'sodamusic_cache', 'browser_cache']);
console.log('  请求 L1 三类 → 可清理 ' + p2.totalCount + ' 个 / ' + (p2.totalBytes / 1048576) + ' MB，拒绝 ' + p2.rejected.length);
for (const c of p2.byCat) console.log('    ✓ ' + c.name + '  ' + c.count + ' 个');

console.log('\n=== 白名单双向校验 ===');
const wlCases = [
  ['C:\\Program Files\\X\\a.exe', 'block'],
  ['C:\\Windows\\WinSxS\\a\\b.dll', 'block'],
  ['C:\\Users\\zoom\\AppData\\Local\\Temp\\a.tmp', 'allow'],
  ['C:\\Users\\zoom\\.ssh\\id_rsa', 'block'],
  ['C:\\Users\\zoom\\Desktop\\a.txt', 'block']
];
for (const [p, want] of wlCases) {
  const v = planner.check(p, { tier: 'L1' });
  const gotW = v.block ? 'block' : 'allow';
  const ok = (want === 'sys?block' ? true : want === gotW);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + gotW.padEnd(6) + p + (v.reason ? '   ← ' + v.reason : ''));
}

console.log('\n=== 结果 ===');
console.log(fail === 0 && bad === 0 ? '全部通过' : '存在失败项，需要修');
