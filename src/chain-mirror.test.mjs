/**
 * The local belt mirror must never contradict the chain.
 *
 * Reproduces the reported failure: a player signed "buy Wood" TWICE and nothing
 * appeared to happen. Both times the purchase was real on the first attempt --
 * the chain granted Wood -- but the local mirror stayed empty, so the button
 * kept reading "buy Wood". The second signature was a re-buy of a tool already
 * held, which the contract rejects with TierLocked.
 *
 * Root cause: the mirror was written by re-running the LOCAL buyTool(), sized
 * against walletBalanceWei() == `chainBalanceWei ?? 0n`. On a first purchase
 * chainBalanceWei is still null, so the local call refused for insufficient
 * funds and the mirror was never updated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const scene = readFileSync(new URL('./ForestScene.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the mirror is written from the chain-confirmed tier, not the local sim', () => {
  // If the mirror is only updated when the LOCAL buy succeeds, a stale balance
  // silently discards a purchase the chain already granted.
  assert.match(
    scene,
    /p\.tool = tier/,
    'the chain-confirmed tier must be adopted',
  );
  assert.match(scene, /p\.durability = Number\(r\.durability/);
  assert.match(scene, /p\.broken = false/);
});

/** The ON-CHAIN branch only: the preview branch above it legitimately differs. */
function onchainBuyBranch() {
  const a = scene.indexOf('async _doBuyTool');
  const off = scene.indexOf('ON-CHAIN:', a);
  const end = scene.indexOf('async doRepair', a);
  return scene.slice(off, end);
}

test('the chain balance is read BEFORE the mirror is touched', () => {
  // Ordering matters: walletBalanceWei() is `chainBalanceWei ?? 0n`, so a mirror
  // update sized before refreshChainBalance() sees 0 ETH and refuses.
  const seg = onchainBuyBranch();
  const refresh = seg.indexOf('await this.refreshChainBalance();');
  const mirror = seg.indexOf('const res = buyTool(p, tier,');
  assert.ok(refresh > -1, 'balance must be refreshed in the on-chain buy path');
  assert.ok(mirror > -1, 'mirror step must exist');
  assert.ok(
    refresh < mirror,
    'balance read must precede the local mirror sizing, or it sees 0n and refuses',
  );
});

test('a failed local mirror does not discard a confirmed purchase', () => {
  // The `if (res.ok)` shape was the bug: ok=false meant the update was skipped.
  // The override must be unconditional-ish on the CHAIN having confirmed.
  assert.ok(
    !/if \(res\.ok\) \{\s*\n\s*recordToolSpend/.test(scene),
    'recording spend must not be the only thing gated on the local result',
  );
  assert.match(scene, /if \(!res\.ok\) \{[\s\S]{0,320}?p\.tool = tier/,
    'a local refusal must fall back to the chain value');
});

test('connect adopts the held tool from the chain', () => {
  // Otherwise a reload shows "buy Wood" to a player who owns Wood, and the
  // re-buy costs a signature before reverting TierLocked.
  assert.match(scene, /async refreshChainTool\(\)/);
  assert.match(scene, /r\.toolOf\(account\)/, 'must read the real tool');
  assert.match(html, /refreshChainTool\?\.\(\)/, 'the connect sync must call it');
});

test('an unreadable tool leaves the mirror alone', () => {
  // "I could not read the chain" is not "you own nothing". Blanking the mirror
  // on a failed read re-creates the original bug for anyone on a flaky RPC.
  assert.match(
    scene,
    /catch \{\s*\n\s*return;[^}]*unreadable/s,
    'a failed read must bail out, not blank the mirror',
  );
});

test('the mirror is never sized against simBalance on chain', () => {
  // simBalance is the preview fiction; sizing a real tx against it is the same
  // class of bug as the null -> 0n case. Only the ON-CHAIN branch matters --
  // preview mode is SUPPOSED to use it.
  const seg = onchainBuyBranch();
  assert.ok(!seg.includes('simBalance'),
    'the on-chain buy path must not read the simulated balance');
});