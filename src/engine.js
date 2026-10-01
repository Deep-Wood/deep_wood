/**
 * Hunt logic for the client.
 *
 * Deliberately a COPY of the logic in gem-hunter/script/hunt-engine.mjs
 * rather than an import: the browser bundle should not depend on a file in a
 * sibling project, and the contract is the real source of truth anyway. A
 * parity check keeps the two from drifting -- if these ever disagree, the
 * client would show results the chain would reject.
 *
 * Uses REAL keccak256, not sha256. The contract hashes with keccak256, so a
 * commitment built on sha256 could never be verified onchain. The first
 * version of this file used node's crypto (sha256) and simply did not run in
 * a browser at all.
 */
import sha3 from 'js-sha3';
const { keccak256 } = sha3;

export const RARITY_NAME = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

export const DROP_TABLE = {
  1: [9000, 1000, 0, 0, 0],
  2: [7000, 2500, 500, 0, 0],
  3: [5500, 3000, 1200, 300, 0],
  4: [4000, 3000, 2000, 900, 100],
};

export const PRICE = [
  50_000_000_000_000n,
  400_000_000_000_000n,
  3_000_000_000_000_000n,
  25_000_000_000_000_000n,
  200_000_000_000_000_000n,
];

const hash = (buf) => new Uint8Array(keccak256.arrayBuffer(buf));

/**
 * 32-byte big-endian encoding of a uint256.
 *
 * NOT Buffer.alloc: Buffer is a Node global and does not exist in a browser.
 * The first version of this file used it, so every hunt threw
 * "Buffer is not defined" the moment a find was revealed -- the roll worked
 * fine in Node (which is why the parity test passed) and crashed in the game.
 */
function toBuf32(v) {
  const b = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

/** UTF-8 bytes of a string, without Node's Buffer. */
function utf8(str) {
  return new TextEncoder().encode(str);
}

/** Concatenate byte arrays without Node's Buffer.concat. */
function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function rollHunt(seed, player, huntIndex, toolTier) {
  const table = DROP_TABLE[toolTier];
  if (!table) throw new Error(`bad toolTier ${toolTier}`);

  // Concatenate without Buffer: keep a running list and join into one array.
  const h = hash(concat(
    toBuf32(BigInt(seed)),
    toBuf32(huntIndex),
    // Strip the 0x prefix: the contract hashes the bare 40-char lowercase hex,
    // so keeping the prefix makes every client render disagree with the chain.
    utf8(String(player).toLowerCase().replace(/^0x/, '')),
  ));
  const gemCount = 3 + (h[0] % 3);

  const counts = [0, 0, 0, 0, 0];
  let valueWei = 0n;
  let highest = 0;

  for (let i = 0; i < gemCount; i++) {
    const gb = hash(concat(h, toBuf32(toolTier), new Uint8Array([i])));
    const roll = ((gb[0] << 16) | (gb[1] << 8) | gb[2]) % 10000;
    let acc = 0, picked = table.length - 1;
    for (let r = 0; r < table.length; r++) {
      acc += table[r];
      if (roll < acc) { picked = r; break; }
    }
    counts[picked] += 1;
    valueWei += PRICE[picked];
    if (picked > highest) highest = picked;
  }

  return { counts, valueWei, total: gemCount, highest };
}
