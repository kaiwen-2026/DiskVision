/**
 * 扫描任务实现（供工作线程调用）
 * ==================================================================
 * 这个文件不直接依赖 worker_threads，只依赖一个「端口对象」（有 postMessage 即可），
 * 因此既能在真正的 Worker 线程里跑，也能在极端环境下退化到主进程内跑（见 worker-host.js）。
 *
 * 支持 4 种任务：
 *   tree —— 全盘/选盘建目录树（Treemap、排行、仪表盘）
 *   flat —— 只收集文件清单（重复文件扫描）
 *   junk —— 定向垃圾扫描（一键智能清理）
 *   hash —— 批量计算 MD5（重复文件精准比对）
 *
 * 为什么用同步 fs（readdirSync/statSync）而不是异步？
 *   同步调用省掉 libuv 任务队列往返，在同一线程内比全异步快数倍；
 *   阻塞问题由「独立线程 + 定期 setImmediate 让出」解决，既能收取消指令，又不影响 UI。
 *
 * 健壮性：权限错误、路径过长、文件被占用、目录联接(junction) —— 全部静默跳过并计数，绝不崩溃。
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const Category = require('../shared/categories');
const Safety = require('../shared/safety');
const Rules = require('../shared/rules');

let cancelled = false;
function setCancelled(v) { cancelled = !!v; }

let lastYield = 0;
/** 定期让出线程：既能响应取消，也不会明显拖慢扫描 */
async function breathe(force) {
  const now = Date.now();
  if (force || now - lastYield > 60) {
    lastYield = now;
    await new Promise(r => setImmediate(r));
  }
}

function norm(p) {
  return String(p || '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
}

/* =====================================================================
 *  一、目录树扫描（tree）
 * ===================================================================== */

async function scanTree(job, port) {
  const roots = job.roots || [];
  const keepBytes = job.keepBytes || (1024 * 1024);
  const ignoreDirs = (job.ignoreDirs || []).map(norm);
  const ignoreExts = new Set((job.ignoreExts || []).map(s => String(s).toLowerCase().replace(/^\./, '')));
  const skipHeavy = job.skipSystemHeavy !== false;

  const dirs = [];    // {id,parent,name,path,size,fileCount,dirCount,mtime,depth}
  const files = [];   // {id,parent,name,path,size,mtime}
  const typeStats = Object.create(null);
  const topFiles = [];
  const TOP_N = 500;

  let idSeq = 1;
  const c = { files: 0, dirs: 0, bytes: 0, errors: 0, skipped: 0 };
  const started = Date.now();
  let lastPost = 0;

  const isIgnored = (fullPath) => {
    const p = norm(fullPath);
    for (const ig of ignoreDirs) if (p === ig || p.startsWith(ig + '\\')) return true;
    return false;
  };

  function shouldSkipDir(fullPath, name, depth) {
    if (Rules.ALWAYS_SKIP_DIR.has(name.toLowerCase())) { c.skipped++; return true; }
    if (skipHeavy && depth <= 3) {
      const p = norm(fullPath);
      if (p.includes('\\winsxs') || p.includes('\\driverstore') ||
        p.includes('\\system32\\config') || p.includes('\\servicing')) { c.skipped++; return true; }
    }
    if (isIgnored(fullPath)) { c.skipped++; return true; }
    return false;
  }

  function pushTopFile(f) {
    if (topFiles.length < TOP_N) {
      topFiles.push(f);
      if (topFiles.length === TOP_N) topFiles.sort((a, b) => b.size - a.size);
      return;
    }
    if (f.size <= topFiles[TOP_N - 1].size) return;
    let i = TOP_N - 1;
    while (i > 0 && topFiles[i - 1].size < f.size) i--;
    topFiles.splice(i, 0, f);
    topFiles.pop();
  }

  async function walk(dirPath, parentId, depth) {
    if (cancelled || depth > 64) return { size: 0, fc: 0, dc: 0 };

    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
      c.errors++;                       // 权限拒绝 / 路径过长 / 被占用 —— 静默跳过
      return { size: 0, fc: 0, dc: 0 };
    }

    const name = dirPath.slice(dirPath.lastIndexOf('\\') + 1) || dirPath;
    let mtime = 0;
    try { mtime = fs.lstatSync(dirPath).mtimeMs || 0; } catch (e) { /* 忽略 */ }

    const node = {
      id: idSeq++, parent: parentId, name, path: dirPath,
      size: 0, fileCount: 0, dirCount: 0, mtime: Math.round(mtime), depth
    };
    dirs.push(node);
    c.dirs++;

    for (const ent of entries) {
      if (cancelled) break;
      // 符号链接 / 目录联接（junction）会造成无限递归，一律跳过
      try { if (ent.isSymbolicLink()) continue; } catch (e) { continue; }

      const childPath = dirPath.endsWith('\\') ? dirPath + ent.name : dirPath + '\\' + ent.name;

      if (ent.isDirectory()) {
        if (shouldSkipDir(childPath, ent.name, depth + 1)) continue;
        const r = await walk(childPath, node.id, depth + 1);
        node.size += r.size;
        node.fileCount += r.fc;
        node.dirCount += r.dc + 1;
      } else if (ent.isFile()) {
        let st;
        try { st = fs.statSync(childPath); } catch (e) { c.errors++; continue; }
        const size = st.size || 0;
        const mt = Math.round(st.mtimeMs || 0);
        node.size += size;
        node.fileCount++;
        c.files++;
        c.bytes += size;

        const ext = Category.extOf(ent.name);
        if (ext && !ignoreExts.has(ext)) {
          const t = typeStats[ext] || (typeStats[ext] = [0, 0]);
          t[0]++; t[1] += size;
        }
        if (size >= keepBytes) {
          const f = { id: idSeq++, parent: node.id, name: ent.name, path: childPath, size, mtime: mt };
          files.push(f);
          pushTopFile(f);
        }
      }
      await breathe(false);
    }

    const now = Date.now();
    if (now - lastPost > 150) {
      lastPost = now;
      port.postMessage({
        type: 'progress',
        payload: {
          files: c.files, dirs: c.dirs, bytes: c.bytes, errors: c.errors,
          current: dirPath, elapsed: now - started
        }
      });
    }
    await breathe(true);
    return { size: node.size, fc: node.fileCount, dc: node.dirCount };
  }

  // 每个扫描根（盘符）由 walk 自己建节点，parent 统一为虚拟根 id = 0
  for (const r of roots) {
    if (cancelled) break;
    await walk(String(r).replace(/\\+$/, ''), 0, 0);
  }

  if (topFiles.length < TOP_N) topFiles.sort((a, b) => b.size - a.size);

  port.postMessage({
    type: 'done',
    payload: {
      mode: 'tree', cancelled,
      dirs: dirs.map(d => [d.id, d.parent, d.name, d.path, d.size, d.fileCount, d.dirCount, d.mtime, d.depth]),
      files: files.map(f => [f.id, f.parent, f.name, f.path, f.size, f.mtime]),
      typeStats: Object.keys(typeStats).map(k => [k, typeStats[k][0], typeStats[k][1]]),
      counters: c, elapsed: Date.now() - started,
      topFiles: topFiles.slice(0, TOP_N).map(f => [f.id, f.parent, f.name, f.path, f.size, f.mtime])
    }
  });
}

/* =====================================================================
 *  二、扁平文件清单（flat，供重复文件扫描使用）
 * ===================================================================== */

async function scanFlat(job, port) {
  const roots = job.roots || [];
  const minBytes = job.minBytes || 0;
  const maxFiles = job.maxFiles || 400000;
  const ignoreDirs = (job.ignoreDirs || []).map(norm);
  const out = [];
  const c = { files: 0, dirs: 0, errors: 0 };
  const started = Date.now();
  let lastPost = 0;

  const isIgnored = (p) => {
    const n = norm(p);
    for (const ig of ignoreDirs) if (n === ig || n.startsWith(ig + '\\')) return true;
    return false;
  };

  async function walk(dirPath, depth) {
    if (cancelled || out.length >= maxFiles || depth > 64) return;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
    catch (e) { c.errors++; return; }

    for (const ent of entries) {
      if (cancelled || out.length >= maxFiles) break;
      try { if (ent.isSymbolicLink()) continue; } catch (e) { continue; }
      const childPath = dirPath.endsWith('\\') ? dirPath + ent.name : dirPath + '\\' + ent.name;
      if (ent.isDirectory()) {
        if (Rules.ALWAYS_SKIP_DIR.has(ent.name.toLowerCase())) continue;
        if (isIgnored(childPath)) continue;
        c.dirs++;
        await walk(childPath, depth + 1);
      } else if (ent.isFile()) {
        let st;
        try { st = fs.statSync(childPath); } catch (e) { c.errors++; continue; }
        c.files++;
        if ((st.size || 0) >= minBytes) out.push([childPath, st.size, Math.round(st.mtimeMs || 0)]);
      }
      await breathe(false);
    }
    const now = Date.now();
    if (now - lastPost > 150) {
      lastPost = now;
      port.postMessage({
        type: 'progress',
        payload: { files: c.files, dirs: c.dirs, bytes: 0, errors: c.errors, current: dirPath, elapsed: now - started }
      });
    }
  }

  for (const r of roots) await walk(String(r).replace(/\\+$/, ''), 0);

  port.postMessage({
    type: 'done',
    payload: { mode: 'flat', cancelled, files: out, counters: c, elapsed: Date.now() - started }
  });
}

/* =====================================================================
 *  三、定向垃圾扫描（junk）
 * ===================================================================== */

async function scanJunk(job, port) {
  const targets = job.targets || [];
  const cfg = job.cfg || {};
  const idleDays = cfg.idleDays || 180;
  const bigFileBytes = cfg.bigFileBytes || (100 * 1024 * 1024);
  const ignoreDirs = (job.ignoreDirs || []).map(norm);
  const ignoreExts = new Set((job.ignoreExts || []).map(s => String(s).toLowerCase().replace(/^\./, '')));
  const nowMs = Date.now();

  const items = [];
  const c = { files: 0, dirs: 0, bytes: 0, errors: 0 };
  const started = Date.now();
  let lastPost = 0;

  const isIgnored = (p) => {
    const n = norm(p);
    for (const ig of ignoreDirs) if (n === ig || n.startsWith(ig + '\\')) return true;
    return false;
  };

  /** 命中第一条规则即返回（保证同一条目只被计一次） */
  function matchRule(item) {
    for (const r of Rules.RULES) {
      let hit = false;
      try { hit = r.test(item); } catch (e) { hit = false; }
      if (hit) return r;
    }
    return null;
  }

  async function walk(dirPath, tag, depth, maxDepth, inCache) {
    if (cancelled || depth > maxDepth) return { size: 0, fc: 0, dc: 0 };

    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
    catch (e) { c.errors++; return { size: 0, fc: 0, dc: 0 }; }
    if (isIgnored(dirPath)) return { size: 0, fc: 0, dc: 0 };

    // 浏览器缓存安全边界：只允许深入到 Cache / Code Cache / GPUCache / Service Worker 等目录，
    // 书签、密码、Cookie、扩展数据一律不碰。
    //   depth 0 = User Data 根，depth 1 = 具体 Profile（Default / Profile 1 …），depth>=2 必须是缓存目录。
    if (tag === 'browser' && depth >= 2 && !inCache) return { size: 0, fc: 0, dc: 0 };

    let size = 0, fc = 0, dc = 0;
    c.dirs++;

    for (const ent of entries) {
      if (cancelled) break;
      try { if (ent.isSymbolicLink()) continue; } catch (e) { continue; }
      const childPath = dirPath.endsWith('\\') ? dirPath + ent.name : dirPath + '\\' + ent.name;

      if (ent.isDirectory()) {
        if (Rules.ALWAYS_SKIP_DIR.has(ent.name.toLowerCase())) continue;
        const childInCache = inCache || Rules.isBrowserCacheDir(ent.name);
        const r = await walk(childPath, tag, depth + 1, maxDepth, childInCache);
        size += r.size; fc += r.fc; dc += r.dc + 1;
      } else if (ent.isFile()) {
        let st;
        try { st = fs.statSync(childPath); } catch (e) { c.errors++; continue; }
        const fsize = st.size || 0;
        const mtime = Math.round(st.mtimeMs || 0);
        size += fsize; fc++; c.files++; c.bytes += fsize;
        if (tag === 'browser' && !inCache) continue;   // 非缓存区的文件（书签/密码等）不收集

        const ext = Category.extOf(ent.name);
        if (ignoreExts.has(ext)) continue;

        const item = {
          path: childPath, raw: childPath, name: ent.name.toLowerCase(), ext,
          isDir: false, size: fsize, mtime,
          ageDays: (nowMs - mtime) / Rules.DAY, isEmpty: false,
          tag, depth: depth + 1, cfg: { idleDays, bigFileBytes }
        };
        const rule = matchRule(item);
        if (rule) {
          const sf = Safety.evaluate(childPath, false, rule.safe ? rule.title : null);
          items.push({
            path: childPath, name: ent.name, size: fsize, mtime,
            isDir: false, rule: rule.id, category: rule.title,
            level: sf.level, reason: sf.reason, locked: sf.locked
          });
        }
      }
      await breathe(false);
    }

    // 目录自身判定（空文件夹 / 卸载残留 / Windows.old）
    let dmtime = 0;
    try { dmtime = Math.round(fs.lstatSync(dirPath).mtimeMs || 0); } catch (e) { /* 忽略 */ }
    const self = {
      path: dirPath, raw: dirPath, name: (dirPath.split('\\').pop() || '').toLowerCase(),
      ext: '', isDir: true, size, mtime: dmtime,
      ageDays: (nowMs - dmtime) / Rules.DAY,
      isEmpty: (fc === 0 && dc === 0), tag, depth, cfg: { idleDays, bigFileBytes }
    };
    const rule = matchRule(self);
    if (rule) {
      const sf = Safety.evaluate(dirPath, true, rule.safe ? rule.title : null);
      items.push({
        path: dirPath, name: dirPath.split('\\').pop() || dirPath, size, mtime: dmtime,
        isDir: true, rule: rule.id, category: rule.title,
        level: sf.level, reason: sf.reason, locked: sf.locked
      });
    }

    const now = Date.now();
    if (now - lastPost > 150) {
      lastPost = now;
      port.postMessage({
        type: 'progress',
        payload: {
          files: c.files, dirs: c.dirs, bytes: c.bytes, errors: c.errors,
          current: dirPath, elapsed: now - started, found: items.length
        }
      });
    }
    return { size, fc, dc };
  }

  // 目标去重（%TEMP% 与 %LOCALAPPDATA%\Temp 常指向同一目录，不去重会重复统计）
  const seen = new Set();
  for (const t of targets) {
    if (cancelled) break;
    const k = norm(t.path);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    await walk(t.path, t.tag, 0, t.maxDepth || 6, false);
  }

  port.postMessage({
    type: 'done',
    payload: { mode: 'junk', cancelled, items, counters: c, elapsed: Date.now() - started }
  });
}

/* =====================================================================
 *  四、MD5 哈希批处理（hash）
 * ===================================================================== */

function md5File(p) {
  return new Promise((resolve) => {
    let h;
    try { h = crypto.createHash('md5'); } catch (e) { return resolve(null); }
    let s;
    try { s = fs.createReadStream(p, { highWaterMark: 1024 * 1024 }); }
    catch (e) { return resolve(null); }
    s.on('data', chunk => { try { h.update(chunk); } catch (e) { /* 忽略 */ } });
    s.on('end', () => { try { resolve(h.digest('hex')); } catch (e) { resolve(null); } });
    s.on('error', () => { try { s.close(); } catch (e) { /* 忽略 */ } resolve(null); });
  });
}

async function hashBatch(job, port) {
  const paths = job.paths || [];
  const out = new Array(paths.length);
  for (let i = 0; i < paths.length; i++) {
    if (cancelled) break;
    out[i] = await md5File(paths[i]);
    if (i % 8 === 0) await breathe(false);
  }
  port.postMessage({ type: 'done', payload: { mode: 'hash', cancelled, hashes: out } });
}

/* ============================== 任务入口 ============================== */
async function runJob(payload, port) {
  const job = payload || {};
  cancelled = false;
  lastYield = 0;
  if (job.mode === 'tree') return scanTree(job, port);
  if (job.mode === 'flat') return scanFlat(job, port);
  if (job.mode === 'junk') return scanJunk(job, port);
  return hashBatch(job, port);
}

module.exports = { runJob, setCancelled };
