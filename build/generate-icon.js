'use strict';

// Generates a 1024x1024 RGBA PNG app icon (gradient rounded square) with no
// external dependencies, by hand-encoding a PNG via zlib. Output: build/icon-1024.png
// Then iconutil compiles the .iconset into icon.icns (see build step).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const RADIUS = 200;

// colors (RGB)
const c1 = [61, 123, 255];   // #3d7bff
const c2 = [138, 92, 255];   // #8a5cff

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function inRounded(x, y) {
  const r = RADIUS;
  // distance into rounded-rect mask (with light anti-aliasing)
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= r - 1) return 1;
  if (d >= r + 1) return 0;
  return (r + 1 - d) / 2;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter type 0
  for (let x = 0; x < SIZE; x++) {
    const t = (x + y) / (2 * SIZE);
    const alpha = inRounded(x + 0.5, y + 0.5);
    raw[p++] = lerp(c1[0], c2[0], t);
    raw[p++] = lerp(c1[1], c2[1], t);
    raw[p++] = lerp(c1[2], c2[2], t);
    raw[p++] = Math.round(255 * alpha);
  }
}

// CRC32
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, 'icon-1024.png');
fs.writeFileSync(outPath, png);
console.log('wrote', outPath, png.length, 'bytes');
