/**
 * DeepWood economy -- the numbers from ECONOMY-SPEC.md, as pure data.
 *
 * This is the single place the economy lives on the client. The contract is
 * still to be redeployed against the same figures (SPEC section 12), so this
 * file is currently the only source of truth and MUST stay in parity with
 * DeepWood.sol once that lands.
 *
 * Every constant here is quoted from ECONOMY-SPEC.md with its section number.
 * If you change a number, change it in the spec too -- the spec is gitignored
 * and local, this file is not, so the spec is the one that will drift unless
 * it is updated deliberately.
 *
 * Units:
 *   - prices are wei (bigint). Never a float: 0.00005 ETH is 5e13 wei and a
 *     float loses it long before it loses the 0.00005.
 *   - gem counts are integers.
 *   - drop tables are per 10,000 hunts.
 */

// --- section 3: the rarity ladder ---------------------------------------

/** Gem name per rarity index. RARITY_NAME[0] is Quartz -- the shop used to
 *  call the same rarity "Common", which is how the card ended up showing two
 *  different numbers for one gem. One name now: SPEC section 13. */
export const RARITY_NAME = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

/** Short labels for the satchel tiles, where full names do not fit. */
export const RARITY_SHORT = ['Qtz', 'Amb', 'Sapph', 'Ruby', 'Diam'];

/**
 * Face value of one gem, in wei. Identical to the contract's priceOf() --
 * verified against src/DeepWood.sol and NOT to be changed.
 */
export const FACE_VALUE = [
  50_000_000_000_000n,        // Quartz   0.00005 ETH
  400_000_000_000_000n,       // Amber    0.0004  ETH
  3_000_000_000_000_000n,     // Sapphire 0.003   ETH
  25_000_000_000_000_000n,    // Ruby     0.025   ETH
  200_000_000_000_000_000n,   // Diamond  0.2     ETH
];

/** ROI weighting, 8x per tier. Scores a haul for the leaderboard. A Ruby is
 *  512 Quartz toward rank even though it is worth 500x in ETH. Distinct job
 *  from FACE_VALUE -- do not conflate them (SPEC section 3). */
export const RARITY_WEIGHT = [1n, 8n, 64n, 512n, 4096n];

// --- section 2: the tool tiers -------------------------------------------

export const MAX_TIER = 5;

/** Wood / Bronze / Iron / Steel / Gold. */
export const TIER_NAME = ['', 'Wood', 'Bronze', 'Iron', 'Steel', 'Gold'];

/** Drop table per tier, per 10,000 hunts. Index is rarity.
 *  Gold additionally requires Skill 4 -- see gatedDropTable(). */
export const DROP_TABLE = {
  1: [10000, 0, 0, 0, 0],
  2: [6000, 4000, 0, 0, 0],
  3: [4500, 3500, 2000, 0, 0],
  4: [3500, 3500, 2400, 600, 0],
  5: [3000, 3000, 2500, 1300, 200],
};

/** Gold without Skill 4: no Diamond at all (SPEC section 2). */
const GOLD_NO_SKILL4 = [3000, 3000, 3000, 1000, 0];

export function dropTable(tier, skill = 1) {
  if (tier === 5 && skill < 4) return GOLD_NO_SKILL4;
  return DROP_TABLE[tier];
}

// --- section 4: durability and tool prices -------------------------------

/** Durability rises 5 per tier: 20/25/30/35/40. More durability amortises
 *  the same repair over more hunts and brings the repair-or-upgrade decision
 *  forward, which is the point. */
export const DURABILITY = { 1: 20, 2: 25, 3: 30, 4: 35, 5: 40 };

export function durabilityOf(tier) {
  return DURABILITY[tier] ?? 0;
}

/** Tool price in wei. 5% goes to the treasury, 95% to the owner. */
export const TOOL_PRICE = {
  1: 5_000_000_000_000_000n,        // Wood   0.005 ETH
  2: 52_000_000_000_000_000n,       // Bronze 0.052
  3: 184_000_000_000_000_000n,      // Iron   0.184
  4: 862_000_000_000_000_000n,      // Steel  0.862
  5: 2_300_000_000_000_000_000n,    // Gold   2.300
};

export function toolPrice(tier) {
  return TOOL_PRICE[tier] ?? 0n;
}

export const TREASURY_BPS = 500;           // 5%
export const BPS_DENOMINATOR = 10_000n;

export function treasuryFee(wei) {
  return (wei * BigInt(TREASURY_BPS)) / BPS_DENOMINATOR;
}

// --- section 5: repair costs ---------------------------------------------

/**
 * Repair cost in gems, by rarity index. Array length varies per tier: Wood is
 * paid wholly in Quartz, Gold spans four rarities.
 *
 * Scaled against the rising durability so repair stays at ~40-50% of a cycle's
 * output. Holding these flat would have shortened payback by 8-33% and undone
 * the long-play goal (SPEC section 5).
 */
export const REPAIR_COST = {
  1: [9, 0, 0, 0, 0],
  2: [5, 4, 0, 0, 0],
  3: [6, 5, 3, 0, 0],
  4: [6, 5, 3, 0, 0],
  5: [12, 10, 8, 4, 0],
};

export function repairCost(tier) {
  return REPAIR_COST[tier] ?? [0, 0, 0, 0, 0];
}

/** Face value of a repair, in wei -- what the gems are worth at 100%. */
export function repairCostWei(tier) {
  let v = 0n;
  repairCost(tier).forEach((n, r) => { v += BigInt(n) * FACE_VALUE[r]; });
  return v;
}

// --- section 6: skill -----------------------------------------------------

export const SKILL_COST = { 2: [0, 0, 40, 0, 0], 3: [0, 0, 0, 15, 0], 4: [0, 0, 0, 0, 5] };

/** Rarity each skill level unlocks. Skill 2 -> Sapphire, 3 -> Ruby,
 *  4 -> Diamond. Skill 1 unlocks nothing: Quartz and Amber are the free
 *  baseline so a new player is never locked out of the first hunt. */
export const SKILL_UNLOCKS = { 1: 0, 2: 2, 3: 3, 4: 4 };

// --- section 7: redemption -----------------------------------------------

/** The player receives 90% of face value. The 10% is NOT the owner's margin --
 *  see section 9: revenue is abandoned tool sales. This exists so redemption
 *  is not exactly value-neutral against gem purchases. */
export const PAYOUT_BPS = 9000;
export const PAYOUT_DIV = 10_000n;

/** Minimum redeemable value in wei. Below this the button is disabled.
 *  Matches the contract's minSplay (0.005 ETH) on purpose -- keep the two
 *  numbers the same so there is one threshold to remember. */
export const REDEEM_FLOOR = 5_000_000_000_000_000n; // 0.005 ETH = 100 Quartz

export function payoutWei(gems, rarity) {
  return (BigInt(gems) * FACE_VALUE[rarity] * BigInt(PAYOUT_BPS)) / PAYOUT_DIV;
}

// --- derived: what the UI shows ------------------------------------------

/**
 * Expected face value of one hunt at a tier, in wei.
 *
 * `skill` DEFAULTS TO 4 on purpose. Every figure quoted in ECONOMY-SPEC.md
 * section 8 is the "at full unlock" number, because Gold is quoted with its 2%
 * Diamond rate. Defaulting to skill 1 silently priced Gold without Diamond and
 * made its payback read 7986 hunts instead of 519 -- a 15x error in the one
 * number the whole ladder is calibrated around. Pass an explicit lower skill
 * only when you are deliberately asking the un-unlocked question.
 */
export function huntValueWei(tier, skill = 4) {
  const t = dropTable(tier, skill);
  let per10k = 0n;
  for (let r = 0; r < 5; r++) per10k += BigInt(t[r]) * FACE_VALUE[r];
  return per10k / 10_000n;
}

/** Net of face value per hunt after amortised repair, in wei. This is the
 *  number the payback table in SPEC section 8 is built from. */
export function netHuntWei(tier, skill = 4) {
  const d = BigInt(durabilityOf(tier) || 1);
  const repairPerHunt = repairCostWei(tier) / d;
  return huntValueWei(tier, skill) - repairPerHunt;
}

/**
 * Hunts needed to earn back a tool price at this tier.
 *
 * netHuntWei() is FACE value minus repair. The player only receives 90% of face
 * on redemption, so the effective take is net * PAYOUT_BPS/10,000. Dividing the
 * price by the un-multiplied net overstated payback by 10,000x.
 *
 * Display only -- see SPEC section 8 for why this is NOT a profit number.
 */
export function paybackHunts(tier, skill = 4) {
  const net = netHuntWei(tier, skill);
  if (net <= 0n) return Infinity;
  const payout = (net * BigInt(PAYOUT_BPS)) / PAYOUT_DIV;
  if (payout <= 0n) return Infinity;
  return Math.round(Number(toolPrice(tier)) / Number(payout));
}

/** Repair cycles before the repair-or-upgrade decision. */
export function cyclesToPayback(tier, skill = 4) {
  const d = durabilityOf(tier);
  return d ? paybackHunts(tier, skill) / d : 0;
}

// --- formatting -----------------------------------------------------------

export const fmtGem = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
};

/** wei -> a compact ETH string. trims trailing zeros so the belt reads
 *  "0.005 ETH" and "2.3 ETH", not "0.00500 ETH". */
export function fmtEth(wei, dp = 5) {
  const v = Number(wei) / 1e18;
  let s = v.toFixed(dp);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${s} ETH`;
}

/** "12Q + 4A" style repair summary, short enough for a belt chip. */
export function fmtRepair(tier, short = true) {
  const cost = repairCost(tier);
  const names = short ? RARITY_SHORT : RARITY_NAME;
  return cost
    .map((n, r) => (n ? `${n}${names[r]}` : null))
    .filter(Boolean)
    .join(' + ') || 'free';
}