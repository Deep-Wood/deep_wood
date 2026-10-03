/**
 * Forest scene: the playable core.
 *
 * A hunter walks a real world. Walking over a dig node starts a hunt, the
 * roll comes from the shared hunt engine (the same module the contract
 * mirrors), and the find animates out of the ground. Nothing here touches a
 * contract -- settlement is a separate concern, deliberately.
 */
import Phaser from 'phaser';
import { buildAllTextures, PAL, rng } from './art.js';
import { createAmbience } from './ambience.js';
import { panelFrame } from './layout.js';
import { retireWalletFoot } from './hud-idle.js';

// Bisect switch for the ambience layers. The 2bf3694 deploy added ~730 display
// objects (205 canopy, 376 undergrowth, 152 shadows) and the character stopped
// rendering on a phone inside a WebView, where every scrollFactor 0 layer kept
// drawing and every world object did not -- the signature of a render budget
// being hit rather than a logic error, which is exactly the kind of thing a
// headless harness cannot reproduce.
//
// ?safe=1  -> no ambience objects at all (plain pre-2bf3694 forest)
// ?safe=2  -> chunk decoration only, no camera-global layers
// ?safe=3  -> camera-global layers only, no chunk decoration
//
// If ?safe=1 brings the hunter back, the ambience work is the cause and the fix
// is to cut object count rather than to hunt for a bug that is not there.
const SAFE = (() => {
  const v = new URLSearchParams(window.location.search).get('safe');
  return v ? Number(v) : 0;
})();
/** Whether the per-chunk decoration layers load at all. */
const DECORATE = SAFE !== 1 && SAFE !== 3;
import { rollHunt, RARITY_NAME } from './engine.js';
import {
  CHUNK, chunkOf, describeChunk, nodeKey,
  residentChunks, staleChunks, LOAD_RADIUS,
  depletionStore, saveDepletion, epochFor,
} from './streaming.js';
import {
  newToolbelt, activeTool, consumeUse, claimTool, canClaim,
  repairTool, canRepair, equip, toolCost, repairCost, durabilityOf,
  huntCostWei, expectedHuntWei, roman, fmt, eth, MAX_TIER,
} from './tools.js';
import { DROP_TABLE, PRICE } from './engine.js';
import {
  newSeasonRecord, recordHunt, rank as rankSeason, topN, standing,
  seasonClock, roiPct, eth as fmtEth, onRoiBoard, shortOfFloor,
  TOP_N,
} from './season.js';
import {
  initCommitment, commitSeason, verifySeason, seasonState, rollSeason,
} from './commitment.js';
import {
  onchainActive, mode as chainMode, claimToolOnchain, buyGemsOnchain,
  priceFor, FOR_SALE, RARITY_NAME_ONSALE,
} from './onchain.js';
import sha3 from 'js-sha3';
import {
  TouchState, readIntent, frameScale, touchRects, shouldShowTouch, TOUCH_LAYOUT,
} from './touch.js';

const TILE = 32;

/**
 * Dim the forest behind a sheet-mode panel and let a tap out there close it.
 *
 * The backdrop is added to the panel container FIRST, so it sits behind the body
 * in the display list. That also decides input order: the body rectangle is made
 * interactive immediately afterwards, so taps on the panel itself are swallowed
 * rather than falling through to the backdrop and dismissing it.
 */
function addPanelBackdrop(scene, depth, px, py, pw, ph, onDismiss) {
  const W = scene.scale.width, H = scene.scale.height;
  // A DIRECT SCENE CHILD, deliberately not a member of the panel container.
  //
  // Adding a Game Object to a Container after setInteractive() registers it
  // against the scene and again against the container, leaving the InputPlugin
  // with two entries at identical coordinates. With the default topOnly, the
  // duplicate shadows the original and the handler silently never fires -- the
  // same bug already documented and worked around for the touch zones. The
  // first version of this backdrop was a container child and outside-taps did
  // nothing for exactly that reason.
  // 0.62 was my own pick and it was far too heavy: it darkened the whole forest
  // so heavily that the game above the sheet read as "covered by a card", which
  // is the complaint this was supposed to fix. Enough to push the world back, not
  // enough to hide it.
  const dim = scene.add.rectangle(0, 0, W, H, 0x050a06, 0.38).setOrigin(0)
    .setScrollFactor(0).setDepth(depth).setInteractive({ useHandCursor: true });
  dim.on('pointerdown', (pointer, x, y) => {
    // Ignore taps that land on the panel, so only true outside-taps dismiss it.
    if (x >= px && x <= px + pw && y >= py && y <= py + ph) return;
    onDismiss();
  });
  return dim;
}


// Alpha for the outer hysteresis ring. Low enough that the chunk boundary is a
// gradient rather than a line, high enough that you can still see you are
// approaching the edge of the loaded world.
const FADE_ALPHA = 0.45;

// The beacon is a marker on the forest floor, so it is drawn at ~0.34 of its
// source height (232px -> ~79px), which keeps it clearly shorter than the
// generated trees (~143px).
const BEACON_SCALE = 0.34;
// Retained only for spawn/legacy callers. There is no world extent any more --
// see WORLD_FAR and the chunk streamer.
const WORLD_W = 40, WORLD_H = 30;
// Effectively-unbounded play area. See the setBounds comment in create().
const WORLD_FAR = 1e7;

// The ground is a scrollFactor-0 TileSprite at a FIXED depth, but every world
// object uses its raw world Y as its depth for y-sorting. Those two conventions
// only agree while world Y is non-negative.
//
// The old fixed world was 0..960, so Y never went negative and a ground depth of
// 0 was always at the bottom. The endless world is centred on (0,0), so EVERYTHING
// NORTH OF SPAWN HAS NEGATIVE Y -- which sorts BELOW a ground depth of 0, and the
// ground then draws on top of it. Walking up made the hunter, the trees and the
// nodes vanish behind the grass, while birds and insects (depth 90000+) carried
// on rendering perfectly, which is exactly the symptom reported.
//
// The ground therefore has to sit below the entire playable range, not merely
// below the origin. Bounds are +/-WORLD_FAR, so this is unconditionally lower
// than any object that can ever exist.
const GROUND_DEPTH = -(WORLD_FAR * 2);

const MOVE_SPEED = 150;

/**
 * Largest distance the player may travel in ONE physics step.
 *
 * Arcade separates overlapping bodies only AFTER moving them, so a step wider
 * than the obstacle can skip it entirely. Trunk colliders are 20x14 (a 20x14
 * rectangle at the tree base) and the player's body is 10 wide, so anything at
 * or above 20px risks walking straight through a tree. 12px leaves margin.
 *
 * This cap is why frame-rate compensation is not a complete fix: below ~8fps
 * the game still moves slower than MOVE_SPEED. That is the deliberate trade --
 * correct collision instead of full speed.
 */
const MAX_STEP_PX = 12;

// World sprites y-sort by using their own y as depth, so any UI must sit
// above WORLD_H * TILE. See openBelt().
const UI_DEPTH = 100_000;

/** Register the walk animations from the 4x4 hunter sheet. */
export function registerAnimations(scene) {
  const names = ['down', 'left', 'right', 'up'];
  names.forEach((n, i) => {
    if (scene.anims.exists(`walk-${i}`)) return;
    scene.anims.create({
      key: `walk-${i}`,
      frames: scene.anims.generateFrameNumbers('hunter', { start: i * 4, end: i * 4 + 3 }),
      frameRate: 8,
      repeat: -1,
    });
  });
}

export class ForestScene extends Phaser.Scene {
  constructor() {
    super('forest');
    this.huntIndex = 0;
    this.seed = '0x5eed';
    this.busy = false;
    this.finds = [];
    // Tool progression lives in a belt, not on the scene, so the same rules
    // the contract enforces (sequential, one per tier, one active) apply
    // here. See src/tools.js.
    this.belt = newToolbelt();
    // Season board. Off-chain: hunts are recorded here as they happen, and
    // the same totals would come off the chain once hunts settle.
    this.board = newSeasonRecord(1, Math.floor(Date.now() / 1000));
    this.boardOpen = false;
    this.leaderboardOpen = false;
    this.lastStanding = 0;
    // Commit-then-act: the season root is published BEFORE any hunt, so the
    // engine cannot rewrite results once players have seen them.
    this.seasonSeed = '0x5eed';
    initCommitment(sha3.keccak256);
    this.commitRoot = null;
    this.huntsPerPlayer = 200; // planned ceiling, which is what the root covers
  }

  /**
   * Real art assets, generated through GMI Cloud (see art-src/ and the
   * dw_assets.py pipeline).
   *
   * Everything here is OPTIONAL. Every one of these has a procedural fallback
   * in art.js, and the scene picks the drawn texture whenever the file is
   * missing, so a CDN hiccup degrades to the old look instead of an empty
   * forest. That fallback is why the loads are wrapped rather than allowed to
   * throw.
   */
  preload() {
    const load = (key, url) => {
      try {
        this.load.image(key, url);
      } catch (e) {
        /* the procedural bake will cover for it */
      }
    };
    for (let i = 1; i <= 4; i++) load(`gen-ground-${i}`, `art/ground-${i}.jpg`);
    load('gen-backdrop', 'art/backdrop.jpg');
    load('gen-tree-a', 'art/tree-a.png');
    load('gen-tree-b', 'art/tree-b.png');
    load('gen-mushroom', 'art/mushroom.png');
    load('gen-crystal', 'art/crystal.png');
    load('gen-hunter', 'art/hunter.png');
    load('gen-beacon', 'art/beacon.png');
    // One generated sprite per rarity, so the reveal shows painted gems rather
    // than pixel art. Squared to a common 84x84 at asset-prep time so all five
    // read at the same visual weight.
    load('gen-gem-0', 'art/gem-quartz.png');
    load('gen-gem-1', 'art/gem-amber.png');
    load('gen-gem-2', 'art/gem-sapphire.png');
    load('gen-gem-3', 'art/gem-ruby.png');
    load('gen-gem-4', 'art/gem-diamond.png');
  }

  /** True when the generated art for a role actually loaded. */
  has(key) { return this.textures.exists(key); }

  create() {
    buildAllTextures(this, WORLD_W * TILE, WORLD_H * TILE);
    // Animations can only be registered AFTER the generated spritesheet
    // exists, so this must happen here. Skipping it makes every later
    // anims.play() throw, and the scene renders a static frame with no error
    // visible in the UI -- so it is asserted rather than assumed.
    registerAnimations(this);
    for (let i = 0; i < 4; i++) {
      if (!this.anims.exists(`walk-${i}`)) throw new Error(`walk-${i} not registered`);
    }

    // Effectively no boundary. The character must never hit a wall.
    //
    // Not literally infinite: Arcade physics works in float px, so coordinates
    // far enough out quantise and the sprite jitters or sticks. 1e7px is
    // ~200,000 chunks in every direction and is never reachable in a session,
    // while staying well inside float precision.
    this.physics.world.setBounds(-WORLD_FAR, -WORLD_FAR, WORLD_FAR * 2, WORLD_FAR * 2);

    // --- ground
    //
    // One world-sized texture, not a TileSprite. TileSprite needs a texture
    // the renderer can tile, and a runtime canvas texture (createCanvas)
    // silently falls back to a blank UUID-keyed one -- the floor rendered as
    // flat empty colour and, being added after the world, painted over
    // everything. A 1:1 image has no such constraint.
    // TileSprite at scrollFactor 0 rather than a world-sized image: the ground
    // now repeats under the camera forever. It must be re-sized on viewport
    // resize or it leaves bare colour at the edges on a rotated phone.
    // Pick one of the four generated ground variants per session. One tile
    // repeating is what shows its beat on a phone screen no matter how it is
    // disguised (verified at 390px: the repetition is obvious, not subtle), so
    // the real fix is that this choice is not the same every load.
    const grounds = [1, 2, 3, 4].filter((i) => this.has(`gen-ground-${i}`));
    const groundKey = grounds.length
      ? `gen-ground-${grounds[(Math.random() * grounds.length) | 0]}`
      : 'ground';
    this.bg = this.add.tileSprite(0, 0, this.scale.width, this.scale.height, groundKey)
      .setOrigin(0).setScrollFactor(0).setDepth(GROUND_DEPTH);
    this.scale.on('resize', (size) => this.bg.setSize(size.width, size.height));

    // Macro layer: the big scenic generation, blurred and dimmed, tiled at a
    // different scale from the base and drifting slightly slower. It removes
    // the low-frequency sameness of a single repeating tile. Additive-free and
    // cheap -- one extra full-screen draw.
    if (this.has('gen-backdrop')) {
      this.macro = this.add.tileSprite(0, 0, this.scale.width, this.scale.height, 'gen-backdrop')
        .setOrigin(0)
        .setScrollFactor(0)
        .setDepth(GROUND_DEPTH + 1)
        .setAlpha(0.16)
        .setTileScale(2.4, 2.4);
      this.scale.on('resize', (size) => this.macro.setSize(size.width, size.height));
    }

    // Trees and props are added to the scene (not a container) so each can
    // carry a depth used for y-sorting. A container would render its children
    // in insertion order, which looks wrong the moment the player walks
    // behind a tree.
    this.sortables = [];

    // --- static colliders: tree trunks
    //
    // Only the trunk blocks. A full 64px box would make the canopy feel like
    // a wall; the player should brush past the leaves but not walk through
    // the wood.
    this.trunks = this.physics.add.staticGroup();

    // Content is streamed per chunk from now on; the whole-world placement
    // below is what the endless forest replaces.
    this.chunks = new Map();
    this._lastChunk = null;
    this._pendingChunkReload = null;
    this.epochByKey = depletionStore(this.seasonSeed);
    // NOTE: the first refreshChunks() is NOT called here. It needs this.player
    // (to know which chunk to load) and this.nodes (to push into), and both are
    // created further down. Calling it here threw "Cannot read properties of
    // undefined (reading 'x')" and left the scene never booting.

    // --- dig nodes: the huntable spots
    //
    // The fixed findSpots(24) roster that used to live here is gone: nodes are
    // created per chunk by refreshChunks(), so this array is bookkeeping for
    // what is currently loaded rather than the whole world.
    this.nodes = [];

    // --- the hunter
    // Position is set from a resolved frame, not from a bare texture key.
    this.player = this.physics.add.sprite(0, 0, 'hunter', 0);

    // The generated sheet is 16 logical px at 4x = 64px. The world tile is
    // 32px, so draw the character at 0.5 to keep it tile-sized.
    this.player.setScale(0.5);

    // Swap in the generated hunter, AFTER the setScale above so it is not
    // overwritten by it. He is a single still, so the four-frame walk animations
    // cannot apply -- the drawn sheet stays loaded but is no longer the visual.
    // Physics is untouched: still the same 10px body the balance and every
    // collision test were tuned against.
    // `genHunter` gates the animation calls below. Both animatePlayer() and
    // animateIdle() write the player's texture every single frame -- one via
    // anims.play(), the other via setFrame() -- and both target the DRAWN sheet.
    // Setting the texture here without gating them meant the generated hunter
    // lasted less than one frame, which looked exactly like the swap never
    // happened.
    if (this.has('gen-hunter')) {
      this.genHunter = true;
      this.player.setTexture('gen-hunter');
      this.player.setOrigin(0.5, 0.72);
      this.player.setScale(0.62);
    }
    this.player.setCollideWorldBounds(true);
    // Collision box at the character's feet. Offsets are in SOURCE pixels of
    // the 64x64 sheet; the box is 10x8 source px, so it must sit at the
    // bottom-centre, well inside the 64x64 bounds.
    this.player.body.setSize(10, 8);
    this.player.body.setOffset(27, 46);

    // Trees block. Dig nodes and props deliberately do not -- a node you
    // cannot step onto is a node you cannot hunt.
    this.physics.add.collider(this.player, this.trunks);

    // The lantern rides with him, additively, one depth below. Sized to the
    // character so it reads as carried light rather than a spotlight.
    if (this.textures.exists('lantern')) {
      this.lantern = this.add.image(0, 0, 'lantern')
        .setDepth(-1)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.9)
        .setAlpha(0.85);
      this.lantern.setPosition(this.player.x, this.player.y);
    }

    // footstep dust
    this.dust = this.add.particles(0, 0, 'spark', {
      speed: { min: 5, max: 20 }, scale: { start: 0.15, end: 0 },
      lifespan: 300, quantity: 1, emitting: false,
    }).setDepth(1);

    // The scene deliberately does NOT dismiss the splash. It used to, 120ms
    // into create(), and that call was the reason the logo never appeared: it
    // bypassed the splash's own gate and added `.done` at ~2.7s while the
    // emblem was still unpainted. The splash is owned by one script in
    // index.html which decodes the image, holds a floor, and has a ceiling. The
    // game has no opinion about it.

    this.commitSeasonNow();
    this.seedRivals();
    this.setupInput();
    this.setupCamera();
    // First world stream: the hunter and the node list now exist, so the
    // origin neighbourhood can finally be built.
    this.refreshChunks(true);

    // Ambience is created AFTER the first stream and lives for the life of the
    // scene. It is camera-global by design -- see ambience.js -- so it must not
    // be part of any chunk's unload set.
    // SAFE 2 is "chunk decoration only" and must keep the ambience OFF, which it
    // was not doing. SAFE 3 is the discriminator: camera-global layers only, with
    // every chunk decoration object gone. If the hunter returns under ?safe=3 the
    // chunk objects are at fault; if it stays broken, the camera-global layers
    // are. As shipped, 3 was a duplicate of 1 and could not answer that.
    this.ambience = SAFE === 1 || SAFE === 2 ? null : createAmbience(this);
    this.setupHud();
    // The shop lives in the DOM top bar, so the rows are plain descriptors here
    // and syncBeltDom() renders them.
    this.shopRows = FOR_SALE.map((rarity) => ({ rarity, label: '', buyLabel: 'buy' }));
    // The toolbelt rows are built inside setupHud now, so they must be filled
    // once at boot. They were previously filled as a side effect of opening a
    // panel, which left the card blank until something happened to happen.
    this.refreshBelt();
    this.setupTouch();

    // Independent of Phaser's delta, which is the value that lies on a slow
    // device. See frameScale().
    this._lastRealTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this.cameras.main.fadeIn(400, 0, 0, 0);
    this.updateHud();
  }

  /**
   * Publish the season commitment BEFORE any hunt is rolled.
   *
   * commit-then-act (SPEC section 9): the root covers every (player,
   * huntIndex) leaf the season will ever settle, so the engine cannot
   * rewrite the season after players have seen results. In a real
   * deployment this root is what goes to commitSeason(bytes32) on-chain; here
   * it is computed and displayed so the player can verify it locally, and
   * verifySeason() re-derives it from the same inputs.
   */
  commitSeasonNow() {
    const plan = [
      { player: this.wallet ?? '0xplayer', hunts: this.huntsPerPlayer },
      ...this.rivalNames().map((n) => ({ player: n, hunts: this.huntsPerPlayer })),
    ];
    const c = commitSeason(this.seasonSeed, plan);
    this.commitRoot = c.root;
    this.commitLeafCount = c.leafCount;
    this.commitPlan = plan;
    this.board.committed = true;
    this.board.commitRoot = c.root;
    return c;
  }

  /** The opponent list, shared with seedRivals() so both agree. */
  rivalNames() {
    return [
      '0xMoss', '0xFern', '0xAlder', '0xBirch', '0xRowan', '0xYew',
      '0xHazel', '0xLarch', '0xAspen', '0xWillow', '0xMaple', '0xElm',
    ];
  }

  /**
   * Player-side verification: recompute the root from the season seed and
   * the published plan, and compare it against what was committed. This is
   * the check that makes the commitment mean anything -- it does not trust
   * the operator's word for it.
   */
  verifyCommitment() {
    if (!this.commitRoot) return { ok: false, reason: 'no commitment published' };
    return verifySeason(this.seasonSeed, this.commitPlan, this.commitRoot);
  }

  /**
   * Simulated opponents, so the board shows a real ranking rather than one
   * player at rank 1 of 1.
   *
   * These are LOCAL SIMULATIONS. They are deliberately generated with a
   * spread of skill and spend, and deliberately NOT flattering: one of them
   * beats the starting player, so the board has something to climb toward.
   * A real deployment replaces this wholesale with settled chain data.
   */
  seedRivals() {
    const now = Math.floor(Date.now() / 1000);
    const names = this.rivalNames();
    // (hunts, luck): more hunts AND luckier finds = higher ROI.
    // Hunt counts must clear the 0.005 ETH splay floor for the player's
    // tier: 50 tier-1, 25 tier-2, 13 tier-3 hunts. Below that the player is
    // correctly EXCLUDED from the board, which would leave the demo board
    // thin. A couple near the bottom are deliberately left just above it.
    const shapes = [
      [420, 0.55], [380, 0.50], [300, 0.62], [260, 0.45], [210, 0.58],
      [180, 0.40], [150, 0.52], [120, 0.66], [95, 0.48], [70, 0.58],
      [55, 0.61], [51, 0.50],
    ];
    const r = () => Math.random();
    names.forEach((n, i) => {
      const [hunts, luck] = shapes[i];
      const tier = hunts > 300 ? 3 : hunts > 120 ? 2 : 1;
      for (let h = 0; h < hunts; h++) {
        // Roughly reproduce the drop table by rarity, nudged by luck.
        const counts = [0, 0, 0, 0, 0];
        const n2 = 3 + Math.floor(r() * 3);
        for (let k = 0; k < n2; k++) {
          let rar;
          if (tier === 1) rar = r() < 0.85 ? 0 : 1;
          else if (tier === 2) rar = r() < 0.68 ? 0 : r() < 0.92 ? 1 : 2;
          else rar = r() < 0.5 ? 0 : r() < 0.78 ? 1 : r() < 0.96 ? 2 : r() < 0.995 ? 3 : 4;
          if (r() > luck && rar > 0) rar -= 1; // unlucky finds lose a rarity
          counts[rar]++;
        }
        recordHunt(this.board, n, counts, tier, now - 1000);
      }
    });
  }

  /* ---------------- world building ---------------- */

  /** Bushes, rocks, grass tufts and flowers. Purely decorative. */

  // ---------------- endless forest: chunk streaming ----------------

  /**
   * Bring the loaded chunk set in line with the player's position.
   * Cheap to call every frame -- it early-returns unless the player has crossed
   * a chunk boundary, so the common case is one comparison.
   */
  refreshChunks(force = false) {
    const [cx, cy] = chunkOf(this.player.x, this.player.y);
    if (!force && this._lastChunk && this._lastChunk[0] === cx && this._lastChunk[1] === cy) return;
    this._lastChunk = [cx, cy];

    const wanted = residentChunks(this.player.x, this.player.y);
    for (const key of staleChunks(this.chunks.keys(), wanted)) this.unloadChunk(key);
    for (const [key, [kx, ky]] of wanted) {
      if (!this.chunks.has(key)) this.loadChunk(key, kx, ky);
    }

    // Fade the outer ring. This is the answer to "can you see where a chunk
    // ends": the boundary is where alpha drops, so there is no hard edge to
    // notice. Applied here, on the chunk crossing, NOT every frame -- a
    // per-frame tween across ~1200 objects would cost more than it is worth.
    const [pcx, pcy] = [cx, cy];
    for (const [key, c] of this.chunks) {
      const d = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cy - pcy));
      const a = d <= LOAD_RADIUS ? 1 : FADE_ALPHA;
      if (c.fade === a) continue;
      c.fade = a;
      for (const o of c.objs) o.setAlpha?.(a * (o.getData?.('baseAlpha') ?? 1));
    }
  }

  loadChunk(key, cx, cy) {
    const data = describeChunk(this.seasonSeed, cx, cy);
    const objs = [];

    // Two generated trees instead of four drawn ones. They are 2x the size the
    // game draws at and get halved here, so they stay crisp on a high-DPI phone
    // without changing the collider geometry the balance depends on.
    const treeKeys = ['gen-tree-a', 'gen-tree-b'].filter((k) => this.has(k));
    const treeScale = treeKeys.length ? 0.78 : 1;
    for (const t of data.trees) {
      const key = treeKeys.length ? treeKeys[t.v % treeKeys.length] : `tree${t.v}`;
      const img = this.add.image(t.x, t.y, key).setOrigin(0.5, 0.9).setDepth(t.y);
      if (treeKeys.length) {
        // Vary the scale per tree. Every generated tree was drawn at exactly
        // 0.78, so 149 identical sizes repeated two silhouettes in lockstep --
        // which is the same repetition problem as a single tiling ground, and
        // the reason the forest read as copy-pasted next to crystals (63
        // distinct sizes) and mushrooms (146).
        //
        // Derived from the tree's OWN seeded record (v, x, y) rather than a
        // fresh RNG draw, so the same tree is always the same size: chunk
        // placement, determinism and settlement are all untouched. Only the
        // drawn size changes.
        // Non-negative modulo. JS `%` keeps the sign of the dividend, and
        // world coordinates go negative, so a plain `% 37` produced jitter down
        // to -0.36 and trees as small as 0.367 -- well under the intended floor
        // of 0.64, so saplings appeared. `((n % 37) + 37) % 37` is always in
        // [0, 37).
        const seed = t.v * 7 + Math.round(t.x) * 13 + Math.round(t.y) * 29;
        const jitter = (((seed % 37) + 37) % 37) / 100;
        img.setScale(treeScale * (0.82 + jitter));
      }
      this.sortables.push(img);
      objs.push(img);
      // Trunk-only collider, matching the old fixed world exactly: a 20x14 box
      // at the base, so the canopy overhangs and the forest reads as walkable
      // rather than a maze.
      const body = this.add.rectangle(t.x, t.y - 4, 20, 14);
      this.physics.add.existing(body, true);
      this.trunks.add(body);
      objs.push(body);
    }

    for (const p of data.props) {
      // The drawn rock (kind 1) is retired. It was four grey rectangles in a
      // neutral 0x6e6e6e with no hue in it, which read as a concrete block
      // against a blue-green forest rather than as stone. Skipping it here
      // rather than in the generator keeps the seeded prop stream intact: the
      // RNG draws the same sequence either way, so chunk placement and
      // determinism are untouched and only the sprite disappears.
      if (p.k === 1) continue;
      const img = this.add.image(p.x, p.y, `prop${p.k}`)
        .setOrigin(0.5, 0.9).setDepth(p.y).setAlpha(0.92);
      this.sortables.push(img);
      objs.push(img);
    }

    // Ground shadows sit just below their tree in the y-sort so they anchor it
    // to the grass instead of floating. Derived from tree positions upstream, so
    // they cost one draw call each and need no RNG here.
    if (DECORATE) for (const s of data.shadows || []) {
      const img = this.add.image(s.x, s.y, 'shadow').setDepth(s.y - 2).setAlpha(0.5);
      // userData does not exist until setData() is called in Phaser -- assigning to it
      // directly throws "Cannot set properties of undefined" and takes the whole
      // scene down at boot. Caught by the reporter on the first run.
      img.setData('baseAlpha', 0.5);
      objs.push(img);
    }

    // Canopy is NOT y-sorted. Fixed at a high depth so the player walks UNDER
    // the leaves; y-sorting it would slide the canopy behind the player the
    // moment they stepped north of a tree, which reads as a bug, not a forest.
    if (DECORATE) for (const c of data.canopy || []) {
      const img = this.add.image(c.x, c.y, 'canopy')
        .setDepth(50000).setAlpha(0.3).setScale(c.s);
      img.setData('baseAlpha', 0.3);
      objs.push(img);
    }

    // Undergrowth is y-sorted with the ground so the player walks in front of
    // tufts below them and behind them above.
    if (DECORATE) for (const u of data.undergrowth || []) {
      const a = 0.75 + u.shade * 0.25;
      const img = this.add.image(u.x, u.y, `under${u.k}`)
        .setOrigin(0.5, 0.95).setDepth(u.y).setAlpha(a);
      img.setData('baseAlpha', a);
      this.sortables.push(img);
      objs.push(img);
    }

    // Bioluminescent mushrooms. Y-sorted with the ground like the undergrowth,
    // so the player walks in front of the ones below him and behind the ones
    // above.
    //
    // No additive halo sprite. There was one per mushroom, and measured across
    // the 25-chunk resident set that was ~230 extra objects for a glow the cap
    // sprite already carries. The `glow` flag still varies cap brightness and
    // scale, which is where it was doing the work anyway.
    if (DECORATE && this.textures.exists('mushroom')) {
      const genShroom = this.has('gen-mushroom');
      for (const m of data.mushrooms || []) {
        const a = 0.55 + m.s * 0.35;
        const img = this.add.image(m.x, m.y, genShroom ? 'gen-mushroom' : 'mushroom')
          .setOrigin(0.5, 0.95).setDepth(m.y).setAlpha(a)
          // the generated cluster is a whole clump, so it sits smaller than the
          // one-mushroom sprite it replaces
          .setScale(genShroom ? m.s * 0.55 : m.s);
        img.setData('baseAlpha', a);
        this.sortables.push(img);
        objs.push(img);
      }
    }

    // Crystals. Not y-sorted with the ground: they are tall enough to read as
    // standing objects, and a crystal that the player passes behind while it
    // looks like it is in front of him looks broken. Sort them like the trees.
    // Crystal decoration is RETIRED. 73 glowing emerald crystals were scattered
    // around the forest as scenery, and every one of them read as treasure
    // lying about -- which quietly undid the whole beacon design. A beacon that
    // hides its rarity is pointless when the floor is littered with glowing
    // gems. Crystals still exist in TWO places that matter: the beacon light
    // (a cool cyan, not emerald) and the revealed gem sprites, which are the
    // only place the player should see a treasure colour.
    //
    // Skipped at the sprite level rather than in the generator, so the seeded
    // decoration stream still draws the same sequence and determinism holds.
    if (false && DECORATE && this.textures.exists('crystal')) {
      const genX = this.has('gen-crystal');
      for (const c of data.crystals || []) {
        const img = this.add.image(c.x, c.y, genX ? 'gen-crystal' : 'crystal')
          .setOrigin(0.5, 0.9).setDepth(c.y - 6).setAlpha(0.9)
          .setScale(genX ? c.s * 0.62 : c.s);
        img.setData('baseAlpha', 0.9);
        this.sortables.push(img);
        objs.push(img);
        const halo = this.add.image(c.x, c.y, 'glow')
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(c.y - 7)
          .setAlpha(0.22)
          .setScale(0.9 * c.s);
        halo.setData('baseAlpha', 0.22);
        objs.push(halo);
      }
    }

    const nodes = [];
    data.nodes.forEach((n) => {
      // A dug node reappears at a new spot: render at the epoch this chunk's
      // depletion record says it is currently on.
      const epoch = epochFor(this.epochByKey, cx, cy, n.idx);
      const spot = epoch === 0 ? n : describeChunk(this.seasonSeed, cx, cy, epoch).nodes.find((q) => q.idx === n.idx);
      if (!spot) return;

      // The light sits at the beacon's CAP, not at its base. The old glow was
      // pinned to `spot.y + 6` -- dirt level -- which was correct when the
      // marker was a flat ground decal, and wrong for a tall stake: it lit the
      // soil under the post and left the lantern itself dark. Origin is (0.5,
      // 0.85), so the cap lands roughly 0.8 of the sprite's height above the
      // anchor.
      // The beacon was drawn at its full 232px, which made it TALLER than the
      // trees it stands among (143px) -- a stake should read as undergrowth
      // marking the floor, not as the largest thing in the scene. BEACON_SCALE
      // puts it at roughly a third of tree height, so the light has to be what
      // draws the eye rather than the silhouette.
      const genBeacon = this.has('gen-beacon');
      const beaconH = (genBeacon ? 232 : 64) * (genBeacon ? BEACON_SCALE : 1);
      const capY = spot.y - beaconH * (genBeacon ? 0.78 : 0.25);

      const glow = this.add.image(spot.x, capY, 'glow')
        .setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.55).setScale(0.55);
      glow.setDepth(spot.y - 1);
      this.sortables.push(glow);
      objs.push(glow);

      // A second, tighter core so the cap reads as a genuine light source
      // rather than a sprite with a haze behind it.
      const core = this.add.image(spot.x, capY, 'glow')
        .setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.5).setScale(0.2);
      core.setDepth(spot.y - 1);
      this.sortables.push(core);
      objs.push(core);

      // A dig site is marked by a BEACON, not by showing the gem. The node
      // texture is retained underneath (it is what the dig pulse animates and
      // what a dug-out site collapses into), but the beacon is what the player
      // sees while hunting. Identical on every site regardless of what is
      // buried -- the rarity is only ever known after `reveal()` rolls it.
      const marker = this.add.image(spot.x, spot.y, genBeacon ? 'gen-beacon' : 'beacon')
        .setOrigin(0.5, 0.85);
      if (genBeacon) marker.setScale(BEACON_SCALE);
      marker.setData('idx', n.idx);
      marker.setData('epoch', epoch);
      marker.setData('cx', cx);
      marker.setData('cy', cy);
      marker.setDepth(spot.y);
      this.sortables.push(marker);
      this.nodes.push(marker);
      objs.push(marker);
      nodes.push(marker);

      this.tweens.add({
        targets: marker, y: spot.y - 3, duration: 900 + n.idx * 37,
        yoyo: true, repeat: -1, ease: 'Sine.inOut',
      });
      this.tweens.add({
        targets: glow, alpha: 0.40, duration: 1100 + n.idx * 53,
        yoyo: true, repeat: -1, ease: 'Sine.inOut',
      });
      this.tweens.add({
        targets: core, alpha: 0.28, duration: 760 + n.idx * 41,
        yoyo: true, repeat: -1, ease: 'Sine.inOut',
      });
    });

    this.chunks.set(key, { objs, nodes, cx, cy, fade: 1 });
  }

  unloadChunk(key) {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const o of c.objs) {
      // Stop the idle bob/pulse tweens before destroying their targets, or the
      // tween keeps writing to a destroyed object every frame.
      this.tweens.killTweensOf(o);
      if (o.destroy) o.destroy();
    }
    for (const n of c.nodes) {
      const i = this.nodes.indexOf(n);
      if (i >= 0) this.nodes.splice(i, 1);
    }
    for (const o of c.objs) {
      const i = this.sortables.indexOf(o);
      if (i >= 0) this.sortables.splice(i, 1);
    }
    // Trunk colliders are static bodies; they must leave the physics world, not
    // just the display list, or a "destroyed" tree keeps blocking the player.
    for (const o of c.objs) {
      if (o.body && this.trunks.has(o)) this.trunks.remove(o);
    }
    // NOTE: do NOT call physics.world.colliders.destroy() here. It destroys
    // EVERY collider in the world, including the player-vs-trunk collider set up
    // in create(), so the first chunk unload would leave the player walking
    // straight through every tree in the forest. Destroying the body above is
    // what removes a single static collider.
    this.chunks.delete(key);
  }

  /** Record a dig and respawn that node elsewhere in the same chunk. */
  markNodeDug(node) {
    const cx = node.getData('cx'), cy = node.getData('cy'), idx = node.getData('idx');
    if (cx === undefined) return;
    const key = `${cx},${cy}`;
    this.epochByKey[nodeKey(cx, cy, idx, 0)] = ((this.epochByKey[nodeKey(cx, cy, idx, 0)] | 0) + 1);
    saveDepletion(this.seasonSeed, this.epochByKey);

    // The chunk is NOT reloaded here. This runs at the START of the dig, while
    // the dig animation still holds a reference to `node` -- unloading now
    // destroys that node mid-animation. The reload is deferred until the dig is
    // over.
    const c = this.chunks.get(key);
    if (c) this._pendingChunkReload = key;
  }

  /** Finish a dig: rebuild the chunk so the emptied node respawns elsewhere. */
  completeNodeDig() {
    const key = this._pendingChunkReload;
    if (!key) return;
    this._pendingChunkReload = null;
    if (this.chunks.has(key)) {
      const [cx, cy] = key.split(',').map(Number);
      this.unloadChunk(key);
      this.loadChunk(key, cx, cy);
    }
  }

  setupCamera() {
    const cam = this.cameras.main;
    // No camera bounds -- same reason as the physics bounds.
    cam.startFollow(this.player, true, 0.12, 0.12);
    cam.setDeadzone(120, 90);
  }

  setupInput() {
    this.keys = this.input.keyboard.addKeys({
      up: 'W', down: 'S', left: 'A', right: 'D',
      up2: 'UP', down2: 'DOWN', left2: 'LEFT', right2: 'RIGHT',
      interact: 'SPACE',
      belt: 'TAB',
      board: 'L',
    });
    // TAB moves focus in the browser and would leave the canvas unusable, so
    // it is claimed here. preventDefault is what stops the page scrolling or
    // tabbing away mid-hunt.
    this.input.keyboard.addCapture('TAB');
  }

  /* ---------------- on-screen controls ---------------- */

  /**
   * Build the d-pad, HUNT, BELT and BOARD as real Phaser zones.
   *
   * The game was keyboard-only, so a phone had nothing to press: not a broken
   * control scheme, an absent one. These are drawn from `touch.js`, which owns
   * the layout maths and the multi-touch bookkeeping, so this method is only
   * about pixels and pointer events.
   *
   * Pointer events (not touch events) throughout, so the same zones work for a
   * finger, a stylus and a mouse in a desktop browser's device-emulation mode --
   * which is also how the smoke test drives them.
   */
  setupTouch() {
    this.touchState = new TouchState();
    this.touchLayer = this.add.container(0, 0)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH + 2);

    // Force-visible from the harness, which cannot rely on device detection.
    const forced = typeof window !== 'undefined'
      ? window.__forceTouchControls
      : undefined;
    this.touchVisible = shouldShowTouch(this.game, forced);
    if (!this.touchVisible) {
      this.touchLayer.setVisible(false);
      return;
    }

    this.layoutTouch();

    // RESIZE mode does not re-run create(), so the pad has to be repositioned
    // by hand. Without this, rotating a phone leaves the controls off-screen.
    this.scale.on('resize', () => this.layoutTouch());

    // Losing focus mid-press (a notification, a tab switch) never delivers
    // pointerup, which would otherwise leave a direction stuck on.
    this.game.events.on('blur', () => this.touchState.clear());
  }

  /** Recompute every control's geometry from the current viewport. */
  layoutTouch() {
    if (!this.touchLayer) return;

    // Disable the outgoing zones BEFORE destroying them.
    //
    // removeAll(true) destroys the objects but does NOT remove them from the
    // InputPlugin's list, because setInteractive() registered them against the
    // scene. A stale zone at the same coordinates as a live one shadows it --
    // `topOnly` dispatches to the topmost hit, which is the dead one, so the
    // button silently did nothing. Measured: 14 input entries for 7 buttons,
    // because setupTouch() plus the RESIZE handler both ran layoutTouch() at
    // boot and left 7 corpses behind.
    for (const z of this.touchZones || []) {
      z.zone.disableInteractive();
      z.zone.destroy();
    }
    this.touchZones = [];
    this.touchLayer.removeAll(true);

    const W = this.scale.width, H = this.scale.height;
    const r = touchRects(W, H);
    // Kept on the scene so the toolbelt drawer can position itself clear of the
    // TOOLBELT / BOARD buttons instead of covering them.
    this.touchRects = r;

    // Rebuild rather than mutate: the rectangles all change on resize and
    // tracking nine zones' geometry by hand is how they end up mismatched.
    const zone = (btn, rect, label, opts = {}) => {
      // Alpha was 0.34 for the d-pad (0.42 HUNT, 0.30 BOARD) and stayed there
      // when the 3D faces were added, so face AND base were both translucent
      // and the extrusion had no solid mass to sit on -- the buttons read as
      // glassy smudges rather than pressed metal. The d-pad is the worst case:
      // at 0.34 over a dark forest floor it was barely legible.
      const { radius = 0, fontSize = 13, alpha = 0.9, tint = 0x9fbc9f } = opts;
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;

      // 3D: each button is a FACE plus an EXTRUDED BASE offset down-right, so
      // the light appears to come from up-left. Two pieces rather than one
      // gradient, because a single shape reads as flat regardless of shading.
      //
      // DEPTH is the extrusion in px. It is proportional to the button so a
      // 38px HUNT and a 46px d-pad key get the same visual weight rather than
      // the small one looking moulded and the large one stamped.
      const DEPTH = Math.max(2, Math.round(Math.min(rect.w, rect.h) * 0.13));
      const BASE = 0x050a07;        // the extruded side, in shadow
      const FACE = 0x1b3322;        // the top surface
      const EDGE = 0x4e8a63;        // rim light on the up-left lip
      // The base is drawn FULLY OPAQUE regardless of the button's alpha. A
      // translucent extrusion makes the whole thing look like a smudge: the eye
      // reads the shadowed side as part of the forest and the face as a tint on
      // top of it, so the button loses its edge. The alpha still controls the
      // face, so a quiet button reads quieter -- but it keeps a solid body.
      const dx2 = Math.max(1, Math.round(DEPTH * 0.5));
      const dy2 = DEPTH;

      const place = (shape) => {
        const a = shape === 'base' ? 1 : alpha;
        if (radius) {
          return this.add.circle(shape === 'base' ? cx + dx2 : cx, shape === 'base' ? cy + dy2 : cy,
            rect.w / 2, shape === 'base' ? BASE : FACE, a);
        }
        return this.add.rectangle(
          rect.x + (shape === 'base' ? dx2 : 0), rect.y + (shape === 'base' ? dy2 : 0),
          rect.w, rect.h, shape === 'base' ? BASE : FACE,
        ).setOrigin(0).setAlpha(a);
      };

      const base = place('base');
      const bg = place('face');

      // Rim light along the top and left edges only -- that asymmetry is what
      // sells the lit-from-up-left reading. A full outline would flatten it back
      // into a sticker.
      if (radius) {
        bg.setStrokeStyle(1, EDGE, alpha);
      } else {
        const rim = this.add.graphics();
        rim.lineStyle(1, EDGE, alpha);
        rim.beginPath();
        rim.moveTo(rect.x, rect.y + rect.h);
        rim.lineTo(rect.x, rect.y);
        rim.lineTo(rect.x + rect.w, rect.y);
        rim.strokePath();
        this.touchLayer.add(rim);
      }

      const text = this.add.text(cx, cy, label, {
        fontFamily: 'monospace',
        fontSize: `${fontSize}px`,
        color: `#${tint.toString(16).padStart(6, '0')}`,
      }).setOrigin(0.5);

      this.touchLayer.add([base, bg, text]);

      // The hit area is a DIRECT SCENE CHILD, not a member of touchLayer.
      //
      // Adding a Game Object to a Container after setInteractive() registers
      // it against the scene and then again against the container, and the
      // InputPlugin ends up holding two entries per button at identical
      // coordinates (measured: 14 entries for 7 buttons). With the default
      // topOnly, dispatch goes to the topmost hit, so a button can be shadowed
      // by a duplicate of itself and silently do nothing. Zones carry no pixels,
      // so grouping them with the artwork bought nothing and cost the input
      // list. scrollFactor 0 + an explicit depth keep them pinned to the screen
      // and above the world.
      const z = this.add.zone(cx, cy, rect.w, rect.h)
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(UI_DEPTH + 2)
        .setInteractive({ useHandCursor: true });

      // The pointer argument is required on release as well as press: the
      // release path needs the SAME pointerId to clear that pointer's entry,
      // and a handler that omits the parameter throws ReferenceError the moment
      // a thumb lifts.
      // Press feedback: the FACE sinks to the base's offset, so the button
      // looks pushed in rather than merely faded. A fade alone on a 3D button
      // flattens it exactly when the player is pressing it.
      const restY = bg.y;
      const restX = bg.x;
      z.on('pointerdown', (p) => {
        this.touchState.press(p.pointerId, btn);
        bg.setAlpha(alpha * 0.75);
        if (radius) bg.setPosition(restX, restY + dy2 - dx2);
        else bg.setPosition(restX + dx2, restY + dy2);
      });
      const release = (p) => {
        this.touchState.release(p.pointerId);
        bg.setAlpha(alpha);
        bg.setPosition(restX, restY);
      };
      z.on('pointerup', release);
      z.on('pointerout', release);

      this.touchZones.push({ btn, zone: z, bg, rect });
      return z;
    };

    const ARROW = { fontSize: 20, tint: 0x9fbc9f };
    zone('up', r.up, '^', ARROW);
    zone('left', r.left, '<', ARROW);
    zone('right', r.right, '>', ARROW);
    zone('down', r.down, 'v', ARROW);

    // Dead-zone hub: drawn so a resting thumb has a home, but NOT interactive.
    this.touchLayer.add(this.add.circle(
      r.hub.x + r.hub.w / 2, r.hub.y + r.hub.h / 2, 7, 0x0d1a10, 0.5,
    ).setStrokeStyle(1, 0x3f8a52));

    // HUNT is the core verb, so it gets its own large target rather than
    // living on the d-pad where it competes with the directions.
    zone('hunt', r.hunt, 'HUNT', { radius: 1, fontSize: 15, alpha: 0.96, tint: 0x6fd08c });

    // Only BOARD. The TOOLBELT button is gone: the toolbelt is permanent rows
    // in the top card, so there is nothing left to open.
    zone('board', r.board, 'BOARD', { fontSize: 11, alpha: 0.82, tint: 0x86a98c });

    this.touchLayer.setVisible(this.touchVisible);

    // The find log lived bottom-left, which is now under the d-pad. Move it up
    // rather than letting the pad cover a log the player is reading.
    if (this.logText) this.logText.setPosition(12, 96);
    this._touchLogMoved = true;
  }

  /** True when the on-screen controls are up. Used by the HUD hint text. */
  get hasTouchPad() {
    return !!(this.touchLayer && this.touchLayer.visible);
  }

  /* ---------------- HUD ---------------- */

  setupHud() {
    const W = this.scale.width, H = this.scale.height;
    this.hud = this.add.container(0, 0).setScrollFactor(0).setDepth(UI_DEPTH);

    // The toolbelt is NOT drawn here. The card the player actually sees --
    // Season I, Rank, ROI, the chain chip, Connect wallet -- is the DOM top bar
    // in index.html, and it paints OVER this canvas. Belt rows drawn here were
    // completely hidden underneath the wallet chips. It lives in that top bar
    // now; see syncBeltDom().
    const panel = this.add.rectangle(10, 10, 250, 74, 0x0d1a10, 0.82)
      .setOrigin(0).setStrokeStyle(2, 0x3f8a52);
    this.hud.add(panel);

    this.hudText = this.add.text(22, 20,
      'DeepWood', { fontFamily: 'monospace', fontSize: '15px', color: '#e8f0e0' });
    this.hud.add(this.hudText);

    this.durBarBg = this.add.rectangle(22, 44, 200, 10, 0x1a2a1a).setOrigin(0);
    this.durBar = this.add.rectangle(22, 44, 200, 10, 0x3f8a52).setOrigin(0);
    this.hud.add([this.durBarBg, this.durBar]);

    this.tierText = this.add.text(22, 60,
      'Tool I  -  WASD move  -  SPACE hunt', {
      fontFamily: 'monospace', fontSize: '11px', color: '#9fbc9f',
    });
    this.hud.add(this.tierText);

    // find log, bottom left.
    // wordWrap is load-bearing: the idle line is 57 characters of monospace and
    // ran straight off the right edge of a 390px phone, so the tail ("press
    // SPACE") was cropped and the instruction was unreadable. It is clamped to
    // the screen minus its own margin and padding, and the real width is
    // recomputed on resize.
    this.logText = this.add.text(12, H - 96, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#cfe0cf',
      backgroundColor: '#060e11cc', padding: { x: 8, y: 6 },
      wordWrap: { width: Math.max(120, W - 40), useAdvancedWrap: true },
    });
    this.hud.add(this.logText);

    // prompt shown when near a node
    this.prompt = this.add.text(W / 2, H - 70, '', {
      fontFamily: 'monospace', fontSize: '14px', color: '#fff8d0',
      backgroundColor: '#0d1a10cc', padding: { x: 10, y: 6 },
    }).setOrigin(0.5).setVisible(false);
    this.hud.add(this.prompt);
  }

  updateHud() {
    const tool = activeTool(this.belt);
    const pct = tool ? tool.left / tool.max : 0;
    this.durBar.width = 200 * pct;
    this.durBar.fillColor = pct > 0.4 ? 0x3f8a52 : pct > 0.15 ? 0xd9a441 : 0xd83a5a;

    const tierName = tool ? `Tool ${roman(tool.tier)}` : 'TOOL BROKEN';
    const uses = tool ? `${tool.left}/${tool.max}` : '--';

    // Name the controls the player actually has. Telling a phone player to
    // "press SPACE" is the same defect as having no button: the instruction
    // refers to hardware they do not have.
    const hint = this.hasTouchPad
      ? 'use the pad to move  -  HUNT to dig  -  BOARD'
      : 'WASD move  -  SPACE hunt  -  L board';

    this.tierText.setText(
      `${tierName}  ${uses} uses   ${fmt(this.belt.common)} Common   ${hint}`
    );
    this.tierText.setColor(tool ? '#9fbc9f' : '#d83a5a');

    // Show every find, quartz included. Filtering quartz out made the log
    // read "no finds yet" while the satchel held gems -- the two panels
    // disagreed because only the log had the filter.
    const lines = this.finds.slice(-5).map((f) => {
      const name = RARITY_NAME[f.rarity] || 'Quartz';
      return `found ${name} x${f.count}  =  ${(Number(f.valueWei) / 1e18).toFixed(5)} ETH`;
    });
    // The wrap width is fixed at construction from the width at that moment, so
    // a rotate or a window resize would leave it stale and the line would crop
    // again. Re-clamp whenever the HUD text is rebuilt. The applied width is
    // tracked here rather than read back off the Text: Phaser does not expose
    // wordWrap as a readable property, and `this.logText.wordWrap.width` threw
    // "Cannot read properties of undefined" and took the whole scene down.
    const logMax = Math.max(120, this.scale.width - 40);
    if (this._logWrap !== logMax) {
      this._logWrap = logMax;
      this.logText.setWordWrapWidth(logMax, true);
    }
    this.logText.setText(lines.length ? lines.join('\n')
      : (this.hasTouchPad
        ? 'no finds yet - walk to a glowing stone and tap HUNT'
        : 'no finds yet - walk to a glowing stone and press SPACE'));
  }

  /* ---------------- season leaderboard ---------------- */

  /**
   * The season board (SPEC section 9).
   *
   * Ranks EFFICIENCY, not wealth: rarity-weight earned per ETH spent. The
   * headline row deliberately leads with ROI, not value, because that is the
   * design's whole claim -- a whale playing identically to a small player
   * posts an identical number.
   *
   * Opens with L. Rivals are simulated locally; the real board would be
   * assembled from settled chain data.
   */
  openLeaderboard() {
    if (this.leaderboardOpen) return;
    this.leaderboardOpen = true;
    this.releaseTouch();

    const W = this.scale.width, H = this.scale.height;
    // Was a hardcoded 430x396 centred -- on a 390px phone that is WIDER than the
    // screen, so this panel started at x = -56 and ran off the left edge.
    const f = panelFrame(W, H, 430, 396);
    const { pw, ph, px: cx, py: cy, sheet } = f;

    const c = this.add.container(0, 0).setScrollFactor(0).setDepth(UI_DEPTH);
    if (sheet) {
      this.lbBackdrop = addPanelBackdrop(
        this, UI_DEPTH - 1, cx, cy, pw, ph, () => this.closeLeaderboard(),
      );
    }
    this.lbFrame = { pw, ph, px: cx, py: cy, sheet };
    c.add(this.add.rectangle(cx + 4, cy + 5, pw, ph, 0x000000, 0.5).setOrigin(0));
    c.add(this.add.rectangle(cx, cy, pw, ph, 0x0b1710, 1).setOrigin(0)
      .setStrokeStyle(2, 0x3f8a52));
    c.add(this.add.rectangle(cx + 1, cy + 1, pw - 2, 28, 0x16281a, 1).setOrigin(0));

    const now = Math.floor(Date.now() / 1000);

    c.add(this.add.text(cx + 14, cy + 8, 'SEASON I  -  VERDANT HOLLOW', {
      fontFamily: 'monospace', fontSize: '14px', color: '#e8f0e0',
    }));
    c.add(this.add.text(cx + 14, cy + 34, `ends in ${seasonClock(this.board, now)}`, {
      fontFamily: 'monospace', fontSize: '12px', color: '#d9a441',
    }));

    // Explain the metric, because an unexplained ROI number means nothing.
    c.add(this.add.text(cx + 14, cy + 52,
      'ranked by EFFICIENCY: rarity-weight per ETH spent', {
      fontFamily: 'monospace', fontSize: '11px', color: '#9fbc9f',
    }));
    c.add(this.add.text(cx + 14, cy + 66,
      'not by wealth - a whale playing like you scores the same', {
      fontFamily: 'monospace', fontSize: '11px', color: '#7a8a7a',
    }));

    // column header
    const hdr = `${'#'.padEnd(4)}${'PLAYER'.padEnd(12)}${'ROI'.padStart(11)}${'BEST'.padStart(12)}`;
    c.add(this.add.text(cx + 14, cy + 88, hdr, {
      fontFamily: 'monospace', fontSize: '11px', color: '#7a8a7a',
    }));

    const me = this.wallet ?? '0xplayer';
    const rows = rankSeason(this.board);
    const list = rows.slice(0, TOP_N);
    const iAmHere = list.some((r) => r.address === String(me).toLowerCase());
    if (!iAmHere && rows.length) list.push(rows.find((r) => r.address === String(me).toLowerCase()));

    let y = cy + 104;
    for (const r of list) {
      if (!r) continue;
      const isMe = r.address === String(me).toLowerCase();
      c.add(this.add.text(cx + 14, y,
        `${String(r.rank).padEnd(4)}${(isMe ? 'YOU' : r.address.slice(0, 10)).padEnd(12)}` +
        `${roiPct(r).padStart(11)}${fmtEth(r.bestWei).padStart(12)}`, {
        fontFamily: 'monospace', fontSize: '12px',
        color: isMe ? '#fff8d0' : r.rank <= 3 ? '#3f8a52' : '#cfe0cf',
      }));
      y += 16;
    }

    if (!rows.length) {
      c.add(this.add.text(cx + 14, cy + 110, 'no hunts recorded this season', {
        fontFamily: 'monospace', fontSize: '12px', color: '#7a8a7a',
      }));
    }

    // my standing, stated plainly
    const st = standing(this.board, me);
    if (!st.ranked) {
      const mine = this.board.players.get(String(me).toLowerCase());
      if (mine && !onRoiBoard(mine)) {
        // The floor excludes sub-floor players rather than damping their
        // score -- a 0.0001 ETH spender scored 819,200x that way, which
        // handed the top of the board to exactly the strategy the floor
        // exists to stop. So say what is needed instead.
        const short = shortOfFloor(mine);
        c.add(this.add.text(cx + 14, cy + ph - 74,
          'not on the board yet - 0.005 ETH splay floor', {
          fontFamily: 'monospace', fontSize: '12px', color: '#d9a441',
        }));
        c.add(this.add.text(cx + 14, cy + 14 + ph - 74 + 14,
          `${fmtEth(mine.ethSpent)} spent, need ${fmtEth(short)} more`, {
          fontFamily: 'monospace', fontSize: '11px', color: '#7a8a7a',
        }));
      }
    }
    if (st.ranked) {
      c.add(this.add.text(cx + 14, cy + ph - 44,
        `you are #${st.rank} of ${st.of}` +
        (st.inTopTen ? '  -  in the prize places' : ''), {
        fontFamily: 'monospace', fontSize: '12px', color: '#fff8d0',
      }));
      if (st.needsToPass) {
        c.add(this.add.text(cx + 14, cy + ph - 28,
          `next rank needs more weight per ETH than ${st.needsToPass.slice(0, 10)}`, {
          fontFamily: 'monospace', fontSize: '11px', color: '#7a8a7a',
        }));
      }
    }

    // Commit-then-act footer. The root is shown so a player can recompute
    // it from the seed and confirm the season was not rewritten.
    const v = this.verifyCommitment();
    const root = this.commitRoot ? this.commitRoot.slice(0, 18) + '...' : 'none';
    c.add(this.add.text(cx + 14, cy + ph - 30,
      `committed root  ${root}  (${this.commitLeafCount} leaves)`, {
      fontFamily: 'monospace', fontSize: '11px',
      color: v.ok ? '#3f8a52' : '#d83a5a',
    }));
    c.add(this.add.text(cx + 14, cy + ph - 14,
      v.ok ? 'root verified against the season seed' : 'VERIFICATION FAILED', {
      fontFamily: 'monospace', fontSize: '11px',
      color: v.ok ? '#7a8a7a' : '#d83a5a',
    }));

    this.lbClose = this.add.text(cx + pw - 30, cy + 8, 'X', {
      fontFamily: 'monospace', fontSize: '14px', color: '#9fbc9f',
    }).setInteractive({ useHandCursor: true });
    c.add(this.lbClose);
    this.lbClose.on('pointerdown', () => this.closeLeaderboard());

    this.lbPanel = c;
  }

  closeLeaderboard() {
    if (!this.lbPanel) return;
    this.lbPanel.destroy(true);
    this.lbPanel = null;
    this.lbBackdrop?.destroy();
    this.lbBackdrop = null;
    this.lbFrame = null;
    if (this.lbOutside) this.input.off('pointerdown', this.lbOutside);
    this.lbOutside = null;
    this.leaderboardOpen = false;
  }

  toggleLeaderboard() {
    if (this.leaderboardOpen) this.closeLeaderboard();
    else {
      this.closeBelt();
      this.openLeaderboard();
    }
  }

  /* ---------------- toolbelt panel ---------------- */

  /**
   * The toolbelt, rendered into the DOM top bar.
   *
   * The card the player actually sees -- Season I, Rank, ROI, the chain chip,
   * Connect wallet -- is the DOM top bar in index.html, and it paints over the
   * canvas. An earlier attempt drew the belt rows into the Phaser HUD and they
   * were entirely invisible underneath the wallet chips.
   *
   * So the belt is DOM. It sits in the top bar's own grid row, which means it
   * takes up space at the top of the screen rather than covering the forest:
   * nothing is hidden, and there is nothing to open or dismiss. The green
   * TOOLBELT button is gone entirely.
   */
  syncBeltDom() {
    const el = document.getElementById('belt');
    if (!el) return;
    const belt = this.belt;

    const q = (id) => document.getElementById(id);
    q('belt-counts').textContent =
      `COMMON ${fmt(belt.common)} · BURNED ${fmt(belt.burned)} · FEES ${fmt(belt.feesPaid)}`;

    const m = chainMode();
    const mode = q('belt-mode');
    mode.textContent = m === 'onchain'
      ? 'ON-CHAIN — writes go to the DeepWood contract'
      : m === 'offline'
        ? 'OFFLINE — no contract configured'
        : 'PREVIEW — simulation only, nothing is on-chain';
    mode.style.color = m === 'onchain' ? 'var(--ok)' : 'var(--warn)';

    // --- tool rows, each with its repair / equip action
    // Interacting with the card keeps it awake.
    for (const id of ['belt-claim-slot', 'belt-shop']) {
      // The idle-fade version of this handler called the keep-awake helper.
      // When the one-shot note replaced the fade that helper was deleted, and
      // this call was left behind -- so every click on CLAIM or a shop buy
      // button threw a ReferenceError on the one path a player cannot work
      // around. Caught by Sentry in production, not by the checks: the harness
      // asserted these buttons existed and never pressed one. The call text is
      // deliberately not quoted here so a grep for it stays meaningful.
      q(id)?.addEventListener('click', () => retireWalletFoot(), true);
    }

    const tools = q('belt-tools');
    tools.textContent = '';
    // The claim button lives in the same row as the tools, so the belt is three
    // rows tall instead of five.
    const claimSlot = q('belt-claim-slot');
    belt.tools.forEach((t, index) => {
      const net = expectedHuntWei(DROP_TABLE[t.tier], PRICE) - huntCostWei(t.tier);
      const row = document.createElement('div');
      row.className = 'belt-tool'
        + (t.left === 0 ? ' broke' : (t.active ? ' held' : ''));
      row.textContent = `T${roman(t.tier)} ${t.left}/${t.max} `
        + (t.left === 0 ? 'BROKEN' : t.active ? 'HELD' : 'stowed')
        + ` · net ${eth(net)}`;

      let label = null;
      if (t.left === 0) {
        const cost = repairCost(t.tier);
        const r = canRepair(belt, index);
        label = document.createElement('button');
        label.className = 'chip btn';
        label.textContent = `FIX ${fmt(cost)}`;
        label.disabled = !r.ok;
        if (r.ok) label.onclick = () => {
          const res = repairTool(belt, index);
          this.beltMsg(`Repaired T${roman(t.tier)} — ${res.fee} to treasury.`, 'ok');
          // Gems are spent: the satchel has nothing left to say.
          window.retireSatchel?.();
          this.refreshBelt();
          this.updateHud();
        };
      } else if (!t.active) {
        label = document.createElement('button');
        label.className = 'chip btn';
        label.textContent = 'EQUIP';
        label.onclick = () => {
          const res = equip(belt, index);
          if (!res.ok) { this.beltMsg(res.reason, 'bad'); return; }
          this.beltMsg(`Equipped T${roman(t.tier)}.`, 'ok');
          this.refreshBelt();
          this.updateHud();
        };
      }
      if (label) row.appendChild(label);
      tools.appendChild(row);
    });

    // --- claim the next tier
    const claim = document.createElement('button');
    claim.className = 'chip btn';
    claim.id = 'belt-claim';
    claimSlot.appendChild(claim);
    const next = belt.tools.reduce((a, t) => Math.max(a, t.tier), 0) + 1;
    if (next > MAX_TIER) {
      claim.textContent = 'ALL OWNED';
      claim.disabled = true;
    } else {
      const cost = toolCost(next);
      const c = canClaim(belt, next);
      claim.textContent = `CLAIM ${roman(next)} — ${fmt(cost)}`;
      claim.disabled = !c.ok;
      claim.onclick = () => this.doClaim(next);
    }

    // --- gem shop. Common and Uncommon only: Rare and above are hunt-only and
    // the contract reverts RarityNotForSale, so offering them would be a lie.
    const shop = q('belt-shop');
    shop.textContent = '';
    for (const row of this.shopRows || []) {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const label = document.createElement('span');
      label.textContent = row.label;
      const buy = document.createElement('button');
      buy.className = 'chip btn';
      buy.textContent = 'buy';
      buy.onclick = () => this.buyGemsOnchain(row.rarity, 1);
      wrap.append(label, buy);
      shop.appendChild(wrap);
    }
  }

  /** A one-line status under the claim button. */
  beltMsg(text, kind = '') {
    const el = document.getElementById('belt-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'belt-msg' + (kind ? ' ' + kind : '');
    // The player acted on the one-time note; it has said what it needed to say.
    if (text) retireWalletFoot();
  }

  /**
   * Claim the next tier. Connected -> the chain is the source of truth and the
   * local belt is a mirror of it. Not connected -> the existing local
   * simulation runs, and the card says so. The two must never be confused:
   * granting a tool locally after an on-chain attempt is what this branch
   * exists to prevent.
   */
  doClaim(next) {
    const belt = this.belt;
    if (next > MAX_TIER) {
      this.beltMsg('Every tier owned.', 'ok');
      return;
    }
    const check = canClaim(belt, next);
    if (!check.ok) { this.beltMsg(check.reason, 'bad'); return; }
    if (onchainActive()) { this.claimToolOnchain(next); return; }
    const res = claimTool(belt, next);
    this.beltMsg(`Claimed T${roman(next)} — ${res.fee} to treasury.`, 'ok');
    // Gems are spent: the satchel has nothing left to say.
    window.retireSatchel?.();
    this.flash(`Tier ${roman(next)} tool claimed`);
    this.refreshBelt();
    this.updateHud();
  }

  openBelt() {
    this.refreshBelt();
    this.refreshShopPrices();
  }

  closeBelt() { /* nothing to close: the toolbelt is a row in the top bar */ }

  /**
   * Buy one gem on chain. Price comes from the contract's own priceOf, never
   * a hardcoded number, and the credit is confirmed by re-reading
   * gemsOf(account, rarity) before the local balance moves.
   */
  async buyGemsOnchain(rarity, count) {
    if (this.busy) return;
    if (!onchainActive()) {
      this.beltMsg('Connect a wallet to buy gems on chain.', 'bad');
      return;
    }
    this.busy = true;
    this.beltMsg('Buying on chain...');

    const price = await priceFor(rarity);
    if (price === null) {
      this.busy = false;
      this.beltMsg('Could not read the price from the contract.', 'bad');
      return;
    }

    const r = await buyGemsOnchain(rarity, count, price);
    this.busy = false;

    if (!r.ok) {
      this.beltMsg(r.code === 'reverted'
          ? 'Purchase reverted on chain - nothing credited.'
          : `Purchase failed: ${r.reason || r.code}`, 'bad');
      this.refreshBelt();
      this.updateHud();
      return;
    }

    // Confirmed: the contract's gem balance actually rose. Mirror it.
    this.belt.common += count;
    this.beltMsg(`Bought ${count} ${RARITY_NAME_ONSALE[rarity]} for ${eth(r.spentWei)} (tx ${String(r.hash).slice(0, 10)}...).`, 'ok');
    this.refreshBelt();
    this.updateHud();
  }

  /** Paint the shop rows with live prices read from the contract. */
  async refreshShopPrices() {
    if (!this.shopRows || !this.shopRows.length) return;
    for (const row of this.shopRows) {
      const p = await priceFor(row.rarity);
      // The label is a plain string now: the shop lives in the DOM top bar, so
      // there is no Phaser Text to write into and nothing to destroy across the
      // await. syncBeltDom() renders whatever string is here.
      row.label = p === null
        ? `${RARITY_NAME_ONSALE[row.rarity]} — price unavailable`
        : `${RARITY_NAME_ONSALE[row.rarity]} ${eth(p)}`;
      if (row.buyLabel) row.buyLabel = onchainActive() ? 'buy' : 'connect';

      // The await above yields, and anything can happen before it resumes: the
      // panel can be closed, rebuilt, or the scene torn down. A destroyed Phaser
      // Text has its canvas nulled, so setText() on it throws from inside the
      // renderer -- `updateUVs -> setCutPosition -> setSize -> updateText ->
      // setText -> drawImage` on null. That was reported as an uncaught
      // pageerror reading "Cannot read properties of null (reading
      // 'drawImage')", which looks exactly like the game crashing.
      //
      // It is reachable on a real phone by opening and closing the toolbelt in
      // quick succession, so it is fixed here rather than filtered out of the
      // harness. The liveness check handles the ordinary case; the guard is
      // there because Phaser's internals decide what a destroyed Text still
      // exposes, and an async write to a destroyed object must not be able to
      // take down the frame regardless.
    }
    this.syncBeltDom();
  }

  /**
   * Claim a tier on chain.
   *
   * Nothing local changes until the contract's own state confirms it. The
   * reply to a duplicate claim is a receipt that says "success" while the
   * count never moves, so a successful send is not treated as a grant.
   */
  async claimToolOnchain(tier) {
    if (this.busy) return;
    this.busy = true;
    this.claimBtn.setText('claiming on chain...');
    this.beltMsg(`Sending claim for Tier ${roman(tier)}...`);

    const r = await claimToolOnchain(tier);

    this.busy = false;
    this.claimBtn.setText('');

    if (!r.ok) {
      // Explicitly say nothing was granted. A failed on-chain claim must not
      // leave the player believing they have a tool.
      this.beltMsg(r.code === 'reverted'
          ? 'Claim reverted on chain - nothing granted.'
          : `Claim failed: ${r.reason || r.code}`, 'bad');
      this.refreshBelt();
      this.updateHud();
      return;
    }

    // The contract now reports the tool. Mirror it into the local belt by
    // reading it back, rather than assuming what the grant produced.
    await this.syncBeltFromChain();
    this.beltMsg(`Tier ${roman(tier)} claimed on chain (tx ${String(r.hash).slice(0, 10)}...).`, 'ok');
    this.flash(`Tier ${roman(tier)} tool claimed on chain`);
    this.refreshBelt();
    this.updateHud();
  }

  /**
   * Pull the player's tools from the contract into the local belt.
   *
   * The chain is the source of truth when connected, so the local mirror is
   * rebuilt from what the contract actually holds rather than from what the
   * client hoped happened.
   */
  async syncBeltFromChain() {
    if (!onchainActive()) return;
    const { getAccount } = await import('./wallet.js');
    const { connect } = await import('./chain.js');
    const { config } = await import('./config.js');
    const account = getAccount();
    if (!account || !config.gameAddress) return;
    let chain_ = this._chainReader;
    if (!chain_) {
      chain_ = await connect({ rpcUrl: config.rpcUrl, address: config.gameAddress });
      this._chainReader = chain_;
    }
    const count = await chain_.toolCount(account);
    const tools = [];
    for (let i = 0; i < count; i++) {
      // toolAt takes an INDEX, not a tier - it reverts at index >= count.
      const [tier, durability, active] = await chain_.toolAt(account, i);
      const max = durabilityOf(tier);
      tools.push({ tier, left: durability, max, active });
    }
    if (!tools.length) return; // never empty a belt we failed to read
    this.belt.tools = tools;
  }

  refreshBelt() {
    if (!document.getElementById('belt')) return;
    this.syncBeltDom();
  }

  /** Legacy belt summary, kept for the shop-price refresh. */
  refreshBeltLegacy() {
    const belt = this.belt;

    // Mode must be visible in the panel itself, not just the topbar. A player
    // who is in simulation should never read a "claimed" line and assume it
    // went to the contract.
    if (this.beltMode) {
      const m = chainMode();
      this.beltMode.setText(
        m === 'onchain'
          ? 'ON-CHAIN - writes go to the DeepWood contract'
          : m === 'offline'
            ? 'OFFLINE - no contract configured'
            : 'PREVIEW - simulation only, nothing is on-chain'
      );
      this.beltMode.setColor(m === 'onchain' ? '#3f8a52' : '#d9a441');
    }

    // One compact counts line. beltBurned / beltFees were rows created by the
    // deleted drawer, so referencing them here threw at boot and took the whole
    // scene down with it.
    this.beltCommon.setText(
      `COMMON ${fmt(belt.common)}  BURNED ${fmt(belt.burned)}  FEES ${fmt(belt.feesPaid)}`,
    );

    for (const { row, btn, index } of this.beltRows) {
      const t = belt.tools[index];
      const net = expectedHuntWei(DROP_TABLE[t.tier], PRICE) - huntCostWei(t.tier);
      const state = t.left === 0 ? 'BROKEN' : t.active ? 'in hand' : 'stowed';
      row.setText(
        `T${roman(t.tier)} ${t.left}/${t.max} ${state === 'in hand' ? 'HELD' : state === 'stowed' ? 'OFF' : 'BROKE'}\n` +
        `net ${eth(net)}`
      );
      row.setColor(t.left === 0 ? '#d83a5a' : t.active ? '#fff8d0' : '#9fbc9f');

      if (t.left === 0) {
        const cost = repairCost(t.tier);
        const r = canRepair(belt, index);
        btn.setText(`FIX ${fmt(cost)}`);
        btn.setColor(r.ok ? '#fff8d0' : '#7a8a7a');
        btn.setBackgroundColor(r.ok ? '#2a4d38' : '#1a2a1a');
        btn.removeAllListeners('pointerdown');
        if (r.ok) {
          btn.on('pointerdown', () => {
            const res = repairTool(belt, index);
            this.beltMsg(`Repaired Tier ${roman(t.tier)} - burned ${fmt(cost)} Common, ${res.fee} to treasury.`, 'ok');
            this.refreshBelt();
            this.updateHud();
          });
        }
      } else if (t.active) {
        btn.setText('IN HAND');
        btn.setColor('#9fbc9f');
        btn.setBackgroundColor('#1a2a1a');
        btn.removeAllListeners('pointerdown');
      } else {
        btn.setText('EQUIP');
        btn.setColor('#fff8d0');
        btn.setBackgroundColor('#2a4d38');
        btn.removeAllListeners('pointerdown');
        btn.on('pointerdown', () => {
          const res = equip(belt, index);
          if (!res.ok) {
            this.beltMsg(res.reason, 'bad');
            return;
          }
          this.beltMsg(`Equipped Tier ${roman(t.tier)}.`, 'ok');
          this.refreshBelt();
          this.updateHud();
        });
      }
    }

    // claim button
    const next = belt.tools.reduce((m, t) => Math.max(m, t.tier), 0) + 1;
    if (next > MAX_TIER) {
      this.claimBtn.setText('ALL OWNED');
      this.claimBtn.setColor('#7a8a7a');
      this.claimBtn.setBackgroundColor('#1a2a1a');
      this.claimBtn.removeAllListeners('pointerdown');
    } else {
      const cost = toolCost(next);
      const c = canClaim(belt, next);
      this.claimBtn.setText(`CLAIM ${roman(next)} - ${fmt(cost)}`);
      this.claimBtn.setColor(c.ok ? '#fff8d0' : '#7a8a7a');
      this.claimBtn.setBackgroundColor(c.ok ? '#2a4d38' : '#1a2a1a');
      this.claimBtn.removeAllListeners('pointerdown');
      if (!c.ok) {
        this.beltMsg(c.reason);
      }
    }
  }

  /** Kept for the TAB key: refreshes the top card's toolbelt rows. */
  toggleBelt() {
    this.openBelt();
  }

  /**
   * A panel over the d-pad would swallow a held direction, so it is released.
   *
   * The controls are deliberately NOT hidden. That was needed when the toolbelt
   * was a bottom sheet sitting across them; the toolbelt is now a narrow drawer
   * on the right edge that never reaches the d-pad, so the game stays playable
   * while it is open and the player should be able to keep walking.
   */
  releaseTouch() {
    if (this.touchState) this.touchState.clear();
  }

  /* ---------------- the loop ---------------- */

  update(time, delta) {
    if (!this.player) return;

    // Stream the world around the player. Early-returns unless a chunk
    // boundary was crossed, so this is one comparison on a normal frame.
    this.refreshChunks();

    // Pollen, birds, insects. One call, no allocation, dt clamped inside.
    this.ambience?.tick(delta / 1000);

    // The lantern follows the hunter, with a slow breath so it reads as a
    // flame rather than a decal. Two writes, no allocation.
    if (this.lantern) {
      const t = this.time.now / 1000;
      this.lantern.setPosition(this.player.x, this.player.y);
      this.lantern.setAlpha(0.78 + Math.sin(t * 1.7) * 0.07);
    }

    const k = this.keys;
    const t = this.touchState || new TouchState();

    // One merge for BOTH input sources. Reading the keyboard and the d-pad in
    // separate branches is how two control schemes end up disagreeing about
    // what "moving right" means -- and diagonals get normalised once, here.
    const intent = readIntent({
      left: k.left.isDown || k.left2.isDown,
      right: k.right.isDown || k.right2.isDown,
      up: k.up.isDown || k.up2.isDown,
      down: k.down.isDown || k.down2.isDown,
      interact: Phaser.Input.Keyboard.JustDown(k.interact),
      belt: Phaser.Input.Keyboard.JustDown(k.belt),
      board: Phaser.Input.Keyboard.JustDown(k.board),
    }, t);

    const vx = intent.vx;
    const vy = intent.vy;

    // Frame-rate compensation, CLAMPED.
    //
    // MEASURED (delta-probe.mjs, three CPU throttles): Phaser advances a fixed
    // 16.67ms of game time per rendered frame, so distance per FRAME is a
    // constant 2.5px while the frame interval varied 6x. Movement speed in px/s
    // is therefore proportional to frame rate -- 150px/s at 60fps, 16px/s at
    // 7.9fps, 1px/s at 1.3fps.
    //
    // So compensate: scale this frame's step by how long the frame REALLY took.
    // At 60fps this is exactly 1.0 and changes nothing.
    //
    // The clamp is the whole trick. Earlier attempts scaled velocity without one
    // and the hunter walked 288px, finishing 248px PAST a trunk: Arcade
    // separates overlaps only AFTER moving, so a step wider than the collider
    // skips it entirely. The trunk body is 20x14 and the player's is 10 wide,
    // so any single step must stay under 20px; MAX_STEP_PX holds it at 12 with
    // margin.
    //
    // The cost is deliberate: below the cap the game is still slower than
    // MOVE_SPEED rather than teleporting through the forest. At 7.9fps that is
    // 79px/s instead of 16, and at 1.3fps 13px/s instead of 1. Correctness of
    // collision beats completeness of the speed fix.
    const moving = intent.moving;

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const realMs = Math.min(nowMs - (this._lastFrameAt || nowMs - 16.67), 250);
    this._lastFrameAt = nowMs;

    const simMs = delta > 0 ? delta : 16.67; // Phaser's fixed per-frame step
    // px needed this frame to hold real-time speed, capped so no single step
    // can clear a 20px trunk collider
    const wantPx = MOVE_SPEED * (realMs / 1000);
    const stepPx = Math.min(wantPx, MAX_STEP_PX);
    // Phaser integrates position += velocity * delta/1000, so the velocity that
    // produces stepPx over ITS fixed delta is just stepPx / (delta/1000). No
    // extra ratio factor -- an earlier draft had one and double-counted.
    const v = stepPx / (simMs / 1000);

    this.player.setVelocity(
      moving ? Math.round(vx * v) : 0,
      moving ? Math.round(vy * v) : 0,
    );

    // y-sort: the player draws behind objects whose base is higher up the
    // screen, so walking north puts them behind a tree and walking south
    // puts them in front. Depth is the object's base y.
    this.player.setDepth(this.player.y);

    if (moving) {
      // pick the dominant axis for the sprite direction
      this.animatePlayer(vx, vy);
      if (time - (this._lastStep || 0) > 180) {
        this._lastStep = time;
        this.dust.emitParticleAt(this.player.x, this.player.y + 14);
      }
    } else {
      this.animateIdle(vx, vy);
    }

    // context prompt
    const near = this.nearestNode();
    if (near) {
      this.prompt.setVisible(true);
      this.prompt.setText(
        !activeTool(this.belt) ? (this.hasTouchPad ? 'TOOL BROKEN - open TOOLBELT' : 'TOOL BROKEN - TAB to repair')
          : this.busy ? 'hunting...'
            : (this.hasTouchPad ? 'tap HUNT' : 'SPACE  hunt')
      );
      this.prompt.setPosition(this.cameras.main.scrollX + this.scale.width / 2,
        this.cameras.main.scrollY + this.scale.height - 70);
    } else {
      this.prompt.setVisible(false);
    }

    if (intent.hunt && near && !this.busy) {
      this.doHunt(near);
    }

    if (intent.belt) {
      this.closeLeaderboard();
      this.toggleBelt();
    }
    if (intent.board) {
      this.toggleLeaderboard();
    }
  }

  animatePlayer(vx, vy) {
    // The generated hunter is a single still with no walk cycle, so there is
    // nothing to play. Facing still has to work, so mirror it instead.
    if (this.genHunter) {
      if (vx !== 0) this.player.setFlipX(vx < 0);
      return;
    }
    let frame = 0;
    if (Math.abs(vx) > Math.abs(vy)) frame = vx < 0 ? 1 : 2;
    else frame = vy < 0 ? 3 : 0;

    const key = `${frame}`;
    if (this._animKey === key) return;
    this._animKey = key;
    this.player.anims.play(`walk-${frame}`, true);
  }

  animateIdle(vx, vy) {
    if (this.genHunter) {
      // same story: setFrame() would drag him back onto the drawn sheet.
      if (vx !== 0) this.player.setFlipX(vx < 0);
      return;
    }
    // face the last direction, standing pose
    let frame = 0;
    if (this._face !== undefined) frame = this._face;
    if (vx !== 0 || vy !== 0) {
      frame = Math.abs(vx) > Math.abs(vy) ? (vx < 0 ? 1 : 2) : (vy < 0 ? 3 : 0);
      this._face = frame;
    }
    this.player.anims.stop();
    this.player.setFrame(frame * 4); // frame 0 of the walk cycle
  }

  /**
   * Nearest dig node within interaction range.
   *
   * The radius is generous (56px) on purpose. At 40 a character could stand
   * visually on top of a node and still be "too far" to hunt it, which reads
   * as the game being broken -- the stone is under your feet and SPACE does
   * nothing.
   */
  nearestNode() {
    let best = null, bestD = 56;
    for (const n of this.nodes) {
      if (n.getData('used')) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, n.x, n.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  doHunt(node) {
    const tool = activeTool(this.belt);
    if (!tool) {
      // Every tool is broken. Send them to the belt panel rather than
      // silently ignoring SPACE.
      this.openBelt();
      this.flash('Tool broken - repair it to hunt again.');
      return;
    }
    this.busy = true;
    node.setData('used', true);
    // Record the dig before the animation, so the epoch bump is committed even
    // if the player walks off mid-dig. The chunk REBUILD is deferred to
    // completeNodeDig(), because doing it here would destroy the node the
    // tween below is still animating.
    this.markNodeDug(node);

    // Brief dig: hold the current facing, pulse the node, then reveal.
    this.player.anims.stop();
    this.tweens.add({
      targets: node, alpha: 0.2, scale: 0.45, duration: 220, yoyo: true,
      onComplete: () => {
        this.reveal(node);
        // Rebuild the chunk AFTER the reveal has read everything it needs off
        // the node, so the emptied spot respawns somewhere else in the chunk.
        this.completeNodeDig();
      },
    });

    const used = consumeUse(this.belt);
    this.updateHud();

    if (used.broke) {
      this.time.delayedCall(500, () => {
        this.flash(`Tier ${roman(used.tool.tier)} broke! It keeps its tier.`);
        this.openBelt();
      });
    }
  }

  reveal(node) {
    // Snapshot the tier BEFORE the reveal, so a tool that breaks on this
    // hunt still rolls against the tier that swung the pick.
    const tier = activeTool(this.belt)?.tier ?? 1;
    const result = rollHunt(this.seed, this.wallet ?? '0xplayer', this.huntIndex, tier);
    this.huntIndex += 1;

    // Quartz is Common, and Common is what tool costs are paid in. Track the
    // full haul too, so the satchel can show the rarer stones.
    this.belt.common += result.counts[0];

    // Season board. Recorded with the tier that swung the pick, since that
    // is the tier whose cost belongs in this player's ROI denominator.
    recordHunt(
      this.board, this.wallet ?? '0xplayer', result.counts, tier,
      Math.floor(Date.now() / 1000)
    );

    // find the most valuable gem in the haul -- that's the one that pops out
    let topRarity = 0;
    result.counts.forEach((c, r) => { if (c > 0 && r > topRarity) topRarity = r; });

    // burst
    const burst = this.add.particles(node.x, node.y, 'spark', {
      speed: { min: 30, max: 90 }, scale: { start: 0.4, end: 0 },
      lifespan: 500, quantity: 8, emitting: false,
    });
    burst.explode(8);

    // the gem pops up and floats
    // The revealed gem is the GENERATED sprite for its rarity. The drawn
    // pixel-art gem is retired and no longer even baked -- it used to be
    // `gem${topRarity}` with the generated art as an optional override, which
    // meant the old gem could reappear any time an asset failed to load. Now
    // there is one gem per rarity and it is the painted one. If the asset is
    // missing the burst above still plays and the find still logs.
    const genGem = `gen-gem-${topRarity}`;
    if (this.has(genGem)) {
      // Scale is 0.8 (67px). This has been wrong in both directions: 0.42 gave
      // 35px, which vanished, and the fix to 1.35 overshot to 113px -- larger
      // than any tree and bigger than the hunter, so a common quartz overshadowed
      // the whole scene. 67px sits ABOVE the 64x68 hunter and below the smallest
      // tree (134px), so the gem reads as the focus without becoming the
      // subject: the player is still hunting, not staring at a trophy.
      const gem = this.add.image(node.x, node.y, genGem)
        .setDepth(10)
        .setScale(0.8);
      // The 1.55 peak is gone -- that was the overshoot, taking the gem to 130px
      // mid-pop. Now a modest 0.95 peak, then a shorter drift. The reveal still
      // gets its beat (340ms pop, then away) without dominating the frame.
      this.tweens.add({
        targets: gem, y: node.y - 30, scale: 0.95, duration: 300, ease: 'Back.out',
        onComplete: () => {
          this.tweens.add({
            targets: gem, y: node.y - 66, alpha: 0, scale: 0.6, duration: 520, ease: 'Sine.in',
            onComplete: () => gem.destroy(),
          });
        },
      });
    }

    // collapse the spent node
    this.tweens.add({
      targets: node, scale: 0, duration: 500, delay: 350,
      onComplete: () => node.destroy(),
    });

    const entry = {
      rarity: topRarity,
      count: result.total,
      valueWei: result.valueWei,
    };
    this.finds.push(entry);

    // Tell the DOM shell (satchel readout) what was found. The shell is the
    // only place that knows about accounts and balances; the scene stays
    // ignorant of them.
    window.dispatchEvent(new CustomEvent('deepwood:find', {
      detail: { counts: result.counts, valueWei: result.valueWei.toString() },
    }));

    if (topRarity >= 2) {
      this.flash(`${RARITY_NAME[topRarity]}!  ${(Number(result.valueWei) / 1e18).toFixed(5)} ETH`);
    }

    this.updateHud();
    this.busy = false;
  }

  flash(msg) {
    const t = this.add.text(this.scale.width / 2, 90, msg, {
      fontFamily: 'monospace', fontSize: '16px', color: '#fff8d0',
      backgroundColor: '#0d1a10ee', padding: { x: 12, y: 8 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(UI_DEPTH + 1);
    this.tweens.add({ targets: t, alpha: 0, delay: 1600, duration: 400, onComplete: () => t.destroy() });
  }
}


