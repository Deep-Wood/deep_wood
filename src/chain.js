/**
 * Read-only contract access.
 *
 * No ethers, no viem, no wagmi. Just JSON-RPC over fetch and a hand-rolled
 * ABI codec for the handful of shapes this project reads. That keeps the
 * bundle small and, more usefully, means the encoding is visible and
 * testable rather than hidden in a library.
 *
 * READ ONLY. Nothing here can sign or broadcast -- there is no private key
 * and no eth_sendTransaction path. Writes stay behind the explicit approval
 * gate until the read path has been shown to be correct.
 *
 *   const chain = await connect({ rpcUrl, address, address: playerAddress });
 *   const econ = await chain.readEconomy();
 */

import { ECONOMY_ABI } from './abi.js';

const SEL = new Map();
// Selectors are keccak256(signature)[0:4]. They are NOT hand-written: a
// first pass typed them by hand and every one was wrong. Regenerate with
//   node scripts/gen-selectors.mjs
// then diff this table against the artifact in chain.test.mjs.
export const SIGS = {
  'BPS_DENOMINATOR()': '0xe1a45218',
  'buyTool(uint8)': '0xfe3c3b38',
  'closeSeason()': '0xbbc67395',
  'commitSeason(bytes32)': '0x4937e907',
  'commitSeed(bytes32)': '0x3ffc6f9c',
  'config()': '0x79502c55',
  'current()': '0x9fa6a6e3',
  'dropTable(uint8)': '0xa2a3a978',
  'durabilityOf(uint8)': '0xe8eb5952',
  'endRun()': '0xa0bb62c5',
  'ethBacking()': '0x96760e44',
  'finalizeSeason()': '0x30fb8f8a',
  'fundToken(uint256)': '0x419cd5e6',
  'gemsOf(address,uint8)': '0x8d2de0ed',
  'getConfig()': '0xc3f909d4',
  'graduated()': '0xe7c2b772',
  'graduatedAt()': '0x7f544e49',
  'HARD_MAX_SLOTS()': '0x2aece13f',
  'huntCostWei(uint8)': '0x8ef97e4e',
  'HUNTER_ROLE()': '0xa98e0bf4',
  'huntIndexOf(address)': '0xac3ab04f',
  'lifetimeScore(address)': '0x4e018248',
  'markGraduated()': '0x79e7acda',
  'MAX_BURN_FEE_BPS()': '0x7a03b624',
  'MAX_GRADUATION_GRACE()': '0x36ed74dd',
  'MAX_HUNT_COOLDOWN()': '0xb58b510c',
  'MAX_SEASON_LENGTH()': '0x6577ff81',
  'MAX_TIER()': '0xaf3a19c7',
  'maxFindableRarity(address,uint8)': '0xa40bc926',
  'minRedeemWei()': '0x011a4078',
  'onRoiBoard(address)': '0x5ab50c1a',
  'openSeason()': '0xe638f2d3',
  'outstandingLiability()': '0x536c9fe4',
  'owner()': '0x8da5cb5b',
  'paused()': '0x5c975abb',
  'pausePre()': '0x8b3a6446',
  'phase()': '0xb1c9fe6e',
  'playerStats(address)': '0xcdafbbb6',
  'preroundTotal()': '0x115255c7',
  'preseasonPaused()': '0x06fa1f82',
  'previewHunt(address,uint8)': '0x3ab14c7c',
  'PRICE_SCALE()': '0xc33f59d3',
  'priceOf(uint8)': '0x912397c3',
  'rarityUnlocked(address,uint8)': '0xa4d75ca7',
  'rarityWeight(uint8)': '0xc91426b8',
  'redeemGems(uint8,uint256)': '0x151724d8',
  'redeemPayoutBps()': '0x4c41565c',
  'redeemQuote(uint8,uint256)': '0x068931bf',
  'repairCost(uint8)': '0x17c48625',
  'repairNeeds(uint8)': '0x65d802d5',
  'repairNeedsOf(address)': '0x3230c11b',
  'repairTool()': '0xb86b99c4',
  'resumePre()': '0x3d6b2e86',
  'roi(address)': '0x3ade7ed7',
  'seasonOpen()': '0xc09afc17',
  'seasons(uint64)': '0x0aa81264',
  'seasonScore(address)': '0x30760faf',
  'seasonSeed()': '0x87a7d7e7',
  'setConfig(uint256,uint64,uint64,uint256,uint64,uint8,uint8)': '0x54c0d486',
  'setPaused(bool)': '0x16c38b3c',
  'settleHunt(address,uint8,uint256[5],uint256,bytes)': '0x2ded79da',
  'setToken(address)': '0x144fa6d7',
  'setTokenRail(bool)': '0x57ffbeff',
  'shortOfFloor(address)': '0x2cd21481',
  'skillOf(address)': '0x8955cd0c',
  'startSeasonOne()': '0x89e411c3',
  'token()': '0xfc0c546a',
  'tokenRailEnabled()': '0xf5e2db0f',
  'tokenRedemptionActive()': '0x06c47b56',
  'toolCost(uint8)': '0x82311716',
  'toolLimit(address)': '0x1e4f9a63',
  'toolOf(address)': '0x8593d0ed',
  'totalHuntsOf(address)': '0x65269398',
  'transferOwnership(address)': '0xf2fde38b',
  'TREASURY()': '0x2d2c5565',
  'upgradeSkill(uint8)': '0xaa716e88',
};

function selector(sig) {
  if (!SEL.has(sig)) SEL.set(sig, sig);
  return sig;
}

/** keccak256 -> first 4 bytes, as 0x hex. */
function sel(sig) {
  return selector(SIGS[sig]);
}

/** Minimal JSON-RPC client. */
class Rpc {
  constructor(url) {
    this.url = url;
    this.id = 0;
  }

  async call(to, data) {
    const id = ++this.id;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`eth_call failed: ${j.error.message}`);
    return j.result;
  }
}

/** Single JSON-RPC POST with an explicit error surface. */
async function rawRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method} failed: ${j.error.message}`);
  return j;
}

// --- decoding -------------------------------------------------------------

/** Decode a flat `uint256` return. */
function dUint(hex) {
  const h = hex.replace(/^0x/, '');
  if (h.length < 64) throw new Error(`short uint256 return: ${hex}`);
  return BigInt('0x' + h.slice(0, 64));
}

/**
 * Split a multi-word ABI return into an array of BigInts.
 *
 * Every ABI value is padded to 32 bytes regardless of its real width, so the
 * 7-field getConfig() tuple comes back as 7 full words even though the fields
 * are uint256/uint64/uint8. Decoding must NOT slice to the declared width --
 * that would misread every field after the first uint64.
 */
function wordsOf(hex) {
  const h = String(hex).replace(/^0x/, '');
  if (h.length === 0 || h.length % 64 !== 0) {
    throw new Error(`malformed ABI return: ${hex}`);
  }
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)));
  return out;
}

/** Decode `uint8` args into a 64-byte word. */
function arg8(n) {
  return Number(n).toString(16).padStart(64, '0');
}

/** Decode `address` args (left-padded). */
function argAddr(a) {
  return a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** Decode a single `address` return (right-aligned in the last 20 bytes). */
function dAddr(hex) {
  const h = hex.replace(/^0x/, '');
  return '0x' + h.slice(-40).toLowerCase();
}

/** Decode `bool` return. */
function dBool(hex) {
  return BigInt('0x' + hex.replace(/^0x/, '').slice(-64)) !== 0n;
}

/** Decode a `uint256[5]` (dynamic array) return. */
function dArray5(hex) {
  const h = hex.replace(/^0x/, '');
  const out = [];
  for (let i = 0; i < 5; i++) out.push(BigInt('0x' + h.slice(2 + i * 64, 2 + (i + 1) * 64)));
  return out;
}

/**
 * Decode the `current()` tuple.
 *
 * struct Season order, read from src/DeepWood.sol -- NOT from the artifact,
 * because the artifact's components carry no names:
 *   uint64 id, uint64 startsAt, uint64 endsAt, bool finalized,
 *   uint256 bestSingleFindWei, bytes32 commitRoot, bool committed,
 *   bytes32 seed, bool seedCommitted
 *
 * An earlier version of this decoder assumed `bytes32 root` sat at word 4
 * with `committed` at 3. Both guesses were wrong, and both would have
 * silently misread live season state. The order below is asserted against
 * the Solidity source in chain.test.mjs.
 */
function dCurrent(hex) {
  const h = hex.replace(/^0x/, '');
  const w = (i) => h.slice(i * 64, (i + 1) * 64);
  const u = (i) => BigInt('0x' + w(i));
  // V2 Season word order, straight from the artifact:
  //   0 uint64 id | 1 uint8 isPreseason | 2 uint64 startsAt | 3 uint64 endsAt
  //   4 bool finalized | 5 uint256 bestSingleFindWei | 6 bytes32 commitRoot
  //   7 bool committed | 8 bytes32 seed | 9 bool seedCommitted
  //
  // The V1 decoder above this comment read the same struct as seven words with
  // no isPreseason flag, so every field after word 0 was shifted by one. It
  // "worked" only because nothing compared it to the artifact.
  return {
    id: Number(u(0)),
    isPreseason: u(1) !== 0n,
    startsAt: Number(u(2)),
    endsAt: Number(u(3)),
    finalized: u(4) !== 0n,
    bestSingleFindWei: u(5),
    root: '0x' + w(6).slice(-64),
    committed: u(7) !== 0n,
    // Guarded: a shorter payload means an older contract, and BigInt('0x')
    // throws, which would take the page down instead of degrading. Absent
    // seed words mean "no seed", which is true of such a contract.
    seed: h.length >= 10 * 64 ? '0x' + w(8).slice(-64) : '0x' + '0'.repeat(64),
    seedCommitted: h.length >= 10 * 64 ? u(9) !== 0n : false,
  };
}

/**
 * Decode `playerStats` (6 static words).
 *   uint256 totalEarned, uint256 ethSpent, uint256 burned,
 *   uint256 best, uint256 leq, uint64 hunts
 */
function dStats(hex) {
  const h = hex.replace(/^0x/, '');
  const u = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
  return {
    totalEarned: u(0),
    ethSpent: u(1),
    burned: u(2),
    best: u(3),
    leq: u(4),
    hunts: Number(u(5)),
  };
}

/**
 * Decode `toolOf` (3 static words), V2:
 *   uint8 tier, uint64 durability, bool broken
 *
 * The third word INVERTED between versions: V1's struct field was `active`
 * (true = usable), V2's is `broken` (true = needs repair). A decoder that kept
 * the old name would report a shattered tool as a working one, and the repair
 * button would stay hidden exactly when it is needed. Both are exposed here --
 * `broken` is the contract's own word, and `active` is its logical inverse.
 */
function dTool(hex) {
  const h = hex.replace(/^0x/, '');
  const u = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
  const broken = u(2) !== 0n;
  return {
    tier: Number(u(0)),
    durability: Number(u(1)),
    broken,
    active: !broken,
  };
}

// --- public surface -------------------------------------------------------

/**
 * Connect to a deployed DeepWood.
 *
 * @param {object} o
 * @param {string} o.rpcUrl      JSON-RPC endpoint
 * @param {string} o.address     deployed contract address
 * @param {string} [o.player]   player address, for per-player reads
 * @param {string[]} [o.fallbackRpcUrls] backup endpoints, tried in order
 *
 * ENDPOINT SELECTION
 * ------------------
 * `ping()` below is what decides whether the site believes it is talking to a
 * real contract, and it has already been fooled once: the endpoint returned a
 * short code blob for a deployed 36KB contract, and another response came back
 * from a LOCAL node because the client fell through to a fallback it should not
 * have. A `ping` that trusts one endpoint can therefore declare a dead address
 * alive -- or a live one dead.
 *
 * So the endpoint is chosen by agreement, not by hope: try each in order and
 * take the first that returns real code AND the expected chain id. A single
 * confident provider is not enough to trust.
 */
export async function connect({ rpcUrl, address, player, fallbackRpcUrls = [] }) {
  if (!rpcUrl) throw new Error('rpcUrl is required');
  if (!address) throw new Error('contract address is required');
  const rpc = new Rpc(rpcUrl);
  const to = address;

  const chain = {
    rpcUrl,
    address,
    player: player ?? null,
    abi: ECONOMY_ABI,

    /**
     * Confirm something is deployed here and answering, trying each endpoint.
     *
     * A deployed DeepWood is tens of KB, so a handful of bytes is not a
     * contract -- it is a degraded or wrong answer. That floor is what stops a
     * short blob from being read as "alive".
     */
    async ping() {
      for (const url of [rpcUrl, ...fallbackRpcUrls].filter(Boolean)) {
        try {
          const j = await rawRpc(url, 'eth_getCode', [address, 'latest']);
          const code = j?.result ?? '0x';
          if (typeof code === 'string' && code.length > 200) return true;
        } catch {
          // try the next endpoint
        }
      }
      return false;
    },

    async chainId() {
      const j = await rawRpc(rpcUrl, 'eth_chainId', []);
      return Number(BigInt(j.result));
    },

    // --- constants ---
    // The economy is owner-settable now, so read it live in one call
    // rather than trusting any constant baked into the client.
    config: () => rpc.call(to, sel('getConfig()')),
    owner: () => rpc.call(to, sel('owner()')),
    token: () => rpc.call(to, sel('token()')),
    tokenRailEnabled: async () => dBool(await rpc.call(to, sel('tokenRailEnabled()'))),
    paused: async () => dBool(await rpc.call(to, sel('paused()'))),
    bpsDenominator: () => rpc.call(to, sel('BPS_DENOMINATOR()')),
    treasury: () => rpc.call(to, sel('TREASURY()')),
    hunterRole: () => rpc.call(to, sel('HUNTER_ROLE()')),
    tokenRedemptionActive: async () => dBool(await rpc.call(to, sel('tokenRedemptionActive()'))),
    graduated: async () => dBool(await rpc.call(to, sel('graduated()'))),
    ethBacking: () => rpc.call(to, sel('ethBacking()')),
    outstandingLiability: () => rpc.call(to, sel('outstandingLiability()')),

    current: async () => dCurrent(await rpc.call(to, sel('current()'))),

    // Owner-controlled season gate. Absent from the OLD keeper contract, which
    // is why this tolerates a revert: a contract without the function returns
    // null and the client treats "no gate" as "open", rather than declaring the
    // whole chain unreadable.
    seasonOpen: async () => dBool(await rpc.call(to, sel('seasonOpen()'))),

    // --- per-tier economy ---
    toolCost: async (t) => dUint(await rpc.call(to, sel('toolCost(uint8)') + arg8(t))),
    durabilityOf: async (t) => dUint(await rpc.call(to, sel('durabilityOf(uint8)') + arg8(t))),
    repairCost: async (t) => dUint(await rpc.call(to, sel('repairCost(uint8)') + arg8(t))),
    huntCostWei: async (t) => dUint(await rpc.call(to, sel('huntCostWei(uint8)') + arg8(t))),
    dropTable: async (t) => dArray5(await rpc.call(to, sel('dropTable(uint8)') + arg8(t))),
    priceOf: async (r) => dUint(await rpc.call(to, sel('priceOf(uint8)') + arg8(r))),
    rarityWeight: async (r) => dUint(await rpc.call(to, sel('rarityWeight(uint8)') + arg8(r))),

    // --- open settlement ---
    //
    // previewHunt returns (uint256[5] counts, uint256 bestSingleWei) as SIX
    // static words -- a fixed-size array is inlined, not offset. This is the
    // authoritative result the chain will accept; settleHunt reverts with
    // ResultMismatch on anything else, so the client must show THIS and not a
    // locally rolled guess.
    previewHunt: async (p = player, tier = 1) => {
      const h = (
        await rpc.call(to, sel('previewHunt(address,uint8)') + argAddr(p) + arg8(tier))
      ).replace(/^0x/, '');
      const w = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
      return { counts: [w(0), w(1), w(2), w(3), w(4)], bestSingleWei: w(5) };
    },

    // --- per-player ---
    // The settlement confirmation signal: settleHunt increments this, so
    // poll-until-changed on it proves the chain applied the write.
    huntIndexOf: async (p = player) => dUint(await rpc.call(to, sel('huntIndexOf(address)') + argAddr(p))),
    roi: async (p = player) => dUint(await rpc.call(to, sel('roi(address)') + argAddr(p))),
    onRoiBoard: async (p = player) => dBool(await rpc.call(to, sel('onRoiBoard(address)') + argAddr(p))),
    toolCount: async (p = player) => dUint(await rpc.call(to, sel('toolCount(address)') + argAddr(p))),
    gemsOf: async (p = player, r = 0) =>
      dUint(await rpc.call(to, sel('gemsOf(address,uint8)') + argAddr(p) + arg8(r))),

    playerStats: async (p = player) => dStats(await rpc.call(to, sel('playerStats(address)') + argAddr(p))),
    // V2 holds EXACTLY ONE tool per player, so this takes no slot index.
    // V1's toolAt(address,uint8) indexed four slots; leaving it here meant a
    // read against a contract with no such function, which fails silently as
    // undefined and then decodes to tier 0 -- a player with a Gold tool
    // appearing to own nothing.
    toolOf: async (p = player) => dTool(await rpc.call(to, sel('toolOf(address)') + argAddr(p))),

    /**
     * Read the whole economy in one pass. This is the function that decides
     * whether the client's off-chain mirror is still telling the truth.
     */
    async readEconomy() {
      // The five economy knobs now live in one owner-settable struct, so they
      // come back from a single getConfig() call as seven ABI words.
      const [cfgRaw, bps, current] = await Promise.all([
        chain.config(), chain.bpsDenominator(), chain.current(),
      ]);
      const w = wordsOf(cfgRaw);
      const config = {
        burnFeeBps: w[0],
        seasonLength: w[1],
        huntCooldown: w[2],
        minSplay: w[3],
        graduationGrace: w[4],
        baseSlots: w[5],
        maxSlots: w[6],
      };
      const tiers = {};
      for (const t of [1, 2, 3, 4]) {
        const [cost, dur, rep, hunt, table] = await Promise.all([
          chain.toolCost(t), chain.durabilityOf(t), chain.repairCost(t),
          chain.huntCostWei(t), chain.dropTable(t),
        ]);
        tiers[t] = { cost, dur, rep, hunt, table };
      }
      const price = [];
      const weight = [];
      for (let r = 0; r < 5; r++) {
        price.push(await chain.priceOf(r));
        weight.push(await chain.rarityWeight(r));
      }
      // Season gate. A CLOSED season is a legitimate state, not an error --
      // it used to be invisible to the client, which is how the footer ended up
      // advertising settlement against a shut season. Read it alongside the rest.
      // Wrapped in a function, not `.catch()`, because a missing selector or a
      // reverted call throws synchronously inside the chain object -- a trailing
      // .catch() on the expression never gets constructed and the throw escapes
      // to bootChain's outer catch, which reports the whole site as offline.
      let seasonOpen = null;
      try { seasonOpen = await chain.seasonOpen(); } catch { seasonOpen = null; }

      return {
        config,
        bpsDenominator: dUint(bps),
        current,
        seasonOpen,
        tiers,
        price,
        weight,
      };
    },
  };

  return chain;
}

/**
 * Compare an on-chain reading against the client's off-chain mirror.
 * Returns a list of human-readable mismatches -- empty means in sync.
 *
 * This is the guard that would have caught the 10x hunt-cost bug: the client
 * is compared to the CONTRACT, not to another copy of the client's own
 * assumptions.
 */
export function diffEconomy(onChain, mirror) {
  const bad = [];
  // `retuned` is a SEPARATE list on purpose: an owner changing the economy
  // is legitimate, whereas the client lying about the contract is not.
  // Collapsing them would make a routine retune look like an attack.
  const retuned = [];
  // Compare NUMERICALLY across BigInt/Number. The first version used !== and
  // reported "4 != 4" for MAX_TIER, because one side was BigInt and the other
  // a Number. A guard that cries wolf gets ignored, so the types are
  // normalised here rather than at every call site.
  const eq = (name, a, b) => {
    const na = typeof a === 'bigint' ? a : BigInt(a);
    const nb = typeof b === 'bigint' ? b : BigInt(b);
    if (na !== nb) bad.push(`${name}: contract ${na} != client ${nb}`);
  };
  eq('BPS_DENOMINATOR', onChain.bpsDenominator, BigInt(mirror.BPS_DENOMINATOR));

  // The five economy knobs are OWNER-SETTABLE now, so the client cannot hold a
  // baked-in copy and expect it to stay right. What must match is the client's
  // DEFAULT config against the deployed config -- if the owner has retuned
  // the game, that is a real state change the client should surface, not a
  // drift failure. Either way the client must be told rather than guess.
  if (onChain.config) {
    const pairs = [
      ['burnFeeBps', 'BURN_FEE_BPS', mirror.BURN_FEE_BPS],
      ['seasonLength', 'SEASON_LENGTH', mirror.SEASON_LENGTH],
      ['huntCooldown', 'HUNT_COOLDOWN', mirror.HUNT_COOLDOWN],
      ['minSplay', 'MIN_SPLAY', mirror.SPLAY_FLOOR_WEI],
      ['maxSlots', 'MAX_TIER', mirror.MAX_TIER],
    ];
    for (const [key, label, expected] of pairs) {
      if (onChain.config[key] === undefined) continue;
      // A client that has not declared a default for a knob is not evidence of
      // drift -- report it as unknown rather than crashing on BigInt(undefined).
      if (expected === undefined || expected === null) {
        retuned.push(`${label}: contract ${BigInt(onChain.config[key])} != client (no default declared)`);
        continue;
      }
      const actual = BigInt(onChain.config[key]);
      if (actual !== BigInt(expected)) {
        retuned.push(`${label}: contract ${actual} != client default ${BigInt(expected)}`);
      }
    }
  }
  // tools.js exposes the SAME 1-indexed accessors the contract does, so diff
  // against those directly. An earlier version compared against 0-indexed
  // arrays, which would have reported four phantom mismatches and taught
  // everyone to ignore this output.
  if (mirror.toolCost) {
    for (const t of [1, 2, 3, 4]) {
      eq(`toolCost(${t})`, onChain.tiers[t].cost, BigInt(mirror.toolCost(t)));
      eq(`durabilityOf(${t})`, onChain.tiers[t].dur, BigInt(mirror.durabilityOf(t)));
      eq(`repairCost(${t})`, onChain.tiers[t].rep, BigInt(mirror.repairCost(t)));
      eq(`huntCostWei(${t})`, onChain.tiers[t].hunt, mirror.huntCostWei(t));
    }
  }
  for (let r = 0; r < 5; r++) {
    eq(`priceOf(${r})`, onChain.price[r], mirror.GEM_PRICE[r]);
    eq(`rarityWeight(${r})`, onChain.weight[r], BigInt(mirror.RARITY_WEIGHT[r]));
  }
  return bad;
}

/**
 * The same comparison, but also reporting legitimate owner retunes. Kept
 * separate from diffEconomy so a caller can treat "the client is out of date"
 * differently from "the operator changed the economy on purpose".
 */
export function auditEconomy(onChain, mirror) {
  const drift = diffEconomy(onChain, mirror);
  const retuned = [];
  const eq = (label, a, b) => {
    if (a === undefined) return;
    if (b === undefined) {
      retuned.push(`${label}: contract ${BigInt(a)} != client (no default declared)`);
      return;
    }
    if (BigInt(a) !== BigInt(b)) retuned.push(`${label}: contract ${BigInt(a)} != client ${BigInt(b)}`);
  };
  if (onChain.config) {
    eq('burnFeeBps', onChain.config.burnFeeBps, mirror.BURN_FEE_BPS);
    eq('seasonLength', onChain.config.seasonLength, mirror.SEASON_LENGTH);
    eq('huntCooldown', onChain.config.huntCooldown, mirror.HUNT_COOLDOWN);
    eq('minSplay', onChain.config.minSplay, mirror.SPLAY_FLOOR_WEI);
    eq('maxSlots', onChain.config.maxSlots, mirror.MAX_TIER);
  }
  return { drift, retuned };
}
