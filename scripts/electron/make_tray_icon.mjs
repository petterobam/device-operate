// Generates build/trayTemplate.png: a 22x22 black ring used as the macOS menu
// bar template image (macOS recolors template images automatically).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const size = 22;
const center = (size - 1) / 2;
const raw = Buffer.alloc(size * (size * 4 + 1));

for (let y = 0; y < size; y += 1) {
  const rowStart = y * (size * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < size; x += 1) {
    const distance = Math.hypot(x - center, y - center);
    const inside = distance <= 9.4 && distance >= 6.1;
    const offset = rowStart + 1 + x * 4;
    raw[offset] = 0;
    raw[offset + 1] = 0;
    raw[offset + 2] = 0;
    raw[offset + 3] = inside ? 255 : 0;
  }
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

let table = null;
function crc32(buffer) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0))
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = path.join(root, "build", "trayTemplate.png");
const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
if (existing && existing.equals(png)) {
  console.log(`tray icon unchanged: ${target}`);
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png);
  console.log(`wrote ${target} (${png.length} bytes)`);
}
