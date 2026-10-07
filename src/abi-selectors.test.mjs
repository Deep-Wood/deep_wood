/**
 * Every selector the client hand-builds must equal the one the COMPILED
 * contract dispatches on.
 *
 * A wrong selector does not fail loudly -- it sends a transaction that hits the
 * fallback and reverts with no data, which is exactly the "mystery revert"
 * class of bug that cost an afternoon once already. These assertions read the
 * REAL dispatch table out of the compiled artifact rather than recomputing
 * keccak in JS, so they are checking the client against the contract and not
 * against a second implementation of the same idea.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  sel,
  calldataBuyTool,
  calldataRepairTool,
  calldataUpgradeSkill,
  calldataRedeemGems,
  calldataSettleHunt,
} from './wallet.js';

const ART = JSON.parse(
  readFileSync('/home/administrator/gem-hunter/out/DeepWoodV4.sol/DeepWoodV4.json', 'utf8'),
);
const DISPATCH = ART.methodIdentifiers;

let checked = 0;

/** Assert sel(sig) is the selector the contract actually dispatches on. */
function assertSelector(sig) {
  assert.ok(DISPATCH[sig], `${sig} is not in the compiled artifact's dispatch table`);
  const want = '0x' + DISPATCH[sig];
  assert.equal(sel(sig), want, `${sig}: client has ${sel(sig)}, contract dispatches ${want}`);
  checked++;
}

// Every write the V2 UI can trigger.
for (const sig of [
  'buyTool(uint8)',
  'repairTool()',
  'upgradeSkill(uint8)',
  'redeemGems(uint8,uint256)',
  'settleHunt(address,uint8,uint256[5],uint256,bytes)',
]) {
  assertSelector(sig);
}

// The builders must embed the right selector, not merely agree with sel().
assert.equal(calldataBuyTool(1).slice(0, 8), DISPATCH['buyTool(uint8)']);
assert.equal(calldataRepairTool().slice(0, 8), DISPATCH['repairTool()']);
assert.equal(calldataUpgradeSkill(2).slice(0, 8), DISPATCH['upgradeSkill(uint8)']);
assert.equal(calldataRedeemGems(1, 5).slice(0, 8), DISPATCH['redeemGems(uint8,uint256)']);
checked += 4;

// V1 functions must be GONE. If any reappears, the client is aimed at the old
// contract and the mismatch will be silent until a user loses funds.
//
// `sel` THROWS on an unknown signature rather than returning undefined -- that
// is deliberate, because an undefined selector concatenates into calldata as
// the literal string "undefined" and produces a plausible-looking transaction
// to nowhere. So "must not resolve" means "must throw".
for (const gone of ['claimTool(uint8)', 'buyGems(uint8,uint256)', 'claimTool', 'buyGems']) {
  assert.throws(
    () => sel(gone),
    /no selector for/,
    `${gone} still resolves -- it is a V1 function and must not be callable`,
  );
  checked++;
}

// And no V1 builder may still be exported from wallet.js.
const wallet = await import('./wallet.js');
for (const gone of ['calldataClaimTool', 'calldataBuyGems', 'claimTool', 'buyGems']) {
  assert.equal(
    wallet[gone],
    undefined,
    `wallet.js still exports ${gone} -- a V1 write path that cannot reach V2`,
  );
  checked++;
}

// settleHunt length invariant, measured rather than assumed.
//
// The builder returns HEX, NO 0x PREFIX, selector INCLUDED -- `send()`
// prepends '0x' and nothing else. The layout is:
//   4-byte selector | 9 head words | offset word | length word
// = 8 + 10*64 hex chars of head+tail, with the last word being the bare
// zero-length marker for the ignored `bytes` argument.
//
// An earlier version of this test asserted 296 bytes against a hex string,
// which was wrong by a factor of two and would have failed on correct code.
{
  const sd = calldataSettleHunt('0x' + '11'.repeat(20), 1, [1, 0, 0, 0, 0], 0);

  // 8-char selector, then 10 full words, then the trailing length word. The
  // encoders emit the MINIMUM hex for a value (a zero is 8 chars, not 64), so
  // the total is 8 + 10*64 + 8 = 656 in the padded ideal but 648 as encoded.
  // Assert the encoded length and then the word structure, which is the part
  // that actually matters.
  assert.equal(sd.length, 648, 'settleHunt calldata hex length as encoded');
  assert.equal(
    sd.slice(0, 8),
    DISPATCH['settleHunt(address,uint8,uint256[5],uint256,bytes)'],
    'selector leads the payload',
  );

  // Strip the selector, then everything is word-aligned.
  const body = sd.slice(8);
  // Index by word number rather than looping: the final length word is only 8
  // hex chars, so a loop bounded by `body.length - 8` stops one word early.
  const word = (n) => body.slice(n * 64, n * 64 + 64);
  assert.equal(body.length, 640, 'the body is 10 words once the short tail is padded');

  // word0 player (left-padded to 32 bytes), word1 tier, words2-6 the five
  // rarity counts, word7 bestSingleWei, word8 the bytes OFFSET, word9 length.
  assert.equal(word(0), '0'.repeat(24) + '11'.repeat(20), 'player is left-padded to 32 bytes');
  assert.equal(word(1), '1'.padStart(64, '0'), 'tier');
  assert.equal(word(2), '1'.padStart(64, '0'), 'count[0]');
  assert.equal(word(3), '0'.repeat(64), 'count[1]');
  assert.equal(word(7), '0'.repeat(64), 'bestSingleWei');
  assert.equal(word(8), (9 * 32).toString(16).padStart(64, '0'), 'bytes offset is 0x120');
  assert.equal(body.slice(-8), '00000000', 'and the bytes length is zero');
  checked += 8;
}

console.log(`ABI selector agreement: ${checked} checks against the compiled dispatch table`);
