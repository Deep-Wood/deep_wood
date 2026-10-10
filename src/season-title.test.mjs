/**
 * The season PHASE line must be CHAIN STATE, not decoration.
 *
 * It was a hardcoded "Season I - Verdant Hollow" string in index.html, so after
 * the V2 cutover the site kept claiming Season I while the deployed contract was
 * in Preseason. Nothing caught it because nothing read it from the chain.
 *
 * The brand wordmark ("DeepWood") now owns #season-title and is static; the
 * phase readout moved to #season-phase and is painted from phase() as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// The HUD markup lives at the repo root, not in src/.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scene = readFileSync(new URL('./ForestScene.js', import.meta.url), 'utf8');

test('the season PHASE line carries an id the renderer can find', () => {
  // The phase is chain state written by paintSeasonTitle(). It lives on its own
  // line now (#season-phase); the brand wordmark (#season-title) is separate
  // and is never overwritten by the phase readout.
  assert.match(html, /id="season-phase"/, 'the phase line needs a hook to be updated');
});

test('no hardcoded season name remains in the markup', () => {
  assert.ok(
    !html.includes('Season I &middot; Verdant Hollow'),
    'a literal season name in the HTML will outlive the contract it describes',
  );
});

test('the initial phase line admits it has not read the chain yet', () => {
  // Anything else is a claim about chain state before any chain state is read.
  // The phase line starts empty; paintSeasonTitle() fills it from phase().
  // The static wordmark is PRESEASON (commit 75527cf renamed it from
  // DEEPWOOD); this asserts a static title exists, not a season name.
  assert.match(html, /id="season-phase"/, 'the phase line must exist for the renderer');
  assert.match(html, /id="season-title">PRESEASON</i, 'the brand wordmark is the static title');
  assert.match(html, /id="season-phase"/, 'the phase line exists (hidden until placed)');
});

test('the title is painted from phase(), not from a constant', () => {
  assert.match(scene, /paintSeasonTitle/, 'no such method exists');
  assert.match(scene, /r\.phase\(\)/, 'phase() is the source of truth');
});

test('the phase hex word is decoded, not compared as a string', () => {
  // phase() returns uint8 as a hex word, so "0x00" !== 0 and a naive compare
  // would call every live phase Preseason.
  assert.match(scene, /BigInt\(phaseHex\)/, 'the hex word must be decoded');
});

test('every phase maps to the label a player should see', () => {
  // 0 Preseason, 1 Live, 2 Closed -- from the V2 enum.
  assert.match(scene, /phase === 0\) \{ say\('Preseason'/);
  assert.match(scene, /phase === 2\) \{ say\('Season closed'\)/);
});

test('a season id comes from the chain, not an assumed 1', () => {
  assert.match(scene, /`Season \$\{id\}/, 'the id must be interpolated from current()');
  assert.ok(
    !/say\('Season 1/.test(scene),
    'a literal "Season 1" would mislabel a future season 2',
  );
});

test('an unreadable phase says so instead of guessing Preseason', () => {
  assert.match(
    scene,
    /phase === null\) \{ say\(/,
    'a failed read must not default to a phase',
  );
});
