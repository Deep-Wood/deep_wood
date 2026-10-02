// Camera-global forest ambience: pollen, birds, insects, vignette.
//
// DELIBERATELY NOT PER CHUNK. Everything here is created once and lives for the
// life of the scene, because it is attached to the CAMERA, not to the world.
// Chunk-owned ambience would be destroyed every time a chunk streamed out --
// the whole forest would blink out of existence as you walked, which is the
// same class of leak as calling physics.world.colliders.destroy() on unload.
//
// Nothing here affects gameplay, settlement, or the season-seed guarantee. It
// is all decoration, and it is all non-deterministic on purpose: two players
// looking at the same forest should see the same TREES and different drifting
// motes. Pollen positions have no business being reproducible.
//
// Cost is the whole design constraint. This is a phone game with a 25-chunk
// resident set and an already-tight frame budget, so: fixed small object counts,
// no allocation in the update path, no per-frame object creation, and insects
// behind a single flag so they can be deleted without touching anything else.

import Phaser from 'phaser';

// --- tunables --------------------------------------------------------------
// INSECTS is the one-line kill switch. If they read as visual noise on a small
// screen, flip this to false and nothing else needs to change.
export const AMBIENCE = {
  INSECTS: true,
  POLLEN: 34,
  BIRDS: 4,
  INSECT_COUNT: 14,
  BIRD_SPEED: 46,        // px/s, slow: birds crossing a clearing are a moment, not traffic
  BIRD_ALTITUDE: -260,   // above the canopy
  VIGNETTE_ALPHA: 0.42,

  // --- night ---------------------------------------------------------------
  // The emblem is a moonlit wood with air in it. Fog is the depth cue; the
  // fireflies are the only warm moving thing in a scene that is otherwise
  // entirely cool, which is what makes them read as alive rather than as
  // particles.
  //
  // FOG_LAYERS is the parallax stack. `factor` is how much of the camera's
  // movement the layer inherits: 0.12 drifts lazily and reads as far away, 0.55
  // tracks nearly with you and reads as fog you are standing in. The spread
  // between them IS the parallax -- with one layer you get a moving overlay, and
  // that is not depth, it is a texture that slides.
  FOG_LAYERS: [
    { y: 0.30, alpha: 0.30, scale: 2.3, factor: 0.12, speed: 5.5, flip: false },
    { y: 0.48, alpha: 0.42, scale: 2.0, factor: 0.26, speed: -8.0, flip: true },
    { y: 0.66, alpha: 0.34, scale: 1.7, factor: 0.55, speed: 11.0, flip: false },
    { y: 0.84, alpha: 0.46, scale: 1.4, factor: 0.78, speed: -15.0, flip: true },
  ],
  FIREFLIES: 16,
  FIREFLY_BLINK: 1.9,    // Hz-ish; not a sine, see the layer
  STARS: 26,
};

/** Deterministic-ish helpers for a layer that only needs cheap variance. */
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Build the ambience. Returns a handle with destroy() -- the scene calls it,
 * and nothing else should hold a reference.
 */
export function createAmbience(scene) {
  const { add, cameras } = scene;
  const cam = cameras.main;
  const layers = [];
  const drifters = [];

  // ---- fog ----------------------------------------------------------------
  // Four sheets at different depths. Each is a sprite wider than the viewport,
  // positioned in screen space but OFFSET BY THE CAMERA'S OWN SCROLL scaled by
  // `factor` -- that offset is the parallax. A layer with factor 0.12 slides a
  // tenth as fast as you walk and reads as distant haze; one at 0.78 nearly
  // keeps pace and reads as fog you are inside of.
  //
  // Horizontal wrap rather than a static overlay, so walking continuously does
  // not walk you out of the end of the fog.
  const fog = [];
  if (scene.textures.exists('fog')) {
    for (const cfg of AMBIENCE.FOG_LAYERS) {
      const span = cam.width * cfg.scale;
      const img = add.image(0, 0, 'fog')
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(90500 + fog.length * 10)
        .setAlpha(cfg.alpha)
        .setDisplaySize(span, span * 0.25)
        .setFlipX(cfg.flip);
      fog.push({ img, span, factor: cfg.factor, speed: cfg.speed, y: cam.height * cfg.y, off: 0 });
      layers.push(img);
    }
    drifters.push((dt) => {
      const sx = cam.scrollX, sy = cam.scrollY;
      for (const f of fog) {
        f.off += f.speed * dt;
        // wrap over the sprite's own span, then offset by a fraction of the
        // camera scroll. Two modulo-free writes per layer per frame.
        let x = (((f.off + sx * f.factor) % f.span) + f.span) % f.span;
        x -= f.span * 0.35;   // keep the sheet centred-ish, not jammed left
        f.img.setPosition(x, f.y + sy * f.factor * 0.4);
      }
    });
  }

  // ---- stars + moon -------------------------------------------------------
  // Only visible where the canopy opens up, which is most of a top-down forest.
  // Scroll factor 0.35: the sky is technically very far away, but pinning it at
  // 0 makes it look like wallpaper glued to the glass, and 0.35 is the point
  // where the eye stops noticing and starts believing.
  const stars = [];
  if (scene.textures.exists('star')) {
    for (let i = 0; i < AMBIENCE.STARS; i++) {
      const s = add.image(0, 0, 'star')
        .setScrollFactor(0.35)
        .setDepth(90200)
        .setAlpha(rand(0.25, 0.95))
        .setScale(rand(0.8, 1.5));
      stars.push({
        img: s,
        ox: rand(-120, cam.width + 120), oy: rand(-260, cam.height * 0.55),
        ph: rand(0, 6.28),
      });
      layers.push(s);
    }
    if (scene.textures.exists('moonmark')) {
      const moon = add.image(cam.width * 0.78, cam.height * 0.14, 'moonmark')
        .setScrollFactor(0.35)
        .setDepth(90210)
        .setAlpha(0.75)
        .setScale(1.4);
      layers.push(moon);
    }
    drifters.push((dt) => {
      const t = nowSec();
      for (const s of stars) {
        // Very slow twinkle. A per-star phase offset stops them pulsing in
        // unison, which is the tell that they are a sine wave and not a sky.
        const tw = 0.72 + Math.sin(t * 0.7 + s.ph) * 0.28;
        s.img.setAlpha(s.img.alpha * 0 + 0.55 * tw);
        s.img.setPosition(
          s.ox + cam.scrollX * -0.35 * 0.65,
          s.oy + cam.scrollY * -0.35 * 0.65,
        );
      }
    });
  }

  // ---- fireflies ----------------------------------------------------------
  // The one warm thing in a cool scene. They drift on a slow Lissajous like the
  // insects, but they BLINK, and the blink is what separates a firefly from a
  // dot: a steady light reads as a pixel defect, a light that pulses in and out
  // of darkness reads as a living thing you are looking at.
  //
  // The blink is a thresholded sine rather than a smooth fade, so each one is
  // dark for most of its cycle and flares briefly. Smooth fading makes all 16
  // look like the same dim smudge; this makes them sparkle out of step.
  const fireflies = [];
  if (scene.textures.exists('firefly')) {
    for (let i = 0; i < AMBIENCE.FIREFLIES; i++) {
      const f = add.image(0, 0, 'firefly')
        .setScrollFactor(0)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(91500)
        .setScale(rand(0.5, 1.25));
      fireflies.push({
        img: f,
        ox: rand(0, cam.width), oy: rand(0, cam.height),
        ph: rand(0, 6.28), sp: rand(0.18, 0.5), amp: rand(14, 46),
        br: rand(0.45, 1.15),
      });
      layers.push(f);
    }
    drifters.push((dt) => {
      const t = nowSec();
      for (const f of fireflies) {
        const x = f.ox + Math.sin(t * f.sp + f.ph) * f.amp;
        const y = f.oy + Math.sin(t * f.sp * 0.63 + f.ph * 2.1) * f.amp * 0.55;
        const s = Math.sin(t * AMBIENCE.FIREFLY_BLINK + f.ph * 3);
        // thresholded: dark most of the time, a sharp flare as it peaks
        const on = s > 0.72 ? 1 : s > 0.3 ? (s - 0.3) / 0.42 : 0;
        f.img.setPosition(x, y);
        f.img.setAlpha(on * f.br);
      }
    });
  }

  // ---- vignette ------------------------------------------------------------
  // A screen-space darkening at the edges. Costs one texture and no update,
  // and it does more for perceived depth than any amount of extra decoration --
  // the eye reads the dark frame as distance.
  // One baked sprite, stretched to the viewport. Not a Graphics object: that
  // version measured 10.4ms/frame because Phaser rebuilds Graphics geometry
  // every frame, and a full-screen transparent overlay then pays fill rate on
  // top. Baked, it is a single batched draw.
  const vign = add.image(0, 0, 'vignette')
    .setOrigin(0, 0).setScrollFactor(0).setDepth(98000);
  const fitVignette = () => vign.setDisplaySize(cam.width, cam.height);
  fitVignette();
  layers.push(vign);

  // ---- pollen --------------------------------------------------------------
  // Motes catching light. One static pool, animated by writing positions in
  // update() -- an emitter would allocate and manage its own particles for no
  // benefit at this count, and would fight the camera-follow for control.
  const pollen = [];
  for (let i = 0; i < AMBIENCE.POLLEN; i++) {
    const m = add.image(0, 0, 'pollen')
      .setScrollFactor(0)
      .setDepth(90000)
      .setAlpha(rand(0.16, 0.5))
      .setScale(rand(0.5, 1.15));
    pollen.push({
      img: m,
      x: rand(0, cam.width), y: rand(0, cam.height),
      vy: rand(-7, -2), vx: rand(3, 11), ph: rand(0, Math.PI * 2),
    });
    layers.push(m);
  }
  drifters.push((dt) => {
    for (const p of pollen) {
      // Slow upward drift with a lateral sway. Writes into screen space, so the
      // motes belong to the view, not to the ground.
      p.x += p.vx * dt + Math.sin(nowSec() * 0.6 + p.ph) * 0.35;
      p.y += p.vy * dt;
      if (p.y < -8) { p.y = cam.height + 8; p.x = rand(0, cam.width); }
      if (p.x > cam.width + 8) p.x = -8;
      p.img.setPosition(p.x, p.y);
    }
  });

  // ---- birds ---------------------------------------------------------------
  // A handful crossing the sky. They are the cheapest possible depth cue: a
  // small moving thing high above the canopy tells you the world goes on past
  // the edge of the screen.
  const birds = [];
  for (let i = 0; i < AMBIENCE.BIRDS; i++) {
    const b = add.image(0, 0, 'bird')
      .setScrollFactor(0)
      .setDepth(91000)
      .setScale(rand(0.7, 1.3))
      .setAlpha(0.85);
    birds.push({ img: b, y: rand(60, 320), vx: rand(-1, 1) < 0 ? -1 : 1, sp: rand(0.7, 1.4), ph: rand(0, 6.28) });
    layers.push(b);
  }
  const respawnBird = (b) => {
    const dir = Math.random() < 0.5 ? -1 : 1;
    b.vx = dir;
    b.y = rand(60, Math.max(80, cam.height * 0.45));
    b.x = dir > 0 ? -14 : cam.width + 14;
  };
  for (const b of birds) respawnBird(b);
  drifters.push((dt) => {
    for (const b of birds) {
      const speed = AMBIENCE.BIRD_SPEED * b.sp;
      b.x += b.vx * speed * dt;
      b.img.setPosition(b.x, b.y + Math.sin(nowSec() * 1.7 + b.ph) * 9);
      if (b.x < -30 || b.x > cam.width + 30) respawnBird(b);
    }
  });

  // ---- insects -------------------------------------------------------------
  // Ground-level, near the player, so they read as SCALE. This is the layer
  // most likely to look like noise: at 390px wide a 2px dot is either a
  // firefly or a dead pixel, and only a human looking at the phone can say
  // which. Hence the single flag above.
  const insects = [];
  if (AMBIENCE.INSECTS) {
    for (let i = 0; i < AMBIENCE.INSECT_COUNT; i++) {
      const b = add.image(0, 0, 'insect')
        .setScrollFactor(0)
        .setDepth(92000)
        .setAlpha(rand(0.3, 0.8))
        .setScale(rand(0.6, 1.2));
      insects.push({
        img: b,
        ox: rand(0, cam.width), oy: rand(0, cam.height),
        ph: rand(0, 6.28), sp: rand(9, 26), amp: rand(8, 26),
      });
      layers.push(b);
    }
    // Insect motion is a jittery Lissajous rather than a drift -- a straight
    // line reads as debris falling, not an insect wandering.
    drifters.push((dt) => {
      const t = nowSec();
      for (const b of insects) {
        const x = b.ox + Math.sin(t * b.sp * 0.07 + b.ph) * b.amp;
        const y = b.oy + Math.sin(t * b.sp * 0.11 + b.ph * 1.7) * b.amp * 0.6;
        b.img.setPosition(x, y);
      }
    });
  }

  // Shared clock. Reading it once per frame instead of Date.now() per object
  // is the difference between 50 calls and 1.
  let now = 0;
  function nowSec() { return now; }

  const onResize = () => { fitVignette(); };
  scene.scale.on('resize', onResize);

  return {
    /** Called once per frame from the scene's update. */
    tick(dt) {
      now += dt;
      // dt is seconds here; clamp so a stalled tab does not teleport every mote
      // across the screen in one step.
      const d = Math.min(dt, 0.05);
      for (const fn of drifters) fn(d);
    },
    get counts() {
      return {
        pollen: pollen.length,
        birds: birds.length,
        insects: insects.length,
        fog: fog.length,
        stars: stars.length,
        fireflies: fireflies.length,
        total: layers.length,
      };
    },
    destroy() {
      scene.scale.off('resize', onResize);
      for (const l of layers) { l.destroy?.(); }
      layers.length = 0;
      drifters.length = 0;
      pollen.length = 0; birds.length = 0; insects.length = 0;
      fog.length = 0; stars.length = 0; fireflies.length = 0;
    },
  };
}