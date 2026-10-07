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

/**
 * Collect every player the chain has seen this run: settleBatch emitters plus
 * migrations (a migrated player has V3 state even with zero V3 hunts yet).
 * `topic[1]` holds the indexed player address, padded to 32 bytes.
 */
export async function enumeratePlayers(rpcUrl, fallbacks, gameAddress) {
  const [batches, migrations] = await Promise.all([
    ethGetLogsChunked(rpcUrl, fallbacks, { address: gameAddress, topics: [TOPIC_BATCH_SETTLED] }),
    ethGetLogsChunked(rpcUrl, fallbacks, { address: gameAddress, topics: [TOPIC_MIGRATION] }),
  ]);
  const players = new Set();
  for (const l of [...batches, ...migrations]) {
    const t = l.topics?.[1];
    if (typeof t === 'string' && t.length >= 42) players.add('0x' + t.slice(26).toLowerCase());
  }
  return [...players];
}

/**
 * One row of the board -- the chain's own numbers for one player.
 *
 * seasonScore is the ROI numerator the contract uses (rarity-weight earned this
 * CURRENT run -- it resets at startSeasonOne, so preseason cannot carry).
 * playerStats.ethSpent is the denominator. ordering matches DeepWoodV3's
 * board logic: ROI, then best find, then legendary-equivalents.
 */
export async function playerRow(chain, player) {
  const [stats, score, roi, onBoard] = await Promise.all([
    chain.playerStats(player),
    chain.seasonScore(player),
    chain.roi(player).catch(() => 0n),
    chain.onRoiBoard(player).catch(() => false),
  ]);
  return {
    address: player.toLowerCase(),
    ethSpent: stats.ethSpent,
    totalEarned: stats.totalEarned,
    bestWei: stats.best,
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
 * Order: roi desc, then best find desc, then leq desc -- the same three keys
 * season.js ranks the local mirror by, read straight from the contract so a
 * whale playing identically posts the same ROI as a small player. Players the
 * contract excludes (`onRoiBoard` false) rank after every ranked player, not
 * silently missing -- an honest "spent X, need Y more" beats an empty board.
 */
export function rankRows(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (a.onBoard !== b.onBoard) return a.onBoard ? -1 : 1;
    if (a.roi !== b.roi) return a.roi > b.roi ? -1 : 1;
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
export async function fetchChainLeaderboard({ rpcUrl, fallbackRpcUrls = [], gameAddress }) {
  const players = await enumeratePlayers(rpcUrl, fallbackRpcUrls, gameAddress);
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
