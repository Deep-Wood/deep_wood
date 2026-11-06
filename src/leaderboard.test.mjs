/**
 * Leaderboard best-find mapping tests.
 *
 * The contract stores bestSingleFindWei = priceOf(r) of the single best gem
 * ever rolled (DeepWood.sol: bestSingleWei = max over gems of priceOf(picked);
 * the player stat is the max over hunts). The leaderboard must show that AS A
 * GEM, so playerRow matches bestWei back to a rarity against the LIVE
 * priceOf(0..4) reads — never the local FACE_VALUE table, which the
 * owner-settable chain prices do not have to agree with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { playerRow, rankRows } = await import('./leaderboard.js');

// Live-shaped price table (owner-settable on V6+; deliberately DIFFERENT from
// the local FACE_VALUE table to prove the mapping uses the chain reads).
const PRICES = [5n * 10n ** 13n, 4n * 10n ** 14n, 3n * 10n ** 15n, 25n * 10n ** 15n, 2n * 10n ** 17n];

function mockChain({ best, prices = PRICES }) {
  return {
    playerStats: async () => ({
      totalEarned: 10n, tokenSpent: 20n, burned: 0n, best, leq: 64n, hunts: 5n,
    }),
    seasonScore: async () => 64n,
    roi: async () => 3n * 10n ** 18n,
    onRoiBoard: async () => true,
    priceOf: async (r) => prices[r],
  };
}

test('bestWei equal to a live priceOf maps to that rarity (best gem shown as gem)', async () => {
  for (let r = 0; r < 5; r++) {
    const row = await playerRow(mockChain({ best: PRICES[r] }), '0xABCDEF0000000000000000000000000000000001');
    assert.equal(row.bestRarity, r, `bestWei=priceOf(${r}) must map to rarity ${r}`);
    assert.equal(row.bestWei, PRICES[r]);
  }
});

test('bestWei of zero (no hunts yet) maps to no rarity, not Quartz', async () => {
  const row = await playerRow(mockChain({ best: 0n }), '0xabc');
  assert.equal(row.bestRarity, -1);
});

test('a legacy bestWei that matches no live price maps to -1 (caller falls back to the token amount)', async () => {
  const row = await playerRow(mockChain({ best: 123456789n }), '0xabc');
  assert.equal(row.bestRarity, -1);
  assert.equal(row.bestWei, 123456789n);
});

test('a failed priceOf read degrades to -1 instead of throwing', async () => {
  const chain = mockChain({ best: PRICES[4] });
  chain.priceOf = async () => { throw new Error('rpc down'); };
  const row = await playerRow(chain, '0xabc');
  assert.equal(row.bestRarity, -1);
});

test('rankRows orders by the exact displayed ROI (score per tokenSpent), not the truncated chain roi', () => {
  // Live 2026-11-05 shape: chain roi() truncates to 0 for everyone, so the old
  // sort fell through to bestWei and put trader2 (smaller ROI) at #1.
  const rows = [
    { address: '0xd1bd', roi: 0n, score: 2211n, tokenSpent: 22500000n * 10n ** 18n, bestWei: 86n * 10n ** 21n, leq: 2216n, onBoard: true }, // exact 9.8e-5
    { address: '0x89aa', roi: 0n, score: 981n, tokenSpent: 4700000n * 10n ** 18n, bestWei: 78n * 10n ** 20n, leq: 981n, onBoard: true },   // exact 2.1e-4
    { address: '0xba85', roi: 0n, score: 7n, tokenSpent: 200000n * 10n ** 18n, bestWei: 4n * 10n ** 20n, leq: 7n, onBoard: true },          // exact 3.5e-5
  ];
  const ranked = rankRows(rows);
  assert.deepEqual(ranked.map((r) => r.address), ['0x89aa', '0xd1bd', '0xba85']);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3]);
});

test('rankRows still orders by bestWei when the exact ROIs tie, and keeps unranked last', () => {
  const rows = [
    { address: '0xa', roi: 0n, score: 10n, tokenSpent: 10n ** 18n, bestWei: PRICES[1], leq: 0n, onBoard: true },
    { address: '0xb', roi: 0n, score: 10n, tokenSpent: 10n ** 18n, bestWei: PRICES[4], leq: 0n, onBoard: true },
    { address: '0xc', roi: 0n, score: 10n, tokenSpent: 10n ** 18n, bestWei: PRICES[2], leq: 0n, onBoard: true },
    { address: '0xoff', roi: 0n, score: 999n, tokenSpent: 10n ** 18n, bestWei: PRICES[4], leq: 0n, onBoard: false },
  ];
  const ranked = rankRows(rows);
  assert.deepEqual(ranked.map((r) => r.address), ['0xb', '0xc', '0xa', '0xoff']);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, 0]);
  // bestRarity rides through the spread untouched
  assert.equal(ranked[0].bestRarity, undefined); // rows built without the field stay pass-through
});

test('rankRows: zero-spend player (display 0x) ranks below any positive ratio', () => {
  const rows = [
    { address: '0xzero', roi: 0n, score: 5n, tokenSpent: 0n, bestWei: PRICES[4], leq: 0n, onBoard: true },
    { address: '0xsome', roi: 0n, score: 1n, tokenSpent: 10n ** 30n, bestWei: PRICES[0], leq: 0n, onBoard: true },
  ];
  const ranked = rankRows(rows);
  assert.deepEqual(ranked.map((r) => r.address), ['0xsome', '0xzero']);
});
