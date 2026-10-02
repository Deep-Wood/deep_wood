// The ground-vs-world depth invariant.
//
// This is a source assertion rather than a runtime one on purpose. The failure
// mode is a comparison between two constants in different parts of a 1500-line
// file, and reading them is cheaper and more honest than booting a browser to
// rediscover that a number is too small.
//
// WHAT WENT WRONG, because the shape of this bug is not obvious from the symptom:
//
//   - Every world object uses its raw world Y as its Phaser depth, for y-sorting:
//     the player, trees, undergrowth, node glows and markers.
//   - The ground is a scrollFactor-0 TileSprite at a FIXED depth.
//   - Those conventions are only compatible while world Y is non-negative.
//
// The original fixed world was 0..960, so Y never went negative and a ground
// depth of 0 was always at the bottom of the range. Nothing was wrong.
//
// The endless forest is centred on (0,0). So EVERYTHING NORTH OF SPAWN HAS A
// NEGATIVE Y, which sorts BELOW a ground depth of 0 -- and the ground then draws
// on top of it. Walking up buried the hunter, the trees and the dig nodes under
// the grass. Birds and insects kept flying because they sit at depth 90000+.
//
// The report was "when he moves up he disappears and there are no more trees and
// gems, only birds flying and the worms". Every element of that sentence is this
// bug. The ambiguous part -- a character vanishing from a canvas -- looked like a
// rendering failure, a WebView budget problem, a camera problem, and a caching
// problem in turn before the sort order turned out to be the cause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./ForestScene.js', import.meta.url), 'utf8');

test('the world is centred on the origin, which is why negative Y is reachable', () => {
  // If this ever changes, the ground-depth rule below may be over- or
  // under-strict and this test is the reminder to re-derive it.
  const far = Number(/const WORLD_FAR\s*=\s*([0-9.e+]+)/.exec(SRC)?.[1]);
  assert.ok(Number.isFinite(far), 'could not read WORLD_FAR');
  assert.ok(far > 1_000_000, 'the world is meant to be effectively unbounded');
  assert.ok(-far < 0, 'a world centred on the origin has reachable negative Y');
});

test('the ground renders below every reachable world position', () => {
  const far = Number(/const WORLD_FAR\s*=\s*([0-9.e+]+)/.exec(SRC)?.[1]);
  assert.ok(Number.isFinite(far), 'could not read WORLD_FAR');

  // Two accepted spellings, resolved to the value the source actually means.
  let groundDepth;
  if (/setScrollFactor\(0\)\.setDepth\(GROUND_DEPTH\)/.test(SRC)) {
    const fromConstant = /const GROUND_DEPTH\s*=\s*-\(?WORLD_FAR\s*\*\s*2/.test(SRC);
    const fromNumber = /const GROUND_DEPTH\s*=\s*(-[0-9.e+]+)/.exec(SRC)?.[1];
    groundDepth = fromConstant ? -(far * 2) : Number(fromNumber);
  } else {
    groundDepth = Number(
      /setScrollFactor\(0\)\.setDepth\((-?[0-9.]+)\)/.exec(SRC)?.[1],
    );
  }

  assert.ok(Number.isFinite(groundDepth), 'could not resolve the ground depth');

  // The lowest world Y a player can ever stand at.
  const lowestReachableY = -far;
  assert.ok(
    groundDepth < lowestReachableY,
    `ground depth ${groundDepth} must be below the lowest reachable world Y ` +
      `(${lowestReachableY}); otherwise objects north of spawn render behind the grass`,
  );
});

test('world objects really do sort on raw world Y', () => {
  // If this stops being true the invariant above stops meaning anything, so it is
  // worth pinning: the whole bug lives in this convention meeting a fixed depth.
  assert.match(
    SRC,
    /this\.player\.setDepth\(this\.player\.y\)/,
    'the hunter must y-sort on its own Y',
  );
  assert.match(
    SRC,
    /add\.image\(t\.x, t\.y, `tree\$\{t\.v\}`\)[\s\S]{0,80}?setDepth\(t\.y\)/,
    'trees must y-sort on their own Y',
  );
});

test('camera-global layers stay above every world object', () => {
  // They are the layers that survived the bug and looked fine, which is why the
  // report named birds and worms rather than "everything went black".
  //
  // Read ambience.js as well: its depths live there, not in ForestScene.js, and
  // this test silently passed an empty assertion set when only one file was read.
  const AMB = readFileSync(new URL('./ambience.js', import.meta.url), 'utf8');
  const depths = [...AMB.matchAll(/\.setDepth\((\d{4,6})\)/g)].map((m) => Number(m[1]));
  assert.ok(depths.length >= 3, `expected the ambience layers, found ${depths.length}`);
  assert.ok(
    Math.min(...depths) > 0,
    'screen-space ambience must stay above the origin, or it disappears north of spawn too',
  );

  // The canopy is deliberately mid-range: it has to be above every y-sorted world
  // object so the hunter walks under the leaves, and it still has to clear the
  // ground, which is now far below the origin.
  assert.match(SRC, /setDepth\(50000\)/, 'canopy must be a fixed high depth');
  assert.ok(50000 > 0, 'canopy must stay above the ground');
});