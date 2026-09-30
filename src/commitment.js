/**
 * Commit-then-act, and season rollover.
 *
 * Two problems this solves, both from SPEC section 9:
 *
 *   1. COMMIT-THEN-ACT. The engine commits a merkle root covering every
 *      (player, huntIndex) leaf it will later settle, BEFORE any hunt. It
 *      then cannot rewrite the season after players have seen results, and
 *      cannot inflate one player's haul without re-deriving the whole root.
 *
 *   2. SEASON ROLLOVER. finalizeSeason() is permissionless: anyone may call
 *      it after endsAt, and it starts the next 14-day season. The client
 *      mirrors the clock so the board resets rather than accumulating
 *      forever.
 *
 * This is the CLIENT half. It computes the same root as the server engine
 * (script/hunt-engine.mjs) so a player can verify a commitment without
 * trusting the operator. Parity between the two is asserted in tests.
 *
 * NOTE ON WHAT COMMIT-THEN-ACT DOES NOT BUY: the engine can still refuse to
 * call settleHunt. That is a liveness failure, not a safety one, and it is
 * documented in SPEC rather than papered over.
 */

// --- hashing ------------------------------------------------------------
//
// keccak256, matching DeepWood.sol and the server engine. Web Crypto exposes
// SHA-2 only, so this uses js-sha3, which is what the engine uses too -- using
// a different implementation on the client would make every commitment
// unverifiable, which defeats the point.

/**
 * Hash an arbitrary byte array with keccak256.
 *
 * The injected impl (js-sha3) returns a HEX STRING, not bytes. Everything
 * downstream here -- concat, hashPair, merkleRoot -- assumes Uint8Array, so
 * the conversion happens once, at this boundary. Miss it and the merkle tree
 * silently hashes ASCII hex characters instead of hashes: still deterministic,
 * still 32 "bytes", completely wrong, and it would never match the server.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 32 bytes
 */
export function keccak(bytes) {
  const hex = keccakImpl(bytes);
  if (typeof hex === 'string') {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  return Uint8Array.from(hex);
}

let keccakImpl = null;

/** Injected by initCommitment() -- keeps the import lazy. */
export function initCommitment(impl) {
  keccakImpl = impl;
}

// --- leaf encoding -----------------------------------------------------

/** A bigint as a 32-byte little-endian-free big-endian buffer. */
function to32(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('to32: negative');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function utf8(str) {
  return new TextEncoder().encode(str);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function toHex(bytes) {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * The merkle leaf for one (seed, player, huntIndex).
 * Mirrors leafFor() in the server engine.
 */
export function leafFor(seed, player, huntIndex) {
  return keccak(concat(
    to32(seed),
    utf8(String(player).toLowerCase()),
    to32(huntIndex),
  ));
}

/**
 * Hash a sibling pair.
 *
 * SORTED, matching the server engine (and the OpenZeppelin convention). The
 * sort makes the tree order-independent: the same two hashes hash the same
 * way regardless of which side of the parent they sit on. The first client
 * version hashed positionally and produced a different root for every season
 * -- still deterministic, still 32 bytes, entirely wrong, and it would have
 * made every commitment look fraudulent to a player verifying it.
 */
function hashPair(a, b) {
  return compareBytes(a, b) <= 0 ? keccak(concat(a, b)) : keccak(concat(b, a));
}

/** Lexicographic byte comparison. Returns <0, 0, >0 like Buffer.compare. */
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Merkle root over leaves. Odd nodes are promoted unchanged (no duplication),
 * which must match the engine exactly or roots diverge.
 */
export function merkleRoot(leaves) {
  if (!leaves.length) return new Uint8Array(32);
  let level = leaves.map((l) => Uint8Array.from(l));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

// --- commitment --------------------------------------------------------

/**
 * Build the season commitment.
 *
 * @param seed       season seed (hex string or BigInt)
 * @param plan       [{player, hunts}] -- every player and how many hunts
 *                   they are expected to make
 * @returns {{root: string, leafCount: number, leaves: string[]}}
 */
export function commitSeason(seed, plan) {
  const seedNum = typeof seed === 'string' ? BigInt(seed) : BigInt(seed);
  const leaves = [];
  for (const { player, hunts } of plan) {
    for (let i = 0; i < hunts; i++) leaves.push(leafFor(seedNum, player, i));
  }
  return {
    root: toHex(merkleRoot(leaves)),
    leafCount: leaves.length,
    leaves: leaves.map(toHex),
  };
}

/**
 * Recompute the root and compare against what was committed on-chain.
 * This is the player-side check: it does not trust the operator's claim.
 */
export function verifySeason(seed, plan, committedRoot) {
  const { root, leafCount } = commitSeason(seed, plan);
  return {
    ok: root.toLowerCase() === String(committedRoot).toLowerCase(),
    recomputed: root,
    committed: committedRoot,
    leafCount,
  };
}

// --- season state machine ----------------------------------------------

export const SEASON_LENGTH_SEC = 14 * 24 * 60 * 60;

/**
 * The season lifecycle the contract enforces.
 *
 *   committed=false -> hunts revert with NotCommitted
 *   committed=true  -> hunts settle
 *   now >= endsAt   -> finalizeSeason() is callable, rolls to id+1
 *
 * finalizeSeason() is permissionless, so the rollover is not gated on a
 * trusted role -- anyone can trigger it once the clock expires.
 */
export function seasonState(board, nowSec) {
  return {
    id: board.id,
    committed: board.committed,
    canCommit: !board.committed,
    ended: nowSec >= board.endsAt,
    canFinalize: nowSec >= board.endsAt,
    startsAt: board.startsAt,
    endsAt: board.endsAt,
  };
}

/**
 * Advance a board past its end: mark finalized and start the next season.
 * The new season is UNCOMMITTED, so hunts revert until the root is published.
 *
 * Returns a NEW board object -- the old one is kept so a player can still
 * verify the season they just finished.
 */
export function rollSeason(board, nowSec) {
  if (nowSec < board.endsAt) {
    return { ok: false, reason: 'season has not ended' };
  }
  const next = {
    id: board.id + 1,
    startsAt: board.endsAt, // the contract stamps start from the prior end
    endsAt: board.endsAt + SEASON_LENGTH_SEC,
    committed: false,
    players: new Map(),
    seasonBest: 0n,
    // carry the finished season for post-hoc verification
    previous: {
      id: board.id,
      startsAt: board.startsAt,
      endsAt: board.endsAt,
      committed: board.committed,
      root: board.commitRoot ?? null,
      players: board.players,
    },
  };
  return { ok: true, board: next };
}

export const toHexBytes = toHex;
export const to32Bytes = to32;
