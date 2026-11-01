/**
 * Uniswap V4 ETH → DeepWood swap via Universal Router.
 * Reads pool parameters when possible; falls back to documented defaults.
 */

import { V4_DEEPWOOD_TOKEN, V4_POOL_KEY, V4_POOL_MANAGER, argAddr, argUint } from './chain.js';

export const V4_UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
export const V4_STATE_VIEW      = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
export const DEEPWOOD_POOL = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0xF049d0076c2f25A763551beD760aB55e905ea831',
  fee: 0,
  tickSpacing: 60,
  hooks: '0xa5e27e3e54739162fe52c2c48e55b6dd6572e8ec',
};

// v4-periphery Actions.sol
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL           = 0x0c;
const TAKE_ALL             = 0x0f;
const V4_SWAP              = 0x10;

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function hex(n, bytes = 32) {
  return BigInt(n).toString(16).padStart(bytes * 2, '0');
}
function addr(a) {
  return a.toLowerCase().replace(/^0x/, '').padStart(40, '0');
}
function encodePoolKey(c0, c1, fee, tickSpacing, hooks) {
  return argAddr(c0) + argAddr(c1) + argUint(fee) + argUint(tickSpacing) + argAddr(hooks);
}
function packActions(actions) {
  return actions.map((a) => a.toString(16).padStart(2, '0')).join('');
}
function encodeBytes(hexData) {
  const len = hexData.length / 2;
  const padded = hexData.padEnd(Math.ceil(hexData.length / 64) * 64, '0');
  return argUint(len) + padded;
}
function encodeBytesArray(items) {
  const offsets = [];
  let cursor = 32 + items.length * 32;
  const dataParts = [];
  for (const item of items) {
    offsets.push(argUint(cursor));
    const encoded = encodeBytes(item);
    dataParts.push(encoded);
    cursor += encoded.length / 2;
  }
  // Correct ABI order for bytes[]: [array length][offsets...][item data...]
  return argUint(items.length) + offsets.join('') + dataParts.join('');
}
function toInt256(n) {
  const tc = n < 0n ? (1n << 256n) + n : n;
  return tc.toString(16).padStart(64, '0');
}

// ---------------------------------------------------------------------------
// Pool parameter reader
// ---------------------------------------------------------------------------

/**
 * Read Slot0 from StateView for the known pool.
 * Returns { sqrtPriceX96, tick, protocolFee, lpFee } or null on failure.
 */
export async function readPoolSlot0(rpcUrl, fallbackRpcUrls = []) {
  const SEL_GET_SLOT0 = '0xdf90153a'; // getSlot0(bytes32)
  const data = SEL_GET_SLOT0 + V4_POOL_KEY.slice(2);
  const urls = [rpcUrl, ...fallbackRpcUrls].filter(Boolean);
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: V4_STATE_VIEW, data }, 'latest'],
        }),
      });
      const j = await res.json();
      if (j.error || !j.result || j.result === '0x') continue;
      const h = j.result.replace(/^0x/, '');
      if (h.length < 64 * 4) continue;
      const word = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
      return {
        sqrtPriceX96: word(0),
        tick: Number(word(1)),
        protocolFee: Number(word(2)),
        lpFee: Number(word(3)),
      };
    } catch { /* next */ }
  }
  return null;
}

/** Unused now that DEEPWOOD_POOL carries the verified pool key params. Kept for reference only. */
export const DEFAULT_POOL_PARAMS = {
  fee: 0,
  tickSpacing: 60,
  hooks: ADDRESS_ZERO,
};

/**
 * Resolve pool params. Returns the verified DEEPWOOD_POOL params.
 * Slot0 does not contain fee/tickSpacing/hooks, so those are hardcoded here
 * from the live pool's Initialize event.
 */
export async function resolvePoolParams(_rpcUrl, _fallbacks = []) {
  return {
    fee: DEEPWOOD_POOL.fee,
    tickSpacing: DEEPWOOD_POOL.tickSpacing,
    hooks: DEEPWOOD_POOL.hooks,
  };
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

/**
 * Build Universal Router execute calldata for exact-in ETH → DeepWood.
 *
 * The V4_SWAP command (0x10) input is ABI-encoded as:
 *   (bytes32 poolKey, int256 amount0Delta, int256 amount1Delta, bytes data)
 *
 * @param {bigint} ethInWei
 * @param {bigint} minDeepwood
 * @param {string} recipient
 * @param {number} [deadline]
 * @returns {string} 0x-prefixed calldata
 */
export function buildURV4SwapEthToDeepwood(
  ethInWei,
  minDeepwood,
  recipient,
  deadline = Math.floor(Date.now() / 1000) + 600,
) {
  // V4_POOL_KEY is the 32-byte pool ID (verified on-chain).
  const poolKey = V4_POOL_KEY.slice(2);                        // 64 hex chars
  // amount0Delta < 0: sending ETH (currency0) to the pool.
  // amount1Delta > 0: minimum DeepWood (currency1) to receive — slippage floor.
  const amount0Delta = toInt256(-ethInWei);                    // 64 hex chars
  const amount1Delta = toInt256(minDeepwood);                  // 64 hex chars

  // ABI encode (bytes32, int256, int256, bytes) for V4_SWAP command input.
  // Head: poolKey, amount0Delta, amount1Delta, offset_to_bytes_data.
  // Tail: bytes length (0), bytes data (empty — no hook data).
  const offsetToBytesData = 4 * 32;                            // 128 = 0x80
  const swapInput =
    poolKey +                                                  // word 0: bytes32 poolKey
    amount0Delta +                                             // word 1: int256 amount0Delta
    amount1Delta +                                             // word 2: int256 amount1Delta
    offsetToBytesData.toString(16).padStart(64, '0') +         // word 3: offset to bytes data
    '0'.repeat(64);                                            // tail: bytes length = 0

  const commands = encodeBytes('10');                          // V4_SWAP command byte
  const inputs = encodeBytesArray([swapInput]);

  const selector = '0x3593564c';
  const commandsEncoded = commands;
  const inputsEncoded = inputs;
  const commandsOffset = 32 * 3;
  const inputsOffset = commandsOffset + commandsEncoded.length / 2;

  return (
    selector +
    argUint(commandsOffset) +
    argUint(inputsOffset) +
    argUint(deadline) +
    commandsEncoded +
    inputsEncoded
  );
}
