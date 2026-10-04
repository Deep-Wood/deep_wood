/**
 * Player economy state -- the client mirror of the new DeepWood.sol.
 *
 * Supersedes the old tools.js, which modelled the pre-redeploy contract:
 * four separately-owned tools with gem-priced claims, rotation between them,
 * and a single `common` counter. The new design (SPEC sections 1-7) is
 *
 *   - ONE tool. Upgrading replaces it. No rotation, no stow, no equip.
 *   - ETH buys and upgrades tools. Gems never do.
 *   - Gems repair, and gems sell for ETH.
 *   - Gem balances are tracked PER RARITY. The old code kept `common` plus a
 *     separate `totals[]` array for the satchel, both fed from counts[0], so
 *     the card showed two different numbers for the same gem and they drifted
 *     apart the moment you spent any. One balance, one source of truth.
 *
 * All prices and costs come from economy.js (which mirrors ECONOMY-SPEC.md).
 */

import {
  FACE_VALUE, TIER_NAME, durabilityOf, toolPrice, treasuryFee,
  repairCost, REDEEM_FLOOR, payoutWei,
} from './economy.js';

/** Fresh player: no tool, no gems, no skills. They must buy Wood with ETH. */
export function newPlayer() {
  return {
    /** @type {number} 0 = no tool yet. 1..5 once bought. */
    tier: 0,
    left: 0,          // durability remaining
    max: 0,           // durability when fully repaired
    /** @type {number[]} gem balance per rarity. THIS is the satchel. */
    gems: [0, 0, 0, 0, 0],
    /** Lifetime per-rarity totals found. Removed: the spendable balance is the
     *  only gem state; lifetime went away with the found/held split. */
    burned: 0,        // lifetime gems burned on repairs (a COUNT, so a number)
    skill: 1,
    // Both wei totals MUST start as bigint. They started as `0` and `0n` mixed
    // respectively, so the first purchase did `0 + 250000000000000n` and threw
    // "Cannot mix BigInt and other types" -- which surfaced as the buy button
    // silently doing nothing, because the throw happened after the afford
    // check but before the state was committed.
    feesPaid: 0n,     // lifetime treasury fees, in wei
    spent: 0n,        // lifetime ETH spent on tools, in wei
  };
}

/** The tool in hand, or null if none / broken. A broken tool cannot hunt. */
export function heldTool(p) {
  // A BROKEN tool is still owned, so this returns it rather than null. The
  // caller that matters is doHunt(), which must refuse a dig -- but that check
  // is `p.left === 0` there, not this function, because the belt still needs
  // to render a broken tool's name and durability.
  if (p.tier === 0) return null;
  return { tier: p.tier, name: TIER_NAME[p.tier], left: p.left, max: p.max };
}

/** Can this player start a dig? False with no tool AND false when broken. */
export function canHunt(p) {
  return p.tier > 0 && p.left > 0;
}

export const toolName = (tier) => TIER_NAME[tier] || 'None';

// --- buying and upgrading -------------------------------------------------

/** The tier this player is working toward: 1 if they hold nothing. */
export function nextTier(p) {
  return p.tier === 0 ? 1 : p.tier + 1;
}

/** `buy tool` for the first one, `upgrade tool` thereafter (SPEC section 4). */
export function buyOrUpgradeLabel(p) {
  return p.tier === 0 ? 'buy tool' : 'upgrade tool';
}

/**
 * Can this player buy/upgrade to `tier`?
 * Checks: in range, not the tier already held, and wallet balance.
 *
 * Sequential by construction -- you can only move one tier at a time, so there
 * is no "must own the tier below" check to forget.
 *
 * @param {object} p
 * @param {number} tier
 * @param {bigint} balance wallet ETH in wei
 */
export function canBuyTool(p, tier, balance = 0n) {
  if (tier == null || tier < 1 || tier > 5) {
    return { ok: false, reason: 'Tool tier out of range' };
  }
  if (tier <= p.tier) {
    return { ok: false, reason: `You already have ${toolName(p.tier)}` };
  }
  if (tier > p.tier + 1) {
    return { ok: false, reason: `${toolName(tier - 1)} first` };
  }
  const cost = toolPrice(tier);
  if (balance < cost) {
    return { ok: false, reason: `Need ${fmtEth(cost)}, have ${fmtEth(balance)}`, short: true };
  }
  return { ok: true, cost };
}

/**
 * Buy the first tool or upgrade to the next one, paying ETH.
 *
 * The old tool is REPLACED, not stowed: the new tool takes the slot and the
 * old one is gone. That is the spec (section 1) and it removes the whole
 * rotation/equip UI.
 *
 * @returns {{ok: boolean, reason?: string, fee?: bigint, replaced?: string}}
 */
export function buyTool(p, tier, balance = 0n) {
  const check = canBuyTool(p, tier, balance);
  if (!check.ok) return check;

  const cost = toolPrice(tier);
  const fee = treasuryFee(cost);
  const replaced = p.tier > 0 ? TIER_NAME[p.tier] : null;

  p.tier = tier;
  p.max = durabilityOf(tier);
  p.left = p.max;
  p.spent += cost;
  p.feesPaid += fee;

  return { ok: true, fee, cost, replaced, left: p.left, max: p.max };
}

// --- repair ----------------------------------------------------------------

/** The gem cost of a repair at this tier, as a sparse array per rarity. */
export function repairNeeds(p) {
  return repairCost(p.tier);
}

export function repairShortfall(p) {
  return repairCost(p.tier).map((n, r) => Math.max(0, n - p.gems[r]));
}

export function canRepair(p) {
  if (p.tier === 0) return { ok: false, reason: 'Buy a tool first' };
  if (p.left > 0) return { ok: false, reason: `${p.left}/${p.max} left -- not broken` };
  const short = repairShortfall(p);
  if (short.some((n) => n > 0)) {
    const missing = short.map((n, r) => (n ? `${n} ${RARITY_LABEL[r]}` : null)).filter(Boolean).join(', ');
    return { ok: false, reason: `Need ${missing}` };
  }
  return { ok: true };
}

const RARITY_LABEL = ['Q', 'A', 'S', 'R', 'D'];

/**
 * Repair with gems. Burns them outright -- no treasury claim, no ETH
 * liability (SPEC section 10).
 */
export function repairTool(p) {
  const check = canRepair(p);
  if (!check.ok) return check;
  const cost = repairCost(p.tier);
  cost.forEach((n, r) => { p.gems[r] -= n; p.burned += n; });
  p.left = p.max;
  return { ok: true };
}

// --- redemption ------------------------------------------------------------

/** Total face value of a player's gems, in wei. */
export function gemValueWei(p) {
  let v = 0n;
  p.gems.forEach((n, r) => { v += BigInt(n) * FACE_VALUE[r]; });
  return v;
}

/** What the player actually receives at the 90% payout. */
export function redeemValueWei(p) {
  let v = 0n;
  p.gems.forEach((n, r) => { v += payoutWei(n, r); });
  return v;
}

/**
 * Can the player redeem? The 0.005 ETH floor exists so a player cannot
 * dust-fence the contract one gem at a time (SPEC section 7).
 */
export function canRedeem(p) {
  const v = redeemValueWei(p);
  if (v <= 0n) return { ok: false, reason: 'No gems to sell' };
  if (v < REDEEM_FLOOR) {
    return { ok: false, reason: `Need ${fmtEth(REDEEM_FLOOR)}, have ${fmtEth(v)}`, short: true };
  }
  return { ok: true, value: v };
}

/** Sell all gems for ETH. Clears the balance and returns the payout. */
export function redeemGems(p) {
  const check = canRedeem(p);
  if (!check.ok) return check;
  p.gems = [0, 0, 0, 0, 0];
  return { ok: true, value: check.value };
}

// --- hunting ---------------------------------------------------------------

/** Credit a find: split the haul into spendable balance and lifetime totals. */
export function creditGems(p, counts) {
  counts.forEach((n, r) => { p.gems[r] += n; });
}

/** Spend one use. Returns {ok, broke} -- the caller charges durability only
 *  after a successful dig, so an abandoned dig costs nothing. */
export function consumeUse(p) {
  if (p.tier === 0) return { ok: false, reason: 'Buy Wood to hunt' };
  if (p.left === 0) return { ok: false, reason: `${toolName(p.tier)} is broken -- repair or upgrade` };
  p.left -= 1;
  return { ok: true, broke: p.left === 0 };
}

// --- formatting ------------------------------------------------------------

export function fmtGem(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export function fmtEth(wei, dp = 5) {
  const v = Number(wei) / 1e18;
  let s = v.toFixed(dp);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${s} ETH`;
}