/**
 * ANA24 PWA / APK icon generator (pure Node — zero dependencies).
 *
 * Renders the ana24.svg brand mark into the PNG icons required for an
 * installable PWA and for Android APK wrapper builders (aiapkstudio.com etc.):
 *
 *   icon-192.png            brand mark (rounded navy tile) at 192px
 *   icon-512.png            brand mark (rounded navy tile) at 512px
 *   icon-maskable-512.png   full-bleed navy tile + glyph scaled into the
 *                           Android adaptive-icon safe zone (80% circle)
 *   apple-touch-icon.png    full-bleed 180px (iOS masks corners itself, so
 *                           no rounded corners / no transparency)
 *
 * The rasterizer is a simple 4x4 supersampled software renderer over the
 * 64x64 brand viewBox; the PNG writer uses node:zlib + a hand-rolled CRC32.
 * It is invoked automatically by a small Vite plugin (see vite.config.ts)
 * before every build, so the icons always land in dist/ — nothing binary is
 * ever committed. Run it standalone with: node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------- palette ------------------------------- */
const NAVY = [0x0b, 0x12, 0x20]; // #0b1220 — brand tile
const CYAN = [0x22, 0xd3, 0xee]; // #22d3ee — chart line
const GREEN = [0x4a, 0xde, 0x80]; // #4ade80 — signal dot

/* ----------------------------- shapes (64x64) --------------------------- */
const SEGS = [
  [14, 42, 26, 30],
  [26, 30, 34, 38],
  [34, 38, 50, 22],
];

function inRoundedRect(vx, vy) {
  const r = 14;
  const qx = Math.max(Math.abs(vx - 32) - (32 - r), 0);
  const qy = Math.max(Math.abs(vy - 32) - (32 - r), 0);
  return qx * qx + qy * qy <= r * r;
}

function distToGlyph(vx, vy) {
  let best = Infinity;
  for (const [x0, y0, x1, y1] of SEGS) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    let t = ((vx - x0) * dx + (vy - y0) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x0 + t * dx;
    const py = y0 + t * dy;
    const d2 = (vx - px) ** 2 + (vy - py) ** 2;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/* --------------------------- software rasterizer ------------------------ */
const SUB = [0.125, 0.375, 0.625, 0.875]; // 4x4 supersampling offsets

/**
 * @param {number} size  output edge in px
 * @param {{ rounded?: boolean, glyphScale?: number }} opts
 */
function renderMark(size, { rounded = true, glyphScale = 1 } = {}) {
  const scale = size / 64;
  const out = Buffer.alloc(size * size * 4);
  const samples = SUB.length ** 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covNavy = 0;
      let covCyan = 0;
      let covGreen = 0;
      for (const oy of SUB) {
        for (const ox of SUB) {
          const vx = (x + ox) / scale;
          const vy = (y + oy) / scale;
          if (rounded && !inRoundedRect(vx, vy)) continue;
          covNavy += 1;
          const gx = 32 + (vx - 32) * glyphScale;
          const gy = 32 + (vy - 32) * glyphScale;
          if (distToGlyph(gx, gy) <= 2) covCyan += 1;
          const ddx = gx - 50;
          const ddy = gy - 22;
          if (ddx * ddx + ddy * ddy <= 16) covGreen += 1;
        }
      }
      if (covNavy === 0) continue; // fully transparent (outside rounded tile)
      const i = (y * size + x) * 4;
      const color = covGreen > 0 ? GREEN : covCyan > 0 ? CYAN : NAVY;
      out[i] = color[0];
      out[i + 1] = color[1];
      out[i + 2] = color[2];
      out[i + 3] = rounded ? Math.round((covNavy / samples) * 255) : 255;
    }
  }
  return out;
}

/* ------------------------------ PNG writer ------------------------------ */
const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------- main ---------------------------------- */
export async function generateIcons() {
  const outDir = join(process.cwd(), "public");
  mkdirSync(outDir, { recursive: true });
  const jobs = [
    ["icon-192.png", 192, { rounded: true, glyphScale: 1 }],
    ["icon-512.png", 512, { rounded: true, glyphScale: 1 }],
    ["icon-maskable-512.png", 512, { rounded: false, glyphScale: 0.9 }],
    ["apple-touch-icon.png", 180, { rounded: false, glyphScale: 0.9 }],
  ];
  for (const [name, size, opts] of jobs) {
    writeFileSync(join(outDir, name), encodePng(size, renderMark(size, opts)));
    console.log(`✓ ${name} (${size}x${size})`);
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  generateIcons().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
