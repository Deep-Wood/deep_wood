/**
 * Parity check: the client tool economy in src/tools.js must match
 * DeepWood.sol exactly.
 *
 * Run with: node src/tools.test.mjs
 *
 * This file is deliberately a plain node script, not a browser test. The
 * whole point is that the numbers the preview shows a player are the numbers
 * the chain will enforce. If they drift, a player sees a cost the contract
 * will reject -- and nothing in the game would surface it.
 */
import {
  toolCost, durabilityOf, repairCost, huntCostWei,
  BURN_FEE_BPS, BPS_DENOMINATOR, MAX_TIER,
  newToolbelt, claimTool, canClaim, repairTool, canRepair,
  equip, activeTool, consumeUse, ownsTier, expectedHuntWei,
} from './tools.js';
import { DROP_TABLE, PRICE } from './engine.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  ${ok ? actual : `${actual} != ${expected}`}`);
}
function group(name) { console.log(`\n${name}`); }

// ---------------------------------------------------------------------
// These literals are transcribed from src/DeepWood.sol. If the contract
// changes and these are not updated, this block fails -- which is the
// signal to go update tools.js, not to edit these numbers.
// ---------------------------------------------------------------------
group('contract constants');
check('BURN_FEE_BPS', BURN_FEE_BPS, 500);
check('BPS_DENOMINATOR', BPS_DENOMINATOR, 10_000);
check('MAX_TIER', MAX_TIER, 4);

group('toolCost (gems)');
check('tier 1 free', toolCost(1), 0);
check('tier 2', toolCost(2), 1_000);
check('tier 3', toolCost(3), 8_000);
check('tier 4', toolCost(4), 60_000);

group('durabilityOf (hunts)');
check('tier 1', durabilityOf(1), 20);
check('tier 2', durabilityOf(2), 50);
check('tier 3', durabilityOf(3), 65);
check('tier 4', durabilityOf(4), 80);

group('repairCost (gems)');
check('tier 1', repairCost(1), 50);
check('tier 2', repairCost(2), 500);
check('tier 3', repairCost(3), 5_000);
check('tier 4', repairCost(4), 40_000);

group('huntCostWei (wei)');
check('tier 1', huntCostWei(1), 100_000_000_000_000n);
check('tier 2', huntCostWei(2), 200_000_000_000_000n);
check('tier 3', huntCostWei(3), 400_000_000_000_000n);
check('tier 4', huntCostWei(4), 800_000_000_000_000n);

group('starting state');
{
  const belt = newToolbelt();
  check('one tool', belt.tools.length, 1);
  check('tier 1', belt.tools[0].tier, 1);
  check('full durability', belt.tools[0].left, 20);
  check('no gems', belt.common, 0);
  check('active tool works', !!activeTool(belt), true);
}

group('sequential gating');
{
  const belt = newToolbelt();
  // Can't jump to tier 3 without tier 2.
  check('tier 3 blocked', canClaim(belt, 3).ok, false);
  check('  reason mentions tier 2', /Tier II/.test(canClaim(belt, 3).reason), true);

  belt.common = 1_000;
  check('tier 2 claimable', canClaim(belt, 2).ok, true);
  check('claim tier 2', claimTool(belt, 2).ok, true);
  check('  now owns 2 tools', belt.tools.length, 2);
  check('  active is tier 2', belt.tools[1].active, true);
  check('  tier 1 demoted', belt.tools[0].active, false);
  check('  common spent', belt.common, 0);
  check('  fee was 5%', belt.feesPaid, 50);

  // Re-claiming an owned tier is rejected: the contract reverts
  // ToolAlreadyOwned, and without this a player gets a free durability pool.
  check('re-claim tier 2 blocked', canClaim(belt, 2).ok, false);
  check('  reason says already own', /already own/i.test(canClaim(belt, 2).reason), true);
}

group('affordability');
{
  const belt = newToolbelt();
  belt.common = 999; // one short of tier 2
  check('tier 2 unaffordable', canClaim(belt, 2).ok, false);
  // fmt() abbreviates, so the cost reads "1K" not "1000". Match the actual
  // rendering the player sees rather than the raw number.
  check('  reason names the cost', /1K/.test(canClaim(belt, 2).reason), true);
  check('  reason names what we hold', /999/.test(canClaim(belt, 2).reason), true);
}

group('breaking and repair');
{
  const belt = newToolbelt();
  for (let i = 0; i < 19; i++) consumeUse(belt);
  check('1 use left', belt.tools[0].left, 1);
  check('still active', !!activeTool(belt), true);

  const last = consumeUse(belt);
  check('20th use breaks it', last.broke, true);
  check('left is 0', belt.tools[0].left, 0);
  check('activeTool returns null', activeTool(belt), null);

  // A tool with uses left cannot be repaired (contract: NotBroken).
  check('cannot repair a working tool', canRepair(belt, 0).ok, false);

  belt.common = 50;
  const feesBefore = belt.feesPaid;
  check('repair claimable at 50', canRepair(belt, 0).ok, true);
  check('repaired', repairTool(belt, 0).ok, true);
  check('  durability restored', belt.tools[0].left, 20);
  // The repair itself: 50 * 500 / 10000 = 2.5, truncated to 2 by Solidity's
  // integer division. Assert the delta from before the repair rather than the
  // cumulative total, so an unrelated earlier fee cannot mask a regression.
  check('  repair fee was 2', belt.feesPaid - feesBefore, 2);
}

group('rotation');
{
  const belt = newToolbelt();
  belt.common = 69_000; // 1000 + 8000 + 60000
  claimTool(belt, 2); claimTool(belt, 3); claimTool(belt, 4);
  check('owns 4 tools', belt.tools.length, 4);
  check('active is tier 4', belt.tools[3].active, true);
  check('  common left', belt.common, 0); // 1000+8000+60000 = 69000

  // Switching back to a working older tool.
  check('equip tier 2', equip(belt, 1).ok, true);
  check('  active is tier 2', belt.tools[1].active, true);
  check('  tier 4 demoted', belt.tools[3].active, false);
  check('  activeTool is tier 2', activeTool(belt).tier, 2);

  // A broken tool cannot be equipped.
  belt.tools[1].left = 0;
  check('cannot equip broken', equip(belt, 1).ok, false);
  check('  activeTool still null', activeTool(belt), null);
}

group('tier is a hard cap on rarity');
{
  // Tier 1 cannot produce anything rarer than Amber. This is the whole
  // reason to upgrade, so it is asserted rather than assumed.
  check('tier 1 table', DROP_TABLE[1].join(','), '9000,1000,0,0,0');
  check('tier 2 table', DROP_TABLE[2].join(','), '7000,2500,500,0,0');
  check('tier 3 table', DROP_TABLE[3].join(','), '5500,3000,1200,300,0');
  check('tier 4 table', DROP_TABLE[4].join(','), '4000,3000,2000,900,100');
}

group('economics: does upgrading pay?');
{
  // Gem value per hunt, less the hunt cost, at each tier. A tier that does
  // not improve net EV is a trap, and the numbers should say so.
  const rows = [1, 2, 3, 4].map((t) => {
    const gross = expectedHuntWei(DROP_TABLE[t], PRICE);
    const net = gross - huntCostWei(t);
    return { t, gross, net };
  });
  for (const r of rows) {
    console.log(
      `    tier ${r.t}: gross ${(Number(r.gross) / 1e18).toFixed(5)}` +
      `  cost ${(Number(huntCostWei(r.t)) / 1e18).toFixed(5)}` +
      `  net ${(Number(r.net) / 1e18).toFixed(5)} ETH/hunt`
    );
  }
  // Net EV must strictly improve with tier, or progression is pointless.
  for (let i = 1; i < rows.length; i++) {
    check(`tier ${rows[i].t} beats tier ${rows[i - 1].t} on net EV`,
      rows[i].net > rows[i - 1].net, true);
  }
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
