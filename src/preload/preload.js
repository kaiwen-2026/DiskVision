/**
 * 预加载脚本（渲染进程与主进程之间唯一的桥）
 * ------------------------------------------------------------------
 * 开启 contextIsolation + 关闭 nodeIntegration，渲染层拿不到 require，
 * 只能通过 contextBridge 暴露下面这份白名单 API —— 最小权限原则。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /* ---------- 配置 ---------- */
  config: () => ipcRenderer.invoke('app:config'),
  saveConfig: (cfg) => ipcRenderer.invoke('app:config:save', cfg),

  /* ---------- 磁盘 ---------- */
  drives: () => ipcRenderer.invoke('sys:drives'),

  /* ---------- 扫描 ---------- */
  scanStart: (arg) => ipcRenderer.invoke('scan:start', arg),
  scanCancel: () => ipcRenderer.invoke('scan:cancel'),
  scanState: () => ipcRenderer.invoke('scan:state'),

  /* ---------- 树图 ---------- */
  treeChildren: (id) => ipcRenderer.invoke('tree:children', { id }),
  treeGoto: (p) => ipcRenderer.invoke('tree:goto', { path: p }),

  /* ---------- 数据 ---------- */
  topFiles: (arg) => ipcRenderer.invoke('data:topFiles', arg || {}),
  topDirs: (arg) => ipcRenderer.invoke('data:topDirs', arg || {}),
  typeStats: (arg) => ipcRenderer.invoke('data:typeStats', arg || {}),
  categoryStats: () => ipcRenderer.invoke('data:categoryStats'),
  extList: () => ipcRenderer.invoke('data:extList'),
  summary: (arg) => ipcRenderer.invoke('data:summary', arg || {}),

  /* ---------- 清理 ---------- */
  junkStart: (arg) => ipcRenderer.invoke('junk:start', arg || {}),
  junkClean: (arg) => ipcRenderer.invoke('junk:clean', arg || {}),
  dupStart: (arg) => ipcRenderer.invoke('dup:start', arg || {}),
  dupDelete: (arg) => ipcRenderer.invoke('dup:delete', arg || {}),

  /* ---------- 文件操作 ---------- */
  stat: (p) => ipcRenderer.invoke('fs:stat', { path: p }),
  reveal: (p) => ipcRenderer.invoke('fs:reveal', { path: p }),
  openDir: (p) => ipcRenderer.invoke('fs:open', { path: p }),
  copy: (t) => ipcRenderer.invoke('fs:copy', { text: t }),
  recycleBin: () => ipcRenderer.invoke('fs:recycleBin'),
  trash: (paths) => ipcRenderer.invoke('fs:trash', { paths }),

  /**
   * 订阅主进程推送的事件（扫描进度等）
   * @returns {function} 取消订阅函数
   */
  on: (channel, cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
