// Which ambience layer is actually costing the frame time?
//
// ambience-perf.mjs showed 20% of the frame going to 53 objects, which is a
// disproportionate ratio. Suspect: the vignette is a full-viewport transparent
// overlay with six stroked rects, and Phaser re-tessellates Graphics geometry
// every frame -- that is fill rate, not object count.
//
// Measure by removing one layer at a time rather than guessing.
//
//   node ambience-layers.mjs [url]
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

const sample = (label, ms = 3500) => page.evaluate(async ([label, ms]) => {
  const times = []; let last = performance.now(); const t0 = last;
  await new Promise((done) => {
    const step = () => {
      const n = performance.now(); times.push(n - last); last = n;
      if (n - t0 < ms) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { label, fps: +(1000 / mean).toFixed(1), meanMs: +mean.toFixed(1) };
}, [label, ms]);

// Tag each layer so it can be hidden by texture key.
await page.evaluate(() => {
  const s = window.__scene;
  s.__layers = { vignette: [], pollen: [], birds: [], insects: [] };
  s.children.list.forEach((o) => {
    if (o.texture && o.texture.key === 'vignette') s.__layers.vignette.push(o);
    if (o.texture && o.texture.key === 'pollen') s.__layers.pollen.push(o);
    if (o.texture && o.texture.key === 'bird') s.__layers.birds.push(o);
    if (o.texture && o.texture.key === 'insect') s.__layers.insects.push(o);
  });
  if (s.ambience?.vign) s.__layers.vignette.push(s.ambience.vign);
  // the vignette is a Graphics object, not an Image -- find it by depth
  s.children.list.forEach((o) => {
    if (o.depth === 98000 && !o.texture) s.__layers.vignette.push(o);
  });
});
const counts = await page.evaluate(() => {
  const l = window.__scene.__layers;
  return Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v.length]));
});
console.log('  layer counts:', JSON.stringify(counts), '\n');

const rows = [];
rows.push(await sample('everything on'));

const hide = async (keys) => page.evaluate((keys) => {
  const l = window.__scene.__layers;
  for (const k of keys) l[k].forEach((o) => o.setVisible(false));
}, keys);
const showAll = async () => page.evaluate(() => {
  const l = window.__scene.__layers;
  for (const k of Object.keys(l)) l[k].forEach((o) => o.setVisible(true));
});

await hide(['vignette']); await new Promise((r) => setTimeout(r, 500));
rows.push(await sample('vignette OFF'));
await showAll();

await hide(['insects']); await new Promise((r) => setTimeout(r, 500));
rows.push(await sample('insects OFF'));
await showAll();

await hide(['pollen', 'insects']); await new Promise((r) => setTimeout(r, 500));
rows.push(await sample('pollen+insects OFF'));

await hide(['vignette', 'pollen', 'birds', 'insects']); await new Promise((r) => setTimeout(r, 500));
rows.push(await sample('ALL ambience OFF'));
await showAll();

const base = rows[rows.length - 1].meanMs;
console.log('  configuration                 fps   meanMs   vs all-off');
for (const r of rows) {
  const delta = r.meanMs - base;
  console.log(`  ${r.label.padEnd(28)} ${String(r.fps).padStart(5)} ${String(r.meanMs).padStart(7)}   ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}ms`);
}
console.log('\n  NOTE: headless Chrome renders WebGL in software (SwiftShader), so fill');
console.log('  rate is far worse here than on a real GPU. Overdraw-heavy layers like');
console.log('  the vignette are therefore OVERSTATED by this harness, not understated.');

await browser.close();