/**
 * Headless smoke test: does the game actually run and render?
 *
 * "The dev server returns 200" proves nothing -- a runtime error in create()
 * still serves the page perfectly. This loads the real page in Chromium,
 * captures console errors, drives the character, performs a hunt, and checks
 * that pixels actually changed on screen.
 */
import puppeteer from 'puppeteer';

const URL = process.env.DW_URL || 'http://localhost:5173/';
const SHOT = process.env.DW_SHOT || '/tmp/deepwood.png';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { console.log(`  FAIL  ${name}  ${detail}`); fail++; }
  else console.log(`  ok    ${name}  ${detail}`);
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n   STACK: ' + String(e.stack || '').split('\n').slice(0,12).join('\n   ')));

console.log('loading', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
// Poll for the canvas rather than waiting on network idle: Vite keeps an HMR
// websocket open forever, so networkidle never fires against the dev server.
await page.waitForSelector('#game canvas', { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3500));

// --- does a canvas exist and does Phaser think it booted?
const boot = await page.evaluate(() => {
  const c = document.querySelector('#game canvas');
  return {
    hasCanvas: !!c,
    w: c ? c.width : 0,
    h: c ? c.height : 0,
    // Phaser stores the game on the canvas element's parent in v3
    gameBooted: !!(window.Phaser && window.Phaser.VERSION),
    phaserVersion: window.Phaser ? window.Phaser.VERSION : null,
  };
});
check('canvas present', boot.hasCanvas, `${boot.w}x${boot.h}`);
check('canvas has size', boot.w > 0 && boot.h > 0, `${boot.w}x${boot.h}`);
check('phaser loaded', boot.gameBooted, boot.phaserVersion || '');

const genTextures = await page.evaluate(() => {
  const t = window.Phaser ? null : null;
  return null;
});

// --- is anything actually drawn?
// Read pixels from a 2D COPY of the canvas, not via gl.readPixels: the WebGL
// back buffer is cleared after compositing, so gl.readPixels outside the draw
// call reliably returns all-zero even when the game is drawing perfectly.
const painted = async (label) => page.evaluate((lbl) => {
  const c = document.querySelector('#game canvas');
  if (!c) return { label: lbl, ok: false, reason: 'no canvas' };
  const tmp = document.createElement('canvas');
  tmp.width = c.width; tmp.height = c.height;
  const g = tmp.getContext('2d');
  g.drawImage(c, 0, 0);
  let d;
  try { d = g.getImageData(0, 0, tmp.width, tmp.height).data; }
  catch (e) { return { label: lbl, ok: false, reason: 'getImageData: ' + e.message }; }
  const seen = new Set();
  let bright = 0;
  for (let i = 0; i < d.length; i += 4 * 53) {
    const r = d[i], g2 = d[i + 1], b = d[i + 2];
    if (r + g2 + b > 60) bright++;
    seen.add(((r >> 3) << 10) | ((g2 >> 3) << 5) | (b >> 3));
  }
  return { label: lbl, ok: bright > 0 && seen.size > 8, bright, colors: seen.size };
}, label);

const p1 = await painted('after boot');
check('something is rendered', p1.ok, `bright samples=${p1.bright} distinct colours=${p1.colors}`);

// --- drive the character: press keys and confirm the view changes
const before = await page.screenshot({ encoding: 'binary' });
await page.keyboard.down('KeyD');
await new Promise((r) => setTimeout(r, 1200));
await page.keyboard.up('KeyD');
await page.keyboard.down('KeyS');
await new Promise((r) => setTimeout(r, 800));
await page.keyboard.up('KeyS');
await new Promise((r) => setTimeout(r, 400));
const after = await page.screenshot({ encoding: 'binary' });

check('canvas changes when the character moves', Buffer.compare(before, after) !== 0,
  `screenshots differ: ${Buffer.compare(before, after) !== 0}`);

// --- hunt: steer toward the nearest node using real key presses, then hunt.
const walked = await page.evaluate(() => {
  const s = window.__scene;
  // nearestAnyNode ignores the interaction radius so the test can steer to it
  let best = null, bd = Infinity;
  for (const n of s.nodes) {
    if (n.getData('used')) continue;
    const d = Math.hypot(n.x - s.player.x, n.y - s.player.y);
    if (d < bd) { bd = d; best = n; }
  }
  if (!best) return null;
  return { nx: best.x, ny: best.y, px: s.player.x, py: s.player.y, dist: Math.round(bd) };
});

let hunted = false;

// Pick the nearest unused node, then drive the character onto it with real
// key events. Keys are HELD across the wait and only released afterwards:
// Phaser clears isDown on keyup, so a press/release inside one tick is
// invisible to the game loop.
if (walked) {
  const nearestAny = () => page.evaluate(() => {
    const s = window.__scene;
    let best = null, bd = Infinity;
    for (const n of s.nodes) {
      if (n.getData('used')) continue;
      const d = Math.hypot(n.x - s.player.x, n.y - s.player.y);
      if (d < bd) { bd = d; best = n; }
    }
    return best ? { dx: best.x - s.player.x, dy: best.y - s.player.y, dist: bd, inRange: !!s.nearestNode() } : null;
  });

  for (let i = 0; i < 40; i++) {
    const dir = await nearestAny();
    if (!dir) break;

    if (dir.inRange) {
      await new Promise((r) => setTimeout(r, 250));
      const before = await page.evaluate(() => ({
        finds: window.__scene.finds.length,
        durability: window.__scene.durability,
      }));
      await page.keyboard.down('Space');
      await new Promise((r) => setTimeout(r, 120));
      await page.keyboard.up('Space');
      await new Promise((r) => setTimeout(r, 1600));
      const after = await page.evaluate(() => {
        const s = window.__scene;
        return {
          finds: s.finds.length,
          durability: s.durability,
          log: s.logText ? s.logText.text : '',
        };
      });
      console.log('   hunt: before', JSON.stringify(before), '-> after', JSON.stringify(after));
      const filled = await page.evaluate(() => {
        const el = document.getElementById('gemlist');
        const t = el && el.textContent;
        return t && !t.includes('empty') ? t : null;
      });
      if (filled) {
        hunted = true;
        console.log('  find:', filled.replace(/\s+/g, ' ').trim().slice(0, 70));
      }
      break;
    }

    const keys = [];
    if (Math.abs(dir.dx) > 6) keys.push(dir.dx > 0 ? 'KeyD' : 'KeyA');
    if (Math.abs(dir.dy) > 6) keys.push(dir.dy > 0 ? 'KeyS' : 'KeyW');
    if (!keys.length) break;
    for (const k of keys) await page.keyboard.down(k);
    await new Promise((r) => setTimeout(r, 220));
    for (const k of keys) await page.keyboard.up(k);
  }
}

// --- tree collision: walk straight into a trunk and confirm we are stopped.
const collided = await page.evaluate(async () => {
  const s = window.__scene;
  // StaticPhysicsGroup2 exposes children via getChildren(), not .list.
  // Pick the MOST ISOLATED trunk: the player walking right is stopped by
  // whichever tree it hits first, so aiming at a trunk wedged among
  // neighbours measures the neighbour, not the one we targeted.
  const kids = s.trunks.getChildren();
  if (!kids.length) return { ok: false, reason: 'no trunk colliders' };
  const trunk = kids[Math.floor(kids.length / 2)];

  // Disable all other colliders so nothing else can stop the player first.
  // Without this the probe measures whichever tree happens to be in the way,
  // and the outcome changes every page load.
  const others = kids.filter((o) => o !== trunk);
  for (const o of others) o.body.enable = false;

  // Teleport just left of the trunk, then push right into it.
  s.player.setPosition(trunk.x - 40, trunk.y);
  s.player.body.reset(s.player.x, s.player.y);
  const before = s.player.x;
  s.player.setVelocity(240, 0);
  await new Promise((r) => setTimeout(r, 700));
  s.player.setVelocity(0, 0);
  const after = s.player.x;
  for (const o of others) o.body.enable = true; // restore the world
  const trunkLeft = trunk.x - 10; // half the 20px collider width
  const t = typeof trunk.getData === 'function' ? trunk : null;
  return {
    ok: after < trunk.x,
    before: Math.round(before), after: Math.round(after),
    trunkX: Math.round(trunk.x), moved: Math.round(after - before),
    stoppedShortOf: Math.round(trunk.x - after),
    // The player's box is 5px wide (setSize 10 at scale 0.5) and the trunk
    // box is 20px, so resting contact puts the centre 12.5px from the trunk
    // centre. Anything under 20 means we are inside or on top of it.
    overlaps: after > trunkLeft + 10,
    othersDisabled: others.length,
  };
});
// --- y-sorting: the player must draw BEHIND a tree whose base is higher up
// the screen, and IN FRONT of one whose base is lower. Without this the
// character floats on top of the whole forest.
const sorted = await page.evaluate(async () => {
  const s = window.__scene;
  // Find a tree, stand just below its base, and confirm the player sorts in
  // FRONT of it. Then stand above another and confirm they sort BEHIND.
  const trees = s.sortables.filter((o) => o.texture && o.texture.key.startsWith('tree'));
  if (trees.length < 2) return { ok: false, reason: 'not enough trees' };

  // 1) player below a tree's base -> player draws in front (depth greater)
  const t1 = trees[0];
  s.player.setPosition(t1.x, t1.y + 40);
  s.player.body.reset(s.player.x, s.player.y);
  await new Promise((r) => setTimeout(r, 120)); // let update() set depth
  const frontOk = s.player.depth > t1.depth;

  // 2) player above a tree's base -> player draws behind (depth smaller)
  const t2 = trees[1];
  s.player.setPosition(t2.x, t2.y - 40);
  s.player.body.reset(s.player.x, s.player.y);
  await new Promise((r) => setTimeout(r, 120));
  const behindOk = s.player.depth < t2.depth;

  return {
    ok: frontOk && behindOk,
    frontOk, behindOk,
    front: { py: Math.round(s.player.y) },
    case1: { treeY: Math.round(t1.y), treeDepth: Math.round(t1.depth) },
    case2: { py: Math.round(s.player.y), playerDepth: Math.round(s.player.depth), treeY: Math.round(t2.y), treeDepth: Math.round(t2.depth) },
  };
});
// --- tool progression: earn, claim, break, repair. Driven through the real
// scene API, not by poking internals, so this exercises the same paths a
// player's clicks do.
const prog = await page.evaluate(async () => {
  const s = window.__scene;
  const out = { steps: [] };
  const log = (k, v) => out.steps.push(k + '=' + JSON.stringify(v));

  // Start: free tier 1, zero gems.
  log('start', {
    tools: s.belt.tools.length,
    tier: s.belt.tools[0].tier,
    left: s.belt.tools[0].left,
    common: s.belt.common,
  });

  // Cannot claim tier 2 with no gems.
  const { canClaim, claimTool, repairTool, canRepair, equip, activeTool,
          consumeUse } = await import('/src/tools.js');
  log('claim2_at_0', canClaim(s.belt, 2));

  // Grind gems the way hunting does.
  s.belt.common = 69_000;
  log('after_grind', { common: s.belt.common });

  log('claim2', canClaim(s.belt, 2));
  log('r_claim2', claimTool(s.belt, 2));
  log('claim3', claimTool(s.belt, 3).ok);
  log('claim4', claimTool(s.belt, 4).ok);
  log('owned', s.belt.tools.map((t) => t.tier));
  log('dup_claim2', canClaim(s.belt, 2));

  // Break the active tier 4.
  const t4 = s.belt.tools[3];
  while (t4.left > 0) consumeUse(s.belt);
  log('broke', { left: t4.left, activeTool: !!activeTool(s.belt) });

  // A working tool cannot be repaired.
  log('repair_working', canRepair(s.belt, 0));

  // Grant gems and repair.
  s.belt.common = 40_000;
  log('r_repair4', repairTool(s.belt, 3));
  log('after_repair', { left: t4.left, active: activeTool(s.belt)?.tier });

  // Rotation: swap back to a stowed tier 2.
  log('equip2', equip(s.belt, 1));
  log('now_holding', activeTool(s.belt)?.tier);
  s.updateHud();
  return out;
});

for (const line of prog.steps) console.log('   belt', line);

// Parse on the first '=' rather than a hand-counted offset -- the offsets
// were off by one and threw inside the page, losing every later check.
const val = (key) => {
  const line = prog.steps.find((l) => l.startsWith(key + '='));
  if (!line) throw new Error(`no step '${key}' in: ${prog.steps.join(' | ')}`);
  return JSON.parse(line.slice(line.indexOf('=') + 1));
};
const owned = val('owned');
const holding = val('now_holding');
const afterRepair = val('after_repair');
const broke = val('broke');
const dup = val('dup_claim2');

// check(name, condition, detail) takes a CONDITION. These were written
// actual/expected, so a correct `false` was passed as the condition itself
// and the check reported failure. Compare explicitly instead.
// --- season leaderboard: the board must rank EFFICIENCY and say so.
const lb = await page.evaluate(async () => {
  const s = window.__scene;
  const { recordHunt, rank, standing, compareRoi, roiDenom, SPLAY_FLOOR_WEI } =
    await import('/src/season.js');
  const now = Math.floor(Date.now() / 1000);

  // Enough tier-1 hunts to clear the 0.005 ETH splay floor (50 x 0.0001).
  // Below that the player is correctly EXCLUDED, not ranked at the bottom.
  for (let i = 0; i < 60; i++) recordHunt(s.board, '0xplayer', [4, 1, 0, 0, 0], 1, now);

  s.toggleLeaderboard();
  const rows = rank(s.board);
  const me = rows.find((r) => r.address === '0xplayer');
  const texts = s.lbPanel ? s.lbPanel.list.filter((o) => o.type === 'Text').map((o) => o.text) : [];

  return {
    open: !!s.lbPanel,
    players: rows.length,
    myRank: me ? me.rank : null,
    of: rows.length,
    roiDescending: rows.every((r, i) => i === 0 || compareRoi(rows[i - 1], r) >= 0),
    mentionsEfficiency: texts.some((t) => /EFFICIENCY/i.test(t)),
    mentionsNotWealth: texts.some((t) => /not by wealth/i.test(t)),
    hasMeRow: texts.some((t) => /^\s*\d+\s+YOU\b/.test(t)),
    topRowSample: texts.filter((t) => /^\s*1\s+\S/.test(t))[0] || null,
    standings: standing(s.board, '0xplayer'),
  };
});

// --- commit-then-act: the root must be published, verifiable, and tamper-evident
await page.evaluate(async () => {
  const m = await import('/src/commitment.js');
  window.__verifySeason = m.verifySeason;
});

const commit = await page.evaluate(() => {
  const s = window.__scene;
  const v = s.verifyCommitment();
  return {
    root: s.commitRoot,
    leaves: s.commitLeafCount,
    committed: s.board.committed,
    boardRoot: s.board.commitRoot,
    verifies: v.ok,
    recomputed: v.recomputed,
    // The attack: after publishing the root, quietly add a player whose
    // results were never committed to. A player recomputing must reject it.
    tampered: (() => {
      const rigged = [...s.commitPlan, { player: '0xCHEF', hunts: 9999 }];
      return window.__verifySeason(s.seasonSeed, rigged, s.commitRoot);
    })(),
  };
});

check('season root is published', /^0x[0-9a-f]{64}$/.test(commit.root || ''), commit.root);
check('  the board is committed', commit.committed, true);
check('  root covers every planned hunt', commit.leaves, 13 * 200);
check('  root verifies against the seed', commit.verifies, true);
check('  recomputed root matches', commit.recomputed, commit.root);
check('  a tampered season is REJECTED', commit.tampered.ok === false, 'root mismatch');

check('leaderboard opens', lb.open, true);
check('board has rivals', lb.players > 5, `${lb.players} players`);
check('player is ranked once past the splay floor', lb.myRank > 0, `rank #${lb.myRank} of ${lb.of}`);
check('board ranks by ROI descending', lb.roiDescending, true);
check('board says it ranks efficiency', lb.mentionsEfficiency, true);
check('board says NOT wealth', lb.mentionsNotWealth, true);
check('player has a row on the board', lb.hasMeRow, true);
check('top row is well formed', /^\s*1\s+\S+\s+[\d.]+[KM]?x\s+0\.\d+ ETH$/.test(lb.topRowSample || ''), lb.topRowSample);
check('standing reports rank 1 of 13', lb.standings.rank === 1, `#${lb.standings.rank}`);
check('  and there is nobody to pass at rank 1', lb.standings.needsToPass === null, true);
check('  and it is in the prize places', lb.standings.inTopTen, true);

// The floor excludes rather than damps. Prove a sub-floor player is absent
// from the ranked list entirely -- flooring would have scored this player
// 819,200x and handed them the top of the board.
const subfloor = await page.evaluate(async () => {
  const s = window.__scene;
  try {
    const { recordHunt, rank, onRoiBoard, shortOfFloor } = await import('/src/season.js');
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 10; i++) recordHunt(s.board, '0xcasual', [4, 0, 0, 0, 0], 1, now);
    const e = s.board.players.get('0xcasual');
    return {
      onBoard: onRoiBoard(e),
      ranked: rank(s.board).some((r) => r.address === '0xcasual'),
      gap: String(shortOfFloor(e)),
    };
  } catch (err) {
    // Returning the reason beats a bare "cannot read of undefined" later.
    return { error: String(err) };
  }
});
check('a sub-floor player is off the board', subfloor.onBoard === false, `onRoiBoard=${subfloor.onBoard}`);
check('  and absent from the ranking', subfloor.ranked === false, `ranked=${subfloor.ranked}`);
check('  with the shortfall reported', subfloor.gap !== '0', `short ${subfloor.gap} wei`);

await page.evaluate(() => window.__scene.closeLeaderboard());

check('owns all four tiers', JSON.stringify(owned) === '[1,2,3,4]', owned.join(','));
check('duplicate tier is rejected', dup.ok === false, dup.reason || '');
check('a broken tool cannot hunt', broke.activeTool === false, `activeTool=${broke.activeTool}`);
check('repair restores durability', afterRepair.left === 80, `${afterRepair.left} uses`);
check('rotation swaps the active tool', holding === 2, `holding tier ${holding}`);

check('world y-sorts around the player', sorted.ok,
  sorted.ok ? 'player draws in front of trees below and behind trees above' : JSON.stringify(sorted));

check('trees block the hunter',
  // walked toward the trunk, stopped on contact, never ended up inside it,
  // and came to rest at the expected gap (player half-width 2.5 + trunk half
  // 10 = 12.5px). The gap is checked tightly because every other collider is
  // disabled, so this is a deterministic number now.
  collided.ok && !collided.overlaps && collided.moved > 10 &&
    collided.stoppedShortOf >= 8 && collided.stoppedShortOf <= 20,
  `walked ${collided.moved}px, stopped ${collided.stoppedShortOf}px short of x=${collided.trunkX} (expected ~12.5)`);

check('walked to a dig node', !!walked, walked ? `node at ${Math.round(walked.nx)},${Math.round(walked.ny)}` : 'no node within range');
check('a hunt produced a gem', hunted, hunted ? '' : 'reached a node and pressed SPACE, satchel still empty');

await page.screenshot({ path: SHOT });
console.log('\nscreenshot ->', SHOT);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
if (errors.length) errors.slice(0, 6).forEach((e) => console.log('   console:', e.slice(0, 200)));

await browser.close();
console.log(fail === 0 ? '\nSMOKE PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
