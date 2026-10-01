// Measure whether movement is actually frame-rate dependent, and if so why.
//
// The code carries a claim -- "Phaser pins its loop delta, so below ~60fps the
// simulation advances 16.67ms of game time per real frame" -- and two reverted
// substepping attempts were built on it. Both made movement WORSE (6-8% of
// expected). Before writing a third fix, check whether the claim is true.
//
//   node delta-probe.mjs
//   DW_THROTTLE=6 node delta-probe.mjs      # 6x slower CPU = lower fps
//
// Samples position on every animation frame, then compares distance travelled
// against 150 px/s x wall-clock. If they agree, the simulation is already
// frame-rate independent and there is no movement bug to fix.
import puppeteer from 'puppeteer';

const URL = process.env.DW_URL || 'http://127.0.0.1:5173/';
const SPEED = Number(process.env.DW_SPEED || 150);
const HOLD_MS = Number(process.env.DW_HOLD || 2000);
const THROTTLE = Number(process.env.DW_THROTTLE || 1);

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

// NOT networkidle2: the game polls the chain continuously so the network never
// goes idle and the navigation times out.
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#game canvas', { timeout: 30000 }).catch(() => {});

const ready = await page
  .waitForFunction('!!(window.__scene && window.__scene.player)', { timeout: 45000 })
  .then(() => true)
  .catch(() => false);
if (!ready) {
  console.log('game never exposed window.__scene.player');
  await browser.close();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1500));

if (THROTTLE > 1) {
  const cdp = await page.target().createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await new Promise((r) => setTimeout(r, 1500));
}

// Sample on every animation frame. Patching scene.update() does not work --
// Phaser does not dispatch it through a property we can see, so the hook never
// fires. rAF gives the TRUE frame interval, which is what we need here.
await page.evaluate(() => {
  window.__probe = [];
  const tick = () => {
    const p = window.__scene.player;
    window.__probe.push({ t: performance.now(), x: p.x, y: p.y });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// t0 MUST come from the page's own clock. Node's Date.now() and the page's
// performance.now() have different origins, so filtering page timestamps with
// a Node timestamp silently drops every sample and reads as "0% speed".
const t0 = await page.evaluate(() => performance.now());
await page.keyboard.down('d');
await new Promise((r) => setTimeout(r, HOLD_MS));
await page.keyboard.up('d');
const wallMs = (await page.evaluate(() => performance.now())) - t0;
await new Promise((r) => setTimeout(r, 200));

const out = await page.evaluate((t0ms) => {
  const p = window.__probe.filter((s) => s.t >= t0ms - 10 && s.t <= t0ms + 2050);
  const gaps = [];
  for (let i = 1; i < p.length; i++) gaps.push(p[i].t - p[i - 1].t);
  const avg = gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : 0;
  return {
    frames: p.length,
    avgFrame: avg,
    maxFrame: gaps.length ? Math.max(...gaps) : 0,
    fps: avg ? 1000 / avg : 0,
    sampleGaps: gaps.slice(0, 12).map((g) => Math.round(g)),
    dx: p.length > 1 ? p[p.length - 1].x - p[0].x : 0,
    dy: p.length > 1 ? Math.abs(p[p.length - 1].y - p[0].y) : 0,
  };
}, t0);

await browser.close();

const expected = (SPEED * wallMs) / 1000;
const actualSpeed = (out.dx / wallMs) * 1000;
const pct = (actualSpeed / SPEED) * 100;

console.log(`\nthrottle x${THROTTLE}   (1 = real time)`);
console.log(
  `  measured fps       ${out.fps.toFixed(1)}   (avg frame ${out.avgFrame.toFixed(1)}ms, worst ${out.maxFrame.toFixed(0)}ms)`,
);
console.log(`  frame gaps (ms)    ${out.sampleGaps.join('  ')}`);
console.log(`\n  held D             ${wallMs} ms`);
console.log(`  moved              ${out.dx.toFixed(1)} px  (vertical ${out.dy.toFixed(1)})`);
console.log(`  expected           ${expected.toFixed(0)} px`);
console.log(`  actual speed       ${actualSpeed.toFixed(0)} px/s of ${SPEED}  (${pct.toFixed(0)}%)`);
console.log(
  `\n  VERDICT: ${
    Math.abs(pct - 100) < 12
      ? 'MOVEMENT IS ALREADY FRAME-RATE INDEPENDENT -- there is no movement bug'
      : `movement runs at ${pct.toFixed(0)}% of intended speed -- genuinely frame-rate dependent`
  }`,
);
