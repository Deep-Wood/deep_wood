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
 * V6 UPDATE: All prices are now in DEEPWOOD (18 decimals), not ETH wei.
 * The contract's priceOf(), toolCost(), quartzPrice(), etc. return DEEPWOOD
 * amounts. Use readLivePrices() to fetch current prices from the chain.
 *
 * Units:
 *   - prices are DEEPWOOD (18 decimals, bigint). V6 moved from ETH wei to DEEPWOOD.
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
 * Face value of one gem, in DEEPWOOD (18 decimals). V6: prices moved from
 * ETH wei to DEEPWOOD. These are the DEFAULT/FALLBACK values -- the live
 * contract values should be read via readLivePrices().
 *
 * V6 uses dedicated price functions: quartzPrice(), amberPrice(), sapphirePrice(),
 * emeraldPrice(), diamondPrice() instead of the old priceOf(uint8).
 */
export const FACE_VALUE = [
  400_000_000_000_000_000_000n,        // Quartz   400 DEEPWOOD
  7_800_000_000_000_000_000_000n,      // Amber    7,800 DEEPWOOD
  86_000_000_000_000_000_000_000n,     // Sapphire 86,000 DEEPWOOD
  1_000_000_000_000_000_000_000_000n,  // Ruby     1,000,000 DEEPWOOD (emeraldPrice)
  4_000_000_000_000_000_000_000_000n,  // Diamond  4,000,000 DEEPWOOD
];

/** ROI weighting, 8x per tier. Scores a haul for the leaderboard. A Ruby is
 *  512 Quartz toward rank even though it is worth 500x in ETH. Distinct job
 *  from FACE_VALUE -- do not conflate them (SPEC section 3). */
export const RARITY_WEIGHT = [1n, 8n, 64n, 512n, 4096n];

// --- section 2: the tool tiers -------------------------------------------

export const MAX_TIER = 5;

/** Wood / Bronze / Iron / Steel / Gold. V6: Wood / Bronze / Silver / Gold / Mithril. */
export const TIER_NAME = ['', 'Wood', 'Bronze', 'Silver', 'Gold', 'Mithril'];

/** Drop table per tier, per 10,000 hunts. Index is rarity. This is the
 *  tier's CEILING -- skill can only lower it. See dropTable(). */
export const DROP_TABLE = {
  1: [10000, 0, 0, 0, 0],
  2: [6000, 4000, 0, 0, 0],
  3: [4500, 3500, 2000, 0, 0],
  4: [3500, 3500, 2400, 600, 0],
  5: [3000, 3000, 2500, 1300, 200],
};

/**
 * The rarest rarity a (tier, skill) context can actually roll -- the find
 * flash celebrates THIS, not "anything ≥ Sapphire" (user, 2026-10-21).
 * Per-tier tops with the live tables: Wood none, Bronze Amber, Silver
 * Sapphire, Gold Ruby, Mithril Diamond; the skill fold (a rarity rolls
 * only when its index sits under the trained skill) caps further, so the
 * celebrated gem RISES with the player instead of firing on every lucky
 * find that used to clear a lower bar. -1 when nothing above Quartz is
 * rollable. Uses the same DROP_TABLE the roll math uses, so the flash can
 * never celebrate a gem the context cannot produce.
 */
export function rarestRollable(tier, skill = 0) {
  const table = DROP_TABLE[tier] ?? DROP_TABLE[1];
  const ceil = Math.min(Number(skill) || 0, 5) - 1;
  for (let r = Math.min(ceil, 4); r >= 1; r--) {
    if (Number(table[r] ?? 0) > 0) return r;
  }
  return -1;
}

/**
 * The find flash starts at SAPPHIRE (user, 2026-10-21, amending the same
 * day's ceiling rule): Amber is a common find and not a moment. The flash
 * fires for the context's ceiling gem ONLY when that ceiling is Sapphire
 * or above -- so Bronze (ceiling Amber) never flashes, Silver flashes
 * Sapphires, Gold Rubies, Mithril Diamonds.
 */
export const FLASH_FLOOR_RARITY = 2;

/**
 * dropTable(tier, skill) mirrored in JS: a tier's own table with every rarity
 * above the unlocked ceiling folded DOWN into Quartz.
 *
 * Mirrors DeepWoodV4.dropTable. Locked weight is REDIRECTED, not dropped, so
 * the row always sums to 10,000 and an unskilled hunter is 100% Quartz at
 * every tier -- they always earn something and can always dig out.
 *
 * Skills are 1..5 (Greenhorn..Lapidary); skill 0 = None (tool-less).
 * Skill S opens rarity S-1: Greenhorn(1) mines pure Quartz, Prospector(2)
 * adds Amber, Delver(3) Sapphire, Assayer(4) Ruby. Locked bands fold
 * back into Quartz so the table always sums to 10,000.
 */
export function dropTable(tier, skill = 0) {
  const t = (DROP_TABLE[tier] ?? DROP_TABLE[1]).slice();
  for (let r = 1; r <= 4; r++) {
    if (skill === 0 || r >= skill) { t[0] += t[r]; t[r] = 0; }
  }
  return t;
}

// --- section 4: durability and tool prices -------------------------------

/** Durability rises 5 per tier: 20/25/30/35/40. More durability amortises
 *  the same repair over more hunts and brings the repair-or-upgrade decision
 *  forward, which is the point. */
export const DURABILITY = { 1: 20, 2: 25, 3: 30, 4: 35, 5: 40 };

export function durabilityOf(tier) {
  return DURABILITY[tier] ?? 0;
}

/**
 * Tool price in DEEPWOOD (18 decimals). V6: prices moved from ETH wei to
 * DEEPWOOD. 5% goes to the treasury, 95% to the owner.
 *
 * V6 uses dedicated cost functions: woodCost(), bronzeCost(), silverCost(),
 * goldCost(), mithrilCost() instead of the old toolCost(uint8).
 */
/**
 * Live tool prices read from the contract. Populated by readLivePrices().
 * Falls back to 0n until the first read completes — never guess.
 */
export const TOOL_PRICE = {
  1: 0n, 2: 0n, 3: 0n, 4: 0n, 5: 0n,
};

export function toolPrice(tier) {
  return TOOL_PRICE[tier] ?? 0n;
}

// V7: live owner-tunable tables, populated by readLivePrices()
export let LIVE_DURABILITY_TABLE = [20n, 25n, 30n, 35n, 40n];
export let LIVE_REPAIR_COST_TABLE = [
  [5n, 0n, 0n, 0n, 0n],
  [3n, 2n, 0n, 0n, 0n],
  [3n, 3n, 1n, 0n, 0n],
  [3n, 3n, 2n, 0n, 0n],
  [5n, 5n, 4n, 2n, 0n],
];
export let LIVE_DROP_TABLE_TIERS = [
  [10000n, 0n, 0n, 0n, 0n],
  [6000n, 4000n, 0n, 0n, 0n],
  [4500n, 3500n, 2000n, 0n, 0n],
  [3500n, 3500n, 2400n, 600n, 0n],
  [3000n, 3000n, 2500n, 1300n, 200n],
];
export let LIVE_SKILL_COST_TABLE = [0n, 20n, 40n, 60n, 80n];
export let LIVE_RARITY_WEIGHT_TABLE = [1n, 8n, 64n, 512n, 4096n];
export let LIVE_MAX_BATCH = 20n;

export function setDurabilityTable(table) {
  LIVE_DURABILITY_TABLE = table;
}
export function setRepairCostTable(table) {
  LIVE_REPAIR_COST_TABLE = table;
}
export function setDropTableTiers(table) {
  LIVE_DROP_TABLE_TIERS = table;
}
export function setSkillCostTable(table) {
  LIVE_SKILL_COST_TABLE = table;
}
export function setRarityWeightTable(table) {
  LIVE_RARITY_WEIGHT_TABLE = table;
}
export function setMaxBatch(val) {
  LIVE_MAX_BATCH = val;
}

export function setToolPrices(prices) {
  for (let i = 0; i < 5; i++) TOOL_PRICE[i + 1] = prices[i] ?? 0n;
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
  1: [5, 0, 0, 0, 0],
  2: [3, 2, 0, 0, 0],
  3: [3, 3, 1, 0, 0],
  4: [3, 3, 2, 0, 0],
  5: [5, 5, 4, 2, 0],
};

export function repairCost(tier) {
  // Prefer the LIVE owner-settable table -- readLivePrices() populates it from
  // the contract at boot, so a retuned chain shows up without a client deploy.
  // The static REPAIR_COST above is only the pre-read fallback, and it is the
  // CONTRACT'S SHIPPED DEFAULTS, not a design document. Until 2026-10-19 this
  // function returned the old V4/V5 design ladder (9 / 5+4 / 6+5+3 / ...),
  // so the repair dialog displayed costs the chain never charged: a Bronze
  // repair showed "5 Quartz + 4 Amber" while the contract deducted 3Q + 2A
  // (ToolRepaired event, total gemsBurned = 5, on-chain deltas verified).
  const live = LIVE_REPAIR_COST_TABLE[tier - 1];
  if (live) return live.map(Number);
  return REPAIR_COST[tier] ?? [0, 0, 0, 0, 0];
}

/** Face value of a repair, in DEEPWOOD (18 decimals) -- what the gems are worth at 100%. */
export function repairCostWei(tier) {
  let v = 0n;
  repairCost(tier).forEach((n, r) => { v += BigInt(n) * FACE_VALUE[r]; });
  return v;
}

// --- section 6: skill -----------------------------------------------------

/**
 * Quartz burned to reach each skill level. `cost = 200 * targetSkill` in
 * DeepWoodV4.upgradeSkill -- the contract charges COMMON (Quartz) only, one
 * level at a time, and a level is only purchasable up to the tier you hold.
 *
 * Keep this in lockstep with the contract's `skillCost()`. It was 500/level,
 * which at the honest phase rates is ~4,400 hunts to full unlock; a skill
 * level DILUTES quartz (it opens a rarer gem, taking weight off the quartz
 * band), so the last levels were the slowest. 200/level puts full unlock at
 * ~1,760 hunts with break-even around skill 3.
 *
 * Read the live value from `chain.skillCost(level)` when you can -- this table
 * exists so the UI can render a price before any RPC round trip.
 */
export const SKILL_COST_QUARTZ = { 1: 0, 2: 20, 3: 40, 4: 60, 5: 80 };

/** Total Quartz to reach each level from Greenhorn (cumulative). */
export const SKILL_TOTAL_QUARTZ = { 1: 0, 2: 20, 3: 60, 4: 120, 5: 200 };

/** Quartz burned to go from `cur` to the next level, or null when maxed. */
export function skillUpCostQuartz(cur) {
  const next = cur + 1;
  return SKILL_COST_QUARTZ[next] ?? null;
}

/**
 * The rarity each skill level unlocks. Skill S opens rarity S-1:
 * Greenhorn(1)=Quartz, Prospector(2)=Amber, Delver(3)=Sapphire,
 * Assayer(4)=Ruby. Lapidary(5) is the cap -- no new rarity.
 *
 * A level is INERT until the tool catches up. Prospector unlocks Amber, but
 * a Wood tool's table is 100% Quartz, so a Wood hunter who buys Prospector
 * sees no change until they upgrade to Bronze. The skill is the PERMISSION
 * to mine the next rarity; the tool is the ABILITY.
 */
export const SKILL_UNLOCKS = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 };

/**
 * The craft title for each skill level: 0 None, 1 Greenhorn, 2 Prospector,
 * 3 Delver, 4 Assayer, 5 Lapidary.
 *
 * A title beats "skill 3" on the button because it tells the player who they
 * ARE, not just a number. Paired with SKILL_UNLOCKS it also answers the only
 * question that matters in the moment: what can I find now?
 */
export const SKILL_NAME = ['None', 'Greenhorn', 'Prospector', 'Delver', 'Assayer', 'Lapidary'];

/** Uppercase form for the button label and HUD chips. */
export const SKILL_NAME_UC = SKILL_NAME.map((n) => n.toUpperCase());

/**
 * The one-line subtitle for a skill level -- what that level unlocked, in the
 * player's language. Skill 0 = None (no tool yet).
 */
export function skillSubtitle(level) {
  const lv = Math.max(0, Math.min(5, Number(level) || 0));
  if (lv === 0) return 'No tool yet';
  if (lv === 1) return 'Quartz only';
  const gem = RARITY_NAME[SKILL_UNLOCKS[lv]] || '';
  return lv >= 4 ? `${gem} + extra slot` : `${gem} unlocked`;
}

/** Craft title for a level, falling back to None for bad input. */
export function skillName(level) {
  const lv = Math.max(0, Math.min(5, Number(level) || 0));
  return SKILL_NAME[lv];
}

/**
 * The highest skill level a player may buy, given the tool they hold.
 * The skill may lead the tool by ONE rung: holding Wood(1) you may buy
 * Prospector(2), which is what unlocks Bronze. Without the +1 the ladder
 * deadlocks. buyTool requires skillOf >= tier, so the climb is
 * skill t -> tool t -> skill t+1 -> tool t+1 ...
 */
export function maxBuyableSkill(toolTier) {
  if (!toolTier || toolTier < 1) return 0;
  return Math.min(5, toolTier + 1);
}

/**
 * The lowest skill level a player may hold at a given tool tier -- the
 * interlock floor. buyTool requires skillOf >= tier, so holding tier T means
 * at least skill T. Below this the player cannot climb.
 */
export function minSkillForTier(toolTier) {
  if (!toolTier || toolTier < 1) return 0;
  return Math.min(5, toolTier);
}

// --- section 7: redemption -----------------------------------------------

/** The player receives 90% of face value. The 10% is NOT the owner's margin --
 *  see section 9: revenue is abandoned tool sales. This exists so redemption
 *  is not exactly value-neutral against gem purchases. */
export const PAYOUT_BPS = 9000;
export const PAYOUT_DIV = 10_000n;

/** Minimum redeemable value in DEEPWOOD (18 decimals). Below this the button
 *  is disabled. V6: moved from ETH wei to DEEPWOOD. */
export const REDEEM_FLOOR = 20_000_000_000_000_000_000_000n; // 20,000 DEEPWOOD = 50 Quartz

export function payoutWei(gems, rarity) {
  return (BigInt(gems) * FACE_VALUE[rarity] * BigInt(PAYOUT_BPS)) / PAYOUT_DIV;
}

// --- V6: Live price reads from the contract ------------------------------

/**
 * Read live prices from the V6 contract. All prices are in DEEPWOOD (18 decimals).
 *
 * V6 uses direct contract reads for all prices:
 *   - Gem prices: quartzPrice(), amberPrice(), sapphirePrice(), emeraldPrice(), diamondPrice()
 *   - Tool prices: woodCost(), bronzeCost(), silverCost(), goldCost(), mithrilCost()
 *
 * @param {object} chain the connected chain handle from chain.js
 * @returns {Promise<{gemPrices: bigint[], toolPrices: bigint[]}>}
 */
export async function readLivePrices(chain) {
  // The Robinhood testnet RPC rate-limits aggressively (HTTP 429). Firing 10
  // parallel calls guaranteed a rejection, which crashed bootChain and dropped
  // the whole session into offline mode. Retry each call individually with
  // backoff, and fall back to zeros if the chain is unreachable.
  const safe = async (fn, fallback) => {
    for (let i = 0; i < 3; i++) {
      try { return await fn(); } catch (e) {
        if (i < 2) await new Promise(r => setTimeout(r, 300 * (i + 1)));
      }
    }
    return fallback;
  };

  const [quartzPrice, amberPrice, sapphirePrice, emeraldPrice, diamondPrice] = await Promise.all([
    safe(() => chain.quartzPrice(), 0n),
    safe(() => chain.amberPrice(), 0n),
    safe(() => chain.sapphirePrice(), 0n),
    safe(() => chain.emeraldPrice(), 0n),
    safe(() => chain.diamondPrice(), 0n),
  ]);
  const [woodCost, bronzeCost, silverCost, goldCost, mithrilCost] = await Promise.all([
    safe(() => chain.woodCost(), 0n),
    safe(() => chain.bronzeCost(), 0n),
    safe(() => chain.silverCost(), 0n),
    safe(() => chain.goldCost(), 0n),
    safe(() => chain.mithrilCost(), 0n),
  ]);
  const toolPrices = [woodCost, bronzeCost, silverCost, goldCost, mithrilCost];
  setToolPrices(toolPrices);

  // V7: owner-tunable gameplay tables — read live from chain storage vars
  const [durability0, durability1, durability2, durability3, durability4] = await Promise.all([
    safe(() => chain.durabilityOf(1), 20n),
    safe(() => chain.durabilityOf(2), 25n),
    safe(() => chain.durabilityOf(3), 30n),
    safe(() => chain.durabilityOf(4), 35n),
    safe(() => chain.durabilityOf(5), 40n),
  ]);
  setDurabilityTable([durability0, durability1, durability2, durability3, durability4]);

  const [repairWood, repairBronze, repairIron, repairSteel, repairMithril] = await Promise.all([
    safe(() => chain.repairNeeds(1), [5n, 0n, 0n, 0n, 0n]),
    safe(() => chain.repairNeeds(2), [3n, 2n, 0n, 0n, 0n]),
    safe(() => chain.repairNeeds(3), [3n, 3n, 1n, 0n, 0n]),
    safe(() => chain.repairNeeds(4), [3n, 3n, 2n, 0n, 0n]),
    safe(() => chain.repairNeeds(5), [5n, 5n, 4n, 2n, 0n]),
  ]);
  setRepairCostTable([repairWood, repairBronze, repairIron, repairSteel, repairMithril]);

  const [drop1, drop2, drop3, drop4, drop5] = await Promise.all([
    safe(() => chain.dropTable(1, 0), [10000n, 0n, 0n, 0n, 0n]),
    safe(() => chain.dropTable(2, 0), [6000n, 4000n, 0n, 0n, 0n]),
    safe(() => chain.dropTable(3, 0), [4500n, 3500n, 2000n, 0n, 0n]),
    safe(() => chain.dropTable(4, 0), [3500n, 3500n, 2400n, 600n, 0n]),
    safe(() => chain.dropTable(5, 0), [3000n, 3000n, 2500n, 1300n, 200n]),
  ]);
  setDropTableTiers([drop1, drop2, drop3, drop4, drop5]);

  const [skill1, skill2, skill3, skill4, skill5] = await Promise.all([
    safe(() => chain.skillCost(1), 0n),
    safe(() => chain.skillCost(2), 20n),
    safe(() => chain.skillCost(3), 40n),
    safe(() => chain.skillCost(4), 60n),
    safe(() => chain.skillCost(5), 80n),
  ]);
  setSkillCostTable([skill1, skill2, skill3, skill4, skill5]);

  const [w0, w1, w2, w3, w4] = await Promise.all([
    safe(() => chain.rarityWeight(0), 1n),
    safe(() => chain.rarityWeight(1), 8n),
    safe(() => chain.rarityWeight(2), 64n),
    safe(() => chain.rarityWeight(3), 512n),
    safe(() => chain.rarityWeight(4), 4096n),
  ]);
  setRarityWeightTable([w0, w1, w2, w3, w4]);

  const maxBatch = await safe(() => chain.maxBatch(), 20n);
  setMaxBatch(maxBatch);

  return {
    gemPrices: [quartzPrice, amberPrice, sapphirePrice, emeraldPrice, diamondPrice],
    toolPrices,
    durabilityTable: [durability0, durability1, durability2, durability3, durability4],
    repairCostTable: [repairWood, repairBronze, repairIron, repairSteel, repairMithril],
    dropTableTiers: [drop1, drop2, drop3, drop4, drop5],
    skillCostTable: [skill1, skill2, skill3, skill4, skill5],
    rarityWeightTable: [w0, w1, w2, w3, w4],
    maxBatch,
  };
}

// --- derived: what the UI shows ------------------------------------------

/**
 * Expected face value of one hunt at a tier, in DEEPWOOD (18 decimals).
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

/** Net of face value per hunt after amortised repair, in DEEPWOOD (18 decimals).
 *  This is the number the payback table in SPEC section 8 is built from. */
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

/**
 * DEEPWOOD (18 decimals) -> a compact token string. V6: was ETH, now DEEPWOOD.
 * Trims trailing zeros so the belt reads "0.005 DEEPWOOD" and "2.3 DEEPWOOD".
 */
export function fmtEth(wei, dp = 5) {
  const v = Number(wei) / 1e18;
  let s = v.toFixed(dp);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${s} DEEPWOOD`;
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
// --- hunter card avatars ---------------------------------------------------
// Inline SVG so there are no image requests to go missing. Each tool tier is
// a pickaxe whose head takes that tier's metal; each skill rank is a gem
// cut to that rank's shape. `current` is lit by CSS, so the glyph itself is
// always the same -- only the frame changes.

/**
 * The pickaxe, optionally wearing an earned skin. The tier's head metal is
 * EARNED progress and never changes -- a skin only recolors the haft and
 * ties a wrap band near the grip, so it reads as an accent, never a disguise.
 * `skin` is `{ id, haft, wrap }` or null for the base wood.
 */
function pickaxeSvg(tier, skin) {
  const metal = ['#8a6b4a', '#c98f4e', '#9aa5b1', '#6d8fa8', '#e8c25a'][tier - 1] || '#8a6b4a';
  const dark = metal === '#e8c25a' ? '#a87c22' : '#00000055';
  const haft = skin?.haft ?? '#6b4f2f';
  const id = `tg${tier}${skin ? 'k' + skin.id : ''}`;
  // Wrap band: a short strip crossing the lower haft, only in a skin.
  const wrap = skin?.wrap
    ? `<path d="M6.4 9.9 L8.1 9.5 L9.1 12.7 L7.4 13.2 Z" fill="${skin.wrap}" stroke="#000" stroke-width=".25"/>`
    : '';
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${metal}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs>`
    + `<path d="M2 4 Q8 0 14 4 L13 6 Q8 3 3 6 Z" fill="url(#${id})" stroke="#000" stroke-width=".4"/>`
    + `<path d="M6 5 L9 14 L7.5 14.8 L5 6 Z" fill="${haft}" stroke="#000" stroke-width=".35"/>`
    + wrap
    + `</svg>`;
}

/** A pickaxe head in the tier's metal. 16x16 viewBox. */
function toolAvatar(tier) {
  return pickaxeSvg(tier, null);
}

/** The pickaxe in an earned skin (`{ id, haft, wrap }`), or the base wood. */
export function toolAvatarSkinned(tier, skin) {
  return pickaxeSvg(tier, skin ?? null);
}

/** A gem cut to the skill rank's facet count. 16x16 viewBox. */
function skillAvatar(rank) {
  // More facets as the rank climbs: a rough pebble up to a brilliant cut.
  const gem = ['#9fbc9f', '#7fd4a0', '#4fb8d8', '#e05a9b', '#fbbf24'][rank] || '#9fbc9f';
  const light = rank >= 3 ? '#ffffff66' : '#ffffff33';
  const id = `sg${rank}`;
  const sides = [0, 4, 5, 6, 8][rank] || 4;
  const cx = 8, cy = 8, r = 5.5;
  let pts = '';
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
    pts += `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)} `;
  }
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light}"/><stop offset=".55" stop-color="${gem}"/><stop offset="1" stop-color="#00000088"/></linearGradient></defs>`
    + `<polygon points="${pts.trim()}" fill="url(#${id})" stroke="#000" stroke-width=".5"/>`
    + `</svg>`;
}

/** The five tool avatars, index 1..5 (0 is the "no tool" state). */
export const TOOL_AVATARS = ['', toolAvatar(1), toolAvatar(2), toolAvatar(3), toolAvatar(4), toolAvatar(5)];

/** The five skill avatars, index 0..4. */
export const SKILL_AVATARS = [skillAvatar(0), skillAvatar(1), skillAvatar(2), skillAvatar(3), skillAvatar(4), skillAvatar(5)];
