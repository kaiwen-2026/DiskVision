/**
 * DiskVision 自测脚本（纯 Node，不需要 Electron）
 * ------------------------------------------------------------------
 * 运行：node tests/selftest.js
 * 覆盖：文件分类、安全分级、目录树扫描、数据集查询、垃圾规则、重复文件（MD5 多线程）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const root = path.join(__dirname, '..');
const Category = require(path.join(root, 'src/shared/categories'));
const Safety = require(path.join(root, 'src/shared/safety'));
const Rules = require(path.join(root, 'src/shared/rules'));
const { Dataset } = require(path.join(root, 'src/main/scanner'));
const { Pool } = require(path.join(root, 'src/main/pool'));
const cleaner = require(path.join(root, 'src/main/cleaner'));
const dup = require(path.join(root, 'src/main/dup'));
const WORKER = path.join(root, 'src/main/worker.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n[' + t + ']'); }

/** 在 worker 里跑一个任务 */
function runJob(payload) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER);
    const t = setTimeout(() => { try { w.terminate(); } catch (e) { } reject(new Error('worker 超时')); }, 60000);
    w.on('message', (m) => {
      if (m.type === 'done') { clearTimeout(t); w.terminate(); resolve(m.payload); }
      if (m.type === 'error') { clearTimeout(t); w.terminate(); reject(new Error(m.payload.message)); }
    });
    w.on('error', (e) => { clearTimeout(t); reject(e); });
    w.postMessage({ type: 'reset' });
    w.postMessage({ type: 'job', payload });
  });
}

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function wfile(p, bytes, fill) {
  mkdir(path.dirname(p));
  fs.writeFileSync(p, Buffer.alloc(bytes, fill == null ? 0x41 : fill));
}

(async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-test-'));

  /* ===================== 1. 文件分类 ===================== */
  section('1. 文件分类与配色');
  ok(Category.ofFile('a.mp4') === 'video', 'a.mp4 → 视频');
  ok(Category.ofFile('a.zip') === 'archive', 'a.zip → 压缩包');
  ok(Category.ofFile('a.msi') === 'installer', 'a.msi → 安装包');
  ok(Category.ofFile('a.png') === 'image', 'a.png → 图片');
  ok(Category.ofFile('a.pdf') === 'document', 'a.pdf → 文档');
  ok(Category.ofFile('a.dll') === 'program', 'a.dll → 程序');
  ok(Category.ofFile('a.log') === 'document', 'a.log → 文档（日志归入文档统计）');
  ok(Category.ofFile('noext') === 'other', '无后缀 → 其他');
  ok(Category.ofDir('Cache') === 'cache', '目录名 Cache → 缓存');
  ok(Category.colorOf('video') === '#e0567a', '视频配色固定');
  ok(Category.LIST.length === 9, '共 9 个分类（含音频）');

  /* ===================== 2. 安全分级 ===================== */
  section('2. 安全防误删分级');
  const E = process.env;
  const sysRoot = E.SystemRoot || 'C:\\Windows';
  const pf = E.ProgramFiles || 'C:\\Program Files';
  const up = E.USERPROFILE || path.join(os.homedir());
  const tmpEnv = E.TEMP || os.tmpdir();

  const cases = [
    [path.join(sysRoot, 'System32', 'kernel.dll'), false, 'red', 'System32 下的 dll'],
    [path.join(pf, 'App', 'app.exe'), false, 'red', 'Program Files 下的一切'],
    [path.join(sysRoot, 'WinSxS', 'a.manifest'), false, 'red', 'WinSxS 锁定'],
    [path.join(sysRoot, 'Temp', 'x.tmp'), false, 'green', 'Windows\\Temp 例外放行'],
    [path.join(sysRoot, 'SoftwareDistribution', 'Download', 'a.cab'), false, 'green', '更新下载缓存'],
    [path.join(tmpEnv, 'x.log'), false, 'green', '%TEMP% 日志'],
    [path.join(up, 'Downloads', 'a.zip'), false, 'yellow', '下载目录个人文件'],
    [path.join(up, 'Desktop', 'a.iso'), false, 'yellow', '桌面个人文件']
  ];
  for (const [p, isDir, want, desc] of cases) {
    const r = Safety.evaluate(p, isDir);
    ok(r.level === want, desc + ' → ' + r.level + '（期望 ' + want + '）');
  }
  ok(Safety.isLocked(path.join(pf, 'a.exe'), false) === true, 'Program Files 内文件被锁定');
  ok(Safety.isLocked(path.join(tmpEnv, 'a.log'), false) === false, '临时目录文件未被锁定');

  /* ===================== 3. 目录树扫描 ===================== */
  section('3. 目录树扫描（Worker）');
  const scanRoot = path.join(tmp, 'tree');
  wfile(path.join(scanRoot, 'a', 'big.bin'), 3 * 1024 * 1024, 1);
  wfile(path.join(scanRoot, 'a', 'small.txt'), 120, 2);
  wfile(path.join(scanRoot, 'c', 'd', 'mid.bin'), 1536 * 1024, 3);
  wfile(path.join(scanRoot, 'c', 'd', 'e', 'tiny.dat'), 10, 4);
  wfile(path.join(scanRoot, 'movie.mp4'), 2 * 1024 * 1024, 5);

  const res = await runJob({
    mode: 'tree', roots: [scanRoot], keepBytes: 1024 * 1024,
    ignoreDirs: [], ignoreExts: [], skipSystemHeavy: true
  });
  const expectBytes = 3 * 1024 * 1024 + 120 + 1536 * 1024 + 10 + 2 * 1024 * 1024;

  ok(res.counters.files === 5, '共扫描 5 个文件，实际 ' + res.counters.files);
  ok(res.counters.bytes === expectBytes, '体积汇总正确：' + res.counters.bytes + ' / ' + expectBytes);
  ok(res.counters.errors === 0, '无权限错误');
  ok(res.files.length === 3, '保留 ≥1MB 的文件 3 个（其余只计入统计），实际 ' + res.files.length);
  ok(res.dirs.length >= 5, '目录节点 ≥5 个，实际 ' + res.dirs.length);
  const ts = {};
  for (const t of res.typeStats) ts[t[0]] = t[2];
  ok(!!ts.bin && !!ts.txt && !!ts.mp4 && !!ts.dat, '类型统计含 bin/txt/mp4/dat');
  ok(ts.mp4 === 2 * 1024 * 1024, 'mp4 体积统计正确');

  const ds = new Dataset().load(res);
  ok(ds.ready, '数据集载入成功');
  const top = ds.children(0);
  ok(top.length === 1 && top[0].kind === 'dir', '虚拟根下只有一个扫描根');
  const lvl1 = ds.children(top[0].id);
  ok(lvl1.length === 3, '根下 3 个子项（a / c / movie.mp4），实际 ' + lvl1.length);
  ok(lvl1[0].size >= lvl1[1].size, '子项按体积倒序');
  const tf = ds.topFiles(30, 'size');
  ok(tf.length === 3 && tf[0].name === 'big.bin', 'TOP 文件第一是 big.bin，实际 ' + (tf[0] && tf[0].name));
  const tf2 = ds.topFiles(30, 'mtime');
  ok(tf2.length === 3, '按时间排序也能返回 3 条');
  const cats = ds.categoryStats();
  ok(cats.length >= 2 && cats[0].size >= cats[cats.length - 1].size, '分类统计按体积倒序');
  const ts2 = ds.typeStatsTop(12);
  ok(ts2.length === 4, '类型统计 4 类，实际 ' + ts2.length);
  ok(ds.summary({ total: 0, free: 0 }).fileCount === 5, '汇总文件数正确');

  /* ===================== 4. 垃圾规则 ===================== */
  section('4. 智能垃圾识别规则');
  const junkRoot = path.join(tmp, 'junk');
  wfile(path.join(junkRoot, 'cache', 'a.tmp'), 2048, 6);
  wfile(path.join(junkRoot, 'logs', 'run.log'), 1024, 7);
  wfile(path.join(junkRoot, 'keep.txt'), 512, 8);
  mkdir(path.join(junkRoot, 'emptyfolder'));

  // 以「个人目录」身份扫描：只有日志/空目录规则会命中，普通 txt 不应被误判
  const jres = await runJob({
    mode: 'junk',
    targets: [{ path: junkRoot, tag: 'personal', maxDepth: 4 }],
    cfg: { idleDays: 180, bigFileBytes: 100 * 1024 * 1024 },
    ignoreDirs: [], ignoreExts: []
  });
  const found = jres.items || [];
  ok(found.length >= 2, '命中至少 2 项垃圾（tmp/log/空目录），实际 ' + found.length);
  ok(found.some(i => i.path.endsWith('a.tmp')), 'a.tmp 被识别为临时文件');
  ok(found.some(i => i.rule === 'emptyDir'), '空文件夹被识别');
  ok(!found.some(i => i.path.endsWith('keep.txt')), '普通 txt 不算垃圾');

  // 同一目录被声明两次（等价于 %TEMP% 与 %LOCALAPPDATA%\Temp 指向同一处）不应重复计数
  const jresDup = await runJob({
    mode: 'junk',
    targets: [
      { path: path.join(junkRoot, 'logs'), tag: 'sysTemp', maxDepth: 2 },
      { path: path.join(junkRoot, 'logs'), tag: 'sysTemp', maxDepth: 2 }
    ],
    cfg: { idleDays: 180, bigFileBytes: 100 * 1024 * 1024 },
    ignoreDirs: [], ignoreExts: []
  });
  ok(jresDup.items.length <= 2, '重复目标不会导致条目翻倍（实际 ' + jresDup.items.length + ' 项）');
  ok(Rules.buildTargets({ temp: 'c:\\t', localAppData: 'c:\\t' }, ['C:'], {}).filter(t => t.path === 'c:\\t').length === 1,
    'buildTargets 会剔除重复目标');

  // 过期安装包 / 闲置大文件
  const old = path.join(tmp, 'old');
  wfile(path.join(old, 'setup.msi'), 2048, 9);
  const oldTime = (Date.now() - 400 * 86400000) / 1000;
  fs.utimesSync(path.join(old, 'setup.msi'), oldTime, oldTime);
  const jres2 = await runJob({
    mode: 'junk',
    targets: [{ path: old, tag: 'personal', maxDepth: 2 }],
    cfg: { idleDays: 180, bigFileBytes: 1024 },
    ignoreDirs: [], ignoreExts: []
  });
  ok((jres2.items || []).some(i => i.rule === 'oldInstaller'), '400 天未动的 msi 命中过期安装包');

  // 分组与汇总
  const grouped = cleaner.group([
    { path: 'a', size: 100, rule: 'sysTemp', category: '系统临时文件', level: 'green', mtime: Date.now() },
    { path: 'b', size: 200, rule: 'sysTemp', category: '系统临时文件', level: 'green', mtime: Date.now() },
    { path: 'c', size: 300, rule: 'idleBig', category: '长期闲置大文件', level: 'yellow', mtime: Date.now() },
    { path: 'd', size: 400, rule: 'log', category: '日志', level: 'red', mtime: Date.now() }
  ]);
  ok(grouped.groups.length === 3, '分出 3 个类别组，实际 ' + grouped.groups.length);
  ok(grouped.safeSize === 300, '绿色合计 300，实际 ' + grouped.safeSize);
  ok(grouped.warnSize === 300, '黄色合计 300，实际 ' + grouped.warnSize);
  ok(grouped.lockedSize === 400, '红色合计 400，实际 ' + grouped.lockedSize);
  ok(grouped.groups[0].level === 'green', '安全组排在最前');

  /* ===================== 5. 重复文件 ===================== */
  section('5. 重复文件（体积分桶 + 多线程 MD5）');
  const dupRoot = path.join(tmp, 'dup');
  const content = crypto.randomBytes(4096);
  wfile(path.join(dupRoot, 'one.bin'), 0, 0); fs.writeFileSync(path.join(dupRoot, 'one.bin'), content);
  wfile(path.join(dupRoot, 'two.bin'), 0, 0); fs.writeFileSync(path.join(dupRoot, 'two.bin'), content);
  wfile(path.join(dupRoot, 'sub', 'three.bin'), 0, 0); mkdir(path.join(dupRoot, 'sub')); fs.writeFileSync(path.join(dupRoot, 'sub', 'three.bin'), content);
  fs.writeFileSync(path.join(dupRoot, 'unique.bin'), crypto.randomBytes(4096));

  const flat = await runJob({ mode: 'flat', roots: [dupRoot], minBytes: 1, maxFiles: 1000, ignoreDirs: [] });
  ok(flat.files.length === 4, '扁平扫描到 4 个文件，实际 ' + flat.files.length);

  const pool = new Pool(2, () => { });
  const dres = await dup.findDuplicates(flat.files, pool, () => { });
  pool.destroy();
  ok(dres.groups.length === 1, '识别出 1 组重复，实际 ' + dres.groups.length);
  ok(dres.groups[0] && dres.groups[0].count === 3, '重复组含 3 个文件，实际 ' + (dres.groups[0] && dres.groups[0].count));
  ok(dres.groups[0] && dres.groups[0].files[0].keep === true, '默认保留修改最早的一份');
  ok(dres.waste === 4096 * 2, '可释放空间 = 2 份 × 4096，实际 ' + dres.waste);

  /* ===================== 6. 容错 ===================== */
  section('6. 容错：不存在的目录 / 无权限');
  const bad = await runJob({ mode: 'tree', roots: [path.join(tmp, 'not-exist-xyz')], keepBytes: 1, ignoreDirs: [], ignoreExts: [] });
  ok(bad && bad.counters.files === 0, '扫描不存在的目录不崩溃');
  ok(bad.counters.errors >= 1, '错误被记录而非抛出');

  // 清理
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

  console.log('\n===============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('===============================');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('自测异常：', e);
  process.exit(1);
});
