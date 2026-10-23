/**
 * Dig animation visual smoke: use scene methods to dismiss modals, buy tool, dig.
 */
import puppeteer from 'puppeteer';

const URL = `https://deepwood-two.vercel.app/?cb=${Date.now()}`;
const SHOT = '/home/administrator/.hermes/profiles/hunter/cache/scratch/dig-animation.png';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setCacheEnabled(false);

page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

console.log('loading', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await new Promise((r) => setTimeout(r, 12_000));

// Wait for chain chip to show live
await page.waitForFunction(() => {
  const el = document.getElementById('chaintext');
  return el && /live/i.test(el.textContent);
}, { timeout: 30_000 });

// Dismiss modals + buy tool + dig via scene methods
const result = await page.evaluate(() => {
  if (!window.__scene) return { ok: false, reason: 'no scene' };
  const s = window.__scene;

  // Dismiss welcome modal
  if (s.welcomeModal) { s.welcomeModal.destroy(); s.welcomeModal = null; }

  // Dismiss satchel modal (might be called differently)
  if (s._camp) { s._camp.close(); }
  if (s._redeemCard) { s._redeemCard.close(); }
  if (s._fuseCard) { s._fuseCard.close(); }
  if (s._aboutCardEl) { s._aboutCardEl.remove(); s._aboutCardEl = null; }

  // Buy Wood tool in preview mode
  // The belt buy button for tier 1
  const buyBtn = document.querySelector('#belt-buy-1') || document.querySelector('[data-tier="1"]') || document.querySelector('.belt-btn[data-tier="1"]');
  if (buyBtn) {
    buyBtn.click();
    // Or call the scene's buy method directly
    if (s.openBelt) s.openBelt();
  }

  return { ok: true };
});
console.log('setup:', result);
await new Promise((r) => setTimeout(r, 1000));

// Check tool status and trigger dig
const digResult = await page.evaluate(() => {
  if (!window.__scene) return { ok: false, reason: 'no scene' };
  const s = window.__scene;

  // Debug: what's the current tool?
  console.log('tool tier:', s.econ?.tier, 'left:', s.econ?.left);

  if (s.nodes && s.nodes.length > 0) {
    const node = s.nodes[0];
    s.player.setPosition(node.x, node.y);
    node.emit('pointerdown');
    return { ok: true, nodeX: node.x, nodeY: node.y, tool: s.econ?.tier };
  }
  return { ok: false, reason: 'no nodes' };
});
console.log('dig triggered:', digResult);

if (!digResult.ok) {
  await page.mouse.click(640, 400);
  console.log('fallback canvas click');
}

// Wait for WIND-UP (90ms) + SWING (70ms) = ~160ms, screenshot during IMPACT
await new Promise((r) => setTimeout(r, 180));

// Screenshot DURING the strike
await page.screenshot({ path: SHOT });
console.log('screenshot (mid-swing):', SHOT);

// Also screenshot after recovery
await new Promise((r) => setTimeout(r, 500));
const SHOT2 = SHOT.replace('.png', '-after.png');
await page.screenshot({ path: SHOT2 });
console.log('screenshot (after):', SHOT2);

await browser.close();
console.log('DONE');