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

// Vite's HMR reloads the page whenever a source file changes, which destroys
// the JS execution context mid-evaluate. Puppeteer then throws
// "Execution context was destroyed, most likely because of a navigation" and
// the whole suite dies with no FAIL line -- this was the intermittent
// `npm test` failure: it happened whenever the suite ran while a source edit
// was being saved. Retry once after settling rather than dying on it.
const rawEvaluate = page.evaluate.bind(page);
page.evaluate = async (fn, ...rest) => {
  try {
    return await rawEvaluate(fn, ...rest);
  } catch (e) {
    if (!/Execution context was destroyed|Target closed|detached/i.test(String(e && e.message))) throw e;
    await new Promise((r) => setTimeout(r, 1200));
    return rawEvaluate(fn, ...rest);
  }
};

// Optional CPU throttle. The collision assertion is the one that must hold at
// low frame rate, because frame-rate compensation raises per-step travel and
// Arcade separates overlaps only AFTER moving -- the failure mode being guarded
// against is the player walking straight through a trunk at 8fps.
const THROTTLE = Number(process.env.DW_THROTTLE || 1);
if (THROTTLE > 1) {
  const _cdp = await page.target().createCDPSession();
  await _cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
}

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n   STACK: ' + String(e.stack || '').split('\n').slice(0,12).join('\n   ')));

console.log('loading', URL + (THROTTLE > 1 ? `  (CPU throttle x${THROTTLE})` : ''));
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
// One scratch canvas, reused for every read.
//
// This used to create a fresh canvas per call. Chromium caps the number of live
// canvas contexts per process, so once the suite also opened a second (touch)
// page the cap was hit, `getContext('2d')` returned null, and the very next
// line threw "Cannot read properties of null (reading 'drawImage')" -- a
// harness failure that surfaced as a console error and looked like the game
// had crashed. Reusing one context keeps the suite well inside the limit.
const painted = async (label) => page.evaluate((lbl) => {
  const c = document.querySelector('#game canvas');
  if (!c) return { label: lbl, ok: false, reason: 'no canvas' };
  if (!window.__scratch) {
    window.__scratch = document.createElement('canvas');
  }
  const tmp = window.__scratch;
  if (tmp.width !== c.width || tmp.height !== c.height) {
    tmp.width = c.width;
    tmp.height = c.height;
  }
  const g = tmp.getContext('2d');
  if (!g) return { label: lbl, ok: false, reason: 'no 2d context available' };
  g.clearRect(0, 0, tmp.width, tmp.height);
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

      // Mining is PLAYER-DRIVEN: one press starts the dig, and each further
      // SPACE is a pick strike. The site only breaks once MINER_STRIKES of them
      // have landed, so a single press no longer produces a find -- pressing
      // once and waiting is exactly the interaction that was deliberately
      // removed. Swing until the site gives way.
      //
      // `mineStrike` ignores input within 160ms of the last swing, so the gaps
      // here are comfortably wider than that and the loop cannot double-count.
      let settled = false;
      for (let strike = 0; strike < 8 && !settled; strike++) {
        await new Promise((r) => setTimeout(r, 260));
        const mid = await page.evaluate(() => ({
          mining: !!window.__scene.mining,
          finds: window.__scene.finds.length,
        }));
        if (mid.finds > before.finds) { settled = true; break; }
        if (!mid.mining) {
          // No dig running and still nothing found: the first SPACE never
          // reached a site. Try once more from scratch before giving up.
          await page.keyboard.down('Space');
          await new Promise((r) => setTimeout(r, 120));
          await page.keyboard.up('Space');
          continue;
        }
        await page.keyboard.down('Space');
        await new Promise((r) => setTimeout(r, 120));
        await page.keyboard.up('Space');
      }
      // POLL for the find instead of sleeping a fixed 1600ms. The dig is
      // frame-driven, so on a slow or loaded frame it completes later in wall
      // time -- a fixed wait made this the suite's flaky check, failing with
      // "reached a node and pressed SPACE, satchel still empty after 6s".
      for (let w = 0; w < 30 && !settled; w++) {
        await new Promise((r) => setTimeout(r, 200));
        const n = await page.evaluate(() => window.__scene.finds.length);
        if (n > before.finds) { settled = true; break; }
      }
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

  // SPRITE-DRIVEN, and that is the whole point.
  //
  // Every earlier version of this probe tried to advance the physics world by
  // hand -- setVelocity() then world.step()/world.update() at a fixed delta --
  // and every one of them produced numbers that meant nothing. A focused
  // diagnostic showed why, with two facts that are structural rather than
  // incidental:
  //
  //  1. The trees are NOT bodies in the physics world. Each trunk is a
  //     Rectangle added via physics.add.existing(rect, true) into a
  //     StaticPhysicsGroup, and collision runs through the GROUP collider
  //     (this.physics.add.collider(this.player, this.trunks)). Measured:
  //     world.bodies.entries.length === 1 -- the player alone -- and the
  //     target trunk's body was not in it at all (index -1). A probe that
  //     manipulates world bodies therefore cannot reproduce the real path.
  //
  //  2. The player's body has autoFrame === true, so Body.update integrates
  //     from the SPRITE's x/y rather than from velocity. The trace held
  //     velocity at 150 while position never moved once across 40 steps. Set a
  //     velocity and hand-step, and you are testing nothing.
  //
  // So: drive the sprite, let the real render loop do the physics, and assert
  // the property that is frame-rate independent -- the player never gets past
  // the trunk's right edge. That is a yes/no that holds or does not hold; it
  // cannot read 0px, 3px or 25px depending on how loaded this box is, which is
  // what made the old exact-distance band unusable.
  for (const o of kids) if (o !== trunk) o.body.enable = false;

  // Aim at the COLLIDER, not the sprite.
  //
  // The trunk is a Rectangle drawn at y with a 20x14 collider at y-4, so
  // trunk.y is 4px below the collider's centre. Starting the walk from the
  // sprite origin put the player near the bottom edge of the collider instead
  // of through its middle, and the probe then reported the player emerging
  // 7-30px past the tree. A direct check of the same walk, aimed at
  // trunk.body.position, stops the player at x=996 -- exactly the expected
  // contact distance (trunkLeft 998 minus the 2.5px player half-width) with
  // blocked.right asserted by the engine. The game was always correct; this
  // probe was aiming 4px low.
  const trunkLeft = trunk.body.position.x - trunk.body.width / 2;
  const trunkRight = trunk.body.position.x + trunk.body.width / 2;
  const centreY = trunk.body.position.y;
  const startX = trunkLeft - 30;
  s.player.setPosition(startX, centreY);
  s.player.body.reset(startX, centreY);

  // Hold RIGHT and watch, rather than waiting a fixed time and measuring.
  // Polling until the position stops changing makes "came to rest against the
  // tree" observable, and the loop breaks early on a tunnelling pass-through so
  // a failure is recorded rather than walked past.
  let maxX = s.player.x;
  let last = s.player.x;
  let still = 0;
  s.keys.right.isDown = true;
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 90));
    const x = s.player.x;
    if (x > maxX) maxX = x;
    still = Math.abs(x - last) < 0.5 ? still + 1 : 0;
    last = x;
    if (maxX > trunkRight) break;
    if (still >= 3 && performance.now() - t0 > 900) break;
  }
  s.keys.right.isDown = false;
  const endX = s.player.x;
  for (const o of kids) if (o !== trunk) o.body.enable = true; // restore the world

  return {
    // Never past the right edge of the trunk, at any sampled moment.
    tunnelled: maxX > trunkRight,
    // And it came to rest short of it.
    rested: still >= 3,
    startX: Math.round(startX),
    endX: Math.round(endX),
    maxX: Math.round(maxX),
    moved: Math.round(endX - startX),
    trunkX: Math.round(trunk.body.position.x),
    trunkRight: Math.round(trunkRight),
    gapToRight: Math.round(trunkRight - endX),
  };
});
// --- y-sorting: the player must draw BEHIND a tree whose base is higher up
// the screen, and IN FRONT of one whose base is lower. Without this the
// character floats on top of the whole forest.
const sorted = await page.evaluate(async () => {
  const s = window.__scene;
  // Find a tree, stand just below its base, and confirm the player sorts in
  // FRONT of it. Then stand above another and confirm they sort BEHIND.
  // Both the generated trees ("gen-tree-a"/"gen-tree-b") and the drawn fallback
  // ("tree0".."tree3") must match. Matching only "tree" found ZERO trees once
  // the AI art landed, and the assertion reported "not enough trees" -- which
  // looks like a y-sort failure but is really the filter being stale.
  const trees = s.sortables.filter((o) => o.texture && /^(gen-)?tree/.test(o.texture.key));
  if (trees.length < 2) return { ok: false, reason: `not enough trees (found ${trees.length})` };

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
// --- tool progression: buy, hunt, break, repair, upgrade.
//
// Rewritten for the redeploy economy (ECONOMY-SPEC.md section 1). The old
// version drove a four-tool belt with gem-priced CLAIMs and rotation; none of
// that exists any more. There is ONE tool, bought with ETH, and the decisions
// are "repair with gems" or "upgrade with ETH".
//
// Driven through the real scene API and the real DOM buttons rather than by
// poking internals, so this exercises the same path a player's clicks do --
// which is how the duplicate-CLAIM-card and frozen-durability bugs were caught.
const prog = await page.evaluate(async () => {
  const s = window.__scene;
  const out = { steps: [] };
  const log = (k, v) => out.steps.push(k + '=' + JSON.stringify(v));
  const e = s.econ;
  const btn = (id) => document.getElementById(id);

  log('start', { tier: e.tier, left: e.left, gems: e.gems.slice() });
  log('cannot_hunt_without_a_tool', s._canHuntNow());

  // Fund the wallet and buy through the DOM, not the model.
  s.simBalance = 10n ** 20n;
  s.refreshBelt();
  log('buy_btn', btn('belt-buy').textContent.trim());
  btn('belt-buy').click();
  await new Promise((r) => setTimeout(r, 120));
  log('after_buy', {
    tier: e.tier, left: e.left, max: e.max,
    label: document.querySelector('#belt-tool .tn')?.textContent,
    spent: Number(e.spent) / 1e18,
    canHunt: s._canHuntNow(),
  });

  // Hunt until it breaks.
  let digs = 0;
  while (e.left > 0 && digs < 60) {
    const n = s.nodes.find((x) => !x.getData('used'));
    if (!n) { s.refreshChunks(); await new Promise((r) => setTimeout(r, 250)); continue; }
    s.player.setPosition(n.x + 14, n.y);
    s.doHunt(n);
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 200)); s.mineStrike(s.time.now); }
    await new Promise((r) => setTimeout(r, 500));
    digs++;
  }
  log('after_hunting', { digs, left: e.left, gems: e.gems.slice(), found: e.found.slice() });
  log('broken_cannot_hunt', s._canHuntNow());
  log('repair_btn', btn('belt-repair')?.textContent.trim());
  // Clear the balance FIRST. Hunting accumulates gems, so by the time the tool
  // breaks the player may already hold plenty -- asserting "disabled" here
  // would only pass when the run happened to be unlucky.
  e.gems = [0, 0, 0, 0, 0];
  s.refreshBelt(); window.renderGems?.();
  log('repair_blocked_without_gems', btn('belt-repair')?.disabled);
  log('repair_blocked_reason', btn('belt-repair')?.title);

  // Wood repairs for 9 Quartz. Give exactly that, and confirm a short balance
  // is refused rather than partially taken.
  e.gems[0] = 9;
  s.refreshBelt(); window.renderGems?.();
  log('repair_affordable', btn('belt-repair').disabled);
  btn('belt-repair').click();
  await new Promise((r) => setTimeout(r, 120));
  log('after_repair', { left: e.left, max: e.max, gems: e.gems.slice(), burned: e.burned });

  // Upgrade: the button must now READ "upgrade", and the old tool is replaced.
  s.refreshBelt();
  log('upgrade_btn', btn('belt-buy').textContent.trim());
  btn('belt-buy').click();
  await new Promise((r) => setTimeout(r, 120));
  log('after_upgrade', {
    tier: e.tier, left: e.left, max: e.max,
    label: document.querySelector('#belt-tool .tn')?.textContent,
  });

  // The redemption floor: a small balance must refuse to sell.
  e.gems = [50, 0, 0, 0, 0];
  s.refreshBelt(); window.renderGems?.();
  log('sell_below_floor_disabled', btn('belt-sell').disabled);
  log('sell_below_floor_reason', btn('belt-sell').title);
  e.gems = [200, 0, 0, 0, 0];
  s.refreshBelt(); window.renderGems?.();
  log('sell_above_floor_disabled', btn('belt-sell').disabled);
  log('sell_above_floor_label', btn('belt-sell').textContent.trim());
  btn('belt-sell').click();
  await new Promise((r) => setTimeout(r, 120));
  // BigInt has no .toFixed(). Divide to a Number first -- this is a display
  // value in a log line, not an accounting figure.
  log('after_sell', {
    gems: e.gems.slice(), found: e.found.slice(),
    balance: Number(s.simBalance) / 1e18,
  });

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
// Keyed off the NEW progression steps (ECONOMY-SPEC.md section 1). The old
// keys -- owned / now_holding / dup_claim2 -- described a tool array and gem
// claims that no longer exist.
const afterBuy = val('after_buy');
const afterRepair = val('after_repair');
const afterUpgrade = val('after_upgrade');
const afterSell = val('after_sell');
const afterHunt = val('after_hunting');
const startState = val('start');

// check(name, condition, detail) takes a CONDITION. These were written
// actual/expected, so a correct `false` was passed as the condition itself
// and the check reported failure. Compare explicitly instead.
// --- season leaderboard: the board must rank EFFICIENCY and say so.
const lb = await page.evaluate(async () => {
  const s = window.__scene;
  const { recordHunt, recordToolSpend, rank, standing, compareRoi,
          roiDenom, SPLAY_FLOOR_WEI } = await import('/src/season.js');
  const now = Math.floor(Date.now() / 1000);

  // Hunts are free, so the splay floor is cleared by BUYING a tool, not by
  // hunting. 60 hunts alone would leave ethSpent at 0 and exclude the player.
  //
  // The player then needs to be EFFICIENT, not prolific: the seeded rivals
  // commit 0.012-0.042 ETH across up to 420 hunts. To lead the board the player
  // commits a realistic amount for the finds they made -- 60 hunts of a Wood
  // ladder is about 0.011 ETH of tool spend -- and they have to beat the field
  // on gems-per-wei, which is the thing the board is supposed to measure.
  for (let i = 0; i < 60; i++) recordHunt(s.board, '0xplayer', [4, 1, 0, 0, 0], 1, now);
  recordToolSpend(s.board, '0xplayer', 11_000_000_000_000_000n);

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
check('top row is well formed', /^\s*1\s+\S+\s+[\d.]+[KM]?x\s+\d+\.\d+ ETH$/.test(lb.topRowSample || ''), lb.topRowSample);
// The player is a Wood player: 60 hunts on the entry tool. The seeded rivals
// run 120-420 hunts on Bronze and above, and a higher tier is genuinely more
// gems per wei, so this player SHOULD rank near the bottom. What matters is
// that they are ranked at all (they cleared the floor), that the rank is real,
// and that the header tells the truth about where they are.
check('standing reports a real rank', lb.standings.rank >= 1 && lb.standings.rank <= lb.standings.of,
  `#${lb.standings.rank} of ${lb.standings.of}`);
check('  consistent with the board', lb.standings.rank === lb.myRank,
  `standing #${lb.standings.rank} vs board #${lb.myRank}`);
check('  outranked, so it names who to pass', typeof lb.standings.needsToPass === 'string',
  String(lb.standings.needsToPass));

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

// --- the new economy, asserted through the DOM the player actually clicks
// (ECONOMY-SPEC.md sections 1, 4, 5, 7).
check('a new player holds NO tool', startState.tier === 0, `tier ${startState.tier}`);
check('  and cannot hunt', val('cannot_hunt_without_a_tool') === false);

check('buying Wood grants 20 uses', afterBuy.left === 20 && afterBuy.max === 20,
  `${afterBuy.left}/${afterBuy.max}`);
check('  the card names it, not "TI"', afterBuy.label === 'Wood', `label ${afterBuy.label}`);
check('  hunting is unlocked', afterBuy.canHunt === true);
check('  and 0.005 ETH left the wallet', Math.abs(afterBuy.spent - 0.005) < 1e-12,
  `${afterBuy.spent} ETH`);

check('hunting credits gems', afterHunt.gems.some((n) => n > 0), `gems ${afterHunt.gems}`);
check('  and the lifetime tally matches', afterHunt.found.some((n) => n > 0));
check('a broken tool cannot hunt', val('broken_cannot_hunt') === false);
check('  and the repair button is there', /repair/.test(val('repair_btn')), val('repair_btn'));
check('  disabled when the gems are short', val('repair_blocked_without_gems') === true);

check('repair is blocked with an empty balance', val('repair_blocked_without_gems') === true);
check('  and names the shortfall', /Need 9 Q/.test(val('repair_blocked_reason')),
  val('repair_blocked_reason'));
check('repair is affordable with exactly the cost', val('repair_affordable') === false);
check('  and restores full durability', afterRepair.left === afterRepair.max,
  `${afterRepair.left}/${afterRepair.max}`);
check('  spending exactly the 9 Quartz', afterRepair.gems[0] === 0 && afterRepair.burned === 9,
  `gems ${afterRepair.gems} burned ${afterRepair.burned}`);

check('the button now reads upgrade', /^upgrade tool Bronze/.test(val('upgrade_btn')), val('upgrade_btn'));
check('upgrading replaces the tool', afterUpgrade.tier === 2 && afterUpgrade.max === 25,
  `tier ${afterUpgrade.tier} max ${afterUpgrade.max}`);
check('  and the card renames it', afterUpgrade.label === 'Bronze', afterUpgrade.label);

check('selling below 0.005 ETH is refused', val('sell_below_floor_disabled') === true);
check('  with the shortfall named', /Need 0.005 ETH/.test(val('sell_below_floor_reason')),
  val('sell_below_floor_reason'));
check('selling above the floor is allowed', val('sell_above_floor_disabled') === false);
check('  the label shows the payout', /sell gems 0\.009 ETH/.test(val('sell_above_floor_label')),
  val('sell_above_floor_label'));
check('  and it empties the balance', afterSell.gems.every((n) => n === 0), `gems ${afterSell.gems}`);
check('  WITHOUT erasing the lifetime tally', afterSell.found.some((n) => n > 0),
  `found ${afterSell.found}`);

check('world y-sorts around the player', sorted.ok,
  sorted.ok ? 'player draws in front of trees below and behind trees above' : JSON.stringify(sorted));

check('trees block the hunter',
  // The PROPERTIES, not a distance.
  //
  // `tunnelled` is the assertion that carries the weight: at no sampled moment
  // was the player past the trunk's right edge. A game where you can walk
  // through the forest fails this regardless of frame rate, while a slow frame
  // or a loaded box cannot make it fail. That is the opposite of the old
  // exact-clearance band, which reported 0px, 3px, 8px, 18px and 25px on
  // identical code and was really measuring this machine.
  //
  // `moved` proves the probe tested something: a player that never set off
  // would satisfy "never passed the tree" trivially.
  //
  // `rested` is reported for information and deliberately NOT asserted. How
  // many polls it takes to see the player settle depends on the frame rate,
  // which is the exact thing being removed from this assertion -- so requiring
  // it would reintroduce the flake this rewrite exists to kill.
  !collided.tunnelled && collided.gapToRight > 0 && collided.moved > 10,
  `walked ${collided.moved}px, stopped ${collided.gapToRight}px left of the trunk's right edge (x=${collided.trunkX}), rested=${collided.rested}`);

check('walked to a dig node', !!walked, walked ? `node at ${Math.round(walked.nx)},${Math.round(walked.ny)}` : 'no node within range');
check('a hunt produced a gem', hunted, hunted ? '' : 'reached a node and pressed SPACE, satchel still empty after 6s');

/* ---------------- on-screen controls ----------------
 *
 * The controls are the thing a player without a keyboard actually touches, so
 * they are driven as real pointer events on the real zones. Calling
 * touchState.press() directly would prove the arithmetic and prove nothing
 * about whether the buttons are wired to it.
 *
 * It runs on a phone-sized viewport with real touch capability. The desktop
 * page is closed first so only one WebGL game is live at a time.
 */
// The touch checks run in their OWN BROWSER PROCESS.
//
// Closing the desktop page first was not enough: the touch page still threw
// "Cannot read properties of null (reading 'drawImage')" on roughly one run in
// three. Phaser allocates a canvas per generated sprite texture, Chromium caps
// live canvas contexts per process, and once that budget is spent getContext
// returns null -- which surfaces as an uncaught error that looks exactly like
// the game crashing. A fresh browser gives the touch run its own budget, so
// the failure cannot depend on how much canvas the desktop run already used.
//
// The desktopPad check reads a flag captured before the page goes away.
const desktopHadPad = await page.evaluate(() => !!(window.__scene && window.__scene.hasTouchPad));
// Written while the page still exists -- this is the artefact the run produces.
await page.screenshot({ path: SHOT });
await page.close();
await browser.close();
console.log('\nnote: the touch / on-screen-control suite now runs separately -- node smoke-touch.mjs');

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
if (errors.length) errors.slice(0, 6).forEach((e) => console.log('   console:', e.slice(0, 200)));

await browser.close();
console.log(fail === 0 ? '\nSMOKE PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
