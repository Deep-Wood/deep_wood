/**
 * Tool progression -- client mirror of DeepWood.sol.
 *
 * Every number here is copied from the contract on purpose. The contract is
 * the source of truth; this file exists so the preview can show the same
 * costs, the same durability, and the same drop tables the chain will
 * enforce. A parity test in the contract repo asserts these stay in sync.
 *
 * Units: costs are in Common (quartz) gems, matching the contract's _burn(),
 * which spends p.gems[Rarity.Common]. Gem value is in wei.
 */

// --- from DeepWood.sol -------------------------------------------------
export const BURN_FEE_BPS = 500; // 5% of every burn goes to treasury

// HUNT_COOLDOWN is a DEPLOY DEFAULT, not a fact. The owner can change it, so
// the client must read the live value from getConfig() and treat this as the
// value to fall back to before the first read completes.
export const HUNT_COOLDOWN = 3;
export const BPS_DENOMINATOR = 10_000;

export const MAX_TIER = 4;

export function toolCost(tier) {
  if (tier <= 1) return 0; // free first tool
  if (tier === 2) return 1_000;
  if (tier === 3) return 8_000;
  return 60_000; // tier 4
}

export function durabilityOf(tier) {
  if (tier <= 1) return 20;
  return 20 + tier * 15;
}

export function repairCost(tier) {
  if (tier <= 1) return 50;
  if (tier === 2) return 500;
  if (tier === 3) return 5_000;
  return 40_000;
}

// 0.0001 ether is 1e14 wei, NOT 1e13. An earlier version had all four tiers
// 10x too cheap, and the parity test asserted the same wrong constants, so
// it passed -- a test that only compares my code against my own
// transcription cannot catch a transcription error. See tools.test.mjs,
// which now derives these from the ETH decimal rather than restating them.
export function huntCostWei(tier) {
  if (tier <= 1) return 100_000_000_000_000n; // 0.0001 ETH
  if (tier === 2) return 200_000_000_000_000n; // 0.0002
  if (tier === 3) return 400_000_000_000_000n; // 0.0004
  return 800_000_000_000_000n;                 // 0.0008
}

// --- local state --------------------------------------------------------

/**
 * @typedef {object} Tool
 * @property {number} tier    1..4
 * @property {number} left    remaining hunts before it breaks
 * @property {number} max     durability when fully repaired
 * @property {boolean} active is this the tool currently in hand
 */

/**
 * Create a fresh toolbelt: one free Tier I, as the contract grants.
 */
export function newToolbelt() {
  return {
    tools: [{ tier: 1, left: durabilityOf(1), max: durabilityOf(1), active: true }],
    common: 0, // spendable Common gems
    burned: 0, // lifetime Common gems burned
    feesPaid: 0, // lifetime treasury fees
  };
}

/** The tool in hand, or null if none. Broken tools are still owned. */
export function activeTool(belt) {
  const t = belt.tools.find((x) => x.active);
  if (!t || t.left === 0) return null; // a broken tool cannot hunt
  return t;
}

/** True if a tool of this tier is already owned (the contract rejects it). */
export function ownsTier(belt, tier) {
  return belt.tools.some((t) => t.tier === tier);
}

/**
 * Can this tier be claimed? Mirrors the contract's three rejections:
 * out of range, already owned, and not sequential.
 * @returns {{ok: boolean, reason?: string}}
 */
export function canClaim(belt, tier) {
  if (tier == null || tier < 1 || tier > MAX_TIER) {
    return { ok: false, reason: 'Tool tier out of range' };
  }
  if (ownsTier(belt, tier)) {
    return { ok: false, reason: `You already own a Tier ${roman(tier)} tool` };
  }
  if (tier > 1 && !ownsTier(belt, tier - 1)) {
    return { ok: false, reason: `Claim Tier ${roman(tier - 1)} first` };
  }
  const cost = toolCost(tier);
  if (belt.common < cost) {
    return { ok: false, reason: `Need ${fmt(cost)} Common, you have ${fmt(belt.common)}` };
  }
  return { ok: true };
}

/**
 * Claim the next tool tier. Burns Common gems like the contract does.
 * @returns {{ok: boolean, reason?: string, fee?: bigint}}
 */
export function claimTool(belt, tier) {
  const check = canClaim(belt, tier);
  if (!check.ok) return check;

  const cost = toolCost(tier);
  const fee = burn(belt, cost);
  const tool = { tier, left: durabilityOf(tier), max: durabilityOf(tier), active: true };

  // Only one tool can be in hand. Demote the outgoing one, but keep it --
  // this is what makes rotation matter (SPEC section 5).
  for (const t of belt.tools) t.active = false;
  belt.tools.push(tool);
  return { ok: true, fee };
}

/**
 * Repair a broken tool. The contract requires durability == 0; a tool with
 * uses left cannot be repaired, so the preview must refuse it too.
 */
export function canRepair(belt, index) {
  const t = belt.tools[index];
  if (!t) return { ok: false, reason: 'No such tool' };
  if (t.left > 0) return { ok: false, reason: `Not broken (${t.left}/${t.max} left)` };
  const cost = repairCost(t.tier);
  if (belt.common < cost) {
    return { ok: false, reason: `Need ${fmt(cost)} Common, you have ${fmt(belt.common)}` };
  }
  return { ok: true };
}

export function repairTool(belt, index) {
  const check = canRepair(belt, index);
  if (!check.ok) return check;
  const t = belt.tools[index];
  const cost = repairCost(t.tier);
  const fee = burn(belt, cost);
  t.left = t.max;
  t.active = true;
  for (const x of belt.tools) if (x !== t) x.active = false;
  return { ok: true, fee };
}

/** Switch which owned tool is in hand. A broken tool cannot be equipped. */
export function equip(belt, index) {
  const t = belt.tools[index];
  if (!t) return { ok: false, reason: 'No such tool' };
  if (t.left === 0) return { ok: false, reason: 'Repair it before using it' };
  for (const x of belt.tools) x.active = false;
  t.active = true;
  return { ok: true };
}

/** Spend one use. Breaks the tool at zero. */
export function consumeUse(belt) {
  const t = activeTool(belt);
  if (!t) return { ok: false, reason: 'No working tool' };
  t.left -= 1;
  return { ok: true, broke: t.left === 0, tool: t };
}

function burn(belt, gems) {
  belt.common -= gems;
  belt.burned += gems;
  // Math.floor, not `/`: Solidity divides uint256 and truncates. A 50-gem
  // repair bills 2.5 in JS and 2 onchain, and that half-gem is precisely the
  // drift this module exists to prevent.
  const fee = Math.floor((gems * BURN_FEE_BPS) / BPS_DENOMINATOR);
  belt.feesPaid += fee;
  return fee;
}

// --- formatting ---------------------------------------------------------

export const ROMAN = ['', 'I', 'II', 'III', 'IV'];
export const roman = (t) => ROMAN[t] || String(t);

/** 1234567 -> "1.23M" */
export function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export const eth = (wei) => `${(Number(wei) / 1e18).toFixed(5)} ETH`;

/**
 * Expected gem value of one hunt at a tier, in wei.
 * Derived from the drop table and the face value of each gem, so the UI can
 * show whether an upgrade actually pays for itself.
 */
export function expectedHuntWei(dropTable, price) {
  let perTenThousand = 0n;
  for (let r = 0; r < 5; r++) perTenThousand += BigInt(dropTable[r]) * price[r];
  // each hunt drops 3..5 gems, mean 4
  return (perTenThousand * 4n) / 10_000n;
}
