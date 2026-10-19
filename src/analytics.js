// First-party analytics for the DeepWood site.
//
// WHY: the app shipped with zero usage visibility (the one unchecked box on
// the builder checklist). This closes it without third parties: a tiny
// event vocabulary is POSTed same-origin to /collect, which a Vercel
// rewrite proxies server-side to the VPS collector. No cookies, no local
// storage, no wallet addresses, no fingerprinting -- event names and small
// props only, so the collector cannot become a player-tracking table.
//
// Safety rules, in priority order:
// 1. Analytics must never break the app: every call is try/caught and
//    fire-and-forget (sendBeacon, else keepalive fetch).
// 2. No endpoint configured (dev, tests, Node) -> every call is a no-op;
//    the module must import cleanly with no window at all.
// 3. One vocabulary, set here. Anything not in the collector's whitelist is
//    dropped server-side anyway.

/** Build-time endpoint; null in dev/tests (VITE_ANALYTICS_URL=/collect in prod). */
const ENDPOINT =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ANALYTICS_URL) ||
  null;

const seen = new Set();

/**
 * Track a funnel event. `props` must be small: short keys, short values --
 * the collector drops anything oversized or unknown.
 * @param {string} event pageview | wallet_connect | tool_buy | hunt_settle |
 *                       gems_redeem | leaderboard_view | tutorial_step
 * @param {{[k: string]: string | number | boolean}} [props]
 */
export function track(event, props = {}) {
  if (!ENDPOINT) return;
  try {
    const body = JSON.stringify({ e: event, props });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, body);
    } else if (typeof fetch === 'function') {
      fetch(ENDPOINT, {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => { /* fire and forget */ });
    }
  } catch { /* rule 1 */ }
}

/**
 * track(), but at most once per event name per page life -- for singleton
 * events like pageview or a first wallet connect.
 */
export function trackOnce(event, props = {}) {
  if (seen.has(event)) return;
  seen.add(event);
  track(event, props);
}
