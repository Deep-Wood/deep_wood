import test from 'node:test';
import assert from 'node:assert/strict';
import { HuntQueue, MAX_BATCH, saveQueue, loadQueue, dropStoredQueue } from './queue.js';

test('queue starts empty with base 0', () => {
  const q = new HuntQueue();
  assert.equal(q.size, 0);
  assert.equal(q.empty, true);
  assert.equal(q.nextIndex, 0n);
});

test('push stores counts, advancing nextIndex', () => {
  const q = new HuntQueue();
  q.rebase(7n, 1);
  assert.equal(q.nextIndex, 7n);
  const ok = q.push([1n, 0n, 0n, 0n, 0n]);
  assert.equal(ok, true);
  assert.equal(q.size, 1);
  assert.equal(q.nextIndex, 8n);
  assert.deepEqual(q.entries[0].counts, [1n, 0n, 0n, 0n, 0n]);
});

test('push refuses beyond MAX_BATCH', () => {
  const q = new HuntQueue();
  for (let i = 0; i < MAX_BATCH; i++) {
    assert.equal(q.push([1n, 0n, 0n, 0n, 0n]), true);
  }
  assert.equal(q.push([1n, 0n, 0n, 0n, 0n]), false);
  assert.equal(q.size, MAX_BATCH);
});

test('rebase adopts a moved index only when the queue is empty', () => {
  const q = new HuntQueue();
  q.rebase(5n, 1);
  q.push([1n, 0n, 0n, 0n, 0n]);
  // Index moved underneath us (another session settled): the queued roll is
  // now for the WRONG hunt index, so the queue must drop.
  q.rebase(6n, 1);
  assert.equal(q.size, 0);
  assert.equal(q.base, 6n);
});

test('rebase to the expected next index keeps the queue', () => {
  const q = new HuntQueue();
  q.rebase(5n, 1);
  q.push([1n, 0n, 0n, 0n, 0n]);
  // Nothing settled underneath: the chain index still equals the base, so
  // the rebase is a no-op on the queue and the entry survives.
  q.rebase(5n, 1);
  assert.equal(q.size, 1, 'queue survives an unchanged rebase');
});

test('stale detects a moved chain index', () => {
  const q = new HuntQueue();
  q.rebase(10n, 1);
  q.push([1n, 0n, 0n, 0n, 0n]);
  assert.equal(q.stale(10n), false, 'chain index matches base');
  assert.equal(q.stale(11n), true, 'chain moved past base');
  assert.equal(q.stale(9n), true, 'chain behind base is also stale');
});

test('empty queue is never stale', () => {
  const q = new HuntQueue();
  assert.equal(q.stale(99n), false);
});

test('toCalldata returns batch in dig order', () => {
  const q = new HuntQueue();
  q.rebase(0n, 2);
  q.push([1n, 2n, 0n, 0n, 0n]);
  q.push([0n, 0n, 0n, 1n, 0n]);
  const { batch } = q.toCalldata();
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0], [1n, 2n, 0n, 0n, 0n]);
  assert.deepEqual(batch[1], [0n, 0n, 0n, 1n, 0n]);
  // Copy, not alias: clearing the queue leaves the extracted data intact.
  q.clear();
  assert.equal(batch.length, 2);
});

test('clear empties without moving the base', () => {
  const q = new HuntQueue();
  q.rebase(3n, 1);
  q.push([1n, 0n, 0n, 0n, 0n]);
  q.clear();
  assert.equal(q.size, 0);
  assert.equal(q.base, 3n, 'base survives a clear so the next dig re-rolls at the right index');
});

test('rebase drops a queue whose tier changed, exactly like a moved base', () => {
  // Rolls are computed per tool tier; the contract recomputes with the tool
  // HELD at settle time. A queue that outlives a tool upgrade is a guaranteed
  // ResultMismatch that burns gas (observed live 2026-10-21: 8 Bronze rolls
  // settled 95s after a Silver purchase).
  const q = new HuntQueue(5n, 2);
  q.push([1n, 0n, 0n, 0n, 0n]);
  q.rebase(5n, 3);
  assert.equal(q.size, 0, 'tier-bound rolls die with the old pick');
  assert.equal(q.base, 5n, 'base adopts the chain index either way');
  assert.equal(q.tier, 3, 'tier adopts the held tool');
  // Same tier, same base: the queue survives untouched.
  q.push([1n, 0n, 0n, 0n, 0n]);
  q.rebase(5n, 3);
  assert.equal(q.size, 1, 'matching tier and base keep the queue');
  // A moved base still drops (unchanged behaviour).
  q.rebase(7n, 3);
  assert.equal(q.size, 0);
});

test('rebase drops a queue whose skill changed, but never on an unknown skill', () => {
  // _rollHunt(seed, player, index, TIER, SKILL): skill folds sub-level
  // rarities into Quartz, so a skill upgrade re-rolls different gems at
  // the same index. Undefined skill = not known yet (boot order: the
  // rebase runs before the skill sync) and must NOT be tested as zero.
  const q = new HuntQueue(5n, 3, 2);
  q.push([1n, 0n, 0n, 0n, 0n]);
  q.rebase(5n, 3, undefined);
  assert.equal(q.size, 1, 'unknown skill never drops the queue');
  assert.equal(q.skill, 2, 'unknown skill does not overwrite the known one');
  q.rebase(5n, 3, 2);
  assert.equal(q.size, 1, 'same skill keeps the queue');
  q.rebase(5n, 3, 3);
  assert.equal(q.size, 0, 'a skill upgrade kills the queued rolls');
  // A queue whose skill was never recorded (old persistence) SURVIVES a
  // known-skill rebase: its rolls were made under the chain's real skill,
  // and dropping them on a guess would throw away valid digs. The
  // contract's own recompute stays the backstop for truly stale rolls.
  const legacy = new HuntQueue(5n, 3);
  legacy.push([1n, 0n, 0n, 0n, 0n]);
  legacy.rebase(5n, 3, 2);
  assert.equal(legacy.size, 1, 'unknown skill is never tested, so no false drop');
  assert.equal(legacy.skill, 2, 'the known skill is adopted for future tests');
});

test('night-dig persistence round-trips the skill', () => {
  const store = mem();
  const q = new HuntQueue(9n, 3, 2);
  q.push([1n, 0n, 0n, 0n, 0n]);
  assert.equal(saveQueue(q, store), true);
  const back = loadQueue(store);
  assert.equal(back.skill, 2, 'skill survives the round-trip');
  back.rebase(9n, 3, 3);
  assert.equal(back.size, 0, 'restored queue still dies on a skill change');
});

// --- night digs: persistence round-trips -------------------------------------

const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('a queue save/load round-trip is lossless (BigInts included)', () => {
  const store = mem();
  const q = new HuntQueue(42n, 2);
  q.push([1n, 2n, 0n, 0n, 0n], 500000000000000n);
  q.push([0n, 0n, 3n, 0n, 1n], 0n);
  assert.equal(saveQueue(q, store), true);
  const back = loadQueue(store);
  assert.ok(back, 'restored');
  assert.equal(back.base, 42n);
  assert.equal(back.tier, 2);
  assert.equal(back.size, 2);
  assert.deepEqual(back.entries[0].counts, [1n, 2n, 0n, 0n, 0n]);
  assert.equal(back.entries[0].bestSingleWei, 500000000000000n);
  assert.deepEqual(back.entries[1].counts, [0n, 0n, 3n, 0n, 1n]);
  // The restored queue is settle-compatible: same base, so not stale.
  assert.equal(back.stale(42n), false);
  assert.equal(back.stale(43n), true);
});

test('an empty queue removes the store; nothing to resurrect', () => {
  const store = mem();
  const q = new HuntQueue(7n, 1);
  q.push([1n, 0n, 0n, 0n, 0n]);
  saveQueue(q, store);
  assert.ok(store.getItem('dw-queue-v1'));
  q.clear();
  saveQueue(q, store);
  assert.equal(store.getItem('dw-queue-v1'), null);
  dropStoredQueue(store); // idempotent
  assert.equal(loadQueue(store), null);
});

test('corrupt, absent, and oversize stores load as null, never throw', () => {
  const store = mem();
  assert.equal(loadQueue(store), null, 'absent');
  store.setItem('dw-queue-v1', '{not json');
  assert.equal(loadQueue(store), null, 'corrupt json');
  store.setItem('dw-queue-v1', JSON.stringify({ base: '1', tier: 1, entries: [{ c: ['1', '1', '1'], b: '0' }] }));
  assert.equal(loadQueue(store), null, 'wrong arity is rejected');
  const many = { base: '1', tier: 1, entries: [] };
  for (let i = 0; i <= MAX_BATCH; i++) many.entries.push({ c: ['1', '0', '0', '0', '0'], b: '0' });
  store.setItem('dw-queue-v1', JSON.stringify(many));
  assert.equal(loadQueue(store), null, 'oversize batch is rejected -- the contract cap is the load cap');
  const hostile = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
  assert.doesNotThrow(() => saveQueue(new HuntQueue(), hostile));
  const full = new HuntQueue(1n, 1);
  full.push([1n, 0n, 0n, 0n, 0n]);
  assert.equal(saveQueue(full, hostile), false, 'a non-empty save reports failure so the caller keeps the leave-warning honest');
});
