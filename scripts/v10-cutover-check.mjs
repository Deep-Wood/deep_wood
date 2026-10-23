/**
 * V10 cutover verification against PRODUCTION (deepwood-two.vercel.app).
 * Cache-busted (?cb=) + setCacheEnabled(false): a cached index.html serves
 * the previous bundle and reads as "the deploy is broken" when it isn't.
 * Checks the DOM for every V10 surface, then screenshots for pixel truth.
 */
import puppeteer from 'puppeteer';

const URL = `https://deepwood-two.vercel.app/?cb=${Date.now()}`;
const SHOT = '/home/administrator/.hermes/profiles/hunter/cache/scratch/v10-cutover.png';
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
await page.setCacheEnabled(false);

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

console.log('loading', URL);
// NOT networkidle2: the site streams background audio, so idle never
// arrives on production. domcontentloaded + a settle wait is what the
// boot path needs anyway.
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await new Promise((r) => setTimeout(r, 12_000)); // let Phaser + bootChain run

// 1. The bundle must carry the V10.1 address (cache-busted fetch)
const bundleCheck = await page.evaluate(async () => {
  const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.src);
  for (const src of scripts) {
    if (!src.includes('/assets/')) continue;
    try {
      const t = await (await fetch(`${src}?cb=${Date.now()}`, { cache: 'no-store' })).text();
      if (t.includes('0x950c43d73051e7ad875c3a2e108a5828e5dffb4c')) return { found: src, ok: true };
    } catch { /* next */ }
  }
  return { found: null, ok: false };
});
check('served bundle targets V10.1', bundleCheck.ok, bundleCheck.found ?? '');

// 2. Chain status chip must report live (bootChain against V10.1)
const chainText = await page.evaluate(() => document.getElementById('chaintext')?.textContent ?? '');
check('chain chip is live', /live/i.test(chainText), JSON.stringify(chainText));

// 3. V10 DOM surfaces exist
const dom = await page.evaluate(() => ({
  fuseCard: !!document.getElementById('fusion-card'),
  fuseRows: !!document.getElementById('fusion-rows'),
  campDescend: !!document.getElementById('camp-descend'),
  campResearch: !!document.getElementById('camp-research'),
  migrateChip: !!document.getElementById('migrate-chip'),
  chipHidden: document.getElementById('migrate-chip')?.classList.contains('hidden'),
}));
check('fusion card in DOM', dom.fuseCard);
check('camp descend section in DOM', dom.campDescend);
check('camp research section in DOM', dom.campResearch);
check('migrate chip present + hidden without a wallet', dom.migrateChip && dom.chipHidden);

// 4. Wallet menu lists Fuse gems (the dropdown renders on avatar click)
const hasFuseItem = await page.evaluate(async () => {
  document.querySelector('.avatar.brand-logo')?.click();
  await new Promise((r) => setTimeout(r, 1200));
  return !!document.getElementById('wm-fuse');
});
check('wallet menu has Fuse gems', hasFuseItem);

// 5. window.deepwoodChain: booted ok against the new address
const chain = await page.evaluate(() => window.deepwoodChain?.ok ?? null);
check('bootChain ok against V10.1', chain === true, String(chain));

await page.screenshot({ path: SHOT });
console.log('screenshot:', SHOT);
const known = /Access-Control-Allow-Origin' header contains multiple values|Failed to load resource: net::ERR_FAILED/;
const unknown = errors.filter((e) => !known.test(e));
console.log('page errors:', unknown.length ? unknown.slice(0, 5) : 'none (known RPC-CORS rotation noise filtered)');
check('no page errors', unknown.length === 0, unknown.slice(0, 3).join(' | '));

await browser.close();
console.log(fail === 0 ? '\nCUTOVER VERIFICATION PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
