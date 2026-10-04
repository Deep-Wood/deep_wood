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
import * as econ from './economy.js';
import * as season from './season.js';

/** Mirror object in the shape diffEconomy() expects from the client side. */
function clientMirror() {
  return {
    BPS_DENOMINATOR: 10_000n,
    BURN_FEE_BPS: econ.TREASURY_BPS,
    SEASON_LENGTH: season.SEASON_LENGTH_SEC,
    HUNT_COOLDOWN: season.HUNT_COOLDOWN,
    SPLAY_FLOOR_WEI: season.SPLAY_FLOOR_WEI,
    // Five tiers now, and the limits have all changed with them (spec s12):
    // MAX_TIER 4 -> 5, hunt cost 0.0001..0.0008 -> 0. The contract is being
    // redeployed to match; until it is, this drift guard is EXPECTED to fire,
    // and that is the point -- it is the thing that tells us the redeploy
    // landed with the numbers the frontend already assumes.
    MAX_TIER: econ.MAX_TIER,
    toolCost: econ.toolPrice,
    durabilityOf: econ.durabilityOf,
    repairCost: (tier) => BigInt(econ.repairCost(tier).reduce(
      (sum, n, r) => sum + BigInt(n) * econ.FACE_VALUE[r], 0n,
    ) / 1n),
    huntCostWei: () => 0n,
    // diffEconomy() indexes these directly (`mirror.GEM_PRICE[r]`), so dropping
    // them made every parity read throw "Cannot read properties of undefined
    // (reading '0')" -- the guard could not report drift because it crashed
    // before it got to compare anything.
    GEM_PRICE: econ.FACE_VALUE,
    RARITY_WEIGHT: econ.RARITY_WEIGHT,
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

// 12s, not 6s. The deadline exists to catch a promise that NEVER settles, not
// to race a legitimately slow read: bootChain makes several sequential calls
// (eth_chainId, then the season reads, then the seed), and a cold browser
// connection with DNS + TLS + CORS preflight measured ~5-6s for the whole
// sequence. A 6s ceiling turned a healthy chain into a FALSE "offline - retry",
// which is worse than a slow chip: it tells the player the contract is gone.
// A true hang still costs one attempt, not the session.
export async function withRetry(fn, attempts = 3, baseMs = 400, attemptMs = 12000) {
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
    chain = await connect({
      rpcUrl: config.rpcUrl,
      fallbackRpcUrls: config.fallbackRpcUrls,
      address: config.gameAddress,
      player,
    });
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

    // Is the deployed contract the one this build targets?
    //
    // ECONOMY-SPEC.md is not yet implemented on chain: the deployed contract is
    // still the four-tier, gem-priced, 0.0001-ETH-hunt build. That makes every
    // diff entry EXPECTED for now. Reporting it as plain `drift` would be
    // crying wolf -- and a guard that cries wolf is a guard everyone learns to
    // ignore, which is how the original 10x hunt-cost bug survived.
    //
    // So it is detected and reported as its own state. The fingerprint is
    // dropTable(1): the old build gives a tier-1 tool 10% Amber, the new one
    // gives it Quartz only. That single value cannot be ambiguous between the
    // two designs.
    const deployedIsPreRedeploy =
      onChain.tiers?.[1]?.table?.[1] > 0n;
    const driftMeaningful = deployedIsPreRedeploy ? [] : drift;

    return { ok: true, chain, onChain, drift: driftMeaningful, rawDrift: drift, deployedIsPreRedeploy };
  } catch (e) {
    return { ok: false, reason: `RPC error: ${e.message}` };
  }
}

/** One-line summary for the topbar. */
export function describe(result) {
  if (!result.ok) return result.reason;
  const { onChain } = result;
  const bits = [`chain ${config.chainId}`, 'contract live'];
  if (result.deployedIsPreRedeploy) bits.push('pre-redeploy (spec not yet on chain)');
  if (onChain?.current) bits.push(`season ${onChain.current.id ?? '?'}`);
  if (config.tokenAddress) bits.push(`token ${config.tokenAddress.slice(0, 6)}…${config.tokenAddress.slice(-4)}`);
  if (result.drift?.length) bits.push(`${result.drift.length} drift`);
  return bits.join(' · ');
}