// Reproduce the hunt-queue path with a MOCKED wallet state (no wallet ext in
// headless). We force state.connected + account via the wallet module's own
// state, then call reveal() directly on a fake node and watch the queue.
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/' || p.endsWith('/')) p += 'index.html';
  try {
    const body = readFileSync(new URL('.' + p, ROOT));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const BASE = 'http://localhost:' + server.address().port + '/';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE:', m.text().slice(0, 120)));
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.__scene', { timeout: 30000 }).catch(() => {});
await page.waitForFunction('window.deepwoodChain && window.deepwoodChain.ok', { timeout: 60000 }).catch(() => console.log('boot timeout'));

// Force the wallet module into "connected" state. wallet.js keeps a private
// `state` object -- poke the exported setters if they exist, else reach through
// onchainActive by patching getState via the module registry. Simplest honest
// route: many pages expose __wallet; if not, we mock window.ethereum BEFORE
// load instead. Instead of all that, directly drive reveal() with onchain
// monkeypatched true via import() of the live modules on the page:
const probe = await page.evaluate(async () => {
  const out = { haveScene: !!window.__scene };
  // Expose the ES module handles the page already imported (module registry
  // is internal; but ForestScene stashes useful refs on itself).
  const s = window.__scene;
  if (!s) return out;
  out.queueNow = s.queue ? s.queue.size : null;
  out.huntIndex = s.huntIndex ?? null;
  out.wallet = s.wallet ?? null;
  return out;
});
console.log('PROBE:', JSON.stringify(probe));

// The cleanest reproduction of the user's complaint does not need a wallet at
// all if the complaint is PREVIEW mode: preview digs DO queue locally and
// badge. Trigger the dig flow the way the game does: walk is unnecessary --
// call reveal() on a synthetic node.
const dig = await page.evaluate(async () => {
  const s = window.__scene;
  if (!s) return { error: 'no scene' };
  const node = { x: 100, y: 100, setData: () => {}, active: true, getData: () => false };
  const before = s.queue ? s.queue.size : null;
  try {
    const ok = await s.reveal(node);
    return { ok, before, after: s.queue ? s.queue.size : null, pending: null };
  } catch (e) {
    return { error: e.message.slice(0, 200), before, after: s.queue ? s.queue.size : null };
  }
});
console.log('DIG:', JSON.stringify(dig));
const badge = await page.evaluate(() => {
  const b = document.getElementById('queue-badge');
  return { text: b ? b.textContent : null, hidden: b ? b.classList.contains('hidden') : null };
});
console.log('BADGE:', JSON.stringify(badge));
await page.screenshot({ path: '/tmp/hunt-after.png' });
await browser.close();
server.close();
