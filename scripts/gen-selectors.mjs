/**
 * Regenerate the SIGS table in src/chain.js from the compiled artifact.
 *
 * WHY THIS EXISTS: the selector table was hand-written twice and was wrong
 * every time. Of the four entries added during the config refactor, three
 * (getConfig, tokenRailEnabled, paused) were wrong. A wrong selector does not
 * throw -- it silently returns empty data, so the drift guard reports nonsense
 * or the client reads a wrong constant. That is precisely the class of bug the
 * guard exists to catch, so the table must never be typed by hand again.
 *
 * Usage:  node scripts/gen-selectors.mjs            # rewrite the table
 *         node scripts/gen-selectors.mjs --check    # exit 1 if out of date
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
// js-sha3 is CommonJS: it exposes only a default export under ESM interop.
import sha3 from 'js-sha3';
const { keccak256 } = sha3;

const require = createRequire(import.meta.url);
// DeepWoodV3 now (settleBatch era). Pointing this at an older artifact is how
// the client ends up with a selector table full of functions the current
// contract does not have -- and a wrong selector does not throw, it silently
// reads empty.
const ART = '/home/administrator/gem-hunter/out/DeepWoodV3.sol/DeepWoodV3.json';
const TARGET = new URL('../src/chain.js', import.meta.url).pathname;

if (!existsSync(ART)) {
  console.error(`missing artifact: ${ART}\nrun: cd /home/administrator/gem-hunter && forge build`);
  process.exit(2);
}

const abi = JSON.parse(readFileSync(ART, 'utf8')).abi;
const sel = (sig) => '0x' + keccak256(sig).slice(0, 8);

const entries = [];
for (const e of abi) {
  if (e.type !== 'function') continue;
  const args = e.inputs.map((i) => i.type).join(',');
  entries.push([`${e.name}(${args})`, sel(`${e.name}(${args})`)]);
}
entries.sort(([a], [b]) => a.localeCompare(b));

const table = entries.map(([sig, hex]) => `  '${sig}': '${hex}',`).join('\n');

const src = readFileSync(TARGET, 'utf8');
const start = src.indexOf('export const SIGS = {');
if (start < 0) {
  console.error('could not find the SIGS table in src/chain.js');
  process.exit(2);
}
const bodyStart = src.indexOf('{', start) + 1;
const bodyEnd = src.indexOf('};', bodyStart);
const next = src.slice(0, bodyStart) + '\n' + table + '\n' + src.slice(bodyEnd);

if (process.argv.includes('--check')) {
  if (next !== src) {
    console.error('SIGS is OUT OF DATE with the artifact. Run: node scripts/gen-selectors.mjs');
    process.exit(1);
  }
  console.log(`SIGS is current (${entries.length} selectors).`);
  process.exit(0);
}

writeFileSync(TARGET, next);
console.log(`wrote ${entries.length} selectors to src/chain.js`);
