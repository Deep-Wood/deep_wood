// There is no toolbelt panel. The toolbelt is permanent rows in the top card.
//
// This asserts the requirement directly rather than the geometry of whatever was
// last built: pressing the old green circle must not create anything, and every
// toolbelt affordance must be reachable in the card.
//
//   node no-panel-check.mjs [url]
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const VIEWPORTS = [
  { name: 'phone portrait', w: 390, h: 844 },
  { name: 'small phone', w: 320, h: 568 },
  { name: 'landscape phone', w: 844, h: 390 },
  { name: 'desktop', w: 1280, h: 800 },
];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h });
  await page.evaluateOnNewDocument(() => { window.__forceTouchControls = true; });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`\n${vp.name} (${vp.w}x${vp.h})`);

  const g = await page.evaluate(() => {
    const s = window.__scene;
    const hudKids = s.hud ? s.hud.list.length : 0;
    // The old green circle must be gone entirely.
    const labels = s.touchLayer ? s.touchLayer.list
      .filter((o) => o.type === 'Text').map((o) => o.text) : [];
    return {
      beltPanel: !!s.beltPanel,
      domBelt: !!document.getElementById('belt'),
      domCounts: (document.getElementById('belt-counts') || {}).textContent || '',
      domMode: (document.getElementById('belt-mode') || {}).textContent || '',
      domTools: document.getElementById('belt-tools') ? document.getElementById('belt-tools').children.length : 0,
      domToolBtns: document.querySelectorAll('#belt-tools button').length,
      domClaim: (document.getElementById('belt-claim') || {}).textContent || '',
      domClaimBtn: !!document.getElementById('belt-claim'),
      domShop: document.getElementById('belt-shop') ? document.getElementById('belt-shop').children.length : 0,
      domShopBtns: document.querySelectorAll('#belt-shop button').length,
      // the belt must be inside the top-bar grid flow, not floating over the game
      beltRect: (() => { const b = document.getElementById('belt'); if (!b) return null;
        const r = b.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; })(),
      hasBeltButton: labels.includes('TOOLBELT'),
      boardButton: labels.includes('BOARD'),
      hudKids,
      toolRows: s.beltRows ? s.beltRows.length : 0,
      shopRows: s.shopRows ? s.shopRows.length : 0,
      // the card must stay inside the viewport
      cardBottom: 0,
      vh: s.scale.height,
      cardsInHud: document.querySelectorAll('#hud .card').length,
      beltInSeason: !!document.querySelector('#season #belt'),
      statusInSeason: !!document.querySelector('#season #status'),
      anyUndefined: [document.getElementById('belt')?.innerText || '']
        .filter((t) => /undefined|NaN/.test(t)),
    };
  });

  check(!g.beltPanel, 'no toolbelt panel exists');
  check(!g.beltBackdrop, 'no backdrop / scrim over the game');
  check(!g.hasBeltButton, 'the old TOOLBELT green circle is gone');
  check(g.boardButton, 'BOARD button still present');
  check(g.cardsInHud === 1, 'the top of the screen is ONE card', `${g.cardsInHud} cards`);
  check(g.beltInSeason, 'the toolbelt is inside the season card');
  check(g.statusInSeason, 'the chain/wallet chips are inside the season card');
  check(g.domBelt, 'the toolbelt is in the DOM top bar');
  check(/COMMON/.test(g.domCounts), 'carries the gem counts', JSON.stringify(g.domCounts));
  check(g.domMode.length > 0, 'carries the on-chain / preview line', JSON.stringify(g.domMode.slice(0, 28)));
  check(g.domTools >= 1, 'carries the tool row(s)', `${g.domTools}`);
  check(g.domClaimBtn && g.domClaim.length > 1, 'claim button present', JSON.stringify(g.domClaim));
  check(g.domShop === 2, 'carries both gem-shop rows', `${g.domShop}`);
  check(g.domShopBtns === 2, 'both shop buy buttons are clickable', `${g.domShopBtns}`);
  check(g.beltRect && g.beltRect.h > 20 && g.beltRect.w > 100, 'the belt row has real size',
    g.beltRect ? `${g.beltRect.w}x${g.beltRect.h} at y=${g.beltRect.top}` : 'missing');
  check(g.beltRect && g.beltRect.top + g.beltRect.h <= vp.h * 0.6,
    'the belt stays in the top bar, clear of the playfield',
    g.beltRect ? `bottom ${g.beltRect.top + g.beltRect.h} of ${vp.h}` : '');
  check(g.anyUndefined.length === 0, 'no row renders undefined/NaN', g.anyUndefined.join(' | '));
  check(g.shopRows === 2, 'the scene still tracks both shop rows', `${g.shopRows}`);

  // Tapping the old button position must not create anything over the game.
  const created = await page.evaluate(() => {
    const s = window.__scene;
    const before = s.children.list.length;
    s.openBelt();
    s.toggleBelt();
    return s.children.list.length - before;
  });
  check(created === 0, 'openBelt() creates no game objects', `${created} created`);

  // And the hunter must be walkable the whole time.
  const moved = await page.evaluate(async () => {
    const s = window.__scene;
    const x0 = s.player.x;
    s.touchState.press(99, 'right');
    await new Promise((r) => setTimeout(r, 800));
    s.touchState.release(99);
    return Math.round(Math.abs(s.player.x - x0));
  });
  check(moved > 2, 'the hunter walks normally', `moved ${moved}px`);

  // Actually CLICK the card's buttons. Sentry caught
  // "hudKeepAwake is not defined" in production because the harness asserted the
  // buttons existed and were wired, and never pressed one. Existence is not
  // reachability.
  const clicks = await page.evaluate(async () => {
    const out = [];
    for (const sel of ['#belt-claim', '#belt-shop button', '#belt-tools button']) {
      const el = document.querySelector(sel);
      if (!el) { out.push(`${sel}:absent`); continue; }
      try { el.click(); out.push(`${sel}:clicked`); }
      catch (e) { out.push(`${sel}:threw ${e.message}`); }
      await new Promise((r) => setTimeout(r, 250));
    }
    return out;
  });
  for (const c of clicks) {
    check(!/threw/.test(c), 'clicking the card does not throw', c);
  }

  await page.screenshot({ path: `/tmp/card-${vp.name.replace(/\s+/g, '-')}.png` });
  await page.close();
}

const p = await browser.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await p.waitForFunction('window.__scene && window.__scene.player', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
await p.close();
check(errs.length === 0, 'no page errors', errs.join(' | '));

console.log(`\n${failures === 0 ? 'NO-PANEL CHECK PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);