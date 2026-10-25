/**
 * 生成打包用的图标 build/icon.ico
 * ------------------------------------------------------------------
 * 纯 Node 原生实现（zlib + Buffer），不依赖任何图形库。
 * 图标内容：品牌渐变底 + 白色圆环（呼应「磁盘可视化」）。
 * 若你想换成自己的图标，直接用同名文件覆盖 build/icon.ico 即可（建议 256×256）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SIZE = 64;

/** 画一张 64×64 的 RGBA 位图（左上角为原点） */
function draw() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 2;
  const rOut = SIZE * 0.30, rIn = SIZE * 0.15;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      // 圆角矩形背景 + 斜向渐变
      const inRound = (() => {
        const r = 10;
        const dx = Math.min(x, SIZE - 1 - x), dy = Math.min(y, SIZE - 1 - y);
        if (dx >= r || dy >= r) return true;
        return (r - dx) * (r - dx) + (r - dy) * (r - dy) <= r * r;
      })();
      let a = 0, b = 0, c = 0, al = 0;
      if (inRound) {
        const t = (x + y) / (2 * SIZE);
        // #4c8dff → #9b8bf0
        const r0 = 0x4c + (0x9b - 0x4c) * t;
        const g0 = 0x8d + (0x8b - 0x8d) * t;
        const b0 = 0xff + (0xf0 - 0xff) * t;
        a = r0; b = g0; c = b0; al = 255;
      }

      // 白色圆环
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (d <= rOut && d >= rIn) { a = 255; b = 255; c = 255; al = 255; }
      // 圆心留白（像饼图的一块被挖掉）
      if (d < rIn * 0.55 && x > cx && y < cy) { a = 0x4c; b = 0x8d; c = 0xff; al = 255; }

      px[i] = c; px[i + 1] = b; px[i + 2] = a; px[i + 3] = al;   // BGRA
    }
  }
  return px;
}

/** RGBA(自下而上) → ICO(BMP/DIB, 32bpp + AND mask) */
function buildIco(px) {
  const w = SIZE, h = SIZE;
  // BITMAPINFOHEADER
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(w, 4);
  dib.writeInt32LE(h * 2, 8);      // XOR + AND
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);        // BI_RGB
  dib.writeUInt32LE(w * h * 4, 20);

  // 转成自下而上
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    px.copy(xor, y * w * 4, srcRow, srcRow + w * 4);
  }
  // AND mask：全 0（不透明），每行补齐到 4 字节
  const rowBytes = Math.ceil(w / 32) * 4;
  const andMask = Buffer.alloc(rowBytes * h, 0);

  const img = Buffer.concat([dib, xor, andMask]);

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);         // type: icon
  dir.writeUInt16LE(1, 4);         // count
  const ent = Buffer.alloc(16);
  ent.writeUInt8(w, 0);
  ent.writeUInt8(h, 1);
  ent.writeUInt8(0, 2);
  ent.writeUInt8(0, 3);
  ent.writeUInt16LE(1, 4);
  ent.writeUInt16LE(32, 6);
  ent.writeUInt32LE(img.length, 8);
  ent.writeUInt32LE(22, 12);

  return Buffer.concat([dir, ent, img]);
}

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildIco(draw()));
console.log('[make-icon] 已生成 ' + out + ' （' + fs.statSync(out).size + ' 字节）');
