// What did the ambience layers actually cost?
//
// The design note promised an object-budget check, so measure it rather than
// assert it: frame time with the full stack, with the camera-global layers
// destroyed, and with insects off. Insects are the layer most likely to be cut,
// so their marginal cost is the number that decides whether they stay.
//
//   node ambience-perf.mjs [url]
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });  // phone, the real target
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

// Sample real frame intervals with the page's own clock. Same method as
// delta-probe.mjs, so the numbers are comparable with what we measured before.
const sample = (label, ms = 4000) => page.evaluate(async ([label, ms]) => {
  const s = window.__scene;
  const times = [];
  let last = performance.now();
  const t0 = last;
  await new Promise((done) => {
    const step = () => {
      const n = performance.now();
      times.push(n - last);
      last = n;
      if (n - t0 < ms) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
  const sorted = times.slice().sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    label,
    fps: +(1000 / mean).toFixed(1),
    meanMs: +mean.toFixed(1),
    p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
    frames: times.length,
    sortables: s.sortables.length,
    objects: s.children ? s.children.list.length : 0,
    ambience: s.ambience ? s.ambience.counts : null,
  };
}, [label, ms]);

const rows = [];
rows.push(await sample('FULL (pollen+birds+insects+vignette)'));
console.log(JSON.stringify(rows[0]));

// Tear the camera-global layers down and re-measure the identical scene.
await page.evaluate(() => { window.__scene.ambience?.destroy(); window.__scene.ambience = null; });
await new Promise((r) => setTimeout(r, 800));
rows.push(await sample('NO ambience (chunk decoration only)'));

console.log('\n  layer                          fps   meanMs  p95Ms  sortables');
for (const r of rows) {
  console.log(`  ${r.label.padEnd(30)} ${String(r.fps).padStart(5)} ${String(r.meanMs).padStart(7)} ${String(r.p95Ms).padStart(6)} ${String(r.sortables).padStart(9)}`);
}
const a = rows[0], b = rows[1];
console.log(`\n  ambience cost: ${(a.meanMs - b.meanMs).toFixed(1)}ms/frame  (${(((a.meanMs - b.meanMs) / b.meanMs) * 100).toFixed(1)}% over no-ambience)`);
console.log(`  ambience object counts: ${JSON.stringify(a.ambience)}`);

const errors = await page.evaluate(() => window.__deepwoodErrors ? window.__deepwoodErrors.length : -1);
console.log(`\n  errors captured during the run: ${errors}`);

await browser.close();