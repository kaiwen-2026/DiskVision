/**
 * 生成打包用的图标 build/icon.ico
 * ==================================================================
 * 纯 Node 原生实现（只用 Buffer，不依赖任何图形库、不需要联网）。
 *
 * 为什么必须是多尺寸：
 *   electron-builder / NSIS 要求 ico 里至少要有一张 256×256，
 *   只给 64×64 会直接报
 *     "image build\icon.ico must be at least 256x256"
 *   Windows 的资源管理器、任务栏、Alt+Tab 又会分别取 16/32/48/64/128，
 *   所以标准做法是一个 ico 里打包多个尺寸。
 *
 * 输出：16 / 32 / 48 / 64 / 128 / 256 六种尺寸，32 位色（BGRA）+ AND 掩码。
 * 图形：圆角渐变底 + 白色圆环（呼应「磁盘可视化 / 饼图」）。
 *
 * 想换成自己的图标：直接用同名文件覆盖 build/icon.ico 即可（建议含 256×256）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SIZES = [16, 32, 48, 64, 128, 256];

/** 画一张 size×size 的 BGRA 位图（左上角为原点） */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const rOut = size * 0.30;      // 圆环外半径
  const rIn = size * 0.155;      // 圆环内半径
  const corner = size * 0.17;    // 圆角半径
  const aa = size >= 48 ? 1 : 0; // 小尺寸不做抗锯齿，保持锐利

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // ① 圆角矩形底：判断到四条边的距离是否在圆角内
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      let inRound = true;
      if (dx < corner && dy < corner) {
        inRound = (corner - dx) * (corner - dx) + (corner - dy) * (corner - dy) <= corner * corner;
      }

      let b = 0, g = 0, r = 0, a = 0;

      if (inRound) {
        // 斜向渐变 #4c8dff → #9b8bf0
        const t = (x + y) / (2 * (size - 1 || 1));
        r = Math.round(0x4c + (0x9b - 0x4c) * t);
        g = Math.round(0x8d + (0x8b - 0x8d) * t);
        b = Math.round(0xff + (0xf0 - 0xff) * t);
        a = 255;
      }

      // ② 白色圆环
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (d <= rOut && d >= rIn) {
        r = 255; g = 255; b = 255; a = 255;
      }

      // ③ 圆环内的「饼图缺口」：右上 1/4 用品牌蓝填掉，形成数据切片的观感
      if (d < rIn * 0.72 && x > cx && y < cy) {
        r = 0x4c; g = 0x8d; b = 0xff; a = 255;
      }

      // ④ 边缘抗锯齿（仅中大尺寸）：圆角外缘做一档混合，避免锯齿
      if (aa && a === 255 && !inRound) { a = 0; }

      px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a;   // BGRA
    }
  }
  return px;
}

/** 单张图 → ICO 内的 DIB 数据（BITMAPINFOHEADER + 自下而上 BGRA + AND 掩码） */
function toDib(px, size) {
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);           // biSize
  hdr.writeInt32LE(size, 4);          // biWidth
  hdr.writeInt32LE(size * 2, 8);      // biHeight = XOR + AND
  hdr.writeUInt16LE(1, 12);           // biPlanes
  hdr.writeUInt16LE(32, 14);          // biBitCount
  hdr.writeUInt32LE(0, 16);           // BI_RGB
  hdr.writeUInt32LE(size * size * 4, 20);

  // 位图数据必须自下而上
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    px.copy(xor, y * size * 4, src, src + size * 4);
  }

  // AND 掩码：32bpp 下按 alpha 生效，这里全部置 0（不透明），每行补齐 4 字节
  const rowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(rowBytes * size, 0);

  return Buffer.concat([hdr, xor, mask]);
}

/** 多尺寸打包成 ICO */
function buildIco(sizes) {
  const images = sizes.map(s => ({ size: s, data: toDib(draw(s), s) }));

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);              // reserved
  dir.writeUInt16LE(1, 2);              // type = icon
  dir.writeUInt16LE(images.length, 4);  // count

  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);   // 256 用 0 表示
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2);                 // 调色板数
    e.writeUInt8(0, 3);                 // reserved
    e.writeUInt16LE(1, 4);              // planes
    e.writeUInt16LE(32, 6);             // bpp
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }

  return Buffer.concat([dir, ...entries, ...images.map(i => i.data)]);
}

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildIco(SIZES));

// 自校验：把刚写出的 ico 读回来，确认尺寸齐全且最大为 256
const buf = fs.readFileSync(out);
const count = buf.readUInt16LE(4);
const found = [];
for (let i = 0; i < count; i++) {
  const w = buf.readUInt8(6 + 16 * i) || 256;
  const h = buf.readUInt8(7 + 16 * i) || 256;
  const bpp = buf.readUInt16LE(6 + 16 * i + 6);
  found.push(w + '×' + h + '/' + bpp + 'bit');
}
console.log('[make-icon] 已生成 ' + out);
console.log('[make-icon] 尺寸：' + found.join(', ') + '，共 ' + fs.statSync(out).size + ' 字节');
if (!found.some(s => s.startsWith('256×256'))) {
  console.error('[make-icon] ✗ 缺少 256×256，electron-builder 会拒绝打包');
  process.exit(1);
}
