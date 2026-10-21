/**
 * Tests for the new economy -- ECONOMY-SPEC.md sections 1-9.
 *
 * These assert the SPEC, not the implementation. Each expectation is derived
 * from the agreed design first and the code second, because the whole point of
 * this file existing is that the numbers are a decision and not an accident.
 *
 *   node src/economy.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TIER_NAME, DROP_TABLE, DURABILITY, TOOL_PRICE, REPAIR_COST,
  FACE_VALUE, RARITY_WEIGHT, PAYOUT_BPS, REDEEM_FLOOR,
  toolPrice, durabilityOf, repairCost, payoutWei, dropTable,
  huntValueWei, netHuntWei, paybackHunts, fmtEth, fmtRepair,
  SKILL_NAME, SKILL_NAME_UC, SKILL_UNLOCKS, RARITY_NAME, TOOL_AVATARS, SKILL_AVATARS,
  toolAvatarSkinned,
  skillName, skillSubtitle,
} from './economy.js';

// Exact literals, NOT n*1e18. Math.round(2.3*1e18) is 2300000000000000001, so a
// test written that way fails against the correct constant for the wrong reason.
const ETH = (n) => {
  const [whole, frac = ''] = String(n).split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0') || '0');
};

// --- section 2: tiers and drop tables -------------------------------------

test('tier names are Wood / Bronze / Iron / Steel / Gold', () => {
  assert.deepEqual(TIER_NAME.slice(1), ['Wood', 'Bronze', 'Iron', 'Steel', 'Gold']);
});

test('Wood mines Quartz only', () => {
  // "Tier1 has 100% chance of mining quartz"
  assert.deepEqual(DROP_TABLE[1], [10000, 0, 0, 0, 0]);
});

test('Bronze is 60% Quartz / 40% Amber', () => {
  assert.deepEqual(DROP_TABLE[2], [6000, 4000, 0, 0, 0]);
});

test('no tier drops a rarity above its own ceiling except Gold', () => {
  // Amber is unlocked by Bronze, so Wood cannot roll it. The old contract had
  // dropTable(1) = [9000, 1000, ...] -- 10% Amber at Wood -- which is exactly
  // the bug the redeploy fixes.
  for (let t = 1; t <= 5; t++) {
    const table = DROP_TABLE[t];
    // sum is 10,000: the table is a probability distribution, not a count
    assert.equal(table.reduce((a, b) => a + b, 0), 10000, `tier ${t} sums to 10,000`);
    const ceiling = t - 1; // tier N may reach rarity N-1
    // Start ABOVE the ceiling, not at it: rarity 0 is Quartz and every tier
    // may find Quartz, including Wood which is Quartz-only.
    for (let r = ceiling + 1; r < 5; r++) {
      assert.equal(table[r], 0, `tier ${t} must not drop rarity ${r}`);
    }
  }
});

test('Gold drops Diamond only with Skill 4', () => {
  const withSkill = dropTable(5, 4);
  const without = dropTable(5, 3);
  assert.ok(withSkill[4] > 0, 'Gold with skill 4 must be able to drop Diamond');
  assert.equal(without[4], 0, 'Gold without skill 4 must never drop Diamond');
});

// --- section 3: the rarity ladder ------------------------------------------

test('face values are the agreed ETH ladder', () => {
  assert.equal(FACE_VALUE[0], ETH(0.00005));  // Quartz
  assert.equal(FACE_VALUE[1], ETH(0.0004));   // Amber
  assert.equal(FACE_VALUE[2], ETH(0.003));    // Sapphire
  assert.equal(FACE_VALUE[3], ETH(0.025));    // Ruby
  assert.equal(FACE_VALUE[4], ETH(0.2));      // Diamond
});

test('each rarity is roughly 8x the last', () => {
  for (let r = 1; r < 5; r++) {
    const ratio = Number(FACE_VALUE[r]) / Number(FACE_VALUE[r - 1]);
    assert.ok(ratio > 6 && ratio < 10, `rarity ${r} is ${ratio.toFixed(2)}x, want ~8x`);
  }
});

test('ROI weights are a separate 8x ladder', () => {
  // Distinct job from face value: this scores a haul, that is its cash worth.
  assert.deepEqual(RARITY_WEIGHT, [1n, 8n, 64n, 512n, 4096n]);
});

// --- section 4: prices and durability ---------------------------------------

test('durability rises 5 per tier: 20/25/30/35/40', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(durabilityOf), [20, 25, 30, 35, 40]);
});

test('tool prices are the agreed ladder', () => {
  assert.equal(toolPrice(1), ETH(0.005));
  assert.equal(toolPrice(2), ETH(0.052));
  assert.equal(toolPrice(3), ETH(0.184));
  assert.equal(toolPrice(4), ETH(0.862));
  assert.equal(toolPrice(5), ETH(2.300));
});

test('tool prices rise with tier', () => {
  for (let t = 1; t < 5; t++) {
    assert.ok(toolPrice(t + 1) > toolPrice(t), `tier ${t + 1} must cost more than ${t}`);
  }
});

// --- section 5: repair costs -------------------------------------------------

test('repair costs are the scaled ladder', () => {
  // Pinned to the CONTRACT'S shipped defaults (V6-lineage constructor), the
  // same values the chain charges live. The old V4/V5 design ladder (9 / 5+4 /
  // 6+5+3 / 6+5+3 / 12+10+8+4) lived here through three deploys and made the
  // repair dialog display costs the chain never charged. Reconciled
  // 2026-10-19 against V9 (0x8c69...52ac6).
  assert.deepEqual(REPAIR_COST[1], [5, 0, 0, 0, 0]);
  assert.deepEqual(REPAIR_COST[2], [3, 2, 0, 0, 0]);
  assert.deepEqual(REPAIR_COST[3], [3, 3, 1, 0, 0]);
  assert.deepEqual(REPAIR_COST[4], [3, 3, 2, 0, 0]);
  assert.deepEqual(REPAIR_COST[5], [5, 5, 4, 2, 0]);
});

test('repair never requires a rarity the tier cannot find', () => {
  // A repair in a gem you cannot mine is unpayable by construction.
  for (let t = 1; t <= 5; t++) {
    const ceiling = t - 1;
    REPAIR_COST[t].forEach((n, r) => {
      if (n > 0) {
        assert.ok(r <= ceiling, `tier ${t} repair needs rarity ${r} but caps at ${ceiling}`);
      }
    });
  }
});

test('repair stays near 40-50% of a cycle, except Steel', () => {
  // Steel is the documented exception: its 6% Ruby rate makes a 45% repair in
  // Ruby-equivalents a paywall, so it is deliberately cheap.
  const EXEMPT = new Set([4]);
  for (let t = 1; t <= 5; t++) {
    const cycle = huntValueWei(t) * BigInt(durabilityOf(t));
    let cost = 0n;
    REPAIR_COST[t].forEach((n, r) => { cost += BigInt(n) * FACE_VALUE[r]; });
    const pct = Number(cost * 10_000n / cycle) / 100;
    if (EXEMPT.has(t)) {
      assert.ok(pct < 20, `Steel repair is ${pct}%, want under 20%`);
    } else {
      assert.ok(pct >= 30 && pct <= 55, `tier ${t} repair is ${pct}%, want 30-55%`);
    }
  }
});

// --- section 7: redemption ----------------------------------------------------

test('payout is 90% of face value', () => {
  assert.equal(PAYOUT_BPS, 9000);
  // 100 Quartz -> 100 * 0.00005 * 0.9
  assert.equal(payoutWei(100, 0), ETH(0.00005) * 100n * 9n / 10n);
});

test('redemption floor is 0.005 ETH, matching minSplay', () => {
  assert.equal(REDEEM_FLOOR, ETH(0.005));
  // 0.005 / (0.00005 * 0.9) = 111.1, so 112 Quartz is the first count that
  // clears the floor. 100 does not: it pays 0.0045.
  assert.equal(payoutWei(100, 0), ETH(0.0045));
  assert.ok(payoutWei(112, 0) >= REDEEM_FLOOR, '112 Quartz should clear the floor');
  assert.ok(payoutWei(111, 0) < REDEEM_FLOOR, '111 Quartz should fall short');
});

// --- section 8: payback -------------------------------------------------------

test('every tier pays back in roughly 470-530 hunts, except Wood', () => {
  // Wood is the cheap entry rung at 202 and is meant to be. The point of the
  // ladder is that the SAME decision faces the player at every rung after it.
  assert.ok(paybackHunts(1) < 260, `Wood pays back in ${paybackHunts(1)}`);
  for (const t of [2, 3, 4, 5]) {
    const h = paybackHunts(t);
    assert.ok(h >= 440 && h <= 560, `tier ${t} pays back in ${h} hunts, want 440-560`);
  }
});

test('net per hunt is positive at every tier', () => {
  // If this ever goes negative the tier is unplayable: you pay to hunt and
  // lose money doing it.
  for (let t = 1; t <= 5; t++) {
    assert.ok(netHuntWei(t) > 0n, `tier ${t} nets ${netHuntWei(t)} per hunt`);
  }
});

test('extra durability did not shorten payback', () => {
  // Regression guard for the real risk in the +5 durability change: more uses
  // per repair improves yield per hunt, which silently cuts the hunt count
  // unless the repair costs were scaled to match. Compare against the flat-20
  // numbers the spec quotes.
  const FLAT20 = { 1: 202, 2: 481, 3: 521, 4: 477, 5: 519 };
  for (const [t, was] of Object.entries(FLAT20)) {
    const now = paybackHunts(Number(t));
    const drift = Math.abs(now - was) / was;
    assert.ok(drift < 0.10, `tier ${t}: ${now} vs ${was} is ${(drift * 100).toFixed(0)}% off`);
  }
});

test('yield per hunt rises with tier', () => {
  for (let t = 1; t < 5; t++) {
    assert.ok(
      huntValueWei(t + 1) > huntValueWei(t),
      `tier ${t + 1} (${huntValueWei(t + 1)}) must beat tier ${t} (${huntValueWei(t)})`,
    );
  }
});

// --- formatting ----------------------------------------------------------------

test('fmtEth trims trailing zeros', () => {
  assert.equal(fmtEth(ETH(0.005)), '0.005 ETH');
  assert.equal(fmtEth(ETH(2.3)), '2.3 ETH');
  assert.equal(fmtEth(0n), '0 ETH');
});

test('fmtRepair renders short labels', () => {
  // Pinned to the chain's live table (V9): Wood 5Q, Bronze 3Q+2A. These are
  // the strings players actually see on the belt chip -- the old values here
  // ('9Qtz', '5Qtz + 4Amb') are what made the repair UI display costs the
  // contract never charged.
  assert.equal(fmtRepair(1), '5Qtz');
  assert.equal(fmtRepair(2), '3Qtz + 2Amb');
});
// --- skill titles (the craft ladder) --------------------------------------

test('the five skill levels are Greenhorn/Prospector/Delver/Assayer/Lapidary', () => {
  assert.deepEqual(SKILL_NAME, ['Greenhorn', 'Prospector', 'Delver', 'Assayer', 'Lapidary']);
  assert.equal(SKILL_NAME.length, 5, 'skill 0..4 is five states');
});

test('skill names uppercase cleanly for the button label', () => {
  assert.deepEqual(SKILL_NAME_UC, ['GREENHORN', 'PROSPECTOR', 'DELVER', 'ASSAYER', 'LAPIDARY']);
});

test('every skill level names the gem it unlocks', () => {
  // Skill N -> Rarity(N); the subtitle is what the button tooltip promises.
  for (const lv of [1, 2, 3, 4]) {
    const sub = skillSubtitle(lv);
    const gem = RARITY_NAME[SKILL_UNLOCKS[lv]];
    assert.ok(sub.includes(gem), `skill ${lv} subtitle should name ${gem}, got "${sub}"`);
  }
});

test('skill 0 is the baseline -- Quartz only, nothing unlocked yet', () => {
  assert.equal(skillSubtitle(0), 'Quartz only');
  assert.equal(skillName(0), 'Greenhorn');
});

test('skills 3 and 4 advertise the extra slot they grant', () => {
  // Contract: newSlots = baseSlots + (skill>=3) + (skill>=4). The subtitle has
  // to say so, or the extra slot is an invisible bonus.
  assert.ok(skillSubtitle(3).includes('slot'), 'skill 3 grants a slot');
  assert.ok(skillSubtitle(4).includes('slot'), 'skill 4 grants a slot');
  assert.ok(!skillSubtitle(1).includes('slot'), 'skill 1 grants no slot');
  assert.ok(!skillSubtitle(2).includes('slot'), 'skill 2 grants no slot');
});

test('skillName clamps out-of-range input instead of returning undefined', () => {
  assert.equal(skillName(-1), 'Greenhorn');
  assert.equal(skillName(99), 'Lapidary');
  assert.equal(skillName(undefined), 'Greenhorn');
  assert.equal(skillName(NaN), 'Greenhorn');
});

// --- hunter card avatars ---------------------------------------------------

test('there are five tool avatars and five skill avatars', () => {
  // TOOL_AVATARS[0] is the empty "no tool" slot; 1..5 are the five picks.
  assert.equal(TOOL_AVATARS.length, 6);
  assert.equal(SKILL_AVATARS.length, 5);
  for (let t = 1; t <= 5; t++) {
    assert.ok(TOOL_AVATARS[t].startsWith('<svg'), `tool ${t} avatar is an SVG`);
    assert.ok(TOOL_AVATARS[t].includes('viewBox'), `tool ${t} has a viewBox`);
  }
  for (let s = 0; s <= 4; s++) {
    assert.ok(SKILL_AVATARS[s].startsWith('<svg'), `skill ${s} avatar is an SVG`);
    assert.ok(SKILL_AVATARS[s].includes('viewBox'), `skill ${s} has a viewBox`);
  }
});

test('each tool tier wears its own metal', () => {
  // The five picks must not all be the same colour, or the ladder reads as
  // five copies of one icon.
  const metals = TOOL_AVATARS.slice(1).map((svg) => /stop-color="([^"]+)"/.exec(svg)?.[1]);
  assert.equal(new Set(metals).size, 5, 'five distinct tool metals');
});

test('tool skins recolor the haft and add the wrap band, never the head', () => {
  const skin = { id: 'ember-trim', haft: '#8a5b3a', wrap: '#ff7a3d' };
  const svg = toolAvatarSkinned(3, skin);
  assert.ok(svg.includes('#8a5b3a'), 'haft takes the skin color');
  assert.ok(svg.includes('#ff7a3d'), 'the wrap band paints');
  assert.equal(toolAvatarSkinned(3, null), TOOL_AVATARS[3], 'null skin is the base avatar');
  // The head metal is EARNED progress: a skin must not touch it.
  const metal = /stop-color="([^"]+)"/.exec(TOOL_AVATARS[3])?.[1];
  assert.ok(svg.includes(`stop-color="${metal}"`), 'the tier metal is unchanged');
  assert.ok(!TOOL_AVATARS[3].includes('#8a5b3a'), 'base avatars stay untouched');
});

test('V6 formatter speaks DEEPWOOD with whole units, never ETH', () => {
  // The find flash used to divide gem value by 1e18 and append 'ETH'; since
  // V6 that wei figure is $DEEPWOOD. Pin the CURRENT contract of fmtEth so
  // a future find-flash regression has a failing test, not a user report.
  assert.equal(fmtEth(86_000_000_000_000_000_000_000n), '86000 DEEPWOOD');
  assert.equal(fmtEth(400_000_000_000_000_000_000n), '400 DEEPWOOD');
  assert.equal(fmtEth(0n), '0 DEEPWOOD');
  assert.ok(!fmtEth(86_000_000_000_000_000_000_000n).includes('ETH'), 'no ETH label on DEEPWOOD amounts');
});

test('higher skill ranks get more facets', () => {
  // The skill ladder is a cut gem that gains facets as it climbs, so the
  // polygon point count must rise with the rank -- otherwise the avatar row
  // gives no visual sense of progression.
  const points = SKILL_AVATARS.map((svg) => {
    const m = /points="([^"]+)"/.exec(svg);
    return m ? m[1].trim().split(/\s+/).length : 0;
  });
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i] >= points[i - 1], `skill ${i} should not have fewer facets than ${i - 1}`);
  }
  assert.ok(points[4] > points[0], 'Lapidary is visibly more cut than Greenhorn');
});

test('the tool ladder names five rungs starting at Wood', () => {
  // Regression: renderHunter passed TIER_NAME.slice(1) with offset 1, which
  // skipped Wood and left the fifth rung undefined ("Bronze, Iron, Steel,
  // Gold, undefined"). TIER_NAME is index-aligned to the tier, so the ladder
  // must read TIER_NAME[1..5] and every one must be a real name.
  const rungs = [];
  for (let i = 1; i <= 5; i++) rungs.push(TIER_NAME[i]);
  assert.deepEqual(rungs, ['Wood', 'Bronze', 'Iron', 'Steel', 'Gold']);
  assert.ok(rungs.every((n) => typeof n === 'string' && n.length > 0), 'no empty rung');
  assert.ok(!rungs.includes(undefined), 'no undefined rung');
});
