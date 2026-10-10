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
import { config } from './config.js';

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
import { HuntQueue, MAX_BATCH } from './queue.js';
import {
  CHUNK, chunkOf, describeChunk, nodeKey,
  residentChunks, staleChunks, LOAD_RADIUS,
  depletionStore, saveDepletion, epochFor, isChunkSpent,
} from './streaming.js';
import {
  newPlayer, heldTool, toolName, nextTier, buyOrUpgradeLabel,
  canBuyTool, buyTool, canRepair, repairTool, repairNeeds,
  canRedeem, redeemGems, redeemValueWei, creditGems, consumeUse, fmtGem,
} from './player.js';
// `fmtEth` below is the ECONOMY formatter (wei -> trimmed ETH), and it is what
// the new belt prices use. The season/ROI strings still use season.js's own
// `eth`, aliased to `seasonEth`, because those pad to fixed widths for
// right-aligned leaderboard columns and this one trims trailing zeros.
// `fmtEth` is the ECONOMY formatter (wei -> trimmed ETH), used by the new belt
// prices. The season/ROI strings keep season.js's own `eth`, aliased
// `seasonEth`, because those pad to fixed widths for right-aligned leaderboard
// columns while this one trims trailing zeros.
// RARITY_NAME is NOT re-imported here: engine.js already exports it and the
// game rolls hunts with it, so there is exactly one definition of the gem
// names. A second import of the same binding is a redeclaration error, and it
// would have been two sources of truth for the same string anyway.
import {
  RARITY_SHORT, TIER_NAME,
  toolPrice, durabilityOf, repairCost, fmtRepair, fmtEth,
  huntValueWei, netHuntWei, paybackHunts, cyclesToPayback, dropTable,
  REDEEM_FLOOR,
} from './economy.js';
import { DROP_TABLE, PRICE } from './engine.js';
import {
  newSeasonRecord, recordHunt, topN,
  seasonClock, roiPct, eth as seasonEth, fmt, onRoiBoard, shortOfFloor, recordToolSpend,
  TOP_N,
} from './season.js';
import { fetchChainLeaderboard } from './leaderboard.js';
import { playFootstep, playPick, playReveal, startAmbient, resumeAudio, isMuted, toggleMute } from './audio.js';
import {
  initCommitment, commitSeason, verifySeason, seasonState, rollSeason,
} from './commitment.js';
import {
  onchainActive, mode as chainMode,
  buyToolOnchain, repairToolOnchain, upgradeSkillOnchain, redeemGemsOnchain,
  walletBalanceWeiOnchain, priceFor, ALL_RARITIES, RARITY_NAMES,
} from './onchain.js';
import sha3 from 'js-sha3';

/**
 * Starting testnet ETH for the OFFLINE preview only.
 *
 * Enough to buy Wood (0.005) many times over and to clear the 0.005 redemption
 * floor several times, so the full loop is demonstrable without a wallet.
 * Never used on chain.
 */
const PREVIEW_ETH = 200_000_000_000_000_000n; // 0.2 ETH
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
const BEACON_SCALE = 0.22;
// The revealed gem. Source art (art/gem-*.png) has its longest edge at 192px,
// so 0.2 lands a gem at roughly 38px on screen: a touch smaller than the 42px
// hunter. The gem is the PAYOUT, not the subject -- it sits on the ground at the
// player's feet for a couple of seconds, and at 0.34 it read as larger than the
// character who found it. The satchel panel is where the find is actually read.
const GEM_SCALE = 0.2;
// Fan spacing follows the sprite so a multi-rarity catch never overlaps.
const GEM_STEP = 192 * GEM_SCALE * 1.05;
// Pick swings required to break a site. Player-driven, so this is the real
// interaction cost of a dig. Every strike must be a deliberate input.
const MINER_STRIKES = 3;
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
    // One tool, no rotation -- ECONOMY-SPEC.md section 1. Player starts with
    // NOTHING: no free Tier I any more. Buying Wood with ETH is the first
    // action in the game, which is the entire spine of the new economy.
    // The economy state. Deliberately NOT `this.player`: that name is already
    // the hunter SPRITE further down this constructor, and reusing it silently
    // overwrote one with the other. The symptom was `p.gems is undefined`,
    // because `player` had become a texture rather than a player.
    this.econ = newPlayer();
    // Simulated wallet for PREVIEW mode only.
    //
    // This was 0n, which made the preview unplayable: "buy Wood" is disabled
    // with "Need 0.005 ETH, have 0 ETH" and there is no way for a visitor to
    // ever earn any, because hunting requires a tool and buying one requires
    // money. A preview that cannot demonstrate the game is not a preview --
    // and it read as "the site is broken" rather than "connect a wallet".
    //
    // On chain this is NEVER read -- walletBalanceWei() returns the real
    // eth_getBalance there. It exists only so an offline visitor can buy Wood,
    // hunt, break it, repair with mined gems and cash out, which is the whole
    // loop the UI is meant to show.
    this.simBalance = PREVIEW_ETH;
    // Real balance, read on connect. null until the first successful read.
    this.chainBalanceWei = null;
    // Guards a double-click while a wallet signature is pending.
    this.txBusy = false;
    // Which belt button is mid-flight, and the verb it shows. Set while a
    // wallet signature or a chain poll is outstanding.
    this.txPendingId = null;
    this.txPendingVerb = null;
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

    // V4: token buy + price oracle config
    this.rpcUrl = config.rpcUrl;
    this.fallbackRpcUrls = config.fallbackRpcUrls;
    this.gameAddress = config.gameAddress || null;
    this.tokenAddress = config.tokenAddress || null;
    this.poolManager = config.poolManager || null;
    this.poolId = config.poolId || null;
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
    // The five GENERATED cut gems, one per rarity. Keys are 'gen-gem-N' because
    // these are painted assets, not baked pixel art -- same convention as the
    // beacon, which loads fine from 'art/beacon.png'.
    //
    // The runtime PNGs under public/art/ used to be flattened during asset prep:
    // alpha was dropped, corner alpha became 255, and the sprite rendered as a
    // solid rectangle of the gem's average colour. The clean alpha-preserving
    // originals live in src/assets/ and are what these are now built from
    // (trim to content, longest edge 192, aspect preserved, alpha intact).
    // Do NOT round-trip these through a step that drops the alpha channel.
    load('gen-gem-0', 'art/gem-quartz.png');
    load('gen-gem-1', 'art/gem-amber.png');
    load('gen-gem-2', 'art/gem-sapphire.png');
    load('gen-gem-3', 'art/gem-ruby.png');
    load('gen-gem-4', 'art/gem-diamond.png');
  }

  /** True when the generated art for a role actually loaded. */
  has(key) { return this.textures.exists(key); }

  create() {
    // Screen-CENTERED signing flash. wallet.js's signing path has no Phaser
    // reference, so it calls this hook. Unlike gameplay flash() (which anchors
    // over the player so you read it without looking away from the forest), the
    // signing prompt pins to the DEAD CENTRE of the viewport on both axes --
    // scrollX + width/2, scrollY + height/2 -- and self-fades. This is the one
    // message that must read as a modal "the wallet is open" state, so it takes
    // the screen centre, not the character.
    window.deepwoodFlash = (msg) => {
      if (!msg) return;
      if (!this._centerToast) {
        const t = this.add.text(0, 0, '', {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '12px', color: '#fff8d0',
          backgroundColor: '#0d1a10dd', padding: { x: 10, y: 6 },
          align: 'center',
        }).setOrigin(0.5, 0.5).setDepth(UI_DEPTH + 2);
        t.setAlpha(0);
        this._centerToast = t;
      }
      const t = this._centerToast;
      // Dead centre of the viewport in WORLD coords (camera scroll + half the
      // view), so it is centred regardless of where the camera/player is.
      t.setPosition(
        this.cameras.main.scrollX + this.scale.width / 2,
        this.cameras.main.scrollY + this.scale.height / 2
      );
      this.tweens.killTweensOf(t);
      t.setText(msg);
      t.setAlpha(1);
      t.setVisible(true);
      this.tweens.add({
        targets: t, alpha: 0, delay: 2200, duration: 500,
        onComplete: () => { t.setVisible(false); },
      });
    };
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
    // Spawn at a random point near the world origin, not AT the origin. A
    // fixed (0,0) meant every reload landed in the same tree arrangement --
    // the "always starts at the same spot" the user reported. World gen is
    // chunk-keyed and effectively unbounded, so any nearby spawn lands in a
    // real generated chunk. 4k px is ~2 chunk diameters -- far enough to be
    // distinct, close enough that the first chunk's load still carries.
    const spawnJitter = CHUNK * 2;  // ~4096 px range
    const spawnX = (((Math.random() * 2) - 1) * spawnJitter) | 0;
    const spawnY = (((Math.random() * 2) - 1) * spawnJitter) | 0;
    this.player = this.physics.add.sprite(spawnX, spawnY, 'hunter', 0);

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
    // The gem shop is gone. Gems are now earned by hunting, spent on repairs,
    // or sold for ETH -- they are never bought, so there is no shop to price
    // (ECONOMY-SPEC.md section 1).
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
      // Commitment is a TOOL purchase now, not a per-hunt fee, so hunt count no
      // longer buys board eligibility. Without this every rival sits at
      // ethSpent 0, fails the 0.005 ETH splay floor, and the demo board is
      // empty except the player. Scaled with hunt count so ROI still ranks the
      // dedicated players above the casual ones.
      recordToolSpend(this.board, n, BigInt(hunts) * 100_000_000_000_000n);
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
    // SCARCITY: a chunk whose site has been fully dug renders with NO beacon.
    // Previously the epoch bump alone respawned one at a fresh random spot the
    // moment the chunk rebuilt, so claiming a gem put a new beacon under the
    // player's feet -- the opposite of scarce. The chunk keeps its trees,
    // props and ambience; only the treasure goes.
    const chunkSpent = isChunkSpent(this.epochByKey, cx, cy);
    data.nodes.forEach((n) => {
      if (chunkSpent) return;
      // A dug node reappears at a new spot: render at the epoch this chunk's
      // depletion record says it is currently on.
      const epoch = epochFor(this.epochByKey, cx, cy, n.idx);
      const spot = epoch === 0 ? n : describeChunk(this.seasonSeed, cx, cy, epoch).nodes.find((q) => q.idx === n.idx);
      if (!spot) return;

      // The beacon is a stake with a lamp on top, so the light lives at the CAP.
      // BEACON_SCALE is 0.22 now: at 0.34 the AI beacon was ~79px, still taller
      // than the hunter (68px) and half a tree, which kept reading as scenery
      // rather than as a marker. At 0.22 it is ~51px -- shorter than the hunter,
      // far below the smallest tree -- so the LIGHT draws the eye, not the
      // silhouette. That is the intent: a stake should not compete with the
      // trees, it should be findable.
      const genBeacon = this.has('gen-beacon');
      const beaconH = (genBeacon ? 232 : 64) * (genBeacon ? BEACON_SCALE : 1);
      const capY = spot.y - beaconH * (genBeacon ? 0.72 : 0.25);

      // SIREN: a rotating two-beam lamp instead of a symmetric blob. The beam
      // sweeps around the cap continuously, which is what makes it read as an
      // active beacon rather than a smudge of glow. Two copies at right angles
      // would strobe; one copy rotating at a per-beacon phase offset looks like
      // a field of independent lamps.
      const hasSiren = this.has('siren');
      if (hasSiren) {
        const beam = this.add.image(spot.x, capY, 'siren')
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(0.42)
          .setScale(0.62);
        beam.setDepth(spot.y - 1);
        beam.setData('baseAlpha', 0.42);
        this.tweens.add({
          targets: beam, angle: 360, duration: 2600 + n.idx * 211,
          repeat: -1, ease: 'Linear',
        });
        // Breathing brightness on top of the rotation: a lamp that only spins
        // can still look painted. This is the pulse that sells it as a light.
        this.tweens.add({
          targets: beam, alpha: 0.62, duration: 900 + n.idx * 71,
          yoyo: true, repeat: -1, ease: 'Sine.inOut',
        });
        this.sortables.push(beam);
        objs.push(beam);
      }

      // A tight hot core at the cap, so the source itself is the brightest
      // point even when the beam points away.
      const core = this.add.image(spot.x, capY, 'glow')
        .setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.62).setScale(0.17);
      core.setDepth(spot.y - 1);
      core.setData('baseAlpha', 0.62);
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

      // Clicking the site is a first-class way to mine it, not just SPACE or the
      // HUNT button. A mouse player should never be told "SPACE  hunt" and then
      // left with nothing to click. Two handlers:
      //   - no dig running  -> start one (this is the HUNT action, pointed at)
      //   - dig running     -> land a strike (this is the pick)
      // One handler with a branch, because registering two on the same sprite
      // means a single click during a dig fires both and swings twice.
      marker.setInteractive({ useHandCursor: true });
      marker.on('pointerdown', () => {
        if (this.mining) {
          if (this.mining.node === marker) this.mineStrike(this.time.now);
        } else if (!this.busy) {
          this.doHunt(marker);
        }
      });

      // The stake bobs. It no longer carries an alpha pulse of its own -- that
      // duty belongs to the core and the beam now, and pulsing the whole sprite
      // made the beacon read as blinking signage.
      this.tweens.add({
        targets: marker, y: spot.y - 3, duration: 900 + n.idx * 37,
        yoyo: true, repeat: -1, ease: 'Sine.inOut',
      });
      this.tweens.add({
        targets: core, alpha: 0.40, duration: 760 + n.idx * 41,
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
    // No camera bounds -- the world is effectively unbounded. The guard
    // against the player sprite disappearing under the top HUD card is done
    // on the PLAYER side in update(): they are not allowed to walk high
    // enough that the HUD would cover them, which is what the user meant by
    // 'the player should never go beyond the header card border'.
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

    // BOARD is GONE from the canvas.
    //
    // It drew a second leaderboard trigger at the top-right, and the DOM icon
    // button (#leaderboard-btn, the bar-chart/signal glyph, now in the right
    // rail) opens exactly
    // the same panel via the same openLeaderboard(). Two controls for one
    // action -- one of them a 60x24 rectangle sitting under the wallet panel --
    // is a duplicate, so the canvas one is removed and the icon button owns it.
    //
    // The 'board' KEY is untouched: L still opens the leaderboard, and the key
    // map still lists board: 'L'.

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

    // The old canvas HUD panel is GONE. It drew a bordered 250x74 box with
    // "DeepWood", a durability bar and a tier line at the top-left -- which sat
    // UNDER the DOM HUD and, once the header card became a narrow left panel,
    // poked out from behind it as a stray green frame with clipped "pWood"
    // text. The DOM owns all of that now: the season panel carries the tool
    // state, and the find log below carries the controls hint.
    //
    // The find log and the walk-up prompt stay: they are canvas-native, sit
    // bottom-left away from the panels, and are not duplicated in the DOM.

    // find log, bottom left.
    // wordWrap is load-bearing: the idle line is 57 characters of monospace and
    // ran straight off the right edge of a 390px phone, so the tail ("press
    // SPACE") was cropped and the instruction was unreadable. It is clamped to
    // the screen minus its own margin and padding, and the real width is
    // recomputed on resize.
    this.logText = this.add.text(12, H - 96, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#cfe0cf',
      // No background plate. It painted a wide translucent rectangle across
      // the bottom-left, which read as one more panel. The reference art floats
      // its text straight on the scene; a text shadow keeps it legible over the
      // moss without a box.
      stroke: '#040a06', strokeThickness: 3,
      wordWrap: { width: Math.max(120, W - 40), useAdvancedWrap: true },
    });
    this.hud.add(this.logText);

    // prompt shown when near a node
    this.prompt = this.add.text(W / 2, H - 70, '', {
      fontFamily: 'monospace', fontSize: '14px', color: '#fff8d0',
      backgroundColor: '#0d1a10dd', padding: { x: 10, y: 5 },
    }).setOrigin(0.5).setVisible(false);
    this.hud.add(this.prompt);
  }

  updateHud() {
    // The canvas HUD panel is gone (see setupHud), so there is no durBar to
    // gate on. This used to `return` early when durBar was missing, which now
    // would be ALWAYS -- and that would have silently stopped paintSeasonStats()
    // from ever running. The season stats are DOM, but they are painted from
    // here, so the guard has to go with the thing it guarded.
    this.paintSeasonStats();

    // The tool name, durability pips and controls hint are all painted by
    // syncToolDom() into #belt-tool now. They were duplicated on the canvas
    // (a 200px bar plus a tier line) and that copy is removed -- one source of
    // truth for tool state, in the DOM, where the panel already shows it.

    // The find log is gone. It printed "found Quartz x5 = 0.00025 ETH" into
    // this.logText, which DUPLICATED the floating x5 label already drawn over
    // the gem sprite in revealGems(). Two renderings of the same count on
    // every single dig read as a bug (or a double-credit). The sprite label is
    // the confirmation; the satchel strip shows the running total. Nothing is
    // lost by dropping the log line -- it never carried information the player
    // could not get from the two places that matter.

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
   * Chain-backed: the players and the numbers come from BatchSettled/Migration
   * events and the contract's own reads (playerStats, seasonScore, roi,
   * onRoiBoard). Rank/best/leq ordering is SPEC section 9 exactly. A failed
   * chain read falls back to the local session board rather than claiming an
   * empty preseason -- the empty-board case is a real possible state and an
   * honest one.
   *
   * Opens with L, and with the LEADERBOARD button in the header card (same
   * function, either input).
   */
  async openLeaderboard(gen) {
    if (this.leaderboardOpen) return;
    this.leaderboardOpen = true;
    if (gen === undefined) gen = (this.lbGen = (this.lbGen ?? 0) + 1);
    this.releaseTouch();

    const W = this.scale.width, H = this.scale.height;
    const f = panelFrame(W, H, 430, 396);
    const { pw, ph, px: cx, py: cy, sheet } = f;
    this.lbFrame = { pw, ph, px: cx, py: cy, sheet };

    const me = String(this.wallet ?? '0xplayer').toLowerCase();

    // Data: chain first, local mirror as fallback. Both paths hand the same
    // shape to the painter below, so the layout never forks.
    let rows = [], rankNote = null, phaseLabel = null;
    try {
      const { getReader } = await import('./onchain.js');
      const r = await getReader();
      if (r) {
        const { fetchChainLeaderboard } = await import('./leaderboard.js');
        const lb = await fetchChainLeaderboard({
          rpcUrl: r.rpcUrl,
          fallbackRpcUrls: r.fallbackRpcUrls ?? [],
          gameAddress: r.address,
        });
        rows = lb.rows;
        phaseLabel = lb.phase === 0 ? 'Preseason'
          : lb.phase === 1 ? `Season ${lb.current?.id ?? 1}`
          : lb.phase === 2 ? 'Season closed'
          : null;
        rankNote = `${lb.playerCount} player(s) settled on-chain`;
      }
    } catch {
      rows = [];   // chain read failed -- show empty state
    }
    // No local fallback: chain-only. If the chain read fails or returns no
    // rows, the panel shows the empty state below.

    if (gen !== undefined && gen !== this.lbGen) return;  // discarded by a newer close/open

    // -- DOM panel. The header card has z-index 9 and the Phaser canvas paints
    //    UNDER it, which is why the old leaderboard sat behind the HUD. A DOM
    //    layer with z-index above the HUD fixes this structurally, not by
    //    hoping Phaser's depth comparison reaches the window. --
    const el = document.createElement('div');
    el.className = 'lb-overlay';
    el.style.cssText =
      'position:fixed;inset:0;z-index:1000;display:flex;align-items:center justify-content:center;' +
      'background:rgba(0,0,0,.55);';
    const frame = sheet
      ? 'left:0;right:0;top:auto;bottom:0;width:100%;max-width:none;border-radius:0;margin-bottom:0;'
      : `left:${cx}px;top:${cy}px;width:${pw}px;max-height:${ph}px;`;

    const top10 = rows.slice(0, TOP_N);
    const iAmHere = top10.some((r) => r.address === me && r.onBoard);
    // If the player is ranked but outside the top 10, they still see where they
    // sit -- the same behaviour the local board had.
    const mineRow = !iAmHere ? rows.find((r) => r.address === me) : null;
    if (mineRow) top10.push(mineRow);

    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const short = (a) => a === '0xplayer' ? 'you (not connected)' : `${a.slice(0, 6)}…${a.slice(-4)}`;
    const roiTxt = (r) => r.onBoard ? r.roi.toLocaleString('en-US') + 'x' : '--';
    const bestTxt = (r) => seasonEth(r.bestWei) + ' ETH';
    const shortAddr = (a) => a === '0xplayer' ? 'YOU' : `${a.slice(0, 6)}…${a.slice(-4)}`;
    const rowHtml = (r) => {
      const isMe = r.address === me;
      return `<div class="lb-row${isMe ? ' me' : ''}${r.onBoard ? '' : ' off'}">${''}` +
        `<span class="lb-rank">${r.onBoard ? r.rank : '--'}</span>${''}` +
        `<span class="lb-addr">${esc(shortAddr(r.address))}</span>${''}` +
        `<span class="lb-roi">${roiTxt(r)}</span>${''}` +
        `<span class="lb-best">${bestTxt(r)}</span>${''}` +
        `</div>`;
    };

    const myRow = rows.find((r) => r.address === me);
    const statsFoot = myRow
      ? (myRow.onBoard
          ? `<div class="lb-stats">you are #${myRow.rank} of ${rows.filter((x) => x.onBoard).length}${' '}${''
          }${myRow.rank <= TOP_N ? ' · in the prize places' : ''}</div>`
          : `<div class="lb-stats off">not on the board yet -- below the splay floor, ${''}${''
          }spend ${seasonEth(myRow.ethSpent)} / 0.005 ETH to rank</div>`)
      : '';

    el.innerHTML = `
      <div class="lb-panel" style="${frame}">
        <div class="lb-head">
          <span class="lb-title">${phaseLabel ?? 'Season'} · VERDANT HOLLOW</span>
          <button class="lb-close" type="button">✕</button>
        </div>
        <div class="lb-sub">
          ranked by EFFICIENCY: rarity-weight per ETH spent · not by wealth · ${esc(rankNote ?? '')}
        </div>
        <div class="lb-cols">
          <span>#</span><span>PLAYER</span><span>ROI</span><span>BEST</span>
        </div>
        <div class="lb-rows">
          ${top10.length ? top10.map(rowHtml).join('') : '<div class="lb-empty">no players on-chain yet</div>'}
        </div>
        ${statsFoot}
      </div>`;
    document.body.appendChild(el);
    this.lbEl = el;

    const close = () => this.closeLeaderboard();
    el.querySelector('.lb-close').addEventListener('pointerdown', close);
    el.addEventListener('pointerdown', (ev) => { if (ev.target === el) close(); });
  }

  closeLeaderboard() {
    // Bump the generation so an in-flight open discards its late result.
    this.lbGen = (this.lbGen ?? 0) + 1;
    // DOM panel, not a Phaser container -- it was created against document.body
    // in openLeaderboard, so remove it from the DOM rather than destroying a
    // scene container. The old canvas-backed version never actually rendered
    // above the DOM HUD (z-index 9), which is why it was DOM now.
    if (this.lbEl) {
      this.lbEl.remove();
      this.lbEl = null;
    }
    if (this.lbBackdrop) { this.lbBackdrop.destroy(); this.lbBackdrop = null; }
    this.lbFrame = null;
    if (this.lbOutside) this.input.off('pointerdown', this.lbOutside);
    this.lbOutside = null;
    this.leaderboardOpen = false;
  }

  toggleLeaderboard() {
    if (this.leaderboardOpen) this.closeLeaderboard();
    else {
      this.closeBelt();
      // openLeaderboard() is async: the chain scan can take several seconds,
      // and the player can tap L again (or the close control) while it is
      // still in flight. A generation guard means a close that lands before
      // the fetch finishes discards the late result instead of leaving a
      // stale overlay on screen after the flag is already false.
      const gen = (this.lbGen = (this.lbGen ?? 0) + 1);
      void this.openLeaderboard(gen);
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
    const q = (id) => document.getElementById(id);
    if (!q('belt')) return;
    const p = this.econ;

    // --- counts: the headline "N gems" text is REMOVED. The gem strip at the
    // top-centre (per-rarity icons + counts, inside a solid lemon box) is the
    // single gem readout now; a second total-gem number on the toolbelt was
    // redundant and the user asked for it gone. belt-counts is left empty. */
    q('belt-counts').textContent = '';

    const m = chainMode();
    const mode = q('belt-mode');
    mode.textContent = m === 'onchain'
      ? 'ON-CHAIN \u2014 writes go to the DeepWood contract'
      : m === 'offline'
        ? 'OFFLINE \u2014 no contract configured'
        : 'PREVIEW \u2014 simulation only';
    mode.style.color = m === 'onchain' ? 'var(--ok)' : 'var(--warn)';

    this.syncActionDom();

    // The badge lives OUTSIDE the mode span (it would be blown away by the
    // textContent rewrite above), so refresh its copy here to stay in sync
    // with any queue writes that landed while the belt was being rebuilt.
    window.renderQueue?.(this.queue?.size ?? 0);
  }

  /** The two ETH actions: buy/upgrade the tool, and sell gems.
   *
   * Both are here rather than one combined button because they spend the same
   * currency for unrelated reasons, and a player mid-decision (upgrade now or
   * sell these gems and repair?) needs to see both prices at once.
   */
  syncActionDom() {
    const el = document.getElementById('belt-actions');
    if (!el) return;
    el.textContent = '';
    const p = this.econ;
    const balance = this.walletBalanceWei();

    // --- buy tool / upgrade tool (single button, dropdown for payment method)
    const nt = nextTier(p);
    // BUY/UPGRADE wraps the icon in a .rail-action-item.rail-action-icon column
    // (like sell/repair/settle) so the "buy"/"upgrade" label sits beneath the
    // icon. It wears the forest GREEN base and a hammer/pickaxe glyph. The
    // payment dropdown (when the token rail is configured) is positioned
    // absolutely against this wrapper, not the whole rail, so it opens under
    // the icon.
    const bwrap = document.createElement('div');
    bwrap.className = 'rail-action-item rail-action-icon order-buy';
    const buy = document.createElement('button');
    buy.className = 'icon-btn buy';
    buy.id = 'belt-buy';
    // A pickaxe/hammer glyph: acquiring a tool.
    const PICKAXE = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">'
      + '<path d="M14.2 4.2a3.2 3.2 0 0 1 4.4 4.4L12.6 14.6l-2.2 5.9a1.3 1.3 0 0 1-2.4 0l-1-2.6-2.6-1a1.3 1.3 0 0 1 0-2.4l5.9-2.2 3.9-8.1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
      + '<path d="M11.4 11.4 9.2 14.2l-.4 1.4 1.6 1.6 1.4-.4 2.8-2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
      + '</svg>';
    if (nt > 5) {
      buy.innerHTML = PICKAXE;
      buy.disabled = true;
      buy.title = 'MAX TIER';
    } else {
      const cost = toolPrice(nt);
      const chk = canBuyTool(p, nt, balance);
      const shortLabel = `${buyOrUpgradeLabel(p)} ${toolName(nt)} ${fmtEth(cost)}`;
      const verb = buyOrUpgradeLabel(p).startsWith('upgrade') ? 'upgrade' : 'buy';
      const nm = toolName(nt);
      buy.innerHTML = PICKAXE;
      buy.setAttribute('aria-label', `${verb} ${nm}`);
      buy.title = shortLabel + (chk.ok ? '' : '\n' + chk.reason);
      buy.disabled = !chk.ok;
      if (!chk.ok) buy.title = chk.reason;

      // Dropdown: one button, two payment options.
      // "pay eth" always available; "pay DeepWood 10% off" only when the token
      // rail is configured (tokenAddress + poolManager + poolId all set).
      const hasTokenRail = !!(this.tokenAddress && this.poolManager && this.poolId);
      if (hasTokenRail && nt <= 5) {
        buy.classList.add('has-dropdown');
        buy.setAttribute('aria-haspopup', 'true');
        buy.setAttribute('aria-expanded', 'false');

        const dd = document.createElement('div');
        dd.className = 'buy-dropdown';
        dd.id = 'buy-dropdown';

        const optEth = document.createElement('button');
        optEth.className = 'buy-dd-item';
        optEth.type = 'button';
        optEth.textContent = 'pay eth';
        optEth.title = `pay ${fmtEth(cost)}`;
        optEth.onclick = (e) => { e.stopPropagation(); closeBuyDropdown(); this.doBuyTool(nt); };

        const optToken = document.createElement('button');
        optToken.className = 'buy-dd-item';
        optToken.type = 'button';
        const tokenCost = this.estimateTokenCost(nt);
        const shortToken = tokenCost > 0
          ? (Number(tokenCost) / 1e18).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
          : '???';
        optToken.textContent = 'pay DeepWood 10% off';
        optToken.title = `pay ~${shortToken} $DEEPWOOD (10% discount)`;
        optToken.onclick = (e) => { e.stopPropagation(); closeBuyDropdown(); this.doBuyToolWithToken(nt); };

        dd.appendChild(optEth);
        dd.appendChild(optToken);

        // Position the dropdown below the button. The button is inside
        // #belt-actions (position:relative), so offsetParent is that container.
        // Buy now sits inside a .rail-action-icon wrapper (icon + label), so the
        // dropdown must open below the WRAPPER (icon + label), not just the icon
        // -- otherwise it covers the "buy"/"upgrade" label. The wrapper is not
        // yet in the DOM at this point (it is appended further down), so
        // offsetTop/offsetLeft would read 0. Compute against the rail instead:
        // the wrapper is a direct child placed after any prior buttons, so its
        // top is the rail's content height. Use getBoundingClientRect on a
        // fresh measurement after layout by deferring to the click handler is
        // overkill; instead position relative to the rail's current bottom.
        dd.style.position = 'absolute';
        // Defer measurement until after the wrapper is laid out: read it lazily
        // on first open. Until then, park it just below the rail so it is never
        // stranded over the label.
        dd.style.top = 'auto';
        dd.style.bottom = '0px';
        dd.style.left = '0px';
        dd.style.minWidth = buy.offsetWidth + 'px';

        el.appendChild(dd);

        buy.onclick = (e) => {
          e.stopPropagation();
          const isOpen = dd.classList.contains('open');
          closeBuyDropdown();
          if (!isOpen) {
            // Measure NOW (the wrapper is in the DOM) and park the dropdown
            // below the wrapper (icon + label) so it never covers the label.
            dd.style.bottom = 'auto';
            dd.style.top = (bwrap.offsetTop + bwrap.offsetHeight + 4) + 'px';
            dd.style.left = bwrap.offsetLeft + 'px';
            dd.classList.add('open');
            buy.setAttribute('aria-expanded', 'true');
          }
        };

        // Close on outside click or escape.
        const outsideClose = (e) => {
          if (!dd.contains(e.target) && e.target !== buy) closeBuyDropdown();
        };
        const escClose = (e) => { if (e.key === 'Escape') closeBuyDropdown(); };
        document.addEventListener('click', outsideClose, true);
        document.addEventListener('keydown', escClose, true);

        function closeBuyDropdown() {
          dd.classList.remove('open');
          buy.setAttribute('aria-expanded', 'false');
          document.removeEventListener('click', outsideClose, true);
          document.removeEventListener('keydown', escClose, true);
        }
      } else {
        // No token rail: single action, no dropdown.
        buy.onclick = () => this.doBuyTool(nt);
      }
    }
    this.decoratePending(buy);
    // The icon + label go into the column wrapper; the wrapper goes into the rail.
    const blbl = document.createElement('span');
    blbl.className = 'rail-action-label';
    blbl.textContent = nt > 5 ? 'max tier' : (buyOrUpgradeLabel(p).startsWith('upgrade') ? 'upgrade' : 'buy');
    bwrap.appendChild(buy);
    bwrap.appendChild(blbl);
    el.appendChild(bwrap);

    // --- sell gems. Rendered as a 3D CIRCLE ICON (like settle/repair) with the
    // "sell gems" label beneath it, in the same column. Wears COPPER (a
    // convert-to-value action) so the column reads green/copper/blue/gold.
    // The dynamic payout stays in the tooltip; the icon + label are fixed.
    {
      const swrap = document.createElement('div');
      swrap.className = 'rail-action-item rail-action-icon order-sell';
      const sell = document.createElement('button');
      sell.className = 'icon-btn sell';
      sell.id = 'belt-sell';
      const held = p.gems.reduce((a, b) => a + b, 0);
      const val = redeemValueWei(p);
      const shortVal = held > 0 ? String(Number(val) / 1e18).replace(/0+$/, '').replace(/\.$/, '') : 'sell gems';
      const payoutLabel = this.tokenAddress ? '$DEEPWOOD' : 'ETH';
      // A gems-to-coin glyph: a stacked gem converting to a coin.
      sell.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">'
        + '<path d="M6.5 10.5 9 7h6l2.5 3.5L12 18l-5.5-7.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
        + '<path d="M6.5 10.5h11" fill="none" stroke="currentColor" stroke-width="1.6"/>'
        + '<path d="M9 7l1.4 3.5M15 7l-1.4 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
        + '</svg>';
      sell.setAttribute('aria-label', 'Sell gems');
      sell.title = held > 0 ? `sell ${held} gems for ${shortVal} ${payoutLabel}` : 'no gems to sell';
      const rchk = canRedeem(p);
      sell.disabled = !rchk.ok;
      if (!rchk.ok) sell.title = rchk.reason;
      sell.onclick = () => this.doSellGems();
      this.decoratePending(sell);
      swrap.appendChild(sell);
      const slbl = document.createElement('span');
      slbl.className = 'rail-action-label';
      slbl.textContent = 'sell gems';
      swrap.appendChild(slbl);
      el.appendChild(swrap);
    }

    // --- repair, shown only when broken and affordable. It is a gem action
    // dressed like the ETH ones, so it sits on its own row under them.
    // Rendered as a 3D CIRCLE ICON (like settle) with the "fix tool" label
    // beneath it, in the same column, so the terminal actions read as a set.
    if (p.tier > 0 && p.left === 0) {
      const rwrap = document.createElement('div');
      rwrap.className = 'rail-action-item rail-action-icon order-repair';
      const r = document.createElement('button');
      r.className = 'icon-btn repair';
      r.id = 'belt-repair';
      // A wrench/hammer glyph: a tool being repaired.
      r.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">'
        + '<path d="M14.7 6.3a3.5 3.5 0 0 0 4.6 4.6l-3 3a1.5 1.5 0 0 1-2.1 0l-1.4-1.4a1.5 1.5 0 0 1 0-2.1l1.9-4.1Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>'
        + '<path d="M11.5 12.5 4.6 19.4a1.6 1.6 0 0 0 0 2.3l.7.7a1.6 1.6 0 0 0 2.3 0l6.9-6.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg>';
      const need = repairNeeds(p);
      const chk = canRepair(p);
      r.setAttribute('aria-label', `Fix ${toolName(p.tier)}`);
      r.title = chk.ok ? `repair ${toolName(p.tier)} for ${fmtRepair(p.tier)}` : chk.reason;
      r.disabled = !chk.ok;
      r.onclick = () => this.doRepair();
      this.decoratePending(r);
      rwrap.appendChild(r);
      const rlbl = document.createElement('span');
      rlbl.className = 'rail-action-label';
      rlbl.textContent = 'fix tool';
      rwrap.appendChild(rlbl);
      el.appendChild(rwrap);
    }

    // --- SETTLE: the only gameplay control that opens the wallet. Connected
    // only (preview has no contract-side queue), always rendered so the badge
    // and the gate always point at a real control, disabled while empty.
    // Rendered as a 3D CIRCLE ICON (like the leaderboard/wallet buttons) with
    // the "settle hunt" label beneath it, not a text chip. The queued count
    // rides as a small badge on the icon so the number is still glanceable.
    // Always rendered so the button stays visible. In preview mode it shows
    // disabled (there's no on-chain queue to settle), but the 3D circle icon
    // and label remain on screen.
    {
      const wrap = document.createElement('div');
      wrap.className = 'rail-action-item rail-action-icon settle-right';
      const st = document.createElement('button');
      st.className = 'icon-btn settle';
      st.id = 'belt-settle';
      const queued = onchainActive() ? (this.queue?.size ?? 0) : 0;
      // A settle/checkmark glyph: a claw/hook stamping a card onto the chain.
      st.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">'
        + '<path d="M6.5 3h11a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H13l-1.8 3.2a1 1 0 0 1-1.7 0L7.7 16.5h-1.2a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>'
        + '<path d="M8.6 11.4l2.3 2.3 4.5-4.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg>'
        + (queued > 0 ? `<span class="icon-badge">${queued}</span>` : '');
      st.setAttribute('aria-label', queued > 0 ? `Settle ${queued} hunts` : 'Settle');
      const offline = !onchainActive();
      st.title = offline
        ? 'settle is on-chain only -- connect a wallet'
        : queued > 0
          ? `bank ${queued} queued hunt${queued === 1 ? '' : 's'} on-chain (one signature)`
          : 'nothing queued -- dig first';
      st.disabled = queued === 0 || offline;
      st.onclick = () => this.doSettle();
      this.decoratePending(st);
      wrap.appendChild(st);
      const lbl = document.createElement('span');
      lbl.className = 'rail-action-label';
      lbl.textContent = 'settle hunt';
      wrap.appendChild(lbl);
      // Appended to the HUD (not the left rail) so it can break out to the FAR
      // RIGHT edge. .settle-right anchors it to the right edge (aligned with the
      // leaderboard column); the top is set below so it sits on the SAME row as
      // the sell button, which is measured from the live layout.
      const hud = document.getElementById('hud');
      // The settle wrapper lives in #hud (not #belt-actions) so it can break
      // out to the far-right edge. syncActionDom clears #belt-actions only, so
      // a stale settle wrapper from a previous render would linger and a new
      // one would stack on top of it -- visible as a duplicated button. Remove
      // any prior settle wrapper before appending the fresh one.
      const stale = hud && hud.querySelector('.settle-right');
      if (stale) stale.remove();
      (hud || el).appendChild(wrap);
      // Align settle's vertical position to the SELL button's row. Settle is
      // position:absolute against #hud, so its top is relative to the HUD's top
      // edge. The wrapper has its own internal offset (the button does not sit
      // flush at the wrapper's top edge), so measure that gap and compensate:
      // we want settle's BUTTON top to equal sell's BUTTON top.
      const sellBtn = document.getElementById('belt-sell');
      if (sellBtn) {
        const hudRect = hud.getBoundingClientRect();
        const sellRect = sellBtn.getBoundingClientRect();
        // Two-pass alignment. Settle is position:absolute inside the #hud GRID,
        // whose containing-block math for absolute children does not match a
        // naive top-from-padding-box (the grid adds its own offset). So set an
        // initial top, measure the actual residual error between settle's button
        // and sell's button, then correct by that error. This lands settle's
        // button exactly on sell's row at every viewport.
        wrap.style.top = (sellRect.top - hudRect.top) + 'px';
        const before = st.getBoundingClientRect().top - sellRect.top;
        wrap.style.top = (sellRect.top - hudRect.top - before) + 'px';
      }
    }
  }

  /**
   * ETH the player can spend, in wei.
   *
   * Preview mode has no wallet and no chain, so this is a simulated balance.
   * When the redeployed contract is wired in, this becomes a real
   * `eth_getBalance` on connect and nothing else changes -- every caller
   * already routes through here rather than reading a balance itself.
   */
  walletBalanceWei() {
    // Synchronous accessor for the offline path. On chain the REAL balance is
    // fetched asynchronously into `this.chainBalanceWei` on connect, and that
    // is what a purchase is sized against -- never `simBalance`, which is a
    // fiction that would size a real transaction against nothing.
    if (onchainActive()) return this.chainBalanceWei ?? 0n;
    return this.simBalance ?? 0n;
  }

  /**
   * Accept the real balance read by the connect flow.
   *
   * Called from index.html rather than from here, because the scene has no
   * reference to the connect button. `null` means the read FAILED and must be
   * stored as unknown -- overwriting with 0n would disable every action and
   * read as a confident "you have nothing", which is a different and wrong
   * statement.
   */
  setChainBalance(wei) {
    this.chainBalanceWei = wei;
    if (wei !== null) this.refreshBelt();
  }

  /**
   * Adopt the chain's own view of what this player holds.
   *
   * The belt is rendered from the LOCAL mirror, which starts empty. So a
   * player who buys a tool and reloads -- or who already holds a tool from an
   * earlier session -- was shown "buy Wood" and offered to buy a tool they
   * already had. On this chain that second buy reverts TierLocked: it costs a
   * signature, shows no purchase, and looks like the button is simply broken.
   *
   * The chain is authoritative, so it gets to overwrite the mirror. A failed
   * read changes nothing, because an unreadable tool is not the same as owning
   * no tool.
   */
  async refreshChainTool() {
    if (!onchainActive()) return;
    this._wasConnected = true;   // even if the read below fails, the wallet is attached
    let tool;
    try {
      const { getReader } = await import('./onchain.js');
      const r = await getReader();
      if (!r) return;
      const { getState } = await import('./wallet.js');
      const { account } = getState();
      if (!account) return;
      tool = await r.toolOf(account);
    } catch {
      return; // unreadable -> leave the mirror alone rather than blank it
    }
    if (!tool) return;
    // Field names matter: the player shape is { tier, left, max }, not
    // { tool, durability }. Writing `tool`/`durability` created properties
    // nothing reads, so `left` stayed 0 and the game called a full-health tool
    // broken -- "tool broken - repair below" for a player holding 20/20.
    const tier = Number(tool.tier) || 0;
    this.econ.tier = tier;
    this.econ.left = Number(tool.durability ?? 0);
    // `max` is the tier's full durability, which the chain does not return; it
    // comes from the economy mirror. Without it a healthy tool would read as
    // "20/0 uses".
    this.econ.max = tier > 0 ? durabilityOf(tier) : 0;

    // V3 settle queue: keep it in lockstep with the chain's hunt index. If the
    // index moved (a settle landed -- ours or another device's), the queue's
    // base is stale and it must be rebased. rebase() is a no-op when nothing
    // drifted and DROPS a loaded queue whose base moved, which is exactly the
    // behaviour a stale queue needs (its contents can never match the chain's
    // recomputation anyway -- the settle would revert ResultMismatch).
    try {
      const { getReader } = await import('./onchain.js');
      const r = await getReader();
      if (r) {
        const { getState } = await import('./wallet.js');
        const { account } = getState();
        if (account) {
          const idx = Number(await r.huntIndexOf(account));
          this._huntIndex = idx;
          if (this.queue) {
            this.queue.rebase(idx, tier);
            window.renderQueue?.(this.queue.size);
          }
        }
      }
    } catch {
      // leave the queue alone: losing a queued batch to an RPC hiccup is worse
      // than briefly showing a slightly stale count.
    }

    // GEMS too, not just the tool. The belt renders the satchel from this local
    // mirror, and gemsOf() was only ever read to CONFIRM a sale -- never to
    // populate the balance. So a player holding gems on chain was permanently
    // shown "no gems yet", and the sell button stayed disabled against a real
    // balance. Same class of bug as the stale tool: the mirror was written from
    // one side of an action and never from the chain's own state.
    await this.refreshChainGems();

    this.refreshBelt();
    this.updateHud();
  }

  /**
   * Adopt the chain's own gem balances into the local satchel.
   *
   * The satchel, the "N gems" count and the sell button all render from
   * `econ.gems`. Nothing wrote that array from the chain -- gemsOf() was only
   * ever read to confirm that a sale had landed -- so a player who had mined on
   * chain was shown "no gems yet" forever, with sell disabled against a balance
   * they actually held.
   *
   * All five rarities, because V2 lets the player redeem any of them. A partial
   * read is discarded rather than merged: half the satchel is a lie, and the
   * sell button would then be priced from the wrong figure.
   */
  async refreshChainGems() {
    if (!onchainActive()) return;
    try {
      const { getReader } = await import('./onchain.js');
      const r = await getReader();
      if (!r) return;
      const { getState } = await import('./wallet.js');
      const { account } = getState();
      if (!account) return;
      const held = await Promise.all(ALL_RARITIES.map((x) => r.gemsOf(account, x)));
      this.econ.gems = held.map((n) => Number(n ?? 0));
      // These five numbers ARE the satchel -- one per rarity, straight off the
      // contract. There is no second tally (no lifetime 'found', no mirror that
      // could drift): the tiles are read from this array and the array is read
      // from the chain after every connect, hunt, buy, repair, or sell.
      // Repaint the satchel tiles too, not just the belt-counts line --
      // window.renderGems reads this same array but only repaints when someone
      // calls it, and refreshChainGems used to be a headless write.
      window.renderGems?.();
    } catch {
      // Leave the mirror alone: an unreadable balance is not an empty one.
    }
  }

  /** Refresh the on-chain balance. Safe to call often; failures leave it null. */
  async refreshChainBalance() {
    if (!onchainActive()) return;
    const b = await walletBalanceWeiOnchain();
    // A null read means UNKNOWN, not zero. Overwriting with 0n would disable
    // every action and read as a confident "you have nothing".
    this.chainBalanceWei = b;
    if (b !== null) this.refreshBelt();
  }

  /**
   * Buy the first tool, or upgrade to the next one.
   *
   * Upgrading REPLACES the held tool. There is no stow and no way back: the
   * durability you had on Bronze is gone, which is the whole tension in
   * "repair with gems, or pay ETH and start fresh".
   */
  /**
   * Estimate the token cost for buying a tool tier, using the on-chain price.
   * Returns wei (18 decimals) or 0 if price is unavailable.
   */
  async estimateTokenCost(tier) {
    try {
      const { getEthPerToken } = await import('./chain.js');
      const ethPerToken = await getEthPerToken(
        this.rpcUrl,
        this.fallbackRpcUrls,
        this.poolManager,
        this.poolId
      );
      const cost = toolPrice(tier);
      // tokenCost (in the token's 18-decimal units) = discounted ETH cost / ethPerToken.
      // ethPerToken is now 1e18-scaled (eth per token, fixed point), so:
      //   discountedEth = cost * 0.9   (wei)
      //   tokenCost = discountedEth * 1e18 / ethPerToken   (token units, 18 dec)
      const discountedEth = (cost * 9000n) / 10000n;
      const tokenCost = (discountedEth * 10n ** 18n) / ethPerToken;
      return tokenCost;
    } catch {
      return 0n;
    }
  }

  /**
   * Buy tool with $DEEPWOOD token at 10% discount.
   * Flow: get quote → user accepts → sign tx → wait for confirmation.
   */
  async doBuyToolWithToken(tier) {
    if (this.txBusy) return;
    this.txBusy = true;
    try {
      await this._doBuyToolWithToken(tier);
    } finally {
      this.txBusy = false;
    }
  }

  async _doBuyToolWithToken(tier) {
    const p = this.econ;

    // OFFLINE: local simulation only
    if (!onchainActive()) {
      this.beltMsg('Token buy requires wallet connection', 'bad');
      return;
    }

    // Get on-chain price
    this.beltMsg('Reading pool price…', 'busy');
    const { getEthPerToken, getBuyNonce, getAllowance, getTokenBalance } = await import('./chain.js');
    const { getState, sendTo } = await import('./wallet.js');
    const { getReader, pollUntilChanged } = await import('./onchain.js');
    const ethPerToken = await getEthPerToken(
      this.rpcUrl,
      this.fallbackRpcUrls,
      this.poolManager,
      this.poolId
    );
    const cost = toolPrice(tier);
    // tokenCost (token's 18-decimal units) = discounted ETH cost / ethPerToken.
    // ethPerToken is 1e18-scaled, so scale the discounted wei cost back up by
    // 1e18 before dividing. (The old `ethPerToken * 10000n / 10000n` was a no-op
    // and, with the old underflowing price, divided by zero.)
    const discountedEth = (cost * 9000n) / 10000n;
    const tokenCost = (discountedEth * 10n ** 18n) / ethPerToken;
    // The buy nonce is keyed by the PLAYER ADDRESS. Use the live connected
    // account from getState(), NOT this.wallet: this.wallet is a Phaser property
    // set by the wallet-sync and can be stale/undefined mid-flight, and
    // getBuyNonce does player.slice(2) -- passing undefined crashed with
    // "Cannot read properties of undefined (reading 'slice')" (DEEPWOOD-B).
    const { account } = getState();
    if (!account) {
      this.beltMsg('Token buy requires a connected wallet', 'bad');
      return;
    }

    // Check token balance
    const tokenBalance = await getTokenBalance(
      this.rpcUrl,
      this.fallbackRpcUrls,
      this.tokenAddress,
      account
    );
    if (tokenBalance < tokenCost) {
      this.beltMsg(`Not enough $DEEPWOOD (need ${(Number(tokenCost)/1e18).toFixed(2)}, have ${(Number(tokenBalance)/1e18).toFixed(2)})`, 'bad');
      return;
    }

    // Check allowance — if insufficient, approve first
    const allowance = await getAllowance(
      this.rpcUrl,
      this.fallbackRpcUrls,
      this.tokenAddress,
      account,
      this.gameAddress
    );
    if (allowance < tokenCost) {
      this.beltMsg('Approving $DEEPWOOD spend…', 'busy');
      this.setTxPending('belt-buy-token', 'approving');
      const { approveTokenTx } = await import('./chain.js');
      const approveData = approveTokenTx(this.gameAddress, tokenCost);
      let approveResult;
      try {
        // approve goes to the TOKEN contract, not the game
        approveResult = await sendTo(this.tokenAddress, approveData);
      } finally {
        this.clearTxPending();
      }
      if (!approveResult?.ok) {
        this.beltMsg(approveResult?.reason || 'approval failed', 'bad');
        return;
      }
      this.beltMsg('Approved! Confirm purchase in wallet…', 'busy');
      // Small delay for the approval to propagate
      await new Promise(r => setTimeout(r, 2000));
    }

    const nonce = await getBuyNonce(
      this.rpcUrl,
      this.fallbackRpcUrls,
      this.gameAddress,
      account
    );
    const quoteExpiresAt = Math.floor(Date.now() / 1000) + 30;

    // Show quote to user
    const shortToken = (Number(tokenCost) / 1e18).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const accepted = await this.showQuoteDialog(tier, shortToken, 30);
    if (!accepted) {
      this.beltMsg('Quote cancelled', 'bad');
      return;
    }

    // Check if quote expired
    if (Date.now() / 1000 > quoteExpiresAt) {
      this.beltMsg('Quote expired - try again', 'bad');
      return;
    }

    // Send transaction
    this.beltMsg('Confirm in wallet…', 'busy');
    this.setTxPending('belt-buy-token', 'buying');
    const { buyToolWithTokenTx } = await import('./chain.js');
    const before = await getReader()?.toolOf(account);

    let r;
    try {
      const txData = buyToolWithTokenTx(tier, tokenCost, quoteExpiresAt, nonce);
      r = await sendTo(this.gameAddress, txData);
    } finally {
      this.clearTxPending();
    }

    if (!r?.ok) {
      this.beltMsg(r?.reason || 'purchase failed', 'bad');
      return;
    }

    // Wait for confirmation
    const after = await pollUntilChanged(
      () => getReader()?.toolOf(account),
      before,
      (b, a) => a.tier > b.tier
    );

    if (!after.changed) {
      this.beltMsg('contract did not apply the purchase (it reverted)', 'bad');
      return;
    }

    // Update local state
    p.tier = tier;
    p.left = Number(after.value.durability ?? 0);
    p.max = durabilityOf(tier);
    recordToolSpend(this.board, this.wallet ?? '0xplayer', cost);
    this.beltMsg(`Bought ${toolName(tier)} with $DEEPWOOD — ${p.left}/${p.max} uses`, 'ok');
    this.refreshBelt();
    window.renderGems?.();
    this.updateHud();
  }

  /**
   * Show a quote dialog and wait for user acceptance.
   * Returns true if accepted, false if cancelled.
   */
  async showQuoteDialog(tier, tokenCost, expiresIn) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'quote-dialog';
      el.innerHTML = `
        <div class="quote-card">
          <h3>Buy ${toolName(tier)} with $DEEPWOOD</h3>
          <p>Token cost: <strong>${tokenCost} $DEEPWOOD</strong></p>
          <p>Discount: <strong>10% off</strong></p>
          <p>Quote expires in: <strong>${expiresIn}s</strong></p>
          <div class="quote-actions">
            <button class="chip btn act" id="quote-accept">Accept</button>
            <button class="chip btn" id="quote-cancel">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(el);

      const acceptBtn = el.querySelector('#quote-accept');
      const cancelBtn = el.querySelector('#quote-cancel');
      const timer = setTimeout(() => {
        el.remove();
        resolve(false);
      }, expiresIn * 1000);

      acceptBtn.onclick = () => {
        clearTimeout(timer);
        el.remove();
        resolve(true);
      };
      cancelBtn.onclick = () => {
        clearTimeout(timer);
        el.remove();
        resolve(false);
      };
    });
  }

  async doBuyTool(tier) {
    // These handlers now AWAIT a wallet signature. Before they were purely
    // local and synchronous, so a double-click cost nothing. Now a second
    // click during the signature window would open a second transaction --
    // and buyTool is sequential, so the second would revert TierLocked after
    // the player had already signed it.
    if (this.txBusy) return;
    this.txBusy = true;
    try {
      await this._doBuyTool(tier);
    } finally {
      this.txBusy = false;
    }
  }

  async _doBuyTool(tier) {
    const p = this.econ;

    // OFFLINE: the local economy is authoritative and nothing leaves the page.
    if (!onchainActive()) {
      const res = buyTool(p, tier, this.simBalance);
      if (!res.ok) { this.beltMsg(res.reason, 'bad'); return; }

      this.simBalance -= (res.cost ?? toolPrice(tier));
      // Tool spend is the ROI denominator now that hunts are free (spec s12
      // item 8). Without this the player buys Wood and the board still reads 0
      // spent, so ROI divides by zero and Rank shows nothing.
      recordToolSpend(this.board, this.wallet ?? '0xplayer', res.cost ?? toolPrice(tier));

      const verb = res.replaced ? 'Upgraded to' : 'Bought';
      const extra = res.replaced ? ` (replaced ${res.replaced})` : '';
      this.beltMsg(
        `${verb} ${toolName(tier)}${extra} \u2014 ${res.left}/${res.max} uses`,
        'ok',
      );
      this.refreshBelt();
      window.renderGems?.();
      this.updateHud();
      return;
    }

    // ON-CHAIN: never touch local state until the contract's own state proves
    // it applied. On 46630 a reverted call still returns a receipt with
    // status 0x1, so a hash proves nothing -- the gate in onchain.js polls
    // `toolOf` until the tier actually moves, and only then do we believe it.
    const cost = toolPrice(tier);
    this.beltMsg('Confirm the purchase in your wallet\u2026', 'busy');
    // Read the REAL balance BEFORE the local mirror is touched. The mirror step
    // sizes itself against walletBalanceWei(), and on a first purchase that
    // value is still null -> 0n, which fails the local affordability check and
    // leaves the card showing no tool after a purchase that actually landed.
    await this.refreshChainBalance();
    this.setTxPending('belt-buy', 'buying');
    let r;
    try {
      r = await buyToolOnchain(tier, cost);
    } finally {
      // Cleared before the local mirror is updated, because that path calls
      // refreshBelt() and the belt must not stay stuck in the busy label.
      this.clearTxPending();
    }

    if (!r.ok) {
      this.beltMsg(r.reason || 'purchase failed', 'bad');
      return;
    }

    // Confirmed by the chain. Now mirror it locally so the UI updates.
    //
    // The mirror is set from the values the CHAIN confirmed (r.tier and
    // r.durability), not from a re-run of the local buyTool(). That re-run
    // used to be the only path, and it silently failed on the first purchase
    // of a session: it sized the buy against walletBalanceWei(), which is
    // `chainBalanceWei ?? 0n`, and chainBalanceWei is still null at this point
    // because refreshChainBalance() runs afterwards. So the local buy was
    // refused for insufficient funds, the mirror stayed empty, the button kept
    // reading "buy Wood" for a player who already owned Wood, and clicking it
    // again opened a second wallet signature that the contract then rejected
    // with TierLocked. The purchase had actually succeeded on both attempts.
    //
    // The chain is the authority on what the player now holds, so its answer
    // is what gets written.
    const res = buyTool(p, tier, this.walletBalanceWei());
    if (!res.ok) {
      // The chain proved the purchase applied, so the local refusal is a
      // STALE-MIRROR artifact, not a real failure. Trust the chain.
      //
      // Field names must match player.js: { tier, left, max }. Writing
      // `tool`/`durability` here created properties nothing reads, leaving
      // `left` at 0 -- a bought tool still shown as broken.
      p.tier = tier;
      p.left = Number(r.durability ?? 0);
      p.max = durabilityOf(tier);
    }
    recordToolSpend(this.board, this.wallet ?? '0xplayer', res.cost ?? cost);
    this.beltMsg(
      `${res.replaced ? 'Upgraded to' : 'Bought'} ${toolName(r.tier)} \u2014 ${r.durability}/${this.econ.max} uses`,
      'ok',
    );
    await this.refreshChainBalance();
    this.refreshBelt();
    window.renderGems?.();
    this.updateHud();
  }

  /**
 * Mark a chain action as in-flight and say so ON THE BUTTON.
 *
 * The message line was the only feedback during a wallet signature or a poll,
 * which made a pending action look identical to a dead button -- the player
 * clicked again, and the second signature was the thing that actually broke
 * (see the TierLocked report). `txBusy` alone prevented re-entry but showed
 * nothing, so "busy" had to be visible on the control itself.
 *
 * @param {string} id   button id, so only the acting button reads as busy
 * @param {string} verb short label, e.g. 'buying' -- must fit ~100px
 */
  setTxPending(id, verb) {
    this.txPendingId = id;
    this.txPendingVerb = verb;
    this.refreshBelt();
  }

  clearTxPending() {
    // Refresh the belt, or the button keeps the "buying…" label forever. The
    // fields alone are not enough: refreshBelt() is what rebuilds the label,
    // and nothing else happens on this path once the transaction resolves.
    this.txPendingId = null;
    this.txPendingVerb = null;
    this.refreshBelt();
  }

  /**
   * Apply the pending state to a freshly built belt button.
   *
   * Called from refreshBelt() for every action, so a belt rebuilt mid-flight
   * (the balance refresh does rebuild it) cannot lose the busy indication.
   */
  decoratePending(btn) {
    if (this.txPendingId !== btn.id) return false;
    btn.disabled = true;
    btn.classList.add('busy');
    btn.textContent = `${this.txPendingVerb}\u2026`;
    // No affordance/tooltip: a disabled button does not open one, and the old
    // "Need X ETH" reason under a pending label would read as a failure.
    btn.removeAttribute('title');
    return true;
  }

  /** Repair with gems. Burns them outright; no treasury claim (spec s10). */
  async doRepair() {
    if (this.txBusy) return;
    this.txBusy = true;
    try {
      await this._doRepair();
    } finally {
      this.txBusy = false;
    }
  }

  async doSettle() {
    if (this.txBusy) return;
    await this._doSettle();
  }
  async _doSettle() {
    if (!onchainActive()) {
      // Preview mode settles nothing: there is no contract holding the digs,
      // so there is no batch to push through.
      this.flash('Preview mode \u2014 connect a wallet to bank real batches.');
      return;
    }
    if (!this.queue || this.queue.empty) {
      this.flash('Nothing queued to settle yet \u2014 dig first.');
      return;
    }
    const n = this.queue.size;
    this.beltMsg(`Confirm the settlement of ${n} hunt${n === 1 ? '' : 's'} in your wallet\u2026`, 'busy');
    this.setTxPending('belt-settle', 'settling');
    let r;
    try {
      const { settleBatchOnchain } = await import('./onchain.js');
      r = await settleBatchOnchain(this.queue);
    } finally {
      this.clearTxPending();
    }
    if (!r.ok) {
      this.beltMsg(r.reason || 'Settlement failed.', 'bad');
      this.flash(r.reason || 'Could not settle the batch.');
      // A stale queue is the likeliest cause: the chain moved (another
      // device, a season flip). Re-sync so the next dig starts clean.
      await this.refreshChainTool();
      return;
    }
    // The contract banked the batch: adopt its balances, record the whole
    // batch on the season board in one entry, drop the queue, and repaint
    // so satchel + "n pending" badge and tool all show the post-settle truth.
    window.renderQueue?.(0);
    this.queue = new HuntQueue(this.queue.nextIndex, this.queue.tier);
    await this.refreshChainTool();
    this.beltMsg(`Banked ${n} hunt${n === 1 ? '' : 's'} \u2014 haul is on-chain.`, 'good');
    this.flash(`Settled ${n} hunt${n === 1 ? '' : 's'} \u2014 the haul is banked.`);
    // refreshChainTool covers tool durability and the chain satchel, but the
    // gem TILE counts (window.renderGems) only repaint when someone changes
    // them. Call it here so the satchel updates as soon as the batch lands
    // rather than waiting for the next dig.
    window.renderGems?.();
  }

  async _doRepair() {
    if (onchainActive()) {
      this.beltMsg('Confirm the repair in your wallet\u2026', 'busy');
      this.setTxPending('belt-repair', 'repairing');
      let r;
      try {
        r = await repairToolOnchain();
      } finally {
        this.clearTxPending();
      }
      if (!r.ok) { this.beltMsg(r.reason || 'repair failed', 'bad'); return; }

      // Only now does the local tool become whole, and only to the durability
      // the chain reports -- the client's own number would be a guess.
      const res = repairTool(this.econ);
      if (!res.ok) { this.beltMsg(r.reason || 'repair failed', 'bad'); return; }
      this.beltMsg(
        `Repaired ${toolName(this.econ.tier)} \u2014 ${r.durability}/${this.econ.max} uses`,
        'ok',
      );
      this.refreshBelt();
      window.renderGems?.();
      this.updateHud();
      return;
    }

    const res = repairTool(this.econ);
    if (!res.ok) { this.beltMsg(res.reason, 'bad'); return; }
    const p = this.econ;
    this.beltMsg(
      `Repaired ${toolName(p.tier)} \u2014 ${p.left}/${p.max} uses`,
      'ok',
    );
    this.refreshBelt();
    window.renderGems?.();
    this.updateHud();
  }

  /**
   * Sell every gem for ETH.
   *
   * The contract redeems ONE rarity per call, so an "sell all" across five
   * rarities is up to five transactions. That is real friction and it is not
   * hidden: each one is confirmed against `gemsOf` before the next starts,
   * and the message says which rarity is being cashed out. Silently sending
   * five transactions to "sell gems" would be worse than asking.
   *
   * The payout is ALWAYS the chain's own quote. Computing 90% of face value
   * locally and showing it as guaranteed is exactly the kind of number that
   * turns out to be wrong at the moment the player relies on it.
   */
  async doSellGems() {
    if (this.txBusy) return;
    this.txBusy = true;
    try {
      await this._doSellGems();
    } finally {
      this.txBusy = false;
    }
  }

  async _doSellGems() {
    const p = this.econ;

    // Which rarities actually hold something. Zero rows are skipped so a
    // player with one rarity does not sign four no-op transactions.
    // gems is a plain Number array in both modes (preview seeds [0,0,0,0,0]
    // and the chain mirror Number()s each gemsOf word), so compare against 0,
    // not 0n -- `number > 0n` throws "Cannot mix BigInt and other types".
    const held = ALL_RARITIES.filter((r) => (p.gems[r] ?? 0) > 0);
    if (!held.length) { this.beltMsg('No gems to sell.', 'bad'); return; }

    if (!onchainActive()) {
      const check = canRedeem(p);
      if (!check.ok) { this.beltMsg(check.reason, 'bad'); return; }
      const total = p.gems.reduce((a, b) => a + b, 0);
      const res = redeemGems(p);
      if (!res.ok) { this.beltMsg(res.reason, 'bad'); return; }
      this.simBalance += res.value;
      this.beltMsg(`Sold ${fmtGem(total)} gems for ${fmtEth(res.value)}.`, 'ok');
      this.refreshBelt();
      window.renderGems?.();
      this.updateHud();
      return;
    }

    // On chain: redeem rarities in ascending order, cheapest first, so if the
    // player is signing several they have already banked the small ones.
    let totalPayout = 0n;
    let totalSold = 0;
    for (const rarity of held) {
      const count = p.gems[rarity] ?? 0;
      if (count <= 0) continue;
      this.beltMsg(`Selling ${RARITY_NAMES[rarity]} (${count})\u2026`, 'busy');
      // Sell is SEVERAL transactions, so the pending label has to be re-raised
      // for each one -- cleared by the loop's own finally, then set again.
      this.setTxPending('belt-sell', 'selling');

      let r;
      try {
        r = await redeemGemsOnchain(rarity, count);
      } finally {
        this.clearTxPending();
      }
      if (!r.ok) {
        // Stop at the first failure rather than pressing on: a below-floor
        // rejection means the rest will likely fail too, and continuing would
        // ask for more signatures after a refusal.
        this.beltMsg(
          `${RARITY_NAMES[rarity]}: ${r.reason || 'sale failed'}${totalSold ? ` (${fmtGem(totalSold)} already sold)` : ''}`,
          'bad',
        );
        break;
      }
      totalPayout += r.payoutWei ?? 0n;
      totalSold += count;
      // Zero it locally only once the chain has confirmed THAT rarity.
      p.gems[rarity] = 0;
    }

    if (totalSold > 0) {
      await this.refreshChainBalance();
      this.beltMsg(`Sold ${fmtGem(totalSold)} gems for ${fmtEth(totalPayout)}.`, 'ok');
    }
    this.refreshBelt();
    window.renderGems?.();
    this.updateHud();
  }

  /** A one-line status under the claim button. */
  beltMsg(text, kind = '') {
    const el = document.getElementById('belt-msg');
    if (!el) return;
    el.textContent = text;
    // `has-text` is what makes the row visible. The CSS hides an empty message
    // outright (rather than letting it hold an empty grid row open in the
    // toolbelt), so the class has to be present whenever there IS text and
    // absent whenever there is not -- see beltMsgClear() below.
    el.className = 'belt-msg has-text' + (kind ? ' ' + kind : '');
    // The player acted on the one-time note; it has said what it needed to say.
    if (text) retireWalletFoot();

    // Clear it after a beat.
    //
    // The message used to stay until the next message replaced it, which meant
    // the last thing you did -- often "Pick broken - claim or repair a tool" --
    // sat in the card permanently, holding a row open that nothing else wanted.
    // Four seconds is long enough to read a transaction hash prefix.
    clearTimeout(this._beltMsgTimer);
    if (text) {
      this._beltMsgTimer = setTimeout(() => {
        const live = document.getElementById('belt-msg');
        if (!live) return;
        live.textContent = '';
        live.className = 'belt-msg';
      }, 4000);
    }
  }

  /**
   * Claim the next tier. Connected -> the chain is the source of truth and the
   * local belt is a mirror of it. Not connected -> the existing local
   * simulation runs, and the card says so. The two must never be confused:
   * granting a tool locally after an on-chain attempt is what this branch
   * exists to prevent.
   */


  /**
   * There is no belt panel to open -- it is a permanent card. Kept as a repaint
   * because three call sites (TAB key, the broken-pick path, touch controls)
   * still invoke it, and all of them want exactly this: re-read the chain and
   * repaint the rows.
   */
  openBelt() {
    this.refreshBelt();
  }

  closeBelt() { /* nothing to close: the toolbelt is a row in the top bar */ }

  /**
   * Buy one gem on chain. Price comes from the contract's own priceOf, never
   * a hardcoded number, and the credit is confirmed by re-reading
   * gemsOf(account, rarity) before the local balance moves.
   */


  /** Paint the shop rows with live prices read from the contract. */


  /**
   * Claim a tier on chain.
   *
   * Nothing local changes until the contract's own state confirms it. The
   * reply to a duplicate claim is a receipt that says "success" while the
   * count never moves, so a successful send is not treated as a grant.
   */


  /**
   * Pull the player's tools from the contract into the local belt.
   *
   * The chain is the source of truth when connected, so the local mirror is
   * rebuilt from what the contract actually holds rather than from what the
   * client hoped happened.
   */


  /**
   * Rank / ROI / Finds, read off the live season board.
   *
   * These three readouts sat at a permanent em dash for the entire life of the
   * card: #rank and #roi had markup but NO code anywhere in the repo ever wrote
   * them (checked every getElementById/querySelector in src/ and index.html).
   * The board already holds everything they need -- recordHunt() runs on every
   * completed dig -- so they were never a missing-data problem, just a missing
   * painter.
   *
   * `standing()` is the same call the board overlay makes, so the card and the
   * overlay can never disagree about the player's position.
   */
  /**
   * Name the season from the chain's own phase.
   *
   * This was a hardcoded "Season I - Verdant Hollow" string, which after the V2
   * cutover kept claiming Season I while the deployed contract sat in Preseason.
   * A title that names the wrong phase is worse than none: the player has no way
   * to tell it is fiction.
   *
   * V2 phase() returns 0=Preseason, 1=Live, 2=Closed. Preseason is id 0 and has
   * no end date, so it is named rather than numbered. Season 1 is only claimed
   * once phase() actually says Live AND current().id is 1 -- the id check stops
   * a future season 2 from being labelled "Season 1".
   */
  async paintSeasonTitle() {
    // The BRAND wordmark lives in #season-title ("DeepWood") and is never
    // touched here. The season PHASE -- real chain state -- is written to the
    // separate #season-phase line beneath it, so the corner reads "DeepWood"
    // with the phase as supporting detail instead of the phase replacing the
    // brand.
    const el = document.getElementById('season-phase');
    if (!el) return;

    const say = (label) => { el.textContent = label; };

    // The SEASON NAME is chain state, readable without a wallet: the contract
    // knows phase() whether or not the player has connected. "Preview mode"
    // belongs to the belt-mode row (it describes how WRITES behave); the card
    // title must say which season is actually on the contract, or a live
    // preseason reads as a broken game to every first-time visitor.
    try {
      const { getReader } = await import('./onchain.js');
      const r = await getReader();
      if (!r) { say(chainMode() === 'preview' ? 'Preview mode' : 'Offline'); return; }

      const [phaseHex, current] = await Promise.all([r.phase(), r.current()]);

      // phase() is uint8, so it arrives as a hex word. Comparing that string to
      // 0 would be false for every real value -- hence the decode, and a null
      // check so an unreadable phase reads as unknown rather than as Preseason.
      let phase = null;
      try { phase = phaseHex === null || phaseHex === undefined ? null : Number(BigInt(phaseHex)); } catch { phase = null; }

      if (phase === null) { say(onchainActive() ? 'Connecting...' : (chainMode() === 'preview' ? 'Preview mode' : 'Offline')); return; }
      if (phase === 0) { say('Preseason' + (onchainActive() ? '' : ' — preview')); return; }
      if (phase === 2) { say('Season closed'); return; }

      // Live. Name it from the chain's own id, never an assumed 1, so a future
      // season 2 cannot be labelled "Season 1".
      const id = Number(current?.id ?? 0);
      say((id > 0 ? `Season ${id} · Verdant Hollow` : 'Season live') + (onchainActive() ? '' : ' — preview'));
    } catch {
      // A failed read must NOT leave the previous season name up -- a stale name
      // is a lie. "Connecting..." is the honest thing to show when connected;
      // a preview client that cannot reach the chain owns the preview label.
      say(onchainActive() ? 'Connecting...' : (chainMode() === 'preview' ? 'Preview mode' : 'Offline'));
    }
  }

  paintSeasonStats() {
    // Rank / ROI / Finds were removed from the HUD at the user's request.
    // The season TITLE is still chain state the player reads, so
    // paintSeasonTitle() stays -- only the three stat readouts are gone.
    // The leaderboard still ranks players; it is one click away via the
    // trophy button, so the numbers were never the only route to them.
    this.paintSeasonTitle();
  }

  refreshBelt() {
    if (!document.getElementById('belt')) return;
    this.syncBeltDom();
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

    // Parallax-free ground sync: the ground is a screen-pinned TileSprite
    // (scrollFactor 0), so it never moves with the camera on its own -- the
    // tiles have to be nudged by the camera's scroll each frame or every
    // tree, rock and grass tuft appears to SLIDE across a frozen ground as
    // the player walks. tilePosition is in texture pixels; scroll and zoom
    // are in world/screen pixels, so account for both.
    if (this.bg) {
      this.bg.tilePositionX = this.cameras.main.scrollX * this.cameras.main.zoom;
      this.bg.tilePositionY = this.cameras.main.scrollY * this.cameras.main.zoom;
    }
    if (this.macro) {
      // macro is drawn at tileScale 2.4 -- one texture px covers 2.4 screen
      // px -- so dividing by 2.4 moves its pattern at the SAME screen rate
      // as the ground. Same rate, no parallax: everything pinned.
      this.macro.tilePositionX = (this.cameras.main.scrollX * this.cameras.main.zoom) / 2.4;
      this.macro.tilePositionY = (this.cameras.main.scrollY * this.cameras.main.zoom) / 2.4;
    }

    // HUD guard: never let the player enter the screen band the top card
    // owns. The card is part of the DOM, not the world, so the player sprite
    // would otherwise be free to walk beneath it and vanish under the acrylic
    // overlay -- the user called this out as 'should never go beyond the
    // header card border'. Convert the HUD's pixel height into world units
    // (they differ by the camera's zoom), then clamp the player's world Y to
    // be at least that far below the camera's scroll.
    //
    // We only clamp WALKING motion (when the player is actively moving up,
    // velocity.y < 0). Teleports -- the smoke test's setPosition() between a
    // pair of distant trees -- are exempt. Without that exception the clamp
    // silently pulled a teleported player back into the HUD band and the
    // y-sort smoke failed behind-the-tree cases.
    if (this.cameras && this.cameras.main) {
      const cam = this.cameras.main;

      // The HUD is two SIDE rails now, not a full-width header bar, so the old
      // rule ("keep the player below #hud's height") is wrong twice over:
      //
      //  1. #hud is the full-screen grid CONTAINER. Its offsetHeight is the
      //     tallest rail (~200px), not a top band, so the clamp band became 5x
      //     its old size.
      //  2. The middle of the screen is clear -- the rails are at the edges, so
      //     there is no full-width ceiling at all.
      //
      // Getting this wrong is exactly what made the UP button throw the player
      // DOWNWARD: walking north hit the oversized invisible ceiling within a
      // few pixels, the clamp snapped `player.y` back to minY (which is BELOW
      // where they were), and the upward input read as a hard downward jump.
      //
      // So clamp against the rail the player is actually underneath, plus a
      // small band for the top-centre chip. Cached: this runs every frame and
      // two getBoundingClientRect() calls per frame would thrash layout.
      const now = this.time.now;
      if (!this._hudBandAt || now - this._hudBandAt > 250) {
        this._hudBandAt = now;
        const bands = [];
        for (const id of ['season', 'belt']) {
          const el = document.getElementById(id);
          if (el) {
            const r = el.getBoundingClientRect();
            bands.push({ l: r.left, r: r.right, b: r.bottom });
          }
        }
        this._hudBands = bands;
      }

      let bandPx = 52;   // the top-centre status chip and the icon row
      const screenX = this.player.x - cam.scrollX;
      for (const b of (this._hudBands || [])) {
        if (screenX >= b.l && screenX <= b.r) bandPx = Math.max(bandPx, b.b + 12);
      }

      const minY = cam.scrollY + (bandPx / cam.zoom);
      const walking = this.player.body && this.player.body.velocity.y < -10;
      if (walking && this.player.y < minY) {
        this.player.y = minY;
        // Stop the upward velocity so the sprite doesn't jitter against the
        // ceiling. Otherwise the player can feel themselves push and get
        // pushed back, which reads as a bug rather than a wall.
        this.player.body.velocity.y = 0;
      }
    }

    // Pollen, birds, insects. One call, no allocation, dt clamped inside.
    this.ambience?.tick(delta / 1000);

    // The lantern follows the hunter, with a slow breath so it reads as a
    // flame rather than a decal. Two writes, no allocation.
    if (this.lantern) {
      const t = this.time.now / 1000;
      this.lantern.setPosition(this.player.x, this.player.y);
      this.lantern.setAlpha(0.78 + Math.sin(t * 1.7) * 0.07);
    }

    // Off-screen beacon pointer. Cheap: one pass over `nodes` (25 resident) and
    // early-outs on the common case where a beacon IS on screen.
    this.updateBeaconArrow();

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
      // Footstep fires ON the walk-cycle contact frames (0 and 2 of the 4-frame
      // row) so the sound lands exactly when the sprite's foot strikes the
      // ground -- not on a wall-clock timer that drifts against the animation.
      const frame = this.player.anims.currentFrame?.index ?? 0;
      if ((frame === 0 || frame === 2) && frame !== this._lastStepFrame) {
        this._lastStepFrame = frame;
        this.dust.emitParticleAt(this.player.x, this.player.y + 14);
        playFootstep();
      }
    } else {
      this._lastStepFrame = -1;
      this.animateIdle(vx, vy);
    }

    // context prompt
    const near = this.nearestNode();
    if (this.mining) {
      // Mid-dig: tell the player exactly what to do. Without this the site is
      // flagged used, `near` is null, and the old prompt went away entirely --
      // so a player who had started a dig was told nothing and left waiting for
      // a gem that their own clicks were supposed to produce.
      this.prompt.setVisible(true);
      const left = MINER_STRIKES - this.mining.done;
      this.prompt.setText(
        this.hasTouchPad ? `TAP ${left} MORE` : `SPACE ${left} MORE`
      );
    } else if (near) {
      this.prompt.setVisible(true);
      this.prompt.setText(
        !this._canHuntNow() ? this._blockedReason()
          : this.busy ? 'hunting...'
            : (this.hasTouchPad ? 'tap HUNT' : 'SPACE  hunt')
      );
    } else {
      this.prompt.setVisible(false);
    }
    // Anchor the prompt to the bottom of the view for every state. This used to
    // sit inside the `near` branch only, so pinning it up here means the
    // mid-dig "TAP n MORE" state cannot leave it stranded wherever it last was.
    this.prompt.setPosition(this.cameras.main.scrollX + this.scale.width / 2,
      this.cameras.main.scrollY + this.scale.height - 70);

    if (intent.hunt) {
      // While a dig is in progress the same input (SPACE / the HUNT button) is
      // the PICK, not a new hunt. `near` is null here because the site is
      // already flagged used, and `busy` is true by design for the duration of
      // the dig -- so this branch must be checked BEFORE the `!this.busy` gate
      // below, or the player can never swing.
      if (this.mining) {
        this.mineStrike(this.time.now);
      } else if (near && !this.busy) {
        this.doHunt(near);
      }
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

  /**
   * A screen-edge arrow pointing at the nearest beacon that is NOT visible.
   *
   * Only RESIDENT beacons are candidates (`this.nodes`, ~25 of them). That is a
   * deliberate limit rather than a shortcut: the resident set is exactly the
   * chunk the player can walk to next, so the arrow never points at something
   * two minutes away. Pointing at a truly global nearest would require
   * generating chunks ahead of the player, which is what the streaming radius
   * deliberately avoids.
   *
   * Hidden when any beacon is on screen -- an arrow next to a beacon you can
   * already see is noise. It also hides while a dig is running, so it does not
   * swing around during the reveal.
   */
  updateBeaconArrow() {
    if (!this.has('arrow')) return;
    const cam = this.cameras.main;
    const view = cam.worldView;
    const w = view.width, h = view.height;

    let best = null, bestD = Infinity;
    for (const n of this.nodes) {
      if (!n.active || n.getData('used')) continue;
      const inside = n.x >= view.x && n.x <= view.x + w
                  && n.y >= view.y && n.y <= view.y + h;
      if (inside) { best = null; break; }   // one visible beacon is enough
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, n.x, n.y);
      if (d < bestD) { bestD = d; best = n; }
    }

    if (!best || this.busy) {
      this.compassArrow?.setVisible(false);
      return;
    }

    if (!this.compassArrow) {
      this.compassArrow = this.add.image(0, 0, 'arrow')
        .setScrollFactor(0)          // screen space, not world space
        .setDepth(9000)              // above the world, below the DOM card
        .setOrigin(0.5, 0.5);
    }
    const a = this.compassArrow;
    a.setVisible(true);

    // Clamp the target into the viewport with a margin, then aim at that. The
    // arrow rides the edge rather than leaving the screen, which is the whole
    // point of an off-screen indicator.
    const M = 42;
    const tx = Phaser.Math.Clamp(best.x, view.x + M, view.x + w - M);
    const ty = Phaser.Math.Clamp(best.y, view.y + M, view.y + h - M);
    a.setPosition(tx - cam.scrollX, ty - cam.scrollY);
    a.setRotation(Phaser.Math.Angle.Between(a.x, a.y, best.x - cam.scrollX, best.y - cam.scrollY));

    // Fade in rather than pop, and breathe so it reads as live guidance.
    const t = this.time.now / 1000;
    a.setAlpha(0.72 + Math.sin(t * 3.4) * 0.16);
  }

  /**
   * Why a dig cannot start RIGHT NOW, in the player's own terms.
   *
   * The prompt used to say "tool broken - repair below" for every blocked
   * state. That is wrong advice for a player who has not bought anything yet --
   * there is nothing to repair -- and the comment on _canHuntNow() even said so
   * while the code went on ignoring it.
   */
  _blockedReason() {
    if (this.econ.tier === 0) {
      return this.hasTouchPad ? 'no pick yet - buy Wood' : 'no pick yet - buy Wood';
    }
    // Owned and undamaged means this is not a repair situation at all: the
    // local mirror has desynced from the chain, and telling a player with 20/20
    // durability to repair their pick is the same class of lie.
    if (this.econ.left > 0) {
      return this.hasTouchPad ? 'pick ready - sync issue' : 'pick ready - sync issue';
    }
    return 'Tool broken. Repair or upgrade first.';
  }

  /**
   * Can this player start a dig right now? Three distinct reasons no:
   * no tool at all, a broken tool, or a dig already running.
   */
  _canHuntNow() {
    if (this.econ.tier === 0) return false;
    if (this.econ.left === 0) return false;
    return true;
  }

  doHunt(node) {
    const tool = heldTool(this.econ);
    if (!tool) {
      // No working tool. Either they have not bought one yet, or the one they
      // hold is broken. These need DIFFERENT advice, so the message branches --
      // telling a brand-new player their pick is broken when they have never
      // held one reads as the game being broken.
      //
      // Throttled. This used to flash on EVERY press, so a player who kept
      // striking a broken pick got the identical line reprinted several times a
      // second and no sense of what to do next -- it read as the game erroring
      // rather than as a resource being exhausted. Once every 2s, and the
      // message names the fix.
      const now = this.time.now;
      if (now - (this._brokenAt ?? -1e9) > 2000) {
        this._brokenAt = now;
        this.openBelt();
        this.flash(this.econ.tier === 0
          ? 'No tool yet \u2014 buy Wood below to start hunting.'
          : 'Pick broken \u2014 repair with gems or upgrade to keep hunting.');
      }
      return;
    }
    // A SPENT tool cannot dig, in ANY mode. This check is FIRST, before the
    // onchain gate, because `heldTool()` deliberately returns a broken tool
    // rather than null (the belt still renders its name), so the `!tool`
    // branch above only ever fires for a player who owns nothing at all.
    //
    // It used to live inside the `onchainActive()` block, which meant a
    // preview-mode player with a spent pick got NO message at all -- the dig
    // simply never happened and the screen stayed silent.
    //
    // Throttled to once every 2s: a player who keeps mashing HUNT on a dead
    // pick would otherwise reprint the same line several times a second, which
    // reads as the game erroring rather than as a resource being exhausted.
    if (this.econ.tier > 0 && this.econ.left <= 0) {
      const now = this.time.now;
      if (now - (this._gateAt ?? -1e9) > 2000) {
        this._gateAt = now;
        this.openBelt();
        this.flash('Tool broken \u2014 repair or upgrade to keep hunting.');
        // A broken tool is NOT a settle problem unless there is ALSO an
        // unsettled batch. Pulsing the settle button here taught the player to
        // think the fix was "settle", when the fix is actually "repair or
        // upgrade". Only pulse settle when something real is queued.
        if ((this.queue?.size ?? 0) > 0) window.pulseSettle?.();
      }
      return;
    }
    // Settle-queue gate (V3): a dig is a queue push in connected mode, so the
    // queue rules bind here, before any animation. A FULL queue only needs a
    // settle (tool is fine), so the broken-tool case is already handled above.
    //
    // pulseSettle is a window global because this file has no DOM imports.
    if (onchainActive()) {
      if (!this.queue) {
        // First hunt since connect or since the last sync: line the queue up
        // with the chain before gating on it, or a stale queue could refuse a
        // legal dig. If _huntIndex is still unknown (refreshChainTool hasn't
        // resolved), DON'T create the queue with base=0 -- reveal() will read
        // the chain and build it with the RIGHT base. The gate only rejects
        // when the queue exists and is full.
        if (this._huntIndex !== undefined) {
          this.queue = new HuntQueue(BigInt(this._huntIndex), this.econ.tier);
        }
        // else: fall through; reveal's path will await huntIndexOf before
        // queueing, and the full-batch check cannot fire for a queue that has
        // not yet been created.
      }
      const now = this.time.now;
      if (this.queue && this.queue.size >= MAX_BATCH) {
        if (now - (this._gateAt ?? -1e9) > 2000) {
          this._gateAt = now;
          this.openBelt();
          this.flash(`Batch full (${MAX_BATCH} hunts) \u2014 SETTLE them below, then keep hunting.`);
          window.pulseSettle?.();
        }
        return;
      }
    } else if (this._wasConnected && this.econ.tier > 0) {
      // The wallet was connected (we have a chain tool on hand), then it was
      // dropped. WITHOUT the connected branch the dig would fall through to
      // the local preview and pretend to count -- a silent ledger that never
      // lands on-chain. Refuse the dig and say exactly what to do next.
      //
      // `_wasConnected` is set on every onchain refresh. A player who never
      // connected at all still gets the pure-preview path, because for them
      // the local mirror IS the game.
      const now = this.time.now;
      if (now - (this._gateAt ?? -1e9) > 2000) {
        this._gateAt = now;
        this.flash('Wallet disconnected \u2014 reconnect with the button above to keep hunting.');
      }
      return;
    }
    this.busy = true;
    node.setData('used', true);
    // Record the dig before the animation, so the epoch bump is committed even
    // if the player walks off mid-dig. The chunk REBUILD is deferred to
    // completeNodeDig(), because doing it here would destroy the node the
    // tween below is still animating.
    this.markNodeDug(node);

    this.startDig(node);
  }

  /**
   * The dig itself: the hunter actually works the ground before anything comes
   * up. Previously this was a 220ms alpha pulse on the NODE with the player
   * frozen -- the hunter held a pick and never used it, which read as the
   * animation being missing rather than as a dig.
   *
   * Now: three pick strikes over DIG_MS, each landing on the node and kicking
   * up dirt, then the reveal.
   *
   * Driven by a TWEEN CHAIN, not `time.delayedCall`. Measured: in the headless
   * smoke environment a plain `this.time.delayedCall(300, ...)` never fires --
   * the scene clock is not advancing there -- so a delayedCall-driven dig cannot
   * be verified by the test suite at all, and `busy` would latch true forever.
   * Tweens do advance (the walk cycle and every beacon animation depend on
   * them), so the whole dig is sequenced off chained tweens. That also means the
   * dig is driven by the same clock as the rest of the motion, which keeps it in
   * step with frame-rate compensation.
   */
  startDig(node) {
      this.player.anims.stop();
      this.player.setTexture(this.has('gen-hunter') ? 'gen-hunter' : 'hunter');

      // Mining is PLAYER-DRIVEN: the pick only falls when the player asks for it.
      //
      // This was a 2100ms tween chain that auto-fired three strikes, so one press
      // of HUNT did the whole dig for you. The ask was "an actual mining where you
      // have to click multiple times before the gem is mined" -- so the number of
      // strikes is now a real input, and the gem appears only once they are all
      // spent. Three is deliberate: enough to feel like work, few enough that a
      // phone player does not have to mash.
      //
      // Tier sets the pace, not the count. A better pick hits harder and faster
      // but still takes the same number of swings -- so upgrading is felt in the
      // quality of each strike rather than in the dig getting shorter, which would
      // make a tier-3 pick a strict shortcut through the interaction.
      this.mining = {
        node,
        done: 0,
        // Harder picks crack the rock faster: fewer frames between swings.
        cooldown: Math.max(140, 320 - (this.player.tier || 1) * 40),
        // Guards against a double-tap landing two strikes on one frame.
        lastAt: 0,
      };

      this.miningLabel = this.add.text(node.x, node.y + 34, 'STRIKE 1/3', {
        fontFamily: 'ui-monospace, monospace', fontSize: '13px',
        color: '#e8f6ff', stroke: '#0b1512', strokeThickness: 4,
      }).setOrigin(0.5).setDepth(node.depth + 2);

      // Face the site immediately, or the first swing lands behind him.
      this.player.setRotation(Math.atan2(node.y - this.player.y, node.x - this.player.x));
      this.updateMiningLabel();
    }

    /**
     * One pick swing, from a player click/tap/SPACE.
     *
     * Returns without effect if the swing is on cooldown or the dig is already
     * finished. Ignores extra input for ~160ms after the last strike so a fast
     * double-tap cannot spend two strikes in one frame -- the player would then
     * see "STRIKE 3/3" appear and vanish without a swing between them.
     */
    mineStrike(now) {
      const m = this.mining;
      if (!m || !m.node?.active) return;
      if (now - m.lastAt < 160) return;
      m.lastAt = now;

      m.done += 1;
      // Later strikes hit harder, so the last one is visibly the decisive blow.
      const power = 0.55 + (m.done / MINER_STRIKES) * 0.6;
      this.strike(m.node, power);
      playPick(power);
      this.updateMiningLabel();

      if (m.done >= MINER_STRIKES) this.finishDig();
    }

    /** Progress readout above the site: which swing is next, and how many are left. */
    updateMiningLabel() {
      const m = this.mining;
      if (!m || !this.miningLabel) return;
      if (m.done >= MINER_STRIKES) {
        this.miningLabel.setText('BROKEN');
        return;
      }
      this.miningLabel.setText(`STRIKE ${m.done + 1}/${MINER_STRIKES}`);
      this.miningLabel.setPosition(m.node.x, m.node.y + 34);
    }

    /** The dig is complete: hand over the find and retire the site. */
    finishDig() {
      const m = this.mining;
      if (!m) return;
      this.mining = null;
      this.miningLabel?.destroy();
      this.miningLabel = null;
      // Clear the "1 MORE" prompt immediately. update() only rewrites the prompt
      // text inside its `if (this.mining)` branch, so once mining ends the last
      // swing count stays frozen on screen until the player walks near another
      // site -- reading as "keep mining" on a dig that is already finished.
      this.prompt.setVisible(false);
      this.player.setScale(1);
      this.player.setRotation(0);

      // The pick's durability is spent at SETTLE in the connected game (V3
      // batches it), so the mirror wears it here instead and refreshChainTool()
      // restores the authoritative count once the batch lands. In preview the
      // mirror is the only state at all.
      let used = { broke: false };
      used = consumeUse(this.econ);
      this.updateHud();
      // Repaint the DOM toolbelt row. `consumeUse` is the ONLY thing that
      // decrements `left`, and the belt readout the player actually sees is a
      // DOM row rendered by `syncBeltDom()` -- which is called from
      // refreshBelt() and the chain-sync path, and from NEITHER after a dig.
      // So the row kept whatever it was painted with at boot and sat at
      // "TI 20/20 HELD" indefinitely, while the Phaser HUD bar behind it did
      // fall correctly. Two renderers of one value, only one of them repainted.
      // This is the missing call.
      this.refreshBelt();

      this.reveal(m.node).then((ok) => {
        // On a failed on-chain settlement the node was un-marked inside
        // reveal() so it stays diggable -- do NOT retire it here.
        if (ok !== false && m.node?.active) {
          // Rebuild the chunk AFTER the reveal has read everything it needs
          // off the node. With scarcity (isChunkSpent) this removes the spent
          // site.
          this.completeNodeDig();
        }
      });

      // One message about the pick, not two. This block used to be reached twice
      // on a breaking dig -- a `used.broke` flash here AND the low-durability
      // flash below -- so the last dig of a pick printed two overlapping lines
      // about the same event. The break is the more important message, so it
      // wins; otherwise warn that the pick is nearly spent.
      //
      // Warning rather than surprise is the point: durability is charged on the
      // final strike, so without this the player only learns the pick is dead
      // by pressing HUNT afterwards and being refused.
      const left = this.player.left;
      if (used.broke) {
        this.flash(`${toolName(this.player.tier)} broke \u2014 repair with gems or upgrade to keep hunting.`);
      } else if (left <= 2) {
        this.flash(`Pick has ${left} use${left === 1 ? '' : 's'} left.`);
      }
    }

  /** One pick impact: the hunter rocks, the site shakes, dirt flies. */
  strike(node, power) {
    if (!node.active) return;
    const sx = this.player.scaleX, sy = this.player.scaleY;
    this.tweens.add({
      targets: this.player,
      scaleX: sx * (1 + 0.16 * power), scaleY: sy * (1 - 0.13 * power),
      duration: 110, yoyo: true, ease: 'Quad.out',
    });
    this.tweens.add({
      targets: node,
      x: node.x + (this._strikeFlip ? 3 : -3),
      alpha: 1 - 0.18 * power,
      duration: 90, yoyo: true, ease: 'Quad.out',
    });
    this._strikeFlip = !this._strikeFlip;

    const dirt = this.add.particles(node.x, node.y - 6, 'spark', {
      speed: { min: 20, max: 60 * power }, angle: { min: 200, max: 340 },
      gravityY: 220, scale: { start: 0.22, end: 0 },
      lifespan: 380, quantity: 1, emitting: false,
    });
    dirt.setDepth(node.depth - 1);
    dirt.explode(3 + Math.round(power * 6));

    // Sparks at the cap, so a beacon being struck is visible from a distance.
    const cap = this.add.particles(node.x, node.y - 24, 'spark', {
      speed: { min: 10, max: 45 * power },
      scale: { start: 0.3, end: 0 }, lifespan: 300,
      quantity: 1, emitting: false,
    });
    cap.explode(2);
  }

  async reveal(node) {
    // Snapshot the tier BEFORE the reveal, so a tool that breaks on this
    // hunt still rolls against the tier that swung the pick.
    //
    // `this.econ.tier`, NOT `this.player.tier`. `this.player` is the Phaser
    // sprite, so its `tier` is undefined and this silently rolled EVERY hunt
    // against tier 1 -- a Steel pick hunting on Wood's table, and Gold
    // throwing outright.
    const tier = this.econ.tier || 1;

    let result;
    if (onchainActive()) {
      // V3 settle-queue path. The dig used to open the wallet and settleHunt
      // right here; per the design it now PUSHES onto the in-memory queue,
      // and the SETTLE button is the only thing that ever talks to the wallet.
      //
      // The numbers shown are the contract's own previewHuntAt(player, tier,
      // queue.size), i.e. the roll for the hunt this dig WILL become once the
      // batch settles. settleBatch recomputes from the committed season seed
      // and reverts ResultMismatch on any difference, so what the player saw
      // is exactly what the contract banks -- as long as the queue base has
      // not drifted. If it did (another device settled in between), the SETTLE
      // button refuses and re-syncs rather than spend gas on a revert.
      if (!this.queue) {
        // First dig since connect or last sync: line the queue up with the
        // chain's own hunt index. If we don't know it yet, ASK the chain
        // right now. If that read fails, REFUSE the dig -- a queue with the
        // wrong base is worse than no queue (it gets rejected at settle and
        // the user burns two digs on a batch that can never commit).
        if (this._huntIndex === undefined) {
          try {
            const { getReader } = await import('./onchain.js');
            const r2 = await getReader();
            const { getState } = await import('./wallet.js');
            if (r2) {
              const { account } = getState();
              if (account) this._huntIndex = Number(await r2.huntIndexOf(account));
            }
          } catch { /* fall through */ }
        }
        if (this._huntIndex === undefined) {
          // Could not read the chain index at ALL. Better to surface that
          // than to start a batch that settleBatch will refuse.
          if (node?.setData) node.setData('used', false);
          this.flash('Could not read the chain hunt index -- check your connection and re-dig.');
          this.busy = false;
          return false;
        }
        this.queue = new HuntQueue(BigInt(this._huntIndex), tier);
      }
      const { previewHuntAtFor } = await import('./onchain.js');
      const preview = await previewHuntAtFor(tier, this.queue.size);
      if (!preview) {
        // Preview failed (RPC hiccup or season boundary). Keep the node
        // diggable; charging a hunt we could not see would be guessing.
        if (node?.setData) node.setData('used', false);
        this.flash('Could not read the next roll from the chain — the dig stays open.');
        this.busy = false;
        return false;
      }
      this.queue.push(preview.counts, preview.bestSingleWei);
      result = {
        counts: preview.counts.map((n) => Number(n)),
        bestSingleWei: preview.bestSingleWei,
        total: preview.counts.reduce((a, b) => a + Number(b), 0),
        valueWei: preview.bestSingleWei,
        pending: true,
      };
      this.huntIndex += 1;
      // Durability was already taken in finishDig() on the local mirror, and
      // the chain will charge the whole batch at settle. Repaint both
      // surfaces that speak about the queue: the badge (window.renderQueue)
      // and the belt, whose SETTLE button must now show "settle N" and lose
      // its disabled state. Without refreshBelt the button stayed greyed out
      // and the dig looked like it never counted.
      window.renderQueue?.(this.queue.size);
      this.refreshBelt();
    } else {
      result = rollHunt(
        this.seed, this.wallet ?? '0xplayer', this.huntIndex, tier,
        this.econ.skill ?? 1,
      );
      this.huntIndex += 1;
    }

    this.busy = false;

    // The credit already happened on the contract when connected -- nothing to
    // add to the mirror. (In V3 terms: the credit happens at SETTLE, and this
    // dig is only queued, so `pending` results must credit NOTHING.) In preview
    // mode there is no contract, so the local mirror IS the state.
    if (!result.pending && !onchainActive()) {
      creditGems(this.econ, result.counts);
    }
    window.renderGems?.();

    // Season board. A queued hunt has not happened on-chain yet -- the batch
    // may still be abandoned -- so it must not appear in the ledger until the
    // settle lands. doSettle() records the whole batch at once.
    if (!result.pending) {
      recordHunt(
        this.board, this.wallet ?? '0xplayer', result.counts, tier,
        Math.floor(Date.now() / 1000)
      );
    }

    // find the most valuable gem in the haul -- that's the one that pops out
    let topRarity = 0;
    result.counts.forEach((c, r) => { if (c > 0 && r > topRarity) topRarity = r; });

    // burst
    const burst = this.add.particles(node.x, node.y, 'spark', {
      speed: { min: 30, max: 90 }, scale: { start: 0.4, end: 0 },
      lifespan: 500, quantity: 8, emitting: false,
    });
    burst.explode(8);

    // The reveal shows THE gem that was mined, not every rarity in the haul.
    //
    // The fan-out this replaces was my own mistake, reported back as "when it
    // claims a gem that is not quartz, it shows both the gem and the quartz
    // gem". The cause is in engine.js: a hunt rolls 3-5 gems INDEPENDENTLY from
    // the drop table, and quartz is the common tier, so counts[0] is non-zero in
    // almost every single haul. Fanning out all non-zero rarities therefore put
    // a quartz sprite on screen next to the ruby that actually mattered, every
    // time. Quartz was not a bug in the roll; it was the roll working correctly
    // and the presentation failing to prioritise it.
    //
    // So: one sprite, for the highest rarity in the haul (`topRarity`, computed
    // above). That is the stone the player was hunting for, and it is the one
    // worth drawing. The full haul is not lost -- it is already credited to
    // the player's balance and recorded on the season board, and the satchel lists
    // every rarity with its count. If the haul is pure quartz, topRarity is 0
    // and a quartz sprite shows, which is correct.
    const shown = [{ rarity: topRarity, count: result.counts[topRarity] }];
    const FAN = 1;
    const baseX = node.x;

    shown.slice(0, FAN).forEach((s, i) => {
      // The GENERATED cut gem, loaded from art/gem-*.png as 'gen-gem-N'.
      // Source art has its longest edge at 192px, so GEM_SCALE brings a gem to
      // roughly 64px on screen: larger than the 42px hunter, well under the
      // smallest tree (134px). The gems vary in shape and aspect (a marquise
      // quartz next to a round diamond), so they are scaled by their LONGEST
      // edge rather than squashed to a common square -- that keeps every stone
      // undistorted and still lands them all at a similar visual size.
      const genGem = `gen-gem-${s.rarity}`;
      if (!this.has(genGem)) return;
      // Depth must sit above SCENERY, not at 10. Trees are depth = world-y and
      // chunks put nodes at hundreds or thousands of pixels of world y, so a
      // tree at y=600 drew OVER the reveal pop (depth 10) and made the gem +
      // count invisible on any beacon tucked behind trunks. UX_DEPTH (50000
      // + 2) is above every scenery depth in the game but still below the
      // always-on-top HUD plane -- exactly where a floating reveal belongs,
      // because it is UI feedback about a click, not a world object that
      // should respect y-sorting.
      const revealDepth = 60000;
      const gem = this.add.image(baseX + i * GEM_STEP, node.y, genGem)
        .setDepth(revealDepth)
        .setScale(0);
      // Pop in with a small stagger so a multi-gem haul unfurls rather than
      // appearing all at once.
      this.tweens.add({
        targets: gem, scale: GEM_SCALE, duration: 260, delay: i * 110, ease: 'Back.out',
        onComplete: () => {
          // Hold at full size, pulsing gently, THEN leave. The old code began
          // drifting the instant the pop finished, which is why the gem was
          // never actually seen.
          this.tweens.add({
            targets: gem, scale: GEM_SCALE * 1.12, duration: 220, yoyo: true, repeat: 1, ease: 'Sine.inOut',
            onComplete: () => {
              this.tweens.add({
                targets: gem, y: node.y - 58, alpha: 0, scale: GEM_SCALE * 0.72,
                duration: 520, ease: 'Sine.in',
                onComplete: () => gem.destroy(),
              });
            },
          });
        },
      });
      // Always label the pop, even when the haul is a single stone. The dig
      // otherwise looks like it produced nothing on a `count === 1` roll,
      // which reads as a rendering fault to the player ("the first beacon
      // didn't show how many gems"). The fan-of-many case still gets 'xN'.
      if (s.count >= 1) {
        const label = this.add.text(baseX + i * GEM_STEP, node.y + 26, `x${s.count}`, {
          fontFamily: 'ui-monospace, monospace', fontSize: '13px', color: '#e8f6ff',
        }).setOrigin(0.5).setDepth(revealDepth + 1).setAlpha(0.9);
        this.tweens.add({
          targets: label, y: node.y - 30, alpha: 0, duration: 900, delay: 200,
          ease: 'Sine.in', onComplete: () => label.destroy(),
        });
      }
    });

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
    // The DOM shell is the only place that renders the find as text (the
    // satchel readout). It previously ALSO rendered a second copy through the
    // deepwood:find listener's own innerHTML write, so every dig drew "x5"
    // twice -- once in the satchel strip and once in a floating label. Remove
    // the duplicate: the satchel is the single source of truth for the count.

    if (topRarity >= 2) {
      this.flash(`${RARITY_NAME[topRarity]}!  ${(Number(result.valueWei) / 1e18).toFixed(5)} ETH`);
    }
    playReveal(topRarity);

    this.updateHud();
    this.busy = false;
  }

  /** An on-screen message that appears and then disappears.
   *
   * ONE reusable element, not a new Text per call. The old version created a
   * fresh object every time, so two messages inside 2s (a pick breaking and
   * the very next press being refused) drew two overlapping banners, and a
   * message that arrived mid-fade stacked a third on top. One element, one
   * live tween: a new message kills the pending tween, rewrites the text and
   * restarts the fade, so only the newest line is ever on screen.
   *
   * It sits OVER THE PLAYER rather than at a fixed screen position. A 16px
   * banner at the top of the screen is a chrome bar the player has to look
   * away from the forest to read; a small line just above their own feet is
   * read without moving the eye. The offset is in world space, so it follows
   * the hunter as they walk and stays anchored while the camera tracks.
   */
  flash(msg) {
    if (!this._toast) {
      const t = this.add.text(0, 0, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px', color: '#fff8d0',
        backgroundColor: '#0d1a10dd', padding: { x: 8, y: 4 },
        // Two lines, not one. The longest line the game prints (the
        // broken-tool refusal) is ~330px at 11px, which stretches the bubble
        // wider than the rail and reads as a banner rather than a note.
        // Wrapping at 260px splits it cleanly in two; 200px made it three
        // lines, which is a paragraph, not a note. wordWrap rather than a
        // hard \n so every flash message gets the same treatment, not just
        // this one.
        wordWrap: { width: 260 },
        align: 'center',
      }).setOrigin(0.5, 1).setDepth(UI_DEPTH + 1);
      t.setAlpha(0);
      this._toast = t;
    }
    const t = this._toast;
    // Anchor above the player, in WORLD coordinates. 30px above the feet is
    // clear of the sprite's own head and of the STRIKE n/3 label that also
    // hangs under a dig site.
    t.setPosition(this.player.x, this.player.y - 30);
    this.tweens.killTweensOf(t);
    t.setText(msg);
    t.setAlpha(1);
    t.setVisible(true);
    this._toastTween = this.tweens.add({
      targets: t, alpha: 0, delay: 2200, duration: 500,
      onComplete: () => { t.setVisible(false); this._toastTween = null; },
    });
  }
}


