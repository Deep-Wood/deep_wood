/**
 * Nothing in the belt may contradict the chain.
 *
 * Two reported symptoms, one root cause each, both from the same mistake -- the
 * belt renders from a local mirror (`econ`) that was written from the CLIENT
 * side of an action instead of from the chain's own state:
 *
 *  1. "tool broken - repair below" for a player holding 20/20.
 *     refreshChainTool() wrote `econ.tool` and `econ.durability`. The player
 *     shape is { tier, left, max }, so those were new properties nothing reads
 *     and `left` stayed 0 -- which is exactly the broken test.
 *
 *  2. "no gems yet" forever, with sell disabled, for a player holding gems.
 *     gemsOf() existed on the reader but was only ever read to CONFIRM a sale;
 *     the balance was never written into the mirror.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const scene = readFileSync(new URL('./ForestScene.js', import.meta.url), 'utf8');
const player = readFileSync(new URL('./player.js', import.meta.url), 'utf8');

/** Strip comments so a comment explaining a fix cannot satisfy the assertion. */
const code = (s) => s.replace(/\/\/[^\n]*/g, '');

/** The real player shape, straight from newPlayer(). */
function playerFields() {
  const body = player.slice(player.indexOf('export function newPlayer'));
  const end = body.indexOf('\n}');
  return [...body.slice(0, end).matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
}

test('the chain mirror writes the REAL player field names', () => {
  // The bug was invented names. This pins them to newPlayer()'s shape.
  const fields = playerFields();
  for (const f of ['tier', 'left', 'max']) {
    assert.ok(fields.includes(f), `newPlayer must define ${f}`);
  }
  assert.ok(!fields.includes('tool'), 'the field is `tier`, not `tool`');
  assert.ok(!fields.includes('durability'), 'the field is `left`, not `durability`');

  const mirror = code(scene.slice(scene.indexOf('async refreshChainTool'), scene.indexOf('/** Refresh the on-chain balance')));
  assert.ok(!/econ\.tool\s*=/.test(mirror), 'must not write a `tool` property');
  assert.ok(!/econ\.durability\s*=/.test(mirror), 'must not write a `durability` property');
  assert.match(mirror, /econ\.tier = tier/);
  assert.match(mirror, /econ\.left = Number\(tool\.durability/);
});

test('the buy mirror writes the real field names too', () => {
  const seg = code(scene.slice(scene.indexOf('async _doBuyTool'), scene.indexOf('async doRepair')));
  assert.ok(!/p\.tool\s*=/.test(seg));
  assert.ok(!/p\.durability\s*=/.test(seg));
  assert.match(seg, /p\.tier = tier/);
  assert.match(seg, /p\.left = Number\(r\.durability/);
});

test('max is derived, not read from the chain', () => {
  // toolOf() returns (tier, durability, broken) -- no max. Without deriving it
  // from the economy mirror a healthy tool reads as "20/0 uses".
  const mirror = code(scene.slice(scene.indexOf('async refreshChainTool'), scene.indexOf('/** Refresh the on-chain balance')));
  assert.match(mirror, /econ\.max = tier > 0 \? durabilityOf\(tier\) : 0/);
});

test('gems are read from the chain into the mirror', () => {
  // gemsOf() was only ever read to confirm a sale. A player holding gems was
  // shown "no gems yet" with sell disabled.
  assert.match(scene, /async refreshChainGems\(\)/);
  const body = code(scene.slice(scene.indexOf('async refreshChainGems'), scene.indexOf('/** Refresh the on-chain balance')));
  assert.match(body, /r\.gemsOf\(account, x\)/, 'must read all rarities');
  assert.match(body, /econ\.gems = held\.map/);
  assert.match(body, /catch \{/, 'a failed read must not blank the satchel');
});

test('tool reconciliation pulls gems in the same pass', () => {
  // One connect sync, one consistent state. Reading the tool and leaving the
  // satchel stale is the half-fix that produced this class of report.
  assert.match(scene, /await this\.refreshChainGems\(\)/);
});

test('the blocked reason names the actual block', () => {
  // It used to say "tool broken - repair below" for every blocked state,
  // including owning nothing at all.
  assert.match(scene, /_blockedReason\(\)/);
  const body = code(scene.slice(scene.indexOf('_blockedReason() {'), scene.indexOf('_canHuntNow() {')));
  assert.match(body, /tier === 0/, 'no tool is its own message');
  assert.match(body, /left > 0/, 'healthy-but-blocked must not claim broken');
  assert.match(body, /'Tool broken\. Repair or upgrade first\.'/, 'a real break still says so');
});

test('the prompt no longer hardcodes the broken message', () => {
  const seg = code(scene.slice(scene.indexOf('const near = this.nearestNode'), scene.indexOf('if (intent.hunt)')));
  assert.ok(
    !/tool broken - repair below/.test(seg),
    'the prompt must delegate to _blockedReason instead of asserting one cause',
  );
});

test('_canHuntNow tests the field the mirror actually writes', () => {
  assert.match(scene, /this\.econ\.left === 0/);
});