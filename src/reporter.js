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

function scrub(s) {
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

  const report = (err, context, level) => {
    const entry = rec(err, context, level);
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
    /** Explicit, non-throwing path for errors a .catch() would otherwise eat. */
    reportError: (err, context) => report(err, context, 'error'),
    warn: (msg, context) => report(new Error(msg), context, 'warn'),
    ring: () => ring.slice(),
    clear: () => { ring.length = 0; seen.clear(); },
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