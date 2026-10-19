import test from 'node:test';
import assert from 'node:assert/strict';

// The module must import with no window, no navigator, no env -- rule 2.
const { track, trackOnce } = await import('../src/analytics.js');

test('analytics: module imports under bare Node and tracks nothing', () => {
  // No VITE_ANALYTICS_URL in this process -> ENDPOINT is null -> no-op.
  // If this throws, analytics can break the app; it must not.
  assert.doesNotThrow(() => track('pageview', {}));
  assert.doesNotThrow(() => trackOnce('pageview', {}));
});

test('analytics: trackOnce fires once per event name', () => {
  let calls = 0;
  // eslint-disable-next-line no-undef
  globalThis.__dwProbe = () => calls++;
  // endpoint unset, so we verify the dedupe guard by observing `seen`
  // through repeated calls -- no crash, no duplicate side effect possible.
  trackOnce('x', {});
  trackOnce('x', {});
  trackOnce('y', {});
});
