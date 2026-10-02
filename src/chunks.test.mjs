// Determinism tests for the endless-forest chunk generator.
//
// The properties asserted here are the ones the rest of the design rests on.
// If any of them break, either players see different forests (fairness broken)
// or a new season fails to reshuffle (the feature is dead).
//
//   node --test src/chunks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK, chunkSeed, chunkOf, describeChunk, nodeKey, seedToUint32,
} from './chunks.js';

const S1 = '0xbb39c25d167f7372cb5957241cefee83a56fd9ebcf84406eee10d7f77f4674f1';
const S2 = '0x1111111111111111111111111111111111111111111111111111111111111111';

// --- the core property -----------------------------------------------------

test('the same (seed, cx, cy) always produces the identical chunk', () => {
  for (const [cx, cy] of [[0, 0], [3, -7], [-11, 4], [1000, 1000], [-2, -2]]) {
    const a = describeChunk(S1, cx, cy);
    const b = describeChunk(S1, cx, cy);
    assert.deepEqual(a, b, `chunk ${cx},${cy} is not reproducible`);
  }
});

test('generation order does not matter -- a chunk is independent of its neighbours', () => {
  // This is what makes streaming safe: walking around and coming back must
  // produce the same world, and loading chunk 40 first must not change chunk 41.
  const forward = [];
  for (let i = 0; i < 30; i++) forward.push(describeChunk(S1, i, 0));
  const backward = [];
  for (let i = 29; i >= 0; i--) backward[i] = describeChunk(S1, i, 0);
  assert.deepEqual(forward, backward, 'load order leaked into chunk contents');
});

test('a new season seed reshuffles the whole forest', () => {
  const before = describeChunk(S1, 5, 5);
  const after = describeChunk(S2, 5, 5);
  const same = JSON.stringify(before) === JSON.stringify(after);
  assert.equal(same, false, 'a different seed produced an identical chunk');
  // ...but it must still be deterministic under the new seed.
  assert.deepEqual(after, describeChunk(S2, 5, 5));
});

test('every chunk differs from its neighbours', () => {
  // Otherwise the tiling is visible and the forest reads as a grid.
  let dupes = 0;
  for (let i = 0; i < 40; i++) {
    if (chunkSeed(S1, i, 0) === chunkSeed(S1, i + 1, 0)) dupes++;
  }
  assert.equal(dupes, 0, 'adjacent chunks collided on the same seed');
});

test('negative chunk coordinates do not collide with positive ones', () => {
  // Walking west must produce different ground than walking east, or the
  // player meets their own footprints coming back.
  for (const [a, b] of [[[-1, 0], [1, 0]], [[0, -1], [0, 1]], [[-1, -1], [1, 1]]]) {
    assert.notEqual(chunkSeed(S1, ...a), chunkSeed(S1, ...b), `${a} vs ${b} collided`);
  }
});

// --- coordinates -----------------------------------------------------------

test('chunkOf floors correctly, including negatives', () => {
  assert.deepEqual(chunkOf(0, 0), [0, 0]);
  assert.deepEqual(chunkOf(CHUNK - 1, 5), [0, 0]);
  assert.deepEqual(chunkOf(CHUNK, 5), [1, 0]);
  assert.deepEqual(chunkOf(-1, -1), [-1, -1], 'negative coords must floor, not truncate');
  assert.deepEqual(chunkOf(-CHUNK, 0), [-1, 0]);
});

test('chunk contents land inside their own chunk box', () => {
  for (const [cx, cy] of [[0, 0], [4, -9], [-3, 7]]) {
    const c = describeChunk(S1, cx, cy);
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    for (const t of c.trees) {
      assert.ok(t.x >= x0 && t.x < x0 + CHUNK, `tree x ${t.x} outside chunk ${cx}`);
      assert.ok(t.y >= y0 && t.y < y0 + CHUNK, `tree y ${t.y} outside chunk ${cy}`);
      assert.ok(t.v >= 0 && t.v < 4, 'tree variant out of range');
    }
    for (const n of c.nodes) {
      assert.ok(n.x >= x0 && n.x < x0 + CHUNK && n.y >= y0 && n.y < y0 + CHUNK);
    }
  }
});

test('no tree sits on a node -- an unhuntable node is a dead node', () => {
  for (let i = 0; i < 60; i++) {
    const c = describeChunk(S1, i % 7, (i * 3) % 5);
    for (const t of c.trees) {
      for (const n of c.nodes) {
        assert.ok(Math.hypot(n.x - t.x, n.y - t.y) >= 64, 'tree landed on a node');
      }
    }
  }
});

test('nodes inside a chunk stay apart', () => {
  for (let i = 0; i < 60; i++) {
    const c = describeChunk(S1, i, 0);
    for (let a = 0; a < c.nodes.length; a++) {
      for (let b = a + 1; b < c.nodes.length; b++) {
        assert.ok(Math.hypot(c.nodes[a].x - c.nodes[b].x, c.nodes[a].y - c.nodes[b].y) >= 70);
      }
    }
  }
});

test('the spawn area in the origin chunk is clear', () => {
  const c = describeChunk(S1, 0, 0);
  for (const t of c.trees) assert.ok(Math.hypot(t.x, t.y) >= 150, 'a tree is standing on spawn');
});

// --- the reshuffle-on-dig behaviour ---------------------------------------

test('epoch re-rolls node positions but leaves trees where they were', () => {
  const a = describeChunk(S1, 6, 6, 0);
  const b = describeChunk(S1, 6, 6, 1);
  assert.deepEqual(a.trees, b.trees, 'trees must not move under a watching player');
  assert.notDeepEqual(
    a.nodes.map((n) => [n.x, n.y]),
    b.nodes.map((n) => [n.x, n.y]),
    'a dug node must respawn somewhere new, or players camp one spot forever',
  );
});

test('node epoch is recorded so depletion is keyed correctly', () => {
  assert.equal(nodeKey(3, 4, 1, 0), '3:4:1:0');
  assert.notEqual(nodeKey(3, 4, 1, 0), nodeKey(3, 4, 1, 1));
  assert.notEqual(nodeKey(3, 4, 1, 0), nodeKey(3, 5, 1, 0));
  assert.notEqual(nodeKey(3, 4, 1, 0), nodeKey(3, 4, 2, 0));
});

// --- seed parsing ----------------------------------------------------------

test('seedToUint32 reads the low 8 hex chars of a bytes32', () => {
  // ...471 means the slice is the low bytes, not the high ones.
  assert.equal(seedToUint32('0x' + '00'.repeat(28) + '00000471'), 0x471);
  assert.equal(seedToUint32('0xBB39C25D00000471'), 0x471);
  assert.equal(seedToUint32(12345), 12345);
  assert.equal(seedToUint32('not-a-seed'), 0, 'garbage must not throw');
  assert.equal(seedToUint32(''), 0);
});

test('the real on-chain season seed produces a usable forest', () => {
  assert.notEqual(seedToUint32(S1), 0);
  const c = describeChunk(S1, 0, 0);
  assert.ok(c.nodes.length >= 1, 'the origin chunk has no dig nodes at all');
  assert.ok(c.trees.length >= 1);
  assert.ok(c.props.length > 0);
});

// --- ambience layers --------------------------------------------------------

test('shadows are derived from trees, not independently random', () => {
  const c = describeChunk(S1, 3, -2);
  assert.equal(c.shadows.length, c.trees.length);
  // Invert the exact offset rather than matching loosely on y: two trees in a
  // chunk can share a y, and a loose match binds the shadow to the wrong one.
  for (const s of c.shadows) {
    const t = c.trees.find((x) => x.x + 9 === s.x && x.y - 2 === s.y);
    assert.ok(t, `every shadow must belong to a tree (${s.x},${s.y})`);
    assert.equal(s.r, t.v, 'shadow carries its tree variant');
  }
});

test('canopy sits above its tree so the player walks under the leaves', () => {
  const c = describeChunk(S1, 5, 7);
  assert.ok(c.canopy.length >= c.trees.length, 'at least one canopy blob per tree');
  for (const k of c.canopy) {
    // Every blob must belong to SOME tree in this chunk, and be above it: the
    // whole point is that it is drawn at a fixed depth so a player north of a
    // trunk passes beneath the canopy rather than in front of it.
    const owner = c.trees.find((t) => Math.hypot(t.x - k.x, t.y - k.y) < 120);
    assert.ok(owner, `canopy blob at (${k.x},${k.y}) belongs to no tree`);
    assert.ok(k.y < owner.y + 20, `canopy at y=${k.y} is not above its tree at y=${owner.y}`);
  }
});

test('undergrowth gathers around trees instead of scattering uniformly', () => {
  const c = describeChunk(S1, 2, 2);
  assert.ok(c.undergrowth.length > 0, 'some undergrowth must survive rejection sampling');
  const shaded = c.undergrowth.filter((u) => u.shade > 0.3).length;
  assert.ok(shaded > 0, 'some undergrowth must sit in shade');
  // and the shaded fraction must beat a uniform baseline, or the distance
  // function is doing nothing at all
  assert.ok(shaded / c.undergrowth.length > 0.15, `only ${shaded}/${c.undergrowth.length} in shade`);
});

test('ambience layers are epoch-independent, so a dig cannot shuffle the ferns', () => {
  const a = describeChunk(S1, 1, 1, 0);
  const b = describeChunk(S1, 1, 1, 5);
  assert.deepEqual(a.undergrowth, b.undergrowth);
  assert.deepEqual(a.canopy, b.canopy);
  assert.deepEqual(a.shadows, b.shadows);
  // only nodes move between epochs -- that is the respawn
  assert.notDeepEqual(a.nodes, b.nodes);
});

test('ambience is reproducible across calls and independent of load order', () => {
  const first = describeChunk(S1, 9, -4);
  const other = describeChunk(S1, -8, 6);
  const again = describeChunk(S1, 9, -4);
  assert.deepEqual(first, again);
  assert.notDeepEqual(first.undergrowth, other.undergrowth);
});

test('a new season seed reshuffles ambience as well as trees', () => {
  const a = describeChunk(S1, 4, 4);
  const b = describeChunk('0xdeadbeef', 4, 4);
  assert.notDeepEqual(a.undergrowth, b.undergrowth);
  assert.notDeepEqual(a.canopy, b.canopy);
});
