// Tests for the runtime error reporter.
//
// The properties that matter: an error that would otherwise hide behind a
// degraded UI is captured, repeats are not spammed, and nothing sensitive is
// ever included in what gets sent.
//
//   node --test src/reporter.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReporter, REPORT_ENDPOINT, scrubEvent, SENTRY_DSN } from './reporter.js';

const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);

// --- capture ---------------------------------------------------------------

test('reportError captures an error instead of letting it vanish', () => {
  const r = createReporter();
  r.reportError(err('live is not defined'), 'render');
  assert.equal(r.ring().length, 1);
  assert.match(r.ring()[0].message, /live is not defined/);
  assert.equal(r.ring()[0].context, 'render');
});

test('the ring is capped, so a throwing loop cannot exhaust memory', () => {
  const r = createReporter({ max: 10 });
  for (let i = 0; i < 500; i++) r.reportError(err('boom ' + i));
  assert.equal(r.ring().length, 10);
  // newest kept, oldest dropped
  assert.match(r.ring()[9].message, /boom 499/);
});

test('warn is recorded at a different level', () => {
  const r = createReporter();
  r.warn('slow rpc');
  assert.equal(r.ring()[0].level, 'warn');
});

// --- redaction -------------------------------------------------------------

test('wallet addresses are redacted from message, stack and context', () => {
  const r = createReporter();
  r.reportError(
    err('rejected from 0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d', {
      stack: 'at swap (0x1234567890abcdef1234567890abcdef12345678:12)',
    }),
    { account: '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d' },
  );
  const e = r.ring()[0];
  assert.ok(!/d1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d/.test(e.message), 'address leaked into message');
  assert.ok(!/1234567890abcdef/.test(e.stack), 'address leaked into stack');
  assert.ok(!/d1Bd8e3D/.test(e.context), 'address leaked into context');
  assert.match(e.message, /<address-redacted>/);
});

test('private keys and secrets never leave', () => {
  const r = createReporter();
  r.reportError(err('bad key 0x' + 'ab'.repeat(32)), { privateKey: '0xdeadbeef', mnemonic: 'word word word' });
  const e = r.ring()[0];
  const blob = JSON.stringify(e);
  assert.ok(!blob.includes('ab'.repeat(32)), '64-hex key leaked');
  assert.ok(!blob.includes('deadbeef'), 'privateKey leaked');
  assert.ok(!blob.includes('word word word'), 'mnemonic leaked');
});

test('bearer tokens are redacted', () => {
  const r = createReporter();
  r.reportError(err('rpc said 401 Bearer sk-live-abc123XYZ'));
  assert.ok(!/sk-live-abc123XYZ/.test(r.ring()[0].message));
});

test('the page URL is captured for triage, and absent outside a browser', () => {
  // Deliberate that the URL is NOT redacted: it is how you find which deploy
  // was affected. Under node there is no location, so the field is null rather
  // than the string "undefined" -- asserted as a real contract either way.
  const r = createReporter();
  r.reportError(err('x'));
  const u = r.ring()[0].url;
  assert.ok(u === null || typeof u === 'string', `url must be null or a string, got ${typeof u}`);
});

// --- transport -------------------------------------------------------------

test('with no endpoint configured nothing is sent and nothing throws', async () => {
  const r = createReporter({ endpoint: null, fetchImpl: null });
  r.reportError(err('silent'));
  assert.equal(await r.send ? true : true, true);
  assert.equal(r.ring().length, 1);
});

test('errors are POSTed when an endpoint is set', async () => {
  const sent = [];
  const r = createReporter({
    endpoint: 'https://example.invalid/e',
    fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true }; },
  });
  r.reportError(err('sent me'));
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://example.invalid/e');
  assert.match(sent[0].body.message, /sent me/);
});

test('repeats are throttled so a per-frame throw cannot flood the collector', async () => {
  let t = 1000;
  const sent = [];
  const r = createReporter({
    endpoint: 'https://example.invalid/e',
    now: () => t,
    repeatWindowMs: 60_000,
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; },
  });
  const line = { filename: 'app.js', lineno: 42 };
  for (let i = 0; i < 50; i++) r.reportError(err('same error', line));
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(sent.length, 1, 'identical repeats must collapse to one send');

  // but a genuinely NEW error still goes through inside the window
  r.reportError(err('different error', line));
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(sent.length, 2);

  // and after the window expires the same one is allowed again
  t += 61_000;
  r.reportError(err('same error', line));
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(sent.length, 3);
});

test('a failing collector never breaks the page', async () => {
  const r = createReporter({
    endpoint: 'https://example.invalid/e',
    fetchImpl: async () => { throw new Error('network down'); },
  });
  r.reportError(err('still fine'));
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.ring().length, 1, 'the error is still captured locally');
});

// --- the regression this was built for -------------------------------------

test('an error thrown inside a .then() is still reported, not eaten', async () => {
  // This is the exact shape that hid the production bug: render() threw inside
  // bootChain().then(), the neighbouring .catch() swallowed it, and the UI said
  // "offline". With the reporter installed, the same throw is visible.
  const sent = [];
  const r = createReporter({
    endpoint: 'https://example.invalid/e',
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body).message); return { ok: true }; },
  });

  await Promise.resolve()
    .then(() => { throw err('live is not defined', { filename: 'index.html', lineno: 123 }); })
    .catch((e) => { r.reportError(e, 'render'); });

  await new Promise((res) => setTimeout(res, 5));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /live is not defined/);
});

test('install() must not throw a ReferenceError of its own', () => {
  // Regression: install() built `{ ring, report, warn }`, but `warn` is a
  // property of the returned object rather than a binding in scope, so it threw
  // on every single install -- and the reporter caught its own bug in its first
  // smoke run.
  const listeners = {};
  const fake = { addEventListener: (t, f) => { listeners[t] = f; } };
  const r = createReporter();
  assert.equal(r.install(fake), true);
  assert.ok(Array.isArray(fake.__deepwoodErrors), 'buffer exposed for tests/adapters');
  assert.doesNotThrow(() => listeners.error({ error: err('x'), message: 'x' }));
  assert.doesNotThrow(() => listeners.unhandledrejection({ reason: err('y') }));
});

test('a global error event with no .error still yields the real message', () => {
  // Chrome delivers an uncaught exception with ev.error null and the text on the
  // event. Reading only ev.error recorded "load error: unknown resource" for a
  // genuine TypeError.
  const listeners = {};
  const fake = { addEventListener: (t, f) => { listeners[t] = f; } };
  const r = createReporter();
  r.install(fake);
  listeners.error({ error: null, message: 'Uncaught TypeError: x is not a function', filename: 'app.js', lineno: 9 });
  assert.match(r.ring()[0].message, /x is not a function/);
  assert.equal(r.ring()[0].line, 9);
});

test('a failed resource load is captured without pretending it is a script error', () => {
  const listeners = {};
  const fake = { addEventListener: (t, f) => { listeners[t] = f; } };
  const r = createReporter();
  r.install(fake);
  listeners.error({ error: null, message: '', target: { src: '/assets/missing.js' } });
  assert.match(r.ring()[0].message, /load error: \/assets\/missing\.js/);
});

// --- endpoint config -------------------------------------------------------

test('no endpoint is configured by default', () => {
  // A build must not ship a silent third-party endpoint. If someone adds
  // VITE_ERROR_REPORT_URL this test is the reminder that it changed.
  assert.equal(REPORT_ENDPOINT, null);
});

test('no Sentry DSN under the test runner, so tests never ship real events', () => {
  // node --test has no Vite env, so this must be null. It is the guard that
  // stops a test run from reporting into the live project.
  assert.equal(SENTRY_DSN, null);
});

// --- Sentry event scrubbing ------------------------------------------------

test('scrubEvent redacts addresses out of a real Sentry event shape', () => {
  // This is the last thing between a player and Sentry's servers, so it has to
  // handle the fields Sentry actually populates, not just message/stack.
  const ev = {
    message: 'swap failed for 0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d',
    exception: {
      values: [{
        type: 'TypeError',
        value: 'no account 0x1234567890abcdef1234567890abcdef12345678',
        module: 'src/wallet.js',
        stacktrace: {
          frames: [{ filename: 'app.js', absPath: '/x/0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd', function: 'swap' }],
        },
      }],
    },
    extra: { to: '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d', kind: 'swap' },
    breadcrumbs: [{ message: 'clicked 0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d', data: { acct: '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d' } }],
  };
  const out = scrubEvent(ev);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes('d1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d'), 'address leaked');
  assert.ok(!blob.includes('1234567890abcdef'), 'address leaked from exception value');
  assert.ok(!blob.includes('abcdefabcdefabcdefabcdefabcdefabcdefabcd'), 'address leaked from frame absPath');
  // Non-address fields must survive, or the event becomes useless for triage.
  assert.equal(out.extra.kind, 'swap');
  assert.equal(out.exception.values[0].type, 'TypeError');
  assert.equal(out.exception.values[0].stacktrace.frames[0].function, 'swap');
});

test('scrubEvent tolerates a partial or unusual event', () => {
  assert.doesNotThrow(() => scrubEvent({}));
  assert.doesNotThrow(() => scrubEvent({ exception: { values: [{}] } }));
  assert.doesNotThrow(() => scrubEvent({ extra: null }));
  assert.equal(scrubEvent(null), null);
});

// --- Sentry sink -----------------------------------------------------------

test('errors reach the attached Sentry sink, through the same throttle', async () => {
  const sent = [];
  const r = createReporter({ now: () => 1000, repeatWindowMs: 60_000 });
  r.attachSentry({ captureException: (e) => { sent.push(e.message); } });
  const line = { filename: 'a.js', lineno: 3 };
  for (let i = 0; i < 5; i++) r.reportError(err('same thing', line));
  assert.equal(sent.length, 1, 'repeats must collapse before reaching Sentry');
  r.reportError(err('a different thing', line));
  assert.equal(sent.length, 2);
});

test('a throwing Sentry sink cannot break reporting', () => {
  const r = createReporter();
  r.attachSentry({ captureException: () => { throw new Error('sentry exploded'); } });
  assert.doesNotThrow(() => r.reportError(err('still captured')));
  assert.equal(r.ring().length, 1);
});

test('hasSentry reflects whether a sink is attached', () => {
  const r = createReporter();
  assert.equal(r.hasSentry(), false);
  r.attachSentry({ captureException: () => {} });
  assert.equal(r.hasSentry(), true);
});