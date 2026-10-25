/**
 * DiskVision —— 主进程入口
 * ==================================================================
 * 设计原则：
 *   - 无后台驻留：窗口全关即退出，不注册自启、不开托盘常驻。
 *   - 无广告无弹窗：去掉默认菜单栏，界面里没有任何推广位。
 *   - 重度任务全部在工作线程，主进程只做转发，UI 永不冻结。
 */
'use strict';

// 必须在任何 fs 操作之前设置：扩大 libuv 线程池，加快异步 IO
process.env.UV_THREADPOOL_SIZE = String(Math.min(32, Math.max(8, (require('os').cpus() || []).length * 4 || 8)));

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const config = require('./config');
const { Scanner } = require('./scanner');
const ipc = require('./ipc');

/**
 * 兼容模式（受限环境专用）
 * ------------------------------------------------------------------
 * 适用范围：容器 / 沙箱 / 远程桌面（RDP）/ 老旧或异常的显卡驱动 / 某些杀软环境。
 * 症状：正常启动时报
 *   GPU process exited unexpectedly: exit_code=-1073741819
 *   FATAL: GPU process isn't usable. Goodbye.
 * 然后进程直接退出，窗口根本不出现。
 *
 * 打开方式（任选其一）：
 *   npm start -- --safe-mode
 *   npm start -- --disable-gpu
 *   DV_SAFE_MODE=1 npm start
 * 打包后的 exe 同理：DiskVision.exe --safe-mode
 *
 * 关掉硬件加速对本程序几乎没有影响 —— UI 只用到 2D canvas（ECharts），
 * 树图渲染走软件光栅一样流畅，还能顺便省掉 GPU 进程的内存占用。
 */
const SAFE_MODE = process.argv.includes('--safe-mode')
  || process.argv.includes('--disable-gpu')
  || process.env.DV_SAFE_MODE === '1';

// 兜底提示：如果环境里设了 ELECTRON_RUN_AS_NODE=1，electron 会以纯 Node 模式加载本文件，
// require('electron') 返回的只是 exe 路径字符串（不是 API 对象），后面全都会 undefined。
// 这种时候给一句人话，比抛 "Cannot read properties of undefined" 好排查得多。
if (!app || typeof app.disableHardwareAcceleration !== 'function') {
  console.error('[DiskVision] 启动失败：当前处于 Node 模式，而不是 Electron 运行时。');
  console.error('  原因：环境变量 ELECTRON_RUN_AS_NODE 被设置了（有些终端 / CI / 沙箱会带）。');
  console.error('  解决：PowerShell 执行  $env:ELECTRON_RUN_AS_NODE=""   后重新 npm start');
  console.error('        cmd 执行         set ELECTRON_RUN_AS_NODE=      后重新 npm start');
  process.exit(1);
}

if (SAFE_MODE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
}

let win = null;
const scanner = new Scanner();

/** 当前生效配置（内存缓存，避免每次都读盘） */
let CFG = null;
function getConfig() { return CFG || (CFG = config.load()); }
function setConfig(patch) { CFG = Object.assign({}, getConfig(), patch || {}); config.save(CFG); return CFG; }

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0d1117',
    show: false,
    title: 'DiskVision - 磁盘可视化清理',
    autoHideMenuBar: true,          // 隐藏菜单栏（按 Alt 可临时呼出）
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  // 去掉默认菜单（文件/编辑/帮助…），保持专业工具观感
  try { win.setMenu(null); } catch (e) { /* 忽略 */ }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => { win.show(); });

  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(1);
  });

  // 外部链接用系统浏览器打开（本程序内不产生任何外链，仅作兜底）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:/i.test(url)) { shell.openExternal(url); }
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  config.init(app.getPath('userData'));
  getConfig();

  if (SAFE_MODE) console.log('[DiskVision] 兼容模式已启用（软件渲染 / 无 GPU 进程）');

  ipc.register({
    get win() { return win; },   // 用 getter，保证 IPC 层永远拿到当前窗口
    scanner,
    getConfig,
    setConfig
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** 窗口全关 → 直接退出，不留后台进程 */
app.on('window-all-closed', () => {
  scanner.cancel();
  scanner.destroy();
  app.quit();
});

/** 兜底：未捕获异常只记录，不弹窗打扰用户 */
process.on('uncaughtException', (err) => {
  console.error('[DiskVision] uncaughtException:', err && err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[DiskVision] unhandledRejection:', err && (err.message || err));
});
