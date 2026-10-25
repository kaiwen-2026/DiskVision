/**
 * 用户配置持久化（忽略列表 / 扫描参数）
 * ------------------------------------------------------------------
 * 存放在 Electron 的 userData 目录（%APPDATA%\disk-vision\config.json），
 * 不写注册表、不写安装目录，绿色版也照常工作。
 */
const fs = require('fs');
const path = require('path');
const Rules = require('../shared/rules');

let FILE = null;

/** 初始化（由 main.js 在 app.ready 后调用，传入 userData 目录） */
function init(userDataDir) {
  FILE = path.join(userDataDir, 'config.json');
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) { /* 忽略 */ }
}

const DEFAULTS = {
  ignoreDirs: Rules.DEFAULT_IGNORE_DIRS.slice(),   // 永不扫描的文件夹
  ignoreExts: Rules.DEFAULT_IGNORE_EXT.slice(),    // 永不清理的后缀
  idleDays: 180,          // 闲置大文件判定：多少天未修改
  bigFileMB: 100,         // 闲置大文件判定：超过多少 MB
  keepFileMB: 1,          // 扫描索引保留的文件阈值（小于此值的文件只计入统计，不进列表）
  dupMinMB: 1,            // 重复文件扫描的最小体积
  includePersonal: true,  // 垃圾扫描是否包含个人目录（下载/桌面/文档）
  skipSystemHeavy: true,  // 跳过 WinSxS / DriverStore 等超重系统目录
  toTrash: true,          // 删除时移入回收站
  lastDrives: ['C:']      // 上次选择的盘符
};

function load() {
  if (!FILE) return Object.assign({}, DEFAULTS);
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    return Object.assign({}, DEFAULTS, obj);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function save(cfg) {
  if (!FILE) return false;
  try {
    const merged = Object.assign({}, DEFAULTS, cfg || {});
    fs.writeFileSync(FILE, JSON.stringify(merged, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { init, load, save, DEFAULTS };
