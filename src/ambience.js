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
        total: layers.length,
      };
    },
    destroy() {
      scene.scale.off('resize', onResize);
      for (const l of layers) { l.destroy?.(); }
      layers.length = 0;
      drifters.length = 0;
      pollen.length = 0; birds.length = 0; insects.length = 0;
    },
  };
}