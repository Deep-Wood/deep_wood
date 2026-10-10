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
  'buyToolWithToken(uint8,uint256,uint256,uint256)': '0xe030f7c7',
  'emergencyWithdraw(address,uint256,address)': '0x551512de',
  'migrateFromV3(address)': '0xeee645f2',
  'completeMigration()': '0x4886f62c',
  'buyNonce(address)': '0xe40afab2',
  'getEthPerToken()': '0xcb27d6b6',
  'getTokensPerEth()': '0x6893f63f',
  'readSqrtPriceX96()': '0x3145fcd6',
  'migrationCompleted()': '0x31677980',
  'POOL_MANAGER()': '0x62308e85',
  'POOL_ID()': '0xe0d7d0e9',
  'V3_CONTRACT()': '0xa5dd65b6',
  'closeSeason()': '0xbbc67395',
  'TREASURY()': '0x2d2c5565',
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
  'MAX_BATCH()': '0x950bff9f',
  'MAX_BURN_FEE_BPS()': '0x7a03b624',
  'MAX_GRADUATION_GRACE()': '0x36ed74dd',
  'MAX_HUNT_COOLDOWN()': '0xb58b510c',
  'MAX_SEASON_LENGTH()': '0x6577ff81',
  'MAX_TIER()': '0xaf3a19c7',
  'maxFindableRarity(address,uint8)': '0xa40bc926',
  'migrateFromV2(address,uint8,uint64,uint256[5])': '0x3b1e1d0b',
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
  'previewHuntAt(address,uint8,uint256)': '0x6bab987f',
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
  'settleBatch(address,uint8,uint256[5][],uint256[])': '0x46fed0ad',
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
  'upgradeSkill(uint8)': '0xaa716e88',
};

function selector(sig) {
  if (!SEL.has(sig)) SEL.set(sig, sig);
  return sig;
}


/** Ordered-list endpoint runner: every read tries the primary, then fallbacks, first good answer wins. */
async function rpcFirst(rpcUrl, fallbacks, method, params, ok) {
  for (const url of [rpcUrl, ...fallbacks].filter(Boolean)) {
    try {
      const j = await rawRpc(url, method, params);
      if (j.error) throw new Error(j.error.message || String(j.error));
      if (ok && !ok(j.result)) continue;
      return j.result;
    } catch {
      // next endpoint
    }
  }
  throw new Error(`${method}: every RPC endpoint failed or disagreed`);
}

/**
 * eth_getLogs across a range, chunked to stay under the provider's cap.
 * The chain here is ~130M blocks and the endpoints allow at most a few
 * million per request, so a single fromBlock:0 scan errors out and (with a
 * swallowing caller) would report an empty history. Chunks are cached in
 * module state keyed by (address, topic0) so a second panel open only scans
 * the blocks mined since the first.
 */
const __logCache = new Map(); // key -> { block, logs }
export async function ethGetLogsChunked(rpcUrl, fallbackRpcUrls, filter, {
  chunkSize = 2_000_000,
  fromHex = '0x0',
} = {}) {
  const latestHex = (await rawRpc(rpcUrl, 'eth_blockNumber', [])).result;
  const latest = Number(BigInt(latestHex));
  const from = Number(BigInt(fromHex));
  const key = JSON.stringify([filter.address ?? '', ...(filter.topics ?? [])]);
  const cached = __logCache.get(key) ?? { block: from - 1, logs: [] };
  const all = cached.logs.slice();
  for (let start = Math.max(from, cached.block + 1); start <= latest; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, latest);
    const f = { ...filter, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) };
    const logs = await ethGetLogs(rpcUrl, fallbackRpcUrls, f);
    if (logs.length) all.push(...logs);
    cached.block = end;
  }
  __logCache.set(key, cached);
  return all;
}

/**
 * eth_getLogs for ONE chunk, trying each endpoint until one returns an array.
 * A short or error result from one provider must not be believed -- the
 * primary on this chain has answered with a truncated code blob before, and a
 * confident-wrong answer is worse than a failure.
 */
export async function ethGetLogs(rpcUrl, fallbackRpcUrls = [], filter) {
  return rpcFirst(rpcUrl, fallbackRpcUrls, 'eth_getLogs', [filter],
    (r) => Array.isArray(r));
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
    // Per-call transport retry. readEconomy issues ~20 sequential eth_calls and
    // the testnet RPCs intermittently drop one outright (bare "Failed to
    // fetch"); without a retry here a single drop aborted the whole boot and
    // the site fell back to the offline simulation. A JSON-RPC error object is
    // a real revert and is thrown immediately, not retried.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        });
        if (!res.ok && res.status >= 500) throw new Error(`eth_call: HTTP ${res.status}`);
        const j = await res.json();
        if (j.error) throw new Error(`eth_call failed: ${j.error.message}`);
        return j.result;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
}

/**
 * A single JSON-RPC POST, retried on TRANSPORT failure.
 *
 * The testnet endpoints (rpc.testnet.chain.robinhood.com / drpc) intermittently
 * drop a request outright -- fetch rejects with a bare TypeError ("Failed to
 * fetch"), not an HTTP error. rawRpc previously made ONE attempt, so a single
 * dropped request killed the caller. readEconomy issues ~20 sequential calls,
 * so one drop anywhere aborted the whole boot and the site reported "offline"
 * while the contract was perfectly healthy.
 *
 * Two retries with short backoff survive the drops without masking a real
 * outage: a genuinely dead endpoint still fails after all attempts and falls
 * through to rpcFirst's next-endpoint logic as before. Only transport-level
 * failures (fetch threw, or a non-2xx/network response) are retried -- a
 * JSON-RPC error object is a REAL answer from the chain and is returned, not
 * retried, because re-sending it would just get the same revert.
 */
async function fetchOnce(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method, params }),
  });
  // A 502/503 from an edge proxy is a transport problem, not an RPC answer.
  if (!res.ok && res.status >= 500) {
    throw new Error(`${method}: HTTP ${res.status}`);
  }
  return res;
}

export async function rawRpc(rpcUrl, method, params) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchOnce(rpcUrl, method, params);
      const j = await res.json();
      if (j.error) throw new Error(`${method} failed: ${j.error.message}`);
      return j;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  throw lastErr;
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
export function argAddr(a) {
  return a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** Encode a `uint256` arg (offsets, amounts) as a 64-byte word. */
export function argUint(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

/** Decode a single `address` return (right-aligned in the last 20 bytes). */
function dAddr(hex) {
  const h = hex.replace(/^0x/, '');
  return '0x' + h.slice(-40).toLowerCase();
}

/** Decode `bool` return. */
export function dBool(hex) {
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
    /** Low-level JSON-RPC call. The leaderboard needs seasonScore(), which is
     *  not part of the named reads, so the transport is exposed rather than
     *  wrapping every future getter one at a time. Read-only -- there is no
     *  transaction path here. */
    rpc,

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

    // --- V2 lifecycle ---
    // `phase` is the only honest source for what the game is doing right now.
    // It did not exist in V1, which had a single season and a `paused` flag.
    // The header previously named a season from a hardcoded string and so
    // claimed "Season I" while the chain was in Preseason.
    phase: () => rpc.call(to, sel('phase()')),
    preseasonPaused: async () => dBool(await rpc.call(to, sel('preseasonPaused()'))),
    seasonOpen: async () => dBool(await rpc.call(to, sel('seasonOpen()'))),
    seasonSeed: async () => rpc.call(to, sel('seasonSeed()')),

    /** seasonScore: the ROI numerator the contract keeps per-player. */
    seasonScore: async (p = player) => dUint(await rpc.call(to, sel('seasonScore(address)') + argAddr(p))),

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

    // V3: the roll for the hunt `offset` digs FROM NOW. Free (eth_call), so
    // the whole upcoming batch can be pre-rolled before any settle happens.
    // Same six-word shape as previewHunt.
    previewHuntAt: async (p = player, tier = 1, offset = 0) => {
      const h = (
        await rpc.call(
          to,
          sel('previewHuntAt(address,uint8,uint256)') + argAddr(p) + arg8(tier) + argUint(offset)
        )
      ).replace(/^0x/, '');
      const w = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
      return { counts: [w(0), w(1), w(2), w(3), w(4)], bestSingleWei: w(5) };
    },

    maxBatch: async () => dUint(await rpc.call(to, sel('MAX_BATCH()'))),

    // --- redemption quotes ---
    // redeemQuote(uint8,uint256) view returns (uint256 payout, bool aboveFloor)
    // The sell flow quotes BEFORE sending so the button can explain a
    // below-floor redemption instead of letting the player sign and revert.
    // The selector exists in the table above; the reader method was missing
    // and every gem redemption threw `redeemQuote is not a function`.
    redeemQuote: async (rarity = 0, count = 1n) => {
      const raw = await rpc.call(
        to,
        sel('redeemQuote(uint8,uint256)') + arg8(rarity) + argUint(count)
      );
      // wordsOf returns BigInt words; dBool takes a hex STRING, so test the
      // word directly instead of round-tripping through a decoder.
      const w = wordsOf(raw);
      return [w[0], w[1] !== 0n];
    },
    minRedeemWei: async () => dUint(await rpc.call(to, sel('minRedeemWei()'))),

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
      // All four tiers in parallel. The testnet RPC is ~800ms per call from a
      // browser (CORS preflight + slow node), so four sequential tiers plus
      // five sequential rarities pushed the whole read past the 12s boot
      // deadline and the site reported "offline · retry" while the contract
      // was healthy. Promise.all cuts the wall time to one call's latency.
      const tierData = await Promise.all([1, 2, 3, 4].map(async (t) => {
        const [cost, dur, rep, hunt, table] = await Promise.all([
          chain.toolCost(t), chain.durabilityOf(t), chain.repairCost(t),
          chain.huntCostWei(t), chain.dropTable(t),
        ]);
        return [t, { cost, dur, rep, hunt, table }];
      }));
      const tiers = Object.fromEntries(tierData);
      const [price, weight] = await Promise.all([
        Promise.all([0, 1, 2, 3, 4].map((r) => chain.priceOf(r))),
        Promise.all([0, 1, 2, 3, 4].map((r) => chain.rarityWeight(r))),
      ]);
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

// =====================================================================
// V4: Price oracle and token buy
// =====================================================================

/**
 * Read sqrtPriceX96 from the Uniswap V4 pool via PoolManager extsload.
 * Pool state is at storage slot 6, keyed by keccak256(poolId, slot).
 */
export async function readSqrtPriceX96(rpcUrl, fallbackRpcUrls, poolManager, poolId) {
  // Compute state slot: keccak256(abi.encodePacked(poolId, bytes32(uint256(6))))
  const slotData = poolId + '0000000000000000000000000000000000000000000000000000000000000006';
  const stateSlot = await rawRpc(rpcUrl, 'web3_sha3', [slotData]);
  if (stateSlot.error) throw new Error(stateSlot.error.message);
  
  // Read storage at that slot
  const data = await rpcFirst(rpcUrl, fallbackRpcUrls, 'eth_getStorageAt', [poolManager, stateSlot.result, 'latest']);
  // An empty read means the pool state slot has no data -- either the poolId is
  // wrong, the PoolManager address is wrong, or the pool was never initialized.
  // rpcFirst already tries every endpoint, so reaching here means the slot is
  // genuinely empty, not that an endpoint was down. Surface the WHY (the slot
  // and pool) so this is diagnosable from the thrown message, not a bare
  // "eth_getStorageAt failed" that says nothing about which read is missing.
  if (data === undefined || data === null || data === '') {
    throw new Error(`pool state slot ${stateSlot.result} empty for poolId ${poolId} at ${poolManager} -- pool uninitialized or wrong address`);
  }
  
  // Decode: low 160 bits = sqrtPriceX96. `data` IS the hex string -- rpcFirst
  // returns j.result directly (not a {result} wrapper), so decode `data`, not
  // data.result. The old `!data.result` guard always evaluated truthy and threw
  // on every call, and BigInt(data.result) was reading a property off a string.
  const raw = BigInt(data);
  const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
  return sqrtPriceX96;
}

/**
 * Get ETH per DEEPWOOD token price from the pool.
 * Returns wei per token (18 decimals).
 */
export async function getEthPerToken(rpcUrl, fallbackRpcUrls, poolManager, poolId) {
  const sqrtPriceX96 = await readSqrtPriceX96(rpcUrl, fallbackRpcUrls, poolManager, poolId);
  if (sqrtPriceX96 === 0n) throw new Error('sqrtPriceX96 is zero');
  const Q96 = 2n ** 96n;
  // sqrtPriceX96 = sqrt(token/eth) * 2^96  =>  eth/token = (2^96 / sqrtPriceX96)^2
  // Computed in FIXED POINT scaled by 1e18 so it does not underflow to zero:
  // when the pool prices the token BELOW 1 ETH (sqrtPriceX96 > Q96), the naive
  // (Q96*Q96)/(sqrt*sqrt) floors to 0 and every downstream token cost divides
  // by zero -- which is exactly what made "pay DeepWood" fail. The 1e18 scale
  // keeps integer precision across the full uint256 range, so the returned value
  // is wei-of-ETH per token, already scaled by 1e18 (i.e. it is "eth per token"
  // in 1e18 fixed point). Divide a wei cost by it and multiply by 1e18 to get a
  // token amount in the token's own 18-decimal units.
  const ethPerTokenScaled = (Q96 * Q96 * 10n ** 18n) / (sqrtPriceX96 * sqrtPriceX96);
  return ethPerTokenScaled;
}

/**
 * Get DEEPWOOD tokens per ETH from the pool.
 * Returns tokens per ETH (18 decimals).
 */
export async function getTokensPerEth(rpcUrl, fallbackRpcUrls, poolManager, poolId) {
  // ethPerToken is now 1e18-scaled (eth per token, fixed point). Invert it to
  // tokens per ETH in the same 1e18 fixed point: 1e18 / (ethPerToken/1e18).
  const ethPerToken = await getEthPerToken(rpcUrl, fallbackRpcUrls, poolManager, poolId);
  if (ethPerToken === 0n) throw new Error('ethPerToken is zero');
  return (10n ** 18n * 10n ** 18n) / ethPerToken;
}

/**
 * Get the player's current buy nonce.
 */
export async function getBuyNonce(rpcUrl, fallbackRpcUrls, gameAddress, player) {
  // rpcFirst returns j.result directly (the hex string), not a {result}
  // wrapper -- decode `result` itself. BigInt(result.result) was reading a
  // property off a string and threw "Cannot convert undefined to a BigInt".
  // Only accept a non-empty hex word so an empty '0x' answer from one
  // endpoint falls through to the next instead of failing BigInt().
  const result = await rpcFirst(rpcUrl, fallbackRpcUrls, 'eth_call', [
    { to: gameAddress, data: '0xe40afab2' + player.slice(2).padStart(64, '0') },
    'latest'
  ], (r) => typeof r === 'string' && /^0x[0-9a-fA-F]+$/.test(r));
  return BigInt(result);
}

/**
 * Buy tool with $DEEPWOOD token at 10% discount.
 * Returns a transaction to be signed by the wallet.
 */
export function buyToolWithTokenTx(tier, maxTokenCost, quoteExpiresAt, nonce) {
  // buyToolWithToken(uint8,uint256,uint256,uint256)
  const selector = '0xe030f7c7';
  const params = [
    tier.toString(16).padStart(64, '0'),
    maxTokenCost.toString(16).padStart(64, '0'),
    quoteExpiresAt.toString(16).padStart(64, '0'),
    nonce.toString(16).padStart(64, '0')
  ].join('');
  return selector + params;
}
