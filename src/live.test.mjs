/**
 * Live-connection test against the REAL deployed contract.
 *
 * Skips (exit 0) when no address is configured, so an offline dev checkout
 * is not a test failure. Set VITE_GAME_ADDRESS to exercise it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vite loads .env.local into import.meta.env at BUILD time, but plain `node`
// does not -- so under `node --test` config.gameAddress would always be empty
// and these tests would SKIP, passing for the wrong reason. That is exactly the
// failure mode these tests exist to catch, so replicate the same lookup here.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['.env.local', '.env.production', '.env']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
for (const k of ['VITE_RPC_URL', 'VITE_GAME_ADDRESS', 'VITE_CHAIN_ID', 'VITE_TOKEN_ADDRESS']) {
  if (process.env[k]) process.env[k] = process.env[k];
}

const { bootChain, describe, withRetry } = await import('./live.js');
const { isConfigured, configProblem } = await import('./config.js');

test('config reports a usable address', () => {
  if (!isConfigured()) {
    assert.ok(configProblem(), 'unconfigured builds must say why');
    console.log('  skip  not configured:', configProblem());
    return;
  }
  assert.equal(configProblem(), null);
});

test('boots against the deployed contract', async () => {
  if (!isConfigured()) {
    console.log('  skip  not configured');
    return;
  }
  const r = await bootChain();
  console.log('  ' + describe(r));
  assert.equal(r.ok, true, r.reason);

  // The economy must actually decode, not just not throw.
  const { onChain } = r;
  assert.equal(typeof onChain.config.burnFeeBps, 'bigint');
  assert.equal(typeof onChain.config.seasonLength, 'bigint');
  assert.ok(onChain.config.seasonLength > 0n, 'season must have a length');

  for (const t of [1, 2, 3, 4]) {
    // Tier 1 is deliberately free (DeepWood.sol: "free first tool"), so only
    // durability is universally > 0. Asserting cost > 0 here would encode a
    // false invariant and flag a correct deployment as broken.
    assert.ok(onChain.tiers[t].dur > 0n, `tier ${t} durability`);
    assert.ok(typeof onChain.tiers[t].hunt === 'bigint', `tier ${t} hunt cost`);
  }
  assert.equal(onChain.tiers[1].cost, 0n, 'tier 1 must be free');
  assert.ok(onChain.tiers[4].cost > 0n, 'tier 4 must cost something');
  assert.equal(onChain.price.length, 5);
  assert.equal(onChain.weight.length, 5);

  // Every rarity price must be strictly increasing, else the gem ladder is
  // broken and the UI would show nonsense.
  for (let i = 1; i < 5; i++) {
    assert.ok(onChain.price[i] > onChain.price[i - 1], `price[${i}] > price[${i - 1}]`);
  }
});

test('client mirror is in sync with the contract', async () => {
  if (!isConfigured()) {
    console.log('  skip  not configured');
    return;
  }
  const r = await bootChain();
  assert.equal(r.ok, true, r.reason);
  // `drift` means the CLIENT is wrong about the contract -- a real defect.
  // An owner retune lands in onChain-vs-default and is reported separately.
  assert.deepEqual(r.drift, [], `client drifted from contract:\n${r.drift.join('\n')}`);
});
/* ---------------- retry ---------------- */

test('withRetry returns the first success without retrying again', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    return { ok: true, chain: { address: '0xabc' } };
  }, 3, 1);
  assert.equal(r.ok, true);
  assert.equal(calls, 1, 'a healthy read must not be repeated');
});

test('withRetry recovers when the first attempts fail transiently', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 3) return { ok: false, reason: 'RPC error: Failed to fetch' };
    return { ok: true };
  }, 3, 1);
  assert.equal(r.ok, true, 'a dropped connection must not end the session offline');
  assert.equal(calls, 3);
});

test('withRetry retries a THROWN error, not just a returned failure', async () => {
  // fetch() rejects rather than returning a body on a network drop, so a
  // retry that only inspected the resolved value would never fire.
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 2) throw new Error('Failed to fetch');
    return { ok: true };
  }, 3, 1);
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test('withRetry does NOT retry a definitive answer', async () => {
  // A chain mismatch or a paused contract is the truth, not a transport
  // glitch. Retrying only delays telling the player what is actually wrong.
  for (const reason of ['chain mismatch: expected 46630, RPC is on 1', 'contract is paused']) {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      return { ok: false, reason };
    }, 3, 1);
    assert.equal(calls, 1, `"${reason}" must be reported after one attempt`);
    assert.equal(r.reason, reason);
  }
});

test('withRetry gives up after the attempt budget and reports the last reason', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    return { ok: false, reason: 'RPC error: Failed to fetch' };
  }, 3, 1);
  assert.equal(r.ok, false, 'retrying forever would leave the player on a blank canvas');
  assert.equal(calls, 3);
  assert.match(r.reason, /RPC error/);
});

test('withRetry backs off between attempts', async () => {
  const stamps = [];
  await withRetry(async () => {
    stamps.push(Date.now());
    return { ok: false, reason: 'RPC error: Failed to fetch' };
  }, 3, 40);
  assert.equal(stamps.length, 3);
  const first = stamps[1] - stamps[0];
  const second = stamps[2] - stamps[1];
  assert.ok(first >= 35, `first backoff ${first}ms should be ~40ms`);
  assert.ok(second > first, `second backoff ${second}ms should exceed the first`);
});
