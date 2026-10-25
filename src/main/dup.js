/**
 * 重复文件扫描
 * ==================================================================
 * 两阶段精准比对，避免对全盘文件做无意义哈希：
 *   ① 按「体积」分桶 —— 只有体积相同的文件才可能重复，先过滤掉 90%+ 的候选
 *   ② 对候选文件用 MD5 校验（多线程 Worker Pool 流式读取，不占内存）
 * 最终输出重复组：组内文件字节完全一致，可选择性保留一个、删除其余。
 */
'use strict';
const fsops = require('./fsops');

/**
 * @param {Array} flatFiles [[path, size, mtime], …]
 * @param {Pool} pool 工作线程池
 * @param {function} onProgress
 */
async function findDuplicates(flatFiles, pool, onProgress) {
  const files = flatFiles || [];

  /* ---------- ① 按体积分桶 ---------- */
  const bySize = new Map();
  for (const f of files) {
    const p = f[0], s = f[1], m = f[2];
    if (!s || s <= 0) continue;
    let arr = bySize.get(s);
    if (!arr) { arr = []; bySize.set(s, arr); }
    arr.push({ path: p, size: s, mtime: m });
  }
  const candidates = [];
  let candidateBytes = 0;
  for (const [, arr] of bySize) {
    if (arr.length < 2) continue;
    for (const x of arr) { candidates.push(x); candidateBytes += x.size; }
  }
  onProgress && onProgress({
    stage: 'size', scanned: files.length,
    candidates: candidates.length, candidateBytes, done: 0, total: candidates.length
  });

  if (!candidates.length) return { groups: [], scanned: files.length, candidates: 0, waste: 0 };

  /* ---------- ② 多线程 MD5 ---------- */
  const CHUNK = 24;                       // 每个线程任务处理多少个文件
  const chunks = [];
  for (let i = 0; i < candidates.length; i += CHUNK) {
    chunks.push(candidates.slice(i, i + CHUNK));
  }
  let finished = 0;
  const jobs = chunks.map((c) =>
    pool.run({ mode: 'hash', paths: c.map(x => x.path) })
      .then((msg) => {
        finished += c.length;
        onProgress && onProgress({
          stage: 'hash', scanned: files.length,
          candidates: candidates.length, candidateBytes,
          done: finished, total: candidates.length
        });
        const hashes = (msg && msg.payload && msg.payload.hashes) || [];
        for (let i = 0; i < c.length; i++) c[i].hash = hashes[i] || null;
      })
  );
  await Promise.all(jobs);

  /* ---------- ③ 按哈希分组 ---------- */
  const byHash = new Map();
  for (const c of candidates) {
    if (!c.hash) continue;                 // 读取失败（被占用/无权限）直接跳过
    let arr = byHash.get(c.hash);
    if (!arr) { arr = []; byHash.set(c.hash, arr); }
    arr.push(c);
  }
  const groups = [];
  let waste = 0;
  for (const [hash, arr] of byHash) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.mtime - b.mtime);   // 最早修改的排第一 → 默认建议保留
    const size = arr[0].size;
    const g = {
      hash, size, count: arr.length,
      waste: size * (arr.length - 1),
      files: arr.map(f => ({
        path: f.path, size: f.size, mtime: f.mtime,
        name: f.path.split('\\').pop() || f.path,
        keep: false, locked: require('../shared/safety').isLocked(f.path, false)
      }))
    };
    g.files[0].keep = true;                  // 默认保留最早的一个
    waste += g.waste;
    groups.push(g);
  }
  groups.sort((a, b) => b.waste - a.waste);

  return { groups, scanned: files.length, candidates: candidates.length, waste };
}

/** 删除重复组中被标记为冗余的文件 */
async function deleteRedundant(groups) {
  const paths = [];
  for (const g of groups || []) {
    for (const f of g.files) if (!f.keep) paths.push(f.path);
  }
  let freed = 0;
  for (const p of paths) freed += fsops.sizeOf(p);
  const r = await fsops.trashMany(paths);
  return { ok: r.ok, failed: r.failed, freed, total: paths.length };
}

module.exports = { findDuplicates, deleteRedundant };
