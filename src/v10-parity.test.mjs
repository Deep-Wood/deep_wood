/**
 * V10 roll parity: the client's local rolls must byte-match the chain's.
 *
 * THE CHAIN TRUTH VECTOR at the bottom is not synthetic. It is the live
 * V10.1 contract's own previewHunt for a real migrated player (trader2,
 * 2026-10-22): hunt index 295, tier 3, skill 3, seed c05f61e5…, leq 1562
 * (prestige at the 30_000 bps cap, luck 0 -> findWeightBps 30_000). The
 * migration run captured counts [0,1,0,0,0] (an Amber) and the settle
 * succeeded -- the chain accepted that roll. If engine.js ever drifts
 * (fold, multiplier, hash input), this vector fails before any player
 * sees a ResultMismatch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rollHunt, tableFor, foldTable, applyFindWeight, DROP_TABLE } from './engine.js';
import { HuntQueue } from './queue.js';
import {
  luckLevelOf, luckBpsOf, studyCost, fusionRow, fusionRows,
} from './v10.js';

// --- the contract's exact fold (replaces the old GOLD gate) --------------
//
// Gold row on-chain (verified live): [3000,3000,2500,1300,200].
// Contract fold: r >= skill -> fold into Quartz; skill 0 folds everything.

test('foldTable matches the contract fold on the live Gold row', () => {
  const gold = DROP_TABLE[5];
  assert.deepEqual(gold, [3000, 3000, 2500, 1300, 200], 'economy.js mirrors the live row');
  assert.deepEqual(foldTable(gold, 1), [10000, 0, 0, 0, 0], 'skill 1: all Quartz on-chain');
  assert.deepEqual(foldTable(gold, 2), [7000, 3000, 0, 0, 0], 'skill 2 keeps Amber, Sapphire+ folds');
  assert.deepEqual(foldTable(gold, 3), [4500, 3000, 2500, 0, 0], 'skill 3 keeps Sapphire, Ruby+ folds');
  assert.deepEqual(foldTable(gold, 4), [3200, 3000, 2500, 1300, 0], 'skill 4 keeps Ruby, Diamond folds');
  assert.deepEqual(foldTable(gold, 5), [3000, 3000, 2500, 1300, 200], 'skill 5: nothing folds');
  assert.deepEqual(foldTable(gold, 0), [10000, 0, 0, 0, 0], 'skill 0 folds everything');
  // Silver, the common migrated tier: skill 3 covers its whole row.
  assert.deepEqual(foldTable(DROP_TABLE[3], 3), [4500, 3500, 2000, 0, 0]);
  // every folded row still sums to 10,000: the roll needs a full table
  for (const skill of [0, 1, 2, 3, 4, 5]) {
    assert.equal(foldTable(gold, skill).reduce((a, b) => a + b, 0), 10000);
  }
});

test('tableFor returns folded rows (no more GOLD_NO_SKILL4 approximation)', () => {
  // The old approximation returned [3000,3000,3000,1000,0] here, which the
  // chain would have rejected on every roll.
  assert.deepEqual(tableFor(5, 3), [4500, 3000, 2500, 0, 0]);
  assert.deepEqual(tableFor(1, 1), [10000, 0, 0, 0, 0]);
});

// --- the V10 find-weight scaling ------------------------------------------
//
// Non-Quartz * mult/10_000 (floor), acc capped at 10_000, Quartz = remainder.

test('applyFindWeight mirrors _rollHunt scaling, including the cap', () => {
  const folded = [4500, 3000, 2500, 0, 0]; // gold, skill 3
  // 1.5x: 3000->4500, 2500->3750, acc=8250, Quartz=1750
  assert.deepEqual(applyFindWeight(folded, 15000), [1750, 4500, 3750, 0, 0]);
  // 3x at the prestige cap: 3000->9000, 2500->7500, acc=16500 -> re-normalized
  // so weights sum to 10_000 (raw 9000+7500 would break %10000 roll:
  // 9000 alone always wins since rarityRoll max is 9999).
  const r3 = applyFindWeight(folded, 30000);
  assert.equal(r3[0], 0, 'Quartz zeroed at cap');
  assert.equal(r3.reduce((a, b) => a + b, 0), 10000, 'weights sum to 10k');
  assert.ok(r3[1] > 0 && r3[2] > 0, 'both Amber and Sapphire remain rollable');
  // below the threshold: no scaling at all (mult <= 10_000)
  assert.deepEqual(applyFindWeight(folded, 10000), folded);
  assert.deepEqual(applyFindWeight(folded, 9999), folded);
});

test('applyFindWeight on a Quartz-heavy table never underflows Quartz', () => {
  const wood = [10000, 0, 0, 0, 0];
  assert.deepEqual(applyFindWeight(wood, 30000), [10000, 0, 0, 0, 0], 'nothing to scale');
});

// --- research / fusion math -----------------------------------------------

test('luck decoding: byte 2 of the packed word', () => {
  assert.equal(luckLevelOf(0n), 0);
  assert.equal(luckLevelOf(1n << 16n), 1);   // L1
  assert.equal(luckLevelOf(5n << 16n), 5);   // L5
  assert.equal(luckLevelOf((3n << 16n) | (1n << 8n) | 1n), 3, 'reserved bytes ignored');
  assert.equal(luckBpsOf(3n << 16n, 250n), 750n);
  assert.equal(luckBpsOf(0n, 250n), 0n);
});

test('study costs double per level from the live base', () => {
  assert.equal(studyCost(0, 50n), 50n);
  assert.equal(studyCost(1, 50n), 100n);
  assert.equal(studyCost(2, 50n), 200n);
  assert.equal(studyCost(3, 50n), 400n);
  assert.equal(studyCost(4, 50n), 800n);
  assert.equal(studyCost(2, 100n), 400n, 'owner can retune the base; math follows');
});

test('fusion rows are value-honest: sink shown, never minted', () => {
  const rows = fusionRows([20n, 12n, 12n, 4n]);
  // 20 Quartz (400 each) -> 1 Amber (7800): burn 8000, get 7800, sink 2.5%
  assert.equal(rows[0].burnValue, 8000n * 10n ** 18n);
  assert.equal(rows[0].gettValue, 7800n * 10n ** 18n);
  assert.equal(rows[0].sinkPct, 2.5);
  // 12 Amber -> Sapphire: burn 93600, get 86000 -> 8.1%
  assert.equal(rows[1].sinkPct, 8.11); // (93600-86000)/93600, floor to 2dp
  // 12 Sapphire -> Ruby: burn 1032000, get 1000000 -> 3.1%
  assert.equal(rows[2].sinkPct, 3.1);
  // 4 Ruby -> Diamond: burn 4000000, get 4000000 -> 0.0% (exactly neutral)
  assert.equal(rows[3].sinkPct, 0);
  for (const r of rows) assert.ok(r.burnValue >= r.gettValue, 'fusion never mints value');
});

// --- queue invalidation on a multiplier change -----------------------------

test('a find-weight change kills the queue like a skill change does', () => {
  const q = new HuntQueue(100n, 3, 3, 30000n);
  q.push([1n, 0n, 0n, 0n, 0n], 400n * 10n ** 18n);
  assert.equal(q.size, 1);
  // same mult: queue survives the rebase
  q.rebase(100n, 3, 3, 30000n);
  assert.equal(q.size, 1);
  // study happened (mult moved): queued rolls are dead, drop them
  q.rebase(100n, 3, 3, 30250n);
  assert.equal(q.size, 0);
  // unknown mult (undefined) never kills anything -- boot order tolerance
  const q2 = new HuntQueue(100n, 3, 3);
  q2.push([1n, 0n, 0n, 0n, 0n], 0n);
  q2.rebase(100n, 3, 3, 30000n);
  assert.equal(q2.size, 1);
});

// --- THE CHAIN TRUTH VECTOR ------------------------------------------------
//
// Live V10.1 (0x950c…fb4c) previewHunt for trader2 on 2026-10-22, seconds
// before the migration settle the chain ACCEPTED:
//   player 0xd1Bd…E848d, huntIndex 295, tier 3, skill 3,
//   seed 0xc05f61e5…, findWeightBps 30_000 (leq 1562 -> cap, luck 0)
//   -> counts [0,1,0,0,0] (one Amber), best 7800e18.

const CHAIN_SEED = '0xc05f61e5f9d3785bd1f2088d93112e85e1ce2f8e68128ff508a468b028b9cf8b';
const T2 = '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d';

test('engine.js reproduces the live V10.1 roll for a migrated player byte-exact', () => {
  const r = rollHunt(CHAIN_SEED, T2, 295n, 3, 3, 30000n);
  assert.deepEqual(r.counts.map((c) => Number(c)), [0, 1, 0, 0, 0],
    'must be the one Amber the chain previewed and settled');
  assert.equal(r.highest, 1);
  // without the multiplier the same roll lands Quartz -- the exact drift
  // class this guard exists for (prestige visibly changes outcomes)
  const flat = rollHunt(CHAIN_SEED, T2, 295n, 3, 3, 10000n);
  assert.deepEqual(flat.counts.map((c) => Number(c)), [1, 0, 0, 0, 0],
    'at 1x the same entropy lands Quartz; at 3x it lands Amber');
});
