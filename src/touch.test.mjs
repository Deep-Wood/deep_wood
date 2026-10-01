/**
 * Tests for the virtual input layer: multi-touch, axis normalisation, and the
 * frame-rate correction.
 *
 * Both the touch half and the delta half are asserted against the failure they
 * were written for, not just their happy path -- a guard that has never been
 * seen to fail is not known to work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TouchState, readIntent, frameScale, touchRects, shouldShowTouch, TOUCH_LAYOUT,
} from './touch.js';

const NO_TOUCH = new TouchState();
const kb = (o = {}) => ({
  left: false, right: false, up: false, down: false,
  interact: false, belt: false, board: false, ...o,
});

test('a held direction reads as held, and lifts on release', () => {
  const t = new TouchState();
  assert.equal(t.left, false);
  t.press(1, 'left');
  assert.equal(t.left, true);
  assert.equal(t.right, false);
  t.release(1);
  assert.equal(t.left, false);
});

test('TWO THUMBS: d-pad and HUNT in the same frame, neither cancels the other', () => {
  const t = new TouchState();
  t.press(1, 'right');
  t.press(2, 'hunt');

  // The reason this is a Map keyed by pointer id and not a set of booleans.
  assert.equal(t.right, true, 'moving right survives a simultaneous hunt press');
  assert.equal(t.consumeHunt(), true);

  // Releasing the hunting thumb must not drop the direction.
  t.release(2);
  assert.equal(t.right, true, 'direction survives the hunt thumb lifting');
  t.release(1);
  assert.equal(t.right, false);
});

test('HUNT is edge-triggered: one press is one hunt, not one per frame', () => {
  const t = new TouchState();
  t.press(1, 'hunt');
  assert.equal(t.consumeHunt(), true, 'first read sees the press');
  assert.equal(t.consumeHunt(), false, 'held thumb does not re-fire');
  t.release(1);
  t.press(2, 'hunt');
  assert.equal(t.consumeHunt(), true, 'a second, separate press fires again');
});

test('clear() releases everything -- a panel covering the pad must not stick movement', () => {
  const t = new TouchState();
  t.press(1, 'left');
  t.press(2, 'hunt');
  t.clear();
  assert.equal(t.left, false);
  assert.equal(t.anyHeld, false);
  assert.equal(t.consumeHunt(), true, 'the latched press is still delivered once');
});

test('diagonals are normalised so a d-pad diagonal is not faster', () => {
  const t = new TouchState();
  t.press(1, 'right');
  t.press(2, 'down');
  const d = readIntent(kb(), t);

  const len = Math.hypot(d.vx, d.vy);
  assert.ok(Math.abs(len - 1) < 1e-9, `diagonal length ${len} should be 1`);
  assert.ok(Math.abs(d.vx - Math.SQRT1_2) < 1e-9);
});

test('a single axis is full speed, not scaled', () => {
  const t = new TouchState();
  t.press(1, 'right');
  const r = readIntent(kb(), t);
  assert.equal(r.vx, 1);
  assert.equal(r.vy, 0);
  assert.equal(r.moving, true);
});

test('keyboard and touch merge into ONE vector (both sources, same path)', () => {
  const t = new TouchState();
  t.press(1, 'down');
  const r = readIntent(kb({ right: true }), t);
  // Keyboard right PLUS a thumb holding down is a DIAGONAL, so it carries the
  // normal diagonal component -- asserting vx === 1 here would contradict the
  // unit-length rule two lines below.
  assert.ok(Math.abs(r.vx - Math.SQRT1_2) < 1e-9, `vx ${r.vx} is the normalised diagonal component`);
  assert.ok(Math.abs(r.vy - Math.SQRT1_2) < 1e-9, `vy ${r.vy} is the normalised diagonal component`);
  // Still unit length: it became a diagonal.
  assert.ok(Math.abs(Math.hypot(r.vx, r.vy) - 1) < 1e-9);
});

test('a keyboard-only direction is unaffected by the touch merge', () => {
  const r = readIntent(kb({ right: true }), NO_TOUCH);
  assert.equal(r.vx, 1, 'desktop play is unchanged: right is right');
  assert.equal(r.vy, 0);
  assert.equal(r.moving, true);
});

test('opposing sources cancel rather than sum to a faster vector', () => {
  const t = new TouchState();
  t.press(1, 'left');
  const r = readIntent(kb({ right: true }), t);
  assert.equal(r.vx, 0, 'right and left cancel');
  assert.equal(r.moving, false);
});

test('hunt is OR-ed across sources: SPACE plus HUNT is one hunt, never zero', () => {
  const t = new TouchState();
  t.press(1, 'hunt');
  const r = readIntent(kb({ interact: true }), t);
  assert.equal(r.hunt, true, 'a latched touch press is not swallowed by a held key');
});

test('the merge consumes latches exactly once', () => {
  const t = new TouchState();
  t.press(1, 'belt');
  assert.equal(readIntent(kb(), t).belt, true);
  assert.equal(readIntent(kb(), t).belt, false, 'the latch does not persist into the next frame');
});

/* ---------------- frame-rate correction ---------------- */

const SPEED = 150;

test('frameScale is exactly 1 at 60fps -- the normal case is untouched', () => {
  assert.equal(frameScale(16.67, 16.67, SPEED), 1);
});

test('frameScale is capped BY THE COLLISION BOUND, not by the frame shortfall', () => {
  // The live site showed delta pinned at 16.67ms while real frames arrived every
  // 89.8ms -- a 5.4x shortfall, i.e. the game advancing at 0.19x.
  //
  // frameScale deliberately does NOT return 5.4. The 4px step bound clamps it to
  // ~1.6x, because the larger step that a full correction needs is exactly what
  // walked the hunter 248px past a tree. This test exists to pin that trade: if
  // someone raises MAX_STEP_PX to make this number bigger, collision breaks and
  // this assertion is the thing that noticed.
  const s = frameScale(89.8, 16.67, SPEED);
  assert.ok(s > 1, `scale ${s} does speed the player up at all`);
  assert.ok(s < 5.4, `scale ${s} must stay BELOW the 5.4x the frame shortfall would allow`);
  assert.ok(Math.abs(s - 1.6) < 0.1, `scale ${s} should sit at the collision bound (~1.6x)`);
});

test('frameScale never returns less than 1 (a fast frame must not slow the player)', () => {
  assert.equal(frameScale(8, 16.67, SPEED), 1);
  assert.equal(frameScale(0, 16.67, SPEED), 1);
  assert.equal(frameScale(16.67, 0, SPEED), 1, 'a zero physics delta is not a divide-by-zero');
  assert.equal(frameScale(NaN, 16.67, SPEED), 1);
});

test('frameScale keeps one step inside the COLLISION contact distance', () => {
  // Trunk body 20x14, player 5x4 -> contact at 12.5px. Arcade separates
  // overlaps only AFTER moving, so a step >= 12.5px can pass clean through a
  // tree. A 10px step was MEASURED doing exactly that (12.6px -> 7.8px past).
  // This is the assertion that stops the correction becoming a tunnel.
  const CONTACT = 12.5;
  for (const real of [20, 33, 50, 90, 200, 1000, 5000]) {
    const s = frameScale(real, 16.67, SPEED);
    const stepPx = (SPEED * s * 16.67) / 1000;
    assert.ok(stepPx < CONTACT, `real=${real}ms step ${stepPx.toFixed(1)}px must stay under the ${CONTACT}px contact distance`);
  }
});

test('at 60fps the correction is inert, so ordinary play is untouched', () => {
  // The only case that must be perfectly free of side effects.
  assert.equal(frameScale(16.67, 16.67, SPEED), 1);
  const s = frameScale(17, 16.67, SPEED);
  assert.ok(s < 1.05, `at 60fps the scale is ${s}, effectively 1`);
});

test('below the step bound the game slows instead of tunnelling -- and says so', () => {
  // At 5fps the correction cannot deliver full speed without a 13px step, so
  // it deliberately gives up speed. Asserting the TRADE rather than pretending
  // the correction is free at every frame rate.
  const s = frameScale(200, 16.67, SPEED);
  assert.ok(s < 5, `at 5fps the scale is capped at ${s}, not the full 12x wanted`);
  const stepPx = (SPEED * s * 16.67) / 1000;
  assert.ok(stepPx <= 4 + 1e-9, 'and the step stays inside the collision bound');
});

/* ---------------- layout ---------------- */

test('the d-pad cluster stays inside the viewport and does not overlap HUNT', () => {
  const W = 390, H = 844; // a phone
  const r = touchRects(W, H);

  const inside = (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H;
  for (const k of ['up', 'left', 'right', 'down', 'hunt', 'belt', 'board']) {
    assert.ok(inside(r[k]), `${k} is inside the ${W}x${H} viewport`);
  }

  // The d-pad is bottom-left, HUNT bottom-right: they must not touch, or a
  // thumb reaching for HUNT clips a direction.
  const padRight = r.right.x + r.right.w;
  assert.ok(padRight < r.hunt.x, `d-pad right edge ${padRight} must clear HUNT left ${r.hunt.x}`);
});

test('BELT and BOARD do not overlap each other', () => {
  const r = touchRects(1280, 800);
  assert.ok(r.belt.y + r.belt.h <= r.board.y, 'BELT sits above BOARD');
  assert.equal(r.belt.w, r.board.w, 'they are the same width, so they read as one control');
});

test('the d-pad centre is a hub, not a fifth direction', () => {
  const r = touchRects(390, 844);
  assert.ok(r.hub, 'a hub is laid out so a resting thumb has somewhere to sit');
  assert.equal(r.hub.w, r.up.w, 'the hub matches the button size');
});

test('the pad is laid out from the edges, so it survives a resize', () => {
  const phone = touchRects(390, 844);
  const desktop = touchRects(1280, 800);
  // Anchored to the bottom-left in both: the gap from the edge is constant.
  assert.equal(phone.left.x, TOUCH_LAYOUT.margin);
  assert.equal(desktop.left.x, TOUCH_LAYOUT.margin);
  assert.equal(phone.hunt.x + phone.hunt.w, 390 - TOUCH_LAYOUT.margin);
  assert.equal(desktop.hunt.x + desktop.hunt.w, 1280 - TOUCH_LAYOUT.margin);
});

test('shouldShowTouch honours an explicit override for the harness', () => {
  assert.equal(shouldShowTouch(null, true), true);
  assert.equal(shouldShowTouch(null, false), false);
  assert.equal(shouldShowTouch(null, undefined), false, 'no touch device reported');
});