/**
 * 磁盘信息：盘符探测 + 容量/剩余统计
 * ------------------------------------------------------------------
 * 优先使用 Node 原生 fs.statfsSync（Node >= 18.15，Electron 28 自带 Node 18.18）；
 * 取不到时降级到 wmic，再不行返回 0（界面显示“未知”，不崩溃）。
 */
const fs = require('fs');
const { execSync } = require('child_process');

/** 探测本机可用固定盘符：C: D: E: … */
function listDrives() {
  const out = [];
  for (let i = 67; i <= 90; i++) {            // 'C' ~ 'Z'
    const letter = String.fromCharCode(i);
    const mount = letter + ':\\';
    try {
      if (fs.statfsSync) fs.statfsSync(mount);
      else if (!fs.existsSync(mount)) continue;
      out.push({ letter, mount });
    } catch (e) {
      // 无盘或不可访问
    }
  }
  return out;
}

/** 单个盘的容量信息（字节） */
function info(mount) {
  if (fs.statfsSync) {
    try {
      const s = fs.statfsSync(mount);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const used = Math.max(0, total - free);
      return { mount, total, free, used, usedPercent: total ? +(used / total * 100).toFixed(2) : 0 };
    } catch (e) { /* 落到 wmic */ }
  }
  try {
    const id = mount.replace('\\', '');
    const raw = execSync(
      `wmic logicaldisk where "DeviceID='${id}'" get Size,FreeSpace /format:csv`,
      { windowsHide: true, timeout: 5000 }
    ).toString();
    const line = raw.split(/\r?\n/).filter(l => l.includes(id))[0];
    if (line) {
      const p = line.trim().split(',');
      const free = Number(p[p.length - 1]) || 0;
      const total = Number(p[p.length - 2]) || 0;
      const used = Math.max(0, total - free);
      return { mount, total, free, used, usedPercent: total ? +(used / total * 100).toFixed(2) : 0 };
    }
  } catch (e) { /* 忽略 */ }
  return { mount, total: 0, free: 0, used: 0, usedPercent: 0 };
}

module.exports = { listDrives, info };
