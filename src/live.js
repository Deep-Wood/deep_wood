/**
 * Live chain connection for the game.
 *
 * connect() in chain.js is a pure reader. This module is the part that
 * actually BOOTSTRAPS it: verify a contract is really there, verify it is on
 * the chain we think it is, read the live economy, and run the drift guard
 * against the client's off-chain mirror.
 *
 * Failure is never fatal. The game is playable offline, so a dead RPC or a
 * missing address downgrades to the simulation and reports why, rather than
 * leaving a blank canvas.
 */

import { connect, diffEconomy } from './chain.js';
import { config, configProblem, isConfigured } from './config.js';
import * as tools from './tools.js';
import * as season from './season.js';

/** Mirror object in the shape diffEconomy() expects from the client side. */
function clientMirror() {
  return {
    BPS_DENOMINATOR: tools.BPS_DENOMINATOR,
    BURN_FEE_BPS: tools.BURN_FEE_BPS,
    SEASON_LENGTH: season.SEASON_LENGTH_SEC,
    HUNT_COOLDOWN: tools.HUNT_COOLDOWN,
    SPLAY_FLOOR_WEI: season.SPLAY_FLOOR_WEI,
    MAX_TIER: tools.MAX_TIER,
    toolCost: tools.toolCost,
    durabilityOf: tools.durabilityOf,
    repairCost: tools.repairCost,
    huntCostWei: tools.huntCostWei,
    // These live in season.js, NOT tools.js. Reading them off tools gave
    // undefined, and diffEconomy then threw on `undefined[0]`.
    GEM_PRICE: season.GEM_PRICE,
    RARITY_WEIGHT: season.RARITY_WEIGHT,
  };
}

/**
 * Retry an operation that failed for a transient reason.
 *
 * The live read fires ~36 JSON-RPC calls at boot. It was measured failing
 * outright on roughly one page load in three with `RPC error: Failed to fetch`
 * -- and because bootChain() had no retry, a single dropped connection
 * downgraded the whole session to the offline simulation permanently, with no
 * recovery short of a page reload. On a phone that is a real exposure.
 *
 * Only the "whole read failed" case is retried. A result that came back but
 * said `chain mismatch` or `contract is paused` is a real answer and must be
 * reported immediately, not asked again -- retrying those would just delay the
 * truth the player needs to see.
 *
 * @param {() => Promise<T>} fn
 * @param {number} attempts total tries, including the first
 * @param {number} baseMs first backoff delay; doubles each retry
 */
/**
 * Per-attempt deadline.
 *
 * withRetry only retries on FAILURE, and a fetch that never settles is not a
 * failure -- it is a promise that never resolves. A single hung JSON-RPC read on
 * a phone network left the chain chip reading "checking..." indefinitely: no
 * error, no retry, no fallback, because the await never came back. A state that
 * is not bounded in time is not a state.
 */
function deadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function withRetry(fn, attempts = 3, baseMs = 400, attemptMs = 6000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      // Exponential backoff, so a burst of retries does not hammer an endpoint
      // that is already struggling -- which is a likely cause in the first place.
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1)));
    }
    try {
      const r = await deadline(Promise.resolve().then(fn), attemptMs, 'chain read');
      if (r.ok) return r;
      last = r;
      // A definitive answer, not a transport failure: stop and report it.
      if (!/RPC error|bad config|could not reach/i.test(r.reason || '')) return r;
    } catch (e) {
      last = { ok: false, reason: `RPC error: ${e.message}` };
    }
  }
  return last;
}

/**
 * @param {object} [o]
 * @param {string} [o.player] wallet address for per-player reads
 * @returns {Promise<{ok:boolean, reason?:string, chain?:object, drift?:string[], onChain?:object}>}
 */
export async function bootChain({ player } = {}) {
  const problem = configProblem();
  if (problem) return { ok: false, reason: problem };

  let chain;
  try {
    // connect() is async -- awaiting it yields the handle. Calling it without
    // await yields a Promise, which then looks like an object with no methods.
    chain = await connect({ rpcUrl: config.rpcUrl, address: config.gameAddress, player });
  } catch (e) {
    return { ok: false, reason: `bad config: ${e.message}` };
  }

  try {
    const alive = await chain.ping();
    if (!alive) {
      return { ok: false, reason: `no contract at ${config.gameAddress}` };
    }

    // Chain-id guard. Reading the right contract on the wrong chain is worse
    // than not reading it at all: the addresses are valid but meaningless.
    const liveChainId = await chain.chainId();
    if (liveChainId !== config.chainId) {
      return {
        ok: false,
        reason: `chain mismatch: expected ${config.chainId}, RPC is on ${liveChainId}`,
      };
    }

    const paused = await chain.paused();
    if (paused) return { ok: false, reason: 'contract is paused' };

    const onChain = await chain.readEconomy();
    const drift = diffEconomy(onChain, clientMirror());

    return { ok: true, chain, onChain, drift };
  } catch (e) {
    return { ok: false, reason: `RPC error: ${e.message}` };
  }
}

/** One-line summary for the topbar. */
export function describe(result) {
  if (!result.ok) return result.reason;
  const { onChain } = result;
  const bits = [`chain ${config.chainId}`, 'contract live'];
  if (onChain?.current) bits.push(`season ${onChain.current.id ?? '?'}`);
  if (config.tokenAddress) bits.push(`token ${config.tokenAddress.slice(0, 6)}…${config.tokenAddress.slice(-4)}`);
  if (result.drift?.length) bits.push(`${result.drift.length} drift`);
  return bits.join(' · ');
}