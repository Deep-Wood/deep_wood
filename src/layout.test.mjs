import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelFrame } from './layout.js';

// The regression these cover: a hardcoded 340px toolbelt covered 87% of a
// 390px phone screen, and a hardcoded 430px standings panel started at x = -56
// and ran off the left edge. Both numbers were desktop assumptions.

const PHONE = [390, 844];
const DESKTOP = [1280, 800];
const LANDSCAPE_PHONE = [844, 390];
const SMALL = [320, 568];

test('toolbelt no longer swallows the screen on a phone', () => {
  const [W, H] = PHONE;
  const f = panelFrame(W, H, 340, 396);
  assert.equal(f.sheet, true, 'a 390px viewport must use the sheet');
  // leaves a margin on both sides
  assert.ok(f.px >= 12, `left margin was ${f.px}`);
  assert.ok(f.px + f.pw <= W - 12, 'panel must not touch the right edge');
  // and is docked to the bottom
  assert.ok(f.py + f.ph <= H, 'sheet must fit vertically');
  assert.equal(f.py + f.ph, H - 12, 'sheet should sit against the bottom edge');
});

test('the forest stays visible above the sheet', () => {
  const [W, H] = PHONE;
  const f = panelFrame(W, H, 340, 396);
  assert.ok(f.ph <= H * 0.7 + 1, `sheet is ${f.ph} of ${H} -- should cap at 70%`);
  assert.ok(f.py >= H * 0.25, `only ${f.py}px of forest left above the sheet`);
});

test('desktop keeps the original right-docked side panel', () => {
  const [W, H] = DESKTOP;
  const f = panelFrame(W, H, 340, 396);
  assert.equal(f.sheet, false, 'desktop must not switch to a sheet');
  assert.equal(f.pw, 340, 'desktop width must be unchanged');
  assert.equal(f.px, W - 340 - 16, 'desktop must stay right-docked');
  assert.equal(f.py, 88, 'desktop top offset must be unchanged');
});

test('no panel is ever wider than the screen', () => {
  // Every width we might ever ship, including the 430px standings.
  for (const [W, H] of [PHONE, DESKTOP, LANDSCAPE_PHONE, SMALL, [360, 640], [768, 1024]]) {
    for (const contentW of [340, 430]) {
      const f = panelFrame(W, H, contentW, 396);
      assert.ok(f.px >= 0, `panel starts off-screen left at ${W}x${H} (${contentW}w)`);
      assert.ok(
        f.px + f.pw <= W,
        `panel ${f.pw}px at x=${f.px} overflows a ${W}px viewport (${contentW}w)`,
      );
    }
  }
});

test('no panel is ever taller than the screen', () => {
  for (const [W, H] of [PHONE, DESKTOP, LANDSCAPE_PHONE, SMALL, [360, 640]]) {
    const f = panelFrame(W, H, 340, 396);
    assert.ok(f.py >= 0, `panel starts above the viewport at ${W}x${H}`);
    assert.ok(f.py + f.ph <= H, `panel bottom ${f.py + f.ph} exceeds ${H}`);
  }
});

test('a landscape phone gets a centred sheet, not one stretched wide', () => {
  const [W, H] = LANDSCAPE_PHONE;
  const f = panelFrame(W, H, 340, 396);
  assert.equal(f.sheet, true, 'too short for a 396px panel -- must sheet');
  assert.ok(f.pw <= 520, `sheet width ${f.pw} should be capped`);
  // centred
  assert.equal(Math.abs(f.px - (W - f.pw) / 2), 0, 'sheet should be horizontally centred');
});

test('a very short viewport still produces a usable sheet', () => {
  const f = panelFrame(320, 400, 340, 396);
  assert.ok(f.ph >= 220, 'sheet must not collapse below a usable height');
  assert.ok(f.ph <= 400, 'and must still fit');
});