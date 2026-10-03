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

  // trees -- NIGHT.
  //
  // These were daylight greens: #35502f ground, #2f6b3f leaf, #5a3d28 trunk.
  // The emblem is a moonlit forest -- desaturated blue-green, deep shadow, one
  // bioluminescent emerald as the only light source -- so every value here is
  // pulled down and cooled. Not darker alone: shifted toward teal, because a
  // dark green forest at night still reads as daylight forest, just underexposed.
  trunk: 0x2b2118, trunkLit: 0x3b2d20, trunkDark: 0x1a1410,
  leaf: 0x14382c, leafLit: 0x1e5544, leafDark: 0x0c241c, leafDeep: 0x081811,
  pine: 0x113025, pineLit: 0x1a4636, pineDark: 0x0a1e17,

  // The moon is a cool light, so the LIT side of a thing is cool and the
  // shadowed side keeps a trace of the warm ground bounce.
  moon: 0x9fd8e8,
  moss: 0x1d4a3a,

  // ground
  ground: 0x11211d, groundAlt: 0x182e28, groundDark: 0x0b1614,
  dirt: 0x2a2418, dirtDark: 0x1c1811,

  // The glow the emblem is actually built around. Kept hot on purpose: if the
  // whole scene is night, this is the only thing that is allowed to be bright,
  // and desaturating it too would leave nothing lit at all.
  glow: 0x3ff0b0,

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

/**
 * One logical pixel, scaled up to the texture's SCALE.
 *
 * `alpha` is optional and defaults to opaque. The moon rim uses it to paint a
 * partial-alpha highlight over whatever the tree already drew, rather than
 * needing to know the canopy's exact silhouette.
 */
function px(ctx, x, y, color, alpha = 1) {
  if (alpha < 1) {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    ctx.fillStyle = toCss(color);
    ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    ctx.globalAlpha = prev;
    return;
  }
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

  // Hoisted: the moon rim below needs the canopy centre, and it was declared
  // inside the broadleaf branch where it was block-scoped and unreachable --
  // which threw "cy is not defined" for variants 0 and 2 and took the whole
  // scene down. 159 unit tests passed straight through it, because nothing in
  // the suite bakes all four tree variants.
  let canopyY = 7.5;

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
    canopyY = cy;
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

  /* ---- moon rim ----------------------------------------------------------
   * The single most effective cue that a scene is lit by a moon rather than a
   * sun: a thin COOL edge on the side facing it, and nothing on the other.
   * A palette swap alone reads as "underexposed daylight" -- the whole forest
   * stayed green no matter how far down the values went. The rim is what says
   * where the light is coming from.
   *
   * Upper-left, matching where the old sun highlights already sat, so it costs a
   * few dozen pixels rather than a second pass over the silhouette. Drawn with
   * partial alpha over whatever is already there, so it lights the canopy edge
   * without needing to know the canopy's exact shape.
   */
  const rim = (x, y, a) => px(ctx, x, y, PAL.moon, a);
  if (v === 1) {
    // pine: the left edge of each tier
    for (let tier = 0; tier < 4; tier++) {
      const ty = baseY - 4 - tier * 2;
      const w = 3 + tier * 2;
      rim(Math.round(8 - w / 2), ty, 0.55);
    }
    rim(7, baseY - 12, 0.7);
  } else if (v === 3) {
    rim(7, 3, 0.6); rim(6, 5, 0.45); rim(8, 2, 0.5);
  } else {
    const cy = canopyY;
    rim(4, Math.round(cy), 0.5);
    rim(5, Math.round(cy) - 2, 0.55);
    rim(6, Math.round(cy) - 3, 0.6);
    rim(7, Math.round(cy) - 4, 0.5);
  }
  // the trunk catches the same light, one pixel down the left side
  if (v === 1) rim(7, baseY - 3, 0.5);
  else if (v === 3) rim(7, baseY - 6, 0.5);
  else rim(6, baseY - 2, 0.5);

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
  const { tex, ctx, done } = blank(scene, key);
  const s = S * SCALE;                  // 16 * 4 = 64 real px
  const cx = s / 2;

  // NEAREST is correct for the pixel-art sprites -- every other texture in this
  // file is hard-edged rectangles on purpose. It is wrong here: this node is a
  // downsampled generated image, and nearest-neighbour at 96 -> ~34px throws
  // away rows and columns of pixels and leaves visible aliasing. Linear is the
  // only thing that makes composited art look like art.
  tex.setFilter(Phaser.Textures.FilterMode.LINEAR);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, s, s);

  // --- disturbed soil: a soft mound, not a stack of hard rectangles --------
  // The previous version drew the soil as rect() rows. Once the generated
  // crystal went in on top, those rows read as a cut stump with a crystal
  // growing out of it. Soft gradients have no such silhouette.
  const mound = ctx.createRadialGradient(cx, s * 0.80, s * 0.04, cx, s * 0.80, s * 0.46);
  mound.addColorStop(0, 'rgba(58,46,36,0.95)');
  mound.addColorStop(0.55, 'rgba(40,33,27,0.80)');
  mound.addColorStop(1, 'rgba(22,26,24,0)');
  ctx.fillStyle = mound;
  ctx.beginPath();
  ctx.ellipse(cx, s * 0.80, s * 0.46, s * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();

  // a few pebbles, kept low contrast so they never compete with the crystal
  for (const [px, py, pr] of [[0.26, 0.80, 0.055], [0.72, 0.83, 0.045], [0.62, 0.74, 0.032]]) {
    ctx.fillStyle = 'rgba(94,104,100,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx * 0 + s * px, s * py, s * pr, s * pr * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const gen = scene.textures.exists('gen-crystal')
    ? scene.textures.get('gen-crystal').getSourceImage()
    : null;

  if (gen && gen.width) {
    // --- the crystal is the subject, so it gets most of the frame ---------
    const h = Math.round(s * 0.86);
    const w = Math.round(h * (gen.width / gen.height));
    const dx = Math.round((s - w) / 2);
    const dy = Math.round(s * 0.13);

    // ground-contact shadow so it is bedded in the soil, not floating on it
    const sh = ctx.createRadialGradient(cx, s * 0.86, 1, cx, s * 0.86, s * 0.22);
    sh.addColorStop(0, 'rgba(8,12,11,0.72)');
    sh.addColorStop(1, 'rgba(8,12,11,0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.ellipse(cx, s * 0.86, s * 0.22, s * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    // bioluminescent pool cast by the crystal onto the soil
    const glow = ctx.createRadialGradient(cx, s * 0.72, 1, cx, s * 0.72, s * 0.40);
    glow.addColorStop(0, 'rgba(90,220,190,0.34)');
    glow.addColorStop(1, 'rgba(90,220,190,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, s, s);

    ctx.drawImage(gen, dx, dy, w, h);
  } else {
    // Fallback keeps the node readable if the asset ever fails to load.
    rect(ctx, 3, 12, 10, 2, PAL.dirtDark);
    rect(ctx, 2, 13, 12, 2, PAL.dirt);
    rect(ctx, 6, 6, 4, 6, PAL.crystal);
    rect(ctx, 6, 6, 2, 6, PAL.crystalLit);
    px(ctx, 7, 5, PAL.crystalLit);
    rect(ctx, 6, 11, 4, 1, shade(PAL.crystal, -25));
  }

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

/**
 * Fog wisps, for the parallax layers.
 *
 * Horizontal soft bands rather than a blob: real ground fog lies in sheets, and
 * a texture that is uniformly cloudy reads as a smudge on the lens instead of
 * air with depth in it. Each wisp is an elongated ellipse with a soft falloff,
 * baked once and then stretched wide, which is why this is a texture and not a
 * Graphics loop -- Phaser rebuilds Graphics geometry every frame, and the
 * vignette already proved that costs 10ms/frame at full-screen size.
 *
 * The ink is COLD and barely there. Fog at night is lit by the moon, not by the
 * sun, and the temptation is to make it a bright grey band, which reads as
 * smoke. It is a slight lift out of the dark, and it occludes more than it
 * illuminates.
 */
export function makeFogTexture(scene) {
  if (scene.textures.exists('fog')) return 'fog';
  const S = 2;
  const W = 256, H = 64;
  const g = scene.make.graphics({ add: false });
  g.clear();
  // Six overlapping soft ellipses, warm-free and low-alpha. Overlap is what
  // makes it look like drifting sheets rather than six distinct puffs.
  for (let i = 0; i < 6; i++) {
    const cx = 26 + i * 41;
    const cy = H / 2 + Math.sin(i * 1.7) * 11;
    const rx = 44 + Math.sin(i * 2.3) * 12;
    const ry = 15 + Math.cos(i * 1.1) * 6;
    g.fillStyle(0x8fb8c4, 0.030);
    g.fillEllipse(cx, cy, rx, ry);
    g.fillStyle(0xa8d4dc, 0.022);
    g.fillEllipse(cx + 9, cy - 3, rx * 0.7, ry * 0.7);
  }
  g.generateTexture('fog', W, H);
  g.destroy();
  return 'fog';
}

/**
 * A firefly: a warm core with a cool-green halo, because the emblem's
 * bioluminescence is green and its fireflies are the warmer counterpoint.
 * Two colours because a single-colour dot either reads as a dead pixel or as a
 * lightbulb, depending on size, and at 3-5px you have no room to be subtle.
 */
export function makeFireflyTexture(scene) {
  if (scene.textures.exists('firefly')) return 'firefly';
  const g = scene.make.graphics({ add: false });
  g.clear();
  g.fillStyle(0x3ff0b0, 0.10); g.fillCircle(7, 7, 6.5);
  g.fillStyle(0x7ef9a0, 0.28); g.fillCircle(7, 7, 3.4);
  g.fillStyle(0xe8ffd0, 0.95); g.fillCircle(7, 7, 1.3);
  g.generateTexture('firefly', 14, 14);
  g.destroy();
  return 'firefly';
}

/** A single star. Deliberately 2px: at phone scale, less is a smudge. */
export function makeStarTexture(scene) {
  if (scene.textures.exists('star')) return 'star';
  const g = scene.make.graphics({ add: false });
  g.clear();
  g.fillStyle(0xdff2ff, 0.55); g.fillRect(0, 0, 2, 2);
  g.fillStyle(0xffffff, 0.95); g.fillRect(0, 0, 1, 1);
  g.generateTexture('star', 2, 2);
  g.destroy();
  return 'star';
}

/**
 * The crescent moon from the emblem, small enough to sit in a corner of the
 * sky above the canopy. Baked once; it is one sprite, so it costs nothing.
 */
export function makeMoonTexture(scene) {
  if (scene.textures.exists('moonmark')) return 'moonmark';
  const g = scene.make.graphics({ add: false });
  g.clear();
  g.fillStyle(0xdff2ff, 0.22); g.fillCircle(18, 18, 15);
  g.fillStyle(0xeaf7ff, 0.85); g.fillCircle(18, 18, 11);
  // Punch the crescent by overdrawing the disc with the sky tint. This is not
  // a true alpha cut-out, but the sky layer behind it is a flat near-black, so
  // the seam is invisible at the one size it is ever drawn.
  g.fillStyle(0x08120f, 1); g.fillCircle(23, 15, 10);
  g.generateTexture('moonmark', 36, 36);
  g.destroy();
  return 'moonmark';
}

/**
 * The hunter's lantern.
 *
 * With the palette moved to night, 87% of the frame now sits below luminance 40
 * and the character has no guaranteed contrast against whatever he is standing
 * on. Measured across his 48x48 band the range was 20..203, so he is findable --
 * but "findable on a dark surface in daylight on a phone" is a weaker promise
 * than it was when the ground was #35502f.
 *
 * So he carries his own light: a small additive halo that travels with him. It
 * is also the emblem's own idea -- a bioluminescent source in a moonlit wood --
 * and it gives the player a moving point of interest to steer by.
 */
/**
 * Three bioluminescent mushrooms on one transparent strip, drawn small.
 *
 * Two pixels of stem and a domed cap, with the cap glowing. The glow is baked
 * INTO the sprite rather than being a second additive sprite per mushroom:
 * twice the objects for the same picture, and this scene cannot afford it.
 * Mushrooms that need a real pool of light on the ground get a separate halo
 * sprite, but only the flagged subset does.
 */
export function makeMushroomTexture(scene) {
  if (scene.textures.exists('mushroom')) return 'mushroom';
  const g = scene.make.graphics({ add: false });
  g.clear();
  for (let k = 0; k < 3; k++) {
    const bx = 5 + k * 7, by = 13;
    const capW = 4 + k * 0.6, capH = 2.6 - k * 0.3;
    g.fillStyle(0x0d1a16, 1); g.fillRect(bx, by - 1, 1, 2);      // stem
    g.fillStyle(0x2f8f70, 0.5); g.fillEllipse(bx, by - 2, capW * 1.5, capH * 1.5); // halo
    g.fillStyle(0x3ff0b0, 1); g.fillEllipse(bx, by - 2, capW, capH);              // cap
    g.fillStyle(0xd8fff0, 0.9); g.fillRect(bx - 0.5, by - 2.5, 1, 1);             // catchlight
  }
  g.generateTexture('mushroom', 24, 16);
  g.destroy();
  return 'mushroom';
}

/** A faceted emerald crystal, half-buried, with a baked inner glow. */
/**
 * A beacon: the surveyor's mark planted at a dig site.
 *
 * Deliberately carries NO rarity information. Every beacon looks identical --
 * same shape, same cold bronze, same glow -- because if it hinted at the reward
 * the dig would stop being a gamble and become a formality, and the player
 * would be scanning for colour instead of exploring. The rarity is only ever
 * known once `reveal()` rolls it, which is why the five gem textures stay
 * separate and are chosen there.
 *
 * A pale ring on the ground reads as "marked, dig here" without advertising
 * what is underneath.
 */
export function makeBeaconTexture(scene) {
  const key = 'beacon';
  if (scene.textures.exists(key)) return key;
  const { ctx, done } = blank(scene, key);
  const s = S * SCALE;
  const cx = s / 2;

  // NEAREST is right for this one: it is hard-edged pixel art, not downsampled
  // generated art. The node texture needs LINEAR, this does not.
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, s, s);

  // --- ground ring: the "this is a marked site" cue ----------------------
  // Two concentric arcs, brightest at the front so it reads as lit from below.
  for (const [r, a, col] of [[0.40, 0.55, '144,192,176'], [0.30, 0.34, '120,170,158']]) {
    ctx.strokeStyle = `rgba(${col},${a})`;
    ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.beginPath();
    ctx.ellipse(cx, s * 0.74, s * r, s * r * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // --- the post: a stake driven into the soil ---------------------------
  const post = (x, w, y0, y1, col) => {
    ctx.fillStyle = col; ctx.fillRect(x, y0, w, y1 - y0);
  };
  const px = Math.round(s * 0.44), pw = Math.max(2, Math.round(s * 0.055));
  post(px, pw, Math.round(s * 0.30), Math.round(s * 0.76), '#6d7a72');
  post(px + 1, Math.max(1, pw - 2), Math.round(s * 0.30), Math.round(s * 0.76), '#93a49a');
  // cross-brace, so it reads as built rather than a bare stick
  post(px - Math.round(s * 0.07), pw, Math.round(s * 0.42),
    Math.round(s * 0.42) + Math.max(1, Math.round(s * 0.045)), '#6d7a72');

  // --- bronze cap: the one warm accent, identical on every beacon --------
  ctx.fillStyle = '#c79a4e';
  ctx.fillRect(px - Math.round(s * 0.045), Math.round(s * 0.27),
    pw + Math.round(s * 0.09), Math.max(2, Math.round(s * 0.07)));
  ctx.fillStyle = '#e6c383';
  ctx.fillRect(px - Math.round(s * 0.045), Math.round(s * 0.27),
    pw + Math.round(s * 0.09), Math.max(1, Math.round(s * 0.028)));

  // --- cold lantern glow at the cap -------------------------------------
  // Cool on purpose. If this were warm it would be the only warm thing in the
  // forest and would read as "treasure", which is the signal we are avoiding.
  const gl = ctx.createRadialGradient(px + pw / 2, s * 0.30, 1, px + pw / 2, s * 0.30, s * 0.22);
  gl.addColorStop(0, 'rgba(150,225,215,0.55)');
  gl.addColorStop(1, 'rgba(150,225,215,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(0, 0, s, s);

  done();
  return key;
}

export function makeCrystalTexture(scene) {
  if (scene.textures.exists('crystal')) return 'crystal';
  const g = scene.make.graphics({ add: false });
  g.clear();
  g.fillStyle(0x3ff0b0, 0.14); g.fillEllipse(8, 11, 13, 7);      // ground glow
  g.fillStyle(0x1d7a5e, 1);
  g.fillTriangle(8, 1, 3, 11, 8, 11);                            // left facet
  g.fillTriangle(8, 1, 13, 11, 8, 11);                           // right facet
  g.fillStyle(0x3ff0b0, 0.85);
  g.fillTriangle(8, 1, 8, 11, 5, 9);                             // lit sliver
  g.fillStyle(0xd8fff0, 0.9); g.fillRect(7, 3, 1, 2);            // tip catchlight
  g.generateTexture('crystal', 16, 14);
  g.destroy();
  return 'crystal';
}

export function makeLanternTexture(scene) {
  if (scene.textures.exists('lantern')) return 'lantern';
  const g = scene.make.graphics({ add: false });
  for (let i = 6; i >= 1; i--) {
    g.fillStyle(0x3ff0b0, 0.035 + (6 - i) * 0.012);
    g.fillCircle(32, 32, i * 5);
  }
  g.fillStyle(0x7ef9d0, 0.5);
  g.fillCircle(32, 32, 4);
  g.generateTexture('lantern', 64, 64);
  g.destroy();
  return 'lantern';
}

/** Soft radial glow, drawn additively behind dig nodes. */
// --- ambience sprites ------------------------------------------------------
// Three tiny textures for the camera-global layers. Each is deliberately a
// couple of pixels: on a 390px phone screen anything larger stops reading as
// atmosphere and starts reading as an object you could walk into.

/**
 * Soft elliptical contact shadow. Drawn once and reused for every tree --
 * a texture atlas of one blob keeps this to a single batched draw call.
 */
export function makeShadowTexture(scene) {
  if (scene.textures.exists('shadow')) return 'shadow';
  const g = scene.make.graphics({ add: false });
  // Three nested ellipses approximate a falloff without a gradient texture.
  for (let i = 3; i >= 1; i--) {
    g.fillStyle(0x0d1a0c, 0.13);
    g.fillEllipse(20, 12, 44 - i * 9, 22 - i * 4);
  }
  g.generateTexture('shadow', 44, 26);
  g.destroy();
  return 'shadow';
}

/** Leaf mass drawn ABOVE the player. Irregular, so overlapping canopies merge. */
export function makeCanopyTexture(scene) {
  if (scene.textures.exists('canopy')) return 'canopy';
  const g = scene.make.graphics({ add: false });
  const blobs = [[24, 16, 17], [40, 12, 13], [12, 14, 12], [30, 24, 14], [46, 22, 10]];
  // A darker underside reads as depth from below; the player is looking up into it.
  for (const [x, y, r] of blobs) {
    g.fillStyle(0x14300f, 0.5);
    g.fillCircle(x, y + 2, r);
  }
  for (const [x, y, r] of blobs) {
    g.fillStyle(0x2b5a1e, 0.55);
    g.fillCircle(x, y, r);
  }
  g.generateTexture('canopy', 60, 40);
  g.destroy();
  return 'canopy';
}

/** Three undergrowth tufts of different silhouette. */
export function makeUndergrowthTextures(scene) {
  for (let k = 0; k < 3; k++) {
    const key = `under${k}`;
    if (scene.textures.exists(key)) continue;
    const g = scene.make.graphics({ add: false });
    const blades = 3 + k * 2;
    for (let i = 0; i < blades; i++) {
      const x = 5 + i * (10 / blades) + (k % 2);
      const h = 7 + ((i * 5 + k * 3) % 8);
      // Two-tone blade: a lit edge and a dark body, so tufts are not flat.
      g.lineStyle(2, k === 2 ? 0x3f7a2a : 0x2f6b24, 0.9);
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x + (i % 2 ? 2 : -2), 14 - h); g.strokePath();
      g.lineStyle(1, 0x63b047, 0.8);
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x + (i % 2 ? 2 : -2), 14 - h); g.strokePath();
    }
    g.generateTexture(key, 20, 16);
    g.destroy();
  }
}

/**
 * Vignette, baked ONCE into a texture.
 *
 * This used to be a Graphics object redrawing six stroked rects every frame, and
 * it measured 10.4ms of a 13ms ambience budget for ONE object: Phaser
 * re-tessellates Graphics geometry per frame, so the cost was fill plus geometry
 * rebuild rather than a single batched sprite. Baking it makes it exactly one
 * draw call, which is what a screen-space overlay should be.
 */
export function makeVignetteTexture(scene) {
  if (scene.textures.exists('vignette')) return 'vignette';
  const S = 256;
  const g = scene.make.graphics({ add: false });
  // Bands of the FRAME ONLY, never the interior.
  //
  // The previous version drew 14 nested fillRects starting at inset 0 -- and a
  // rect at inset 0 covers the entire texture, so every one of the 14 layers
  // stacked darkness on the CENTRE while the edges got one. Measured alpha came
  // out 124/255 in the middle and 14 at the edges: a black hole in the middle of
  // the screen with the hunter sitting in it, which is exactly how it looked.
  //
  // Each band is therefore drawn as four strips around a clear inner square, so
  // alpha is 0 at the centre by construction rather than by tuning.
  const BANDS = 14;
  const INNER = Math.round(S * 0.44);   // centre 44% is untouched
  for (let i = 0; i < BANDS; i++) {
    const t = i / BANDS;                       // 0 = outermost band
    const outer = Math.round(t * INNER);
    const inner = Math.round(((i + 1) / BANDS) * INNER);
    const band = Math.max(1, outer - inner);
    // Alpha per band has to be much higher than it looks: each pixel is covered
    // by at most one or two bands, not all 14. At 0.030 the whole vignette
    // measured 8/255 at the edge and was invisible -- the fix for the black-hole
    // version over-corrected, and the check that let it through only asserted
    // the CENTRE was clear, never that the edge was dark.
    g.fillStyle(0x000000, 0.115 * (1 - t * 0.55));
    g.fillRect(0, outer, S, band);                                   // top
    g.fillRect(0, S - outer - band, S, band);                        // bottom
    g.fillRect(outer, inner, band, S - inner * 2);                   // left
    g.fillRect(S - outer - band, inner, band, S - inner * 2);        // right
  }
  g.generateTexture('vignette', S, S);
  g.destroy();
  return 'vignette';
}

export function makePollenTexture(scene) {
  const g = scene.make.graphics({ add: false });
  // Soft, slightly warm -- pollen catching light, not a white pixel.
  g.fillStyle(0xfff3c4, 1);
  g.fillCircle(3, 3, 2);
  g.fillStyle(0xffffff, 0.55);
  g.fillCircle(3, 3, 1);
  g.generateTexture('pollen', 6, 6);
  g.destroy();
}

/** A two-stroke gull silhouette. Cheap, and reads as a bird at 6px. */
export function makeBirdTexture(scene) {
  const g = scene.make.graphics({ add: false });
  g.lineStyle(2, 0x1c2230, 1);
  g.beginPath();
  g.moveTo(0, 4); g.lineTo(5, 0); g.lineTo(9, 4);
  g.strokePath();
  g.beginPath();
  g.moveTo(9, 4); g.lineTo(13, 0); g.lineTo(17, 4);
  g.strokePath();
  g.generateTexture('bird', 18, 8);
  g.destroy();
}

/** A single near-pixel dot. If this reads as dirt on the lens, turn INSECTS off. */
export function makeInsectTexture(scene) {
  const g = scene.make.graphics({ add: false });
  g.fillStyle(0x2b2a1f, 1);
  g.fillRect(2, 2, 2, 2);
  g.generateTexture('insect', 6, 6);
  g.destroy();
}

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
 * A rotating beacon light: a radial core with two opposed CONES, like a
 * lighthouse or a siren sweeping a beam.
 *
 * The plain `glow` texture is a symmetric blob. Symmetric light does not read
 * as a beacon -- it reads as a smudge, which is exactly the complaint that the
 * beacons "don't glow". A real rotating light is asymmetric: bright where the
 * beam points, dark on the far side, and it visibly sweeps.
 *
 * So this bakes one frame of a rotating two-beam lamp. `ForestScene` rotates
 * copies of it, which is both cheaper and smoother than redrawing cones per
 * frame, and the core stays centred while the cones sweep.
 */
export function makeSirenTexture(scene) {
  const key = 'siren';
  if (scene.textures.exists(key)) return key;
  const R = 128;                       // texture is 256x256
  const C = R;
  const t = scene.textures.createCanvas(key, R * 2, R * 2);
  t.setFilter(Phaser.Textures.FilterMode.LINEAR);
  const ctx = t.getContext();
  ctx.clearRect(0, 0, R * 2, R * 2);

  // Two opposed beams. CONE_SPREAD is how wide each wedge opens; WEDGE_START
  // fades the beam in from the core so it does not look like a hard triangle.
  const CONE_SPREAD = 0.62;            // radians of half-width
  const WEDGE_START = 0.06;
  for (const dir of [0, Math.PI]) {
    const g = ctx.createRadialGradient(C, C, WEDGE_START * R, C, C, R);
    g.addColorStop(0.00, 'rgba(210,255,248,0.00)');
    g.addColorStop(0.10, 'rgba(190,255,244,0.42)');
    g.addColorStop(0.42, 'rgba(140,235,220,0.17)');
    g.addColorStop(1.00, 'rgba(110,215,200,0.00)');
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(C, C);
    // Draw the wedge rotated into place, clipped to the radial falloff above.
    ctx.arc(C, C, R, dir - CONE_SPREAD, dir + CONE_SPREAD);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  // The hot core, on top and full-circle so the source reads as the origin.
  const core = ctx.createRadialGradient(C, C, 0, C, C, R * 0.42);
  core.addColorStop(0.00, 'rgba(255,255,255,0.92)');
  core.addColorStop(0.22, 'rgba(214,255,248,0.60)');
  core.addColorStop(0.55, 'rgba(150,240,225,0.20)');
  core.addColorStop(1.00, 'rgba(120,225,205,0.00)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, R * 2, R * 2);

  t.refresh();
  return key;
}

/**
 * A chunky chevron for the off-screen beacon pointer.
 *
 * Drawn pointing RIGHT (0 rad) so the sprite can simply be rotated to the target
 * bearing with `setRotation`. Origin (0.5, 0.5) keeps the rotation about the
 * arrow's middle rather than a corner.
 */
export function makeArrowTexture(scene) {
  const key = 'arrow';
  if (scene.textures.exists(key)) return key;
  const R = 40;                       // 80x80
  const t = scene.textures.createCanvas(key, R * 2, R * 2);
  t.setFilter(Phaser.Textures.FilterMode.LINEAR);
  const ctx = t.getContext();
  ctx.clearRect(0, 0, R * 2, R * 2);
  const c = R;
  // Solid body plus a soft halo, so the arrow reads over both the dark forest
  // floor and a bright canopy edge.
  for (const [spread, fill] of [[1.0, 'rgba(150,240,225,0.30)'], [0.72, 'rgba(216,255,248,0.95)']]) {
    ctx.beginPath();
    ctx.moveTo(c + 26 * spread, c);
    ctx.lineTo(c - 12 * spread, c - 22 * spread);
    ctx.lineTo(c - 4 * spread, c);
    ctx.lineTo(c - 12 * spread, c + 22 * spread);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
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
  // SEAMLESS TILE, not a world-sized bake.
  //
  // The endless forest cannot use a texture sized to the world -- there is no
  // world size any more. This now produces a single tile that repeats, so the
  // ground is a TileSprite following the camera at scrollFactor 0 instead of a
  // giant image.
  //
  // Seamless means every blob is ALSO drawn at its wrapped offsets, so a patch
  // that runs off the right edge reappears on the left. Without that the seams
  // are visible as a grid and the forest immediately reads as tiled.
  const key = 'ground';
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const W = GROUND_TILE, H = GROUND_TILE;
  const t = scene.textures.createCanvas(key, W, H);
  t.setFilter(Phaser.Textures.FilterMode.LINEAR);
  const ctx = t.getContext();
  const rnd = rng(20260929);

  // Draw fn, called once per wrap-offset so anything crossing an edge is
  // continued on the opposite side.
  const wrapped = (x, y, draw) => {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const px = x + ox * W, py = y + oy * H;
        if (px < -W || px > W * 2 || py < -H || py > H * 2) continue;
        draw(px, py);
      }
    }
  };

  ctx.fillStyle = toCss(PAL.ground);
  ctx.fillRect(0, 0, W, H);

  // broad tonal patches, so the floor is not one flat colour
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W, y = rnd() * H;
    const rx = 40 + rnd() * 110, ry = 30 + rnd() * 90;
    const col = rnd() > 0.5 ? PAL.groundAlt : PAL.groundDark;
    wrapped(x, y, (px, py) => oval(ctx, px, py, rx, ry, col, 0.35));
  }
  // worn dirt
  for (let i = 0; i < 12; i++) {
    const x = rnd() * W, y = rnd() * H;
    const rx = 30 + rnd() * 70, ry = 20 + rnd() * 50;
    wrapped(x, y, (px, py) => oval(ctx, px, py, rx, ry, PAL.dirt, 0.28));
  }

  // blades
  // Density scaled from the old 9000-over-1280x960 bake to this 512 tile,
  // so the repeat does not read as noise.
  for (let i = 0; i < 1900; i++) {
    const r = rnd();
    ctx.fillStyle = toCss(r > 0.86 ? PAL.leafLit : r > 0.55 ? PAL.leaf : PAL.leafDark);
    ctx.globalAlpha = 0.5 + rnd() * 0.4;
    ctx.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 2);
  }
  ctx.globalAlpha = 1;

  // pebbles and flowers
  for (let i = 0; i < 56; i++) {
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
/** Ground tile edge in px. One tile repeats under the camera forever. */
export const GROUND_TILE = 512;

export function buildAllTextures(scene, worldW = 1280, worldH = 960) {
  makeHunterTexture(scene);
  makeNodeTexture(scene);
  makeSparkTexture(scene);
  makeGlowTexture(scene);
  makeSirenTexture(scene);
  makeArrowTexture(scene);
  // Ambience sprites are built here too so there is exactly one place where
  // textures come into existence, and a missing one fails loudly at boot rather
  // than silently rendering nothing 60 times a second.
  makeShadowTexture(scene);
  makeCanopyTexture(scene);
  makeUndergrowthTextures(scene);
  makeVignetteTexture(scene);
  makeLanternTexture(scene);
  makeFogTexture(scene);
  makeFireflyTexture(scene);
  makeStarTexture(scene);
  makeMoonTexture(scene);
  makeBeaconTexture(scene);
  makeMushroomTexture(scene);
  makeCrystalTexture(scene);
  makePollenTexture(scene);
  makeBirdTexture(scene);
  makeInsectTexture(scene);
  for (let v = 0; v < 4; v++) makeTreeTexture(scene, v);
  for (let k = 0; k < 4; k++) makePropTexture(scene, k);
  makeGroundTexture(scene, worldW, worldH);
}

export { S as LOGICAL_SIZE, SCALE as PIXEL_SCALE };
