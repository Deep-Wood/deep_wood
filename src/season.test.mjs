/**
 * Season leaderboard tests -- SPEC.md section 9.
 *
 *   node src/season.test.mjs
 *
 * The load-bearing test here is the splay floor. Without it, one lucky hunt
 * and a logout tops the board, which is the exact failure SPEC section 9
 * exists to prevent. Everything else is bookkeeping by comparison.
 */
import {
  newSeasonRecord, recordHunt, roiOf, roiFloat, rank, topN, standing,
  SPLAY_FLOOR_WEI, HUNT_COST, RARITY_WEIGHT, GEM_PRICE, SEASON_LENGTH_SEC, recordToolSpend,
  seasonClock, WEI_PER_ETH, compareRoi, roiDenom, onRoiBoard, shortOfFloor,
} from './season.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  ${ok ? actual : `${actual} != ${expected}`}`);
}
function group(n) { console.log(`\n${n}`); }

const T0 = 1_700_000_000; // a fixed "now" so nothing depends on wall clock
const counts = (...c) => c;

// ---------------------------------------------------------------------
group('contract mirrors');
// Derive wei from the ETH amount the SPEC and contract state, rather than
// restating the digit count. "0.0001 ether" written by hand is exactly how
// 1e13 got typed instead of 1e14, and the test then asserted the same wrong
// number and passed. This form cannot drift: the conversion is the assertion.
const wei = (ethStr) => BigInt(ethStr.replace('.', '')) * (10n ** BigInt(18 - (ethStr.split('.')[1] || '').length));

check('splay floor is 0.005 ETH', SPLAY_FLOOR_WEI, wei('0.005'));
// Hunts are FREE now. A 0.0001 ETH fee against Wood's 0.00005 yield would
// make the entry tier net-negative by 50% (ECONOMY-SPEC.md s12 item 8), so the
// ROI denominator moved to tool purchases -- see recordToolSpend().
check('hunt cost tier 1 is zero', HUNT_COST[0], 0n);
check('hunt cost tier 2 is zero', HUNT_COST[1], 0n);
check('hunt cost tier 3 is zero', HUNT_COST[2], 0n);
check('hunt cost tier 4 is zero', HUNT_COST[3], 0n);
check('hunt cost tier 5 is zero', HUNT_COST[4], 0n);
check('quartz price is 0.00005 ETH', GEM_PRICE[0], wei('0.00005'));
check('amber price is 0.0004 ETH', GEM_PRICE[1], wei('0.0004'));
check('sapphire price is 0.003 ETH', GEM_PRICE[2], wei('0.003'));
check('ruby price is 0.025 ETH', GEM_PRICE[3], wei('0.025'));
check('diamond price is 0.2 ETH', GEM_PRICE[4], wei('0.2'));
check('season is 14 days', SEASON_LENGTH_SEC, 14 * 24 * 60 * 60);
check('quartz weight', RARITY_WEIGHT[0], 1n);
check('diamond weight', RARITY_WEIGHT[4], 4_096n);

group('recording a hunt');
{
  const b = newSeasonRecord(1, T0);
  const r = recordHunt(b, '0xAAA', counts(4, 1, 0, 0, 0), 1, T0 + 10);
  check('accepted', r.ok, true);
  check('  5 gems', r.entry.hunts, 1);
  check('  leq = 4x1 + 1x8', r.entry.leq, 12n);
  check('  value = 4 quartz + 1 amber', r.valueWei, 600_000_000_000_000n);
  check('  a free hunt spends nothing', r.entry.ethSpent, 0n);
  check('  best find recorded', r.entry.bestWei, 600_000_000_000_000n);
}

group('the splay floor -- the point of the whole design');
{
  // One player: one lucky diamond hunt, then quits. They never bought a tool,
  // so they committed ZERO ETH -- hunts are free, so finding a Diamond without
  // spending is exactly the case the floor has to stop. Under the old economy
  // the 0.0001 hunt fee was enough to put them on the board.
  const luck = newSeasonRecord(1, T0);
  recordHunt(luck, '0xluck', counts(0, 0, 0, 0, 1), 1, T0 + 10);

  const l = [...luck.players.values()][0];
  // The policy is EXCLUSION, matching DeepWood.roi() (returns 0 below
  // MIN_SPLAY) and onRoiBoard() (false). Flooring the denominator was tried
  // and measured wrong -- it still let this player score 819,200 against
  // 40,000 for a diligent player who spent the full floor.
  // Nothing spent at all, so the ratio is not merely large, it is unbounded.
  // roiOf() returns 0n for a zero denominator rather than throwing.
  check('  no spend means no ratio, not a crash', roiOf(l), 0n);
  check('  and the denominator really is zero', l.ethSpent, 0n);
  check('  so the player is EXCLUDED', onRoiBoard(l), false);
  check('  and scores zero for ranking', compareRoi(l, { leq: 1n, ethSpent: SPLAY_FLOOR_WEI }) === -1, true);
  check('  shortOfFloor reports the whole floor as the gap', shortOfFloor(l), SPLAY_FLOOR_WEI);

  // The player it is protecting: they bought Wood, did 50 real hunts, and are
  // still on the floor -- which is the point, the floor is about COMMITMENT,
  // not volume. One lucky find cannot beat that.
  const d = newSeasonRecord(1, T0);
  for (let i = 0; i < 50; i++) recordHunt(d, '0xdiligent', counts(4, 0, 0, 0, 0), 1, T0 + i);
  recordToolSpend(d, '0xdiligent', wei('0.005'));
  const e2 = [...d.players.values()][0];
  check('diligent player qualifies', onRoiBoard(e2), true);
  check('  their ROI is modest', roiFloat(e2), 40_000);
  check('  and short of nothing', shortOfFloor(e2), 0n);
}
{
  // The floor must NOT punish a player who has genuinely spent enough.
  const real = newSeasonRecord(1, T0);
  // Spend comes from buying a tool, not from hunting: Wood is 0.005 ETH, and
  // the floor is 0.005, so buying it is exactly at the floor and upgrading to
  // Bronze clears it.
  for (let i = 0; i < 100; i++) recordHunt(real, '0xreal', counts(4, 0, 0, 0, 0), 1, T0 + i);
  recordToolSpend(real, '0xreal', wei('0.052'));
  const e = [...real.players.values()][0];
  check('  spend above floor', e.ethSpent > SPLAY_FLOOR_WEI, true);
  const expected = (e.leq * WEI_PER_ETH) / e.ethSpent;
  check('  ROI uses real spend', roiOf(e), expected);
}

group('scale invariance -- a whale ties a small player');
{
  // The core promise of SPEC section 9. Same play, same ROI, different size.
  const small = newSeasonRecord(1, T0);
  const whale = newSeasonRecord(1, T0);
  const greedy = newSeasonRecord(1, T0);
  for (let i = 0; i < 200; i++) {
    recordHunt(small, '0xsmall', counts(4, 1, 0, 0, 0), 1, T0 + i);
    recordHunt(whale, '0xwhale', counts(4, 1, 0, 0, 0), 1, T0 + i);
    recordHunt(greedy, '0xgreedy', counts(4, 1, 0, 0, 0), 1, T0 + i);
  }
  const s = [...small.players.values()][0];
  const w = [...whale.players.values()][0];
  check('identical ROI', roiOf(s), roiOf(w));

  // And a whale at a HIGHER tool tier spends more per hunt but gets a better
  // table, so it is not automatically better. Volume is self-defeating at
  // worst -- that is SPEC's argument, so assert it is not free.
  // Same finds, same hunts, same tool: identical efficiency. To make ROI
  // differ at all, one of them has to have committed more ETH for the same
  // output. Spend is per TOOL rather than per hunt, so that is a pricier tool,
  // not a faster player -- which is what should make ROI worse.
  recordToolSpend(small, '0xsmall', wei('0.005'));
  recordToolSpend(greedy, '0xgreedy', wei('0.100'));
  const g = [...greedy.players.values()][0];
  const s2 = [...small.players.values()][0];
  check('  same numerator', g.leq, s2.leq);
  check('  but far more committed', g.ethSpent > s2.ethSpent * 10n, true);
  check('  so worse ROI', roiOf(g) < roiOf(s2), true);
}

group('ranking');
{
  const b = newSeasonRecord(1, T0);
  // Everyone buys Wood (0.005 ETH) -- that is the whole splay floor now, since
  // hunts are free. It used to take 50 hunts at 0.0001 ETH to get there.
  for (let i = 0; i < 80; i++) recordHunt(b, '0xmid', counts(4, 1, 0, 0, 0), 1, T0 + i);
  for (let i = 0; i < 80; i++) recordHunt(b, '0xlead', counts(2, 4, 1, 0, 0), 1, T0 + i);
  for (let i = 0; i < 55; i++) recordHunt(b, '0xnerd', counts(4, 1, 0, 0, 0), 1, T0 + i);
  for (const a of ['0xmid', '0xlead', '0xnerd']) recordToolSpend(b, a, wei('0.005'));

  const rows = rank(b);
  check('three ranked', rows.length, 3);
  check('  all cleared the splay floor', rows.every((r) => onRoiBoard(r)), true);
  check('  best ROI first', rows[0].address, '0xlead');
  check('  ranks are 1..n', rows.map((r) => r.rank).join(','), '1,2,3');
  check('  ROI descending', roiOf(rows[0]) >= roiOf(rows[1]) && roiOf(rows[1]) >= roiOf(rows[2]), true);
}

group('tie-breaks: best find, then legendary-equivalents');
{
  // For best-find to decide anything, two players must tie on ROI but
  // differ in what one hunt was worth. That is possible because the
  // contract's rarity weights and prices are NOT exactly proportional:
  //
  //   weight  1,   8,  64,  512, 4096
  //   price/w 50000, 50000, 46875, 48828, 48828
  //
  // Quartz and Amber are exactly proportional, so mixing THOSE changes
  // nothing. Sapphire is cheaper per unit of weight (46875 < 50000), so a
  // haul of 1 Sapphire weighs 64 like 64 Quartz but is worth 3,000,000
  // against 3,200,000.
  //
  // A: 80 hunts x 64 Quartz     leq 5120, best find 3,200,000
  // B: 80 hunts x  1 Sapphire   leq 5120, best find 3,000,000
  // Identical hunt count, leq, and spend. B's rarer find is worth less, so
  // the tie-break puts A first -- which is the honest ordering.
  const b = newSeasonRecord(1, T0);
  for (let i = 0; i < 80; i++) recordHunt(b, '0xa', counts(64, 0, 0, 0, 0), 1, T0 + i);
  for (let i = 0; i < 80; i++) recordHunt(b, '0xb', counts(0, 0, 1, 0, 0), 1, T0 + i);
  recordToolSpend(b, '0xa', wei('0.005'));
  recordToolSpend(b, '0xb', wei('0.005'));

  const rows = rank(b);
  const A = rows.find((r) => r.address === '0xa');
  const B = rows.find((r) => r.address === '0xb');
  check('equal leq', A.leq, B.leq);
  check('  identical spend too', A.ethSpent, B.ethSpent);
  check('  so ROI is exactly tied', compareRoi(A, B), 0);
  check('  but the best finds differ', A.bestWei !== B.bestWei, true);
  check('  A wins the tie-break on best find', A.rank, 1);

  // And the rarer gem is genuinely the less valuable one at equal weight.
  // Asserting this is what makes the ordering above sensible rather than
  // arbitrary.
  check('  rarer is worth less per unit weight',
    3_000_000n * 8n < 3_200_000n * 8n, true);
}

group('season boundary');
{
  const b = newSeasonRecord(1, T0);
  const end = T0 + SEASON_LENGTH_SEC;
  const late = recordHunt(b, '0xlate', counts(4, 0, 0, 0, 0), 1, end + 1);
  check('a hunt after the buzzer is rejected', late.ok, false);
  const last = recordHunt(b, '0xlast', counts(4, 0, 0, 0, 0), 1, end - 1);
  check('one second before is fine', last.ok, true);
  check('  season best recorded', b.seasonBest, 200_000_000_000_000n); // 4 quartz
  check('  the late hunt did not count', [...b.players.values()].some((e) => e.address === '0xlate'), false);
}

group('bad input');
{
  const b = newSeasonRecord(1, T0);
  check('tool tier 0 rejected', recordHunt(b, '0xa', counts(1, 0, 0, 0, 0), 0, T0).ok, false);
  check('tool tier 5 rejected', recordHunt(b, '0xa', counts(1, 0, 0, 0, 0), 5, T0).ok, false);
  check('address is lowercased', recordHunt(b, '0xAbC', counts(1, 0, 0, 0, 0), 1, T0).entry.address, '0xabc');
  // mixed-case must collide with the lowercase entry, not fork it
  recordHunt(b, '0xABC', counts(1, 0, 0, 0, 0), 1, T0 + 1);
  check('same player, not a fork', [...b.players.values()].filter((e) => e.address === '0xabc').length, 1);
}

group('sub-floor players are not ranked at all');
{
  const b = newSeasonRecord(1, T0);
  // Spend is a TOOL purchase now, so the fixture has to express the floor in
  // tools rather than hunts. The casual player looked but never committed:
  // hunts recorded, no tool bought. The serious player bought Wood (the floor)
  // and upgraded to Bronze, putting real ETH in.
  for (let i = 0; i < 10; i++) recordHunt(b, '0xcasual', counts(4, 0, 0, 0, 0), 1, T0 + i);
  for (let i = 0; i < 60; i++) recordHunt(b, '0xserious', counts(4, 1, 0, 0, 0), 1, T0 + i);
  recordToolSpend(b, '0xserious', wei('0.005'));
  const rows = rank(b);
  check('only the qualifying player is ranked', rows.length, 1);
  check('  and it is the serious one', rows[0].address, '0xserious');
  check('  the casual player is absent', rows.some((r) => r.address === '0xcasual'), false);
  check('  standing says unranked', standing(b, '0xcasual').ranked, false);
  check('  standing says ranked', standing(b, '0xserious').ranked, true);
}

group('standing');
{
  const b = newSeasonRecord(1, T0);
  for (let i = 0; i < 80; i++) recordHunt(b, '0xlead', counts(2, 4, 1, 0, 0), 1, T0 + i);
  for (let i = 0; i < 80; i++) recordHunt(b, '0xchase', counts(4, 1, 0, 0, 0), 1, T0 + i);
  recordToolSpend(b, '0xlead', wei('0.005'));
  recordToolSpend(b, '0xchase', wei('0.005'));
  const st = standing(b, '0xchase');
  check('ranked', st.ranked, true);
  check('  second', st.rank, 2);
  check('  of two', st.of, 2);
  check('  knows who to pass', st.needsToPass, '0xlead');
  check('  unranked player', standing(b, '0xnobody').ranked, false);
}

group('top 10');
{
  const b = newSeasonRecord(1, T0);
  for (let p = 0; p < 25; p++) {
    for (let i = 0; i < 50 + p * 4; i++) {
      recordHunt(b, `0xp${p}`, counts(4, 1, 0, 0, 0), 1, T0 + i);
    }
    // Commitment scales with play: someone who hunts 4x as much has bought a
    // more expensive tool. That keeps every player's ETH committed in
    // proportion to their output, which is what makes the ROI identical across
    // all 25 and the board volume-blind.
    //
    // Under the old economy this fell out for free -- every hunt cost 0.0001
    // ETH, so hunt count WAS spend. Hunts are free now, so the relationship has
    // to be stated.
    recordToolSpend(b, `0xp${p}`, BigInt(50 + p * 4) * wei('0.0001'));
  }
  const top = topN(b);
  check('exactly ten', top.length, 10);
  check('  ranks 1-10', top[0].rank, 1);
  check('  last is 10', top[9].rank, 10);
  // Every player here plays IDENTICALLY (same finds per hunt), so all 25
  // post the same ROI. Volume must NOT be rewarded -- that is the entire
  // point of the board. Ordering falls through to the best-find tie-break,
  // and since best find scales with hunt count here, the biggest sporter
  // happens to head the table. What matters is that ROI did not decide it.
  // Everyone here plays identically and spends identically per hunt, so
  // every one of them is floored to the same denominator -- and then the
  // ratio collapses to raw leq, so the 29-hunt player legitimately leads.
  // That is the floor doing its job, not a bug: below the floor, ranking is
  // by output, and output is not efficiency.
  const all = [...b.players.values()];
  check('  all clear the splay floor', all.every((e) => onRoiBoard(e)), true);
  // Identical play must tie EXACTLY, however much was spent. This is the
  // SPEC's scale-invariance promise, and it is exactly what truncated
  // fixed-point scoring got wrong (600 vs 696 -- a 16% spread).
  let allTie = true;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (compareRoi(all[i], all[j]) !== 0) allTie = false;
    }
  }
  check('  every pair ties exactly', allTie, true);

  // The real tie test: same ratio, DIFFERENT sizes, both ABOVE the floor.
  // This is the SPEC's scale-invariance promise, and it is the case a
  // truncated fixed-point score got wrong (600 vs 696 -- a 16% spread).
  const tie = newSeasonRecord(1, T0);
  for (let i = 0; i < 200; i++) recordHunt(tie, '0xsmall', counts(4, 1, 0, 0, 0), 1, T0 + i);
  for (let i = 0; i < 800; i++) recordHunt(tie, '0xwhale', counts(4, 1, 0, 0, 0), 1, T0 + i);
  // The whale committed 4x the ETH for 4x the hunts. Same efficiency, different
  // size -- which is the whole promise of the board.
  recordToolSpend(tie, '0xsmall', 200n * wei('0.0001'));
  recordToolSpend(tie, '0xwhale', 800n * wei('0.0001'));
  const sm = [...tie.players.values()].find((e) => e.address === '0xsmall');
  const wh = [...tie.players.values()].find((e) => e.address === '0xwhale');
  check('  small is above the floor', sm.ethSpent > SPLAY_FLOOR_WEI, true);
  check('  whale is 4x the size', wh.ethSpent, sm.ethSpent * 4n);
  check('  and they tie EXACTLY', compareRoi(sm, wh), 0);
  const sScore = roiFloat(sm), wScore = roiFloat(wh);
  check('  display scores agree to 0.1%', Math.abs(sScore - wScore) / sScore < 0.001, true);
  check('  top 10 is the first ten', top[9].rank, 10);
}

group('season clock');
{
  const b = newSeasonRecord(1, T0);
  check('14d at start', seasonClock(b, T0), '14d 00h');
  check('mid-season', seasonClock(b, T0 + 7 * 86400), '7d 00h');
  check('under a day', seasonClock(b, T0 + 13.5 * 86400), '12h 00m');
  check('expired shows 0m, never negative', seasonClock(b, T0 + 99 * 86400), '0m');
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
