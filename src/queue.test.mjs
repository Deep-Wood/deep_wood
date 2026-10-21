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
