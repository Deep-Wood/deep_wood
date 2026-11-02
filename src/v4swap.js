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
  // Offsets are relative to the word AFTER the array length word.
  let cursor = items.length * 32;
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
 * Verified byte-for-byte against successful on-chain UR txs (e.g.
 * 0x5e7b0881feec65cbd905bca3d6645feaee0beb0e63444dd3de455e70e98f04b0) and
 * confirmed with eth_call against the live pool:
 *
 *   execute(
 *     commands = 0x10,                       // V4_SWAP only
 *     inputs   = [ abi.encode(bytes actions=0x060c0f, bytes[] params) ],
 *     deadline
 *   )
 *
 * where params = [ swapParams, settleAll, takeAll ]:
 *   swapParams  = dynamic tuple (PoolKey, bool zeroForOne, uint128 amountIn,
 *                                uint128 amountOutMin, uint256 minHopPriceX36,
 *                                bytes hookData) — Robinhood V4 extension field
 *   settleAll   = (address currency0=ETH, uint256 amount)   // pays msg.value in
 *   takeAll     = (address currency1=token, uint256 minOut) // receives token
 *
 * @param {bigint} ethInWei
 * @param {bigint} minDeepwood
 * @param {string} recipient (unused — TAKE_ALL sends to msg.sender)
 * @param {number} [deadline]
 * @returns {string} 0x-prefixed calldata
 */
export function buildURV4SwapEthToDeepwood(
  ethInWei,
  minDeepwood,
  recipient,
  deadline = Math.floor(Date.now() / 1000) + 600,
) {
  void recipient;
  const p = DEEPWOOD_POOL;

  // --- swapParams: dynamic tuple with 0x20 offset pointer ---------------
  // tuple head (10 words): poolKey(5) + zeroForOne + amountIn + amountOutMin
  //                       + minHopPriceX36 + hookDataOffset
  const hookData = ''; // empty — the game hook accepts plain swaps
  const hookDataOffset = 10 * 32; // 0x140 — right after the 10-word head
  const swapParams =
    argUint(0x20) +                       // offset to tuple content
    argAddr(p.currency0) +                // tuple: currency0 (ETH = 0x0)
    argAddr(p.currency1) +                // tuple: currency1 (DeepWood)
    argUint(p.fee) +                      // tuple: fee
    argUint(p.tickSpacing) +              // tuple: tickSpacing (int24, positive)
    argAddr(p.hooks) +                    // tuple: hooks
    argUint(1) +                          // zeroForOne = true (ETH -> token)
    argUint(ethInWei) +                   // amountIn (uint128)
    argUint(minDeepwood) +                // amountOutMinimum (uint128)
    argUint(0) +                          // minHopPriceX36 = 0 (no hop constraint)
    argUint(hookDataOffset) +             // offset to hookData within tuple
    argUint(hookData.length / 2);         // hookData length = 0

  // --- settleAll / takeAll: static (address, uint256) pairs -------------
  const settleAll = argAddr(p.currency0) + argUint(ethInWei);
  const takeAll = argAddr(p.currency1) + argUint(minDeepwood);

  // --- V4_SWAP input: abi.encode(bytes actions, bytes[] params) ---------
  const actions = '060c0f'; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const encActions = encodeBytes(actions);
  const encParams = encodeBytesArray([swapParams, settleAll, takeAll]);
  const actionsOffset = 2 * 32;                    // 0x40
  const paramsOffset = actionsOffset + encActions.length / 2; // 0x80
  const v4swapInput =
    argUint(actionsOffset) + argUint(paramsOffset) + encActions + encParams;

  // --- execute(bytes commands, bytes[] inputs, uint256 deadline) --------
  const commands = '10'; // V4_SWAP
  const encCommands = encodeBytes(commands);
  const encInputs = encodeBytesArray([v4swapInput]);
  const commandsOffset = 3 * 32;                   // 0x60
  const inputsOffset = commandsOffset + encCommands.length / 2;

  return (
    '0x3593564c' +
    argUint(commandsOffset) +
    argUint(inputsOffset) +
    argUint(deadline) +
    encCommands +
    encInputs
  );
}

// ---------------------------------------------------------------------------
// SELL: DeepWood -> ETH through the same Universal Router V4_SWAP path.
// Encoding mirrors the proven SELL txs (sell_all_graduated): same actions
// 0x060c0f, but zeroForOne=false, SETTLE_ALL on the token (ERC20, pulled via
// Permit2), TAKE_ALL on ETH. The BUY function above is intentionally left
// byte-identical — do not refactor it into a shared helper without re-running
// src/v4swap.test.mjs.
// ---------------------------------------------------------------------------

export const V4_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// Permit2 amounts/expirations are uint160/uint48 — NOT uint256. Encoding a
// maxUint256 here garbles the calldata (ABI field is uint160; viem does not
// truncate, so the tx lands but the allowance stays unchanged).
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Build Universal Router execute calldata for exact-in DeepWood -> ETH.
 * Same structure as the buy; verified against sell_all_graduated.mjs's
 * viem encoding (encodeSell) and proven with eth_call + a live tx.
 *
 * @param {bigint} deepwoodIn  token amount in wei (18 decimals)
 * @param {bigint} minEthWei   minimum ETH out (wei)
 * @param {string} recipient (unused — TAKE_ALL sends to msg.sender)
 * @param {number} [deadline]
 */
export function buildURV4SwapDeepwoodToEth(
  deepwoodIn,
  minEthWei,
  recipient,
  deadline = Math.floor(Date.now() / 1000) + 600,
) {
  void recipient;
  const p = DEEPWOOD_POOL;

  const hookData = '';
  const hookDataOffset = 10 * 32; // 0x140
  const swapParams =
    argUint(0x20) +
    argAddr(p.currency0) +                // currency0 = ETH
    argAddr(p.currency1) +                // currency1 = DeepWood
    argUint(p.fee) +
    argUint(p.tickSpacing) +
    argAddr(p.hooks) +
    argUint(0) +                          // zeroForOne = FALSE (token -> ETH)
    argUint(deepwoodIn) +                 // amountIn (uint128)
    argUint(minEthWei) +                  // amountOutMinimum (uint128)
    argUint(0) +                          // minHopPriceX36 = 0
    argUint(hookDataOffset) +
    argUint(hookData.length / 2);         // hookData length = 0

  // SELL: settle the TOKEN input, take ETH out.
  const settleAll = argAddr(p.currency1) + argUint(deepwoodIn);
  const takeAll = argAddr(p.currency0) + argUint(minEthWei);

  const actions = '060c0f';
  const encActions = encodeBytes(actions);
  const encParams = encodeBytesArray([swapParams, settleAll, takeAll]);
  const actionsOffset = 2 * 32;                    // 0x40
  const paramsOffset = actionsOffset + encActions.length / 2; // 0x80
  const v4swapInput =
    argUint(actionsOffset) + argUint(paramsOffset) + encActions + encParams;

  const commands = '10';
  const encCommands = encodeBytes(commands);
  const encInputs = encodeBytesArray([v4swapInput]);
  const commandsOffset = 3 * 32;                   // 0x60
  const inputsOffset = commandsOffset + encCommands.length / 2;

  return (
    '0x3593564c' +
    argUint(commandsOffset) +
    argUint(inputsOffset) +
    argUint(deadline) +
    encCommands +
    encInputs
  );
}

/** ERC20 approve(address spender, uint256 amount) — selector 0x095ea7b3. */
export function buildErc20ApproveCalldata(spender, amount) {
  return '0x095ea7b3' + argAddr(spender) + argUint(amount);
}

/**
 * Permit2 approve(address token, address spender, uint160 amount, uint48
 * expiration) — selector 0x87517c45. uint160/uint48 fields still occupy full
 * 32-byte words in the ABI encoding.
 */
export function buildPermit2ApproveCalldata(token, spender, amount, expiration) {
  return '0x87517c45' + argAddr(token) + argAddr(spender) + argUint(amount) + argUint(expiration);
}

// Read selectors (eth_call, no signing needed)
export const SEL_BALANCE_OF = '0x70a08231';   // balanceOf(address)
export const SEL_ERC20_ALLOWANCE = '0xdd62ed3e'; // allowance(address,address)
export const SEL_PERMIT2_ALLOWANCE = '0x927da105'; // allowance(address,address,address) -> (uint160,uint48)
