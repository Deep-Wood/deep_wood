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
import {
  DROP_TABLE as ECONOMY_DROP_TABLE,
  FACE_VALUE as ECONOMY_PRICE,
} from './economy.js';
const { keccak256 } = sha3;

export const RARITY_NAME = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

/**
 * Drop tables live in economy.js. This file used to keep its OWN copy, and the
 * two disagreed: this one gave Wood a 10% Amber chance, while economy.js (and
 * the spec, and the contract) give Wood pure Quartz. So a Wood dig dropped
 * Ambers that the economy does not price, and the surplus value went straight
 * into the ROI numerator.
 *
 * A second copy of the economy is exactly the drift the header comment on this
 * file warns about. One source, imported.
 */
export const DROP_TABLE = ECONOMY_DROP_TABLE;

/** Gold without Skill 4 has no Diamond at all (SPEC section 2). */
const GOLD_NO_SKILL4 = [3000, 3000, 3000, 1000, 0];

/**
 * The table for a tier, accounting for the Skill 4 Diamond gate.
 *
 * This copy also had no tier-5 row, so buying Gold threw `bad toolTier 5` and
 * the hunt could not resolve at all.
 */
export function tableFor(tier, skill = 1) {
  if (tier === 5 && skill < 4) return GOLD_NO_SKILL4;
  return ECONOMY_DROP_TABLE[tier];
}

/**
 * Gem face values. Also duplicated here once, which is how a price could drift
 * from the economy silently. One source now.
 */
export const PRICE = ECONOMY_PRICE;

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

export function rollHunt(seed, player, huntIndex, toolTier, skill = 1) {
  // tableFor(), not DROP_TABLE[toolTier]: the direct index threw on tier 5,
  // which the local copy did not have a row for.
  const table = tableFor(toolTier, skill);
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
