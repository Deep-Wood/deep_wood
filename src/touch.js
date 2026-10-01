/**
 * Virtual input for touch, plus the frame-rate correction for movement.
 *
 * Two independent problems are solved here, and neither belongs in the scene:
 *
 * 1. THE GAME HAD NO TOUCH CONTROLS AT ALL. Movement was WASD/arrows and the
 *    hunt was SPACE, so on a phone there was literally nothing to press. The
 *    scene built every panel button as a Phaser zone but built no movement
 *    control, because a keyboard is not a control scheme.
 *
 * 2. THE SIMULATION COULD RUN IN SLOW MOTION. Phaser pins its loop delta, and
 *    the arcade body integrates `velocity * delta` per step. If the browser
 *    delivers a frame every 90ms but delta stays at the 16.67ms of a 60fps
 *    step, the player advances 16.67ms of game time per 90ms of real time --
 *    the game runs at 0.19x speed instead of dropping frames. Measured on the
 *    live site: 13px of travel where MOVE_SPEED should have produced ~225px.
 *
 * This module is deliberately Phaser-free so both halves are unit-testable
 * without a browser. The scene owns the pixels; this owns the decisions.
 */

/**
 * Touch-control geometry, in CSS pixels, laid out from the screen edges so a
 * resize only has to recompute positions.
 *
 * The d-pad sits bottom-LEFT and HUNT bottom-RIGHT, which is where thumbs
 * actually rest on a phone held in two hands. The find log is moved OFF the
 * bottom-left by the scene when these are visible -- it used to live there and
 * would otherwise sit underneath the d-pad.
 */
export const TOUCH_LAYOUT = {
  dpadBtn: 62,
  dpadGap: 6,
  huntR: 46,
  margin: 16,
  sideBtnW: 78,
  sideBtnH: 32,
  sideGap: 10,
};

/**
 * Largest distance the player may travel in ONE physics step.
 *
 * This is a COLLISION constraint, not a tuning preference. Arcade physics
 * separates overlapping bodies only after moving them, so a step larger than
 * the trunk collider walks straight through a tree. Measured while building
 * this: the trunk body is 20x14 and the player 5x4, so contact happens at
 * 12.5px, and a 10px step stepped from 12.6px clear to 7.8px PAST the trunk
 * without ever registering an overlap -- the player tunnelled and the collision
 * probe reported it 20px beyond the tree.
 *
 * 4px is comfortably inside the 12.5px contact distance, so overlap is always
 * evaluated while there is still room to resolve it.
 *
 * The cost is real and worth stating: full walking speed is preserved down to
 * ~15fps, and below that the game degrades into slight slow motion rather than
 * letting the hunter walk through trees. Correct collision beats exact speed.
 */
const MAX_STEP_PX = 4;

/**
 * How much to scale the movement velocity so that DISTANCE PER REAL SECOND is
 * constant instead of distance per simulated frame.
 *
 * `realDeltaMs` must be measured independently (performance.now), because the
 * Phaser `delta` argument is exactly the value that is lying.
 *
 * Returns 1 at 60fps -- the normal case is untouched.
 *
 * The cap matters more than the correction. Arcade physics separates
 * overlapping bodies AFTER moving them, so a step larger than a tree trunk can
 * pass straight through one. `maxStepPx` bounds a single frame's travel to
 * under the trunk width, so the correction degrades into slight slow motion on
 * a genuinely slow device rather than teleporting the player through the
 * forest. Full speed is maintained down to ~12fps.
 */
export function frameScale(realDeltaMs, physicsDeltaMs, speedPxPerSec, maxStepPx = MAX_STEP_PX) {
  if (!(realDeltaMs > 0) || !(physicsDeltaMs > 0)) return 1;

  const wanted = realDeltaMs / physicsDeltaMs;
  if (!(wanted > 1)) return 1;

  // Distance the body would travel in one physics step at nominal speed.
  const baseStep = (speedPxPerSec * physicsDeltaMs) / 1000;
  const capByStep = baseStep > 0 ? maxStepPx / baseStep : wanted;

  // The outer 5 is a second belt-and-braces bound for a pathological hitch.
  return Math.min(wanted, Math.max(1, capByStep), 5);
}

/**
 * Multi-touch button state, keyed by pointer id.
 *
 * A Map keyed by pointer rather than a set of booleans is what makes TWO
 * thumbs work: pointer 1 holds the d-pad and pointer 2 taps HUNT in the same
 * frame, and neither release cancels the other. With plain booleans the second
 * touch would clear the first and the player would drop every direction the
 * instant they hunted.
 */
export class TouchState {
  constructor() {
    /** @type {Map<number, string>} pointerId -> button name */
    this.pointers = new Map();
    this._huntLatch = false;
    this._beltLatch = false;
    this._boardLatch = false;
  }

  /**
   * A pointer went down on `btn`. Latches the edge-triggered buttons.
   *
   * Named press/release rather than down/up: the class also exposes `up` and
   * `down` as direction GETTERS, and in a class body a later `get down()`
   * silently replaces an earlier `down()` method. Calling `state.down(id,
   * 'left')` then threw "not a function" -- the direction getter had eaten the
   * press handler. Distinct names remove the collision entirely.
   */
  press(pointerId, btn) {
    this.pointers.set(pointerId, btn);
    if (btn === 'hunt') this._huntLatch = true;
    else if (btn === 'belt') this._beltLatch = true;
    else if (btn === 'board') this._boardLatch = true;
  }

  /** A pointer lifted or slid off. */
  release(pointerId) {
    this.pointers.delete(pointerId);
  }

  /** Every pointer released -- focus loss, or a panel covering the pad. */
  clear() {
    this.pointers.clear();
  }

  _held(btn) {
    for (const v of this.pointers.values()) if (v === btn) return true;
    return false;
  }

  get left() { return this._held('left'); }
  get right() { return this._held('right'); }
  get up() { return this._held('up'); }
  get down() { return this._held('down'); }

  get anyHeld() { return this.pointers.size > 0; }

  /**
   * Edge-triggered read: returns true once per press, then clears.
   *
   * JustDown() semantics, and it has to be an edge rather than a level. The
   * scene's hunt path guards on `!this.busy`, so a HELD button would either
   * fire one hunt and then be ignored, or -- if the guard changed -- hunt
   * repeatedly while the thumb rested on it.
   */
  consumeHunt() { const v = this._huntLatch; this._huntLatch = false; return v; }
  consumeBelt() { const v = this._beltLatch; this._beltLatch = false; return v; }
  consumeBoard() { const v = this._boardLatch; this._boardLatch = false; return v; }
}

/**
 * Merge keyboard and touch into one intent, then normalise the axis.
 *
 * Both sources feed the SAME merge, so a player can hold D on the keyboard and
 * a thumb on the d-pad and get one consistent vector rather than two code
 * paths that can disagree about what "moving right" means.
 *
 * Normalising matters: with a d-pad, holding up+right must not be 1.41x faster
 * than holding right alone, or the d-pad diagonals become the fastest way to
 * move and the controls feel broken.
 *
 * @param kb  keyboard state: {left,right,up,down,interact,belt,board} where
 *            the interact/belt/board flags are EDGE-triggered (JustDown)
 * @param t   a TouchState
 */
export function readIntent(kb, t) {
  const rx = (kb.right ? 1 : 0) + (t.right ? 1 : 0);
  const lx = (kb.left ? 1 : 0) + (t.left ? 1 : 0);
  const dy = (kb.down ? 1 : 0) + (t.down ? 1 : 0);
  const uy = (kb.up ? 1 : 0) + (t.up ? 1 : 0);

  let vx = rx - lx;
  let vy = dy - uy;

  if (vx !== 0 && vy !== 0) {
    const INV = Math.SQRT1_2; // 1/sqrt(2), so a diagonal keeps unit length
    vx *= INV;
    vy *= INV;
  }

  return {
    vx,
    vy,
    moving: vx !== 0 || vy !== 0,
    // OR, never AND: holding SPACE while tapping HUNT is one hunt, not zero.
    hunt: !!(kb.interact || t.consumeHunt()),
    belt: !!(kb.belt || t.consumeBelt()),
    board: !!(kb.board || t.consumeBoard()),
  };
}

/**
 * Should the on-screen controls be shown?
 *
 * Detection reads SEVERAL independent signals, because any one of them alone
 * gets a real phone wrong:
 *
 *  - `game.device.input.touch` is Phaser's own verdict.
 *  - `navigator.maxTouchPoints` is what the platform actually reports.
 *  - `(pointer: coarse)` is the CSS answer to "is the primary input a finger".
 *
 * A laptop with a touchscreen reports coarse pointer but no touch points while
 * a stylus user reports neither, so the controls follow the most likely intent
 * rather than one vendor's guess.
 *
 * `force` lets the smoke test pin it on regardless of what the browser claims.
 */
export function shouldShowTouch(game, force) {
  if (force !== undefined) return !!force;

  // Phaser exposes the device on the Game itself. It is NOT `game.sys.game`:
  // there is no `sys` on a Game, so that expression silently evaluated to
  // undefined and this returned false on EVERY device -- the controls were dead
  // in production and only appeared locally because the harness forced them on.
  const phaserSaysTouch = !!(game && game.device && game.device.input && game.device.input.touch);

  const hasTouchPoints = typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;

  const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && (window.matchMedia('(pointer: coarse)').matches
      || window.matchMedia('(any-pointer: coarse)').matches);

  return phaserSaysTouch || hasTouchPoints || coarse;
}

/** Button rectangles, recomputed on resize rather than baked at create time. */
export function touchRects(W, H, L = TOUCH_LAYOUT) {
  const b = L.dpadBtn;
  const g = L.dpadGap;
  const span = b * 3 + g * 2;

  // D-pad cluster: the cross is centred, so the centre button sits at +b+g.
  const dx = L.margin;
  const dy = H - L.margin - span;
  const cell = (col, row) => ({
    x: dx + col * (b + g),
    y: dy + row * (b + g),
    w: b,
    h: b,
  });

  return {
    up: cell(1, 0),
    left: cell(0, 1),
    // Centre is a dead zone so a thumb resting between directions is not a
    // direction. It is drawn as a small hub rather than a fourth button.
    hub: cell(1, 1),
    right: cell(2, 1),
    down: cell(1, 2),

    hunt: {
      x: W - L.margin - L.huntR * 2,
      y: H - L.margin - L.huntR * 2,
      w: L.huntR * 2,
      h: L.huntR * 2,
    },

    belt: { x: W - L.margin - L.sideBtnW, y: L.margin, w: L.sideBtnW, h: L.sideBtnH },
    board: {
      x: W - L.margin - L.sideBtnW,
      y: L.margin + L.sideBtnH + L.sideGap,
      w: L.sideBtnW,
      h: L.sideBtnH,
    },
  };
}