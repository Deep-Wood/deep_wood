/**
 * On-chain leaderboard -- client assembly of the season board from settled
 * chain data, replacing the local-demo board.
 *
 * The contract stores per-player totals (playerStats) and the board score
 * (seasonScore) on-chain, but no ranked list -- a mapping cannot be iterated.
 * So the rank table is a CLIENT artifact, built the same way the SPEC section 9
 * mirror builds it:
 *
 *   1. enumerate players from `BatchSettled` + `Migration` events
 *      (both index the player)
 *   2. read playerStats + seasonScore + roi + onRoiBoard per player
 *   3. sort by ROI, tie-broken by best find then legendary-equivalents
 *
 * The per-player read functions are the contract's own words, which is what
 * makes this the "true" board rather than the client's arithmetic -- the rank
 * inputs are exactly what the chain would use for roi() and onRoiBoard().
 */

import { ethGetLogsChunked } from './chain.js';
import { connect } from './chain.js';

/** topic0 of BatchSettled(address indexed, uint16, uint256). */
const TOPIC_BATCH_SETTLED =
  '0x' + '5735baff3f785fc8554746c9013c2e165bed5e7560855368b59929ac31966512';
/** topic0 of Migration(address indexed, uint8, uint64, uint256[5]). */
const TOPIC_MIGRATION =
  '0x' + '6fa26d385100d139b2500238902c862a9ea39c02f795da15f45e2129b4fde233';
/** topic0 of LegacyMigrated(address indexed, uint256[5], uint8, uint64, uint8, uint64) — V8 migration events. */
const TOPIC_LEGACY_MIGRATED =
  '0x' + '23e864945207f67964b1fb743ce31837df9570d9e255d7dbcc99d78d86783d23';
/** topic0 of HuntSettled(address indexed, uint256, uint256, uint256) — single-hunt settle events. */
const TOPIC_HUNT_SETTLED =
  '0x' + 'e07948b263c9bf0047fa07cb430cbebd9118ee826fe1b6ec1d1195330a0d9799';

/**
 * Collect every player the chain has seen this run: settleBatch emitters plus
 * migrations (a migrated player has V3 state even with zero V3 hunts yet).
 * `topic[1]` holds the indexed player address, padded to 32 bytes.
 */
export async function enumeratePlayers(rpcUrl, fallbacks, gameAddress, deployBlock = null) {
  const fromHex = deployBlock ? '0x' + Number(deployBlock).toString(16) : null;
  // The Robinhood testnet RPC does NOT reliably support topic-filtered
  // eth_getLogs — a filtered query for an existing event can return [] while
  // an unfiltered query returns it. So we fetch ALL events from the contract
  // in one scan and filter client-side by topic0. This also reduces 4 RPC
  // round-trips to 1.
  const ALL_TOPICS = new Set([TOPIC_BATCH_SETTLED, TOPIC_MIGRATION, TOPIC_LEGACY_MIGRATED, TOPIC_HUNT_SETTLED]);
  const logs = await ethGetLogsChunked(rpcUrl, fallbacks, { address: gameAddress }, { fromHex });
  const players = new Set();
  for (const l of logs) {
    const t0 = l.topics?.[0];
    const t1 = l.topics?.[1];
    if (!ALL_TOPICS.has(t0)) continue;
    if (typeof t1 === 'string' && t1.length >= 42) players.add('0x' + t1.slice(26).toLowerCase());
  }
  return [...players];
}

/**
 * One row of the board -- the chain's own numbers for one player.
 *
 * seasonScore is the ROI numerator the contract uses (rarity-weight earned this
 * CURRENT run -- it resets at startSeasonOne, so preseason cannot carry).
 * playerStats.tokenSpent is the denominator. ordering matches DeepWoodV3's
 * board logic: ROI, then best find, then legendary-equivalents.
 *
 * bestWei is the contract's bestSingleFindWei = priceOf(r) of the single best
 * gem ever rolled, so it is matched back to a rarity against the LIVE
 * priceOf(0..4) reads (never the local FACE_VALUE table -- the owner-settable
 * chain prices are what settle validates against, and a stale local table
 * would mislabel the gem). bestRarity is that index, or -1 when bestWei
 * matches no live price (e.g. 0, or a legacy value from an older price table).
 */
export async function playerRow(chain, player) {
  const [stats, score, roi, onBoard, prices] = await Promise.all([
    chain.playerStats(player),
    chain.seasonScore(player),
    chain.roi(player).catch(() => 0n),
    chain.onRoiBoard(player).catch(() => false),
    Promise.all([0, 1, 2, 3, 4].map((r) => chain.priceOf(r).catch(() => null))),
  ]);
  const best = BigInt(stats.best);
  let bestRarity = -1;
  for (let r = 4; r >= 0; r--) {
    if (prices[r] != null && BigInt(prices[r]) === best) { bestRarity = r; break; }
  }
  return {
    address: player.toLowerCase(),
    tokenSpent: stats.tokenSpent,
    totalEarned: stats.totalEarned,
    bestWei: stats.best,
    bestRarity,
    leq: stats.leq,
    hunts: stats.hunts,
    score,        // rarity-weight earned this season (ROI numerator)
    roi,          // 1e18 fixed point, direct from roi()
    onBoard,      // direct from onRoiBoard()
  };
}

/**
 * The ranked board.
 *
 * Order: onBoard first, then ROI desc, then best find desc, then leq desc.
 *
 * The ROI key is the SAME ratio the panel displays -- seasonScore per whole
 * DEEPWOOD spent -- compared exactly with bigint cross-multiplication:
 *   a.score / a.tokenSpent  vs  b.score / b.tokenSpent
 *   <=>  a.score * b.tokenSpent  vs  b.score * a.tokenSpent
 * The chain's own roi() is NOT used for ordering: it is
 * (score * 1e18) / tokenSpent in integer division, and tokenSpent is
 * 18-decimal wei while score is a small rarity weight, so it truncates to 0
 * for every realistic player. Sorting by that 0 ranked everyone equal and
 * silently fell through to the best-find tie-breaker (observed live
 * 2026-11-05: trader2 ranked #1 on a Sapphire tie-break while his displayed
 * ROI was the second-lowest). The panel shows chain roi only when it is
 * non-zero, which is a floor() of this same ratio -- so exact-ratio ordering
 * always agrees with the displayed column. Players the contract excludes
 * (`onRoiBoard` false) rank after every ranked player, not silently missing.
 */
export function rankRows(rows) {
  const roiCmp = (a, b) => {
    const ta = BigInt(a.tokenSpent ?? 0n), tb = BigInt(b.tokenSpent ?? 0n);
    const sa = BigInt(a.score ?? 0n), sb = BigInt(b.score ?? 0n);
    if (ta === 0n || tb === 0n) {
      // No spend = ratio 0 (the panel shows '0x'): ranks below any real ratio.
      if (ta === 0n && tb === 0n) return 0;
      return ta === 0n ? 1 : -1;
    }
    const l = sa * tb, r = sb * ta;
    return l > r ? -1 : l < r ? 1 : 0; // desc
  };
  const sorted = [...rows].sort((a, b) => {
    if (a.onBoard !== b.onBoard) return a.onBoard ? -1 : 1;
    const c = roiCmp(a, b);
    if (c !== 0) return c;
    if (a.bestWei !== b.bestWei) return a.bestWei > b.bestWei ? -1 : 1;
    if (a.leq !== b.leq) return a.leq > b.leq ? -1 : 1;
    return a.address < b.address ? -1 : 1;
  });
  let rank = 0;
  return sorted.map((r) => ({
    ...r,
    rank: r.onBoard ? ++rank : 0,
  }));
}

/**
 * Read the full leaderboard from the chain. Returns rows in rank order, plus
 * the season's own state so the panel can label itself honestly
 * (Preseason vs Season N, open vs closed).
 */
export async function fetchChainLeaderboard({ rpcUrl, fallbackRpcUrls = [], gameAddress, deployBlock = null }) {
  const players = await enumeratePlayers(rpcUrl, fallbackRpcUrls, gameAddress, deployBlock);
  const chain = await connect({ rpcUrl, address: gameAddress, fallbackRpcUrls });
  const [phaseRaw, current, seasonOpen] = await Promise.all([
    chain.phase().then((h) => Number(BigInt(String(h)))).catch(() => null),
    chain.current().catch(() => null),
    chain.seasonOpen().catch(() => null),
  ]);
  const rows = await Promise.all(players.map((p) => playerRow(chain, p)));
  return {
    rows: rankRows(rows),
    playerCount: rows.length,
    phase: phaseRaw,            // 0 preseason, 1 live, 2 closed
    current,
    seasonOpen,
    fromChain: true,
  };
}
