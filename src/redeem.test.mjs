import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PERCENT_STEPS, percentAmount, clampAmount, rarityRows, redeemState, fmtToken,
} from './redeem.js';

// The card's rules, pinned. Each of these guards a specific way the card can
// ask a player to sign something the contract will refuse, or let them redeem
// a position they did not mean to.

test('the percentage chips are the four the design calls for', () => {
  assert.deepEqual(PERCENT_STEPS, [25, 50, 75, 100]);
});

test('a percentage chip floors, never rounds up', () => {
  // 25% of 5 is 1.25 -- offering 2 would quote a redemption of gems the
  // player does not hold.
  assert.equal(percentAmount(5, 25), 1);
  assert.equal(percentAmount(1600, 25), 400);
  assert.equal(percentAmount(1600, 50), 800);
  assert.equal(percentAmount(1600, 75), 1200);
});

test('100% is exact and is a full drain', () => {
  assert.equal(percentAmount(1600, 100), 1600);
  assert.equal(percentAmount(7, 100), 7);
  // Even a balance that does not divide by 4 must come out whole at 100%.
  assert.equal(percentAmount(3, 100), 3);
});

test('percentAmount on an empty balance is zero, not NaN', () => {
  assert.equal(percentAmount(0, 100), 0);
  assert.equal(percentAmount(undefined, 50), 0);
  assert.equal(percentAmount(-4, 25), 0);
});

test('typed input is clamped to the balance', () => {
  assert.equal(clampAmount('1600', 1600), 1600);
  assert.equal(clampAmount('99999', 1600), 1600, 'over the balance clamps down');
});

test('typed input survives what a keyboard actually produces', () => {
  // Digits with separators, a decimal point, a minus sign, and blank are all
  // reachable states of the text box. None may produce NaN.
  assert.equal(clampAmount('1,600', 1600), 1600);
  assert.equal(clampAmount('12.5', 1600), 125);
  assert.equal(clampAmount('-3', 1600), 3);
  assert.equal(clampAmount('', 1600), 0);
  assert.equal(clampAmount('abc', 1600), 0);
  assert.equal(clampAmount(null, 1600), 0);
});

test('blank means nothing selected, not everything', () => {
  // The dangerous alternative: treating "" as "all". A player who clears the
  // field and taps redeem would dump the whole position.
  assert.equal(clampAmount('', 1600), 0);
});

test('every rarity gets a row, empty ones are not selectable', () => {
  const rows = rarityRows([1600, 0, 5, 0, 0]);
  assert.equal(rows.length, 5, 'the card must not reflow as balances change');
  assert.equal(rows[0].selectable, true);
  assert.equal(rows[1].selectable, false, 'an empty rarity cannot be picked');
  assert.equal(rows[2].held, 5);
  assert.equal(rows[4].name, 'Diamond');
});

test('rarityRows tolerates a short or missing balance array', () => {
  assert.equal(rarityRows(undefined).length, 5);
  assert.equal(rarityRows([]).every((r) => r.held === 0), true);
});

test('a redemption below the contract floor is blocked before signing', () => {
  const floor = 5_000_000_000_000_000n; // 0.005 ETH
  const st = redeemState({
    held: 1600, amount: 1, quoteWei: 1_000_000_000_000n, floorWei: floor, railActive: true,
  });
  assert.equal(st.ok, false);
  assert.equal(st.kind, 'floor');
});

test('a redemption at or above the floor is allowed', () => {
  const floor = 5_000_000_000_000_000n;
  const st = redeemState({
    held: 1600, amount: 100, quoteWei: floor, floorWei: floor, railActive: true,
  });
  assert.equal(st.ok, true);
});

test('a locked rail blocks even a valid amount', () => {
  const st = redeemState({
    held: 1600, amount: 1600, quoteWei: 10n ** 21n, floorWei: 1n, railActive: false,
  });
  assert.equal(st.ok, false);
  assert.equal(st.kind, 'locked');
});

test('over-balance and zero are blocked with their own reasons', () => {
  const base = { quoteWei: 10n ** 21n, floorWei: 1n, railActive: true };
  assert.equal(redeemState({ ...base, held: 5, amount: 6 }).kind, 'over');
  assert.equal(redeemState({ ...base, held: 5, amount: 0 }).kind, 'zero');
  assert.equal(redeemState({ ...base, held: 0, amount: 0 }).kind, 'empty');
});

test('a slow quote read does not block the button', () => {
  // quoteWei null = the read has not landed. The chain is the authority; a
  // lagging RPC must not present a dead button.
  const st = redeemState({
    held: 1600, amount: 1600, quoteWei: null, floorWei: 5n, railActive: true,
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
