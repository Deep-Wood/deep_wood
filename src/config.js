/**
 * Runtime configuration for the live game.
 *
 * Addresses are NOT baked into source. They arrive from the environment at
 * build time (Vite) with local dev defaults, so the same bundle can be
 * pointed at testnet or mainnet without editing code.
 *
 * Env vars (Vite only exposes VITE_* to the client):
 *   VITE_RPC_URL       JSON-RPC endpoint (primary)
 *   VITE_RPC_FALLBACKS comma-separated backup endpoints, tried in order.
 *                      Needed because the primary endpoint has been observed
 *                      serving WRONG answers rather than errors -- it returned a
 *                      short code blob for a contract with 36KB of code, and
 *                      once fell back to a local node. A failed request is
 *                      easy to retry; a confidently wrong one is not.
 *   VITE_GAME_ADDRESS  deployed DeepWood address
 *   VITE_CHAIN_ID      expected chain id, decimal. Guards against the site
 *                      silently reading the wrong chain after a bad deploy.
 *   VITE_TOKEN_ADDRESS optional, shown in the UI when wired
 *
 * Nothing here is a secret. These are public read endpoints and public
 * addresses; anything that needed a key would not belong in a client bundle.
 */

const env = (() => {
  // Vite injects import.meta.env at build time. Under plain `node --test`
  // that object does not exist, so read process.env as a fallback -- without
  // it the live tests skip silently and pass for the wrong reason.
  if (typeof import.meta !== 'undefined' && import.meta.env) return import.meta.env;
  if (typeof process !== 'undefined' && process.env) return process.env;
  return {};
})();

/** Testnet defaults, used when the build has no env configured. */
export const DEFAULTS = {
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  // A second provider, so a single endpoint answering incorrectly cannot make
  // the whole game read as broken (or, worse, read as correct). Chain 46630.
  fallbackRpcUrls: ['https://robinhood-testnet.drpc.org'],
  chainId: 46630,
};

export const config = {
  rpcUrl: env.VITE_RPC_URL || DEFAULTS.rpcUrl,
  /** Backups tried in order when the primary is unreachable or wrong. */
  fallbackRpcUrls: (
    env.VITE_RPC_FALLBACKS !== undefined && env.VITE_RPC_FALLBACKS !== ''
      ? String(env.VITE_RPC_FALLBACKS)
      : (DEFAULTS.fallbackRpcUrls || []).join(',')
  )
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u && u !== DEFAULTS.rpcUrl),
  gameAddress: (env.VITE_GAME_ADDRESS || '').trim(),
  chainId: Number(env.VITE_CHAIN_ID || DEFAULTS.chainId),
  tokenAddress: (env.VITE_TOKEN_ADDRESS || '').trim(),
};

/**
 * Why the game is running without a contract, if it is.
 *
 * The game is fully playable offline -- the simulation is the same code the
 * smoke test exercises. But an UNCONFIGURED build must say so plainly rather
 * than letting a visitor believe they are playing the real on-chain game.
 */
export function configProblem() {
  if (!config.gameAddress) {
    return 'GAME_ADDRESS not set - running the offline simulation, not the on-chain game';
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.gameAddress)) {
    return `GAME_ADDRESS is not a valid address: ${config.gameAddress}`;
  }
  return null;
}

export const isConfigured = () => configProblem() === null;