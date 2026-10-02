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

/**
 * Recursive, because /launch now holds a subdirectory: the self-hosted Cinzel
 * webfont lives at launch/fonts/ so the emblem's typeface is served from our
 * own origin rather than a font CDN. The first version of this script used a
 * bare copyFileSync over readdirSync and the build died on
 * EISDIR: illegal operation on a directory, copyfile '.../launch/fonts'.
 */
function copyInto(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyInto(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      n++;
    }
  }
}

copyInto(src, out);
console.log(`copy-launch: ${n} file(s) -> dist/launch/`);