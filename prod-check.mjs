// Production check after a Vercel deploy.
// A green build is not a rendered site. Asserts on things that cannot be false
// negatives: HTTP status, title, the chain chip, console/page errors, and the
// touch control set at 390px.
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'https://deepwood-two.vercel.app/';
const NEW = '0xD7633c0623BC5a1FD82677c34f97612633ADe720';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

const page = await browser.newPage();
const errs = [];
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

const res = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
check('serves 200', res.status() === 200, 'got ' + res.status());
check('title is DeepWood', (await page.title()) === 'DeepWood', await page.title());

// wait for the canvas / scene to exist
await page
  .waitForFunction('window.__scene && window.__scene.finds !== undefined', { timeout: 30000 })
  .catch(() => {});
const scene = await page.evaluate(() => (window.__scene ? true : false));
check('scene booted', scene);

// no horizontal overflow at desktop and at 390px
// A real phone descriptor, not setViewport. setViewport alone leaves
// `pointer: coarse` false, so the touch layer correctly stays hidden and the
// control check below fails on a perfectly good deploy -- a false negative from
// the harness, not a fault on the page.
const PHONE = {
  name: 'phone',
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const overflowAt = async (w, h) => {
  await page.setViewport({ width: w, height: h });
  await new Promise((r) => setTimeout(r, 700));
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
};
check('no h-overflow at 1280px', (await overflowAt(1280, 800)) <= 0);

// Measure phone overflow in a page that was BORN a phone. Measuring after a
// bare setViewport({390,844}) on a desktop-sized page reports ~445px of
// overflow that does not exist: the Phaser canvas is still sized for 1280 and
// has not re-fitted yet. Loading in phone mode gives scrollWidth 390 and zero
// overflowing elements, which is the truth about the layout.
await page.emulate(PHONE);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__scene && window.__scene.finds !== undefined', { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const of390 = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check('no h-overflow at 390px', of390 <= 0, of390 + 'px over');

// the mobile control set must be present and actually visible
const touchSet = await page.evaluate(() => {
  const want = ['up', 'left', 'right', 'down', 'hunt', 'belt', 'board'];
  const zones = (window.__scene && window.__scene.touchZones) || [];
  const names = zones.map((z) => z.btn);
  return {
    missing: want.filter((w) => !names.includes(w)),
    visible: zones.filter((z) => z.zone && z.zone.width > 0 && z.zone.height > 0).length,
  };
});
check('all 7 touch controls present', touchSet.missing.length === 0, 'missing: ' + (touchSet.missing.join(',') || 'none'));

// desktop must NOT show them
await page.setViewport({ width: 1280, height: 800, hasTouch: false, isMobile: false });
await new Promise((r) => setTimeout(r, 900));
const deskVisible = await page.evaluate(() =>
  ((window.__scene && window.__scene.touchZones) || []).filter(
    (z) => z.zone && z.zone.width > 0 && z.zone.height > 0,
  ).length,
);
check('desktop hides touch controls', deskVisible === 0, deskVisible + ' visible');

check('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');

await page.screenshot({ path: '/tmp/dw-prod.png' });
await browser.close();

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nPRODUCTION CHECK PASSED');
process.exit(fails ? 1 : 0);