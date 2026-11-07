// Deterministic biomes + POIs for the 3D Camp view.
//
// Pure module: no Phaser, no three.js, no DOM — testable with node --test.
// Same determinism contract as chunks.js: everything derives from
// (seasonSeed, cx, cy) only, so the 3D view is part of the fairness story,
// not a decoration beside it. A new season reshuffles biomes and POIs
// because the seed re-hashes every chunk.
//
//   node --test src/pois.test.mjs

import { chunkSeed, chunkOf, CHUNK } from './chunks.js';

/** 3D biome palettes. Order matters: biomeOfChunk returns an index here. */
export const BIOMES = [
  {
    name: 'Heartwood Grove',
    sky: 0xa8c4ad, fog: 0x9db8a0, fogFar: 130,
    ground: [0x3f6b35, 0x557f3a, 0x2f5527],
    trunk: 0x6b4a2f, leaf: [0x2e6b2f, 0x3d7d38, 0x24591f],
    glow: 0x9fe870, light: 0xfff2d8, sun: 2.2,
  },
  {
    name: 'Gloam Hollow',
    sky: 0x5c6a8a, fog: 0x55638a, fogFar: 95,
    ground: [0x2c3a4a, 0x3a4a5c, 0x232f3d],
    trunk: 0x3d3348, leaf: [0x4a3d6b, 0x5c4a8a, 0x372c55],
    glow: 0xb48aff, light: 0xcfd8ff, sun: 1.4,
  },
  {
    name: 'Emberfall',
    sky: 0xd8a878, fog: 0xd0a070, fogFar: 120,
    ground: [0x7a5a35, 0x8a6a3d, 0x5f4527],
    trunk: 0x54371f, leaf: [0xb06a2f, 0xc97f38, 0x8f5423],
    glow: 0xffb347, light: 0xffdf9e, sun: 2.0,
  },
];

/** Biome index for a chunk: stable per (seed, cx, cy). */
export function biomeOfChunk(seedHex, cx, cy) {
  return chunkSeed(seedHex, cx, cy) % BIOMES.length;
}

const POI_NAMES = [
  'Sunken Shrine', 'Old Miner Cache', 'Ember Ruins', 'Whispering Stones',
  'Fox Den', 'Fallen Watchtower', 'Moss Altar', 'Starling Perch',
];

// local mulberry32 — chunks.js keeps its own private; duplicating the 8
// lines keeps this module free of changes to chunks.js's tested internals.
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

/**
 * POIs in one chunk, in WORLD pixels (same coordinate space as dig nodes,
 * so a gate click can pan the 2D camera straight to it).
 *
 * 1 in 4 chunks has no POI (deterministic); the rest have exactly one,
 * placed away from the chunk edges so it never sits on a chunk border.
 */
export function poisForChunk(seedHex, cx, cy) {
  const h = (chunkSeed(seedHex, cx, cy) ^ 0x51f15eed) >>> 0;
  if (h % 4 === 0) return [];
  const r = makeRng(h ^ 0x9e3779b9);
  const ox = cx * CHUNK, oy = cy * CHUNK;
  return [{
    x: Math.round(ox + 96 + r() * (CHUNK - 192)),
    y: Math.round(oy + 96 + r() * (CHUNK - 192)),
    name: POI_NAMES[Math.floor(r() * POI_NAMES.length) % POI_NAMES.length],
    kind: h % 3,
    cx, cy,
  }];
}

/** All POIs in the 3x3 chunk ring around a world point (the Camp view's gates). */
export function poisAround(seedHex, x, y) {
  const [cx, cy] = chunkOf(x, y);
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      out.push(...poisForChunk(seedHex, cx + dx, cy + dy));
    }
  }
  return out.slice(0, 6);
}
