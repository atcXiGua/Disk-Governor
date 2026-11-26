'use strict';
/**
 * 规则加载器
 *
 * 设计意图：把「哪些目录能删」的知识从代码里抽出来，变成可独立审查的数据。
 * 每条规则必须附带判断依据（basis）和处理建议（advice），否则加载即失败。
 *
 * 文件命名决定优先级：按文件名升序拼接，先加载先匹配。
 * 因此拆分规则时不能随意调整文件序号，否则会改变命中结果。
 */
const fs = require('fs');
const path = require('path');

const TIERS = new Set(['L0', 'L1', 'L2', 'L3']);
const KINDS = new Set(['clean', 'deny', 'hold', 'migrate', 'other']);
const REQUIRED = ['id', 'name', 'tier', 'kind', 'match', 'basis', 'advice'];
const SCHEMA_VERSION = 1;

function fail(file, id, msg) {
  throw new Error(`规则校验失败 [${file}${id ? ' / ' + id : ''}] ${msg}`);
}

function validateRule(r, file) {
  if (!r || typeof r !== 'object') fail(file, '', '规则必须是对象');
  for (const k of REQUIRED) {
    if (r[k] === undefined || r[k] === null || r[k] === '') fail(file, r.id, `缺少必填字段 ${k}`);
  }
  if (!TIERS.has(r.tier)) fail(file, r.id, `tier 非法: ${r.tier}（应为 L0/L1/L2/L3）`);
  if (!KINDS.has(r.kind)) fail(file, r.id, `kind 非法: ${r.kind}`);
  if (typeof r.match !== 'object' || Array.isArray(r.match) || !Object.keys(r.match).length) {
    fail(file, r.id, 'match 必须是非空对象');
  }
  if (typeof r.basis !== 'string' || r.basis.length < 8) {
    fail(file, r.id, 'basis（判断依据）过短，无法作为审查凭据');
  }
  if (typeof r.advice !== 'string' || r.advice.length < 4) {
    fail(file, r.id, 'advice（处理建议）缺失');
  }

  // 硬约束：能进清理清单的，必须是可再生的、且只可能落在 L1/L2
  if (r.selectable === true) {
    if (r.regenerable !== true) fail(file, r.id, 'selectable=true 但 regenerable 不为 true');
    if (r.tier !== 'L1' && r.tier !== 'L2') fail(file, r.id, 'selectable=true 但 tier 不是 L1/L2');
  }
  // 反向约束：L0/L3 不允许声明可清理
  if (r.kind === 'clean' && (r.tier === 'L0' || r.tier === 'L3')) {
    fail(file, r.id, `${r.tier} 不允许 kind=clean`);
  }
  if (r.requires && typeof r.requires !== 'object') fail(file, r.id, 'requires 必须是对象');
  return true;
}

/**
 * @param {string} rulesDir  规则目录绝对路径
 * @param {object} opts      { disabled: string[] }
 * @returns {{ rules: object[], groups: object[], files: string[] }}
 */
function loadRules(rulesDir, opts = {}) {
  const disabled = new Set(opts.disabled || []);
  if (!fs.existsSync(rulesDir)) {
    throw new Error(`规则目录不存在: ${rulesDir}`);
  }
  const files = fs.readdirSync(rulesDir)
    .filter(f => f.toLowerCase().endsWith('.json'))
    .sort();                       // 文件名即优先级
  if (!files.length) throw new Error(`规则目录为空: ${rulesDir}`);

  const rules = [];
  const groups = [];
  const seen = new Map();

  for (const file of files) {
    const full = path.join(rulesDir, file);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      throw new Error(`规则文件解析失败 [${file}]: ${e.message}`);
    }
    if (doc.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`[${file}] schemaVersion 应为 ${SCHEMA_VERSION}，实际 ${doc.schemaVersion}`);
    }
    if (!Array.isArray(doc.rules) || !doc.rules.length) {
      throw new Error(`[${file}] rules 必须是非空数组`);
    }

    let loaded = 0;
    for (const r of doc.rules) {
      validateRule(r, file);
      if (seen.has(r.id)) {
        throw new Error(`规则 id 重复: ${r.id}（${seen.get(r.id)} 与 ${file}）`);
      }
      seen.set(r.id, file);
      if (disabled.has(r.id)) continue;
      rules.push(Object.assign({}, r, { _file: file }));
      loaded++;
    }
    groups.push({
      file,
      group: doc.group || '',
      description: doc.description || '',
      total: doc.rules.length,
      loaded
    });
  }

  if (!rules.length) throw new Error('所有规则均被禁用，无可用规则');
  return { rules, groups, files };
}

module.exports = { loadRules, validateRule, TIERS, KINDS, SCHEMA_VERSION };
