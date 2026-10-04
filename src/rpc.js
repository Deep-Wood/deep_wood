/**
 * JSON-RPC with failover across providers.
 *
 * WHY THIS EXISTS
 * ===============
 * The primary endpoint has been observed returning confidently WRONG answers
 * rather than failing: a short code blob for a contract holding 36KB, and once
 * an empty response because the client fell back to a local node. Ordinary
 * error handling cannot catch that -- the response is valid JSON, correctly
 * shaped, and wrong.
 *
 * A player seeing a wrong balance cannot tell they are seeing a wrong balance.
 * The defence is to treat an implausible answer as a failure and try elsewhere.
 *
 * READ path only. Writes go through the player's wallet provider, never here --
 * choosing an endpoint for a transaction is not a fallback list's decision.
 */
import { config } from './config.js';

/** Every endpoint to try, primary first, de-duplicated. */
export function rpcEndpoints() {
  return [config.rpcUrl, ...(config.fallbackRpcUrls || [])].filter(
    (u, i, all) => u && all.indexOf(u) === i,
  );
}

/**
 * Call a JSON-RPC method, trying each endpoint until one answers plausibly.
 *
 * @param {string} method        e.g. 'eth_getBalance'
 * @param {Array}  params        e.g. [address, 'latest']
 * @param {object} opts
 * @param {number} opts.minHexChars  reject hex results shorter than this. This
 *        is the guard against the silent-wrong-answer failure: an `eth_getCode`
 *        or `eth_getBalance` that returns a one-byte hex string is not a
 *        plausible answer, so it is treated as a failed read rather than a
 *        result to believe.
 * @returns {Promise<any>} the result, or null if every endpoint failed
 */
export async function rpcCall(method, params = [], { minHexChars = 0 } = {}) {
  const errors = [];
  for (const url of rpcEndpoints()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await res.json();

      // An explicit JSON-RPC error is a REAL answer ("reverted", "not found"),
      // so stop rather than asking a second provider to also say no.
      if (j?.error) return null;

      const result = j?.result;
      if (result === undefined || result === null) throw new Error('empty result');

      if (minHexChars > 0 && typeof result === 'string') {
        const body = result.startsWith('0x') ? result.slice(2) : result;
        if (body.length < minHexChars) {
          throw new Error(`implausible result: ${body.length} hex chars, need ${minHexChars}`);
        }
      }
      return result;
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  if (errors.length && typeof console !== 'undefined') {
    console.warn(`[rpc] all endpoints failed for ${method}:`, errors.join(' | '));
  }
  return null;
}
