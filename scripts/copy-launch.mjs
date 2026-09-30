/**
 * Copy the token launch page into the built site at /launch.
 *
 * The launch page is the pre-existing root index.html that shipped before the
 * game. When the game took over the root, that page would otherwise have been
 * deleted by the deploy, so it lives in /launch/ and this copies it into dist/.
 *
 * It has to happen in the build rather than by hand: dist/ is gitignored, so
 * Vercel rebuilds it from scratch every deploy and anything copied in manually
 * is gone by the time anyone looks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'launch');
const out = path.join(root, 'dist', 'launch');

if (!fs.existsSync(src)) {
  console.error(`copy-launch: ${src} is missing - the launch page would be dropped`);
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, f), path.join(out, f));
  n++;
}
console.log(`copy-launch: ${n} file(s) -> dist/launch/`);