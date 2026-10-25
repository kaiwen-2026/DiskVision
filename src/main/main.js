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
