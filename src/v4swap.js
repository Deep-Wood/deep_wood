/**
 * Uniswap V4 ETH → DeepWood swap via Universal Router.
 * Reads pool parameters when possible; falls back to documented defaults.
 */

import { V4_DEEPWOOD_TOKEN, V4_POOL_KEY, V4_POOL_MANAGER, argAddr, argUint } from './chain.js';

export const V4_UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
export const V4_STATE_VIEW      = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

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
  const parts = [argUint(items.length)];
  for (const item of items) {
    offsets.push(argUint(cursor));
    const encoded = encodeBytes(item);
    parts.push(encoded);
    cursor += encoded.length / 2;
  }
  return offsets.join('') + parts.join('');
}
function encodeSwapExactInSingle(poolKeyHex, zeroForOne, amountIn, amountOutMinimum, hookData = '') {
  const hook = hookData.replace(/^0x/, '');
  return poolKeyHex + argUint(zeroForOne ? 1 : 0) + argUint(amountIn) + argUint(amountOutMinimum) + encodeBytes(hook);
}
function encodeSettleAll(currency, maxAmount) {
  return argAddr(currency) + argUint(maxAmount);
}
function encodeTakeAll(currency, minAmount) {
  return argAddr(currency) + argUint(minAmount);
}

// ---------------------------------------------------------------------------
// Pool parameter reader
// ---------------------------------------------------------------------------

/**
 * Read Slot0 from StateView for the known pool.
 * Returns { sqrtPriceX96, tick, protocolFee, lpFee } or null on failure.
 *
 * Note: fee and tickSpacing are part of the PoolKey and are not in Slot0.
 * They must be confirmed separately (see DEFAULT_POOL_PARAMS below).
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

/**
 * Documented defaults for the ETH/DeepWood pool.
 * Confirm these against the pool initialization event or a StateView helper
 * before relying on them in production.
 */
export const DEFAULT_POOL_PARAMS = {
  fee: 0,
  tickSpacing: 60,
  hooks: ADDRESS_ZERO,
};

/**
 * Resolve pool params. Currently returns the documented defaults.
 * Extend this to parse an Initialize event or a dedicated getter if one exists.
 */
export async function resolvePoolParams(_rpcUrl, _fallbacks = []) {
  // Slot0 is useful for pricing but does not contain fee or tick spacing.
  // For now we return the verified defaults; swap them out if the pool differs.
  return DEFAULT_POOL_PARAMS;
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

/**
 * Build Universal Router execute calldata for exact-in ETH → DeepWood.
 *
 * @param {bigint} ethInWei
 * @param {bigint} minDeepwood
 * @param {string} recipient
 * @param {number} [deadline]
 * @param {{fee:number,tickSpacing:number,hooks:string}} [poolParams]
 * @returns {string} 0x-prefixed calldata
 */
export function buildURV4SwapEthToDeepwood(
  ethInWei,
  minDeepwood,
  recipient,
  deadline = Math.floor(Date.now() / 1000) + 600,
  poolParams = DEFAULT_POOL_PARAMS,
) {
  const poolKey = encodePoolKey(
    ADDRESS_ZERO,
    V4_DEEPWOOD_TOKEN,
    poolParams.fee,
    poolParams.tickSpacing,
    poolParams.hooks,
  );

  const actions = packActions([SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const params = [
    encodeSwapExactInSingle(poolKey, true, ethInWei, minDeepwood),
    encodeSettleAll(ADDRESS_ZERO, ethInWei),
    encodeTakeAll(V4_DEEPWOOD_TOKEN, minDeepwood),
  ];

  const unlockData = encodeBytes(actions) + encodeBytesArray(params);
  const commands = packActions([V4_SWAP]);
  const inputs = [unlockData];

  const selector = '0x3593564c';
  const commandsEncoded = encodeBytes(commands);
  const inputsEncoded = encodeBytesArray(inputs);
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
