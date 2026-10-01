/**
 * Wallet connection + the two player write paths.
 *
 * Read-only access lives in chain.js. This module is the part a PLAYER signs:
 * EIP-1193 (window.ethereum) connect, chain switching, and calldata for
 * `claimTool(uint8)` and `buyGems(uint8,uint256)`.
 *
 * No ethers, no viem, no wagmi -- same reason chain.js has none: the bundle
 * stays small and the encoding stays visible and testable instead of hidden
 * in a library. The selectors are NOT re-derived or re-typed here; they come
 * from the SIGS table chain.js generates from the compiled artifact, so there
 * is exactly one selector table in the project and one generator for it.
 *
 * NO SIGNING KEY, EVER. There is no key-handling code in this file and no
 * key material is read, imported, or accepted. Every transaction is handed to
 * the wallet, which prompts the user. wallet.test.mjs scans the client sources
 * for key-handling APIs and fails if any appear.
 *
 * Two-tier error contract, deliberately consistent WITHIN each tier:
 *
 *   - Pure builders (encoders, `calldata.claimTool`, `calldata.buyGems`)
 *     THROW a named `WalletError` with a `code`. They are total functions
 *     over their arguments; a bad tier is a programming error, not a runtime
 *     condition to report.
 *   - Everything that touches the provider (`connect`, `switchToGameChain`,
 *     `claimTool`, `buyGems`) RETURNS a typed result and never throws:
 *     `{ ok: true, ... }` or `{ ok: false, code, reason }`.
 *
 * A caller can therefore `await claimTool(2)` with no wallet installed and
 * get `{ ok: false, code: 'no-provider', ... }` rather than an exception, and
 * a caller can `try { calldata.claimTool(9) } catch (e) { e.code }`.
 *
 * A wrong chain is NEVER reported as connected -- the same stance live.js
 * takes on the read side, because reading the right address on the wrong
 * chain produces valid-looking garbage.
 *
 *   const r = await connect();
 *   if (r.ok && r.wrongChain) await switchToGameChain();
 *   const tx = await claimTool(1);
 */

import { SIGS } from './chain.js';
import { config } from './config.js';

/** The chain the game is deployed on. Mirrors config.chainId; checked below. */
export const GAME_CHAIN_ID = config.chainId;

// --- selector access (single source of truth: chain.js's generated table) ---

const SEL_MEMO = new Map();

/**
 * Resolve a signature through the generated SIGS table.
 *
 * chain.js's own `sel()` returns `undefined` for an unknown signature, which
 * concatenates into calldata as the string "undefined" -- a plausible-looking
 * transaction to nowhere. This throws instead, with the typo in the message.
 */
export function sel(sig) {
  if (!SEL_MEMO.has(sig)) {
    const v = SIGS[sig];
    if (!v) throw new WalletError('unknown-selector', `no selector for "${sig}"`);
    SEL_MEMO.set(sig, v);
  }
  return SEL_MEMO.get(sig);
}

// --- errors ----------------------------------------------------------------

/** Named error for the throwing tier (pure builders). */
export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

// --- encoding (mirrors chain.js: hand-rolled, no dependency) ---------------

const UINT256_MAX = (1n << 256n) - 1n;

/** ABI-encode a uintN as one 32-byte word, with a range check. */
function encUint(n, bits, what) {
  let v;
  try {
    v = typeof n === 'bigint' ? n : BigInt(n);
  } catch {
    throw new WalletError('bad-arg', `${what} is not an integer: ${String(n)}`);
  }
  if (v < 0n || v > (1n << BigInt(bits)) - 1n) {
    throw new WalletError('bad-arg', `${what} out of uint${bits} range: ${v}`);
  }
  return v.toString(16).padStart(64, '0');
}

export const encUint8 = (n) => encUint(n, 8, 'uint8');
export const encUint256 = (n) => encUint(n, 256, 'uint256');

/** ABI-encode an address (left-padded), with a shape check. */
export function encAddress(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new WalletError('bad-arg', `not an address: ${String(a)}`);
  }
  return a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** wei -> 0x hex quantity for an RPC field. */
export const toQuantity = (v) => '0x' + BigInt(v).toString(16);

/** Parse an RPC quantity ('0xb63a...') to a Number. Throws on garbage. */
export function fromQuantity(h) {
  if (h === null || h === undefined) throw new WalletError('bad-chain', 'provider returned no chain id');
  return Number(BigInt(h));
}

// --- argument validation ---------------------------------------------------
//
// These are the guards that stop the client from offering an action the
// contract will revert on, transcribed from src/DeepWood.sol -- the same
// discipline tools.js uses for the toolbelt. State-dependent guards
// (ToolAlreadyOwned, TierLocked, InsufficientGems) live onchain and are NOT
// re-implemented here; guessing at them from a stale read would be worse than
// letting the chain be the authority.

/**
 * claimTool: `if (tier == 0 || tier > 4) revert ToolOutOfRange();`
 *
 * The type check is strict on purpose: `Number('2') === 2`, so accepting a
 * numeric STRING here would coerce it silently. Coercion is how a wrong value
 * reaches the chain looking right, so a caller passing '2' gets the error and
 * fixes the caller.
 */
export function checkTier(tier) {
  if (typeof tier !== 'number' || !Number.isInteger(tier)) {
    throw new WalletError('tier-out-of-range', `claimTool: tier must be an integer 1..4, got ${typeof tier === 'string' ? `"${tier}"` : String(tier)}`);
  }
  if (tier < 1 || tier > 4) {
    throw new WalletError('tier-out-of-range', `claimTool: tier must be 1..4, got ${tier}`);
  }
  return tier;
}

/**
 * buyGems: `if (count == 0) revert ZeroAmount();`
 *           `if (rarity > Rarity.Uncommon) revert RarityNotForSale();`
 *
 * Rarity 0 = Common, 1 = Uncommon. Rare+ is HUNT-ONLY by design (SPEC §4,
 * R1) -- an ETH path to Rare would make hunting decorative.
 */
export function checkBuy(rarity, count) {
  if (typeof rarity !== 'number' || !Number.isInteger(rarity) || rarity < 0 || rarity > 1) {
    throw new WalletError('rarity-not-for-sale', `buyGems: rarity must be 0 (Common) or 1 (Uncommon), got ${typeof rarity === 'string' ? `"${rarity}"` : String(rarity)}`);
  }
  let n;
  try {
    n = BigInt(count);
  } catch {
    throw new WalletError('zero-amount', `buyGems: count must be an integer, got ${String(count)}`);
  }
  if (n <= 0n) {
    throw new WalletError('zero-amount', `buyGems: count must be > 0, got ${String(count)}`);
  }
  return { rarity, count: n };
}

// --- calldata --------------------------------------------------------------
//
// These return BARE hex (no `0x`), so `send()` prefixes exactly once. An
// earlier version returned chain.js's `0x`-prefixed `sel()` value and `send()`
// prepended another -- `0x0xcbc15b3a...`, which is not valid hex and would
// have failed in the wallet rather than here. Length is the cheap guard:
// calldata must be exactly 8 + 64*n characters.

// `claimTool(uint8)` -- 8 + 64 hex chars.
export function calldataClaimTool(tier) {
  const t = checkTier(tier);
  return sel('claimTool(uint8)').slice(2) + encUint8(t);
}

/**
 * `buyGems(uint8,uint256)` -- 8 + 64 + 64 hex chars.
 *
 * PAYABLE: the wei value travels in the transaction envelope, not in the
 * calldata, so it is deliberately absent here. The contract checks
 * `msg.value < priceOf(rarity) * count`.
 */
export function calldataBuyGems(rarity, count) {
  const { rarity: r, count: n } = checkBuy(rarity, count);
  return sel('buyGems(uint8,uint256)').slice(2) + encUint8(r) + encUint256(n);
}

/** The 4-byte selector of a bare-hex calldata blob. */
export function decodeHeader(data) {
  return '0x' + String(data).replace(/^0x/, '').slice(0, 8);
}

// --- provider + state ------------------------------------------------------

const state = {
  provider: null,
  account: null,
  chainId: null,
  listeners: new Set(),
  wired: false,
};

/** Reset module state. For tests and for an explicit teardown. */
export function resetWallet() {
  state.provider = null;
  state.account = null;
  state.chainId = null;
  state.wired = false;
}

/** window.ethereum, or null. Safe under Node (no window at all). */
export function getProvider(explicit) {
  if (explicit) return explicit;
  if (state.provider) return state.provider;
  if (typeof window === 'undefined') return null;
  return window.ethereum ?? null;
}

/** Current known account, or null. Never throws. */
export function getAccount() {
  return state.account;
}

/** Current known chain id, or null. Never throws. */
export function getChainId() {
  return state.chainId;
}

/**
 * Snapshot for the UI. `connected` means "we have an account AND the chain
 * is the game chain" -- a wrong-chain wallet is NOT connected, deliberately.
 */
export function getState() {
  const account = state.account;
  const chainId = state.chainId;
  const rightChain = chainId === GAME_CHAIN_ID;
  const connected = Boolean(account) && rightChain;
  let reason = null;
  if (!account) reason = 'not-connected';
  else if (!rightChain) reason = `wrong-chain:${chainId}`;
  return { account, chainId, rightChain, connected, reason };
}

// --- listener API ----------------------------------------------------------

/**
 * Subscribe to wallet state changes.
 *
 *   onWallet(({ account, chainId, connected, reason, event }) => ...)
 *   returns an unsubscribe function.
 *
 * `event` is one of 'connected' | 'accounts' | 'chain' | 'disconnect'.
 * Listeners never fire for state we did not observe.
 */
export function onWallet(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

function emit(event) {
  const snap = { ...getState(), event };
  for (const fn of state.listeners) {
    try {
      fn(snap);
    } catch (e) {
      // A listener that throws must not stop the others or wedge the
      // provider callbacks, so the failure is reported and swallowed.
      console.error('wallet listener failed', e);
    }
  }
}

/**
 * Attach EIP-1193 listeners once per provider.
 *
 * `chainChanged` emits a chain id that may be WRONG -- getState() will report
 * connected=false and the UI is expected to offer switchToGameChain().
 * `accountsChanged` with an empty array means "locked / disconnected", not
 * "the user is on no account", and is reported as a disconnect.
 */
export function installListeners(provider) {
  const p = getProvider(provider);
  if (!p || typeof p.on !== 'function') return false;
  if (state.wired && state.provider === p) return true;
  state.provider = p;
  state.wired = true;
  p.on('accountsChanged', (accounts) => {
    const next = Array.isArray(accounts) && accounts.length ? accounts[0] : null;
    const changed = next !== state.account;
    state.account = next;
    if (changed) emit(next ? 'accounts' : 'disconnect');
  });
  p.on('chainChanged', (hex) => {
    let id = null;
    try {
      id = fromQuantity(hex);
    } catch {
      id = null;
    }
    const changed = id !== state.chainId;
    state.chainId = id;
    if (changed) emit('chain');
  });
  p.on('disconnect', () => {
    state.account = null;
    emit('disconnect');
  });
  return true;
}

/** Map a provider rejection to a stable code. EIP-1193 code 4001 = user. */
function errCode(e) {
  if (e && e.code === 4001) return 'rejected';
  if (e && e.code === 4902) return 'chain-unknown';
  if (e && e.code === -32002) return 'request-pending';
  return 'provider-error';
}

// --- connect ---------------------------------------------------------------

/**
 * Ask the wallet for an account and verify the chain.
 *
 * Returns `{ok:true, account, chainId, rightChain, connected}` or
 * `{ok:false, code, reason}`. NEVER throws and NEVER reports a wrong-chain
 * wallet as connected. Does not switch chains -- the caller decides whether
 * to prompt, which is why `switchToGameChain` is separate.
 *
 * @param {object} [o]
 * @param {object} [o.provider] injected EIP-1193 provider (tests)
 * @param {boolean} [o.silent] use eth_accounts instead of eth_requestAccounts,
 *                             i.e. do not open the wallet's connect prompt
 */
export async function connect({ provider, silent = false } = {}) {
  const p = getProvider(provider);
  if (!p || typeof p.request !== 'function') {
    return {
      ok: false,
      code: 'no-provider',
      reason: 'no EIP-1193 wallet found (window.ethereum). Install one, or use a dApp browser.',
    };
  }
  state.provider = p;

  try {
    const accounts = silent
      ? await p.request({ method: 'eth_accounts' })
      : await p.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || accounts.length === 0) {
      state.account = null;
      return { ok: false, code: 'no-accounts', reason: 'wallet returned no accounts' };
    }
    const chainId = fromQuantity(await p.request({ method: 'eth_chainId' }));
    state.account = accounts[0];
    state.chainId = chainId;
    installListeners(p);

    const rightChain = chainId === GAME_CHAIN_ID;
    const snap = getState();
    emit(rightChain ? 'connected' : 'chain');
    if (!rightChain) {
      // Hard error, same stance as live.js's chain-mismatch guard: the
      // account is real but nothing it signs may touch the game contract.
      return {
        ok: false,
        code: 'wrong-chain',
        reason: `wallet is on chain ${chainId}, game is on ${GAME_CHAIN_ID}`,
        account: accounts[0],
        chainId,
        rightChain: false,
        connected: false,
      };
    }
    return { ok: true, ...snap };
  } catch (e) {
    const code = errCode(e);
    return {
      ok: false,
      code,
      reason: code === 'rejected' ? 'connection rejected in the wallet' : String(e?.message || e),
    };
  }
}

/**
 * Switch the wallet to the game chain, adding it first if unknown.
 *
 *   4902 "Unrecognized chain ID" -> wallet_addEthereumChain -> retry
 *
 * Uses config.rpcUrl for the add request. There is no API key on that endpoint
 * and none is needed; nothing secret may be put in a wallet-add URL, since the
 * user can read what the site asks their wallet to store.
 */
export async function switchToGameChain({ provider } = {}) {
  const p = getProvider(provider);
  if (!p || typeof p.request !== 'function') {
    return { ok: false, code: 'no-provider', reason: 'no EIP-1193 wallet found (window.ethereum)' };
  }
  const target = toQuantity(GAME_CHAIN_ID);
  const params = {
    chainId: target,
    chainName: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [config.rpcUrl],
  };

  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
  } catch (e) {
    if (errCode(e) !== 'chain-unknown') {
      const code = errCode(e);
      return {
        ok: false,
        code,
        reason: code === 'rejected' ? 'chain switch rejected in the wallet' : String(e?.message || e),
      };
    }
    try {
      await p.request({ method: 'wallet_addEthereumChain', params: [params] });
    } catch (e2) {
      const code = errCode(e2);
      return {
        ok: false,
        code,
        reason: code === 'rejected' ? 'chain add rejected in the wallet' : String(e2?.message || e2),
      };
    }
  }

  // The provider is the authority on where the wallet ended up -- do not
  // assume the switch took, and do not assume our cached chain id is stale-free.
  try {
    const chainId = fromQuantity(await p.request({ method: 'eth_chainId' }));
    state.chainId = chainId;
    const rightChain = chainId === GAME_CHAIN_ID;
    if (state.account) emit('chain');
    if (!rightChain) {
      return {
        ok: false,
        code: 'wrong-chain',
        reason: `wallet reports chain ${chainId} after switching, expected ${GAME_CHAIN_ID}`,
        chainId,
      };
    }
    return { ok: true, chainId, ...getState() };
  } catch (e) {
    return { ok: false, code: 'bad-chain', reason: String(e?.message || e) };
  }
}

// --- write path ------------------------------------------------------------

/** Common preconditions for a write. Returns null when ready. */
function notReady() {
  const p = getProvider();
  if (!p || typeof p.request !== 'function') {
    return { ok: false, code: 'no-provider', reason: 'connect a wallet first' };
  }
  if (!state.account) {
    return { ok: false, code: 'not-connected', reason: 'connect a wallet first' };
  }
  if (state.chainId !== GAME_CHAIN_ID) {
    return {
      ok: false,
      code: 'wrong-chain',
      reason: `wallet is on chain ${state.chainId}, game is on ${GAME_CHAIN_ID}`,
    };
  }
  if (!config.gameAddress) {
    return { ok: false, code: 'not-configured', reason: 'GAME_ADDRESS not set - nothing to send to' };
  }
  return null;
}

/** eth_sendTransaction with a typed result and no throw. */
async function send(data, { valueWei } = {}) {
  const blocked = notReady();
  if (blocked) return blocked;
  const tx = { from: state.account, to: config.gameAddress, data: '0x' + data };
  if (valueWei !== undefined) tx.value = toQuantity(valueWei);
  try {
    const hash = await getProvider().request({ method: 'eth_sendTransaction', params: [tx] });
    return { ok: true, hash, from: state.account, to: config.gameAddress, tx };
  } catch (e) {
    const code = errCode(e);
    return {
      ok: false,
      code,
      reason: code === 'rejected' ? 'transaction rejected in the wallet' : String(e?.message || e),
    };
  }
}

/**
 * Claim a tool tier. Tier 1 is free; 2..4 cost gems and must be claimed in
 * order (the chain enforces both -- TierLocked / ToolAlreadyOwned).
 *
 * @returns {Promise<{ok:boolean, hash?:string, code?:string, reason?:string}>}
 */
export async function claimTool(tier) {
  let data;
  try {
    data = calldataClaimTool(tier);
  } catch (e) {
    return { ok: false, code: e.code || 'bad-arg', reason: e.message };
  }
  return send(data);
}

/**
 * Buy gems. Common (0) and Uncommon (1) only; Rare+ is hunt-only.
 *
 * @param {number} rarity 0 or 1
 * @param {number|bigint} count > 0
 * @param {object} [o]
 * @param {bigint|number|string} [o.valueWei] wei to send. Required by the
 *        contract: `if (msg.value < cost) revert ZeroAmount();`
 * @param {bigint|number|string} [o.priceWei] on-chain priceOf(rarity), for a
 *        pre-flight underpayment check. Omit it and the chain decides.
 * @returns {Promise<{ok:boolean, hash?:string, code?:string, reason?:string}>}
 */
export async function buyGems(rarity, count, { valueWei, priceWei } = {}) {
  let data;
  try {
    data = calldataBuyGems(rarity, count);
  } catch (e) {
    return { ok: false, code: e.code || 'bad-arg', reason: e.message };
  }
  if (valueWei === undefined || valueWei === null) {
    return { ok: false, code: 'bad-arg', reason: 'buyGems needs { valueWei } -- buyGems is payable' };
  }
  // Value validation happens BEFORE the wallet is touched, so an underpayment
  // names itself instead of reporting whatever preflight happens to fail
  // first -- a "not-configured" complaint about an unaffordable purchase is
  // true and useless.
  let value;
  try {
    value = BigInt(valueWei);
  } catch {
    return { ok: false, code: 'bad-arg', reason: `valueWei is not an integer: ${String(valueWei)}` };
  }
  if (value < 0n) {
    return { ok: false, code: 'bad-arg', reason: `valueWei must be >= 0, got ${value}` };
  }
  if (priceWei !== undefined && priceWei !== null) {
    let cost;
    try {
      cost = BigInt(priceWei) * BigInt(count);
    } catch {
      return { ok: false, code: 'bad-arg', reason: `priceWei is not an integer: ${String(priceWei)}` };
    }
    if (value < cost) {
      // Caught before the wallet opens, so the player is not asked to sign a
      // transaction the chain will revert.
      return {
        ok: false,
        code: 'zero-amount',
        reason: `value ${value} wei is below the ${cost} wei cost of ${count} gem(s)`,
      };
    }
  }
  return send(data, { valueWei: value });
}