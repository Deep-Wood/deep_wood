// Does the reporter actually catch what it was built to catch?
//
// The production bug was a ReferenceError thrown inside a .then() callback and
// swallowed by the neighbouring .catch(). Reproduce exactly that shape here and
// assert the error is visible. A reporter that only proves itself in unit tests
// is the same mistake as a probe that cannot fail.
//
//   node reporter-smoke.mjs [url]
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
let fails = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}${d ? ' — ' + d : ''}`);
  if (!ok) fails++;
};

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.__reporter', { timeout: 20000 });
check('reporter installed on the page', true);

const before = await page.evaluate(() => window.__reporter.ring().length);

// 1. the exact production shape: throw inside a .then(), catch it beside.
await page.evaluate(() => {
  Promise.resolve()
    .then(() => { throw new ReferenceError('live is not defined'); })
    .catch((e) => { window.__reporter.reportError(e, 'render'); });
});
const afterThen = await page.evaluate(() => window.__reporter.ring());
check('an error thrown inside a .then() is captured', afterThen.length > before,
  afterThen.length ? afterThen[afterThen.length - 1].message : 'nothing captured');
check('the original message survives', /live is not defined/.test(afterThen[afterThen.length - 1].message));

// 2. A genuinely unhandled throw from SAME-ORIGIN script. Throwing from inside
// page.evaluate() is not a valid test of this: Chrome masks cross-origin errors
// as "Script error." with no filename and no stack, which is what the reporter
// received and faithfully stored. A real player error comes from the page's own
// bundle, so inject a <script> element -- same origin, full detail.
await page.evaluate(() => {
  const s = document.createElement('script');
  s.textContent = 'setTimeout(function(){ throw new TypeError("unhandled boom"); }, 0);';
  document.body.appendChild(s);
});
await new Promise((r) => setTimeout(r, 500));
const afterGlobal = await page.evaluate(() => window.__reporter.ring());
const boom = afterGlobal.find((e) => /unhandled boom/.test(e.message));
check('an uncaught same-origin error is captured with real detail', !!boom,
  boom ? `captured: ${boom.message}` : `ring held: ${afterGlobal.map((e) => e.message).join(' | ')}`);
check('the uncaught error kept its stack trace', !!(boom && boom.stack && boom.stack.length > 10),
  boom ? `${(boom.stack || '').split('\n').length} stack lines` : 'no stack');

// 3. redaction, end to end in a real browser.
await page.evaluate(() => {
  window.__reporter.reportError(
    Object.assign(new Error('swap failed for 0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d'), {
      stack: 'at swap (0x1234567890abcdef1234567890abcdef12345678:12)',
    }),
    { account: '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d' },
  );
});
const blob = await page.evaluate(() => JSON.stringify(window.__reporter.ring()));
check('a wallet address is redacted from what is captured',
  !blob.includes('d1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d') && !blob.includes('1234567890abcdef'),
  blob.includes('<address-redacted>') ? 'redacted as expected' : 'NOT REDACTED');

// 4. The REPORTER sends nothing without an endpoint. Spy on fetch rather than
// on all requests: an earlier version of this check watched every request and
// correctly saw the game's own RPC traffic, then failed for the game's sake.
const outbound = await page.evaluate(async () => {
  const calls = [];
  const real = window.fetch;
  window.fetch = function (...a) { calls.push(String(a[0])); return real.apply(this, a); };
  window.__reporter.reportError(new Error('should not be sent anywhere'));
  await new Promise((r) => setTimeout(r, 500));
  window.fetch = real;
  // The game's own chain reads share this fetch, so filter them out: this
  // asserts about the REPORTER, not about the app.
  return calls.filter((u) => !u.includes('rpc.testnet.chain.robinhood.com'));
});
check('the reporter fetches nothing with no endpoint configured', outbound.length === 0,
  outbound.slice(0, 2).join(', ') || 'zero reporter fetches');

await browser.close();
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nREPORTER SMOKE PASSED');
process.exit(fails ? 1 : 0);