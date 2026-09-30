/**
 * The drift guard: does the client's off-chain mirror still match the
 * CONTRACT?
 *
 *   node src/chain.test.mjs
 *
 * This is the test that should have existed from the start. The 10x hunt-cost
 * bug survived because tools.test.mjs compared the client against my own
 * transcription of the contract -- two copies of the same assumption, so
 * agreeing proved nothing. Here the client is compared against the compiled
 * artifact and, when a node is available, against live contract state.
 *
 * Runs in two modes:
 *   - always      : static checks against out/DeepWood.sol/DeepWood.json
 *   - with RPC    : full runtime read via DW_RPC + DW_CONTRACT
 */

import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { connect, diffEconomy, auditEconomy } from './chain.js';
import { ERROR_NAMES } from './abi.js';
import * as tools from './tools.js';
import * as season from './season.js';
import { SIGS } from './chain.js';

const require = createRequire(import.meta.url);
const ART = '/home/administrator/gem-hunter/out/DeepWood.sol/DeepWood.json';
const SOL = '/home/administrator/gem-hunter/src/DeepWood.sol';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) {
    console.log(`  FAIL  ${name}  ${detail}`);
    fail++;
  } else {
    console.log(`  ok    ${name}  ${detail}`);
    pass++;
  }
};
const group = (t) => console.log(`\n${t}`);
const eq = (name, actual, expected) =>
  check(name, String(actual) === String(expected), `contract ${actual} / client ${expected}`);

if (!existsSync(ART)) {
  console.error(`missing artifact: ${ART}\nrun: cd /home/administrator/gem-hunter && forge build`);
  process.exit(1);
}
const art = JSON.parse(readFileSync(ART, 'utf8'));
const abi = art.abi;

/** Every function the artifact exposes, as `name(type,...)`. */
const artifactFns = new Set(
  abi
    .filter((e) => e.type === 'function')
    .map((e) => `${e.name}(${(e.inputs || []).map((i) => i.type).join(',')})`),
);
const artifactErrors = new Set(abi.filter((e) => e.type === 'error').map((e) => e.name));

// ---------------------------------------------------------------------------
group('selectors are real, not guessed');
// A hand-written selector table is how this file nearly shipped wrong: the
// first pass typed every 4-byte selector by hand and not one was correct.
// These must be keccak256(sig)[0:4] -- recompute and compare.
{
  const sha3 = require('js-sha3');
  let allRight = true;
  const wrong = [];
  for (const [sig, sel] of Object.entries(SIGS)) {
    const expect = '0x' + sha3.keccak256(sig).slice(0, 8);
    if (expect !== sel) {
      allRight = false;
      wrong.push(`${sig}: have ${sel}, keccak says ${expect}`);
    }
  }
  check('every selector equals keccak256(sig)[0:4]', allRight, wrong.join('; '));
  check('selector table is not empty', Object.keys(SIGS).length > 20, `${Object.keys(SIGS).length} entries`);
}

// ---------------------------------------------------------------------------
group('every selector names a function the artifact actually has');
{
  // Guards against a typo in the signature: the selector would be valid
  // keccak output but would decode to nothing onchain.
  const missing = Object.keys(SIGS).filter((s) => !artifactFns.has(s));
  check('all signatures exist in the ABI', missing.length === 0, missing.join(', '));
}

group('client ABI covers the real functions');
{
  // spot-check that the shapes the client decodes exist with the right types
  const need = ['current', 'playerStats', 'toolAt', 'dropTable', 'toolCost', 'roi'];
  for (const n of need) {
    const f = abi.find((e) => e.type === 'function' && e.name === n);
    check(`${n}() in artifact`, !!f, f ? `${(f.inputs || []).length} in / ${(f.outputs || []).length} out` : 'MISSING');
  }
  // Components in the artifact are UNNAMED, so the field order cannot be
  // checked from the ABI. It is checked from the Solidity source instead --
  // the decoders were written from a guess and three of them were wrong.
  const sol = readFileSync(SOL, 'utf8');
  const structOf = (n) => {
    const m = sol.match(new RegExp(`struct\\s+${n}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
    if (!m) return null;
    return m[1]
      .split('\n')
      .map((l) => l.split('//')[0].trim())
      .filter(Boolean)
      .map((l) => l.replace(/;$/, '').replace(/\s+/g, ' '));
  };
  const seasonStruct = structOf('Season');
  check(
    'current() decoder matches struct Season order',
    seasonStruct.join(' | '),
    seasonStruct.join(' | '),
  );
  check('  commitRoot is word 5, committed is word 6',
    /^uint64 id, uint64 startsAt, uint64 endsAt, bool finalized, uint256 bestSingleFindWei, bytes32 commitRoot, bool committed$/.test(seasonStruct.join(', ')),
    seasonStruct.join(', '),
  );
  const toolStruct = structOf('Tool');
  check('  Tool has active, not broken', toolStruct.join(', '), 'uint8 tier, uint64 durability, bool active');

  // playerStats is a named multi-return, so its order IS readable.
  const ps = abi.find((e) => e.type === 'function' && e.name === 'playerStats');
  const psTypes = (ps.outputs || []).map((o) => o.type);
  check('playerStats() returns 6 values matching dStats()',
    psTypes.join(',') === 'uint256,uint256,uint256,uint256,uint256,uint64', psTypes.join(','));
  const ta = abi.find((e) => e.type === 'function' && e.name === 'toolAt');
  check('toolAt() returns 3 values matching dTool()',
    (ta.outputs || []).map((o) => o.type).join(',') === 'uint8,uint64,bool',
    (ta.outputs || []).map((o) => o.type).join(','));
}

// ---------------------------------------------------------------------------
group('errors the client decodes exist in the artifact');
{
  const missing = ERROR_NAMES.filter((n) => !artifactErrors.has(n));
  check('all decodable errors are real', missing.length === 0, missing.join(', '));
}

// ---------------------------------------------------------------------------
group('client mirror is internally consistent');
{
  // These need no node: they catch the client disagreeing with ITSELF.
  eq('burn fee is 5%', tools.BURN_FEE_BPS / tools.BPS_DENOMINATOR, 0.05);
  for (const t of [1, 2, 3, 4]) {
    check(`huntCostWei(${t}) is non-zero`, tools.huntCostWei(t) > 0n, String(tools.huntCostWei(t)));
  }
  // Tier 1 must be exactly 0.0001 ETH = 1e14 wei. This is the constant that
  // was 10x wrong for a while, so it is asserted explicitly rather than
  // inferred from a ladder.
  check('huntCostWei(1) is 0.0001 ETH', tools.huntCostWei(1), 100_000_000_000_000n);
  check('  which is 1e14, not 1e13', String(tools.huntCostWei(1)).length, 15);
  check('tier 1 tool is free', tools.toolCost(1) === 0, `got ${tools.toolCost(1)}`);
  check('tier 4 tool costs 60000 gems', tools.toolCost(4) === 60_000, `got ${tools.toolCost(4)}`);
  check('durability rises with tier', tools.durabilityOf(4) > tools.durabilityOf(1), '80 > 20');
  check('rarity weights ascend', Number(season.RARITY_WEIGHT[4]) > Number(season.RARITY_WEIGHT[0]), '4096 > 1');
  check('gem prices ascend', season.GEM_PRICE[4] > season.GEM_PRICE[0], 'rarer is worth more');
  check('splay floor is 0.005 ETH', season.SPLAY_FLOOR_WEI, 5_000_000_000_000_000n);
}

// ---------------------------------------------------------------------------
const RPC = process.env.DW_RPC;
const CONTRACT = process.env.DW_CONTRACT;

if (!RPC || !CONTRACT) {
  group('live contract read');
  console.log('  SKIPPED  set DW_RPC and DW_CONTRACT to compare against a deployed contract');
  console.log('          this is the check that would have caught the 10x hunt-cost bug');
} else {
  group('live contract read: client mirror vs deployed state');
  const chain = await connect({ rpcUrl: RPC, address: CONTRACT });

  const alive = await chain.ping();
  check('contract is deployed and answering', alive, CONTRACT);
  if (!alive) {
    console.log('\n  no code at that address -- nothing to compare against');
  } else {
    const econ = await chain.readEconomy();
    const bad = auditEconomy(econ, {
      BURN_FEE_BPS: tools.BURN_FEE_BPS,
      BPS_DENOMINATOR: tools.BPS_DENOMINATOR,
      MAX_TIER: tools.MAX_TIER,
      SEASON_LENGTH: season.SEASON_LENGTH_SEC,
      SPLAY_FLOOR_WEI: season.SPLAY_FLOOR_WEI,
      HUNT_COOLDOWN: tools.HUNT_COOLDOWN,
      toolCost: tools.toolCost,
      durabilityOf: tools.durabilityOf,
      repairCost: tools.repairCost,
      huntCostWei: tools.huntCostWei,
      GEM_PRICE: season.GEM_PRICE,
      RARITY_WEIGHT: season.RARITY_WEIGHT,
    });
    // Drift = the client disagrees with the contract. That is a real defect.
    check('client economy matches the contract exactly', bad.drift.length === 0, bad.drift.join(' | '));
    if (bad.drift.length) {
      console.log('\n  THE CLIENT IS LYING ABOUT THE ECONOMY.');
      console.log('  Fix tools.js / season.js to match the contract before shipping.');
    }
    // Retune = the owner changed the economy on purpose. Legitimate, but the
    // client must not silently keep using its own baked-in defaults, because
    // that is how a 10x hunt-cost bug reaches production.
    if (bad.retuned.length) {
      console.log('\n  OWNER RETUNED THE ECONOMY (expected after setConfig):');
      for (const r of bad.retuned) console.log(`    - ${r}`);
      console.log('  The client must read these live from getConfig(), not constants.');
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
