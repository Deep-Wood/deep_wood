/**
 * wallet.test.mjs -- pure logic for the wallet module. No real wallet needed.
 *
 * Covers what can be wrong without a browser: calldata encoding (decoded back
 * and compared against the COMPILED artifact, not against a hand-typed
 * selector), argument validation, chain-id comparison, the no-provider path,
 * and the refusal to call a wrong-chain wallet "connected".
 *
 * Runs in two modes, same idea as live.test.mjs:
 *   - always   : encoding / validation / no-provider (this file)
 *   - with RPC : live.txt is the live half and skips when unconfigured
 *
 * The selectors here are DERIVED with keccak256 over the artifact ABI, the
 * same way scripts/gen-selectors.mjs derives the table wallet.js reads. If the
 * artifact is missing this file skips that group rather than failing -- an
 * offline checkout has no artifacts, and a selector check that silently
 * "passes" because it compared nothing would be worse than skipping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Same reason live.test.mjs does this: Vite loads .env.* into import.meta.env
// at BUILD time, but plain `node` does not, so config.gameAddress would be
// empty and every send-path test would skip. Load them here so the payable
// path is actually exercised.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['.env.local', '.env.production', '.env']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

// DYNAMIC imports, and the reason matters: a static `import` is hoisted above
// every statement in this file, so config.js would evaluate BEFORE the
// .env loader above ran, see an empty environment, and leave gameAddress
// blank. Every send-path test then "skipped" -- and a guard that skips cannot
// fail, which is exactly how the double-`0x` data bug survived injection:
// the test that was supposed to catch it never ran.
//
// live.test.mjs avoids this with the same `await import()` shape.
const {
  WalletError, GAME_CHAIN_ID, sel, encUint8, encUint256, encAddress,
  toQuantity, fromQuantity, checkTier, checkBuy,
  calldataClaimTool, calldataBuyGems, calldataSettleHunt, decodeHeader,
  connect, claimTool, buyGems, getState, getAccount, getChainId,
  resetWallet, installListeners,
} = await import('./wallet.js');
const { GEM_PRICE } = await import('./season.js');
const { config } = await import('./config.js');

const require = createRequire(import.meta.url);
const ART = '/home/administrator/gem-hunter/out/DeepWood.sol/DeepWood.json';

const skip = (why) => console.log(`  skip  ${why}`);

// Node has no window, which is exactly the "no provider installed" case the
// UI has to survive -- so the default state here is already the real one.

test.afterEach(() => resetWallet());

// ---------------------------------------------------------------------------
test('chain facts', async (t) => {
  assert.equal(GAME_CHAIN_ID, 46630, 'game chain id');
  await t.test('quantity round-trips', () => {
    // DERIVED, not restated: the first draft of this line hardcoded '0xb63a'
    // and it was wrong (46630 is 0xb626). A hand-typed hex constant is the
    // same class of error as a hand-typed selector.
    assert.equal(BigInt(toQuantity(46630)), 46630n, 'decimal survives the conversion');
    assert.equal(fromQuantity(toQuantity(46630)), 46630, 'and back again');
    assert.equal(toQuantity(46630), '0xb626', 'the literal, now verified against the RPC');
    assert.equal(fromQuantity(toQuantity(1)), 1);
    // A chain id far beyond uint64 does not throw -- it just loses precision,
    // which is safe because a mismatch is the outcome either way.
    assert.ok(Number.isFinite(fromQuantity('0x' + 'f'.repeat(64))), 'huge id does not throw');
    assert.equal(fromQuantity('0x0'), 0);
    assert.equal(fromQuantity('0x1'), 1);
  });
  await t.test('a garbage chain id is a named error, not NaN', () => {
    assert.throws(() => fromQuantity(null), WalletError);
    assert.throws(() => fromQuantity(undefined), /no chain id/);
  });
});

// ---------------------------------------------------------------------------
// Selectors: derived from the artifact, compared to the table wallet.js uses.
// ---------------------------------------------------------------------------
test('selectors match the compiled artifact', async (t) => {
  if (!fs.existsSync(ART)) return skip(`no artifact at ${ART}`);
  const { keccak256 } = require('js-sha3');
  const abi = JSON.parse(fs.readFileSync(ART, 'utf8')).abi;

  const want = (name) => {
    const f = abi.find((e) => e.type === 'function' && e.name === name);
    assert.ok(f, `artifact has no ${name}`);
    const sig = `${name}(${f.inputs.map((i) => i.type).join(',')})`;
    return { sig, selector: '0x' + keccak256(sig).slice(0, 8) };
  };

  await t.test('claimTool(uint8)', () => {
    const { sig, selector } = want('claimTool');
    assert.equal(sig, 'claimTool(uint8)');
    assert.equal(selector, '0xcbc15b3a', 'derived selector');
    assert.equal(sel('claimTool(uint8)'), selector, 'table entry wallet.js reads');
    assert.equal(decodeHeader(calldataClaimTool(1)), selector, 'calldata header');
  });

  await t.test('buyGems(uint8,uint256)', () => {
    const { sig, selector } = want('buyGems');
    assert.equal(sig, 'buyGems(uint8,uint256)');
    assert.equal(selector, '0xaf6520db', 'derived selector');
    assert.equal(sel('buyGems(uint8,uint256)'), selector, 'table entry wallet.js reads');
    assert.equal(decodeHeader(calldataBuyGems(0, 1)), selector, 'calldata header');
  });

  await t.test('the artifact signatures are the ones we encode for', async () => {
    const abiSigs = abi
      .filter((e) => e.type === 'function')
      .map((e) => `${e.name}(${e.inputs.map((i) => i.type).join(',')})`);
    for (const s of ['claimTool(uint8)', 'buyGems(uint8,uint256)']) {
      assert.ok(abiSigs.includes(s), `${s} must exist in the ABI`);
    }
  });

  await t.test('buyGems is payable and claimTool is not', () => {
    const m = (n) => abi.find((e) => e.type === 'function' && e.name === n);
    assert.equal(m('buyGems').stateMutability, 'payable');
    assert.equal(m('claimTool').stateMutability, 'nonpayable');
  });
});

// ---------------------------------------------------------------------------
// Encoding: decode the calldata BACK and check the words.
// ---------------------------------------------------------------------------
test('calldata encodes claimTool correctly', () => {
  // A hand-typed selector is how this file nearly shipped wrong, so the
  // assertion is on the DECODED bytes, not on a copied constant.
  for (const tier of [1, 2, 3, 4]) {
    const data = calldataClaimTool(tier);
    // 4-byte selector + one 32-byte word == 8 + 64 hex chars.
    assert.equal(data.length, 8 + 64, `claimTool(${tier}) is 4+32 bytes`);
    assert.match(data, /^[0-9a-f]+$/, 'bare hex, exactly one 0x at most');
    assert.ok(!data.startsWith('0x'), 'calldata must not carry a 0x prefix');
    const head = '0x' + data.slice(0, 8);
    const word = data.slice(8);
    assert.equal(head, sel('claimTool(uint8)'));
    assert.equal(head, decodeHeader(data));
    assert.match(word, /^[0-9a-f]{64}$/);
    // Left-padded: a uint8 argument occupies the LAST byte.
    assert.equal(BigInt('0x' + word), BigInt(tier), `tier ${tier}`);
    assert.equal(word.slice(0, 62), '0'.repeat(62), 'padding must be zero, not absent');
  }
  assert.equal(BigInt('0x' + calldataClaimTool(4).slice(8)), 4n);
});

test('calldata encodes buyGems correctly', () => {
  const cases = [
    [0, 1n],
    [1, 1n],
    [0, 10n],
    [1, 4_294_967_296n],               // > 2^32
    [0, (1n << 256n) - 1n],            // max uint256
  ];
  for (const [rarity, count] of cases) {
    const data = calldataBuyGems(rarity, count);
    assert.equal(data.length, 8 + 64 + 64, `buyGems(${rarity},${count}) is 4+32+32 bytes`);
    assert.equal('0x' + data.slice(0, 8), sel('buyGems(uint8,uint256)'));
    assert.equal(decodeHeader(data), sel('buyGems(uint8,uint256)'));
    const rWord = data.slice(8, 8 + 64);
    const cWord = data.slice(8 + 64);
    assert.equal(BigInt('0x' + rWord), BigInt(rarity), `rarity ${rarity}`);
    assert.equal(BigInt('0x' + cWord), count, `count ${count}`);
    assert.match(cWord, /^[0-9a-f]{64}$/);
  }
  // Distinct selectors: if these two collided, one function's calldata would
  // be the other's and the test above would pass for the wrong reason.
  assert.notEqual(sel('claimTool(uint8)'), sel('buyGems(uint8,uint256)'));
  assert.notEqual(calldataClaimTool(1).slice(10), calldataBuyGems(1, 1).slice(10));
});

test('payable value is NOT in the calldata', () => {
  // value travels in the tx envelope. A buyGems call whose "value" appeared
  // as a third word would be 4+32+32+32 bytes and would not decode.
  assert.equal(calldataBuyGems(0, 1).length, 8 + 64 + 64);
});

test('encoders', () => {
  assert.equal(encUint8(0), '0'.repeat(64));
  assert.equal(encUint8(255), '0'.repeat(62) + 'ff');
  assert.equal(encUint256(0n), '0'.repeat(64));
  assert.equal(encUint256(1n), '0'.repeat(63) + '1');
  assert.equal(
    encAddress('0xCDAd67Ed7165a42a74A7324275Da11f0F9f98b8A'),
    '0'.repeat(24) + 'cdad67ed7165a42a74a7324275da11f0f9f98b8a',
  );
  assert.throws(() => encUint8(256), /uint8 range/);
  assert.throws(() => encUint8(-1), /uint8 range/);
  assert.throws(() => encUint8('abc'), WalletError);
  assert.throws(() => encAddress('0x1234'), /not an address/);
  assert.throws(() => sel('claimTool(uint256)'), /no selector/);
});

// ---------------------------------------------------------------------------
// Argument validation: the client must not offer what the chain will revert.
// ---------------------------------------------------------------------------
test('claimTool tier validation mirrors ToolOutOfRange', () => {
  for (const t of [1, 2, 3, 4]) assert.equal(checkTier(t), t);
  // claimTool(uint8): `if (tier == 0 || tier > 4) revert ToolOutOfRange();`
  for (const t of [0, 5, -1, 255, 1.5, null, undefined, NaN]) {
    assert.throws(() => calldataClaimTool(t), /tier must be/, `tier ${String(t)}`);
  }
  // A numeric STRING is rejected rather than coerced: Number('2') === 2, so
  // accepting it would let a mistyped call site reach the chain looking right.
  assert.throws(() => calldataClaimTool('2'), /tier must be an integer/, "string '2'");
  assert.throws(() => calldataClaimTool(2n), /tier must be an integer/, 'bigint 2n');
  // The error names the rule, so a UI can show the reason.
  assert.throws(() => calldataClaimTool(5), /1\.\.4/);
});

test('buyGems validation mirrors ZeroAmount and RarityNotForSale', () => {
  assert.deepEqual(checkBuy(0, 3), { rarity: 0, count: 3n });
  assert.deepEqual(checkBuy(1, 1), { rarity: 1, count: 1n });
  // `if (rarity > Rarity.Uncommon) revert RarityNotForSale();`
  for (const r of [2, 3, 4, -1, 1.5, '1', null]) {
    assert.throws(() => calldataBuyGems(r, 1), /rarity must be 0/, `rarity ${r}`);
  }
  // `if (count == 0) revert ZeroAmount();`
  for (const c of [0, 0n, -1]) {
    assert.throws(() => calldataBuyGems(0, c), /count must be > 0/, `count ${c}`);
  }
  // uint256 bound on count.
  assert.throws(() => calldataBuyGems(0, 1n << 256n), /uint256 range/);
});

test('a rejected argument never becomes calldata', () => {
  const before = calldataBuyGems(0, 1);
  assert.throws(() => calldataBuyGems(9, 1), WalletError);
  assert.throws(() => calldataClaimTool(0), WalletError);
  // ...and the module is not left half-initialised by a throw.
  assert.equal(calldataBuyGems(0, 1), before);
});

// ---------------------------------------------------------------------------
// No-provider path. Node has no window, so this is the real default.
// ---------------------------------------------------------------------------
test('no provider installed', async (t) => {
  await t.test('connect reports it instead of throwing', async () => {
    const r = await connect();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-provider');
    assert.match(r.reason, /EIP-1193/);
  });

  await t.test('state is disconnected, not half-connected', () => {
    assert.equal(getAccount(), null);
    assert.equal(getChainId(), null);
    const s = getState();
    assert.equal(s.connected, false);
    assert.equal(s.account, null);
    assert.equal(s.reason, 'not-connected');
  });

  await t.test('writes refuse with a typed result, never an exception', async () => {
    for (const r of [
      await claimTool(1),
      await buyGems(0, 1, { valueWei: 50000000000000n }),
    ]) {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'no-provider');
    }
  });

  await t.test('installListeners on nothing is a no-op, not a crash', () => {
    assert.equal(installListeners(null), false);
  });

  await t.test('a bogus window.ethereum is still "no provider"', async () => {
    globalThis.window = { ethereum: {} };
    try {
      const r = await connect();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'no-provider');
    } finally {
      delete globalThis.window;
    }
  });
});

// ---------------------------------------------------------------------------
// Wrong chain must never read as connected. Uses an injected fake provider.
// ---------------------------------------------------------------------------
function fakeProvider({ accounts = ['0x1111111111111111111111111111111111111111'], chainId = 46630, fail } = {}) {
  const handlers = {};
  return {
    _handlers: handlers,
    isFake: true,
    async request({ method, params }) {
      if (fail && fail[method]) throw fail[method];
      if (method === 'eth_requestAccounts') return accounts;
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_chainId') return toQuantity(chainId);
      if (method === 'wallet_switchEthereumChain') {
        chainId = Number(BigInt(params[0].chainId));
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        chainId = Number(BigInt(params[0].chainId));
        return null;
      }
      if (method === 'eth_sendTransaction') return '0xdeadbeef';
      throw new Error(`unexpected method ${method}`);
    },
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    emit(ev, arg) { (handlers[ev] || []).forEach((f) => f(arg)); },
  };
}

test('connect on the wrong chain is NOT connected', async () => {
  const p = fakeProvider({ chainId: 1 });
  const r = await connect({ provider: p });
  assert.equal(r.ok, false, 'a wrong-chain wallet must not report ok');
  assert.equal(r.code, 'wrong-chain');
  assert.match(r.reason, /chain 1, game is on 46630/);
  assert.equal(getState().connected, false);
  assert.equal(getState().rightChain, false);
  assert.equal(getAccount(), '0x1111111111111111111111111111111111111111', 'account is still known');
  // ...and writes are refused on exactly the same rule.
  const w = await claimTool(1);
  assert.equal(w.ok, false);
  assert.equal(w.code, 'wrong-chain');
});

test('connect on the right chain is connected', async () => {
  const r = await connect({ provider: fakeProvider({ chainId: 46630 }) });
  assert.equal(r.ok, true);
  assert.equal(getState().connected, true);
  assert.equal(getState().rightChain, true);
  assert.equal(getState().reason, null);
});

test('a rejected connection is reported, not thrown', async () => {
  const err = Object.assign(new Error('User rejected the request.'), { code: 4001 });
  const r = await connect({ provider: fakeProvider({ fail: { eth_requestAccounts: err } }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rejected');
  assert.match(r.reason, /rejected/);
});

test('a wallet with no accounts is not connected', async () => {
  const r = await connect({ provider: fakeProvider({ accounts: [] }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-accounts');
  assert.equal(getState().connected, false);
});

test('provider events move the state', async () => {
  const p = fakeProvider();
  await connect({ provider: p });
  const seen = [];
  const off = (await import('./wallet.js')).onWallet((s) => seen.push(`${s.event}:${s.chainId ?? '-'}`));

  p.emit('accountsChanged', ['0x2222222222222222222222222222222222222222']);
  assert.equal(getAccount(), '0x2222222222222222222222222222222222222222');
  p.emit('chainChanged', toQuantity(1));
  assert.equal(getState().connected, false, 'chainChanged to a wrong chain disconnects');
  p.emit('chainChanged', toQuantity(46630));
  assert.equal(getState().connected, true);
  p.emit('disconnect', {});
  assert.equal(getState().connected, false);

  assert.ok(seen.length >= 4, `listeners fired (${seen.join(',')})`);
  off();
  const n = seen.length;
  p.emit('accountsChanged', ['0x3333333333333333333333333333333333333333']);
  assert.equal(seen.length, n, 'unsubscribe works');
});

test('a throwing listener does not break the others', async () => {
  const { onWallet } = await import('./wallet.js');
  const p = fakeProvider();
  await connect({ provider: p });
  const ok = [];
  onWallet(() => { throw new Error('boom'); });
  onWallet(() => ok.push('ran'));
  p.emit('accountsChanged', ['0x4444444444444444444444444444444444444444']);
  assert.deepEqual(ok, ['ran']);
});

// ---------------------------------------------------------------------------
// Payable write path, through an injected fake.
// ---------------------------------------------------------------------------
test('buyGems needs a value; the contract would revert without one', async () => {
  const p = fakeProvider();
  await connect({ provider: p });
  const r = await buyGems(0, 1);
  assert.equal(r.ok, false);
  assert.match(r.code, /bad-arg/);
  assert.match(r.reason, /payable/);
});

test('buyGems underpayment is refused before the wallet opens', async () => {
  const p = fakeProvider();
  await connect({ provider: p });
  // Take the price from the client mirror, not a hand-typed literal: season.js
  // GEM_PRICE is the same number the contract's priceOf() returns, and
  // chain.test.mjs pins the two together. Restating the digit here would be a
  // second copy to drift.
  const price = GEM_PRICE[0];
  assert.equal(price, 50_000_000_000_000n, 'mirror price for rarity 0');

  const under = await buyGems(0, 1, { valueWei: price - 1n, priceWei: price });
  assert.equal(under.ok, false);
  assert.equal(under.code, 'zero-amount');
  assert.match(under.reason, /below the/);

  // Underpaying a BATCH must scale, not compare against a single gem.
  const batchUnder = await buyGems(0, 3, { valueWei: price * 3n - 1n, priceWei: price });
  assert.equal(batchUnder.ok, false, '3 gems cost 3x, so 3x-1 is short');
  assert.equal(batchUnder.code, 'zero-amount');

  // Surplus is ALLOWED: the contract only requires msg.value >= cost and the
  // surplus stays as backing, so over-paying must never be refused client-side.
  const over = await buyGems(0, 1, { valueWei: price * 2n, priceWei: price });
  if (!over.ok) {
    assert.equal(over.code, 'not-configured',
      'surplus was only ever blocked by the missing address, never by the value: ' + JSON.stringify(over));
  }
});

test('without priceWei the client defers to the chain, it does not guess', async () => {
  // The client mirror can be stale, so a missing price must not become a
  // fabricated one. buyGems only preflights what it was told.
  const p = fakeProvider();
  await connect({ provider: p });
  const r = await buyGems(0, 1, { valueWei: 0n });
  if (!config.gameAddress) {
    assert.equal(r.code, 'not-configured', 'no value error invented without a price');
  } else {
    assert.equal(r.ok, true, 'the chain decides, not the client: ' + JSON.stringify(r));
  }
});

test('the exact-cost buyGems sends a well-formed transaction', async () => {
  const p = fakeProvider();
  await connect({ provider: p });
  if (!config.gameAddress) return skip('GAME_ADDRESS not set - no contract to send to');
  const price = 50000000000000n;
  const r = await buyGems(0, 1, { valueWei: price, priceWei: price });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.hash, '0xdeadbeef');
  assert.equal(r.tx.value, toQuantity(price), 'value must be a hex quantity');
  assert.equal(r.tx.from, '0x1111111111111111111111111111111111111111');
  assert.equal(r.tx.to, config.gameAddress);
  // Exactly ONE 0x -- the double-prefix bug this suite was written to catch.
  assert.equal(r.tx.data, '0x' + calldataBuyGems(0, 1));
  assert.ok(!/^0x0x/.test(r.tx.data), 'data must not be double-prefixed');
  assert.match(r.tx.data, /^0x[0-9a-f]{136}$/, 'selector + 2 words');
});

test('a write with no configured address refuses rather than sending', async () => {
  const p = fakeProvider();
  await connect({ provider: p });
  if (config.gameAddress) return skip('a game address IS configured here');
  const r = await claimTool(1);
  assert.equal(r.ok, false);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-configured');
});

test('a bad argument beats a missing wallet', async () => {
  // Validation happens first, so the message names the real problem rather
  // than blaming the wallet for a tier that could never be sent.
  const r = await claimTool(9);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'tier-out-of-range');
});

test('a rejected signature is reported, not thrown', async () => {
  const err = Object.assign(new Error('User rejected.'), { code: 4001 });
  const p = fakeProvider({ fail: { eth_sendTransaction: err } });
  await connect({ provider: p });
  if (!config.gameAddress) return skip('no contract address to send to in this checkout');
  const r = await claimTool(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rejected');
});

// ---------------------------------------------------------------------------
// The hard constraint: no key material anywhere in the client.
// ---------------------------------------------------------------------------
test('no signing key is read anywhere in the client', async (t) => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.dirname(dir);
  // Every shipped client source. wallet.test.mjs is EXCLUDED: it holds these
  // regex literals by definition, and a guard that matches itself is a guard
  // that reports its own source and gets ignored.
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(js|mjs)$/.test(f) && !/\.test\.mjs$/.test(f))
    .map((f) => path.join('src', f));
  files.push('index.html', path.join('scripts', 'copy-launch.mjs'));

  // The APIs that would mean signing locally, plus the env var that would
  // carry a key into a public bundle.
  const bad = [
    [/privateKey/i, 'key property'],
    [/secretKey|privKey/i, 'secret key property'],
    [/\bmnemonic\b/i, 'mnemonic'],
    [/seedPhrase/i, 'seed phrase'],
    [/new\s+(ethers|Web3)/, 'ethers/Web3 constructor'],
    [/\bnew\s+(ethers\.)?Wallet\s*\(/, 'Wallet constructor'],
    [/\bhdkey\b|\bBIP39\b|\bbip39\b/i, 'HD key derivation'],
    [/eth_privateKey|personal_/, 'node signing API'],
    [/eth_signTypedData|eth_signTransaction|eth_sign\b/, 'local signing'],
    [/import\s*\(?\s*\{?\s*(secret|private)/i, 'imports a key'],
  ];

  await t.test(`scanned ${files.length} client sources`, () => {
    const offenders = [];
    for (const f of files) {
      const p = path.join(root, f);
      if (!fs.existsSync(p)) { offenders.push(`${f}: MISSING`); continue; }
      const src = fs.readFileSync(p, 'utf8');
      for (const [re, why] of bad) if (re.test(src)) offenders.push(`${f}: ${why} (${re})`);
    }
    assert.deepEqual(offenders, [], `client must not touch key material:\n  ${offenders.join('\n  ')}`);
  });

  await t.test('the wallet module delegates signing to the provider', () => {
    const src = fs.readFileSync(path.join(dir, 'wallet.js'), 'utf8');
    assert.match(src, /eth_sendTransaction/, 'writes go through the wallet');
    // The only chain it builds is the public game chain id, from config.
    assert.match(src, /config\.rpcUrl/);
    assert.ok(!/import\s.*\b(ethers|viem|web3)\b/.test(src), 'no signing library');
  });

  await t.test('the wallet module holds no key-shaped constant', () => {
    const src = fs.readFileSync(path.join(dir, 'wallet.js'), 'utf8');
    // A 64-hex-char literal would be a key or a hash; the module should have
    // none, because every selector comes from the generated SIGS table.
    const hexish = src.match(/0x[0-9a-fA-F]{32,}/g) || [];
    assert.deepEqual(hexish, [], `unexpected long hex literal(s): ${hexish.join(', ')}`);
  });

  await t.test('no VITE_ var carries a key', async () => {
      for (const [k, v] of Object.entries(config)) {
      if (/private|secret|seed|key|pass/i.test(k)) {
        assert.fail(`config exposes a key-shaped field: ${k}`);
      }
      assert.doesNotMatch(String(v), /^[0-9a-fA-F]{64}$/, `config.${k} looks like a raw key/hash`);
    }
  });
});

// --- open settlement: settleHunt calldata ------------------------------
//
// The regression that matters: the offset word for the trailing `bytes`
// argument is a POSITION, not a presence flag. Encoding it as 0 makes every
// settlement revert on a real chain with a bare `data: "0x"` and no error
// name, so a shape check alone would not have caught it -- the payload has to
// be sent to a contract. script/dryrun-client-abi.mjs does that; these
// assertions pin the arithmetic that produced the wrong value.
describe('calldataSettleHunt', () => {
  const PLAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cfffb92266';
  const counts = [4n, 1n, 0n, 0n, 0n];

  it('keeps the keeper-era selector, so existing tooling still works', () => {
    const data = calldataSettleHunt(PLAYER, 1, counts, 400000000000000n);
    assert.equal(decodeHeader(data), sel('settleHunt(address,uint8,uint256[5],uint256,bytes)'));
    assert.equal(data.length, 8 + 64 * 10, '4 + 10 words: player, tier, 5 counts, best, offset, length');
  });

  it('points the bytes offset past the head, not at zero', () => {
    const data = calldataSettleHunt(PLAYER, 1, counts, 400000000000000n);
    const word = (i) => data.slice(8 + 64 * i, 8 + 64 * (i + 1));
    // slots: 0 player, 1 tier, 2..6 counts, 7 best, 8 offset, 9 length
    assert.equal(word(8), (9n * 32n).toString(16).padStart(64, '0'), 'offset must be 0x120');
    assert.notEqual(word(8), '0'.repeat(64), 'offset 0 reverts on chain with an unnamed error');
    assert.equal(word(9), '0'.repeat(64), 'the ignored signature is empty');
  });

  it('inlines the fixed-size counts array rather than offsetting it', () => {
    const data = calldataSettleHunt(PLAYER, 1, counts, 400000000000000n);
    const word = (i) => BigInt('0x' + data.slice(8 + 64 * i, 8 + 64 * (i + 1)));
    assert.equal(word(0), BigInt(PLAYER), 'player is left-padded into slot 0');
    assert.equal(word(1), 1n, 'tier');
    counts.forEach((c, i) => assert.equal(word(2 + i), c, `count ${i}`));
    assert.equal(word(7), 400000000000000n, 'bestSingleWei');
  });

  it('refuses a counts array that is not five long', () => {
    assert.throws(() => calldataSettleHunt(PLAYER, 1, [1, 2, 3], 1n), /exactly 5/);
    assert.throws(() => calldataSettleHunt(PLAYER, 1, 'nope', 1n), /exactly 5/);
  });

  it('rejects an out-of-range tier rather than truncating it', () => {
    assert.throws(() => calldataSettleHunt(PLAYER, 9, counts, 1n));
    assert.throws(() => calldataSettleHunt(PLAYER, 0, counts, 1n));
  });
});
