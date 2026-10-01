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

test('a claim that reverts grants NOTHING and reports reverted', async () => {
  const oc = await boot();
  // The contract already holds one tool and this claim does not apply, so the
  // count never moves — the exact shape of a reverted ToolAlreadyOwned.
  oc.__setReader({ toolCount: async () => 1, gemsOf: async () => 0n });

  const r = await oc.claimToolOnchain(1);

  assert.equal(r.ok, false, 'a broadcast the contract ignored is NOT a grant');
  assert.equal(r.code, 'reverted');
  assert.ok(!r.confirmed, 'nothing may claim confirmation');
  assert.match(r.reason, /nothing granted/i);
});

test('a claim the contract applies is confirmed by the count moving', async () => {
  const oc = await boot();
  let reads = 0;
  oc.__setReader({
    // First poll still 1, then 2: the claim applied.
    toolCount: async () => { reads++; return reads < 2 ? 1 : 2; },
    gemsOf: async () => 0n,
  });

  const r = await oc.claimToolOnchain(2);

  assert.equal(r.ok, true, 'a real state change is a success');
  assert.equal(r.confirmed, true);
  assert.equal(Number(r.count), 2);
  assert.ok(reads >= 2, 'it must poll the chain rather than trust the send');
});

test('a rejected signature fails closed before any grant', async () => {
  const oc = await boot({ reject: true });
  oc.__setReader({ toolCount: async () => 1, gemsOf: async () => 0n });

  const r = await oc.claimToolOnchain(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rejected');
});

test('a reverted purchase credits nothing', async () => {
  const oc = await boot();
  // gemsOf never rises -> the purchase did not apply.
  oc.__setReader({ toolCount: async () => 1, gemsOf: async () => 0n, priceOf: async () => 50000000000000n });

  const r = await oc.buyGemsOnchain(0, 1, 50000000000000n);
  assert.equal(r.ok, false, 'a broadcast the contract ignored credits nothing');
  assert.equal(r.code, 'reverted');
});

test('a confirmed purchase is credited only after gemsOf rises', async () => {
  const oc = await boot();
  let reads = 0;
  oc.__setReader({
    toolCount: async () => 1,
    gemsOf: async () => { reads++; return reads < 2 ? 0n : 1n; },
    priceOf: async () => 50000000000000n,
  });

  const r = await oc.buyGemsOnchain(0, 1, 50000000000000n);
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.spentWei, 50000000000000n, 'the exact chain price is sent, not a guess');
});

test('Rare+ is refused because the contract reverts RarityNotForSale', async () => {
  const oc = await boot();
  oc.__setReader({ toolCount: async () => 0, gemsOf: async () => 0n, priceOf: async () => 1n });

  for (const rarity of [2, 3, 4]) {
    const r = await oc.buyGemsOnchain(rarity, 1, 1n);
    assert.equal(r.ok, false, `rarity ${rarity} must be refused`);
    assert.equal(r.code, 'not-for-sale');
  }
});

test('a missing chain price is refused rather than guessed', async () => {
  const oc = await boot();
  oc.__setReader({ toolCount: async () => 0, gemsOf: async () => 0n, priceOf: async () => 1n });

  const r = await oc.buyGemsOnchain(0, 1, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad-arg');
  assert.match(r.reason, /priceWei is required/);
});

test('a non-positive count is refused', async () => {
  const oc = await boot();
  oc.__setReader({ toolCount: async () => 0, gemsOf: async () => 0n, priceOf: async () => 1n });

  for (const bad of [0, -1, 1.5]) {
    const r = await oc.buyGemsOnchain(0, bad, 1n);
    assert.equal(r.ok, false, `count ${bad} must be refused`);
  }
});

test('only Common and Uncommon are for sale, and the game address is real', async () => {
  await boot();
  assert.deepEqual(onchain.FOR_SALE, [0, 1]);
  assert.equal(onchain.mode() === 'onchain' && GAME.startsWith('0x'), true);
});
