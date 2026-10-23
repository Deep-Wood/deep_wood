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
  calldataMigrateFromV9,
  calldataDescend,
  calldataStudy,
  calldataFuse,
} from './wallet.js';

const ART = JSON.parse(
  readFileSync('/home/administrator/gem-hunter/out/DeepWoodV10.sol/DeepWoodV10.json', 'utf8'),
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
  'buyTool(uint8,uint256)',
  'repairTool()',
  'upgradeSkill(uint8)',
  'redeemGems(uint8,uint256)',
  'settleBatch(address,uint8,uint256[5][],uint256[])',
  'migrateFromV9()',
  'descend()',
  'study()',
  'fuse(uint8,uint8)',
]) {
  assertSelector(sig);
}

// The builders must embed the right selector, not merely agree with sel().
assert.equal(calldataBuyTool(1, 1000n).slice(0, 8), DISPATCH['buyTool(uint8,uint256)']);
assert.equal(calldataRepairTool().slice(0, 8), DISPATCH['repairTool()']);
assert.equal(calldataUpgradeSkill(2).slice(0, 8), DISPATCH['upgradeSkill(uint8)']);
assert.equal(calldataRedeemGems(1, 5).slice(0, 8), DISPATCH['redeemGems(uint8,uint256)']);
assert.equal(calldataMigrateFromV9().slice(0, 8), DISPATCH['migrateFromV9()']);
assert.equal(calldataDescend().slice(0, 8), DISPATCH['descend()']);
assert.equal(calldataStudy().slice(0, 8), DISPATCH['study()']);
assert.equal(calldataFuse(0, 1).slice(0, 8), DISPATCH['fuse(uint8,uint8)']);
checked += 8;

// V1 functions must be GONE. If any reappears, the client is aimed at the old
// contract and the mismatch will be silent until a user loses funds.
//
// `sel` THROWS on an unknown signature rather than returning undefined -- that
// is deliberate, because an undefined selector concatenates into calldata as
// the literal string "undefined" and produces a plausible-looking transaction
// to nowhere. So "must not resolve" means "must throw".
for (const gone of ['claimTool(uint8)', 'buyGems(uint8,uint256)', 'claimTool', 'buyGems',
  // settleHunt was cut from the contract in V6; the queue settles via
  // settleBatch only. A resolving selector here means a stale SIGS table.
  'settleHunt(address,uint8,uint256[5],uint256,bytes)']) {
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

// settleHunt is GONE (cut in V6): no length invariant remains. The V10
// builders are asserted above against the live artifact's dispatch table.

console.log(`ABI selector agreement: ${checked} checks against the compiled dispatch table`);
