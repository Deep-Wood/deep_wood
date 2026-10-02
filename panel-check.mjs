// Does the toolbelt behave as a bottom sheet on a phone, and stay a side panel
// on a desktop? Plus: does tapping outside dismiss it, and does tapping INSIDE
// it not dismiss it?
//
//   node panel-check.mjs [url]
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const VIEWPORTS = [
  { name: 'phone portrait', w: 390, h: 844, sheet: true },
  { name: 'small phone', w: 320, h: 568, sheet: true },
  { name: 'landscape phone', w: 844, h: 390, sheet: true },
  { name: 'desktop', w: 1280, h: 800, sheet: false },
];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h });
  // Force the touch controls on. Without this the harness never builds a
  // touchLayer, so every assertion about hiding it was silently skipped --
  // which is how the first version of this check passed while the d-pad was
  // sitting on top of the sheet.
  await page.evaluateOnNewDocument(() => { window.__forceTouchControls = true; });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  console.log(`\n${vp.name} (${vp.w}x${vp.h})`);
  await page.evaluate(() => window.__scene.openBelt());
  await new Promise((r) => setTimeout(r, 500));

  // Read the frame the scene computed. The first version of this probe guessed
  // which rectangle was the panel body by size, and happily measured the
  // full-screen backdrop (100% coverage) or the 4px-offset drop shadow -- both
  // of which produced confident, wrong failures.
  const geo = await page.evaluate(() => {
    const s = window.__scene;
    if (!s.beltPanel || !s.beltFrame) return null;
    const f = s.beltFrame;
    return {
      bodyX: f.px, bodyY: f.py, bodyW: f.pw, bodyH: f.ph, sheet: f.sheet,
      vw: s.scale.width, vh: s.scale.height,
      hasBackdrop: !!s.beltBackdrop,
    };
  });

  if (!geo) { check(false, 'panel opened'); await page.close(); continue; }

  check(geo.bodyX >= 0, 'panel is fully on-screen', `x=${geo.bodyX}`);
  check(geo.bodyX + geo.bodyW <= geo.vw, 'panel does not overflow right',
    `${geo.bodyX + geo.bodyW} <= ${geo.vw}`);
  check(geo.bodyY + geo.bodyH <= geo.vh, 'panel does not overflow bottom',
    `${geo.bodyY + geo.bodyH} <= ${geo.vh}`);

  const coverage = ((geo.bodyW * geo.bodyH) / (geo.vw * geo.vh)) * 100;
  if (vp.sheet) {
    check(geo.sheet === true, 'a 390px viewport selects sheet mode');
    check(geo.hasBackdrop, 'sheet mode has a dismiss backdrop');
    check(geo.bodyY + geo.bodyH >= geo.vh - 20, 'sheet is docked to the bottom edge');
    check(coverage < 70, 'sheet leaves the forest visible', `${coverage.toFixed(0)}% of screen`);
  } else {
    check(!geo.hasBackdrop, 'desktop keeps the bare panel (no backdrop)');
    check(Math.abs(geo.bodyX - (geo.vw - 340 - 16)) < 2, 'desktop stays right-docked', `x=${geo.bodyX}`);
  }

  // tap OUTSIDE the panel -> should dismiss (sheet mode only)
  if (vp.sheet) {
    const before = await page.evaluate(() => !!window.__scene.beltPanel);
    await page.mouse.click(Math.round(vp.w / 2), Math.round(vp.h * 0.12));
    await new Promise((r) => setTimeout(r, 400));
    const after = await page.evaluate(() => !!window.__scene.beltPanel);
    check(before && !after, 'tapping outside dismisses the sheet');
  }

  // tap INSIDE the panel -> must NOT dismiss
  await page.evaluate(() => window.__scene.openBelt());
  await new Promise((r) => setTimeout(r, 400));
  // Controls must not sit on top of an open modal panel.
  const ctrl = await page.evaluate(() => {
    const s = window.__scene;
    const layer = s.touchLayer;
    return { touchVisible: s.touchVisible, layerVisible: layer ? layer.visible : null };
  });
  if (ctrl.touchVisible) {
    check(ctrl.layerVisible === false,
      'touch controls are hidden while the panel is open',
      `layerVisible=${ctrl.layerVisible}`);
  }

  const inside = await page.evaluate(() => {
    const f = window.__scene.beltFrame;
    return { x: Math.round(f.px + f.pw / 2), y: Math.round(f.py + 30) };
  });
  await page.mouse.click(inside.x, inside.y);
  await new Promise((r) => setTimeout(r, 400));
  const stillOpen = await page.evaluate(() => !!window.__scene.beltPanel);
  check(stillOpen, 'tapping inside the panel does not dismiss it');

  // ...and they must come back when it closes, or the game becomes unplayable.
  const restored = await page.evaluate(() => {
    window.__scene.closeBelt();
    return window.__scene.touchLayer ? window.__scene.touchLayer.visible : null;
  });
  if (ctrl.touchVisible) {
    check(restored === true, 'touch controls return after the panel closes',
      `layerVisible=${restored}`);
  }

  await page.close();
}

const errs = await (async () => {
  const p = await browser.newPage();
  const seen = [];
  p.on('pageerror', (e) => seen.push(String(e.message).slice(0, 120)));
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));
  await p.close();
  return seen;
})();
check(errs.length === 0, 'no page errors', errs.join(' | '));

console.log(`\n${failures === 0 ? 'PANEL CHECK PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);