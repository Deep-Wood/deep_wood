import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK, chunkOf } from './chunks.js';
import { BIOMES, biomeOfChunk, poisForChunk, poisAround } from './pois.js';

const SEED = '0x' + 'ab'.repeat(32);

test('biomeOfChunk is deterministic and in range', () => {
  for (let cx = -3; cx <= 3; cx++) {
    for (let cy = -3; cy <= 3; cy++) {
      const a = biomeOfChunk(SEED, cx, cy);
      const b = biomeOfChunk(SEED, cx, cy);
      assert.equal(a, b);
      assert.ok(a >= 0 && a < BIOMES.length, `biome ${a} out of range`);
    }
  }
});

test('biomeOfChunk varies across chunks (not all one biome)', () => {
  const set = new Set();
  for (let i = 0; i < 50; i++) set.add(biomeOfChunk(SEED, i - 25, (i * 7) % 11 - 5));
  assert.ok(set.size > 1, 'every chunk got the same biome');
});

test('a new seed reshuffles biomes', () => {
  const other = '0x' + 'cd'.repeat(32);
  let same = 0;
  for (let i = 0; i < 30; i++) {
    if (biomeOfChunk(SEED, i, 0) === biomeOfChunk(other, i, 0)) same++;
  }
  assert.ok(same < 30, 'different seed produced identical biomes everywhere');
});

test('poisForChunk: deterministic, at most one, inside chunk bounds', () => {
  for (let cx = -4; cx <= 4; cx++) {
    for (let cy = -4; cy <= 4; cy++) {
      const a = poisForChunk(SEED, cx, cy);
      const b = poisForChunk(SEED, cx, cy);
      assert.deepEqual(a, b, 'not deterministic');
      assert.ok(a.length <= 1);
      for (const p of a) {
        assert.ok(p.x >= cx * CHUNK && p.x < (cx + 1) * CHUNK, 'x outside chunk');
        assert.ok(p.y >= cy * CHUNK && p.y < (cy + 1) * CHUNK, 'y outside chunk');
        assert.ok(typeof p.name === 'string' && p.name.length > 0);
        assert.ok(p.kind >= 0 && p.kind < 3);
      }
    }
  }
});

test('some chunks have a POI and some do not (but deterministically)', () => {
  let withPoi = 0, total = 0;
  for (let i = 0; i < 40; i++) {
    total++;
    if (poisForChunk(SEED, i - 20, (i * 3) % 9 - 4).length) withPoi++;
  }
  assert.ok(withPoi > 0 && withPoi < total, `expected a mix, got ${withPoi}/${total}`);
});

test('poisAround covers the 3x3 ring around a world point, capped at 6', () => {
  const [cx, cy] = chunkOf(1234, -777);
  const around = poisAround(SEED, 1234, -777);
  const manual = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    manual.push(...poisForChunk(SEED, cx + dx, cy + dy));
  }
  assert.deepEqual(around, manual.slice(0, 6));
  assert.ok(around.length <= 6);
});
