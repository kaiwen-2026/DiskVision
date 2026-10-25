/**
 * postinstall：把 echarts 的 dist 拷到 src/renderer/vendor/
 * ------------------------------------------------------------------
 * 目的：运行时完全离线，打包时也不需要把 node_modules/echarts 打进 asar。
 * vendor 目录已随源码提供；只有当它缺失时才从 node_modules 恢复。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'echarts', 'dist', 'echarts.min.js');
const dst = path.join(root, 'src', 'renderer', 'vendor', 'echarts.min.js');

if (fs.existsSync(dst)) {
  console.log('[vendor-echarts] vendor/echarts.min.js 已存在，跳过');
  process.exit(0);
}
if (!fs.existsSync(src)) {
  console.warn('[vendor-echarts] 未找到 node_modules/echarts，请先执行 npm install');
  process.exit(0);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('[vendor-echarts] 已生成 src/renderer/vendor/echarts.min.js');
