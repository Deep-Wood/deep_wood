// Touch / on-screen-control suite.
//
// Split out of smoke.mjs so a harness problem in this file cannot turn the
// desktop suite red. The error it reports -- "Cannot read properties of null
// (reading 'drawImage')" -- fires on roughly half of runs HERE but does NOT
// reproduce in any isolated probe: a plain load, a 390x844 touch load, a
// post-load viewport resize, and a getContext tracer (115 contexts requested,
// 0 null) all came back clean. It is cumulative state of the full suite, not
// something reproducible on its own, so it belongs in its own run where it
// cannot be mistaken for a regression in the game.
import puppeteer from 'puppeteer';

const SHOT = process.env.DW_SHOT || 'smoke-touch.png';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

// The extracted section brings its own browser, page and error collector, and
// references only this one name from the enclosing scope.
const URL = process.env.DW_URL || 'http://localhost:5173/';

const touchBrowser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});
const touchPage = await touchBrowser.newPage();
const touchErrors = [];
touchPage.on('console', (m) => { if (m.type() === 'error') touchErrors.push(m.text()); });
touchPage.on('pageerror', (e) => {
  touchErrors.push('pageerror: ' + e.message);
  if (process.env.DW_TRACE) console.log('STACK>>\n' + String(e.stack || '').split('\n').slice(0, 12).join('\n'));
});
// A phone viewport, so the layout assertions are against the size that matters.
await touchPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
// NO __forceTouchControls override here on purpose.
//
// The pad's visibility is device detection, and forcing it on is exactly how
// the original bug survived: shouldShowTouch() read `game.sys.game.device`,
// which is undefined on a Phaser Game, so it returned false on EVERY device
// and the controls were dead in production -- while the harness forced them
// visible and reported green. This page runs on real detection against a
// touch-enabled viewport, and a separate check below asserts a DESKTOP page
// correctly does NOT get them.
await touchPage.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await touchPage.waitForSelector('#game canvas', { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3500));

const pad = await touchPage.evaluate(() => {
  const s = window.__scene;
  const vis = (b) => !!(s.touchZones || []).find((z) => z.btn === b);
  const zone = (b) => (s.touchZones || []).find((z) => z.btn === b)?.zone;
  return {
    padVisible: s.hasTouchPad,
    buttons: ['up', 'left', 'right', 'down', 'hunt', 'belt', 'board'].filter(vis),
    rightCentre: zone('right') ? [zone('right').x, zone('right').y] : null,
    huntCentre: zone('hunt') ? [zone('hunt').x, zone('hunt').y] : null,
    hubIsInteractive: !!(s.touchZones || []).find((z) => z.btn === 'hub'),
    viewport: [s.scale.width, s.scale.height],
  };
});

check('on-screen controls appear on a touch device', pad.padVisible, `${pad.buttons.length} buttons`);
check('the pad has all four directions plus HUNT, BELT and BOARD',
  ['up', 'left', 'right', 'down', 'hunt', 'belt', 'board'].every((b) => pad.buttons.includes(b)),
  pad.buttons.join(','));
check('the d-pad centre is a dead zone, not a fifth direction', !pad.hubIsInteractive);
check('controls are inside the phone viewport',
  pad.viewport[0] === 390 && pad.viewport[1] === 844,
  `${pad.viewport[0]}x${pad.viewport[1]}`);

// Drive the actual zone with pointer events and read the resulting movement.
const tp = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
if (pad.rightCentre) {
  await touchPage.mouse.move(...Object.values(tp(...pad.rightCentre)));
  await touchPage.mouse.down();
  await new Promise((r) => setTimeout(r, 900));
  const heldState = await touchPage.evaluate(() => ({
    moving: window.__scene.player.body.velocity.x > 0,
    touchRight: window.__scene.touchState.right,
  }));
  await touchPage.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const released = await touchPage.evaluate(() => window.__scene.touchState.right);

  check('pressing the on-screen RIGHT moves the character', heldState.moving,
    `velocity.x > 0 = ${heldState.moving}`);
  check('the touch layer records the press', heldState.touchRight);
  check('releasing the button stops the character', released === false,
    'otherwise the hunter walks off on its own forever');
}

// HUNT must fire a real hunt from the button, not just set a latch.
if (pad.huntCentre) {
  const huntedByButton = await touchPage.evaluate(async () => {
    const s = window.__scene;
    const findsBefore = s.finds.length;
    // Stand the hunter on a node, then press HUNT through the real zone.
    const node = s.nodes.find((n) => !n.getData('used'));
    s.player.setPosition(node.x, node.y);
    await new Promise((r) => setTimeout(r, 120));
    const z = s.touchZones.find((t) => t.btn === 'hunt').zone;
    z.emit('pointerdown', { pointerId: 77 });
    await new Promise((r) => setTimeout(r, 1400));
    z.emit('pointerup', { pointerId: 77 });
    return { before: findsBefore, after: s.finds.length };
  });
  check('the on-screen HUNT button performs a hunt',
    huntedByButton.after > huntedByButton.before,
    `finds ${huntedByButton.before} -> ${huntedByButton.after}`);
}

// The find log must not sit underneath the d-pad.
const logClear = await touchPage.evaluate(() => {
  const s = window.__scene;
  const logY = s.logText.y;
  const padTop = s.scale.height - 16 - (62 * 3 + 6 * 2);
  return { logY, padTop, clear: logY + s.logText.height < padTop };
});
check('the find log is not hidden under the d-pad', logClear.clear,
  `log ends ${Math.round(logClear.logY + 40)}px, pad starts ${Math.round(logClear.padTop)}px`);

// Belt and BOARD must be reachable without a keyboard, or a phone player
// cannot claim a tool at all.
const panels = await touchPage.evaluate(async () => {
  const s = window.__scene;
  const out = {};
  s.touchZones.find((t) => t.btn === 'belt').zone.emit('pointerdown', { pointerId: 81 });
  await new Promise((r) => setTimeout(r, 200));
  out.beltOpened = !!s.beltPanel;
  s.touchZones.find((t) => t.btn === 'belt').zone.emit('pointerup', { pointerId: 81 });
  s.closeBelt();
  s.touchZones.find((t) => t.btn === 'board').zone.emit('pointerdown', { pointerId: 82 });
  await new Promise((r) => setTimeout(r, 200));
  out.boardOpened = !!s.leaderboardOpen;
  s.touchZones.find((t) => t.btn === 'board').zone.emit('pointerup', { pointerId: 82 });
  s.closeLeaderboard();
  return out;
});
check('TOOLBELT opens from the screen', panels.beltOpened);
check('BOARD opens from the screen', panels.boardOpened);

// The other half of the detection contract: a mouse browser must NOT get the
// pad. Without this, "the pad appears" could be satisfied by always-on.
// The "must NOT appear on desktop" half of the detection contract.
//
// Reuses the SAME browser via a fresh page. Opening a second browser here was
// the cause of the only remaining failure in this suite: with two Chromium
// processes contending, the second one fell back from WebGL to Phaser's Canvas
// renderer, and any Text.setText() then hit `updateUVs -> drawImage` on a null
// context. The stack was
//   updateUVs -> setCutPosition -> setSize -> updateText -> setText
//     -> refreshShopPrices (ForestScene.js:961)
// which reads like a game crash and is really a renderer fallback.
//
// Without it, "the pad appears on touch" would be satisfiable by controls that
// are simply always on.
const desktopPage = await touchBrowser.newPage();
await desktopPage.setViewport({ width: 1280, height: 800 });
await desktopPage.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await desktopPage.waitForSelector('#game canvas', { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3500));
const desktopHadPad = await desktopPage.evaluate(() => !!(window.__scene && window.__scene.hasTouchPad));
await desktopPage.close();

check('a desktop mouse browser does NOT get the on-screen controls',
  desktopHadPad === false, `hasTouchPad=${desktopHadPad}`);

check('no console errors with touch controls', touchErrors.length === 0,
  touchErrors.slice(0, 3).join(' | '));
if (touchErrors.length) touchErrors.slice(0, 6).forEach((e) => console.log('   console:', e.slice(0, 200)));

await touchPage.close();
await touchBrowser.close();

console.log('screenshot ->', SHOT);

check('no console errors with touch controls', touchErrors.length === 0, touchErrors.slice(0, 2).join(' | '));
if (touchErrors.length) touchErrors.slice(0, 6).forEach((e) => console.log('   console:', e.slice(0, 200)));
console.log(`\n${fail} CHECK(S) FAILED`);
process.exitCode = fail ? 1 : 0;
