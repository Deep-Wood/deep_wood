/**
 * Gating tests for the on-chain path.
 *
 * The property under test: a connected player never receives a local item
 * unless the contract's own state confirms it. This is not hypothetical — on
 * chain 46630 a reverted call still returns a receipt with status 0x1 (verified
 * live: a duplicate claimTool(1) returned a hash, reported a successful
 * receipt, and left toolCount unchanged at 1 -> 1). A gate on "the tx was
 * sent", or even on the receipt, would hand out a free simulated tool.
 *
 * These drive the REAL onchain.js through its __setReader seam, so the
 * polling/confirmation logic under test is the shipping code, not a restatement
 * of it. The provider is injected exactly as wallet.test.mjs does it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VITE_GAME_ADDRESS = process.env.VITE_GAME_ADDRESS || '0xCDAd67Ed7165a42a74A7324275Da11f0F9f98b8A';
process.env.VITE_RPC_URL = process.env.VITE_RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
process.env.VITE_CHAIN_ID = process.env.VITE_CHAIN_ID || '46630';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const GAME = process.env.VITE_GAME_ADDRESS;

const { connect, getState } = await import('./wallet.js');
const onchain = await import('./onchain.js');

/**
 * A provider that returns a hash for eth_sendTransaction no matter what the
 * call does — including a call that reverts. That is the real chain's
 * behaviour and the reason a send-based gate is unsafe.
 */
function fakeProvider({ reject = false } = {}) {
  return {
    isFake: true,
    async request({ method }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return '0xb626'; // 46630
      if (method === 'net_version') return '46630';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        if (reject) { const e = new Error('User rejected the request'); e.code = 4001; throw e; }
        return '0xdeadbeef'; // a hash, even when the call will revert
      }
      throw new Error(`unexpected method ${method}`);
    },
    on() {}, removeListener() {},
  };
}

async function boot(opts = {}) {
  const r = await connect({ provider: fakeProvider(opts) });
  assert.equal(r.ok, true, 'test setup: the fake wallet must connect: ' + JSON.stringify(r));
  return onchain;
}

test('onchainActive() is true once connected to the right chain', async () => {
  await boot();
  assert.equal(getState().connected, true);
  assert.equal(onchain.onchainActive(), true);
  assert.equal(onchain.mode(), 'onchain');
});

test('a purchase that reverts grants NOTHING and reports reverted', async () => {
  const oc = await boot();
  // V2 holds exactly ONE tool, so the confirmation signal is `toolOf`'s TIER,
  // not a growing count. It never moves here -- the exact shape of a reverted
  // TierLocked or Underpaid.
  oc.__setReader({ toolOf: async () => ({ tier: 1, durability: 20n, broken: false }) });

  const r = await oc.buyToolOnchain(2, 52_000_000_000_000_000n);

  assert.equal(r.ok, false, 'a broadcast the contract ignored is NOT a grant');
  assert.equal(r.code, 'reverted');
  assert.ok(!r.confirmed, 'nothing may claim confirmation');
  assert.match(r.reason, /nothing granted/i);
});

test('a purchase the contract applies is confirmed by the tier moving', async () => {
  const oc = await boot();
  let reads = 0;
  oc.__setReader({
    // First poll still tier 1, then tier 2: the purchase applied.
    toolOf: async () => { reads++; return reads < 2
      ? { tier: 1, durability: 20n, broken: false }
      : { tier: 2, durability: 25n, broken: false }; },
  });

  const r = await oc.buyToolOnchain(2, 52_000_000_000_000_000n);

  assert.equal(r.ok, true, 'a real state change is a success');
  assert.equal(r.confirmed, true);
  assert.equal(r.tier, 2);
  assert.ok(reads >= 2, 'it must poll the chain rather than trust the send');
});

test('buying the wrong tier is reported, not counted as success', async () => {
  const oc = await boot();
  // The tier MOVES (1 -> 2) so the poll predicate is satisfied and the test
  // does not sit for the full poll timeout, but it lands on 2 rather than the 3
  // that was paid for. Reporting ok here would be a lie: the player paid for
  // tier 3.
  let reads = 0;
  oc.__setReader({
    toolOf: async () => ({ tier: reads++ < 1 ? 1 : 2, durability: 25n, broken: false }),
  });

  const r = await oc.buyToolOnchain(3, 184_000_000_000_000_000n);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'wrong-tier');
});

test('a rejected signature fails closed before any grant', async () => {
  const oc = await boot({ reject: true });
  oc.__setReader({ toolOf: async () => ({ tier: 1, durability: 20n, broken: false }) });

  const r = await oc.buyToolOnchain(1, 5_000_000_000_000_000n);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rejected');
});

test('a purchase with no price is refused rather than guessed', async () => {
  const oc = await boot();
  oc.__setReader({ toolOf: async () => ({ tier: 1, durability: 20n, broken: false }) });

  // The contract reverts Underpaid(cost, msg.value) on a zero value. Guessing
  // the price here would open the wallet and only then report the failure.
  const r = await oc.buyToolOnchain(2);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad-arg');
});

test('a repair of an unbroken tool is refused before gas is spent', async () => {
  const oc = await boot();
  oc.__setReader({ toolOf: async () => ({ tier: 1, durability: 12n, broken: false }) });

  // The contract reverts NotBroken. Catching it here means the button should
  // not have been enabled at all, and if it was, no gas is wasted finding out.
  const r = await oc.repairToolOnchain();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-broken');
});

test('a repair with no tool is refused before gas is spent', async () => {
  const oc = await boot();
  oc.__setReader({ toolOf: async () => ({ tier: 0, durability: 0n, broken: false }) });

  const r = await oc.repairToolOnchain();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-tool');
});

test('a repair that reverts burns nothing', async () => {
  const oc = await boot();
  // Stays broken: the gems were not spent and the tool was not restored.
  oc.__setReader({ toolOf: async () => ({ tier: 1, durability: 0n, broken: true }) });

  const r = await oc.repairToolOnchain();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'reverted');
  assert.match(r.reason, /gems not burned/i);
});

test('a repair the contract applies is confirmed by broken going false', async () => {
  const oc = await boot();
  let reads = 0;
  oc.__setReader({
    toolOf: async () => { reads++; return reads < 2
      ? { tier: 2, durability: 0n, broken: true }
      : { tier: 2, durability: 25n, broken: false }; },
  });

  const r = await oc.repairToolOnchain();
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.durability, 25n);
});

test('a skill jump is refused before the wallet opens', async () => {
  const oc = await boot();
  oc.__setReader({ skillOf: async () => 0 });

  // The contract only accepts skill+1. Skipping a level is a revert, and the
  // player should be told before signing rather than after.
  const r = await oc.upgradeSkillOnchain(3, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'skill-not-next');
});

test('a skill purchase that reverts spends nothing', async () => {
  const oc = await boot();
  oc.__setReader({ skillOf: async () => 0 });

  const r = await oc.upgradeSkillOnchain(1, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'reverted');
  assert.match(r.reason, /gems not spent/i);
});

test('a skill purchase the contract applies is confirmed by skill rising', async () => {
  const oc = await boot();
  let reads = 0;
  oc.__setReader({ skillOf: async () => { reads++; return reads < 2 ? 0 : 1; } });

  const r = await oc.upgradeSkillOnchain(1, 0);
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.skill, 1);
});

test('a redemption below the floor is refused before signing', async () => {
  const oc = await boot();
  oc.__setReader({
    gemsOf: async () => 3n,
    // 3 Quartz cannot clear 0.005 ETH.
    redeemQuote: async () => [135_000_000_000_000n, false],
    minRedeemWei: async () => 5_000_000_000_000_000n,
  });

  const r = await oc.redeemGemsOnchain(0, 3);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'below-floor');
});

test('a redemption reports the CHAIN payout, never a locally computed one', async () => {
  const oc = await boot();
  const QUOTE = 900_000_000_000_000_000n;
  let reads = 0;
  oc.__setReader({
    // Falls from 2000 to 1000, so the poll predicate is satisfied.
    gemsOf: async () => (reads++ < 1 ? 2000n : 1000n),
    redeemQuote: async () => [QUOTE, true],
    minRedeemWei: async () => 5_000_000_000_000_000n,
  });

  const r = await oc.redeemGemsOnchain(0, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.payoutWei, QUOTE, 'the payout must be the number the contract quoted');
});

test('a redemption for more gems than you hold is refused', async () => {
  const oc = await boot();
  oc.__setReader({ gemsOf: async () => 5n });

  const r = await oc.redeemGemsOnchain(0, 10);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'insufficient-gems');
});

test('a redemption that reverts leaves the gems alone', async () => {
  const oc = await boot();
  oc.__setReader({
    gemsOf: async () => 2000n,      // never falls
    redeemQuote: async () => [900_000_000_000_000_000n, true],
    minRedeemWei: async () => 5_000_000_000_000_000n,
  });

  const r = await oc.redeemGemsOnchain(0, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'reverted');
});

test('the V1 gate functions are gone', async () => {
  // If these reappear, something is still calling the old contract.
  const oc = await import('./onchain.js');
  for (const gone of ['claimToolOnchain', 'buyGemsOnchain']) {
    assert.equal(oc[gone], undefined, `${gone} is a V1 gate and must not exist`);
  }
});
