import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PERCENT_STEPS, percentAmount, clampAmount, rarityRows, redeemState, fmtToken, normalizeRedeemQuote,
} from './redeem.js';

// The card's rules, pinned. Each of these guards a specific way the card can
// ask a player to sign something the contract will refuse, or let them redeem
// a position they did not mean to.
//
// RAW COUNTS: held balances and typed amounts are BigInt whole-gem counts now
// (gems are items, not wei). The helpers still tolerate legacy Numbers -- the
// numeric-call asserts pin that compat path.

test('the percentage chips are the four the design calls for', () => {
  assert.deepEqual(PERCENT_STEPS, [25, 50, 75, 100]);
});

test('a percentage chip floors, never rounds up', () => {
  // 25% of 5 is 1.25 -- offering 2 would quote a redemption of gems the
  // player does not hold.
  assert.equal(percentAmount(5n, 25), 1n);
  assert.equal(percentAmount(1600n, 25), 400n);
  assert.equal(percentAmount(1600n, 50), 800n);
  assert.equal(percentAmount(1600n, 75), 1200n);
  // Legacy numbers still work.
  assert.equal(percentAmount(1600, 25), 400n);
});

test('100% is exact and is a full drain', () => {
  assert.equal(percentAmount(1600n, 100), 1600n);
  assert.equal(percentAmount(7n, 100), 7n);
  // Even a balance that does not divide by 4 must come out whole at 100%.
  assert.equal(percentAmount(3n, 100), 3n);
});

test('percentAmount on an empty balance is zero, not NaN', () => {
  assert.equal(percentAmount(0n, 100), 0n);
  assert.equal(percentAmount(undefined, 50), 0n);
  assert.equal(percentAmount(-4, 25), 0n);
});

test('typed input is clamped to the balance', () => {
  assert.equal(clampAmount('1600', 1600n), 1600n);
  assert.equal(clampAmount('99999', 1600n), 1600n, 'over the balance clamps down');
});

test('typed input survives what a keyboard actually produces', () => {
  // Digits with separators, a decimal point, a minus sign, and blank are all
  // reachable states of the text box. None may produce NaN.
  assert.equal(clampAmount('1,600', 1600n), 1600n);
  assert.equal(clampAmount('12.5', 1600n), 125n);
  assert.equal(clampAmount('-3', 1600n), 3n);
  assert.equal(clampAmount('', 1600n), 0n);
  assert.equal(clampAmount('abc', 1600n), 0n);
  assert.equal(clampAmount(null, 1600n), 0n);
});

test('blank means nothing selected, not everything', () => {
  // The dangerous alternative: treating "" as "all". A player who clears the
  // field and taps redeem would dump the whole position.
  assert.equal(clampAmount('', 1600n), 0n);
});

test('every rarity gets a row, empty ones are not selectable', () => {
  const rows = rarityRows([1600n, 0n, 5n, 0n, 0n]);
  assert.equal(rows.length, 5, 'the card must not reflow as balances change');
  assert.equal(rows[0].selectable, true);
  assert.equal(rows[1].selectable, false, 'an empty rarity cannot be picked');
  assert.equal(rows[2].held, 5n);
  assert.equal(rows[4].name, 'Diamond');
});

test('rarityRows tolerates a short or missing balance array', () => {
  assert.equal(rarityRows(undefined).length, 5);
  assert.equal(rarityRows([]).every((r) => r.held === 0n), true);
});

test('a redemption below the contract floor is blocked before signing', () => {
  const floor = 5_000_000_000_000_000n; // 0.005 token-wei
  const st = redeemState({
    held: 1600n, amount: 1n, quoteWei: 1_000_000_000_000n, floorWei: floor, railActive: true,
  });
  assert.equal(st.ok, false);
  assert.equal(st.kind, 'floor');
});

test('a redemption at or above the floor is allowed', () => {
  const floor = 5_000_000_000_000_000n;
  const st = redeemState({
    held: 1600n, amount: 100n, quoteWei: floor, floorWei: floor, railActive: true,
  });
  assert.equal(st.ok, true);
});

test('the floor message carries the contract minimum, formatted', () => {
  // The raw 18-decimal integer (20000000000000000000000) is unreadable in a
  // status line. The player needs the human number (20,000) so they can see
  // the threshold and stop typing amounts that are guaranteed to revert.
  const floor = 20_000n * 10n ** 18n; // the live contract's minRedeemWei
  const st = redeemState({
    held: 19n, amount: 4n, quoteWei: 1_440n * 10n ** 18n, floorWei: floor, railActive: true,
  });
  assert.equal(st.ok, false);
  assert.equal(st.kind, 'floor');
  assert.match(st.reason, /20,000/);
  assert.doesNotMatch(st.reason, /20000000000000000000000/);
});

test('a locked rail blocks even a valid amount', () => {
  const st = redeemState({
    held: 1600n, amount: 1600n, quoteWei: 10n ** 21n, floorWei: 1n, railActive: false,
  });
  assert.equal(st.ok, false);
  assert.equal(st.kind, 'locked');
});

test('over-balance and zero are blocked with their own reasons', () => {
  const base = { quoteWei: 10n ** 21n, floorWei: 1n, railActive: true };
  assert.equal(redeemState({ ...base, held: 5n, amount: 6n }).kind, 'over');
  assert.equal(redeemState({ ...base, held: 5n, amount: 0n }).kind, 'zero');
  assert.equal(redeemState({ ...base, held: 0n, amount: 0n }).kind, 'empty');
});

test('a slow quote read does not block the button', () => {
  // quoteWei null = the read has not landed. The chain is the authority; a
  // lagging RPC must not present a dead button.
  const st = redeemState({
    held: 1600n, amount: 1600n, quoteWei: null, floorWei: 5n, railActive: true,
  });
  assert.equal(st.ok, true);
});

test('token amounts are grouped and trimmed for display', () => {
  assert.equal(fmtToken(0n), '0');
  assert.equal(fmtToken(1600n * 10n ** 18n), '1,600');
  assert.equal(fmtToken(1234567n * 10n ** 18n), '1,234,567');
  assert.equal(fmtToken(1_500_000_000_000_000_000n), '1.5');
  assert.equal(fmtToken(null), '--');
});

// --- the "You receive" estimate must follow every control that sets amount --
//
// Regression: the percentage chips and the rarity buttons used to set `amount`
// and call render() only. render() paints from the CACHED quoteWei, so the
// estimate stayed at '--' until the player typed in the box by hand. The fix
// is that every path which changes the selection or the amount also calls
// refreshQuote(). This asserts the CONTRACT of that wiring at the source level,
// because the card is DOM-heavy and a behavioural test would need a full DOM.

test('every control that sets the amount also refreshes the quote', async () => {
  const src = await readFile(new URL('./redeemcard.js', import.meta.url), 'utf8');

  // The three controls that can change what the player is redeeming.
  for (const handler of ['elPcts.querySelectorAll', 'elRarities.querySelectorAll']) {
    const i = src.indexOf(handler);
    assert.ok(i > 0, `${handler} should exist`);
    const block = src.slice(i, i + 700);
    assert.ok(
      block.includes('refreshQuote()'),
      `${handler} must call refreshQuote() so the estimate updates`,
    );
  }

  // The manual input already did this; keep it pinned so a refactor cannot
  // silently drop it and regress the same way.
  const inputIdx = src.indexOf('elInput.addEventListener');
  assert.ok(inputIdx > 0, 'the input handler should exist');
  assert.ok(
    src.slice(inputIdx, inputIdx + 400).includes('refreshQuote()'),
    'the manual input must call refreshQuote()',
  );
});


// --- normalizeRedeemQuote: the estimate-shape bridge -----------------------
// Regression: the reader returns a raw [payout, aboveFloor] array; the card
// read `.tokens` off it and the "You receive" line showed '--' forever.
test('normalizeRedeemQuote accepts the reader array shape', () => {
  const q = normalizeRedeemQuote([450000000000000000000n, true]);
  assert.equal(q.tokens, 450000000000000000000n);
  assert.equal(q.aboveFloor, true);
  assert.equal(normalizeRedeemQuote([0n, false]).aboveFloor, false);
});

test('normalizeRedeemQuote accepts named/object shapes and rejects garbage', () => {
  assert.equal(normalizeRedeemQuote(null), null);
  assert.equal(normalizeRedeemQuote(undefined), null);
  assert.equal(normalizeRedeemQuote({}), null);
  assert.equal(normalizeRedeemQuote(['not-a-bigint', true]), null);
  const named = normalizeRedeemQuote({ tokens: 5n, aboveFloor: false });
  assert.equal(named.tokens, 5n);
  assert.equal(named.aboveFloor, false);
  const payout = normalizeRedeemQuote({ payout: 7n, aboveFloor: true });
  assert.equal(payout.tokens, 7n);
  assert.equal(payout.aboveFloor, true);
});
