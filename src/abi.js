/**
 * Contract ABI, generated from the compiled artifact.
 *
 *   node scripts/gen-abi.mjs          # regenerate
 *   node src/chain.test.mjs           # verify the client matches the contract
 *
 * Hand-transcribing contract constants is how the hunt costs ended up 10x
 * too cheap for a while: the client and the test agreed with each other
 * because both were my own transcription. So the ABI is generated from
 * out/DeepWood.sol/DeepWood.json, and chain.test.mjs asserts the client's
 * mirror against values read back OFF A RUNNING NODE. If the contract
 * changes, this fails instead of drifting quietly.
 */

/** Minimal ABI: every economy read the client needs, plus the season actions. */
export const ECONOMY_ABI = [
  // --- economy (owner-settable, read live) -----------------------------
  // These five were compile-time constants. They are now a struct the owner
  // can change, so the client must read them rather than assume any value.
  'function getConfig() view returns (uint256 burnFeeBps, uint64 seasonLength, uint64 huntCooldown, uint256 minSplay, uint64 graduationGrace, uint8 baseSlots, uint8 maxSlots)',
  'function BPS_DENOMINATOR() view returns (uint256)',
  // --- owner / token state ---------------------------------------------
  'function owner() view returns (address)',
  'function token() view returns (address)',
  'function tokenRailEnabled() view returns (bool)',
  'function paused() view returns (bool)',
  'function HUNTER_ROLE() view returns (address)',
  'function TREASURY() view returns (address)',
  'function tokenRedemptionActive() view returns (bool)',
  'function graduated() view returns (bool)',
  'function ethBacking() view returns (uint256)',
  'function outstandingLiability() view returns (uint256)',
  'function current() view returns (tuple(uint64 id, uint64 startsAt, uint64 endsAt, bool committed, bytes32 root, uint64 huntsSettled, uint256 totalGems))',

  // --- per-tier economy (uint8 in, uint256 out) ------------------------
  'function toolCost(uint8 tier) view returns (uint256)',
  'function durabilityOf(uint8 tier) view returns (uint256)',
  'function repairCost(uint8 tier) view returns (uint256)',
  'function huntCostWei(uint8 toolTier) view returns (uint256)',
  'function dropTable(uint8 toolTier) view returns (uint256[5])',
  'function priceOf(uint8 r) view returns (uint256)',
  'function rarityWeight(uint8 r) view returns (uint256)',

  // --- per-player state ------------------------------------------------
  'function roi(address player) view returns (uint256)',
  'function onRoiBoard(address player) view returns (bool)',
  'function toolCount(address player) view returns (uint256)',
  'function toolAt(address player, uint8 index) view returns (tuple(uint8 tier, uint8 durability, bool broken, uint8 skills))',
  'function playerStats(address player) view returns (tuple(uint256 hunts, uint256 gemsTotal, uint256 bestSingleFindWei, uint256 ethSpent, uint64 seasonId, uint8 bestToolTier))',
  'function gemsOf(address player, uint8 rarity) view returns (uint256)',

  // --- season actions --------------------------------------------------
  'function commitSeason(bytes32 root)',
  'function finalizeSeason()',
];

/** Events the client listens for. */
export const EVENTS_ABI = [
  'event SeasonStarted(uint64 indexed seasonId, uint64 startsAt, uint64 endsAt)',
  'event SeasonCommitted(uint64 indexed seasonId, bytes32 root)',
  'event SeasonFinalized(uint64 indexed seasonId)',
  'event ToolClaimed(address indexed player, uint8 tier, uint256 gemsPaid)',
  'event HuntSettled(address indexed player, uint256 totalGems, uint256 valueWei, uint256 huntCostWei)',
];

/** Errors worth decoding into a readable message. */
export const ERROR_NAMES = [
  'AlreadyCommitted', 'AlreadyGraduated', 'BadSignature', 'CooldownActive',
  'InsufficientGems', 'NotBroken', 'NotCommitted', 'NotHunter', 'NotOpen',
  'OnlyTreasury', 'RarityLocked', 'RarityNotForSale',
];
