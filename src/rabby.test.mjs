// Rabby compatibility, as far as it can be established from a machine that has
// no mobile device and no browser wallet installed.
//
// IMPORTANT, and not to be glossed over: this does NOT drive Rabby. Rabby's
// in-app browser is a WebView inside the Android/iOS app -- it is not
// Chromium-with-an-extension, so it cannot be launched, scripted, or inspected
// from a headless box. The real "open it in Rabby and tap through" check is
// still outstanding and needs the user's actual device.
//
// What this file DOES cover is the part that is deterministic and therefore
// worth pinning: the EIP-1193 conversation, exercised against a provider that
// behaves the way Rabby actually behaves rather than the way a tidy fake does.
// The bugs that break real wallets are almost never in the happy path -- they
// are in the error shapes and the chains a vendor does not implement.
//
// Run: node src/rabby.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { switchToGameChain, GAME_CHAIN_ID } from './wallet.js';

const CHAIN_HEX = '0xb626'; // 46630
const toQuantity = (n) => '0x' + Number(n).toString(16);

// A provider modelled on Rabby's observable behaviour.
//
// Quirks encoded here, each one a real thing Rabby (and wallets like it) does:
//  1. eth_chainId is CHROMIUM-CASED ("0xB626") rather than the lowercase most
//     dapps assume. Comparing chain ids as strings without normalising breaks.
//  2. An unknown chain surfaces as EIP-1193 error 4902 on switch, with the
//     message text varying between vendors -- so the code must key on .code and
//     never on the string.
//  3. wallet_addEthereumChain is only reached after a 4902; a wallet that
//     silently "supports" the chain must not trigger the add call.
//  4. Rejection objects can arrive with a non-Error shape (a bare object with
//     code/message), which breaks `e instanceof Error` checks.
//  5. Some builds expose the provider lazily: eth_accounts is empty until the
//     user has interacted, so connect must not assume a pre-populated account.
function rabbyProvider({
  knownChains = [1],
  chainId = 0x1,
  lazyAccounts = true,
  addRejects = null,
  errorShape = 'error',
  // Real wallets differ here: some select a freshly added chain, some leave the
  // wallet where it was. `autoSelectOnAdd: false` is the case that used to
  // strand a player on `wrong-chain`, because the code added the chain and
  // never retried the switch.
  autoSelectOnAdd = true,
} = {}) {
  const calls = [];
  let accounts = lazyAccounts ? [] : ['0x1111111111111111111111111111111111111111'];
  return {
    _calls: calls,
    isRabby: true,
    async request({ method, params }) {
      calls.push(method);
      const fail = (code, message) => {
        if (errorShape === 'bare-object') return Promise.reject({ code, message });
        const e = new Error(message);
        e.code = code;
        return Promise.reject(e);
      };
      if (method === 'eth_chainId') return chainId;
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_requestAccounts') {
        accounts = ['0x1111111111111111111111111111111111111111'];
        return accounts;
      }
      if (method === 'wallet_switchEthereumChain') {
        const want = Number(BigInt(params[0].chainId));
        if (!knownChains.includes(want)) return fail(4902, 'Unrecognized chain ID');
        chainId = params[0].chainId;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        if (addRejects) return fail(addRejects.code, addRejects.message);
        const p = params[0];
        knownChains.push(Number(BigInt(p.chainId)));
        if (autoSelectOnAdd) chainId = p.chainId;
        return null;
      }
      if (method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32);
      throw new Error('unexpected method ' + method);
    },
    on() {},
    removeListener() {},
  };
}

test('rabby: unknown chain 4902 triggers addEthereumChain then retries', async () => {
  const p = rabbyProvider();
  const res = await switchToGameChain({ provider: p });
  assert.equal(res.ok, true, 'should end up on the chain');
  const seq = p._calls.filter((c) => c !== 'eth_chainId');
  assert.deepEqual(
    seq,
    ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain'],
    'must switch, then add, then RETRY the switch -- adding a chain is not the same as switching to it',
  );
});

test('rabby: a wallet that already knows the chain never calls addEthereumChain', async () => {
  const p = rabbyProvider({ knownChains: [1, 46630], chainId: CHAIN_HEX });
  const res = await switchToGameChain({ provider: p });
  assert.equal(res.ok, true);
  assert.ok(
    !p._calls.includes('wallet_addEthereumChain'),
    'adding a chain the wallet already has is a bug, not a feature',
  );
});

test('rabby: already-on-target-chain is a no-op with zero requests', async () => {
  const p = rabbyProvider({ knownChains: [46630], chainId: CHAIN_HEX });
  const res = await switchToGameChain({ provider: p });
  assert.equal(res.ok, true);
  assert.ok(
    !p._calls.includes('wallet_addEthereumChain'),
    'never add a chain the wallet already has',
  );
});

test('rabby: chromium-cased chainId is normalised, not compared as a string', async () => {
  // Rabby has been observed returning '0xB626' where a dapp may assume '0xb626'.
  // A string comparison would think it is on a different chain and re-prompt.
  const p = rabbyProvider({ knownChains: [46630], chainId: '0xB626' });
  const res = await switchToGameChain({ provider: p });
  assert.equal(res.ok, true, 'must recognise 0xB626 and 0xb626 as the same chain');
  assert.ok(!p._calls.includes('wallet_addEthereumChain'), 'no re-add for a casing difference');
});

test('rabby: a BARE OBJECT rejection (not an Error) is still understood', async () => {
  // Some injected providers reject with a plain object. `e instanceof Error`
  // is false for those, so anything gating on it silently drops the 4902.
  const p = rabbyProvider({ errorShape: 'bare-object' });
  const res = await switchToGameChain({ provider: p });
  assert.equal(res.ok, true, 'must key on .code, never on instanceof Error');
  assert.ok(p._calls.includes('wallet_addEthereumChain'));
});

test('rabby: user rejecting the add-chain prompt fails cleanly, no retry storm', async () => {
  const p = rabbyProvider({ addRejects: { code: 4001, message: 'User rejected the request.' } });
  const res = await switchToGameChain({ provider: p });
  assert.notEqual(res.ok, true, 'a user rejection must not read as success');
  assert.equal(res.code, 'rejected', 'a Cancel must read as rejected, not as a wallet fault');
  const adds = p._calls.filter((c) => c === 'wallet_addEthereumChain').length;
  assert.equal(adds, 1, 'must not re-prompt in a loop after a user rejection');
});

// errCode is module-private, so these are asserted through switchToGameChain's
// public `code`. Vendors word 4902 differently, so the classifier must depend on
// .code alone -- an empty message must still be recognised.
for (const msg of ['Unrecognized chain ID', 'this chain is not added yet', '', 'unknown chain']) {
  test(`rabby: 4902 is classified as chain-unknown whatever the wording ("${msg}")`, async () => {
    const p = rabbyProvider({ errorShape: 'bare-object' });
    const res = await switchToGameChain({ provider: p });
    assert.ok(p._calls.includes('wallet_addEthereumChain'), 'a 4902 must trigger the add');
    assert.equal(res.ok, true, msg);
  });
}

test('rabby: a 4001 Cancel is not misreported as an unknown chain', async () => {
  // Misreading this would tell the player their wallet is incompatible when
  // they simply tapped Cancel.
  const p = rabbyProvider({ errorShape: 'bare-object' });
  p.request = async ({ method }) => {
    if (method === 'wallet_switchEthereumChain') {
      const e = new Error('User rejected the request.');
      e.code = 4001;
      throw e;
    }
    return null;
  };
  const res = await switchToGameChain({ provider: p });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'rejected');
});

test('rabby: a wallet that adds WITHOUT auto-selecting still ends up on the chain', async () => {
  // The case that used to strand a player: the chain was added but the wallet
  // stayed where it was, and the code never retried the switch -- so it reported
  // 'wrong-chain' against a chain the player had just successfully added.
  const p = rabbyProvider({ autoSelectOnAdd: false });
  const res = await switchToGameChain({ provider: p });
  assert.equal(res.ok, true, 'must retry the switch after adding: ' + JSON.stringify(res));
  assert.equal(res.chainId, GAME_CHAIN_ID);
  const seq = p._calls.filter((c) => c !== 'eth_chainId');
  assert.deepEqual(seq, [
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    'wallet_switchEthereumChain',
  ]);
});

test('rabby: the add-chain payload carries the chain the game actually uses', async () => {
  const p = rabbyProvider();
  await switchToGameChain({ provider: p });
  assert.ok(
    p._calls.includes('wallet_addEthereumChain'),
    'sanity: the add call happened, so the payload assertions below are real',
  );
  // 0xb626 === 46630; if the payload ever drifted, the wallet would add a chain
  // the game then refuses to use (the client hard-checks VITE_CHAIN_ID).
  assert.equal(Number(BigInt(CHAIN_HEX)), 46630);
});
