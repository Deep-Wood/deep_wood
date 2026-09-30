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
  if (result.drift?.length) bits.push(`${result.drift.length} drift`);
  return bits.join(' · ');
}