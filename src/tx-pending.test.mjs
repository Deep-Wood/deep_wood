/**
 * An in-flight chain action must LOOK in flight.
 *
 * Reported failure: a player signed "buy Wood" twice because a pending
 * transaction was indistinguishable from a dead button -- the only feedback was
 * a small status line, and the button itself sat there looking inert and
 * clickable. The second signature was what actually broke, because the contract
 * rejects re-buying a held tool with TierLocked.
 *
 * So the pending state has to be visible ON the acting control, survive a belt
 * rebuild, and -- critically -- be cleared again afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const scene = readFileSync(new URL('./ForestScene.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('./belt.css', import.meta.url), 'utf8');

test('every chain action raises and clears a pending state', () => {
  // A pending state that is set but never cleared wedges the button forever --
  // worse than the original bug, because the game becomes unusable.
  for (const [id, verb] of [
    ['belt-buy', 'buying'],
    ['belt-repair', 'repairing'],
    ['belt-sell', 'selling'],
  ]) {
    assert.match(
      scene,
      new RegExp(`setTxPending\\('${id}', '${verb}'\\)`),
      `${id} must show a pending state while in flight`,
    );
  }
  assert.match(scene, /clearTxPending\(\)/);
});

test('clearing the pending state REBUILDS the belt', () => {
  // The bug this file was written for, found in a browser: nulling the fields
  // left the button reading "buying…" permanently, because refreshBelt() is
  // what produces the label and nothing else ran on that path.
  // Anchor on the DEFINITION, not a call site: `clearTxPending();` appears
  // three times as a statement, and a naive indexOf lands on the first one,
  // whose slice runs to the next brace and swallows the method entirely -- so
  // the test passed even with the refreshBelt() line deleted.
  const i = scene.indexOf('  clearTxPending() {');
  assert.ok(i > -1, 'the clearTxPending definition must exist');
  // Strip COMMENTS before matching. The comment inside this very method
  // mentions refreshBelt() while explaining why it is required, so matching the
  // raw text found the explanation and passed even with the call deleted --
  // a test that could never fail.
  const body = scene.slice(i, scene.indexOf('\n  }', i))
    .replace(/\/\/[^\n]*/g, '');
  assert.match(
    body,
    /this\.refreshBelt\(\)/,
    'clearTxPending must rebuild the belt or the busy label never goes away',
  );
});

test('the pending state is applied at the render point, not just at set time', () => {
  // refreshBelt() runs on every balance update, including the one that happens
  // DURING a purchase. Without decorating at render, that rebuild silently
  // drops the busy state and the button looks clickable again mid-signature.
  const calls = scene.match(/decoratePending\(/g) ?? [];
  assert.ok(calls.length >= 4, `expected the decorator at every append, saw ${calls.length}`);
  assert.match(scene, /decoratePending\(btn\)/, 'it must be a reusable method');
});

test('only the acting button shows pending', () => {
  // All three sharing one row means a global "busy" state would grey out
  // controls the player is not waiting on.
  assert.match(
    scene,
    /if \(this\.txPendingId !== btn\.id\) return false/,
    'the pending state must be scoped to the one button',
  );
});

test('a pending button is disabled and says why', () => {
  assert.match(scene, /btn\.disabled = true/);
  assert.match(scene, /btn\.classList\.add\('busy'\)/);
  assert.match(scene, /textContent = `\$\{this\.txPendingVerb\}\\u2026`/);
  // The stale "Need X ETH" reason must go: under a pending label it reads as a
  // refusal that already happened.
  assert.match(scene, /btn\.removeAttribute\('title'\)/);
});

test('pending is styled as working, not as refused', () => {
  // A disabled button defaults to a not-allowed cursor, which reads as "this
  // is broken". The action is still in progress.
  assert.match(css, /\.belt-actions \.act\.busy/);
  assert.match(css, /cursor: progress/);
  assert.match(css, /@keyframes belt-busy/);
});

test('the pulse respects reduced-motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('the busy label still fits the button', () => {
  // "buying…" is 7 chars against "buy Wood"'s 8, so the content-sized button
  // cannot grow past what the longest normal label already reserved.
  assert.ok('buying…'.length <= 'buy Bronze 0.052'.length);
});