import { test } from 'node:test';
import assert from 'node:assert/strict';

// rpc.js reads config at import time, so the env has to be set before it loads.
process.env.VITE_RPC_URL = 'https://primary.example';
process.env.VITE_RPC_FALLBACKS = 'https://backup1.example,https://backup2.example';

const { rpcEndpoints, rpcCall } = await import('./rpc.js');

/**
 * Stub global fetch with a per-URL handler map.
 *
 * An UNHANDLED url THROWS, modelling an unreachable endpoint. It must not return
 * a JSON-RPC error, because that is a legitimate answer and rpcCall correctly
 * stops the walk on one -- a stub that faked it would make "unreachable" and
 * "refused" indistinguishable and hide the very behaviour under test.
 */
function stubFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    const h = handlers[url];
    if (!h) throw new Error(`unreachable: ${url}`);
    return { json: async () => h(init) };
  };
  return calls;
}

test('the endpoint list is primary first, then fallbacks, de-duplicated', () => {
  const eps = rpcEndpoints();
  assert.equal(eps[0], 'https://primary.example');
  assert.ok(eps.includes('https://backup1.example'));
  assert.ok(eps.includes('https://backup2.example'));
  assert.equal(new Set(eps).size, eps.length, 'no duplicate endpoints');
});

test('the primary answer is used when it is plausible', async () => {
  const calls = stubFetch({
    'https://primary.example': () => ({ result: '0x' + 'ab'.repeat(32) }),
  });
  const got = await rpcCall('eth_getBalance', ['0xabc', 'latest']);
  assert.equal(got, '0x' + 'ab'.repeat(32));
  assert.deepEqual(calls, ['https://primary.example'], 'must not fall through');
});

test('an unreachable primary falls through to the backup', async () => {
  stubFetch({
    'https://backup1.example': () => ({ result: '0x' + 'cd'.repeat(32) }),
  });
  const got = await rpcCall('eth_getBalance', ['0xabc', 'latest'], { minBytes: 4 });
  assert.equal(got, '0x' + 'cd'.repeat(32));
});

test('a real balance with TRIMMED leading zeros is believed', async () => {
  // The regression that greyed out the buy button: 46630 RPCs trim leading
  // zeros from the uint256, so an 11 ETH balance arrives as 16 hex chars, not
  // 64. Judging by trimmed hex-char count rejected every real balance and left
  // a funded wallet reading as empty. A trimmed body of >= minBytes bytes is a
  // plausible quantity and must be believed.
  const calls = stubFetch({
    'https://primary.example': () => ({ result: '0x9c2d438e044446e7' }), // 11.25 ETH, 8 bytes
  });
  const got = await rpcCall('eth_getBalance', ['0xabc', 'latest'], { minBytes: 4 });
  assert.equal(got, '0x9c2d438e044446e7', 'a real balance with trimmed zeros passes');
  assert.deepEqual(calls, ['https://primary.example'], 'must not fall through');
});

test('a SHORT hex answer is not believed -- it is retried elsewhere', async () => {
  // This is the exact failure that started all of it: the primary answered
  // "0x" plus one byte for a contract holding 36KB. A failed read is easy to
  // retry; a confidently wrong one silently disables the game.
  const calls = stubFetch({
    'https://primary.example': () => ({ result: '0xc7' }),
    'https://backup1.example': () => ({ result: '0x' + '11'.repeat(32) }),
  });
  const got = await rpcCall('eth_getBalance', ['0xabc', 'latest'], { minBytes: 4 });
  assert.equal(got, '0x' + '11'.repeat(32), 'the short answer was discarded');
  assert.deepEqual(calls, ['https://primary.example', 'https://backup1.example']);
});

test('every endpoint answering badly returns null rather than a wrong number', async () => {
  stubFetch({
    'https://primary.example': () => ({ result: '0x' }),
    'https://backup1.example': () => ({ result: '0x01' }),
    'https://backup2.example': () => ({ result: '0x' }),
  });
  const got = await rpcCall('eth_getBalance', ['0xabc', 'latest'], { minBytes: 4 });
  assert.equal(got, null, 'unknown is not zero and not a guess');
});

test('an explicit JSON-RPC error stops the walk -- it is a real answer', async () => {
  // "reverted" or "not found" is the contract speaking. Asking a second
  // provider to also say no adds latency and hides which endpoint answered.
  const calls = stubFetch({
    'https://primary.example': () => ({ error: { code: 3, message: 'execution reverted' } }),
    'https://backup1.example': () => ({ result: '0x' + 'ff'.repeat(32) }),
  });
  assert.equal(await rpcCall('eth_call', []), null);
  assert.deepEqual(calls, ['https://primary.example']);
});

test('a network throw on the primary still reaches the backup', async () => {
  globalThis.fetch = async (url) => {
    if (url === 'https://primary.example') throw new Error('network down');
    return { json: async () => ({ result: '0x' + '22'.repeat(32) }) };
  };
  const got = await rpcCall('eth_getBalance', ['0xabc', 'latest'], { minBytes: 4 });
  assert.equal(got, '0x' + '22'.repeat(32));
});
