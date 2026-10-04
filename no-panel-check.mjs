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
      // One tool, not a list (ECONOMY-SPEC.md section 1).
      domTool: (document.getElementById('belt-tool') || {}).textContent || '',
      domToolName: (document.querySelector('#belt-tool .tn') || {}).textContent || '',
      domActions: document.querySelectorAll('#belt-actions button').length,
      domBuy: (document.getElementById('belt-buy') || {}).textContent || '',
      domBuyBtn: !!document.getElementById('belt-buy'),
      domSellBtn: !!document.getElementById('belt-sell'),
      domGems: [...document.querySelectorAll('#gemlist .gem')].length,
      // the belt must be inside the top-bar grid flow, not floating over the game
      beltRect: (() => { const b = document.getElementById('belt'); if (!b) return null;
        const r = b.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; })(),
      hasBeltButton: labels.includes('TOOLBELT'),
      boardButton: labels.includes('BOARD'),
      hudKids,
      // The economy state is a single tool object, not rows.
      econTier: s.econ ? s.econ.tier : null,
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
  check(g.domCounts.length > 0, 'carries the gem counts', JSON.stringify(g.domCounts));
  check(g.domMode.length > 0, 'carries the on-chain / preview line', JSON.stringify(g.domMode.slice(0, 28)));
  check(g.domTool.length > 0, 'carries the tool row', JSON.stringify(g.domTool.slice(0, 40)));
  // Names the tool. The PRICE moves to the title whenever three buttons share
  // the row (a narrow belt column, or a phone), so it is asserted below in the
  // state where there is room for it rather than here where there is not.
  check(g.domBuyBtn && /^buy Wood/.test(g.domBuy.trim()),
    'the buy button names the first tool', JSON.stringify(g.domBuy.trim()));
  check(g.domSellBtn, 'the sell-gems button is present');
  check(g.domActions >= 2, 'carries both ETH actions', `${g.domActions}`);
  check(g.domGems === 5, 'the satchel lists all five rarities', `${g.domGems}`);
  check(g.beltRect && g.beltRect.h > 20 && g.beltRect.w > 100, 'the belt row has real size',
    g.beltRect ? `${g.beltRect.w}x${g.beltRect.h} at y=${g.beltRect.top}` : 'missing');
  check(g.beltRect && g.beltRect.top + g.beltRect.h <= vp.h * 0.6,
    'the belt stays in the top bar, clear of the playfield',
    g.beltRect ? `bottom ${g.beltRect.top + g.beltRect.h} of ${vp.h}` : '');
  check(g.anyUndefined.length === 0, 'no row renders undefined/NaN', g.anyUndefined.join(' | '));
  check(g.econTier === 0, 'a new player holds no tool', `tier ${g.econTier}`);

  // --- the card must not GROW between states.
  // The card's height used to move with its contents: buying a tool added a
  // row, breaking it added the repair button, and a long wallet error wrapped
  // the footer to three lines. Each of those pushed the forest down and took
  // the playfield with it. It is locked per viewport now, so this measures
  // every state that used to move it and asserts they are all identical.
  const heights = await page.evaluate(async () => {
    const s = window.__scene;
    const H = () => Math.round(document.getElementById('season').getBoundingClientRect().height);
    const out = { empty: H() };
    s.simBalance = 10n ** 20n;
    s.refreshBelt();
    document.getElementById('belt-buy').click();
    await new Promise((r) => setTimeout(r, 120));
    out.withTool = H();
    s.econ.left = 0; s.refreshBelt();
    await new Promise((r) => setTimeout(r, 120));
    out.broken = H();
    s.econ.gems = [200, 5, 1, 0, 1]; s.refreshBelt(); window.renderGems?.();
    s.beltMsg('Connected, but could not switch to chain 46630 (chain switch rejected in the wallet). Switch it in your wallet, then press again.', 'bad');
    await new Promise((r) => setTimeout(r, 120));
    out.worstCase = H();
    // and nothing is silently clipped away to achieve it
    const card = document.getElementById('season');
    out.clipped = [...card.querySelectorAll('*')]
      .filter((e) => e.scrollHeight > e.clientHeight + 2 && getComputedStyle(e).overflow === 'hidden')
      .map((e) => e.id || e.className);
    return out;
  });
  // NOTE the argument order: check(ok, label, detail). These were first written
  // as check(label, condition, detail), which passed the LABEL STRING as the
  // condition -- a non-empty string is always truthy, so all four checks passed
  // unconditionally, including with the height lock deleted. They printed
  // "ok true" and were watching nothing.
  check(heights.withTool === heights.empty,
    'the card does not grow when a tool is bought', `${heights.empty} -> ${heights.withTool}`);
  check(heights.broken === heights.empty,
    '  nor when it breaks', `${heights.empty} -> ${heights.broken}`);
  check(heights.worstCase === heights.empty,
    '  nor with a full satchel and a long error', `${heights.empty} -> ${heights.worstCase}`);
  check(heights.clipped.length === 0,
    '  and nothing is clipped to achieve it', heights.clipped.join(', '));

  // Every action button must be readable, not merely present.
  //
  // Fitting three buttons on one row meant shrinking type and shortening
  // labels, and a label that ellipsised to "buy Bronze 0." hides the price --
  // the one thing the button exists to quote. So this asserts each label is
  // fully rendered, and that they all share ONE line, at every viewport.
  const btns = await page.evaluate(async () => {
    const s = window.__scene;
    s.simBalance = 10n ** 20n;
    s.refreshBelt();
    document.getElementById('belt-buy').click();
    await new Promise((r) => setTimeout(r, 150));
    s.econ.left = 0; s.refreshBelt();   // three buttons: buy, sell, fix
    await new Promise((r) => setTimeout(r, 200));
    const els = [...document.querySelectorAll('#belt-actions button')];
    return els.map((e) => ({
      label: e.textContent.trim(),
      truncated: e.scrollWidth > e.clientWidth + 1,
      top: Math.round(e.getBoundingClientRect().top),
    }));
  });
  check(btns.length === 3, 'a broken tool offers all three actions', `${btns.length}`);
  check('every action label is fully readable', btns.every((b) => !b.truncated),
    btns.filter((b) => b.truncated).map((b) => b.label).join(', '));
  check('  and all three share one line', new Set(btns.map((b) => b.top)).size === 1,
    `rows: ${new Set(btns.map((b) => b.top)).size}`);

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
    // The new card's controls. Existence is not reachability -- these must
    // actually be pressable without throwing.
    for (const sel of ['#belt-buy', '#belt-sell']) {
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

// --- the tree bakes, checked in a real browser ------------------------------
// The night pass added a moon rim that read a block-scoped `cy` and threw
// "cy is not defined" for two of the four tree variants, which took the scene
// down in local AND production. 159 unit tests passed straight through it,
// because nothing in the suite ever baked a tree. This runs in the page, where
// Phaser and a real canvas actually exist, and reads pixels rather than trusting
// that the code ran.
const bakes = await p.evaluate(async () => {
  // READ the textures the scene already baked at startup -- do not call
  // makeTreeTexture again. Re-baking replaces the live texture object and every
  // sprite bound to it loses its GL handle, which fails the page with
  // "Cannot read properties of null (reading 'glTexture')". That was this test
  // breaking the thing it was testing. Reading the shipped texture also has the
  // advantage of verifying what actually reached the player.
  const out = [];
  for (let v = 0; v < 4; v++) {
    const key = `tree${v}`;
    const tex = window.__scene.textures.get(key);
    if (!tex) { out.push({ v, key, w: 0, inked: 0, moonPx: 0 }); continue; }
    const src = tex.getSourceImage();
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, src.width, src.height).data;
    let moonPx = 0, inked = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      inked++;
      // PAL.moon is #9fd8e8 -- cool, high blue. Count pixels near it: the rim
      // is drawn at partial alpha over the canopy, so it lands desaturated.
      if (d[i] > 90 && d[i + 2] > 130 && d[i + 2] > d[i] + 25) moonPx++;
    }
    out.push({ v, key, w: src.width, inked, moonPx });
  }
  return out;
});
for (const b of bakes) {
  check(b.w > 0 && b.inked > 50, `tree variant ${b.v} baked real pixels`, `${b.inked}px`);
  check(b.moonPx > 0, `tree variant ${b.v} has a moon rim`, `${b.moonPx}px`);
}

await p.close();
check(errs.length === 0, 'no page errors', errs.join(' | '));

console.log(`\n${failures === 0 ? 'NO-PANEL CHECK PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);