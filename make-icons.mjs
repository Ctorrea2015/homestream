// One-time generator: renders a 192px + 512px PNG app icon (dark panel with a play triangle)
import zlib from "node:zlib";
import fs from "node:fs";

function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeIcon(size) {
  // RGBA buffer
  const px = Buffer.alloc(size * size * 4);
  const bg = [16, 20, 27, 255];      // #10141b dark panel
  const fg = [59, 130, 246, 255];    // #3b82f6 blue
  const border = [42, 51, 66, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded corners
      const r = size * 0.18;
      const inCorner =
        ((x < r) && (y < r) && Math.hypot(x - r, y - r) > r) ||
        ((x > size - r) && (y < r) && Math.hypot(x - (size - r), y - r) > r) ||
        ((x < r) && (y > size - r) && Math.hypot(x - r, y - (size - r)) > r) ||
        ((x > size - r) && (y > size - r) && Math.hypot(x - (size - r), y - (size - r)) > r);
      if (inCorner) { px[i + 3] = 0; continue; } // transparent
      // play triangle centered
      const cx = size * 0.56, cy = size * 0.5;
      const dx = x - cx, dy = y - cy;
      const s = size * 0.22;
      const inside =
        dx <= s * 0.9 &&
        dx >= -s * 0.75 &&
        Math.abs(dy) <= (s * 0.9 - dx) * (s / (s * 1.65));
      px[i] = inside ? fg[0] : bg[0];
      px[i + 1] = inside ? fg[1] : bg[1];
      px[i + 2] = inside ? fg[2] : bg[2];
      px[i + 3] = 255;
      void border;
    }
  }
  // assemble PNG
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/icon-192.png", makeIcon(192));
fs.writeFileSync("public/icon-512.png", makeIcon(512));
console.log("icons written:", fs.statSync("public/icon-192.png").size, fs.statSync("public/icon-512.png").size);
