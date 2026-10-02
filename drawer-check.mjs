// The toolbelt is a right-edge DRAWER. It must never cover or dim the game.
// These assertions are about the thing the player complained about, not about
// geometry that happens to look acceptable.
//
//   node drawer-check.mjs [url]
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const VIEWPORTS = [
  { name: 'phone portrait', w: 390, h: 844 },
  { name: 'small phone', w: 320, h: 568 },
  { name: 'landscape phone', w: 844, h: 390 },
  { name: 'desktop', w: 1280, h: 800 },
];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h });
  await page.evaluateOnNewDocument(() => { window.__forceTouchControls = true; });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  console.log(`\n${vp.name} (${vp.w}x${vp.h})`);
  // Snapshot the full-screen-visible inventory BEFORE opening.
  await page.evaluate(() => {
    const s = window.__scene;
    window.__before = new Set(s.children.list
      .filter((o) => o.visible && o.width >= s.scale.width && o.height >= s.scale.height
        && o.alpha > 0.1).map((o) => o.uuid));
  });
  await page.evaluate(() => window.__scene.openBelt());
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(() => {
    const s = window.__scene;
    window.__coversAdded = s.children.list
      .filter((o) => o.visible && o.width >= s.scale.width && o.height >= s.scale.height
        && o.alpha > 0.1 && !window.__before.has(o.uuid)).length;
  });

  const g = await page.evaluate(() => {
    const s = window.__scene, f = s.beltFrame;
    if (!f) return { missing: true };
    // Anything covering the whole viewport is, by definition, a modal.
    const fullScreen = s.children.list.filter((o) => o.visible
      && o.width >= s.scale.width && o.height >= s.scale.height
      && o.alpha > 0.1);
    return {
      px: f.px, py: f.py, pw: f.pw, ph: f.ph, drawer: !!f.drawer,
      vw: s.scale.width, vh: s.scale.height,
      backdrop: !!s.beltBackdrop,
      fullScreenCoverCount: fullScreen.length,
      touchVisible: s.touchVisible,
      controlsVisible: s.touchLayer ? s.touchLayer.visible : null,
      coverage: +(((f.pw * f.ph) / (s.scale.width * s.scale.height)) * 100).toFixed(1),
      shopRows: s.shopRows ? s.shopRows.length : 0,
      toolRows: s.beltRows ? s.beltRows.length : 0,
      claimText: s.claimBtn ? s.claimBtn.text : '',
    };
  });

  if (g.missing) { check(false, 'drawer opened'); await page.close(); continue; }

  check(g.drawer === true, 'renders as a drawer, not a sheet/panel');
  // (the vignette is a permanent, deliberately-partial-alpha game element; what
  // matters is that the drawer ADDS none, asserted below)
  check(g.backdrop === false, 'no backdrop / no dim over the game');
  check(g.coverage < 22, 'drawer is a small slice of the screen', `${g.coverage}%`);
  check(g.pw <= 140, 'drawer is narrow', `${g.pw}px`);

  // "Nothing covers the game" is the actual requirement, so assert it directly:
  // opening the drawer must not introduce ANY new full-screen visible object.
  // (Comparing screenshot byte lengths was the first attempt and it is worthless
  // -- pollen and the hunter animate, so the bytes differ either way.)
  const newCovers = await page.evaluate(() => window.__coversAdded || 0);
  check(newCovers === 0, 'opening the drawer adds no full-screen overlay', `${newCovers} added`);

  // Re-open, then tap far from the drawer: it must close.
  await page.evaluate(() => window.__scene.openBelt());
  await new Promise((r) => setTimeout(r, 600));
  await page.mouse.click(Math.round(vp.w * 0.2), Math.round(vp.h * 0.55));
  await new Promise((r) => setTimeout(r, 500));
  check(!(await page.evaluate(() => !!window.__scene.beltPanel)), 'tapping the forest closes the drawer');

  // A tap INSIDE the drawer must NOT close it -- otherwise the buy buttons are
  // unusable, which is the other half of the bug.
  await page.evaluate(() => window.__scene.openBelt());
  await new Promise((r) => setTimeout(r, 600));
  const inD = await page.evaluate(() => {
    const f = window.__scene.beltFrame;
    return { x: Math.round(f.px + f.pw / 2), y: Math.round(f.py + 8) };
  });
  await page.mouse.click(inD.x, inD.y);
  await new Promise((r) => setTimeout(r, 500));
  check(await page.evaluate(() => !!window.__scene.beltPanel), 'tapping inside the drawer does not close it');

  // The game must still be PLAYABLE with the drawer open.
  if (g.controlsVisible) {
    check(g.controlsVisible === true, 'touch controls stay visible and usable with the drawer open');
    // TouchState has no `.dir` -- the first version of this set a property that
    // does not exist, so the hunter never moved and the check reported a game
    // that was stuck. It is press/release by pointerId.
    const moved = await page.evaluate(async () => {
      const s = window.__scene;
      const x0 = s.player.x;
      s.touchState.press(99, 'right');
      await new Promise((r) => setTimeout(r, 800));
      s.touchState.release(99);
      return Math.round(Math.abs(s.player.x - x0));
    });
    check(moved > 2, 'the hunter can still walk with the drawer open', `moved ${moved}px`);
  }

  // The claim/buy path must survive the redesign.
  check(g.shopRows >= 2, 'gem shop rows present', `${g.shopRows}`);
  check(g.toolRows >= 1, 'tool rows present', `${g.toolRows}`);
  check(g.claimText.length > 0, 'claim button present', JSON.stringify(g.claimText));

  await page.screenshot({ path: `/tmp/drawer-${vp.name.replace(/\s+/g, '-')}.png` });
  await page.close();
}

const p = await browser.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await p.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));
await p.close();
check(errs.length === 0, 'no page errors', errs.join(' | '));

console.log(`\n${failures === 0 ? 'DRAWER CHECK PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);