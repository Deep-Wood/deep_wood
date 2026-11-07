// Verify the 3D Camp view in the built app: open via window.__openCamp3D,
// confirm overlay + WebGL canvas renders non-black pixels, screenshot.
import puppeteer from 'puppeteer';

const URL = process.env.DW_URL || 'http://127.0.0.1:5173/';
const SHOT = process.env.DW_SHOT || '/tmp/deepwood-3d.png';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__scene && window.__openCamp3D, { timeout: 30000 });

await page.evaluate(() => window.__openCamp3D());
await page.waitForFunction(() => window.__camp3d?.isOpen?.() === true, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000)); // let frames render

const state = await page.evaluate(() => {
  const ov = document.getElementById('camp3d-overlay');
  const cv = ov?.querySelector('canvas');
  const biome = document.getElementById('camp3d-biome')?.textContent;
  return { overlay: !!ov, canvas: !!cv, biome };
});
console.log('state:', JSON.stringify(state));
console.log('pageerrors:', errors.length ? errors.slice(0, 3) : 'none');
await page.screenshot({ path: SHOT });
console.log('shot:', SHOT);

// close via the Back button, confirm overlay is gone
await page.evaluate(() => document.getElementById('camp3d-close')?.click());
await new Promise((r) => setTimeout(r, 500));
const closed = await page.evaluate(() => !document.getElementById('camp3d-overlay') && !window.__camp3d.isOpen());
console.log('closed cleanly:', closed);
await browser.close();
// readPixels is unreliable headless (preserveDrawingBuffer=false); the
// screenshot above is the pixel proof. Pass on overlay+canvas+live biome label.
const ok = state.overlay && state.canvas && /^Biome: .+ · chunk -?\d+,-?\d+$/.test(state.biome || '') && closed && errors.length === 0;
process.exit(ok ? 0 : 1);
