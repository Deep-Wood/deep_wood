// Verify the redemption card renders ABOVE its backdrop and is interactive.
//
// The bug: the card was authored inside #hud (a stacking context at z-index 9),
// so its z-index: 71 was scoped there while the backdrop sat at z-index 70 on
// <body> -- painting OVER the card and blurring it via backdrop-filter.
//
// The check is therefore structural, not cosmetic: after opening the card, the
// element at the card's own centre must BE the card (or a descendant), and the
// backdrop must not be the topmost element there.
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'https://deepwood-two.vercel.app/';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 1280, height: 800 });

const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

// Dismiss the first-run tutorial overlay. It is a legitimate z-index 200 modal
// and would sit over the card in a fresh profile, which is correct behaviour --
// but it makes the card untestable, so the test skips past it.
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('dw-tutorial-v1', '1'); } catch { /* ignore */ }
});

await page.goto(`${URL}?cb=${Math.random().toString(36).slice(2)}`, {
  // domcontentloaded, NOT networkidle: the page streams background music and
  // polls the chain forever, so "idle" never arrives and the navigation times
  // out even though the game booted fine.
  waitUntil: 'domcontentloaded', timeout: 60000,
});
await new Promise((r) => setTimeout(r, 6000));

// Open the card directly through the scene, the same path the button uses.
const opened = await page.evaluate(async () => {
  const s = window.__scene;
  if (!s) return { ok: false, why: 'no scene' };
  if (typeof s.openRedeemCard !== 'function') return { ok: false, why: 'no openRedeemCard' };
  // Give the player a balance so the card has something to show.
  s.econ.gems = [1600, 0, 5, 0, 0];
  s._tokenRailActive = true;
  s.openRedeemCard();
  await new Promise((r) => setTimeout(r, 400));
  const card = document.getElementById('redeem-card');
  return {
    ok: true,
    hidden: card?.classList.contains('hidden'),
    parent: card?.parentElement?.tagName,
  };
});
console.log('OPEN:', JSON.stringify(opened));

if (opened.ok && !opened.hidden) {
  // The real test: what is on top at the card's centre?
  const hit = await page.evaluate(() => {
    const card = document.getElementById('redeem-card');
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const backdrop = document.querySelector('.redeem-backdrop');
    const bdVisible = backdrop && !backdrop.classList.contains('hidden');
    return {
      cardRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      topTag: top?.tagName,
      topId: top?.id || null,
      topClass: typeof top?.className === 'string' ? top.className : null,
      insideCard: !!(top && card.contains(top)),
      backdropVisible: bdVisible,
      cardZ: getComputedStyle(card).zIndex,
      cardPE: getComputedStyle(card).pointerEvents,
      backdropZ: backdrop ? getComputedStyle(backdrop).zIndex : null,
      backdropBlur: backdrop ? getComputedStyle(backdrop).backdropFilter : null,
    };
  });
  console.log('HIT:', JSON.stringify(hit, null, 2));

  // Is the primary control actually clickable at its own coordinates?
  const clickable = await page.evaluate(() => {
    const go = document.getElementById('redeem-go');
    const r = go.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { isGo: top === go, topTag: top?.tagName, topId: top?.id || null };
  });
  console.log('BUTTON:', JSON.stringify(clickable));

  // And does typing an amount drive the card? (the whole point of the feature)
  const typed = await page.evaluate(async () => {
    const inp = document.getElementById('redeem-input');
    inp.value = '1500';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const quote = document.getElementById('redeem-quote')?.textContent;
    const msg = document.getElementById('redeem-msg')?.textContent;
    const goDisabled = document.getElementById('redeem-go')?.disabled;
    return { quote, msg, goDisabled, of: document.getElementById('redeem-of')?.textContent };
  });
  console.log('TYPED:', JSON.stringify(typed));
}

console.log('PAGEERRORS:', errs.length ? errs.slice(0, 3) : 'none');
await browser.close();
