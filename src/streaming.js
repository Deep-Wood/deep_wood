// Chunk streaming for the endless forest.
//
// Split out of ForestScene so it can be reasoned about (and unit-tested) on
// its own. The scene owns Phaser objects; this owns the decision of WHICH
// chunks should exist and WHAT goes in them.
//
// The one rule that makes an unbounded world work without a server: a chunk's
// contents are a pure function of (seasonSeed, cx, cy). Nothing here reads
// load order, player history, or wall-clock time. Stream a chunk in, walk away
// and come back, and it is byte-identical -- which is also why a new season
// seed reshuffles the entire world without invalidating anything.

import {
  CHUNK, chunkOf, describeChunk, nodeKey, seedToUint32,
} from './chunks.js';

/** Chunks kept loaded around the player, in each direction. 1 = 3x3. */
export const LOAD_RADIUS = 1;

/**
 * Which chunk keys should be resident for a player at (x, y).
 * A ring of radius R+1 is retained so walking in one direction does not
 * thrash: chunks are destroyed only once they are two steps outside.
 */
export function residentChunks(x, y, radius = LOAD_RADIUS) {
  const [cx, cy] = chunkOf(x, y);
  const out = new Map(); // key -> [cx, cy]
  const keep = radius + 1;
  for (let dx = -keep; dx <= keep; dx++) {
    for (let dy = -keep; dy <= keep; dy++) {
      const k = `${cx + dx},${cy + dy}`;
      out.set(k, [cx + dx, cy + dy]);
    }
  }
  return out;
}

/** Keys currently resident that are no longer wanted. */
export function staleChunks(loadedKeys, wantedKeys) {
  const out = [];
  for (const k of loadedKeys) if (!wantedKeys.has(k)) out.push(k);
  return out;
}

/**
 * Depletion bookkeeping, persisted locally.
 *
 * A dug node does not stay dug: it comes back at a different spot, because a
 * node that returned in place would let a player camp one tile forever and the
 * efficiency leaderboard would measure nothing.
 *
 * `epoch` counts digs. chunk cx,cy node idx at epoch 0 is one node; at epoch 1
 * it is a DIFFERENT node (see describeChunk's epoch parameter), so the map
 * does not have to be rebuilt in place -- the player walks over and finds
 * fresh treasure elsewhere in the same chunk.
 *
 * Keyed by season seed: a new season is a new forest, so old depletion must
 * not carry over.
 */
const STORE_KEY = 'deepwood.depletion.v1';

export function depletionStore(seedHex) {
  const key = seedToUint32(seedHex);
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch { /* private mode */ }
  let parsed = {};
  if (raw) { try { parsed = JSON.parse(raw) || {}; } catch { parsed = {}; } }
  return parsed[key] || {};
}

export function saveDepletion(seedHex, map) {
  const key = seedToUint32(seedHex);
  let all = {};
  try { all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { all = {}; }
  all[key] = map;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // Quota or private mode. Not fatal -- depletion is a convenience for the
    // player's own session, not authoritative state. Settlement does not read it.
  }
}

/**
 * How many digs this chunk's node idx has had, which selects its epoch.
 * Returns the epoch to GENERATE at. A node that has been dug n times renders
 * at epoch n and is dug into epoch n+1.
 */
export function epochFor(depleted, cx, cy, idx) {
  const k = nodeKey(cx, cy, idx, 0);
  const n = depleted[k] | 0;
  return n;
}

/**
 * True once a chunk's site has been dug OUT ENTIRELY.
 *
 * This is what makes beacons scarce. The epoch counter alone does the opposite
 * of what a player wants: digging bumped the epoch, `completeNodeDig()` rebuilt
 * the chunk, and `describeChunk(..., epoch+1)` produced a site at a NEW random
 * position -- so claiming one made another appear right where you were standing.
 * That reads as the forest spawning extra treasure rather than being consumed.
 *
 * So a dug site stays dug. The epoch still advances (the world keeps its
 * bookkeeping) but it is capped: once `RESPAWN_AFTER_EPOCHS` digs have happened
 * at this site, the site is retired for good and the chunk renders with NO beacon
 * until the player walks far enough that a new chunk generates.
 *
 * The cap is what stops the world from becoming literally unplayable: the forest
 * is effectively unbounded, so retiring a site costs the player one beacon in
 * one chunk rather than ending the hunt. A long enough walk always finds new
 * ground.
 */
export const RESPAWN_AFTER_EPOCHS = 1;

/**
 * Has this chunk's single site been dug past the respawn allowance?
 *
 * The epoch is the count of digs that site has taken: `markNodeDug` increments
 * it BEFORE the chunk is rebuilt, so a chunk rebuilt after its first dig loads
 * with epoch 1. "Dug once" therefore means epoch >= 1, and with
 * RESPAWN_AFTER_EPOCHS = 1 the site is spent from then on.
 *
 * The key MUST come from `nodeKey()`, which formats `${cx}:${cy}:${idx}:${epoch}`
 * with COLONS. An earlier version inlined `` `${cx},${cy},0,0` `` with COMMAS,
 * which matched nothing -- every lookup missed, `isChunkSpent` was always
 * false, and beacons respawned exactly as before while the code looked correct.
 * Never hand-build this key.
 */
export function isChunkSpent(depleted, cx, cy) {
  const digs = depleted[nodeKey(cx, cy, 0, 0)] | 0;
  return digs >= RESPAWN_AFTER_EPOCHS;
}

export { CHUNK, chunkOf, describeChunk, nodeKey };