/**
 * Procedural sprite generator for DeepWood.
 *
 * Sprites are drawn in code on a canvas and handed to Phaser as textures.
 * That is a deliberate constraint: there is no image-generation tool here,
 * and it turns out to be the right call anyway. Code-drawn sprites are
 * frame-consistent by construction -- the walk cycle cannot drift between
 * frames the way AI-generated art does, which is what makes the animation
 * read as animation rather than a slideshow.
 *
 * Everything renders at 4x into a 16x16 logical grid, nearest-neighbour, so
 * the result is crisp pixel art.
 *
 * Two Phaser gotchas this file is written around. Both fail SILENTLY -- no
 * error, valid object state, correct positions, nothing on screen:
 *
 *   1. createCanvas() gives a 2D context, but pixels are not on the GPU until
 *      refresh() is called. Draw and forget, and every sprite built from that
 *      texture is fully transparent. Always call the returned done().
 *   2. Texture.add(name, sourceIndex, x, y, width, height) needs BOTH
 *      dimensions. Pass five arguments, `height` is dropped, the frame has
 *      h === undefined, and a physics body on that sprite computes a NaN
 *      position on its first step.
 */
import Phaser from 'phaser';

const S = 16;      // logical sprite size
const SCALE = 4;   // logical -> real pixel multiplier

/** Palette. Kept small and fixed so the game reads as one art style. */
export const PAL = {
  // character
  skin: 0xf2c49b, skinShade: 0xd9a077,
  hair: 0x3d2b1f, hairLit: 0x5a4030,
  cloak: 0x3f6b4d, cloakLit: 0x548a63, cloakDark: 0x2b4d37,
  belt: 0x6b4a2f, pants: 0x4a3b5c, pantsShade: 0x382c46,
  boots: 0x3a2a1d, bootsLit: 0x4a3726,
  pack: 0x8a6f4a, packLid: 0xa08762,
  hat: 0x7a5c3a, hatLit: 0x9a7a4e, hatDark: 0x5a4128,
  metal: 0x9aa2ab, metalDark: 0x6a727b, wood: 0x8a6a42,

  // trees
  trunk: 0x5a3d28, trunkLit: 0x6d4a32, trunkDark: 0x422c1c,
  leaf: 0x2f6b3f, leafLit: 0x3f8a52, leafDark: 0x1f4a2c, leafDeep: 0x163620,
  pine: 0x27603a, pineLit: 0x348049, pineDark: 0x1a4529,

  // ground
  ground: 0x35502f, groundAlt: 0x3d5c34, groundDark: 0x2a4126,
  dirt: 0x5a4630, dirtDark: 0x47361f,

  // props
  rock: 0x6e6e6e, rockLit: 0x8a8a8a, rockDark: 0x4a4a4a,
  flower: [0xe8e2c8, 0xe0c060, 0xc878a0],

  gem: [0xcfd6dd, 0xd9a441, 0x3a6fd8, 0xd83a5a, 0x8a3ad8], // quartz..diamond
  spark: 0xfff8d0,
  crystal: 0x9fe8d8, crystalLit: 0xd8fff4,
  shadow: 0x1a2a1a,
  outline: 0x141c16,
};

const hex = (n) => n & 0xffffff;
const toCss = (color) => '#' + hex(color).toString(16).padStart(6, '0');

function shade(color, amt) {
  const r = Math.max(0, Math.min(255, (color >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((color >> 8) & 0xff) + amt));
  const b = Math.max(0, Math.min(255, (color & 0xff) + amt));
  return (r << 16) | (g << 8) | b;
}

/** Deterministic PRNG, so the forest is identical on every load. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Create a canvas texture and return {tex, ctx, done}.
 * `done()` uploads pixels to the GPU -- see the note at the top of file.
 */
function blank(scene, key) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const t = scene.textures.createCanvas(key, S * SCALE, S * SCALE);
  t.setFilter(Phaser.Textures.FilterMode.NEAREST);
  const ctx = t.getContext();
  return { tex: t, ctx, done: () => t.refresh() };
}

function px(ctx, x, y, color) {
  ctx.fillStyle = toCss(color);
  ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
}

function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = toCss(color);
  ctx.fillRect(x * SCALE, y * SCALE, w * SCALE, h * SCALE);
}

/** A soft ellipse, used for foliage masses. */
function oval(ctx, cx, cy, rx, ry, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = toCss(color);
  ctx.beginPath();
  ctx.ellipse(cx * SCALE, cy * SCALE, rx * SCALE, ry * SCALE, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Character: a hunter. 4 directions x 4 walk frames = 16 frames.      */
/* ------------------------------------------------------------------ */

/**
 * @param dir 0=down 1=left 2=right 3=up
 * @param frame 0..3 walk-cycle phase
 */
function drawHunter(ctx, dir, frame) {
  const bob = [0, -1, 0, 0][frame];      // vertical bounce
  const swing = [0, 1, 0, -1][frame];    // -1..1, drives legs and arms

  const back = dir === 3;
  const side = dir === 1 || dir === 2;
  const facing = dir === 2 ? 1 : -1;     // which way a side view points

  // contact shadow -- belongs to the ground, so it never bobs
  rect(ctx, 4, 15, 8, 1, PAL.shadow);

  const yHatTop = 1 + bob;
  const yBrim = yHatTop + 3;
  const yFace = yBrim + 1;
  const yTorso = yFace + 3;
  const yLegs = yTorso + 5;
  const yBoot = 14 + bob;

  if (side) {
    /* ---------------- side profile ---------------- */
    const legF = swing;
    const legB = -swing;

    // back leg first, so the front leg overlaps it
    rect(ctx, 5, yLegs, 2, 3 - Math.max(0, legB), PAL.pantsShade);
    px(ctx, 5, yBoot, PAL.boots);
    rect(ctx, 8, yLegs, 2, 3 - Math.max(0, legF), PAL.pants);
    px(ctx, 8, yBoot, PAL.bootsLit);

    // cloak / torso
    rect(ctx, 4, yTorso, 8, 5, PAL.cloak);
    rect(ctx, 4, yTorso, 8, 1, PAL.cloakLit);
    rect(ctx, 4, yTorso + 4, 8, 1, PAL.cloakDark);
    rect(ctx, 4, yTorso + 3, 8, 1, PAL.belt);

    // rear arm, behind the torso
    rect(ctx, facing > 0 ? 10 : 4, yTorso + 1 + Math.max(0, legB), 2, 3, PAL.cloakDark);

    // pack, slung on the back
    rect(ctx, facing > 0 ? 4 : 10, yTorso, 2, 4, PAL.pack);
    rect(ctx, facing > 0 ? 4 : 10, yTorso, 2, 1, PAL.packLid);

    // head
    rect(ctx, 5, yFace, 6, 3, PAL.skin);
    rect(ctx, 5, yFace + 2, 6, 1, PAL.skinShade);
    px(ctx, facing > 0 ? 11 : 4, yFace + 1, PAL.skinShade); // nose
    px(ctx, facing > 0 ? 9 : 6, yFace + 1, PAL.outline);    // eye
    rect(ctx, 5, yFace - 1, 6, 1, PAL.hair);

    // hat
    rect(ctx, 3, yBrim, 10, 1, PAL.hat);
    rect(ctx, 5, yHatTop, 6, 3, PAL.hat);
    rect(ctx, 5, yHatTop, 6, 1, PAL.hatLit);
    rect(ctx, 5, yHatTop + 2, 6, 1, PAL.hatDark);
    px(ctx, 3, yBrim, PAL.hatDark);

    // pick, in the leading hand
    rect(ctx, facing > 0 ? 11 : 4, yTorso + Math.max(0, legF), 1, 3, PAL.wood);
    rect(ctx, facing > 0 ? 11 : 4, yTorso - 1 + Math.max(0, legF), 2, 1, PAL.metal);
    px(ctx, facing > 0 ? 11 : 4, yTorso + 3 + Math.max(0, legF), PAL.skin);
  } else {
    /* ---------------- front / back ---------------- */
    rect(ctx, 5, yLegs, 2, 3, PAL.pants);
    rect(ctx, 9, yLegs, 2, 3, PAL.pantsShade);
    const liftL = swing > 0 ? 1 : 0;
    const liftR = swing < 0 ? 1 : 0;
    rect(ctx, 5, yBoot - liftL, 2, 1, liftL ? PAL.bootsLit : PAL.boots);
    rect(ctx, 9, yBoot - liftR, 2, 1, liftR ? PAL.bootsLit : PAL.boots);

    // torso
    rect(ctx, 4, yTorso, 8, 5, back ? PAL.cloakDark : PAL.cloak);
    rect(ctx, 4, yTorso, 8, 1, back ? PAL.cloak : PAL.cloakLit);
    rect(ctx, 4, yTorso + 4, 8, 1, PAL.cloakDark);
    rect(ctx, 4, yTorso + 3, 8, 1, PAL.belt);
    px(ctx, 7, yTorso + 3, PAL.hatLit);

    if (back) {
      // pack, front and centre when walking away
      rect(ctx, 5, yTorso + 1, 6, 4, PAL.pack);
      rect(ctx, 5, yTorso + 1, 6, 1, PAL.packLid);
      rect(ctx, 5, yTorso + 4, 6, 1, PAL.hatDark);
      rect(ctx, 5, yTorso, 6, 1, PAL.metalDark); // bedroll
    }

    // arms
    const armL = Math.max(0, -swing);
    const armR = Math.max(0, swing);
    rect(ctx, 2, yTorso + 1 + armL, 2, 3, PAL.cloakDark);
    rect(ctx, 12, yTorso + 1 + armR, 2, 3, PAL.cloakDark);
    px(ctx, 2, yTorso + 4 + armL, PAL.skin);
    px(ctx, 13, yTorso + 4 + armR, PAL.skin);
    if (!back) {
      // pick in the right hand
      rect(ctx, 13, yTorso + armR, 1, 3, PAL.wood);
      rect(ctx, 13, yTorso - 1 + armR, 2, 1, PAL.metal);
    }

    // head
    rect(ctx, 4, yFace, 8, 3, back ? PAL.skinShade : PAL.skin);
    if (back) {
      // hood up, no face
      rect(ctx, 4, yFace - 1, 8, 4, PAL.cloakDark);
      rect(ctx, 4, yFace - 1, 8, 1, PAL.cloak);
    } else {
      rect(ctx, 4, yFace + 2, 8, 1, PAL.skinShade);
      px(ctx, 6, yFace + 1, PAL.outline);
      px(ctx, 9, yFace + 1, PAL.outline);
      px(ctx, 4, yFace, PAL.hair);
      px(ctx, 11, yFace, PAL.hair);
    }

    // hat
    rect(ctx, 2, yBrim, 12, 1, PAL.hat);
    rect(ctx, 4, yHatTop, 8, 3, PAL.hat);
    rect(ctx, 4, yHatTop, 8, 1, PAL.hatLit);
    rect(ctx, 4, yHatTop + 2, 8, 1, PAL.hatDark);
    px(ctx, 2, yBrim, PAL.hatDark);
    px(ctx, 13, yBrim, PAL.hatDark);
  }
}

export function makeHunterTexture(scene) {
  const key = 'hunter';
  const { tex: t, ctx, done } = blank(scene, key);
  const cols = 4, rows = 4; // 4 walk frames per direction

  // Register all 16 cells as INDIVIDUAL frames. Direction rows in order:
  // down(0), left(1), right(2), up(3). Registering the sheet as one 64x64
  // frame instead leaves the texture with a single frame, so
  // generateFrameNumbers() yields 1 frame and every anims.play() throws.
  for (let dir = 0; dir < rows; dir++) {
    for (let f = 0; f < cols; f++) {
      // add(name, sourceIndex, x, y, width, height) -- BOTH dims required.
      t.add(dir * cols + f, 0, f * S * SCALE, dir * S * SCALE, S * SCALE, S * SCALE);
    }
  }

  for (let dir = 0; dir < rows; dir++) {
    for (let f = 0; f < cols; f++) {
      ctx.clearRect(f * S * SCALE, dir * S * SCALE, S * SCALE, S * SCALE);
      drawHunter(ctx, dir, f);
    }
  }
  done(); // upload pixels to the GPU -- without this the sprite is invisible
  return key;
}

/* ------------------------------------------------------------------ */
/* Trees                                                               */
/* ------------------------------------------------------------------ */

/**
 * Four types, so the forest is not one shape stamped 70 times.
 * 0 broadleaf, 1 pine, 2 bushy, 3 tall narrow
 */
export function makeTreeTexture(scene, variant = 0) {
  const key = `tree${variant}`;
  const { ctx, done } = blank(scene, key);
  const v = variant % 4;
  const baseY = 15;

  /* ---- trunk ---- */
  if (v === 1) {
    rect(ctx, 7, baseY - 3, 2, 3, PAL.trunk);
    px(ctx, 7, baseY - 3, PAL.trunkLit);
  } else if (v === 3) {
    rect(ctx, 7, baseY - 6, 2, 6, PAL.trunk);
    rect(ctx, 7, baseY - 6, 1, 6, PAL.trunkLit);
    px(ctx, 8, baseY - 2, PAL.trunkDark);
  } else {
    rect(ctx, 6, baseY - 2, 4, 2, PAL.trunk);
    rect(ctx, 6, baseY - 2, 1, 2, PAL.trunkLit);
    px(ctx, 9, baseY - 1, PAL.trunkDark);
  }
  px(ctx, 5, baseY, PAL.trunkDark);  // roots flaring into the grass
  px(ctx, 10, baseY, PAL.trunkDark);

  if (v === 1) {
    /* ---------------- pine: stacked tiers ---------------- */
    for (let tier = 0; tier < 4; tier++) {
      const ty = baseY - 4 - tier * 2;
      const w = 3 + tier * 2;
      rect(ctx, 8 - w / 2, ty, w, 2, PAL.pineDark);
      rect(ctx, 8 - w / 2 + 1, ty, w - 2, 1, PAL.pine);
    }
    // lit tips, upper-left
    rect(ctx, 7, baseY - 11, 2, 1, PAL.pineLit);
    rect(ctx, 6, baseY - 9, 2, 1, PAL.pineLit);
    rect(ctx, 6, baseY - 7, 2, 1, PAL.pineLit);
    px(ctx, 7, baseY - 12, PAL.pineLit); // crown spike
    px(ctx, 8, baseY - 12, PAL.pine);
  } else if (v === 3) {
    /* ---------------- tall narrow ---------------- */
    oval(ctx, 8, 4.5, 2.6, 3.4, PAL.leafDeep);
    oval(ctx, 8, 4.5, 2.2, 3.0, PAL.leaf);
    oval(ctx, 7.2, 3.4, 1.2, 1.4, PAL.leafLit, 0.85);
    px(ctx, 5, 6, PAL.leaf);
    px(ctx, 11, 5, PAL.leafDark);
    px(ctx, 6, 2, PAL.leaf);
  } else {
    /* ---------------- broadleaf / bushy: layered canopy ---------------- */
    const dark = v === 2 ? PAL.pineDark : PAL.leafDeep;
    const mid = v === 2 ? PAL.pine : PAL.leaf;
    const lit = v === 2 ? PAL.pineLit : PAL.leafLit;
    const cy = v === 2 ? 9.5 : 7.5;
    const rx = v === 2 ? 4.6 : 5.2;
    const ry = v === 2 ? 3.2 : 3.8;

    // masses back to front, for volume
    oval(ctx, 8, cy + 1.4, rx, ry, dark);
    oval(ctx, 6.2, cy, rx * 0.72, ry * 0.8, mid);
    oval(ctx, 9.8, cy, rx * 0.72, ry * 0.8, mid);
    oval(ctx, 8, cy - 0.6, rx * 0.85, ry * 0.7, mid);
    oval(ctx, 6.6, cy - 1.4, rx * 0.45, ry * 0.42, lit, 0.9); // sun, upper-left

    // ragged edge, so it does not read as a plain ellipse
    px(ctx, 8 - Math.round(rx) - 1, cy, dark);
    px(ctx, 8 + Math.round(rx), cy - 1, dark);
    px(ctx, 6, cy - Math.round(ry) - 1, mid);
    px(ctx, 10, cy - Math.round(ry) - 2, mid);
    px(ctx, 8 - Math.round(rx) - 2, cy - 1, lit);
    px(ctx, 8 + Math.round(rx) + 1, cy, mid);
  }

  done();
  return key;
}

/* ------------------------------------------------------------------ */
/* Gems, dig nodes, props                                              */
/* ------------------------------------------------------------------ */

/** A faceted gem in rarity colours, for finds and the reveal burst. */
export function makeGemTexture(scene, rarity) {
  const key = `gem${rarity}`;
  const { ctx, done } = blank(scene, key);
  const c = PAL.gem[rarity];

  // dark outline first, body inset by one, so it reads at small sizes
  rect(ctx, 5, 4, 6, 1, PAL.outline);
  rect(ctx, 4, 5, 8, 2, PAL.outline);
  rect(ctx, 3, 7, 10, 4, PAL.outline);
  rect(ctx, 4, 11, 8, 2, PAL.outline);
  rect(ctx, 6, 13, 4, 2, PAL.outline);

  rect(ctx, 6, 5, 4, 2, shade(c, 25)); // crown
  rect(ctx, 5, 7, 6, 4, c);             // body
  rect(ctx, 6, 11, 4, 2, c);            // pavilion
  rect(ctx, 7, 13, 2, 1, shade(c, -20));

  // facets
  rect(ctx, 6, 5, 2, 1, 0xffffff);
  rect(ctx, 5, 7, 2, 3, shade(c, 30));
  rect(ctx, 9, 7, 2, 4, shade(c, -45));
  rect(ctx, 5, 9, 2, 2, shade(c, -15));
  rect(ctx, 6, 11, 2, 2, shade(c, -30));

  px(ctx, 5, 6, 0xffffff); // specular
  px(ctx, 5, 4, PAL.spark);
  px(ctx, 10, 4, PAL.spark);
  done();
  return key;
}

export function makeGems(scene) {
  for (let r = 0; r < 5; r++) makeGemTexture(scene, r);
}

/**
 * A dig node: disturbed soil, half-buried stones, a pale crystal breaking
 * through. This is what the player walks up to, so it must read as
 * "interactable" rather than as a gem someone dropped.
 */
export function makeNodeTexture(scene) {
  const key = 'node';
  const { ctx, done } = blank(scene, key);

  rect(ctx, 3, 12, 10, 2, PAL.dirtDark);
  rect(ctx, 2, 13, 12, 2, PAL.dirt);
  rect(ctx, 4, 14, 8, 1, PAL.dirtDark);

  rect(ctx, 2, 11, 2, 2, PAL.rockDark);
  rect(ctx, 12, 12, 2, 2, PAL.rockDark);
  px(ctx, 2, 11, PAL.rock);
  px(ctx, 12, 12, PAL.rock);

  rect(ctx, 6, 6, 4, 6, PAL.crystal);
  rect(ctx, 6, 6, 2, 6, PAL.crystalLit);
  rect(ctx, 9, 8, 1, 4, shade(PAL.crystal, -40));
  px(ctx, 7, 5, PAL.crystalLit);
  px(ctx, 8, 5, PAL.crystal);
  rect(ctx, 6, 11, 4, 1, shade(PAL.crystal, -25));

  done();
  return key;
}

/** Scatter props: 0 bush, 1 rock, 2 grass tuft, 3 flowers. */
export function makePropTexture(scene, kind = 0) {
  const key = `prop${kind}`;
  const { ctx, done } = blank(scene, key);
  const k = kind % 4;

  if (k === 0) {
    // bush
    oval(ctx, 8, 11, 4.4, 2.6, PAL.leafDeep);
    oval(ctx, 8, 10.4, 4.0, 2.4, PAL.leaf);
    oval(ctx, 6.4, 9.4, 1.8, 1.3, PAL.leafLit, 0.9);
    px(ctx, 4, 12, PAL.leafDark);
    px(ctx, 12, 11, PAL.leafDark);
    px(ctx, 8, 7, PAL.leaf);
  } else if (k === 1) {
    // rock
    rect(ctx, 5, 9, 6, 4, PAL.rock);
    rect(ctx, 6, 8, 4, 1, PAL.rock);
    rect(ctx, 5, 9, 2, 3, PAL.rockLit);
    rect(ctx, 9, 10, 2, 3, PAL.rockDark);
    px(ctx, 6, 12, PAL.rockDark);
    px(ctx, 5, 13, PAL.shadow);
    px(ctx, 10, 13, PAL.shadow);
  } else if (k === 2) {
    // grass tuft
    rect(ctx, 7, 12, 1, 3, PAL.leafLit);
    rect(ctx, 6, 11, 1, 4, PAL.leaf);
    rect(ctx, 9, 10, 1, 5, PAL.leaf);
    rect(ctx, 8, 12, 1, 3, PAL.leafDark);
    rect(ctx, 10, 12, 1, 2, PAL.leafLit);
  } else {
    // flowers
    rect(ctx, 6, 11, 1, 4, PAL.leaf);
    rect(ctx, 9, 12, 1, 3, PAL.leafDark);
    px(ctx, 6, 10, PAL.flower[0]);
    px(ctx, 9, 11, PAL.flower[1]);
    px(ctx, 7, 13, PAL.flower[2]);
  }

  done();
  return key;
}

/** Four-point sparkle for the reveal burst. */
export function makeSparkTexture(scene) {
  const key = 'spark';
  const { tex: t, ctx, done } = blank(scene, key);
  ctx.fillStyle = toCss(PAL.spark);
  ctx.beginPath();
  const cx = (S * SCALE) / 2, cy = (S * SCALE) / 2, r = (S * SCALE) / 2 - 2;
  for (let i = 0; i < 8; i++) {
    const ang = (Math.PI / 4) * i;
    const rad = i % 2 === 0 ? r : r / 4;
    const x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  done();
  return key;
}

/** Soft radial glow, drawn additively behind dig nodes. */
export function makeGlowTexture(scene) {
  const key = 'glow';
  if (scene.textures.exists(key)) return key;
  const R = 96;
  const t = scene.textures.createCanvas(key, R, R);
  t.setFilter(Phaser.Textures.FilterMode.LINEAR);
  const ctx = t.getContext();
  const g = ctx.createRadialGradient(R / 2, R / 2, 0, R / 2, R / 2, R / 2);
  g.addColorStop(0, 'rgba(190,255,240,0.55)');
  g.addColorStop(0.35, 'rgba(150,235,215,0.20)');
  g.addColorStop(1, 'rgba(120,220,200,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, R, R);
  t.refresh();
  return key;
}

/**
 * The whole forest floor as ONE world-sized texture.
 *
 * Not a TileSprite: a runtime canvas texture cannot tile in this Phaser build
 * and silently falls back to a blank UUID-keyed texture. A single 1:1 image is
 * deterministic and lets the detail be non-repeating.
 */
export function makeGroundTexture(scene, worldW, worldH) {
  const key = 'ground';
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const W = worldW, H = worldH;
  const t = scene.textures.createCanvas(key, W, H);
  t.setFilter(Phaser.Textures.FilterMode.LINEAR);
  const ctx = t.getContext();
  const rnd = rng(20260929);

  ctx.fillStyle = toCss(PAL.ground);
  ctx.fillRect(0, 0, W, H);

  // broad tonal patches, so the floor is not one flat colour
  for (let i = 0; i < 220; i++) {
    oval(ctx, rnd() * W, rnd() * H, 40 + rnd() * 110, 30 + rnd() * 90,
      rnd() > 0.5 ? PAL.groundAlt : PAL.groundDark, 0.35);
  }
  // worn dirt
  for (let i = 0; i < 26; i++) {
    oval(ctx, rnd() * W, rnd() * H, 30 + rnd() * 70, 20 + rnd() * 50, PAL.dirt, 0.28);
  }

  // blades
  for (let i = 0; i < 9000; i++) {
    const r = rnd();
    ctx.fillStyle = toCss(r > 0.86 ? PAL.leafLit : r > 0.55 ? PAL.leaf : PAL.leafDark);
    ctx.globalAlpha = 0.5 + rnd() * 0.4;
    ctx.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 2);
  }
  ctx.globalAlpha = 1;

  // pebbles and flowers
  for (let i = 0; i < 260; i++) {
    const r = rnd();
    if (r > 0.82) {
      ctx.fillStyle = toCss(PAL.rockDark);
      ctx.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 2, 1);
    } else {
      ctx.fillStyle = toCss(PAL.flower[Math.floor(rnd() * PAL.flower.length)]);
      ctx.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 1);
    }
  }

  t.refresh();
  return key;
}

/** Create every texture. Call once in scene create(). */
export function buildAllTextures(scene, worldW = 1280, worldH = 960) {
  makeHunterTexture(scene);
  makeGems(scene);
  makeNodeTexture(scene);
  makeSparkTexture(scene);
  makeGlowTexture(scene);
  for (let v = 0; v < 4; v++) makeTreeTexture(scene, v);
  for (let k = 0; k < 4; k++) makePropTexture(scene, k);
  makeGroundTexture(scene, worldW, worldH);
}

export { S as LOGICAL_SIZE, SCALE as PIXEL_SCALE };
