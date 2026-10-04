/**
 * Tests for the economy state model -- ECONOMY-SPEC.md sections 1, 4, 5, 7.
 *
 *   node src/player.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  newPlayer, heldTool, canHunt, toolName, nextTier, buyOrUpgradeLabel,
  canBuyTool, buyTool, canRepair, repairTool, repairNeeds, repairShortfall,
  canRedeem, redeemGems, redeemValueWei, creditGems, consumeUse,
} from './player.js';
import { FACE_VALUE, REDEEM_FLOOR, toolPrice, durabilityOf } from './economy.js';

const ETH = (n) => {
  const [w, f = ''] = String(n).split('.');
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, '0') || '0');
};
const RICH = ETH(100);

/**
 * A player holding `tier`, fully repaired.
 *
 * Climbs the ladder one rung at a time because the model forbids skipping --
 * which is itself the behaviour under test, so the fixture cannot shortcut it.
 */
function withTool(tier) {
  const p = newPlayer();
  for (let t = 1; t <= tier; t++) {
    const res = buyTool(p, t, RICH);
    assert.ok(res.ok, `fixture could not reach tier ${t}: ${res.reason}`);
  }
  return p;
}

// --- section 1: starting state ----------------------------------------------

test('a new player has no tool', () => {
  const p = newPlayer();
  assert.equal(p.tier, 0);
  assert.equal(heldTool(p), null);
  assert.equal(toolName(0), 'None');
});

test('a new player cannot hunt -- they must buy Wood first', () => {
  const res = consumeUse(newPlayer());
  assert.equal(res.ok, false);
  assert.match(res.reason, /Buy Wood/);
});

test('a new player has no gems', () => {
  assert.deepEqual(newPlayer().gems, [0, 0, 0, 0, 0]);
});

test('the first action is labelled "buy tool", later ones "upgrade tool"', () => {
  const p = newPlayer();
  assert.equal(buyOrUpgradeLabel(p), 'buy tool');
  assert.equal(nextTier(p), 1);
  buyTool(p, 1, RICH);
  assert.equal(buyOrUpgradeLabel(p), 'upgrade tool');
  assert.equal(nextTier(p), 2);
});

// --- section 4: buying and upgrading -----------------------------------------

test('buying Wood costs 0.005 ETH and grants 20 uses', () => {
  const p = newPlayer();
  const res = buyTool(p, 1, RICH);
  assert.ok(res.ok);
  assert.equal(p.tier, 1);
  assert.equal(p.left, 20);
  assert.equal(p.max, 20);
});

test('you cannot buy without the ETH', () => {
  const p = newPlayer();
  const chk = canBuyTool(p, 1, toolPrice(1) - 1n);
  assert.equal(chk.ok, false);
  assert.match(chk.reason, /Need 0\.005 ETH/);
});

test('an unaffordable buy is refused, not silently ignored', () => {
  // The reason must exist: the old CLAIM button was disabled with no
  // explanation, which was the one control in the card that failed silently.
  const p = newPlayer();
  const res = buyTool(p, 1, 0n);
  assert.equal(res.ok, false);
  assert.ok(res.reason && res.reason.length > 0);
  assert.equal(p.tier, 0, 'a refused buy must not grant the tool');
});

test('upgrading REPLACES the tool -- no stow, no rotation', () => {
  const p = withTool(1);
  p.left = 3;
  const res = buyTool(p, 2, RICH);
  assert.ok(res.ok);
  assert.equal(p.tier, 2);
  assert.equal(res.replaced, 'Wood');
  assert.equal(p.left, 25, 'the new tool arrives fully repaired');
  // One tool. There is no array any more.
  assert.equal(p.tools, undefined);
});

test('upgrading costs the next tier price, not a gem cost', () => {
  const p = withTool(1);
  const before = p.gems.reduce((a, b) => a + b, 0);
  buyTool(p, 2, RICH);
  assert.equal(p.gems.reduce((a, b) => a + b, 0), before, 'upgrading must not touch gems');
  assert.equal(p.spent, toolPrice(1) + toolPrice(2));
});

test('you cannot skip a tier', () => {
  const p = withTool(1);
  const chk = canBuyTool(p, 4, RICH);
  assert.equal(chk.ok, false);
  assert.match(chk.reason, /Iron first/);
});

test('you cannot re-buy the tier you already hold', () => {
  const p = withTool(2);
  const chk = canBuyTool(p, 2, RICH);
  assert.equal(chk.ok, false);
  assert.match(chk.reason, /already have Bronze/);
});

test('durability is the tier ladder at every rung', () => {
  for (const t of [1, 2, 3, 4, 5]) {
    const p = withTool(t);
    assert.equal(p.max, durabilityOf(t));
    assert.equal(p.left, durabilityOf(t));
  }
});

// --- section 5: repair --------------------------------------------------------

test('a tool must be broken before it can be repaired', () => {
  const p = withTool(1);
  p.left = 5;
  const chk = canRepair(p);
  assert.equal(chk.ok, false);
  assert.match(chk.reason, /not broken/);
});

test('repair costs gems and restores full durability', () => {
  const p = withTool(1);
  p.left = 0;
  creditGems(p, [9, 0, 0, 0, 0]);
  const res = repairTool(p);
  assert.ok(res.ok);
  assert.equal(p.left, 20);
  assert.deepEqual(p.gems, [0, 0, 0, 0, 0], 'the gems are spent');
  assert.equal(p.burned, 9);
});

test('repair names the gems you are short of', () => {
  const p = withTool(1);
  p.left = 0;
  creditGems(p, [4, 0, 0, 0, 0]);
  const chk = canRepair(p);
  assert.equal(chk.ok, false);
  assert.match(chk.reason, /Need 5 Q/);
  assert.deepEqual(repairShortfall(p), [5, 0, 0, 0, 0]);
});

test('repair refuses a partially-paid cost rather than taking what it can', () => {
  const p = withTool(3);
  p.left = 0;
  creditGems(p, [6, 5, 2, 0, 0]); // one Sapphire short
  const before = p.gems.slice();
  assert.equal(repairTool(p).ok, false);
  assert.deepEqual(p.gems, before, 'a refused repair must not debit anything');
});

test('repair burns gems outrightly and creates no claim', () => {
  // Section 10: repairs burn, so there is no treasury accumulator to fund.
  const p = withTool(1);
  p.left = 0;
  creditGems(p, [9, 0, 0, 0, 0]);
  repairTool(p);
  assert.equal(p.treasuryGems, undefined, 'no treasury claim may be created');
});

// --- section 7: redemption -----------------------------------------------------

test('redemption is refused below the 0.005 ETH floor', () => {
  const p = withTool(1);
  creditGems(p, [111, 0, 0, 0, 0]);
  assert.ok(redeemValueWei(p) < REDEEM_FLOOR);
  const chk = canRedeem(p);
  assert.equal(chk.ok, false);
  assert.match(chk.reason, /Need 0\.005 ETH/);
});

test('redemption clears the whole balance and pays 90% of face', () => {
  const p = withTool(1);
  creditGems(p, [200, 0, 0, 0, 0]);
  const expect = BigInt(200) * FACE_VALUE[0] * 9n / 10n;
  assert.equal(redeemValueWei(p), expect);
  const res = redeemGems(p);
  assert.ok(res.ok);
  assert.equal(res.value, expect);
  assert.deepEqual(p.gems, [0, 0, 0, 0, 0]);
});

test('a redemption zeroes the balances it paid out', () => {
  // The satchel tiles are the balances themselves. A sell pays the balance out
  // and the tiles go back to zero -- there is no separate lifetime tally to
  // preserve.
  const p = withTool(1);
  creditGems(p, [200, 0, 0, 0, 0]);
  redeemGems(p);
  assert.deepEqual(p.gems, [0, 0, 0, 0, 0]);
});

test('the satchel and the balance are one counter', () => {
  const p = withTool(1);
  creditGems(p, [7, 3, 0, 0, 0]);
  assert.equal(p.gems.reduce((a, b) => a + b, 0), 10);
  p.gems[0] = 0;
  assert.equal(p.gems.reduce((a, b) => a + b, 0), 3);
});

// --- hunting -------------------------------------------------------------------

test('one use is spent per dig and the tool breaks at zero', () => {
  const p = withTool(1);
  for (let i = 1; i < 20; i++) {
    const r = consumeUse(p);
    assert.ok(r.ok);
    assert.equal(r.broke, false);
  }
  const last = consumeUse(p);
  assert.equal(last.broke, true);
  assert.equal(p.left, 0);
  assert.equal(canHunt(p), false, 'a broken tool cannot hunt');
  // still owned, still renderable -- a broken tool is not a missing tool
  assert.equal(heldTool(p).name, 'Wood');
});

test('a broken tool refuses another dig until repaired or upgraded', () => {
  const p = withTool(1);
  p.left = 0;
  const res = consumeUse(p);
  assert.equal(res.ok, false);
  assert.match(res.reason, /broken/);
});

test('the full ladder is 20/25/30/35/40 uses', () => {
  const counts = [];
  for (const t of [1, 2, 3, 4, 5]) {
    const p = withTool(t);
    let n = 0;
    while (consumeUse(p).ok) n++;
    counts.push(n);
  }
  assert.deepEqual(counts, [20, 25, 30, 35, 40]);
});

test('creditGems adds to the spendable balance only', () => {
  const p = newPlayer();
  creditGems(p, [1, 2, 3, 4, 5]);
  assert.deepEqual(p.gems, [1, 2, 3, 4, 5]);
});

test('repairNeeds matches the tier table', () => {
  assert.deepEqual(repairNeeds(withTool(1)), [9, 0, 0, 0, 0]);
  assert.deepEqual(repairNeeds(withTool(5)), [12, 10, 8, 4, 0]);
});