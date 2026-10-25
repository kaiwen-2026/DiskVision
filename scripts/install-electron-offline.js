/**
 * 离线安装 Electron 运行时（完全不联网）
 * ==================================================================
 * 背景：
 *   electron 的 npm 包本身只有 ~100KB，真正 100MB+ 的运行时是 postinstall 阶段
 *   由 @electron/get 从 GitHub 下载的。如果你已经有官方 zip，或已经解压好的目录，
 *   就不需要再下载。
 *
 * 用法（在项目根目录执行）：
 *   node scripts/install-electron-offline.js                        # 自动搜索常见位置
 *   node scripts/install-electron-offline.js D:\dl\electron-v28.3.3-win32-x64.zip
 *   node scripts/install-electron-offline.js D:\dl\electron-v45.0.0-win32-x64   # 已解压目录也行
 *   node scripts/install-electron-offline.js --check ...            # 只校验，不安装
 *   ELECTRON_ZIP=D:\dl\xxx.zip node scripts/install-electron-offline.js
 *
 * 四道校验（任何一道不过就跳过这个文件，绝不把坏二进制装进去）：
 *   ① ZIP 结构完整 —— 尾部能找到中央目录结束标记（能识别下载中断的半截包）
 *   ② 目录完整 —— electron.exe + icudtl.dat + resources/default_app.asar + Chromium dll 齐全
 *   ③ 有效 PE —— electron.exe 有合法的 MZ / PE 头
 *   ④ 真能运行 —— 执行 electron.exe --version 必须输出 vX.Y.Z
 *
 * 搜索顺序：命令行参数 → ELECTRON_ZIP → %LOCALAPPDATA%\electron\Cache
 *          → 项目内 electron-cache/ → 下载目录 → %TEMP%\electron-download-*
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON_PKG = path.join(ROOT, 'node_modules', 'electron');
const DIST = path.join(ELECTRON_PKG, 'dist');
const TMP = path.join(ROOT, 'node_modules', '.electron-extract-tmp');
const SYS_TAR = 'C:\\Windows\\System32\\tar.exe';

const CHECK_ONLY = process.argv.includes('--check');
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'));

// Electron 运行时根目录里必然存在的文件（缺少任意一个说明包不对或不完整）
const REQUIRED_FILES = [
  'electron.exe',
  'icudtl.dat',
  path.join('resources', 'default_app.asar')
];
// 至少要有这些之一（不同版本命名略有差异）
const REQUIRED_ANY = ['ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll', 'vk_swiftshader.dll'];

function log(msg) { console.log('[electron-offline] ' + msg); }
function die(msg, code) { console.error('[electron-offline] ✗ ' + msg); process.exit(code || 1); }

/* ----------------------- 0. 前置检查 ----------------------- */
if (!fs.existsSync(ELECTRON_PKG)) {
  die('找不到 node_modules/electron。请先执行：\n' +
    '  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install\n' +
    '（Windows cmd：set ELECTRON_SKIP_BINARY_DOWNLOAD=1 && npm install）');
}

let pkgVersion = '?';
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(ELECTRON_PKG, 'package.json'), 'utf8')).version;
} catch (e) { /* 忽略 */ }

/* ----------------------- 1. 收集候选 ----------------------- */
function collectCandidates() {
  const out = [];
  const seen = new Set();

  const push = (p, from) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    let st;
    try { st = fs.statSync(abs); } catch (e) { return; }

    if (st.isDirectory()) {
      // 允许直接传「已解压好的运行时目录」
      if (!fs.existsSync(path.join(abs, 'electron.exe'))) return;
      seen.add(abs);
      out.push({ path: abs, from: from, kind: 'dir' });
      return;
    }
    if (!st.isFile() || !/\.zip$/i.test(abs)) return;
    seen.add(abs);
    out.push({ path: abs, from: from, kind: 'zip' });
  };

  ARGS.forEach(a => push(a, '命令行参数'));
  push(process.env.ELECTRON_ZIP, '环境变量 ELECTRON_ZIP');

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cacheDir = path.join(localAppData, 'electron', 'Cache');
  push(path.join(cacheDir, `electron-v${pkgVersion}-win32-x64.zip`), 'electron 官方缓存');

  const scanDir = (dir, from) => {
    if (!dir || !fs.existsSync(dir)) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names) {
      const full = path.join(dir, n);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory() && /^electron-v.*-win32-x64$/i.test(n)) { push(full, from + '（已解压）'); continue; }
      if (st.isFile() && /^electron-v.*-win32-x64\.zip$/i.test(n)) push(full, from);
    }
  };
  scanDir(cacheDir, 'electron 官方缓存');
  scanDir(path.join(ROOT, 'electron-cache'), '项目内 electron-cache/');
  scanDir(path.join(os.homedir(), 'Downloads'), '下载目录');

  // %TEMP%\electron-download-xxxx\ —— npm 中断后会残留半截文件，也当候选（但会被校验拦下）
  const tmpRoot = process.env.TEMP || os.tmpdir();
  if (fs.existsSync(tmpRoot)) {
    let dirs = [];
    try { dirs = fs.readdirSync(tmpRoot); } catch (e) { dirs = []; }
    for (const d of dirs) {
      if (/^electron-download-/i.test(d)) scanDir(path.join(tmpRoot, d), '中断的临时下载目录');
    }
  }
  return out;
}

/* ----------------------- 2. 校验工具 ----------------------- */

/** ① ZIP 结构完整性：尾部 64KB 内必须有 EOCD 标记 PK\x05\x06 */
function checkZipStructure(p) {
  const size = fs.statSync(p).size;
  if (size < 1024) return { ok: false, reason: '文件过小（' + size + ' 字节），不是有效压缩包' };
  const tailLen = Math.min(size, 65557);
  const buf = Buffer.alloc(tailLen);
  const fd = fs.openSync(p, 'r');
  try { fs.readSync(fd, buf, 0, tailLen, size - tailLen); } finally { fs.closeSync(fd); }

  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);   // PK\005\006
  if (buf.lastIndexOf(sig) < 0) {
    return {
      ok: false,
      reason: '压缩包不完整（找不到中央目录结束标记）—— 典型的下载中断残留，仅 ' +
        (size / 1048576).toFixed(1) + ' MB，官方 zip 通常 >90 MB'
    };
  }
  return { ok: true };
}

/** ② 目录内容：是不是一套完整的 Electron 运行时 */
function checkDistLayout(dir) {
  for (const f of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, f))) {
      return { ok: false, reason: '缺少 ' + f + '（不是 Electron 运行时，或解压不完整）' };
    }
  }
  if (!REQUIRED_ANY.some(f => fs.existsSync(path.join(dir, f)))) {
    return { ok: false, reason: '缺少 Chromium 运行时 dll（' + REQUIRED_ANY.join(' / ') + '）' };
  }
  return { ok: true };
}

/** ③ 是不是有效的 PE 可执行文件 */
function checkPeExe(p) {
  if (!fs.existsSync(p)) return { ok: false, reason: 'electron.exe 不存在' };
  const fd = fs.openSync(p, 'r');
  try {
    const head = Buffer.alloc(0x40);
    fs.readSync(fd, head, 0, 0x40, 0);
    if (head[0] !== 0x4d || head[1] !== 0x5a) return { ok: false, reason: 'electron.exe 不是 MZ 可执行文件' };
    const eLfanew = head.readUInt32LE(0x3c);
    if (eLfanew <= 0 || eLfanew > 0x10000000) return { ok: false, reason: 'electron.exe 的 PE 头偏移非法' };
    const sig = Buffer.alloc(4);
    fs.readSync(fd, sig, 0, 4, eLfanew);
    if (!(sig[0] === 0x50 && sig[1] === 0x45 && sig[2] === 0 && sig[3] === 0)) {
      return { ok: false, reason: 'electron.exe 缺少 PE 签名（文件已损坏）' };
    }
  } finally { fs.closeSync(fd); }
  return { ok: true };
}

/** ④ 真能跑起来：--version 必须输出 vX.Y.Z */
function probeVersion(exe) {
  // 关键：必须清掉 ELECTRON_RUN_AS_NODE。
  // 该变量为真时 electron.exe 会以 Node 模式启动，--version 打印的是内置 Node 版本
  // （例如 Electron 45 内置 Node 24.22.0，会误报成 v24.22.0），导致版本判断完全错位。
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.ELECTRON_ENABLE_STACK_DUMPING;

  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 25000, windowsHide: true, env });
  const out = String((r && r.stdout) || '').trim();
  const m = out.match(/v\d+\.\d+\.\d+/);
  if (!m) {
    const why = r && r.signal ? ('进程崩溃，信号 ' + r.signal)
      : r && r.status != null ? ('退出码 ' + r.status) : '无输出';
    return { ok: false, reason: 'electron.exe 无法运行（' + why + '），二进制已损坏' };
  }
  return { ok: true, version: m[0] };
}

/** 运行时目录里通常带一个 version 文件，用来交叉验证 */
function readVersionFile(dir) {
  try {
    const v = fs.readFileSync(path.join(dir, 'version'), 'utf8').trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch (e) { return null; }
}

/* ----------------------- 3. 解压 / 复制 ----------------------- */
function extract(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (fs.existsSync(SYS_TAR)) {
    try { execFileSync(SYS_TAR, ['-xf', zip, '-C', dest], { stdio: 'pipe' }); return 'Windows bsdtar'; }
    catch (e) { /* 继续 */ }
  }
  try { execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'pipe' }); return 'tar'; }
  catch (e) { /* 继续 */ }
  // 兜底；注意 PowerShell 对损坏的 zip 可能不报错，所以后面必须做内容校验
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`
  ], { stdio: 'pipe' });
  return 'PowerShell Expand-Archive';
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }

/* ----------------------- 4. 主流程 ----------------------- */
const cands = collectCandidates();
if (!cands.length) {
  die('没找到任何 Electron 运行时（zip 或已解压目录）。\n' +
    '需要的文件（注意不是 chromedriver）：\n' +
    `  https://npmmirror.com/mirrors/electron/${pkgVersion}/electron-v${pkgVersion}-win32-x64.zip\n` +
    `  https://github.com/electron/electron/releases/download/v${pkgVersion}/electron-v${pkgVersion}-win32-x64.zip\n` +
    '放到下面任一位置后重跑本脚本：\n' +
    `  ${path.join(process.env.LOCALAPPDATA || '%LOCALAPPDATA%', 'electron', 'Cache')}\n` +
    `  ${path.join(ROOT, 'electron-cache')}`);
}

log('候选 ' + cands.length + ' 个' + (CHECK_ONLY ? '（--check 只校验，不安装）' : '') + '：');
for (const c of cands) {
  const size = c.kind === 'dir'
    ? fs.readdirSync(c.path).length + ' 个文件'
    : (fs.statSync(c.path).size / 1048576).toFixed(1) + ' MB';
  log('  · [' + c.kind + '] ' + size + '  ' + c.path + '  （' + c.from + '）');
}

let found = null;

for (const c of cands) {
  log('— 检查 ' + path.basename(c.path));
  let workDir = null;

  if (c.kind === 'zip') {
    const st = checkZipStructure(c.path);
    if (!st.ok) { log('  ① ✗ ' + st.reason + '，跳过'); continue; }
    log('  ① ✓ ZIP 结构完整');

    rmrf(TMP);
    try {
      const how = extract(c.path, TMP);
      log('  ② 解压完成（' + how + '）');
      workDir = TMP;
    } catch (e) {
      log('  ② ✗ 解压失败：' + String((e && e.message) || e).split('\n')[0] + '，跳过');
      rmrf(TMP);
      continue;
    }
  } else {
    workDir = c.path;
    log('  ① ✓ 已解压目录，无需解压');
  }

  const lay = checkDistLayout(workDir);
  if (!lay.ok) {
    log('  ② ✗ ' + lay.reason + '，跳过');
    let top = [];
    try { top = fs.readdirSync(workDir).slice(0, 8); } catch (e) { top = []; }
    if (top.length) log('     实际内容：' + top.join(', '));
    rmrf(TMP);
    continue;
  }
  log('  ② ✓ 目录完整（electron.exe / icudtl.dat / default_app.asar / Chromium dll 齐全）');

  const pe = checkPeExe(path.join(workDir, 'electron.exe'));
  if (!pe.ok) { log('  ③ ✗ ' + pe.reason + '，跳过'); rmrf(TMP); continue; }
  log('  ③ ✓ electron.exe 是有效的 PE 可执行文件');

  const probe = probeVersion(path.join(workDir, 'electron.exe'));
  if (!probe.ok) { log('  ④ ✗ ' + probe.reason + '，跳过'); rmrf(TMP); continue; }
  log('  ④ ✓ 运行自检通过：' + probe.version);

  const fileVer = readVersionFile(workDir);
  if (fileVer) {
    const same = ('v' + fileVer) === probe.version;
    log('     version 文件：' + fileVer + (same ? '（与二进制一致）' : '，与二进制不一致，以二进制为准'));
  }

  found = { cand: c, workDir: workDir, version: probe.version };
  break;
}

if (!found) {
  rmrf(TMP);
  die('没有任何候选是完整可用的 Electron 运行时。');
}

/* ----------------------- 5. 安装 ----------------------- */
if (CHECK_ONLY) {
  rmrf(TMP);
  log('');
  log('✓ 校验通过：' + found.cand.path);
  log('  Electron ' + found.version + '，可直接安装（去掉 --check 再跑一次）');
  process.exit(0);
}

rmrf(DIST);
if (found.cand.kind === 'zip') {
  fs.renameSync(TMP, DIST);
} else {
  log('  复制到 ' + DIST + '（请稍等）…');
  fs.cpSync(found.workDir, DIST, { recursive: true });
  rmrf(TMP);
}
fs.writeFileSync(path.join(ELECTRON_PKG, 'path.txt'), 'electron.exe', 'utf8');

const exePath = path.join(DIST, 'electron.exe');
log('');
log('✓ 已安装：' + DIST);
log('✓ electron.exe ' + (fs.statSync(exePath).size / 1048576).toFixed(1) + ' MB，path.txt 已写入');
log('✓ 运行版本：' + found.version + '（npm 包声明 ' + pkgVersion + '）');

const bare = String(found.version).replace(/^v/, '');
if (pkgVersion !== '?' && bare !== pkgVersion) {
  console.log('\n[注意] npm 包版本 ' + pkgVersion + ' 与运行时 ' + found.version + ' 不一致。');
  console.log('       npm start / npm run dev 可正常运行；');
  console.log('       但 npm run dist 打包时 electron-builder 会按 package.json 里的版本另找运行时，');
  console.log('       想一致就把 devDependencies.electron 改成 "^' + bare + '"（必要时重新 npm install）。');
}

try {
  fs.writeFileSync(path.join(ELECTRON_PKG, '.offline-install.json'), JSON.stringify({
    source: found.cand.path,
    from: found.cand.from,
    pkgVersion: pkgVersion,
    electronVersion: found.version,
    installedAt: new Date().toISOString()
  }, null, 2), 'utf8');
} catch (e) { /* 忽略 */ }

console.log('\n[electron-offline] 完成，现在可以 npm start 了。');
