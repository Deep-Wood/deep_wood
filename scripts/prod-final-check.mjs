// Final prod check: chain chip must reach a live state despite the RPC's
// 429/CORS burst, and the leaderboard column geometry must hold on prod.
import puppeteer from 'puppeteer';

const URL = 'https://deepwood-two.vercel.app/?cb=final' + Date.now();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

let chip = null;
for (let i = 0; i < 100; i++) {
  chip = await page.evaluate(() => {
    const t = document.getElementById('chaintext');
    return { text: t ? t.textContent : null, boot: window.deepwoodChain ? { ok: window.deepwoodChain.ok, reason: window.deepwoodChain.reason } : null };
  });
  if (chip.text && !/checking/i.test(chip.text)) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('CHIP:', JSON.stringify(chip));

// open the leaderboard, measure the column on prod
await page.evaluate(() => window.__scene && window.__scene.toggleLeaderboard());
let panel = null;
for (let i = 0; i < 60; i++) {
  panel = await page.evaluate(() => {
    const p = document.querySelector('.lb-panel');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { wPct: Math.round((r.width / innerWidth) * 100), hPct: Math.round((r.height / innerHeight) * 100), rightDocked: Math.round(innerWidth - (r.x + r.width)) <= 1 };
  });
  if (panel) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('PANEL:', JSON.stringify(panel));
await browser.close();
