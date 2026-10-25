/**
 * IPC 接口层
 * ==================================================================
 * 渲染进程（UI）只能通过这里定义的通道访问本机文件系统，
 * 所有危险操作都在这一层做二次校验（红色锁定过滤、批量上限、路径合法性）。
 *
 * 命名约定：
 *   xxx:start  —— 长任务，进度通过 push 事件推送，invoke 在结束时返回结果
 *   fs:xxx     —— 文件系统副作用（打开 / 删除 / 复制）
 *   data:xxx   —— 查询已扫描的数据集
 */
'use strict';
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const diskinfo = require('./diskinfo');
const cleaner = require('./cleaner');
const dup = require('./dup');
const fsops = require('./fsops');
const Safety = require('../shared/safety');
const Category = require('../shared/categories');

const MAX_BATCH_DELETE = 1000;   // 单次最多删除条目数，防误操作雪崩

function send(win, ch, payload) {
  if (win && win.webContents && !win.isDestroyed()) {
    try { win.webContents.send(ch, payload); } catch (e) { /* 忽略 */ }
  }
}

/**
 * @param {object} ctx { win, scanner, getConfig, setConfig }
 */
function register(ctx) {
  // 注意：win 用 getter 提供，这里只能在使用时读取，不能解构（否则永远是 null）
  const scanner = ctx.scanner;
  const cfgGet = ctx.getConfig;
  const cfgSet = ctx.setConfig;

  /* ------------------------------ 配置 ------------------------------ */
  ipcMain.handle('app:config', () => cfgGet());
  ipcMain.handle('app:config:save', (_e, cfg) => {
    cfgSet(cfg || {});
    return cfgGet();
  });

  /* ---------------------------- 磁盘信息 ---------------------------- */
  ipcMain.handle('sys:drives', () => {
    return diskinfo.listDrives().map(d => Object.assign({ letter: d.letter, mount: d.mount }, diskinfo.info(d.mount)));
  });
  ipcMain.handle('sys:disk', (_e, mount) => diskinfo.info(mount));

  /* ---------------------------- 全盘扫描 ---------------------------- */
  ipcMain.handle('scan:start', async (_e, arg) => {
    const cfg = cfgGet();
    const a = arg || {};
    const drives = a.drives && a.drives.length ? a.drives : cfg.lastDrives;
    cfgSet({ lastDrives: drives });

    const roots = drives.map(d => String(d).replace(/\\+$/, '') + '\\');
    const opts = {
      roots,
      keepBytes: Math.max(0, (Number(a.keepMB != null ? a.keepMB : cfg.keepFileMB) || 0)) * 1024 * 1024,
      ignoreDirs: cfg.ignoreDirs,
      ignoreExts: cfg.ignoreExts,
      skipSystemHeavy: cfg.skipSystemHeavy !== false
    };
    try {
      const r = await scanner.startTreeScan(opts, (p) => send(ctx.win, 'scan:progress', p));
      if (r.cancelled) return { cancelled: true };
      const di = disksOf(drives);
      return {
        cancelled: false,
        summary: scanner.dataset.summary(di),
        counters: scanner.dataset.counters,
        elapsed: scanner.dataset.elapsed,
        disks: di
      };
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('scan:cancel', () => { scanner.cancel(); return true; });
  ipcMain.handle('scan:state', () => ({ running: scanner.running, ready: scanner.dataset.ready }));

  /* ---------------------------- 树图下钻 ---------------------------- */
  ipcMain.handle('tree:children', (_e, arg) => {
    const id = (arg && arg.id != null) ? arg.id : 0;
    if (!scanner.dataset.ready) return [];
    return scanner.dataset.children(id);
  });

  ipcMain.handle('tree:goto', (_e, arg) => {
    const p = arg && arg.path;
    if (!p || !scanner.dataset.ready) return null;
    const d = scanner.dataset.findDirByPath(p);
    if (!d) return null;
    const trail = [];
    let cur = d;
    let guard = 0;
    while (cur && guard++ < 64) {
      trail.unshift({ id: cur.id, name: cur.name, path: cur.path });
      if (cur.parent === 0 || cur.parent == null) break;
      cur = scanner.dataset.dirById.get(cur.parent);
    }
    trail.unshift({ id: 0, name: '全部磁盘', path: '' });
    return { id: d.id, trail };
  });

  /* ---------------------------- 数据查询 ---------------------------- */
  ipcMain.handle('data:topFiles', (_e, arg) => {
    const a = arg || {};
    if (!scanner.dataset.ready) return [];
    return scanner.dataset.topFiles(a.n || 30, a.sort || 'size', a.ext || 'all', a.minSize || 0);
  });
  ipcMain.handle('data:topDirs', (_e, arg) => {
    if (!scanner.dataset.ready) return [];
    return scanner.dataset.topDirs((arg && arg.n) || 30);
  });
  ipcMain.handle('data:typeStats', (_e, arg) => {
    if (!scanner.dataset.ready) return [];
    return scanner.dataset.typeStatsTop((arg && arg.n) || 12);
  });
  ipcMain.handle('data:categoryStats', () => {
    if (!scanner.dataset.ready) return [];
    return scanner.dataset.categoryStats();
  });
  ipcMain.handle('data:extList', () => {
    if (!scanner.dataset.ready) return [];
    const set = new Set();
    for (const t of scanner.dataset.typeStats) if (t[0]) set.add(t[0]);
    return Array.from(set).sort();
  });
  ipcMain.handle('data:summary', (_e, arg) => {
    const drives = (arg && arg.drives) || cfgGet().lastDrives;
    if (!scanner.dataset.ready) return null;
    return scanner.dataset.summary(disksOf(drives));
  });

  /* --------------------------- 智能垃圾清理 --------------------------- */
  ipcMain.handle('junk:start', async (_e, arg) => {
    const cfg = cfgGet();
    const a = arg || {};
    const drives = a.drives && a.drives.length ? a.drives : cfg.lastDrives;
    const c = {
      idleDays: Number(a.idleDays != null ? a.idleDays : cfg.idleDays) || 180,
      bigFileBytes: (Number(a.bigFileMB != null ? a.bigFileMB : cfg.bigFileMB) || 100) * 1024 * 1024,
      includePersonal: a.includePersonal != null ? !!a.includePersonal : !!cfg.includePersonal
    };
    const opts = {
      targets: cleaner.targets(drives, c),
      cfg: c,
      ignoreDirs: cfg.ignoreDirs,
      ignoreExts: cfg.ignoreExts
    };
    try {
      const r = await scanner.startJunkScan(opts, (p) => send(ctx.win, 'junk:progress', p));
      const grouped = cleaner.group(r.items || []);
      ctx.lastJunk = grouped;
      return Object.assign({ cancelled: !!r.cancelled, elapsed: r.elapsed, counters: r.counters }, grouped);
    } catch (err) {
      return { error: (err && err.message) || String(err), groups: [] };
    }
  });

  ipcMain.handle('junk:clean', async (_e, arg) => {
    const paths = (arg && arg.paths) || [];
    if (paths.length > MAX_BATCH_DELETE) return { error: '单次删除上限 ' + MAX_BATCH_DELETE + ' 项' };
    return await cleaner.clean(paths);
  });

  /* ---------------------------- 重复文件 ---------------------------- */
  ipcMain.handle('dup:start', async (_e, arg) => {
    const cfg = cfgGet();
    const a = arg || {};
    const drives = a.drives && a.drives.length ? a.drives : cfg.lastDrives;
    const minBytes = (Number(a.minMB != null ? a.minMB : cfg.dupMinMB) || 1) * 1024 * 1024;
    const roots = drives.map(d => String(d).replace(/\\+$/, '') + '\\');
    try {
      const r = await scanner.startFlatScan({
        roots, minBytes, maxFiles: 500000,
        ignoreDirs: cfg.ignoreDirs, ignoreExts: []
      }, (p) => send(ctx.win, 'dup:progress', Object.assign({ stage: 'scan' }, p)));

      const pool = scanner.ensurePool((p) => send(ctx.win, 'dup:progress', p));
      const res = await dup.findDuplicates(r.files || [], pool, (p) => send(ctx.win, 'dup:progress', p));
      ctx.lastDup = res;
      return res;
    } catch (err) {
      return { error: (err && err.message) || String(err), groups: [] };
    }
  });

  ipcMain.handle('dup:delete', async (_e, arg) => {
    const groups = (arg && arg.groups) || [];
    let count = 0;
    for (const g of groups) for (const f of g.files) if (!f.keep) count++;
    if (count > MAX_BATCH_DELETE) return { error: '单次删除上限 ' + MAX_BATCH_DELETE + ' 项' };
    return await dup.deleteRedundant(groups);
  });

  /* ---------------------------- 文件操作 ---------------------------- */
  ipcMain.handle('fs:stat', (_e, arg) => {
    const p = arg && arg.path;
    if (!p) return null;
    try {
      const st = fs.statSync(p);
      const isDir = st.isDirectory();
      const sf = Safety.evaluate(p, isDir);
      return {
        path: p, name: path.basename(p) || p, isDir,
        size: st.size || 0, mtime: Math.round(st.mtimeMs || 0),
        atime: Math.round(st.atimeMs || 0), ctime: Math.round(st.ctimeMs || 0),
        ext: isDir ? '' : Category.extOf(path.basename(p)),
        category: isDir ? Category.ofDir(path.basename(p)) : Category.ofFile(path.basename(p)),
        level: sf.level, reason: sf.reason, locked: sf.locked
      };
    } catch (e) {
      return { path: p, name: path.basename(p) || p, error: (e && e.message) || '无法访问' };
    }
  });

  ipcMain.handle('fs:reveal', (_e, arg) => { fsops.reveal(arg && arg.path); return true; });
  ipcMain.handle('fs:open', (_e, arg) => { fsops.openDir(arg && arg.path); return true; });
  ipcMain.handle('fs:copy', (_e, arg) => { fsops.copyText(arg && arg.text); return true; });
  ipcMain.handle('fs:recycleBin', () => { fsops.openRecycleBin(); return true; });

  /** 通用删除（来自树图 / 大文件列表 / 重复文件），一律移入回收站 */
  ipcMain.handle('fs:trash', async (_e, arg) => {
    const paths = (arg && arg.paths) || [];
    if (!paths.length) return { ok: 0, failed: [], freed: 0, total: 0 };
    if (paths.length > MAX_BATCH_DELETE) return { error: '单次删除上限 ' + MAX_BATCH_DELETE + ' 项' };
    let freed = 0;
    for (const p of paths) freed += fsops.sizeOf(p);
    const r = await fsops.trashMany(paths);
    return { ok: r.ok, failed: r.failed, freed, total: paths.length };
  });

  /* ------------------------------ 工具 ------------------------------ */
  function disksOf(drives) {
    let total = 0, free = 0;
    for (const d of drives || []) {
      const i = diskinfo.info(String(d).replace(/\\+$/, '') + '\\');
      total += i.total; free += i.free;
    }
    return { total, free, used: Math.max(0, total - free) };
  }
}

module.exports = { register };
