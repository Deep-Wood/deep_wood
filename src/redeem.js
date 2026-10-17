// Redemption card logic: pure functions so the card's maths and its guards are
// testable without a DOM or a chain.
//
// The card lets a player pick ONE rarity and an amount, then redeem it for
// $DEEPWOOD. The contract redeems a single rarity per call (see
// DeepWoodV4.redeemGems), so the card is single-rarity by construction rather
// than by UI accident -- a multi-select would need several signatures and would
// quote a total the contract never charges.

/** The percentage chips, in the order they appear. */
export const PERCENT_STEPS = [25, 50, 75, 100];

/**
 * How many gems a percentage chip selects.
 *
 * `held` is the player's balance for the chosen rarity. Floor, never round:
 * 25% of 5 gems is 1, and offering 2 would quote a redemption the player
 * cannot pay for. 100% is exact and is the only chip guaranteed to be a
 * full drain.
 */
export function percentAmount(held, pct) {
  const h = typeof held === 'bigint' ? held : BigInt(Math.trunc(Number(held)) || 0);
  if (h <= 0n) return 0n;
  if (pct >= 100) return h;
  return (h * BigInt(pct)) / 100n;
}

/**
 * Clamp raw text input to a legal redemption amount.
 *
 * Accepts what a player actually types: "", "12", "1 2", "12.5", "-3", "1e4".
 * Returns an integer in [0, held]. Deliberately tolerant -- the input field is
 * a text box the player types into, so a rejected keystroke must never wedge
 * the card in a state where the button is enabled but the value is NaN.
 *
 * Blank input returns 0 (an explicit "nothing selected"), not `held`: a field
 * that silently means "everything" is how a player accidentally dumps a
 * position they meant to sample.
 */
export function clampAmount(raw, held) {
  const h = typeof held === 'bigint' ? held : BigInt(Math.trunc(Number(held)) || 0);
  if (h < 0n) return 0n;
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (digits === '') return 0n;
  // Digits-only input cannot overflow BigInt, but cap the parse anyway.
  let n;
  try { n = BigInt(digits); } catch { return 0n; }
  if (n < 0n) return 0n;
  return n > h ? h : n;
}

/**
 * Which rarity rows the card shows.
 *
 * Every rarity is listed, including empty ones, so the card is a stable five
 * rows rather than a list that reflows as balances change -- a row vanishing
 * under the player's finger is how a mis-tap happens. Empty rows are marked
 * `selectable: false` so the UI can grey them without the caller re-deriving
 * the rule.
 */
export function rarityRows(balances) {
  const names = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];
  // Raw BigInt counts (whole gems) from the scene; accept legacy Numbers too.
  const raw = (i) => {
    const v = balances?.[i];
    try { return typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)) || 0); }
    catch { return 0n; }
  };
  return names.map((name, i) => {
    const held = raw(i);
    return { rarity: i, name, held, selectable: held > 0n };
  });
}

/**
 * The state of the redeem button and the summary line under it.
 *
 * @param {object} o
 * @param {number} o.held     player's balance for the selected rarity
 * @param {number} o.amount   the amount currently entered
 * @param {bigint} o.quoteWei contract's quoted payout for that amount, or null
 * @param {bigint} o.floorWei the contract's minimum redemption (minRedeemWei)
 * @param {boolean} o.railActive  is token redemption open yet?
 * @returns {{ok: boolean, reason: string, kind: string}}
 */
export function redeemState({ held, amount, quoteWei, floorWei, railActive }) {
  if (!railActive) {
    return {
      ok: false,
      kind: 'locked',
      reason: 'Redemption opens when the season graduates.',
    };
  }
  if (!(held > 0n)) {
    return { ok: false, kind: 'empty', reason: 'No gems of that kind.' };
  }
  if (!(amount > 0n)) {
    return { ok: false, kind: 'zero', reason: 'Choose an amount to redeem.' };
  }
  if (amount > held) {
    return {
      ok: false,
      kind: 'over',
      reason: `You hold ${held} - you cannot redeem ${amount}.`,
    };
  }
  // The floor is a real on-chain rejection (BelowMinRedeem), so it is checked
  // here to keep the player from signing a transaction that is guaranteed to
  // revert. A null quote means the read has not landed yet: allow the button
  // and let the chain be the authority, rather than blocking on a slow RPC.
  if (quoteWei != null && floorWei != null && quoteWei < floorWei) {
    return {
      ok: false,
      kind: 'floor',
      reason: 'Too small to redeem - add more gems.',
    };
  }
  return { ok: true, kind: 'ready', reason: '' };
}

/**
 * Format a $DEEPWOOD amount (18 decimals) for display.
 *
 * Grouped thousands, at most 4 significant decimals, trailing zeros trimmed.
 * A raw wei figure in the UI is unreadable and a full-precision one is worse.
 */
export function fmtToken(wei) {
  if (wei == null) return '--';
  const n = Number(wei) / 1e18;
  if (!Number.isFinite(n)) return '--';
  if (n === 0) return '0';
  const fixed = n.toFixed(4).replace(/\.?0+$/, '');
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}
