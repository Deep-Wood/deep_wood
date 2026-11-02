// Conformance test for buildURV4SwapEthToDeepwood — pins the EXACT calldata
// structure that successful on-chain UR txs use (verified against
// 0x5e7b0881feec65cbd905bca3d6645feaee0beb0e63444dd3de455e70e98f04b0 and
// proven with eth_call + a live swap 0x6b386abc5b82...).
//
// If this test fails, the swap WILL revert on-chain — do not "fix" the test
// to match new output without re-verifying with eth_call against the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildURV4SwapEthToDeepwood, V4_UNIVERSAL_ROUTER, DEEPWOOD_POOL } from './v4swap.js';

const ETH_IN = 5_000_000_000_000_000n; // 0.005 ETH
const MIN_OUT = 0n;
const DEADLINE = 1793570000;
const RECIPIENT = '0x89aaad8ca73c2c1f35be48f040a80f43005e2781';

function words(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const w = [];
  for (let i = 0; i < h.length / 64; i++) w.push(h.slice(i * 64, (i + 1) * 64));
  return w;
}

function build() {
  return buildURV4SwapEthToDeepwood(ETH_IN, MIN_OUT, RECIPIENT, DEADLINE);
}

test('selector is UR execute(bytes,bytes[],uint256)', () => {
  assert.equal(build().slice(0, 10), '0x3593564c');
});

test('execute head: commands offset 0x60, inputs offset, deadline last', () => {
  const w = words(build());
  // w[0] is selector+first word combined? No — words() starts after 0x, so w[0]
  // contains the 4-byte selector in its first 8 hex chars. Compare from byte 4.
  const args = build().slice(10); // strip 0x + selector
  const aw = words(args);
  assert.equal(BigInt('0x' + aw[0]), 0x60n, 'commands offset must be 0x60 (3-word head)');
  // commands = 1 byte => encBytes = 64 bytes => inputs offset = 0x60 + 64 = 0xa0
  assert.equal(BigInt('0x' + aw[1]), 0xa0n, 'inputs offset');
  assert.equal(BigInt('0x' + aw[2]), BigInt(DEADLINE), 'deadline');
});

test('commands tail is exactly 0x10 (V4_SWAP), offset-encoded — NOT inlined as bytes32', () => {
  const aw = words(build().slice(10));
  // tail starts at word 3: [len][data]
  assert.equal(BigInt('0x' + aw[3]), 1n, 'commands length = 1');
  assert.ok(aw[4].startsWith('10' + '0'.repeat(62)), 'commands data = 0x10');
});

test('inputs is bytes[] with ONE element = abi.encode(bytes actions, bytes[] params)', () => {
  const aw = words(build().slice(10));
  // inputs array starts at byte 0xa0 => word index 0xa0/32 = 5
  const arr = aw.slice(5);
  assert.equal(BigInt('0x' + arr[0]), 1n, 'one input');
  assert.equal(BigInt('0x' + arr[1]), 0x20n, 'input[0] offset = 0x20 (after length word)');
  // bytes[] elements are each encBytes-wrapped: [len][content]
  const inp = arr.slice(2);
  assert.equal(BigInt('0x' + inp[0]), 0x360n, 'input[0] length = 864 bytes (matches on-chain good tx)');
  const body = inp.slice(1); // v4swapInput content
  // (bytes actions, bytes[] params): w0=offset actions=0x40, w1=offset params
  assert.equal(BigInt('0x' + body[0]), 0x40n, 'actions offset 0x40');
  // actions: len then data — at byte 0x40 => word 2
  assert.equal(BigInt('0x' + body[2]), 3n, 'actions length 3');
  assert.ok(body[3].startsWith('060c0f'), 'actions = 0x060c0f (SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL)');
  // params array offset = 0x40 + 64 = 0x80 => word 1
  assert.equal(BigInt('0x' + body[1]), 0x80n, 'params offset 0x80');
  const params = body.slice(4);
  assert.equal(BigInt('0x' + params[0]), 3n, '3 params');
  assert.equal(BigInt('0x' + params[1]), 0x60n, 'param[0] offset = 3*32 = 0x60 (relative to after array length)');
});

test('swapParams tuple: poolKey + zeroForOne=true + amountIn + amountOutMin + minHopPriceX36=0 + hookData', () => {
  const aw = words(build().slice(10));
  const arr = aw.slice(5);
  const inp = arr.slice(2);
  const body = inp.slice(1);
  const params = body.slice(4);
  const off0 = Number(BigInt('0x' + params[1])) / 32;
  const sp = params.slice(1 + off0); // [len][content] — bytes[] elements are encBytes-wrapped
  assert.equal(BigInt('0x' + sp[0]), 0x180n, 'param[0] length = 384 bytes');
  const sc = sp.slice(1);
  assert.equal(BigInt('0x' + sc[0]), 0x20n, 'dynamic tuple 0x20 offset pointer');
  const t = sc.slice(1);
  // poolKey: currency0, currency1, fee, tickSpacing, hooks
  assert.equal(BigInt('0x' + t[0]), 0n, 'currency0 = ETH (address zero)');
  assert.ok(t[1].endsWith(DEEPWOOD_POOL.currency1.slice(2).toLowerCase()), 'currency1 = DEEPWOOD');
  assert.equal(BigInt('0x' + t[2]), BigInt(DEEPWOOD_POOL.fee), 'fee');
  assert.equal(BigInt('0x' + t[3]), BigInt(DEEPWOOD_POOL.tickSpacing), 'tickSpacing');
  assert.ok(t[4].endsWith(DEEPWOOD_POOL.hooks.slice(2).toLowerCase()), 'hooks');
  assert.equal(BigInt('0x' + t[5]), 1n, 'zeroForOne = true (ETH -> token)');
  assert.equal(BigInt('0x' + t[6]), ETH_IN, 'amountIn');
  assert.equal(BigInt('0x' + t[7]), MIN_OUT, 'amountOutMinimum');
  assert.equal(BigInt('0x' + t[8]), 0n, 'minHopPriceX36 = 0');
  assert.equal(BigInt('0x' + t[9]), 0x140n, 'hookData offset = 10 words');
  assert.equal(BigInt('0x' + t[10]), 0n, 'hookData length = 0');
});

test('settleAll = (ETH, amountIn) and takeAll = (DEEPWOOD, minOut) as (address, uint256) pairs', () => {
  const aw = words(build().slice(10));
  const arr = aw.slice(5);
  const inp = arr.slice(2);
  const body = inp.slice(1);
  const params = body.slice(4);
  const off1 = Number(BigInt('0x' + params[2])) / 32;
  const off2 = Number(BigInt('0x' + params[3])) / 32;
  const p1 = params.slice(1 + off1); // [len=0x40][currency][amount]
  const p2 = params.slice(1 + off2);
  assert.equal(BigInt('0x' + p1[0]), 0x40n, 'settleAll length = 2 words');
  assert.equal(BigInt('0x' + p1[1]), 0n, 'settle currency = ETH');
  assert.equal(BigInt('0x' + p1[2]), ETH_IN, 'settle amount = ETH in');
  assert.equal(BigInt('0x' + p2[0]), 0x40n, 'takeAll length = 2 words');
  assert.ok(p2[1].endsWith(DEEPWOOD_POOL.currency1.slice(2).toLowerCase()), 'take currency = DEEPWOOD');
  assert.equal(BigInt('0x' + p2[2]), MIN_OUT, 'take min = minOut');
});

test('router + pool constants are the verified on-chain addresses', () => {
  assert.equal(V4_UNIVERSAL_ROUTER, '0x8876789976decbfcbbbe364623c63652db8c0904');
  assert.equal(DEEPWOOD_POOL.currency1, '0xF049d0076c2f25A763551beD760aB55e905ea831');
  assert.equal(DEEPWOOD_POOL.hooks, '0xa5e27e3e54739162fe52c2c48e55b6dd6572e8ec');
  assert.equal(DEEPWOOD_POOL.tickSpacing, 60);
});

// ---------------------------------------------------------------------------
// SELL builder — must mirror the proven viem encodeSell byte-for-byte.
// ---------------------------------------------------------------------------
import { buildURV4SwapDeepwoodToEth, buildErc20ApproveCalldata, buildPermit2ApproveCalldata, V4_PERMIT2, MAX_UINT160 } from './v4swap.js';

const DEEP_IN = 25_000_000_000_000_000_000n; // 25 DEEPWOOD
const MIN_ETH = 1_000_000_000_000_000n; // 0.001 ETH min out

function sellWords() {
  return words(buildURV4SwapDeepwoodToEth(DEEP_IN, MIN_ETH, RECIPIENT, DEADLINE).slice(10));
}

test('sell: same execute shell — selector, 0x10 commands tail, one input of len 0x360', () => {
  const d = buildURV4SwapDeepwoodToEth(DEEP_IN, MIN_ETH, RECIPIENT, DEADLINE);
  assert.equal(d.slice(0, 10), '0x3593564c');
  const aw = words(d.slice(10));
  assert.equal(BigInt('0x' + aw[0]), 0x60n);
  assert.equal(BigInt('0x' + aw[1]), 0xa0n);
  assert.equal(BigInt('0x' + aw[2]), BigInt(DEADLINE));
  const arr = aw.slice(5);
  assert.equal(BigInt('0x' + arr[0]), 1n);
  const inp = arr.slice(2);
  assert.equal(BigInt('0x' + inp[0]), 0x360n, 'input[0] length 864');
  const body = inp.slice(1);
  assert.equal(BigInt('0x' + body[0]), 0x40n);
  assert.ok(body[3].startsWith('060c0f'), 'actions 0x060c0f');
});

test('sell: zeroForOne=false, amountIn=DEEP_IN, amountOutMin=MIN_ETH', () => {
  const params = sellWords().slice(5).slice(2).slice(1).slice(4); // aw -> arr -> inp -> body -> params
  const off0 = Number(BigInt('0x' + params[1])) / 32;
  const sc = params.slice(1 + off0).slice(1); // [len][tuple...]
  const t = sc.slice(1);
  assert.equal(BigInt('0x' + t[5]), 0n, 'zeroForOne = FALSE (token -> ETH)');
  assert.equal(BigInt('0x' + t[6]), DEEP_IN, 'amountIn = DEEP_IN');
  assert.equal(BigInt('0x' + t[7]), MIN_ETH, 'amountOutMin = MIN_ETH');
  assert.equal(BigInt('0x' + t[8]), 0n, 'minHopPriceX36 = 0');
});

test('sell: settleAll = (DEEPWOOD, DEEP_IN), takeAll = (ETH zero, MIN_ETH)', () => {
  const params = sellWords().slice(5).slice(2).slice(1).slice(4);
  const off1 = Number(BigInt('0x' + params[2])) / 32;
  const off2 = Number(BigInt('0x' + params[3])) / 32;
  const p1 = params.slice(1 + off1);
  const p2 = params.slice(1 + off2);
  assert.ok(p1[1].endsWith(DEEPWOOD_POOL.currency1.slice(2).toLowerCase()), 'settle currency = DEEPWOOD');
  assert.equal(BigInt('0x' + p1[2]), DEEP_IN, 'settle amount = DEEP_IN');
  assert.equal(BigInt('0x' + p2[1]), 0n, 'take currency = ETH (address zero)');
  assert.equal(BigInt('0x' + p2[2]), MIN_ETH, 'take min = MIN_ETH');
});

test('sell: buy builder output is unchanged by the sell addition (regression pin)', () => {
  const d = buildURV4SwapEthToDeepwood(ETH_IN, MIN_OUT, RECIPIENT, DEADLINE);
  const aw = words(d.slice(10));
  const params = aw.slice(5).slice(2).slice(1).slice(4);
  const off0 = Number(BigInt('0x' + params[1])) / 32;
  const t = params.slice(1 + off0).slice(1).slice(1);
  assert.equal(BigInt('0x' + t[5]), 1n, 'buy stays zeroForOne=true');
});

test('approval calldata: ERC20 approve and Permit2 approve (uint160, NOT uint256)', () => {
  const ap = buildErc20ApproveCalldata(V4_PERMIT2, (1n << 256n) - 1n);
  assert.equal(ap.slice(0, 10), '0x095ea7b3');
  assert.ok(ap.slice(10 + 64).startsWith('f' + 'f'.repeat(63)), 'amount = maxUint256 fills the word');
  const pp = buildPermit2ApproveCalldata(DEEPWOOD_POOL.currency1, V4_UNIVERSAL_ROUTER, MAX_UINT160, 1893456000);
  assert.equal(pp.slice(0, 10), '0x87517c45');
  // 4 args x 32 bytes: token, spender, amount(uint160), expiration(uint48)
  assert.equal((pp.length - 10) / 64, 4, 'exactly 4 words after selector');
  const amtWord = pp.slice(10 + 128, 10 + 192);
  assert.equal(BigInt('0x' + amtWord), MAX_UINT160, 'amount = maxUint160 ((1<<160)-1), NOT maxUint256');
  assert.ok(amtWord.length === 64 && amtWord.startsWith('0'.repeat(64 - 40)), 'uint160 right-aligned in word');
  const expWord = pp.slice(10 + 192);
  assert.equal(BigInt('0x' + expWord), 1893456000n, 'expiration');
});
