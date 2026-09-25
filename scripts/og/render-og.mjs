// Renders scripts/og/og-card.svg -> public/og.png (1200x630 Open Graph card).
// Run: npm run og
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const svgPath = fileURLToPath(new URL('./og-card.svg', import.meta.url));
const outPath = fileURLToPath(new URL('../../public/og.png', import.meta.url));

const svg = readFileSync(svgPath);
const image = sharp(svg, { density: 72 }).resize(1200, 630).png({ compressionLevel: 9 });
await image.toFile(outPath);

const meta = await sharp(outPath).metadata();
const stats = await sharp(outPath).stats();
const mean = stats.channels.map((c) => c.mean.toFixed(1)).join(', ');

console.log('OG image written:', outPath);
console.log(`Format: ${meta.format} | ${meta.width}x${meta.height} | ${meta.size} bytes`);
console.log(`Mean RGB: ${mean}`);
if (meta.width !== 1200 || meta.height !== 630) {
  console.error('Unexpected dimensions — aborting.');
  process.exit(1);
}
if (Number(mean.split(', ')[0]) < 2) {
  console.error('Image appears blank — check fonts/SVG.');
  process.exit(1);
}
