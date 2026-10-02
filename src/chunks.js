// Endless forest: deterministic chunk generation.
//
// The world used to be a fixed 40x30 tiles (1280x960) with 96 trees, 220 props
// and 24 dig nodes placed once in create(). The character walked into an
// invisible wall at the edge. This module replaces the whole-world placement
// with an unbounded, streamed one.
//
// DETERMINISM IS THE POINT, not a convenience. A chunk's contents must depend
// on nothing but (seasonSeed, cx, cy) -- never on load order, on how far the
// player has walked, or on when the chunk was generated. Two consequences, and
// both are the reason this exists:
//
//   1. Every player gets the identical forest, with no server and no stored
//      world state. The client already trusts a committed season seed for
//      settlement; deriving layout from that same seed makes the MAP part of
//      the fairness guarantee instead of a decoration sitting beside it.
//   2. A new season reshuffles everything, because a new seed re-hashes every
//      chunk. Nothing has to be invalidated -- there is nothing to invalidate.
//
// This file is pure: no Phaser, no scene, no DOM. That is deliberate -- the
// determinism property is the risky part and it must be testable without a
// browser.
//
//   node --test src/chunks.test.mjs

/** Chunk edge in pixels. 512 = 16 world tiles. */
export const CHUNK = 512;

/** Per-chunk density. Tuned so a 3x3 loaded ring reads as forest, not park. */
export const TREES_PER_CHUNK = 7;
export const PROPS_PER_CHUNK = 26;
// One dig site per 512px chunk. Was 3, which with LOAD_RADIUS 1 put ~27 sites
// on screen -- the forest read as littered rather than hunted, and a find cost
// a few steps instead of a walk. At 1 it is ~9 visible, so travelling between
// beacons is the cost of a gem.
//
// Placement maths is untouched (same seeded stream, same rejection sampling
// against trees and other nodes), and settlement never depended on density:
// `rollHunt` keys off huntIndex, not location. This changes the RATE of earning
// and nothing about determinism.
export const NODES_PER_CHUNK = 1;
// Decoration per chunk. These do not affect gameplay or settlement, so they can
// be tuned freely; changing them does NOT break the seed guarantee because
// nothing about a hunt depends on where a fern is.
export const UNDERGROWTH_PER_CHUNK = 34;
// Attempts, not results -- rejection sampling against tree proximity discards
// most of them, so the resident count lands well below these. Kept modest on
// purpose: every one of these is a real sprite in a scene that already carries
// ~1850 of them.
export const MUSHROOMS_PER_CHUNK = 26;
export const CRYSTALS_PER_CHUNK = 4;

// Spawn is deliberately kept clear in the origin chunk only. Everywhere else
// the forest is dense, because "open clearing at 0,0" in every chunk would read
// as tiled rather than endless.
const SPAWN_CLEAR_R = 150;

/**
 * Mix (seed, cx, cy) into a uint32.
 *
 * FNV-1a over a byte stream. Negative chunk coords are folded through a
 * two's-complement uint32 so walking west gives different chunks than walking
 * east -- without that, chunks at -1 and +1 would collide.
 */
export function chunkSeed(seedHex, cx, cy) {
  const base = seedToUint32(seedHex);
  let h = base >>> 0;
  // Fold coordinates in as 4 bytes each, big-endian.
  const bytes = [
    cx & 0xff, (cx >>> 8) & 0xff, (cx >>> 16) & 0xff, (cx >>> 24) & 0xff,
    cy & 0xff, (cy >>> 8) & 0xff, (cy >>> 16) & 0xff, (cy >>> 24) & 0xff,
  ];
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Final avalanche, or chunks differing by one coordinate have visibly
  // correlated first draws (FNV alone has weak low-bit diffusion).
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Accepts '0xbb39…' (the on-chain season seed) or a number. */
export function seedToUint32(seedHex) {
  if (typeof seedHex === 'number') return seedHex >>> 0;
  const s = String(seedHex || '');
  // Take the LAST 8 hex chars. The season seed is bytes32; the low 4 bytes are
  // as good as any for layout, and using a fixed slice keeps JS and any
  // reimplementation in agreement.
  const hex = s.replace(/^0x/i, '').slice(-8);
  if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) return 0;
  return parseInt(hex, 16) >>> 0;
}

/** mulberry32 -- small, fast, good enough, and identical across engines. */
function makeRng(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chunk coordinates containing a world point. Floor, so negative works. */
export function chunkOf(x, y) {
  return [Math.floor(x / CHUNK), Math.floor(y / CHUNK)];
}

/**
 * Layout of one chunk.
 *
 * `epoch` is what makes a dug node respawn somewhere new: pass 0 for the
 * original layout and 1,2,3... after each dig. It re-rolls only the node
 * positions, so a chunk's trees never move under the player while they are
 * watching, but the node they just emptied does relocate.
 *
 * All coordinates are WORLD pixels, so the scene places them directly.
 */
export function describeChunk(seedHex, cx, cy, epoch = 0) {
  const ox = cx * CHUNK, oy = cy * CHUNK;
  const isOrigin = cx === 0 && cy === 0;

  // --- trees: a separate stream from props/nodes so that adding a prop never
  // reshuffles the trees (which would move colliders out from under a player).
  const rTrees = makeRng(chunkSeed(seedHex, cx, cy) ^ 0x9e3779b9);
  const trees = [];
  const taken = [];
  for (let i = 0; i < TREES_PER_CHUNK; i++) {
    const x = ox + Math.floor(rTrees() * (CHUNK / 32)) * 32 + 16;
    const y = oy + Math.floor(rTrees() * (CHUNK / 32)) * 32 + 16;
    if (isOrigin && Math.hypot(x, y) < SPAWN_CLEAR_R) continue;
    // keep trunks from stacking into an impassable clump
    if (taken.some((t) => Math.hypot(t.x - x, t.y - y) < 52)) continue;
    taken.push({ x, y });
    trees.push({ x, y, v: Math.floor(rTrees() * 4) });
  }

  // Nodes yield to trees, NOT the other way round.
  //
  // A tree on a node makes the node unhuntable, so they must be kept apart --
  // but the original fixed world solved that by dropping the tree, and here
  // that is wrong. The node set changes every epoch (that is the respawn), so
  // dropping trees would pop trunk colliders in and out of existence under a
  // player who is standing there watching, and the test "trees must not move
  // under a watching player" caught exactly that.
  //
  // So: trees are authoritative and epoch-independent, and a node candidate
  // that lands too near one is rejected instead. Colliders are therefore
  // stable for the lifetime of the chunk.
  const rNodes = makeRng(chunkSeed(seedHex, cx, cy) ^ (0x51ed270b + epoch * 0x9e3779b9));
  const nodes = [];
  // Retry budget per site. With NODES_PER_CHUNK = 1 a single rejection left the
  // chunk with NO beacon at all -- and because the same seed reproduces it,
  // that chunk was permanently unhuntable at every epoch. Measured before this
  // fix: chunk(1,1) produced 0 nodes at epoch 0 AND at epoch 5, and chunk(2,2)
  // had one site at epoch 0 and none at epoch 5, i.e. digging emptied it forever.
  // So a site now RETRIES against a fresh draw rather than giving up, and the
  // loop always runs NODES_PER_CHUNK times.
  const NODE_ATTEMPTS = 24;
  for (let i = 0; i < NODES_PER_CHUNK; i++) {
    for (let a = 0; a < NODE_ATTEMPTS; a++) {
      const x = ox + 64 + rNodes() * (CHUNK - 128);
      const y = oy + 64 + rNodes() * (CHUNK - 128);
      if (nodes.some((n) => Math.hypot(n.x - x, n.y - y) < 70)) continue;
      if (trees.some((t) => Math.hypot(t.x - x, t.y - y) < 64)) continue;
      nodes.push({ x: Math.round(x), y: Math.round(y), idx: i, epoch });
      break;
    }
  }

  // --- props: pure decoration, separate stream, cheap.
  const rProps = makeRng(chunkSeed(seedHex, cx, cy) ^ 0x2545f491);
  const props = [];
  for (let i = 0; i < PROPS_PER_CHUNK; i++) {
    props.push({
      x: ox + rProps() * CHUNK,
      y: oy + rProps() * CHUNK,
      k: Math.floor(rProps() * 4),
    });
  }

  // --- ambience layers. All of these are derived from the trees above rather
  // than from their own independent random stream, because a forest reads as
  // living because things gather AROUND its trees: shade collects under a
  // canopy, undergrowth crowds a trunk, and clearings stay bare. Scattering
  // these uniformly is what makes procedural forests look like a sprinkled
  // texture instead of a place.
  //
  // Tree positions are epoch-independent, so all of this is too -- a dig cannot
  // make the undergrowth rearrange itself under the player's feet.

  // Ground shadows anchor each tree and give it weight against the flat grass.
  // Derived, not random: one per tree, offset toward the light.
  const shadows = trees.map((t) => ({ x: t.x + 9, y: t.y - 2, r: t.v }));

  // Canopy sits ABOVE the player in the draw order rather than y-sorted with the
  // trees, so walking north passes under the leaves instead of behind them.
  const rCanopy = makeRng(chunkSeed(seedHex, cx, cy) ^ 0x7f4a7c15);
  const canopy = [];
  for (const t of trees) {
    // One big blob per tree plus an occasional spill between two of them.
    canopy.push({ x: t.x - 6 + rCanopy() * 12, y: t.y - 46 - rCanopy() * 22, s: 0.9 + rCanopy() * 0.5 });
    if (rCanopy() < 0.45) {
      canopy.push({ x: t.x + 40 + rCanopy() * 30, y: t.y - 30 - rCanopy() * 26, s: 0.6 + rCanopy() * 0.4 });
    }
  }

  // Undergrowth: density falls off with distance to the nearest tree, so tufts
  // crowd trunks and the open ground between stands stays bare. Rejection
  // sampling against a distance function rather than its own RNG -- otherwise
  // it would be uniform scatter wearing a costume.
  const rUnder = makeRng(chunkSeed(seedHex, cx, cy) ^ 0x1b873593);
  const undergrowth = [];
  for (let i = 0; i < UNDERGROWTH_PER_CHUNK; i++) {
    const x = ox + rUnder() * CHUNK;
    const y = oy + rUnder() * CHUNK;
    // shade(t) = 1 at a trunk, ~0 by 150px away
    let shade = 0;
    for (const t of trees) {
      const d = Math.hypot(t.x - x, t.y - y);
      const s = Math.max(0, 1 - d / 150);
      if (s > shade) shade = s;
    }
    // accept more readily the shadier it is; 15% of open ground still gets a
    // tuft so the clearing is not sterile
    if (rUnder() > 0.15 + shade * 0.85) continue;
    undergrowth.push({ x: Math.round(x), y: Math.round(y), k: Math.floor(rUnder() * 3), shade });
  }

  // --- bioluminescent life -------------------------------------------------
  // The emblem's mushrooms are the scene's light source, so where they appear
  // matters more than it would for inert decoration. Same rule as undergrowth:
  // they want shade and damp, so they cluster against trunks and thin out in
  // the open. Scattered uniformly they read as stickers on the grass.
  //
  // They are DETERMINISTIC, unlike the drifting ambience. Two players walking
  // the same chunk see the same mushrooms in the same places, which is what
  // makes the forest feel like a place rather than a screensaver.
  const rShroom = makeRng(chunkSeed(seedHex, cx, cy) ^ 0x27d4eb2f);
  const mushrooms = [];
  for (let i = 0; i < MUSHROOMS_PER_CHUNK; i++) {
    const x = ox + rShroom() * CHUNK;
    const y = oy + rShroom() * CHUNK;
    let shade = 0;
    for (const t of trees) {
      const s = Math.max(0, 1 - Math.hypot(t.x - x, t.y - y) / 110);
      if (s > shade) shade = s;
    }
    if (rShroom() > 0.10 + shade * 0.90) continue;
    mushrooms.push({
      x: Math.round(x), y: Math.round(y),
      k: Math.floor(rShroom() * 3),
      s: 0.75 + rShroom() * 0.6,
      // only the larger caps glow, so a patch has a few real lights in it
      glow: rShroom() < 0.45,
    });
  }

  // Crystals are rarer and want to be more exposed than mushrooms do -- they are
  // the emblem's anchor, and something that glows is worth seeing from a
  // distance. Placed in clearings rather than under trunks.
  const rCrystal = makeRng(chunkSeed(seedHex, cx, cy) ^ 0x165667b1);
  const crystals = [];
  for (let i = 0; i < CRYSTALS_PER_CHUNK; i++) {
    const x = ox + rCrystal() * CHUNK;
    const y = oy + rCrystal() * CHUNK;
    let shade = 0;
    for (const t of trees) {
      const s = Math.max(0, 1 - Math.hypot(t.x - x, t.y - y) / 120);
      if (s > shade) shade = s;
    }
    if (shade > 0.45) continue;                 // keep clearings clear
    crystals.push({ x: Math.round(x), y: Math.round(y), s: 0.8 + rCrystal() * 0.5 });
  }

  return { cx, cy, trees, props, nodes, shadows, canopy, undergrowth, mushrooms, crystals };
}

/** Stable key for a chunk's node, used for local depletion bookkeeping. */
export function nodeKey(cx, cy, idx, epoch = 0) {
  return `${cx}:${cy}:${idx}:${epoch}`;
}