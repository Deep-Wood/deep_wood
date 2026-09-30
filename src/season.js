/**
 * Season leaderboard -- client mirror of SPEC.md section 9.
 *
 * The whole design is here: the board ranks EFFICIENCY, not wealth. A whale
 * playing identically to a small player posts an identical ROI. They simply
 * get there sooner, and that is the only difference the game rewards.
 *
 * That is why the primary metric is a ratio, and why the denominator carries a
 * splay floor. Without the floor, one lucky hunt and a logout posts a perfect
 * score on a trivial denominator and takes the top of the board -- the exact
 * failure the floor exists to prevent.
 *
 * Ranking, in order:
 *   1. ROI        = rarityWeight earned / ETH spent
 *   2. Best find  = single highest-value hunt (rewards nerve, not hours)
 *   3. Legendary-equivalents (makes a Diamond worth more than 40 Quartz)
 *
 * Nothing here touches a contract. The contract stores per-player totals and
 * a season-wide best; assembling a ranked board from those is an off-chain
 * job, and this is the client half of it.
 */

// --- from DeepWood.sol -------------------------------------------------
export const RARITY_NAME = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

/** Face value of one gem, wei. Mirrors priceOf(). */
export const GEM_PRICE = [
  50_000_000_000_000n,  // Common    0.00005
  400_000_000_000_000n,  // Uncommon  0.0004
  3_000_000_000_000_000n, // Rare      0.003
  25_000_000_000_000_000n, // Epic     0.025
  200_000_000_000_000_000n, // Legendary 0.2
];

/** Rarity weight of a single gem -- the ROI numerator. Mirrors rarityWeight(). */
export const RARITY_WEIGHT = [1n, 8n, 64n, 512n, 4_096n];

/** Per-hunt cost in wei, by tool tier. Mirrors huntCostWei(). */
// 0.0001 ether = 1e14 wei. These were 1e13 -- 10x too cheap. See the note in
// tools.js huntCostWei(); the same mistake appeared in both files.
export const HUNT_COST = [
  100_000_000_000_000n, // tier 1  0.0001
  200_000_000_000_000n, // tier 2  0.0002
  400_000_000_000_000n, // tier 3  0.0004
  800_000_000_000_000n, // tier 4  0.0008
];

export const SEASON_LENGTH_SEC = 14 * 24 * 60 * 60;

/**
 * Minimum ETH that counts toward the ROI denominator.
 *
 * Spec: "Minimum splay floor (0.005 ETH). Without it, a player who makes one
 * lucky hunt and quits posts a perfect ratio on a tiny denominator and tops
 * the board." Roughly one mid-tier tool.
 */
// 0.005 ETH. ETH is 10^18 wei, so this is 5 * 10^15 -- NOT 5 * 10^12. An
// earlier version had it 1000x too small, which made the floor lower than a
// single tier-1 hunt and therefore never fired: every player, including the
// one-lucky-hunt-and-quit case the floor exists to stop, was scored on raw
// spend. The season test caught it.
export const SPLAY_FLOOR_WEI = 5_000_000_000_000_000n; // 0.005 ETH

export const TOP_N = 10;

// --- scoring -----------------------------------------------------------

/**
 * A blank season record.
 */
export function newSeasonRecord(id, nowSec) {
  return {
    id,
    startsAt: nowSec,
    endsAt: nowSec + SEASON_LENGTH_SEC,
    committed: false,
    // per-player
    players: new Map(), // address(lowercase) -> entry
  };
}

function entryFor(board, address) {
  const key = String(address).toLowerCase();
  let e = board.players.get(key);
  if (!e) {
    e = {
      address: key,
      leq: 0n,        // rarity-weight earned -- ROI numerator
      ethSpent: 0n,   // raw spend, before the splay floor
      bestWei: 0n,    // best single find
      hunts: 0,
      gems: [0, 0, 0, 0, 0],
      finalized: false,
    };
    board.players.set(key, e);
  }
  return e;
}

/**
 * Record a settled hunt.
 * @param board    the season board (mutated)
 * @param address  player address
 * @param counts   array of 5 gem counts by rarity, from the hunt engine
 * @param toolTier 1..4, which sets the per-hunt ETH cost
 * @param nowSec   current time, to reject late hunts
 */
export function recordHunt(board, address, counts, toolTier, nowSec) {
  // A hunt that lands after the season closed does not count. Without this a
  // player could bank a lucky roll at the buzzer.
  if (nowSec >= board.endsAt) return { ok: false, reason: 'season has ended' };
  if (toolTier < 1 || toolTier > 4) return { ok: false, reason: 'bad tool tier' };

  const e = entryFor(board, address);

  let valueWei = 0n;
  let leqGain = 0n;
  for (let r = 0; r < 5; r++) {
    const n = counts[r] || 0;
    if (n <= 0) continue;
    e.gems[r] += n;
    valueWei += GEM_PRICE[r] * BigInt(n);
    leqGain += RARITY_WEIGHT[r] * BigInt(n);
  }

  e.leq += leqGain;
  e.ethSpent += HUNT_COST[toolTier - 1];
  e.hunts += 1;
  if (valueWei > e.bestWei) e.bestWei = valueWei;

  board.seasonBest = (board.seasonBest ?? 0n);
  if (valueWei > board.seasonBest) board.seasonBest = valueWei;

  return { ok: true, valueWei, leqGain, entry: e };
}

/**
 * ROI for one player, with the splay floor applied.
 *
 * The floor is the design: a player who has spent less than 0.005 ETH has
 * their spend rounded UP to it. That is deliberately harsh to the one-lucky-
 * hunt-and-quit strategy, and it is the reason a 0.0001 ETH player cannot
 * post a 10x ROI.
 */
/**
 * ROI = rarity-weight earned / ETH spent, with the splay floor on the
 * denominator. Raw that is ~1e-13, so any BigInt division of it is either 0
 * or badly quantised.
 *
 * Quantising was tried first and is WRONG, in a way that matters: two players
 * with mathematically identical ratios scored 600 and 696 -- a 16% spread
 * caused purely by where the integer division truncated. That breaks the
 * SPEC's central promise (a whale and a small player playing identically
 * must tie), and it silently advantages whoever's numbers happen to divide
 * evenly. src/season.test.mjs asserts the tie and caught it.
 *
 * So the score is a CROSS-MULTIPLIED rational, (leq * K) / denom, compared
 * with compareRoi rather than by dividing. Equal ratios then compare equal
 * exactly, for any K. K only has to be large enough that the quotient is
 * still a meaningful integer for display.
 */
/**
 * Wei per ETH. This is NOT a display scale -- it is the unit conversion that
 * makes the score read as "rarity-weight per ETH":
 *
 *   leq / (denom_wei / 1e18)  ==  leq * 1e18 / denom_wei
 *
 * so roiOf() is ALREADY unscaled and callers must not divide again. (Getting
 * this wrong was not hypothetical: the score read 1e18 times too small until
 * the name made the units obvious.)
 */
export const WEI_PER_ETH = 1_000_000_000_000_000_000n;

/**
 * TRUE if this player qualifies for the board at all.
 *
 * Mirrors DeepWood.sol: `roi()` returns 0 and `onRoiBoard()` returns false
 * below MIN_SPLAY. The contract excludes sub-floor players; the client must
 * agree or the preview ranks people the chain will refuse to rank.
 */
export function onRoiBoard(entry) {
  return entry.ethSpent >= SPLAY_FLOOR_WEI;
}

/**
 * The denominator: raw spend. No flooring.
 *
 * An earlier version RAISED sub-floor spend to the floor instead of
 * excluding the player. That is measurably wrong: a one-diamond-hunt player
 * who spent 0.0001 ETH scored 819,200 against 40,000 for a diligent player
 * who spent the full 0.005 ETH -- i.e. flooring handed the top of the board
 * to exactly the lucky-and-quit strategy the floor exists to stop. Exclusion
 * is what the contract does, and it is the policy that works.
 */
export function roiDenom(entry) {
  return entry.ethSpent;
}

/**
 * ROI in rarity-weight per ETH, as an integer.
 *
 * DISPLAY ONLY. Two players with equal ratios can differ in the last digit
 * here because of integer truncation -- use compareRoi() for ordering, which
 * is exact.
 */
export function roiOf(entry) {
  return (entry.leq * WEI_PER_ETH) / roiDenom(entry);
}

/**
 * The score used for ordering. Sub-floor players score 0, matching the
 * contract's roi(), and rank() drops them via eligible().
 */
export function boardScore(entry) {
  return onRoiBoard(entry) ? roiOf(entry) : 0n;
}

/**
 * Exact comparison of two ROI ratios by cross-multiplication.
 * Returns >0 if a ranks above b, <0 if below, 0 if they are exactly tied.
 *
 * a.leq / a.denom  vs  b.leq / b.denom   <=>   a.leq * b.denom  vs  b.leq * a.denom
 * No division, so no truncation, so equal ratios are exactly equal.
 */
export function compareRoi(a, b) {
  // Sub-floor players compare as zero, exactly as the contract's roi() does.
  if (!onRoiBoard(a) && !onRoiBoard(b)) return 0;
  if (!onRoiBoard(a)) return -1;
  if (!onRoiBoard(b)) return 1;
  const l = a.leq * roiDenom(b);
  const r = b.leq * roiDenom(a);
  return l > r ? 1 : l < r ? -1 : 0;
}

/** ROI as a plain number, for display and formatting. */
export function roiFloat(entry) {
  return Number(roiOf(entry));
}

/**
 * The ranked board.
 *
 * Sort: ROI desc, then best find desc, then legendary-equivalents desc. The
 * ties are the SPEC's secondary and tertiary metrics, applied in order.
 */
export function rank(board) {
  // Only players who cleared the splay floor are ranked -- the same set the
  // contract will consider. Unqualified players are not ranked, and saying
  // so is more honest than showing them at the bottom of a table they are
  // not on.
  const rows = [...board.players.values()].filter((e) => e.hunts > 0 && onRoiBoard(e));
  rows.sort((a, b) => {
    if (a.finalized !== b.finalized) return a.finalized ? -1 : 1; // pinned first
    // compareRoi, NOT roiOf(b) - roiOf(a). Those are truncated fixed-point
    // values, and subtracting them ranks identical play differently.
    const r = compareRoi(b, a);
    if (r !== 0) return r;
    if (b.bestWei !== a.bestWei) return b.bestWei > a.bestWei ? 1 : -1;
    if (b.leq !== a.leq) return b.leq > a.leq ? 1 : -1;
    return a.address < b.address ? -1 : 1; // stable, deterministic
  });
  return rows.map((e, i) => ({ ...e, rank: i + 1, roi: roiOf(e) }));
}

export function topN(board, n = TOP_N) {
  return rank(board).slice(0, n);
}

/**
 * What a player still needs to qualify, in wei. 0 if already on the board.
 * Shown in the UI so a sub-floor player knows the target rather than just
 * seeing themselves missing.
 */
export function shortOfFloor(entry) {
  const short = SPLAY_FLOOR_WEI - entry.ethSpent;
  return short > 0n ? short : 0n;
}

/** Where does this player sit, and how far to the next rank up? */
export function standing(board, address) {
  const rows = rank(board);
  const key = String(address).toLowerCase();
  const i = rows.findIndex((r) => r.address === key);
  if (i < 0) return { ranked: false };
  const above = i > 0 ? rows[i - 1] : null;
  const shortfall = above ? (above.leq * 1_000_000n) / SPLAY_FLOOR_WEI - rows[i].roi : 0n;
  return {
    ranked: true,
    rank: rows[i].rank,
    of: rows.length,
    inTopTen: rows[i].rank <= TOP_N,
    needsToPass: above ? above.address : null,
  };
}

// --- formatting --------------------------------------------------------

export const eth = (wei) => `${(Number(wei) / 1e18).toFixed(5)} ETH`;
export const fmt = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
};

/**
 * ROI as a short display string.
 *
 * The raw value is legitimately large -- a player who spends 1 ETH for
 * 87,970 rarity-weight has an 87,970x ROI, and that is the number the metric
 * is supposed to report. Printing it in full overflows the column, so large
 * values abbreviate: "87,970x" -> "88.0Kx". Small values keep two decimals
 * because below ~10 the difference between 0.5x and 0.6x is the whole story.
 */
export function roiPct(entry) {
  const v = roiFloat(entry);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}Mx`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}Kx`;
  if (v >= 1000) return `${v.toFixed(0)}x`;
  if (v >= 10) return `${v.toFixed(1)}x`;
  return `${v.toFixed(2)}x`;
}

/** Countdown text for the season clock. */
export function seasonClock(board, nowSec) {
  const left = Math.max(0, board.endsAt - nowSec);
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}
