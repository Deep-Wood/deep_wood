/**
 * On-chain backing for the toolbelt.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORUR
 * ======================================
 * Never grant a local item because a transaction was sent. On chain 46630 a
 * reverted call still produces a receipt with `status: 0x1`, so neither a
 * returned hash nor a receipt proves anything. The only trustworthy signal is
 * the contract's own state changing.
 *
 * Verified on Robinhood Chain Testnet against the live DeepWood contract:
 * `claimTool(1)` from a wallet already owning tier 1 (must revert
 * ToolAlreadyOwned) returned a hash normally AND reported a successful
 * receipt, while `toolCount(player)` stayed at 1 -> 1. It reverted; the
 * receipt lied.
 *
 * So every write here is: snapshot the authoritative value, send, then poll
 * until that value actually moves. Only then does the caller learn it
 * succeeded. "Did not move" is a failure, and nothing is granted.
 *
 * When no wallet is connected the caller falls back to the local simulation in
 * tools.js, which is unchanged and still preview-only.
 */
import { getState, claimTool as wcClaimTool, buyGems as wBuyGems } from './wallet.js';
import { connect as readConnect } from './chain.js';
import { config } from './config.js';

/** Rarities the contract sells. Rare+ are hunt-only and revert. */
export const FOR_SALE = [0, 1];
export const RARITY_NAME_ONSALE = { 0: 'Common', 1: 'Uncommon' };

const POLL_INTERVAL_MS = 1200;
const POLL_ATTEMPTS = 20; // ~24s; a testnet block is sub-second in practice

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A failed result, shaped like wallet.js's so callers handle one shape. */
const fail = (code, reason) => ({ ok: false, code, reason });

/**
 * Poll `read()` until it returns a value that satisfies `moved`, or give up.
 * @returns {Promise<{changed: boolean, value: any, waited: number}>}
 */
async function pollUntilChanged(read, before, moved) {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    let value;
    try {
      value = await read();
    } catch {
      continue; // transient RPC hiccup mid-flight; keep trying
    }
    if (moved(before, value)) return { changed: true, value, waited: i + 1 };
  }
  return { changed: false, value: undefined, waited: POLL_ATTEMPTS };
}

let reader = null;

/**
 * Test seam: inject a fake read handle.
 *
 * The confirmation logic (poll until the contract's value moves) is the
 * property worth testing, and it is unreachable without a real funded wallet
 * otherwise. Exported so tests can drive the real code path, not a copy.
 * @param {object|null} r
 */
export function __setReader(r) {
  reader = r;
}

/** Lazily open (and reuse) the read-only handle. */
async function getReader() {
  if (reader) return reader;
  if (!config.gameAddress) return null;
  reader = await readConnect({ rpcUrl: config.rpcUrl, address: config.gameAddress });
  return reader;
}

/** True when writes would go to the chain rather than the local simulation. */
export function onchainActive() {
  return getState().connected && Boolean(config.gameAddress);
}

/** How the UI should describe itself right now. */
export function mode() {
  if (!config.gameAddress) return 'offline';
  return onchainActive() ? 'onchain' : 'preview';
}

/**
 * Claim a tool tier on chain.
 *
 * Sends the transaction, then waits for `toolCount(account)` to increase.
 * Grants nothing unless it does.
 *
 * @param {number} tier 1..4
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, fee?:number,
 *                    hash?:string, confirmed?:boolean}>}
 */
export async function claimToolOnchain(tier) {
  const r = await getReader();
  if (!r) return fail('not-configured', 'GAME_ADDRESS not set - no contract to write to');

  const { account } = getState();
  const before = await r.toolCount(account);

  const sent = await wcClaimTool(tier);
  if (!sent.ok) return fail(sent.code || 'send-failed', sent.reason || 'transaction was not sent');

  const after = await pollUntilChanged(
    () => r.toolCount(account),
    before,
    (b, a) => a > b,
  );

  if (!after.changed) {
    // The tx was broadcast but the contract never applied it: it reverted.
    // The receipt would have said 'success'. Do not grant anything.
    return fail('reverted', 'contract did not apply the claim (it reverted) - nothing granted');
  }

  return { ok: true, hash: sent.hash, confirmed: true, count: after.value };
}

/**
 * Buy gems on chain. Common (0) and Uncommon (1) only.
 *
 * Confirms via `gemsOf(account, rarity)` increasing. `priceWei` should come
 * from the chain's own `priceOf` so we never guess a price.
 *
 * @param {number} rarity 0 or 1
 * @param {number} count > 0
 * @param {bigint} priceWei on-chain priceOf(rarity)
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, hash?:string}>}
 */
export async function buyGemsOnchain(rarity, count, priceWei) {
  const r = await getReader();
  if (!r) return fail('not-configured', 'GAME_ADDRESS not set - no contract to write to');
  if (!FOR_SALE.includes(rarity)) {
    return fail('not-for-sale', `${rarity >= 2 ? 'Rare+' : 'that rarity'} is hunt-only, not for sale`);
  }
  if (!Number.isInteger(count) || count <= 0) {
    return fail('bad-arg', `count must be a positive integer, got ${count}`);
  }
  if (priceWei === undefined || priceWei === null) {
    return fail('bad-arg', 'priceWei is required - read it from the chain, never guess');
  }

  const { account } = getState();
  const before = await r.gemsOf(account, rarity);
  const value = BigInt(priceWei) * BigInt(count);

  const sent = await wBuyGems(rarity, count, { valueWei: value, priceWei });
  if (!sent.ok) return fail(sent.code || 'send-failed', sent.reason || 'transaction was not sent');

  const after = await pollUntilChanged(
    () => r.gemsOf(account, rarity),
    before,
    (b, a) => a > b,
  );

  if (!after.changed) {
    return fail('reverted', 'contract did not apply the purchase (it reverted) - nothing credited');
  }

  return { ok: true, hash: sent.hash, confirmed: true, count: after.value, spentWei: value };
}

/** Read the on-chain price for a sellable rarity. null if unavailable. */
export async function priceFor(rarity) {
  const r = await getReader();
  if (!r) return null;
  try {
    return await r.priceOf(rarity);
  } catch {
    return null;
  }
}
