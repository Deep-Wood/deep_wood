// Does an error actually reach Sentry from a real production page -- with the
// wallet address scrubbed on the way?
//
// The unit tests prove scrubEvent works on a synthetic event. This proves the
// DSN is live, the SDK loads on demand, the request goes to the user's own
// project, and no address survives into the payload.
//
//   node sentry-e2e.mjs [url]
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const DSN_ORG = '4512183620534272';
let fails = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}${d ? ' — ' + d : ''}`);
  if (!ok) fails++;
};

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();

// Capture every envelope Sentry tries to POST, and the request headers.
const envelopes = [];
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('/api/') && u.includes('/envelope/')) {
    try { envelopes.push({ url: u, body: req.postData() || '', headers: req.headers() }); } catch { /* ignore */ }
  }
  req.continue();
});

// The lazy-load property that actually matters: NOTHING reaches Sentry's servers
// until there is an error to send. Tracking the SDK chunk by resourceType was
// wrong -- Vite serves a dynamic import as a fetched chunk, not a <script>, so
// that check reported "never loaded" while the very next check showed the
// envelope POSTed. Measure the network effect, not the mechanism.
const inbox = [];
page.on('request', (req) => { if (req.url().includes('/envelope/')) inbox.push(Date.now()); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.__reporter', { timeout: 20000 });
await new Promise((r) => setTimeout(r, 4000));

check('Sentry is contacted ZERO times on a clean page load', inbox.length === 0,
  inbox.length ? `${inbox.length} request(s) before any error` : 'no request before an error');

// Fire a real error carrying a wallet address, the exact thing we must not leak.
await page.evaluate(() => {
  window.__reporter.reportError(
    Object.assign(new Error('settle failed for 0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d'), {
      filename: 'app.js', lineno: 7,
    }),
    'sentry-e2e',
  );
});
await new Promise((r) => setTimeout(r, 6000));

check('Sentry IS contacted after the error', envelopes.length > 0,
  `${envelopes.length} envelope(s)`);

const e = envelopes[envelopes.length - 1];
if (e) {
  check('envelope targets the project from the DSN we were given', e.url.includes(DSN_ORG),
    e.url.replace(/\?.*/, '').slice(0, 70));
  // Sentry v11 authenticates with sentry_key in the envelope query string, not
  // the X-Sentry-Auth header. Accept either; what matters is that it is a real
  // authenticated SDK envelope and not our own raw fetch.
  check('request is a real authenticated Sentry envelope',
    !!e.headers['x-sentry-auth'] || e.url.includes('sentry_key='),
    e.url.includes('sentry_key=') ? 'sentry_key in query (v11 style)' : 'auth header');
  check('NO wallet address in the wire payload', !e.body.includes('d1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d'),
    e.body.includes('address-redacted') ? 'redacted as expected' : 'check body');
  check('the error is still legible for triage', /settle failed for/.test(e.body) && /sentry-e2e/.test(e.body),
    'message and context survived redaction');
}

await browser.close();
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nSENTRY E2E PASSED');
process.exit(fails ? 1 : 0);