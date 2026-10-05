import test from 'node:test';
import assert from 'node:assert/strict';
import { HuntQueue, MAX_BATCH } from './queue.js';

test('queue starts empty with base 0', () => {
  const q = new HuntQueue();
  assert.equal(q.size, 0);
  assert.equal(q.empty, true);
  assert.equal(q.nextIndex, 0n);
});

test('push stores counts and best, advancing nextIndex', () => {
  const q = new HuntQueue();
  q.rebase(7n, 1);
  assert.equal(q.nextIndex, 7n);
  const ok = q.push([1n, 0n, 0n, 0n, 0n], 100n);
  assert.equal(ok, true);
  assert.equal(q.size, 1);
  assert.equal(q.nextIndex, 8n);
  assert.deepEqual(q.entries[0].counts, [1n, 0n, 0n, 0n, 0n]);
  assert.equal(q.entries[0].bestSingleWei, 100n);
});

test('push refuses beyond MAX_BATCH', () => {
  const q = new HuntQueue();
  for (let i = 0; i < MAX_BATCH; i++) {
    assert.equal(q.push([1n, 0n, 0n, 0n, 0n], 1n), true);
  }
  assert.equal(q.push([1n, 0n, 0n, 0n, 0n], 1n), false);
  assert.equal(q.size, MAX_BATCH);
});

test('rebase adopts a moved index only when the queue is empty', () => {
  const q = new HuntQueue();
  q.rebase(5n, 1);
  q.push([1n, 0n, 0n, 0n, 0n], 1n);
  // Index moved underneath us (another session settled): the queued roll is
  // now for the WRONG hunt index, so the queue must drop.
  q.rebase(6n, 1);
  assert.equal(q.size, 0);
  assert.equal(q.base, 6n);
});

test('rebase to the expected next index keeps the queue', () => {
  const q = new HuntQueue();
  q.rebase(5n, 1);
  q.push([1n, 0n, 0n, 0n, 0n], 1n);
  // Nothing settled underneath: the chain index still equals the base, so
  // the rebase is a no-op on the queue and the entry survives.
  q.rebase(5n, 1);
  assert.equal(q.size, 1, 'queue survives an unchanged rebase');
});

test('stale detects a moved chain index', () => {
  const q = new HuntQueue();
  q.rebase(10n, 1);
  q.push([1n, 0n, 0n, 0n, 0n], 1n);
  assert.equal(q.stale(10n), false, 'chain index matches base');
  assert.equal(q.stale(11n), true, 'chain moved past base');
  assert.equal(q.stale(9n), true, 'chain behind base is also stale');
});

test('empty queue is never stale', () => {
  const q = new HuntQueue();
  assert.equal(q.stale(99n), false);
});

test('toCalldata returns parallel arrays in dig order', () => {
  const q = new HuntQueue();
  q.rebase(0n, 2);
  q.push([1n, 2n, 0n, 0n, 0n], 5n);
  q.push([0n, 0n, 0n, 1n, 0n], 7n);
  const { batch, bests } = q.toCalldata();
  assert.equal(batch.length, 2);
  assert.equal(bests.length, 2);
  assert.deepEqual(batch[0], [1n, 2n, 0n, 0n, 0n]);
  assert.equal(bests[1], 7n);
  // Copy, not alias: clearing the queue leaves the extracted data intact.
  q.clear();
  assert.equal(batch.length, 2);
});

test('clear empties without moving the base', () => {
  const q = new HuntQueue();
  q.rebase(3n, 1);
  q.push([1n, 0n, 0n, 0n, 0n], 1n);
  q.clear();
  assert.equal(q.size, 0);
  assert.equal(q.base, 3n, 'base survives a clear so the next dig re-rolls at the right index');
});
