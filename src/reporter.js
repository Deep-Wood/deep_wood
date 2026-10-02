// Runtime error reporting.
//
// WHY THIS EXISTS. A `ReferenceError` shipped to production in the HUD and sat
// there until a player photographed the screen. It was invisible by
// construction: render() runs inside bootChain().then(), so its throw was
// caught by the .catch() beside it and rendered as "offline · retry" -- a
// legitimate-looking state. 114 tests stayed green. Nothing in the project
// reported runtime errors at all.
//
// So the job is not only "log errors". It is to stop errors from wearing a
// normal-looking face. See reportError() -- that is the half that matters.
//
// Transport is deliberately swappable: with no endpoint configured this keeps
// errors in a ring buffer and does nothing else, which is a working local
// development aid. Point VITE_ERROR_REPORT_URL at any collector and it POSTs.
// A Sentry adapter drops in behind send() without touching a single call site.

const REDACT = [
  // Never put a player's key material or wallet in a third-party log.
  [/0x[a-fA-F0-9]{64}/g, '0x<64-hex-redacted>'],
  [/0x[a-fA-F0-9]{40}/g, '0x<address-redacted>'],
  [/\b[0-9a-fA-F]{16,}\b/g, '<hex-redacted>'],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>'],
  [/("(?:privateKey|mnemonic|seed|secret|passphrase)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"'],
];

export function scrub(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const [re, rep] of REDACT) out = out.replace(re, rep);
  return out;
}

/** Build the key used to collapse repeats. Same error at same place = same. */
function fingerprint(e) {
  const msg = (e && (e.message || String(e))) || 'unknown';
  const where = (e && (e.filename || '')) + ':' + ((e && e.lineno) || '');
  return scrub(msg).slice(0, 200) + ' @ ' + scrub(where);
}

export function createReporter({
  endpoint = null,
  max = 50,
  repeatWindowMs = 5 * 60 * 1000,
  now = () => Date.now(),
  fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  sentry = null,   // set later by attachSentry()
} = {}) {
  const ring = [];               // most recent errors, newest last
  const seen = new Map();        // fingerprint -> timestamp of last send
  let seq = 0;

  const rec = (err, context, level) => {
    const e = err || {};
    const entry = {
      id: ++seq,
      level: level || 'error',
      message: scrub(e.message || String(err || 'unknown')).slice(0, 500),
      stack: scrub(e.stack || '').slice(0, 2000),
      file: scrub(e.filename || ''),
      line: e.lineno || 0,
      col: e.colno || 0,
      // Keep a string context as-is. JSON.stringify('render') stores '"render"',
      // which then prints with stray quotes everywhere it is surfaced.
      context: context == null
        ? null
        : scrub(typeof context === 'string' ? context : JSON.stringify(context)).slice(0, 500),
      at: now(),
      url: typeof location !== 'undefined' && location && location.href
        ? String(location.href)
        : null,
    };
    ring.push(entry);
    while (ring.length > max) ring.shift();
    return entry;
  };

  // Rate-limited to first-party endpoints only. Loops are common (a per-frame
  // throw would otherwise POST thousands of times), but anything we need to see
  // is almost always seen more than once by whoever reports it, so console
  // output is never suppressed.
  const throttleOk = (entry) => {
    const k = fingerprint(entry);
    // Absent must mean "never sent", NOT "sent at epoch 0". Defaulting to 0
    // meant the very first occurrence of any error computed now()-0, which sits
    // inside the window for the first repeatWindowMs of the process's life --
    // so the first sighting of every error was silently dropped. That defeats
    // the entire point: the error you have never seen is the one you need.
    if (seen.has(k)) {
      if (now() - seen.get(k) < repeatWindowMs) return false;
    }
    seen.set(k, now());
    return true;
  };

  async function send(entry) {
    if (!endpoint || !fetchImpl) return false;
    if (!throttleOk(entry)) return false;
    try {
      await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
        // Never let reporting become a slow request the player waits on.
        keepalive: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  // Feed Sentry through the same throttle gate as the fetch transport, so a
  // throwing loop cannot produce thousands of events on either. The entry is
  // already scrubbed, and Sentry's own beforeSend scrubs again -- deliberately
  // redundant rather than trusting a single layer.
  const toSentry = (entry, original) => {
    if (!sentry) return;
    try {
      sentry.captureException(original instanceof Error ? original : new Error(entry.message), {
        level: entry.level,
        tags: { context: entry.context || 'none' },
        extra: { message: entry.message, file: entry.file, line: entry.line },
      });
    } catch { /* telemetry must never throw into the page */ }
  };

  /** Attach Sentry after initSentry() resolves, since it is a dynamic import. */
  const attachSentry = (sdk) => { sentry = sdk; };
  const hasSentry = () => !!sentry;

  const report = (err, context, level) => {
    const entry = rec(err, context, level);
    if (sentry && throttleOk(entry)) toSentry(entry, err);
    // Always console first: the local log is the ground truth and must not
    // depend on any third party being configured or reachable.
    if (typeof console !== 'undefined') {
      const tag = entry.context ? ` [${entry.context}]` : '';
      if (entry.level === 'warn') console.warn('[deepwood]', entry.message + tag);
      else console.error('[deepwood]', entry.message + tag, entry.file + ':' + entry.line);
    }
    void send(entry);
    return entry;
  };

  return {
    report,
    /**
     * Opt in to sending events tagged as harness noise. Off in production; the
     * e2e harness turns it on so it can inspect a real envelope on the wire,
     * then the dashboard stays clean on every other run.
     */
    allowTestEvents,
    /** Explicit, non-throwing path for errors a .catch() would otherwise eat. */
    reportError: (err, context) => report(err, context, 'error'),
    warn: (msg, context) => report(new Error(msg), context, 'warn'),
    ring: () => ring.slice(),
    clear: () => { ring.length = 0; seen.clear(); },
    attachSentry,
    hasSentry,
    install(target) {
      const w = target || (typeof window !== 'undefined' ? window : null);
      if (!w) return false;
      w.addEventListener('error', (ev) => {
        // Three shapes arrive here, and only reading ev.error misses two:
        //   1. real script error      -> ev.error set
        //   2. uncaught exception     -> ev.error often NULL, message on the
        //                                EVENT itself ("Uncaught TypeError: ...")
        //   3. failed resource load   -> ev.error null, target is the element
        // Handling only ev.error recorded "load error: unknown resource" for a
        // genuine uncaught TypeError -- which is the single case this whole
        // reporter exists to catch.
        let e = ev.error;
        if (!e && ev.message) {
          e = new Error(ev.message);
          e.filename = ev.filename;
          e.lineno = ev.lineno;
          e.colno = ev.colno;
        }
        if (!e) {
          const t = ev.target;
          const src = t && (t.src || t.href);
          e = new Error('load error: ' + (src || (t && (t.id || t.nodeName)) || 'unknown resource'));
        }
        report(e, 'window.onerror');
      });
      w.addEventListener('unhandledrejection', (ev) => {
        report(
          ev.reason instanceof Error ? ev.reason : new Error('unhandled rejection: ' + String(ev.reason)),
          'unhandledrejection',
        );
      });
      // Expose the buffer so tests and manual debugging can read what was
      // captured, and so a future Sentry adapter has one place to drain.
      //
      // Only the buffer: this used to be `{ ring, report, warn }`, but `warn`
      // is a property of the object being returned here, not a binding in this
      // scope, so evaluating it threw "ReferenceError: warn is not defined" on
      // every install. The reporter caught its own bug in its first smoke run.
      // The reporter itself is already on window.__reporter.
      w.__deepwoodErrors = ring;
      return true;
    },
  };
}

/** Endpoint from build-time env; null in dev or when unset. */
export const REPORT_ENDPOINT =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ERROR_REPORT_URL) || null;

/**
 * Sentry DSN, injected at build time only.
 *
 * A DSN is PUBLISHABLE and lives in the committed bundle on purpose. It
 * identifies the project and lets anyone send events, but it cannot read your
 * data and grants no access. This is the opposite of an RPC key or a private
 * key, which must never be committed. Keep it out of .env.local only if you
 * want local dev errors to stay on the machine.
 */
export const SENTRY_DSN =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SENTRY_DSN) || null;

/**
 * When false (the default and the only state in production), events tagged as
 * test-harness noise are DISCARDED before they leave the browser.
 *
 * This exists because the e2e harness needs to see a real envelope on the wire
 * to prove the DSN routing and the redaction, but sending that on every CI run
 * fills the dashboard with events nobody will ever fix. So the harness opts in
 * explicitly via allowTestEvents(true); nothing else in the game sets it, and
 * it is not readable from the network -- it lives only in the page it is set on.
 */
let _allowTestEvents = false;
export const allowTestEvents = (v) => { _allowTestEvents = !!v; };
export const testEventsAllowed = () => _allowTestEvents;

/**
 * Scrub a Sentry event in place. Runs in beforeSend, so this is the LAST thing
 * between a player and Sentry's servers.
 *
 * Sentry's own "send default PII" setting is off by default and must stay off,
 * but one toggle is not a guarantee -- a stack frame filename or a custom extra
 * key can carry an address without Sentry ever labelling it as one. So the
 * redaction is applied here too, at the boundary, and is deliberately
 * repetitive with the local scrub rather than trusting either layer alone.
 */
export function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.message) event.message = scrub(String(event.message));
  if (event.logger) event.logger = scrub(String(event.logger));
  // Exception values and their stack frames are the paths that actually leak:
  // a frame filename is arbitrary text from the page.
  for (const ex of [].concat(event.exception?.values || [])) {
    if (ex?.value) ex.value = scrub(String(ex.value));
    if (ex?.module) ex.module = scrub(String(ex.module));
    for (const f of [].concat(ex?.stacktrace?.frames || [])) {
      if (f?.filename) f.filename = scrub(String(f.filename));
      if (f?.absPath) f.absPath = scrub(String(f.absPath));
      if (f?.function) f.function = scrub(String(f.function));
    }
  }
  if (event.extra && typeof event.extra === 'object') {
    for (const k of Object.keys(event.extra)) {
      if (typeof event.extra[k] === 'string') event.extra[k] = scrub(event.extra[k]);
    }
  }
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b?.message) b.message = scrub(String(b.message));
      if (b?.data && typeof b.data === 'object') {
        for (const k of Object.keys(b.data)) {
          if (typeof b.data[k] === 'string') b.data[k] = scrub(b.data[k]);
        }
      }
    }
  }
  return event;
}

/**
 * Initialise Sentry. Separate from createReporter so the reporter's behaviour
 * and its tests never depend on the SDK being present or configured, and so
 * this can be skipped entirely when there is no DSN.
 *
 * beforeBreadcrumb drops console noise; the game is frame-driven and would
 * otherwise bury a real error under thousands of breadcrumbs.
 */
export async function initSentry(dsn = SENTRY_DSN) {
  if (!dsn) return null;
  // LAZY ON PURPOSE. The Sentry chunk is 142 KB gzipped on top of Phaser's
  // 360 KB -- 28% -- and an eager import makes every player download it on
  // every load, for a service they may never need. Instead this returns a stub
  // that does the real import on the FIRST error, so a session where nothing
  // breaks never fetches the SDK at all.
  let sdkPromise = null;
  const load = () => {
    if (!sdkPromise) sdkPromise = import('@sentry/browser').then((Sentry) => {
      Sentry.init({
      dsn,
      // Nothing identifies a player. No user id, no IP-derived default beyond
      // Sentry's own, no session replay. A wallet address in a stack trace is
      // scrubbed below, but the simplest privacy win is not to attach identity
      // at all.
      sendDefaultPii: false,
      tracesSampleRate: 0,
          beforeSend: (event, hint) => {
          // Drop the e2e harness's deliberate error so the dashboard only ever
          // contains real player errors. Asserted on in CI from the request the
          // test intercepts in the browser, not on the event arriving here, so
          // dropping it costs the test nothing.
          //
          // Also anything tagged with a TEST_CONTEXT prefix, so adding a new
          // harness later cannot leak noise by default.
          const tags = (event && event.tags) || {};
          const context = String(tags.context || '');
          const isTest = context.startsWith('sentry-e2e') || context.startsWith('__test_');
          if (isTest && !_allowTestEvents) {
            // Returning null is Sentry's documented way to discard an event.
            return null;
          }
          return scrubEvent(event, hint);
        },
        beforeBreadcrumb: (b) => (b && b.category === 'console' ? null : b),
      });
      return Sentry;
    }).catch((e) => {
      // Never let telemetry break the game.
      console.warn('[deepwood] sentry unavailable:', e && e.message);
      return null;
    });
    return sdkPromise;
  };

  // The stub is shaped like the SDK so call sites do not change; it is attached
  // eagerly, but costs nothing until captureException is actually called.
  return {
    captureException: (err, ctx) => load().then((S) => S && S.captureException(err, ctx)),
  };
}