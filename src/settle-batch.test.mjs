import test from 'node:test';
import assert from 'node:assert/strict';
import { calldataSettleBatch, sel } from './wallet.js';

/**
 * The batch encoder is the one piece of hand-rolled ABI in this feature that
 * can decode to garbage without failing loudly, so it is verified BYTE BY
 * BYTE here, and cross-checked against a live settleBatch on 46630.
 *
 * Canonical layout for `settleBatch(address,uint8,uint256[5][],uint256[])`:
 *   head:  player(32) tier(32) offsetA(32) offsetB(32)
 *   A:     length(32) elements[n x 5 words INLINE] -- a dynamic array of
 *          STATIC types lays elements inline after the length; pointers are
 *          only for arrays of DYNAMIC types (verified byte-for-byte against
 *          `cast calldata`, whose encoding the contract accepts).
 *   B:     length(32) bests[n]
 */

const P = '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d';
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const addr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

test('selector matches the artifact table', () => {
  assert.equal(sel('settleBatch(address,uint8,uint256[5][],uint256[])'), '0x46fed0ad');
});

test('one-hunt batch layout is byte exact', () => {
  const hex = calldataSettleBatch(P, 1, [[1n, 0n, 0n, 0n, 0n]], [123n]);

  // tail A at 0x80: length 1, then the five counts INLINE (no pointers).
  // tail B at 0x80 + 0x20 + 5*0x20 = 0x160.
  let expect = '46fed0ad' + addr(P) + w(1) + w(0x80) + w(0x160);
  expect += w(1);
  expect += w(1) + w(0) + w(0) + w(0) + w(0);
  expect += w(1) + w(123);

  assert.equal(hex, expect);
});

test('two-hunt batch offsets advance by 5 words per hunt', () => {
  const hex = calldataSettleBatch(
    P,
    2,
    [
      [1n, 0n, 0n, 0n, 0n],
      [0n, 1n, 0n, 0n, 0n],
    ],
    [10n, 20n],
  );

  const tailA = 0x80;
  const tailB = tailA + 32 + 2 * 5 * 32; // 0x1c0
  let expect = '46fed0ad' + addr(P) + w(2) + w(tailA) + w(tailB);
  expect += w(2);
  expect += w(1) + w(0) + w(0) + w(0) + w(0); // hunt 0 counts
  expect += w(0) + w(1) + w(0) + w(0) + w(0); // hunt 1 counts
  expect += w(2) + w(10) + w(20); // bests

  assert.equal(hex, expect);
});

test('twenty-hunt batch: tail B starts after the inline elements', () => {
  const batch = [];
  const bests = [];
  for (let i = 0; i < 20; i++) {
    batch.push([BigInt(i), 0n, 0n, 0n, 0n]);
    bests.push(BigInt(i));
  }
  const hex = calldataSettleBatch(P, 1, batch, bests);
  const arg = hex.slice(8); // drop selector
  const words = arg.match(/.{64}/g);
  const offA = BigInt('0x' + words[2]);
  const offB = BigInt('0x' + words[3]);
  // Computed, not hand-derived: tail B follows head(4) + length + 20
  // pointers + 20 elements of 5 words.
  const expectB = BigInt(4 * 32 + 32 + 20 * 5 * 32);
  assert.equal(offA, 0x80n, 'offsetA points right after the head');
  assert.equal(offB, expectB, 'offsetB word points past all of tail A');
  // The length word at tailB must say 20.
  assert.equal(BigInt('0x' + words[Number(offB / 32n)]), 20n, 'tail B length');
});

test('rejects a batch over the contract cap', () => {
  const batch = [];
  const bests = [];
  for (let i = 0; i < 21; i++) {
    batch.push([1n, 0n, 0n, 0n, 0n]);
    bests.push(0n);
  }
  assert.throws(() => calldataSettleBatch(P, 1, batch, bests), /exceeds the contract cap/);
});

test('rejects mismatched bests length', () => {
  assert.throws(
    () => calldataSettleBatch(P, 1, [[1n, 0n, 0n, 0n, 0n]], []),
    /bests must match/,
  );
});

test('rejects a hunt that is not five counts', () => {
  assert.throws(
    () => calldataSettleBatch(P, 1, [[1n, 0n, 0n, 0n]], [0n]),
    /exactly 5 rarity counts/,
  );
});

test('rejects an empty batch before any encoding', () => {
  assert.throws(() => calldataSettleBatch(P, 1, [], []), /non-empty/);
});
