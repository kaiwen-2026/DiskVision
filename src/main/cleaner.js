/**
 * 智能垃圾清理
 * ==================================================================
 * 流程：
 *   扫描(Worker, mode=junk) → 按「类别 + 安全等级」分组 → 用户勾选 → 移入回收站
 *
 * 安全分级（颜色）：
 *   green  100% 安全：临时文件、日志、缩略图缓存、浏览器缓存、空文件夹 —— 可一键清理
 *   yellow 谨慎删除：过期安装包、闲置大文件、Windows.old —— 需自行确认
 *   red    永久锁定：系统关键目录 / 关键后缀 —— 界面上禁止勾选，删除接口也会二次拒绝
 */
'use strict';
const Rules = require('../shared/rules');
const Safety = require('../shared/safety');
const fsops = require('./fsops');

/** 环境变量快照（统一小写，Windows 路径不区分大小写） */
function envSnapshot() {
  const e = process.env || {};
  const g = (k) => String(e[k] || '').toLowerCase();
  return {
    sysRoot: g('SystemRoot') || 'c:\\windows',
    windir: g('windir') || 'c:\\windows',
    programFiles: g('ProgramFiles') || 'c:\\program files',
    programFilesX86: g('ProgramFiles(x86)') || 'c:\\program files (x86)',
    programData: g('ProgramData') || 'c:\\programdata',
    userProfile: g('USERPROFILE') || '',
    appData: g('APPDATA') || '',
    localAppData: g('LOCALAPPDATA') || '',
    temp: g('TEMP') || ''
  };
}

/** 构造垃圾扫描目标根目录 */
function targets(drives, cfg) {
  return Rules.buildTargets(envSnapshot(), drives || ['C:'], cfg || {});
}

/**
 * 把扫描到的条目按「类别 × 等级」分组，供 UI 展示
 * @param {Array} items
 */
function group(items) {
  const byCat = new Map();
  const levelSum = { green: 0, yellow: 0, red: 0 };
  const levelCount = { green: 0, yellow: 0, red: 0 };

  for (const it of items || []) {
    const lv = it.level || 'yellow';
    levelSum[lv] += it.size || 0;
    levelCount[lv] += 1;

    let g = byCat.get(it.rule);
    if (!g) {
      const rule = Rules.RULE_MAP[it.rule] || { title: it.category || '其他', desc: '' };
      g = {
        id: it.rule, title: rule.title, desc: rule.desc,
        level: lv, size: 0, count: 0, locked: true, items: []
      };
      byCat.set(it.rule, g);
    }
    g.size += it.size || 0;
    g.count += 1;
    if (lv !== 'red') { g.locked = false; g.level = lv === 'green' ? g.level : (g.level === 'red' ? lv : g.level); }
    if (lv === 'green' && g.level !== 'green') g.level = 'green';
    g.items.push(it);
  }

  const list = Array.from(byCat.values()).map(g => {
    // 类别内按体积倒序，UI 只展示前若干条
    g.items.sort((a, b) => b.size - a.size);
    if (g.level === 'red') g.locked = true;
    return g;
  });
  list.sort((a, b) => {
    const rank = { green: 0, yellow: 1, red: 2 };
    if (rank[a.level] !== rank[b.level]) return rank[a.level] - rank[b.level];
    return b.size - a.size;
  });

  return {
    groups: list,
    totalSize: levelSum.green + levelSum.yellow + levelSum.red,
    safeSize: levelSum.green,
    warnSize: levelSum.yellow,
    lockedSize: levelSum.red,
    counts: levelCount
  };
}

/**
 * 执行清理
 * @param {string[]} paths 已勾选的路径（UI 侧已排除红色项，这里再兜一次底）
 */
async function clean(paths) {
  const list = (paths || []).filter(p => {
    const sf = Safety.evaluate(p, true);
    return sf.level !== 'red';
  });
  if (!list.length) return { ok: 0, failed: [], freed: 0, total: 0, rejected: (paths || []).length };

  // 先统计将要释放的空间
  let freed = 0;
  for (const p of list) freed += fsops.sizeOf(p);

  const r = await fsops.trashMany(list);
  return {
    ok: r.ok, failed: r.failed, freed,
    total: list.length,
    rejected: (paths || []).length - list.length
  };
}

module.exports = { envSnapshot, targets, group, clean };
