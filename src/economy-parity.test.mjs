/**
 * One economy, and an ROI that means something.
 *
 * Two reported symptoms, both from duplicated constants:
 *
 *  1. "Why is Wood getting an amber?" -- engine.js kept its OWN DROP_TABLE,
 *     and that copy gave Wood a 10% Amber chance. economy.js (and the spec, and
 *     the contract) give Wood pure Quartz. That copy also had no tier-5 row, so
 *     Gold threw outright.
 *
 *  2. "ROI 5800%" -- the card computed `leq / Math.max(1, ethSpent) * 100`.
 *     When the tool spend had not been recorded, ethSpent was 0, the divisor
 *     became 1, and 58 leq WAS the percentage. Reproduced exactly below.
 *
 * A second copy of the economy is precisely the drift engine.js's own header
 * warns about, so these tests pin the single-source property.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

import { rollHunt, DROP_TABLE, PRICE, tableFor } from './engine.js';
import { DROP_TABLE as ECON_TABLE, FACE_VALUE, MAX_TIER } from './economy.js';

const scene = readFileSync(new URL('./ForestScene.js', import.meta.url), 'utf8');
const engineSrc = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');

/**
 * Strip comments. The fixes here are all EXPLAINED in comments that quote the
 * old buggy code -- so a raw text match finds `this.player.tier` and
 * `Math.max(1, ...ethSpent)` in the explanation and fails against correct code.
 */
const bare = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('Wood drops Quartz and nothing else', () => {
  assert.deepEqual(DROP_TABLE[1], [10000, 0, 0, 0, 0]);
  // Statistical proof over the real roll, not just the table: 20k hunts.
  const seen = [0, 0, 0, 0, 0];
  for (let h = 0; h < 20000; h++) {
    rollHunt(12345, '0xplayer', h, 1, 1).counts.forEach((c, i) => { seen[i] += c; });
  }
  assert.equal(seen[0] > 0, true, 'quartz must still drop');
  for (let i = 1; i < 5; i++) {
    assert.equal(seen[i], 0, `${i} must never drop from Wood, saw ${seen[i]}`);
  }
});

test('every tier can roll, including Gold', () => {
  // The engine copy had rows 1-4 only, so tier 5 threw `bad toolTier 5`.
  for (let tier = 1; tier <= MAX_TIER; tier++) {
    assert.ok(tableFor(tier, 4), `tier ${tier} must have a table`);
    const r = rollHunt(7, '0xabc', 1, tier, 4);
    assert.ok(r.total > 0, `tier ${tier} must produce gems`);
  }
});

test('Gold without Skill 4 drops no Diamond', () => {
  const seen = [0, 0, 0, 0, 0];
  for (let h = 0; h < 5000; h++) {
    rollHunt(99, '0xabc', h, 5, 1).counts.forEach((c, i) => { seen[i] += c; });
  }
  assert.equal(seen[4], 0, 'Diamond is gated behind Skill 4');
});

test('there is exactly one drop table and one price list', () => {
  // engine.js must not declare its own numeric arrays any more.
  assert.match(engineSrc, /import \{[\s\S]*DROP_TABLE as ECONOMY_DROP_TABLE/);
  assert.match(engineSrc, /FACE_VALUE as ECONOMY_PRICE/);
  for (const tier of [1, 2, 3, 4, 5]) {
    assert.deepEqual(DROP_TABLE[tier], ECON_TABLE[tier], `tier ${tier} must match`);
  }
  assert.equal(PRICE.length, FACE_VALUE.length);
  PRICE.forEach((p, i) => assert.equal(p, FACE_VALUE[i]));
});

test('a hunt rolls against the tier the player HOLDS', () => {
  // `this.player` is the Phaser sprite, so `this.player.tier` is undefined and
  // every hunt silently rolled on tier 1's table.
  const i = scene.indexOf('  reveal(node) {');
  const seg = bare(scene.slice(i, i + 700));
  assert.match(seg, /this\.econ\.tier \|\| 1/);
  assert.ok(!/this\.player\.tier/.test(seg), 'must not read the sprite for the tier');
});

test('ROI is gem value over ETH spent, in real units', () => {
  const j = scene.indexOf('  paintSeasonStats() {');
  const seg = bare(scene.slice(j, scene.indexOf('  refreshBelt() {', j)));
  assert.ok(
    !/Math\.max\(1, .*ethSpent/.test(seg),
    'a max(1,...) divisor turns a zero denominator into a huge fake percentage',
  );
  assert.ok(!/entry\.leq\s*\/\s*Number\(entry\.ethSpent/.test(seg),
    'leq is a leaderboard rarity score, not a return; it must not be the ROI numerator');
  assert.match(seg, /FACE_VALUE\[i\]/, 'ROI must be valued with FACE_VALUE');
  assert.match(seg, /spent > 0/, 'zero spend must show a dash, not a number');
});

test('the 5800% case is impossible under the new formula', () => {
  // Reproduce the old arithmetic to prove what it was reporting.
  const oldFormula = 58 / Math.max(1, 0) * 100;
  assert.equal(oldFormula.toFixed(1), '5800.0');
  // The new one has no such path: it needs a real denominator and yields the
  // gem value ratio instead.
  const FACE = FACE_VALUE.map(Number);
  const gems = [60, 0, 0, 0, 0];
  const found = gems.reduce((a, n, i) => a + n * FACE[i], 0);
  const pct = (found / 5e15 * 100).toFixed(1);
  assert.equal(pct, '60.0', '15 Wood digs on a 0.005 tool is 60% back');
  assert.notEqual(pct, '5800.0');
});