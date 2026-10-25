/**
 * 扫描调度器 + 扫描结果数据集
 * ==================================================================
 * 职责：
 *   1. 启动 / 取消扫描（任务跑在工作线程，主线程只转发进度）
 *   2. 把回传的紧凑数组还原成「数据集」，建立索引
 *   3. 向上层提供查询：下钻子项、TOP 排行、类型统计、汇总指标
 *
 * 内存控制的关键：
 *   - 只保留「目录节点」+「超过阈值的大文件」，小文件只累计成统计数字，
 *     因此 100 万文件的盘也只占几十 MB 内存，渲染进程更不会爆。
 *   - 下钻时子项超过 MAX_CHILDREN 会被裁掉，合并成一个「其他 N 项」节点。
 *
 * 线程可靠性：
 *   优先用 Worker；若 Worker 起不来（asar 打包、权限受限等），自动降级为进程内执行，
 *   功能完全一致，只是会短暂占用主线程（tasks.js 内部有 setImmediate 让出）。
 */
'use strict';
const os = require('os');
const Category = require('../shared/categories');
const { Pool } = require('./pool');
const { spawn, makeShim } = require('./worker-host');

const MAX_CHILDREN = 220;   // 单层最多展示多少个子块

/* =====================================================================
 *  数据集
 * ===================================================================== */
class Dataset {
  constructor() { this.clear(); }

  clear() {
    this.dirs = [];           // {id,parent,name,path,size,fileCount,dirCount,mtime,depth}
    this.files = [];          // {id,parent,name,path,size,mtime}
    this.dirById = new Map();
    this.dirChildren = new Map();  // parentId -> [dirId]
    this.fileChildren = new Map(); // parentId -> [fileId]
    this.fileById = new Map();
    this.typeStats = [];      // [ext, count, size]
    this.counters = { files: 0, dirs: 0, bytes: 0, errors: 0, skipped: 0 };
    this.elapsed = 0;
    this.roots = [];
    this.ready = false;
  }

  /** 载入回传数据 */
  load(payload) {
    this.clear();
    const fd = payload.dirs || [];
    const ff = payload.files || [];

    for (const a of fd) {
      const d = {
        id: a[0], parent: a[1], name: a[2], path: a[3], size: a[4],
        fileCount: a[5], dirCount: a[6], mtime: a[7], depth: a[8]
      };
      this.dirs.push(d);
      this.dirById.set(d.id, d);
      if (d.parent === 0) this.roots.push(d.id);
      let arr = this.dirChildren.get(d.parent);
      if (!arr) { arr = []; this.dirChildren.set(d.parent, arr); }
      arr.push(d.id);
    }
    for (const a of ff) {
      const f = { id: a[0], parent: a[1], name: a[2], path: a[3], size: a[4], mtime: a[5] };
      this.files.push(f);
      this.fileById.set(f.id, f);
      let arr = this.fileChildren.get(f.parent);
      if (!arr) { arr = []; this.fileChildren.set(f.parent, arr); }
      arr.push(f.id);
    }
    this.typeStats = payload.typeStats || [];
    this.counters = Object.assign(this.counters, payload.counters || {});
    this.elapsed = payload.elapsed || 0;
    this.ready = true;
    return this;
  }

  node(id) { return this.dirById.get(id) || this.fileById.get(id) || null; }

  /** 按路径定位目录（用于从任意路径跳到树图） */
  findDirByPath(p) {
    if (!p) return null;
    const n = String(p).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
    for (const d of this.dirs) {
      if (d.path.toLowerCase().replace(/\\+$/, '') === n) return d;
    }
    return null;
  }

  /**
   * 取某目录的可视化子项（目录 + 大文件，超出部分合并）
   * @param {number} id 目录 id，0 = 虚拟根
   */
  children(id) {
    const out = [];
    const kids = this.dirChildren.get(id) || [];
    for (const cid of kids) {
      const d = this.dirById.get(cid);
      if (!d || d.size <= 0) continue;
      out.push({
        id: d.id, kind: 'dir', name: d.name, path: d.path, size: d.size,
        mtime: d.mtime, fileCount: d.fileCount, dirCount: d.dirCount,
        category: Category.ofDir(d.name), children: true
      });
    }
    const fids = this.fileChildren.get(id) || [];
    for (const fid of fids) {
      const f = this.fileById.get(fid);
      if (!f) continue;
      out.push({
        id: f.id, kind: 'file', name: f.name, path: f.path, size: f.size,
        mtime: f.mtime, fileCount: 0, dirCount: 0,
        category: Category.ofFile(f.name), children: false
      });
    }
    out.sort((a, b) => b.size - a.size);

    if (out.length > MAX_CHILDREN) {
      const head = out.slice(0, MAX_CHILDREN);
      let restSize = 0;
      const restCount = out.length - MAX_CHILDREN;
      for (let i = MAX_CHILDREN; i < out.length; i++) restSize += out[i].size;
      head.push({
        id: -1, kind: 'aggregate', name: '其他 ' + restCount + ' 项', path: '',
        size: restSize, mtime: 0, fileCount: 0, dirCount: 0,
        category: 'other', children: false
      });
      return head;
    }
    return out;
  }

  /** TOP 大文件 */
  topFiles(n, sortBy, extFilter, minSize) {
    let list = this.files.slice();
    if (minSize) list = list.filter(f => f.size >= minSize);
    if (extFilter && extFilter !== 'all') {
      list = list.filter(f => Category.extOf(f.name) === extFilter);
    }
    if (sortBy === 'mtime') list.sort((a, b) => a.mtime - b.mtime);        // 最久未修改在前
    else if (sortBy === 'mtime-desc') list.sort((a, b) => b.mtime - a.mtime);
    else list.sort((a, b) => b.size - a.size);
    return list.slice(0, n || 30).map(f => ({
      id: f.id, name: f.name, path: f.path, size: f.size, mtime: f.mtime,
      ext: Category.extOf(f.name), category: Category.ofFile(f.name), isDir: false
    }));
  }

  /** TOP 大文件夹 */
  topDirs(n) {
    const list = this.dirs
      .filter(d => d.parent !== 0 || this.roots.length > 1)   // 单盘扫描时跳过盘符本身
      .slice()
      .sort((a, b) => b.size - a.size);
    return list.slice(0, n || 30).map(d => ({
      id: d.id, name: d.name, path: d.path, size: d.size, mtime: d.mtime,
      fileCount: d.fileCount, dirCount: d.dirCount,
      category: Category.ofDir(d.name), isDir: true
    }));
  }

  /** 类型统计：按后缀取前 n 项，其余归入「其他后缀」 */
  typeStatsTop(n) {
    const list = this.typeStats.slice().sort((a, b) => b[2] - a[2]);
    const top = list.slice(0, n || 12);
    let rest = 0;
    for (let i = (n || 12); i < list.length; i++) rest += list[i][2];
    const out = top.map(t => ({
      name: t[0] ? '.' + t[0] : '(无后缀)',
      ext: t[0], count: t[1], size: t[2],
      category: Category.ofFile('x.' + t[0]),
      color: Category.colorOf(Category.ofFile('x.' + t[0]))
    }));
    if (rest > 0) {
      out.push({ name: '其他后缀', ext: '', count: 0, size: rest, category: 'other', color: Category.colorOf('other') });
    }
    return out;
  }

  /** 按 8 大类汇总 */
  categoryStats() {
    const map = Object.create(null);
    for (const t of this.typeStats) {
      const key = Category.ofFile('x.' + t[0]);
      const m = map[key] || (map[key] = { size: 0, count: 0 });
      m.size += t[2]; m.count += t[1];
    }
    return Category.LIST.map(c => ({
      key: c.key, label: c.label, color: c.color,
      size: (map[c.key] && map[c.key].size) || 0,
      count: (map[c.key] && map[c.key].count) || 0
    })).filter(x => x.size > 0).sort((a, b) => b.size - a.size);
  }

  /** 汇总指标 */
  summary(diskInfo) {
    const scanned = this.counters.bytes || 0;
    const di = diskInfo || { total: 0, free: 0, used: 0 };
    return {
      totalBytes: di.total || 0,
      freeBytes: di.free || 0,
      usedBytes: di.used || scanned,
      scannedBytes: scanned,
      usedPercent: di.total ? +((di.total - di.free) / di.total * 100).toFixed(2) : 0,
      fileCount: this.counters.files || 0,
      dirCount: this.counters.dirs || 0,
      errorCount: this.counters.errors || 0,
      skippedCount: this.counters.skipped || 0,
      elapsed: this.elapsed
    };
  }
}

/* =====================================================================
 *  扫描调度器
 * ===================================================================== */
class Scanner {
  constructor() {
    this.dataset = new Dataset();
    this.pool = null;              // 哈希线程池，按需创建
    this.worker = null;
    this.running = false;
    this.lastJunk = null;
    this.lastDup = null;
  }

  ensurePool(onProgress) {
    if (!this.pool) {
      this.pool = new Pool(Math.min(8, Math.max(2, (os.cpus() || []).length || 4)), onProgress || (() => { }));
    }
    return this.pool;
  }

  /**
   * 跑一个任务（带一次「线程失败 → 进程内降级重跑」的容错）
   * @param {object} payload 任务参数（含 mode）
   * @param {function} onProgress
   */
  _run(payload, onProgress) {
    const self = this;
    return new Promise((resolve, reject) => {
      if (this.running) return reject(new Error('已有扫描任务在进行中'));
      this.running = true;

      let finished = false;
      let usedShim = false;
      let cur = null;

      const cleanup = (w) => { try { w.terminate(); } catch (e) { /* 忽略 */ } };
      function finish(p) {
        if (finished) return;
        finished = true; self.running = false;
        if (cur) cleanup(cur);
        self.worker = null;
        resolve(p);
      }
      function fail(e) {
        if (finished) return;
        finished = true; self.running = false;
        if (cur) cleanup(cur);
        self.worker = null;
        reject(e);
      }

      function start(useShim) {
        const w = useShim ? makeShim() : spawn();
        cur = w;
        self.worker = w;

        w.on('message', (m) => {
          if (!m) return;
          if (m.type === 'progress') { onProgress && onProgress(m.payload); return; }
          if (m.type === 'done') { finish(m.payload); return; }
          if (m.type === 'error') {
            if (!usedShim) { usedShim = true; cleanup(w); start(true); return; }
            fail(new Error((m.payload && m.payload.message) || '任务执行失败'));
          }
        });
        w.on('error', (e) => {
          if (!usedShim) { usedShim = true; cleanup(w); start(true); return; }
          fail(e);
        });

        w.postMessage({ type: 'reset' });
        w.postMessage({ type: 'job', payload });
      }

      start(false);
    });
  }

  /** 树扫描 */
  async startTreeScan(opts, onProgress) {
    const p = await this._run(Object.assign({ mode: 'tree' }, opts), onProgress);
    if (!p.cancelled && p.mode === 'tree') this.dataset.load(p);
    return { payload: p, cancelled: !!p.cancelled };
  }

  /** 定向垃圾扫描 */
  async startJunkScan(opts, onProgress) {
    const p = await this._run(Object.assign({ mode: 'junk' }, opts), onProgress);
    if (!p.cancelled) this.lastJunk = p.items || [];
    return p;
  }

  /** 扁平文件清单扫描 */
  startFlatScan(opts, onProgress) {
    return this._run(Object.assign({ mode: 'flat' }, opts), onProgress);
  }

  cancel() {
    if (this.worker) { try { this.worker.postMessage({ type: 'cancel' }); } catch (e) { /* 忽略 */ } }
    if (this.pool) this.pool.cancelAll();
  }

  destroy() { if (this.pool) this.pool.destroy(); }
}

module.exports = { Scanner, Dataset, MAX_CHILDREN };
