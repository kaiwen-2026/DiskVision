/**
 * 文件系统操作（删除 / 打开 / 复制路径）
 * ------------------------------------------------------------------
 * 安全原则：
 *   1. 一律走「移入回收站」（Electron shell.trashItem），绝不直接粉碎；
 *   2. 回收站失败时只记录失败原因，绝不降级为强制删除；
 *   3. 删除前由调用方（cleaner/dup/UI）做过红色锁定过滤 + 二次确认。
 */
'use strict';
const fs = require('fs');
const Safety = require('../shared/safety');

// electron 延迟加载：这样本模块在纯 Node 环境（自测脚本）里也能被 require
let _e = null;
function el() {
  if (!_e) _e = require('electron');
  return _e;
}

/** 单个条目移入回收站 */
async function trashOne(p) {
  if (Safety.isLocked(p, true) || Safety.isLocked(p, false)) {
    return { path: p, ok: false, reason: '系统保护文件，已拒绝删除' };
  }
  try {
    await el().shell.trashItem(p);
    return { path: p, ok: true };
  } catch (e) {
    return { path: p, ok: false, reason: (e && e.message) || '移入回收站失败' };
  }
}

/**
 * 批量移入回收站
 * @param {string[]} paths
 * @param {number} [concurrency] 并发数，太大容易把回收站 UI 卡住
 */
async function trashMany(paths, concurrency) {
  const list = (paths || []).slice();
  const n = Math.max(1, Math.min(8, concurrency || 4));
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      results[i] = await trashOne(list[i]);
    }
  }
  await Promise.all(new Array(n).fill(0).map(worker));

  const ok = results.filter(r => r && r.ok);
  const failed = results.filter(r => r && !r.ok);
  return { ok: ok.length, failed, total: list.length };
}

/** 在资源管理器中定位（文件→选中文件；目录→打开目录） */
function reveal(p) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) el().shell.openPath(p);
    else el().shell.showItemInFolder(p);
    return true;
  } catch (e) { return false; }
}

/** 打开目录 */
function openDir(p) {
  try { el().shell.openPath(p); return true; } catch (e) { return false; }
}

/** 打开回收站 */
function openRecycleBin() {
  try { el().shell.openPath('shell:RecycleBinFolder'); return true; } catch (e) { return false; }
}

/** 复制文本到剪贴板 */
function copyText(t) {
  try { el().clipboard.writeText(String(t || '')); return true; } catch (e) { return false; }
}

/** 读取文件体积（删除前统计用，失败返回 0，不抛错） */
function sizeOf(p) {
  try { return fs.statSync(p).size || 0; } catch (e) { return 0; }
}

module.exports = { trashOne, trashMany, reveal, openDir, openRecycleBin, copyText, sizeOf };
