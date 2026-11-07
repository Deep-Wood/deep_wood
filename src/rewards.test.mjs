// rewards.js conformance: the client table must mirror the V10.2 contract table
// exactly (ids, amounts, Sapphire cap, scopes) and the claim-key/digest
// packing must match Solidity's abi.encodePacked / abi.encode byte-for-byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, encodePacked, toBytes } from 'viem';
import {
  REWARDS, REWARD_ALIAS, CLAIM_TYPEHASH, rewardIdFor, rewardIdHex,
  claimDayFor, claimKeyHex, claimDigestHex, formatReward, rewardTotal,
  assertTableValid,
} from './rewards.js';
import { dayNumber, saturdayOf, utcDay } from './engagement.js';
import { calldataClaimReward } from './wallet.js';

// The approved table (owner decision 2026-11-06): reduced + capped at Sapphire.
const EXPECTED = {
  'warm-pick': [5n, 0n, 0n, 0n, 0n], 'prospectors-eye': [2n, 1n, 0n, 0n, 0n],
  'keep-it-sharp': [5n, 0n, 0n, 0n, 0n], 'big-dig': [15n, 3n, 0n, 0n, 0n],
  'streak-3': [3n, 0n, 0n, 0n, 0n], 'streak-7': [8n, 2n, 0n, 0n, 0n],
  'streak-14': [15n, 3n, 1n, 0n, 0n], 'streak-30': [40n, 10n, 2n, 0n, 0n],
  'first-find': [2n, 0n, 0n, 0n, 0n], 'amber-rush': [0n, 1n, 0n, 0n, 0n],
  'deep-blue': [0n, 0n, 1n, 0n, 0n], 'ruby-crown': [0n, 0n, 3n, 0n, 0n],
  'diamond-club': [0n, 0n, 5n, 0n, 0n], 'mithril-club': [10n, 2n, 1n, 0n, 0n],
  'lapidary': [10n, 2n, 1n, 0n, 0n], 'century': [25n, 2n, 0n, 0n, 0n],
  'on-the-board': [3n, 1n, 0n, 0n, 0n], 'kindling': [3n, 0n, 0n, 0n, 0n],
  'furnace': [15n, 3n, 1n, 0n, 0n], 'century-digger': [12n, 2n, 0n, 0n, 0n],
  'grand-digger': [50n, 10n, 3n, 0n, 0n], 'patron': [0n, 4n, 1n, 0n, 0n],
};

test('table matches the approved amounts exactly', () => {
  assert.deepEqual(Object.keys(REWARDS).sort(), Object.keys(EXPECTED).sort());
  for (const [id, amounts] of Object.entries(EXPECTED)) {
    assert.deepEqual(REWARDS[id].amounts, amounts, `amounts for ${id}`);
  }
});

test('Sapphire cap: no Ruby/Diamond rewards anywhere', () => {
  assertTableValid(); // throws on violation
  for (const r of Object.values(REWARDS)) {
    assert.equal(r.amounts[3], 0n);
    assert.equal(r.amounts[4], 0n);
  }
});

test('scopes are valid and hot-streak aliases streak-7 (no double-pay)', () => {
  for (const r of Object.values(REWARDS)) {
    assert.ok(['daily', 'weekend', 'once'].includes(r.scope));
  }
  assert.equal(rewardIdFor('hot-streak'), 'streak-7');
  assert.equal(rewardIdFor('warm-pick'), 'warm-pick');
  assert.equal(REWARD_ALIAS['hot-streak'], 'streak-7');
});

test('rewardIdHex = keccak256(utf8 id), matches known vector', () => {
  assert.equal(rewardIdHex('warm-pick'),
    '0x38b89d5a92c6c6d91c15754328df21893e1f6748255903267221eac0c6ba9915');
  assert.equal(rewardIdHex('warm-pick'), keccak256(toBytes('warm-pick')));
});

test('CLAIM_TYPEHASH matches the contract constant', () => {
  assert.equal(CLAIM_TYPEHASH,
    '0x243504b18c238960e8574e090cafd38c013b2a0b7903cc37a03065365efc929e');
});

test('claimKeyHex matches abi.encodePacked(player, id, day) layout', () => {
  const player = '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d';
  const idHex = rewardIdHex('streak-7');
  const key = claimKeyHex(player, idHex, 0);
  // manual layout: 20-byte address + 32-byte id + 8-byte uint64, then keccak
  const packed = '0x'
    + player.slice(2).toLowerCase()
    + idHex.slice(2)
    + (0n).toString(16).padStart(16, '0');
  assert.equal(key, keccak256(packed));
  assert.equal(key, keccak256(encodePacked(['address', 'bytes32', 'uint64'], [player, idHex, 0n])));
  // day is big-endian uint64 at the tail
  const key2 = claimKeyHex(player, idHex, 20500);
  const packed2 = '0x' + player.slice(2).toLowerCase() + idHex.slice(2)
    + (20500).toString(16).padStart(16, '0');
  assert.equal(key2, keccak256(packed2));
});

test('claimDigestHex matches abi.encode(CLAIM_TYPEHASH, player, id, day)', () => {
  const player = '0xd1Bd8e3D34B5f8ed38A56aA804A45B15a3FE848d';
  const idHex = rewardIdHex('warm-pick');
  const day = dayNumber(utcDay());
  // manual: 4 static words, each 32 bytes
  const manual = '0x'
    + CLAIM_TYPEHASH.slice(2)
    + player.slice(2).toLowerCase().padStart(64, '0')
    + idHex.slice(2)
    + day.toString(16).padStart(64, '0');
  assert.equal(claimDigestHex(player, idHex, day), keccak256(manual));
});

test('claimDayFor: daily=today, weekend=saturday, once=0', () => {
  const today = '2026-11-07'; // a Saturday
  assert.equal(claimDayFor('warm-pick', today), dayNumber(today));
  assert.equal(claimDayFor('big-dig', today), dayNumber(saturdayOf(today)));
  assert.equal(claimDayFor('big-dig', '2026-11-08'), dayNumber('2026-11-07')); // Sunday -> Sat
  assert.equal(claimDayFor('big-dig', '2026-11-09'), dayNumber('2026-11-09')); // Monday -> falls back to today
  assert.equal(claimDayFor('streak-7', today), 0);
  assert.equal(claimDayFor('first-find', today), 0);
});

test('formatReward / rewardTotal', () => {
  assert.equal(formatReward([5n, 0n, 0n, 0n, 0n]), '5 Quartz');
  assert.equal(formatReward([15n, 3n, 1n, 0n, 0n]), '15 Quartz + 3 Amber + 1 Sapphire');
  assert.equal(rewardTotal([15n, 3n, 1n, 0n, 0n]), 19n);
});

test('calldataClaimReward ABI layout: sel + id + day + 0x60 + len + sig', () => {
  const idHex = rewardIdHex('warm-pick');
  const sig = '0x' + 'ab'.repeat(65);
  const data = calldataClaimReward(idHex, 20500, sig);
  assert.equal(data.slice(0, 8), '1735867a'); // claimReward(bytes32,uint64,bytes)
  const body = data.slice(8);
  assert.equal(body.length, 64 * 7); // id + day + offset + len + sig(3 words)
  assert.equal(body.slice(0, 64), idHex.slice(2));
  assert.equal(BigInt('0x' + body.slice(64, 128)), 20500n);
  assert.equal(BigInt('0x' + body.slice(128, 192)), 0x60n); // bytes offset
  assert.equal(BigInt('0x' + body.slice(192, 256)), 65n);   // sig length
  assert.equal(body.slice(256, 256 + 130), 'ab'.repeat(65));
  assert.equal(body.slice(256 + 130), '0'.repeat(62)); // pad to 32-byte boundary
  // bad args throw with code bad-arg
  assert.throws(() => calldataClaimReward('0x1234', 0, sig), /bytes32/);
  assert.throws(() => calldataClaimReward(idHex, -1, sig), /day/);
  assert.throws(() => calldataClaimReward(idHex, 0, '0x1234'), /65-byte/);
});
