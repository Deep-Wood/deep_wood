/**
 * Contract ABI for DeepWoodV2 -- GENERATED, not hand-written.
 *
 *   node scripts/gen-abi.mjs
 *
 * Do not edit by hand. The previous hand-written ABI still carried the V1
 * shape -- `toolCount`, `toolAt`, `repairCost`, `huntCostWei` per-hunt
 * charges, `claimTool` -- none of which exist in V2. A hand-written ABI
 * against a changed contract does not fail loudly; it fails as a mysterious
 * revert at the call site. Generating from the artifact makes that class of
 * drift impossible.
 *
 * Regenerating changes only these lists. Anything the app calls that is
 * missing here is a real integration gap, and `src/live.test.mjs` asserts
 * every name the client uses is present.
 */

/** Everything the client reads. Mixed view and pure -- both are safe to call. */
export const ECONOMY_ABI = [
  'function BPS_DENOMINATOR() view returns (uint256)',
  'function HARD_MAX_SLOTS() view returns (uint8)',
  'function HUNTER_ROLE() view returns (address)',
  'function MAX_BURN_FEE_BPS() view returns (uint256)',
  'function MAX_GRADUATION_GRACE() view returns (uint64)',
  'function MAX_HUNT_COOLDOWN() view returns (uint64)',
  'function MAX_SEASON_LENGTH() view returns (uint64)',
  'function MAX_TIER() view returns (uint8)',
  'function PRICE_SCALE() view returns (uint256)',
  'function TREASURY() view returns (address)',
  'function config() view returns (uint256,uint64,uint64,uint256,uint64,uint8,uint8)',
  'function current() view returns (uint64,uint8,uint64,uint64,bool,uint256,bytes32,bool,bytes32,bool)',
  // V7: gameplay parameters are now owner-tunable storage vars, not view functions.
  // The client reads them directly from the public storage getters.
  'function dropTableTiers(uint256,uint256) view returns (uint256)',
  'function skillCostTable(uint256) view returns (uint256)',
  'function durabilityTable(uint256) view returns (uint256)',
  'function ethBacking() view returns (uint256)',
  'function gemsOf(address,uint8) view returns (uint256)',
  'function getConfig() view returns (uint256,uint64,uint64,uint256,uint64,uint8,uint8)',
  'function graduated() view returns (bool)',
  'function graduatedAt() view returns (uint64)',
  'function repairCostTable(uint256,uint256) view returns (uint256)',
  'function rarityWeightTable(uint256) view returns (uint256)',
  'function maxBatch() view returns (uint256)',
  'function redeemPayoutBpsStorage() view returns (uint256)',
  'function setGameParams(uint256[5],uint256[5][5],uint256[5][5],uint256[5],uint256[5],uint256,uint256)',
  'function huntIndexOf(address) view returns (uint64)',
  'function lifetimeScore(address) view returns (uint256)',
  'function maxFindableRarity(address,uint8) view returns (uint8)',
  'function minRedeemWei() view returns (uint256)',
  'function onRoiBoard(address) view returns (bool)',
  'function outstandingLiability() view returns (uint256)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function phase() view returns (uint8)',
  'function playerStats(address) view returns (uint256,uint256,uint256,uint256,uint256,uint64)',
  'function preroundTotal() view returns (uint256)',
  'function preseasonPaused() view returns (bool)',
  'function previewHunt(address,uint8) view returns (uint256[5],uint256)',
  'function priceOf(uint8) pure returns (uint256)',
  'function rarityUnlocked(address,uint8) view returns (bool)',
  'function redeemPayoutBps() pure returns (uint256)',
  'function redeemQuote(uint8,uint256) view returns (uint256,bool)',
  'function repairCost(uint8) pure returns (uint256)',
  'function roi(address) view returns (uint256)',
  'function seasonOpen() view returns (bool)',
  'function seasonScore(address) view returns (uint256)',
  'function seasonSeed() view returns (bytes32)',
  'function seasons(uint64) view returns (uint64,uint8,uint64,uint64,bool,uint256,bytes32,bool,bytes32,bool)',
  'function shortOfFloor(address) view returns (uint256)',
  'function skillOf(address) view returns (uint8)',
  'function token() view returns (address)',
  // tokenRedemptionActive() removed from contract — client returns true directly
  // 'function tokenRedemptionActive() view returns (bool)',
  'function toolCost(uint8) pure returns (uint256)',
  'function toolOf(address) view returns (uint8,uint64,bool)',
  'function totalHuntsOf(address) view returns (uint64)',
  'function migrationCompleted() view returns (bool)',
  'function V3_CONTRACT() view returns (address)',
  'function quartzPrice() view returns (uint256)',
  'function amberPrice() view returns (uint256)',
  'function sapphirePrice() view returns (uint256)',
  'function emeraldPrice() view returns (uint256)',
  'function diamondPrice() view returns (uint256)',
  'function woodCost() view returns (uint256)',
  'function bronzeCost() view returns (uint256)',
  'function silverCost() view returns (uint256)',
  'function goldCost() view returns (uint256)',
  'function mithrilCost() view returns (uint256)',
];

/** Everything a player or the owner sends. */
export const ACTION_ABI = [
  'function buyTool(uint8,uint256) nonpayable returns ()',
  'function buyToolWithEth(uint8,bytes,uint256) payable returns ()',
  'function buyToolWithToken(uint8,uint256) nonpayable returns ()',
  'function closeSeason() nonpayable returns ()',
  'function commitSeason(bytes32) nonpayable returns ()',
  'function commitSeed(bytes32) nonpayable returns ()',
  'function emergencyWithdraw(address,uint256,address) nonpayable returns ()',
  'function endRun() nonpayable returns ()',
  'function finalizeSeason() nonpayable returns ()',
  'function markGraduated() nonpayable returns ()',
  'function migrateFromV3(address) nonpayable returns ()',
  'function completeMigration() nonpayable returns ()',
  'function openSeason() nonpayable returns ()',
  'function pausePre() nonpayable returns ()',
  'function redeemGems(uint8,uint256) nonpayable returns ()',
  'function repairTool() nonpayable returns ()',
  'function resumePre() nonpayable returns ()',
  'function setConfig(uint256,uint64,uint64,uint256,uint64,uint8,uint8) nonpayable returns ()',
  'function setGemPrices(uint256[5]) nonpayable returns ()',
  'function setPaused(bool) nonpayable returns ()',
  'function setToken(address) nonpayable returns ()',
  'function setToolPrices(uint256[5]) nonpayable returns ()',
  'function settleBatch(address,uint8,uint256[5][],uint256[]) nonpayable returns ()',
  'function startSeasonOne() nonpayable returns ()',
  'function transferOwnership(address) nonpayable returns ()',
  'function upgradeSkill(uint8) nonpayable returns ()',
];

/** The subset the UI binds to. Kept separate so a test can assert the app
 *  only ever calls one of these, rather than reaching into owner-only
 *  functions by accident. */
export const PLAYER_ACTIONS = [
  'buyTool',
  'repairTool',
  'settleHunt',
  'upgradeSkill',
  'redeemGems',
  'commitSeed',
  'openSeason',
  'pausePre',
  'resumePre',
  'startSeasonOne',
  'closeSeason',
  'endRun',
];

/** Events the client listens for. */
export const EVENTS_ABI = [
  'ConfigUpdated( uint256, uint64, uint64, uint256, uint64, uint8, uint8)',
  'GemsRedeemed(indexed  address, uint8, uint256, uint256)',
  'HuntSettled(indexed  address, uint256, uint256, uint256)',
  'MarkedGraduated()',
  'OwnershipTransferred(indexed  address,indexed  address)',
  'PausedStateChanged( bool)',
  'PreseasonEnded( uint256, uint256)',
  'PreseasonPaused( bool)',
  'RunEnded( uint64)',
  'SeasonCommitted(indexed  uint64, bytes32)',
  'SeasonFinalized(indexed  uint64)',
  'SeasonOpened(indexed  uint64)',
  'SeasonSeedCommitted(indexed  uint64, bytes32)',
  'SeasonStarted(indexed  uint64, uint64, uint64)',
  'SkillUpgraded(indexed  address, uint256, uint256)',
  'TokenSet(indexed  address)',
  'ToolBought(indexed  address, uint8, uint256, uint256)',
  'ToolRepaired(indexed  address, uint8, uint256)',
  'EmergencyWithdraw(indexed  address, uint256, indexed  address)',
  'MigratedFromV3(indexed  address)',
];

/** Errors worth decoding into a readable message. Generated, so a new custom
 *  error in the contract can never be missing from the decoder. */
export const ERROR_NAMES = [
  'AlreadyCommitted',
  'AlreadyGraduated',
  'AlreadyOpen',
  'BadConfig',
  'BadSignature',
  'BelowMinRedeem',
  'CooldownActive',
  'InsufficientGems',
  'InsufficientTokenBalance',
  'NoToken',
  'NotBroken',
  'NotCommitted',
  'NotHunter',
  'NotLive',
  'NotOpen',
  'NotOwner',
  'NotPreseason',
  'Paused',
  'RarityLocked',
  'RarityNotForSale',
  'ResultMismatch',
  'SeasonHasHunts',
  'SeasonNotEnded',
  'SeasonNotOpen',
  'SeedAlreadyCommitted',
  'SeedNotCommitted',
  'SlotLimit',
  'TierLocked',
  'TokenRailLocked',
  'ToolNotOwned',
  'ToolOutOfRange',
  'TransferFailed',
  'Underpaid',
  'ZeroAmount',
];
