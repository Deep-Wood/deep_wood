// Reproduce "new hunts not getting added in the UI": connect the page to a
// funded wallet via the onchain path, dig, and watch the queue badge + belt.
import puppeteer from 'puppeteer';

const URL = 'https://deepwood-two.vercel.app/?cb=hunt' + Date.now();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE:', m.text().slice(0, 150)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

// wait for scene + chain boot
await page.waitForFunction('window.__scene && window.deepwoodChain && window.deepwoodChain.ok', { timeout: 60000 }).catch(() => console.log('boot wait timeout'));
const boot = await page.evaluate(() => ({ ok: window.deepwoodChain?.ok, onchain: !!(window.__scene && window.__scene.wallet), wallet: window.__scene?.wallet ?? null }));
console.log('BOOT:', JSON.stringify(boot));

// If no wallet connected, hunts stay in PREVIEW mode. Try the preview dig path:
// click DIG a few times via the scene API and watch the queue.
const dig = await page.evaluate(async () => {
  const s = window.__scene;
  const out = { queueBefore: s?.queue?.size ?? null, hunted: false, error: null };
  return out;
});
console.log('PRE-DIG:', JSON.stringify(dig));
await page.screenshot({ path: '/tmp/hunt-before.png' });
await browser.close();
