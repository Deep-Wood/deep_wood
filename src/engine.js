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

/**
 * The contract folds skill-locked rarities into Quartz BEFORE the roll
 * (V10 _rollHunt: `if (skill == 0 || r >= skill) { table[0] += table[r];
 * table[r] = 0; }` -- skill S unlocks Rarity(S-1)). This exact fold
 * replaced the old GOLD_NO_SKILL4 approximation on 2026-10-22: the
 * approximation diverged from the chain for every sub-skill Gold player
 * (skill 1 rolls 100% Quartz on-chain but 30% locally; skill 4 rolls
 * Ruby at 1300 but locally at 1000), so every local dig after the first
 * was a guaranteed ResultMismatch at settle. Mirrors the fold, never
 * approximates it.
 */
export function foldTable(table, skill) {
  const t = [...table];
  for (let r = 1; r < 5; r++) {
    if (skill === 0 || r >= skill) { t[0] += t[r]; t[r] = 0; }
  }
  return t;
}

/**
 * V10 prestige + research luck: non-Quartz weights scale by
 * findWeightBps / 10_000, Quartz takes the remainder, acc capped at
 * 10_000 so a big multiplier can never underflow the Quartz slot.
 * Byte-mirrors the contract's block in _rollHunt -- the same math the
 * settle gate recomputes, or queued digs revert ResultMismatch.
 */
export function applyFindWeight(table, findWeightBps) {
  const mult = Number(findWeightBps);
  if (mult <= 10000) return [...table];
  const t = [...table];
  let acc = 0;
  for (let r = 1; r < 5; r++) {
    t[r] = Math.floor((t[r] * mult) / 10000);
    acc += t[r];
  }
  if (acc > 10000) {
    // Re-normalize so non-Quartz weights sum to exactly 10000.
    // Without this, a scaled weight > 10000 always wins because
    // rarityRoll is % 10000 (max 9999) — Silver at prestige cap
    // would roll 100% Amber (3500*3=10500 > 9999).
    const scale = 10000 / acc;
    let sum = 0;
    for (let r = 1; r < 4; r++) {
      t[r] = Math.floor(t[r] * scale);
      sum += t[r];
    }
    t[4] = 10000 - sum; // last rarity takes the rounding remainder
    t[0] = 0;
  } else {
    t[0] = 10000 - acc;
  }
  return t;
}

/**
 * The table for a tier, folded for the player's skill exactly as the
 * contract folds it at roll time.
 */
export function tableFor(tier, skill = 1) {
  const row = ECONOMY_DROP_TABLE[tier];
  if (!row) throw new Error(`bad toolTier ${tier}`);
  return foldTable(row, skill);
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

export function rollHunt(seed, player, huntIndex, toolTier, skill = 1, findWeightBps = 10000) {
  // tableFor(tier, skill) folds skill-locked rarities into Quartz and
  // applyFindWeight scales the folded table by the V10 prestige + luck
  // multiplier -- both byte-mirror _rollHunt, which is the whole point:
  // the settle gate recomputes this exact pipeline from the same seed.
  const table = applyFindWeight(tableFor(toolTier, skill), findWeightBps);

  // Concatenate without Buffer: keep a running list and join into one array.
  const h = hash(concat(
    toBuf32(BigInt(seed)),
    toBuf32(huntIndex),
    // Strip the 0x prefix: the contract hashes the bare 40-char lowercase hex,
    // so keeping the prefix makes every client render disagree with the chain.
    utf8(String(player).toLowerCase().replace(/^0x/, '')),
  ));
  // One rarity per hunt, exactly ONE gem of it -- mirrors the contract's
  // _rollHunt. The 1-5 multiplier was never spec'd; every dig is one stone.
  const gemCount = 1;

  const counts = [0, 0, 0, 0, 0];
  let valueWei = 0n;
  let highest = 0;

  // Pick the rarity for this entire hunt.
  const rarityRoll = ((h[1] << 16) | (h[2] << 8) | h[3]) % 10000;
  let acc = 0, picked = table.length - 1;
  for (let r = 0; r < table.length; r++) {
    acc += table[r];
    if (rarityRoll < acc) { picked = r; break; }
  }
  counts[picked] = gemCount;
  valueWei = BigInt(PRICE[picked]) * BigInt(gemCount);
  highest = picked;

  return { counts, valueWei, total: gemCount, highest };
}
