/**
 * The pending-hunt queue: the client-side half of batch settlement.
 *
 * WHY THIS EXISTS
 * ===============
 * A connected dig used to settle on-chain IMMEDIATELY: every swing of the
 * pick popped the wallet. The user's requirement is the opposite -- a hunt
 * may NEVER trigger a transaction on its own. The only write the game fires
 * unprompted is none; the SETTLE button is the single door to the wallet.
 *
 * HOW IT STAYS HONEST
 * ===================
 * The results are not invented locally. V5 read the roll for hunt
 * `base + offset` from the contract's `previewHuntAt`. V6 has NO offset
 * variant -- `previewHunt(player, tier)` rolls at the chain's CURRENT hunt
 * index only. So the first dig of a session previews from the chain, and
 * each subsequent dig's roll is computed LOCALLY with the same keccak
 * formula the contract uses at settle time (engine.js rollHunt, verified
 * byte-exact against the chain's previewHunt at hunt index 0). The chain
 * seed is read once per session from `seasonSeed()` and the result is
 * recomputed against it, so the queue holds chain-authorized results for
 * hunt indexes [base, base+n). If anything settles underneath us (another
 * tab, another device), the base moves and the whole queue is stale --
 * settleBatch reverts atomically, and `stale()` is what lets the UI SAY so
 * instead of failing blind.
 *
 * WHAT LOSES DATA (BY DESIGN, SIGNED OFF)
 * =======================================
 * The queue lives in memory. A reload or close with hunts queued drops
 * them: the gems were never on-chain, so they never existed. The UI warns
 * before unload. This is the user-accepted trade: sign once per session,
 * never per dig.
 */

/** Cap from the contract (MAX_BATCH); read once at boot, defaults to 20. */
export const MAX_BATCH = 20;

/**
 * The queue. One entry per QUEUED (dug-but-unsettled) hunt:
 *   { counts: bigint[5], bestSingleWei: bigint }
 * plus `base`, the chain hunt index the first entry corresponds to.
 *
 * bestSingleWei is BACK because the live V6 contract still requires it:
 * settleBatch reverts ResultMismatch unless bestWei[k] equals the
 * expected best for that hunt (priceOf(rolled rarity)). The migration
 * that dropped it read "V6 removed bestSingleWei from previewHunt" as
 * "the contract ignores bestWei" -- the contract does NOT ignore bestWei;
 * it still validates it against its own recompute.
 */
export class HuntQueue {
  constructor(huntIndex = 0n, tier = 0) {
    this.entries = [];
    this.base = BigInt(huntIndex);
    this.tier = tier;
  }

  /** Chain hunt index the next queued hunt will settle at. */
  get nextIndex() {
    return this.base + BigInt(this.entries.length);
  }

  get size() {
    return this.entries.length;
  }

  get empty() {
    return this.entries.length === 0;
  }

  /**
   * Reset the base from the chain. Called at boot, on connect, and after any
   * successful settle -- anything that could have moved huntIndexOf.
   *
   * A loaded queue survives ONLY when the chain index still equals the queue's
   * base: the queued hunts are for indexes base..base+n-1, and an unchanged
   * base means every one of them is still upcoming. A moved index means some
   * of them were settled elsewhere -- the whole queue is dead, so it drops.
   * This matches stale(), which also compares against base.
   */
  rebase(huntIndex, tier) {
    if (this.entries.length > 0 && BigInt(huntIndex) !== this.base) {
      this.entries = [];
    }
    this.base = BigInt(huntIndex);
    this.tier = tier;
  }

  /**
   * Queue one hunt's chain-authorized result.
   * @returns {boolean} false if the queue is full or the tier changed mid-run
   */
  push(counts, bestSingleWei = 0n) {
    if (this.entries.length >= MAX_BATCH) return false;
    this.entries.push({ counts, bestSingleWei: BigInt(bestSingleWei) });
    return true;
  }

  /**
   * The argument shape wallet.settleBatch wants: two parallel arrays in dig
   * order -- the counts AND the per-hunt bestSingleWei the contract still
   * validates (ResultMismatch on any difference). Copies out so the caller
   * can clear without aliasing.
   */
  toCalldata() {
    return {
      batch: this.entries.map((e) => e.counts),
      bests: this.entries.map((e) => e.bestSingleWei),
    };
  }

  clear() {
    this.entries = [];
  }

  /**
   * Would settleBatch accept this queue right now? True when the chain's
   * hunt index still equals the base -- i.e. nothing settled underneath us.
   * Cheap enough to check before prompting the wallet; the contract re-checks
   * authoritatively on settle.
   */
  stale(chainHuntIndex) {
    return this.entries.length > 0 && BigInt(chainHuntIndex) !== this.base;
  }
}
