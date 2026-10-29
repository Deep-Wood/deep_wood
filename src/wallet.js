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

import { SIGS } from "./chain.js";
import { config } from "./config.js";

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
    if (!v)
      throw new WalletError("unknown-selector", `no selector for "${sig}"`);
    SEL_MEMO.set(sig, v);
  }
  return SEL_MEMO.get(sig);
}

// --- errors ----------------------------------------------------------------

/** Named error for the throwing tier (pure builders). */
export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

// --- encoding (mirrors chain.js: hand-rolled, no dependency) ---------------

const UINT256_MAX = (1n << 256n) - 1n;

/** ABI-encode a uintN as one 32-byte word, with a range check. */
function encUint(n, bits, what) {
  let v;
  try {
    v = typeof n === "bigint" ? n : BigInt(n);
  } catch {
    throw new WalletError("bad-arg", `${what} is not an integer: ${String(n)}`);
  }
  if (v < 0n || v > (1n << BigInt(bits)) - 1n) {
    throw new WalletError("bad-arg", `${what} out of uint${bits} range: ${v}`);
  }
  return v.toString(16).padStart(64, "0");
}

export const encUint8 = (n) => encUint(n, 8, "uint8");
export const encUint256 = (n) => encUint(n, 256, "uint256");

/** ABI-encode an address (left-padded), with a shape check. */
export function encAddress(a) {
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new WalletError("bad-arg", `not an address: ${String(a)}`);
  }
  return a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** wei -> 0x hex quantity for an RPC field. */
export const toQuantity = (v) => "0x" + BigInt(v).toString(16);

/** Parse an RPC quantity ('0xb63a...') to a Number. Throws on garbage. */
export function fromQuantity(h) {
  if (h === null || h === undefined)
    throw new WalletError("bad-chain", "provider returned no chain id");
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
/**
 * V2 tier check: 1..MAX_TIER, which is FIVE.
 *
 * The client must mirror `MAX_TIER` from the contract rather than assume it.
 * V1 capped at 4 and this transcribed 4 as well; with V2 that would have made
 * Gold -- the top of the ladder -- permanently unreachable from the UI while
 * every test still passed, because the test used the same wrong constant.
 * Read `MAX_TIER()` off the chain at startup and pass it in; the default here
 * matches the contract today so a missing read is still correct.
 */
export const MAX_TIER_DEFAULT = 5;

export function checkTier(tier, maxTier = MAX_TIER_DEFAULT) {
  const range = `1..${maxTier}`;
  if (typeof tier !== "number" || !Number.isInteger(tier)) {
    throw new WalletError(
      "tier-out-of-range",
      `buyTool: tier must be an integer ${range}, got ${typeof tier === "string" ? `"${tier}"` : String(tier)}`,
    );
  }
  if (tier < 1 || tier > maxTier) {
    throw new WalletError(
      "tier-out-of-range",
      `buyTool: tier must be ${range}, got ${tier}`,
    );
  }
  return tier;
}

/**
 * Skill level check. The contract requires EXACTLY the next level
 * (`_burn(repairNeeds(skill + 1))`), so a jump of more than one is a revert,
 * not a discount.
 */
export function checkSkill(level) {
  if (
    typeof level !== "number" ||
    !Number.isInteger(level) ||
    level < 1 ||
    level > 4
  ) {
    throw new WalletError(
      "skill-out-of-range",
      `upgradeSkill: level must be an integer 1..4, got ${typeof level === "string" ? `"${level}"` : String(level)}`,
    );
  }
  return level;
}

/**
 * redeemGems: `if (count == 0) revert ZeroAmount();`
 *
 * Every rarity is redeemable in V2 -- there is no RarityNotForSale gate, since
 * gems are no longer purchasable at all. They are only ever mined, so any
 * rarity a player holds is theirs to cash out.
 */
export function checkRedeem(rarity, count) {
  if (
    typeof rarity !== "number" ||
    !Number.isInteger(rarity) ||
    rarity < 0 ||
    rarity > 4
  ) {
    throw new WalletError(
      "rarity-out-of-range",
      `redeemGems: rarity must be an integer 0..4, got ${typeof rarity === "string" ? `"${rarity}"` : String(rarity)}`,
    );
  }
  let n;
  try {
    n = BigInt(count);
  } catch {
    throw new WalletError(
      "zero-amount",
      `redeemGems: count must be an integer, got ${String(count)}`,
    );
  }
  if (n <= 0n) {
    throw new WalletError(
      "zero-amount",
      `redeemGems: count must be > 0, got ${String(count)}`,
    );
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
/**
 * `buyTool(uint8,uint256)` -- V6.
 *
 * NOT PAYABLE: V6 pulls DEEPWOOD via transferFrom, so the frontend must
 * approve the token spend first (see chain.js approveTokenTx). The second
 * argument is the maximum DEEPWOOD tokens (18 decimals) the player is
 * willing to spend, read live from toolCost(tier) on chain.
 *
 * SEQUENTIAL: the contract requires the next tier only (`held.tier + 1`).
 *
 * @param {number} tier 1..MAX_TIER (5)
 * @param {bigint|number} maxTokenCost DEEPWOOD tokens (18 decimals)
 */
export function calldataBuyTool(tier, maxTokenCost) {
  const t = checkTier(tier);
  return sel("buyTool(uint8,uint256)").slice(2) + encUint8(t) + encUint256(maxTokenCost);
}

/**
 * `repairTool()` -- no arguments.
 *
 * Not payable and takes nothing: the contract derives the exact gem vector
 * from the held tier via `repairNeeds`, so the client cannot ask to repair with
 * the wrong gems or the wrong count. It reverts NotBroken if durability is
 * above zero, so the button must be disabled unless the tool is broken.
 */
export function calldataRepairTool() {
  return sel("repairTool()").slice(2);
}

/**
 * `upgradeSkill(uint8)` -- 4 + 32 hex chars.
 *
 * Not payable. Skills cost GEMS, never ETH (`_burn` spends Quartz only), so
 * there is no value here -- a value would be silently absorbed by nothing and
 * strand funds in the contract.
 *
 * @param {number} level 1..4, must be exactly skill+1: the contract rejects
 *                        any other jump with RarityLocked
 */
export function calldataUpgradeSkill(level) {
  const n = checkSkill(level);
  return sel("upgradeSkill(uint8)").slice(2) + encUint8(n);
}

/**
 * `redeemGems(uint8,uint256)` -- 4 + 32 + 32 hex chars.
 *
 * Not payable. The payout comes OUT of the contract's own ETH backing, so
 * sending value with this call would be sending money to buy the thing you are
 * already being paid for.
 *
 * @param {number} rarity 0..4
 * @param {bigint|number} count > 0
 */
export function calldataRedeemGems(rarity, count) {
  const { rarity: r, count: n } = checkRedeem(rarity, count);
  return (
    sel("redeemGems(uint8,uint256)").slice(2) + encUint8(r) + encUint256(n)
  );
}

/**
 * V10 write builders: migrateFromV9, descend, study, fuse.
 *
 * All four are promptless single-purpose writes. Same conventions as every
 * other builder here: returns HEX, NO 0x PREFIX, selector included --
 * `send()` prepends '0x' and nothing else.
 */

/**
 * `migrateFromV9()` -- self-serve, one-shot. Pulls satchel, tool, skill,
 * hunt index, lifetime stats and season score from the legacy V9 contract
 * via its public views. Roll continuity: V10 committed V9's seed, so the
 * carried hunt index continues the same entropy stream.
 */
export function calldataMigrateFromV9() {
  return sel("migrateFromV9()").slice(2);
}

/**
 * `descend()` -- prestige. Wipes satchel, tool and skill for a permanent
 * find-weight multiplier derived from lifetime leq. Keeps research,
 * lifetime stats and board standing. Requires leq >= minLeqForDescend.
 */
export function calldataDescend() {
  return sel("descend()").slice(2);
}

/**
 * `study()` -- one luck research level. Burns `luckBase << level` Quartz;
 * luck adds bps to the find-weight multiplier for every future roll.
 */
export function calldataStudy() {
  return sel("study()").slice(2);
}

/**
 * `fuse(uint8,uint8)` -- burn `fusionRates[rarity] * times` of gem
 * `rarity`, credit `times` of gem `rarity + 1`. Steps 0..3 only
 * (Quartz->Amber .. Ruby->Diamond); the contract reverts FusionDisabled
 * beyond that or when the rate is zero.
 *
 * @param {number} rarity 0..3
 * @param {number} times  >= 1
 */
export function calldataFuse(rarity, times) {
  if (!Number.isInteger(rarity) || rarity < 0 || rarity > 3) {
    const e = new Error("rarity must be 0..3 (Quartz->Amber .. Ruby->Diamond)");
    e.code = "bad-arg";
    throw e;
  }
  if (!Number.isInteger(times) || times < 1) {
    const e = new Error("times must be a whole number >= 1");
    e.code = "bad-arg";
    throw e;
  }
  return sel("fuse(uint8,uint8)").slice(2) + encUint8(rarity) + encUint8(times);
}

/**
 * `settleBatch(address,uint8,uint256[5][],uint256[])` -- batch settle.
 *
 * Layout (all offsets relative to the START OF THE ARG BLOCK, i.e. after the
 * 4-byte selector):
 *   head:  player(32) tier(32) offsetA(32) offsetB(32)   -> 4 slots
 *   tail A at 0x80:  length(32) then N elements, each 5 inlined counts
 *   tail B:          length(32) then N bestSingleWei values
 *
 * Each uint256[5] is FIXED-SIZE, so inside the outer array the five counts are
 * inlined and NOT behind a pointer -- only the OUTER array is dynamic. Getting
 * this wrong is silent: the tx reverts ResultMismatch at best, or worse the
 * first hunt's counts are read as offsets and the whole thing decodes to
 * nonsense. Hence the byte-exact test that round-trips this against the
 * foundry harness.
 *
 * V6: bestSingleWei is still REQUIRED. The contract validates
 * `bestWei[k] == expectedBest` where expectedBest = priceOf(rolled rarity),
 * and reverts ResultMismatch otherwise. The migration that sent zeros here
 * misread the ABI change -- previewHunt still returns bestSingleWei as its
 * 6th word, and settleBatch still checks every entry.
 *
 * @param {string} player  the settling player's address (must be you)
 * @param {number} tier    1..4
 * @param {Array<(bigint|number)[]>} batch  N hunt results, each five counts
 *                                          from previewHunt, in dig order
 * @param {Array<(bigint|number)>} bests     N bestSingleWei values, one per
 *                                          hunt, from previewHunt word 6
 */
export function calldataSettleBatch(player, tier, batch, bests) {
  const t = checkTier(tier);
  if (!Array.isArray(batch) || batch.length === 0) {
    throw new WalletError(
      "bad-arg",
      "batch must be a non-empty array of hunts",
    );
  }
  if (batch.length > 20) {
    throw new WalletError(
      "bad-arg",
      `batch of ${batch.length} exceeds the contract cap (20)`,
    );
  }
  for (const counts of batch) {
    if (!Array.isArray(counts) || counts.length !== 5) {
      throw new WalletError(
        "bad-arg",
        "each hunt must be an array of exactly 5 rarity counts",
      );
    }
  }
  if (!Array.isArray(bests) || bests.length !== batch.length) {
    throw new WalletError(
      "bad-arg",
      "bests must be an array with one bestSingleWei per hunt",
    );
  }

  const n = batch.length;
  const headWords = 4; // player, tier, offsetA, offsetB
  // Tail A starts right after the head. Solidity's canonical ABI encoding for
  // a DYNAMIC array of STATIC element types (uint256[5]) lays the elements
  // INLINE after the length word -- there is NO per-element pointer array.
  // (The first version of this encoder emitted pointers, matching the rule
  // for dynamic arrays of DYNAMIC types; the contract decoded pointers as
  // gem counts and reverted ResultMismatch. Proven by byte-diffing against
  // `cast calldata` and dry-running both encodings on anvil: cast's passed,
  // the pointer layout reverted.)
  const tailAOffset = headWords * 32;
  const tailBOffset = tailAOffset + 32 + n * 5 * 32;

  let out = sel("settleBatch(address,uint8,uint256[5][],uint256[])").slice(2);
  out += encAddress(player);
  out += encUint8(t);
  out += encUint256(tailAOffset);
  out += encUint256(tailBOffset);

  // --- tail A: uint256[5][] -- length, then the elements inline ---
  out += encUint256(n);
  for (let i = 0; i < n; i++) {
    for (const c of batch[i]) out += encUint256(c);
  }

  // --- tail B: uint256[] bests -- one REAL bestSingleWei per hunt ---
  out += encUint256(n);
  for (let i = 0; i < n; i++) out += encUint256(bests[i]);
  return out;
}

/** The 4-byte selector of a bare-hex calldata blob. */
export function decodeHeader(data) {
  return "0x" + String(data).replace(/^0x/, "").slice(0, 8);
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
  if (typeof window === "undefined") return null;
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
  if (!account) reason = "not-connected";
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

/**
 * Disconnect the wallet from the page's perspective.
 *
 * "Disconnect" on a wallet is a misnomer -- the page cannot make Rabby (or any
 * EIP-1193 provider) forget the account; only the wallet can do that. What we
 * CAN do is what the user expects from a Disconnect button: clear our copy of
 * the account, stop listening for it, and surrender the approved
 * `eth_accounts` permission so the next `eth_requestAccounts` actually shows
 * the connect prompt instead of silently re-attaching the same account.
 *
 * `wallet_revokePermissions` is supported by Rabby, MetaMask (from flask /
 * recent stable), and most EIP-2255 wallets. On one that does not support it
 * the local reset still happens -- the page behaves as if disconnected and a
 * real rejection is shown next time the wallet tries to re-attach.
 */
export async function disconnect() {
  const p = getProvider();
  resetWallet();
  emit("disconnect");
  if (!p?.request) return { ok: false, reason: "no provider" };
  try {
    await p.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
    return { ok: true };
  } catch (err) {
    // -32601 = method not found (provider predates EIP-2255). Local state is
    // already cleared -- surface that as success with a caveat.
    return { ok: true, revoked: false, reason: err?.message?.slice(0, 120) };
  }
}

function emit(event) {
  const snap = { ...getState(), event };
  for (const fn of state.listeners) {
    try {
      fn(snap);
    } catch (e) {
      // A listener that throws must not stop the others or wedge the
      // provider callbacks, so the failure is reported and swallowed.
      console.error("wallet listener failed", e);
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
  if (!p || typeof p.on !== "function") return false;
  if (state.wired && state.provider === p) return true;
  state.provider = p;
  state.wired = true;
  p.on("accountsChanged", (accounts) => {
    const next =
      Array.isArray(accounts) && accounts.length ? accounts[0] : null;
    const changed = next !== state.account;
    state.account = next;
    if (changed) emit(next ? "accounts" : "disconnect");
  });
  p.on("chainChanged", (hex) => {
    let id = null;
    try {
      id = fromQuantity(hex);
    } catch {
      id = null;
    }
    const changed = id !== state.chainId;
    state.chainId = id;
    if (changed) emit("chain");
  });
  p.on("disconnect", () => {
    state.account = null;
    emit("disconnect");
  });
  return true;
}

/** Map a provider rejection to a stable code. EIP-1193 code 4001 = user. */
function errCode(e) {
  if (e && e.code === 4001) return "rejected";
  if (e && e.code === 4902) return "chain-unknown";
  if (e && e.code === -32002) return "request-pending";
  return "provider-error";
}

/**
 * The raw provider rejection, surfaced so the UI can show the user what the
 * wallet actually said instead of a generic "provider error". Wallets word
 * failures differently and -32601 ("method not found") reads as meaningless to
 * a player; errCode already classifies it, this only preserves the evidence.
 */
function errDetail(e) {
  if (!e || typeof e !== "object") return null;
  return {
    code: e.code ?? null,
    message: String(e.message ?? e).slice(0, 300),
    data: e.data ?? null,
  };
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
  if (!p || typeof p.request !== "function") {
    return {
      ok: false,
      code: "no-provider",
      reason:
        "no EIP-1193 wallet found (window.ethereum). Install one, or use a dApp browser.",
    };
  }
  state.provider = p;

  try {
    const accounts = silent
      ? await p.request({ method: "eth_accounts" })
      : await p.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || accounts.length === 0) {
      state.account = null;
      return {
        ok: false,
        code: "no-accounts",
        reason: "wallet returned no accounts",
      };
    }
    const chainId = fromQuantity(await p.request({ method: "eth_chainId" }));
    state.account = accounts[0];
    state.chainId = chainId;
    installListeners(p);

    const rightChain = chainId === GAME_CHAIN_ID;
    const snap = getState();
    emit(rightChain ? "connected" : "chain");
    if (!rightChain) {
      // Hard error, same stance as live.js's chain-mismatch guard: the
      // account is real but nothing it signs may touch the game contract.
      return {
        ok: false,
        code: "wrong-chain",
        reason: `wallet is on chain ${chainId}, game is on ${GAME_CHAIN_ID}`,
        account: accounts[0],
        chainId,
        rightChain: false,
        connected: false,
      };
    }
    import('./analytics.js').then(({ track }) => track('wallet_connect'));
    return { ok: true, ...snap };
  } catch (e) {
    const code = errCode(e);
    return {
      ok: false,
      code,
      reason:
        code === "rejected"
          ? "connection rejected in the wallet"
          : String(e?.message || e),
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
 * user can read what the site asks their wallet to store. The explorer URL is
 * included for the wallet's own "view on explorer" affordance.
 */
export async function switchToGameChain({ provider } = {}) {
  const p = getProvider(provider);
  if (!p || typeof p.request !== "function") {
    return {
      ok: false,
      code: "no-provider",
      reason: "no EIP-1193 wallet found (window.ethereum)",
    };
  }
  const target = toQuantity(GAME_CHAIN_ID);
  const params = {
    chainId: target,
    chainName: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [config.rpcUrl],
    blockExplorerUrls: ["https://explorer.testnet.chain.robinhood.com"],
  };

  try {
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: target }],
    });
  } catch (e) {
    if (errCode(e) !== "chain-unknown") {
      const code = errCode(e);
      return {
        ok: false,
        code,
        reason:
          code === "rejected"
            ? "chain switch rejected in the wallet"
            : String(e?.message || e),
        detail: errDetail(e),
      };
    }
    try {
      await p.request({ method: "wallet_addEthereumChain", params: [params] });
      // RETRY the switch. Adding a chain and switching to it are two separate
      // operations, and wallets differ: some auto-select a freshly added chain,
      // some leave the wallet where it was. Without this retry the et_chainId
      // check below reports 'wrong-chain' and the player is stuck staring at a
      // chain they just added. The doc comment promised this retry; the code
      // never did it.
      await p.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: target }],
      });
    } catch (e2) {
      const code = errCode(e2);
      return {
        ok: false,
        code,
        reason:
          code === "rejected"
            ? "chain add rejected in the wallet"
            : String(e2?.message || e2),
        detail: errDetail(e2),
      };
    }
  }

  // The provider is the authority on where the wallet ended up -- do not
  // assume the switch took, and do not assume our cached chain id is stale-free.
  //
  // POLL, do not read once. Privy's embedded-wallet provider resolves
  // wallet_switchEthereumChain as soon as the request has been forwarded to
  // the secure-context iframe, but the iframe's own chain state can trail that
  // reply: a single eth_chainId read immediately after reports the OLD chain,
  // the caller shows "wallet is on chain 1, game is on 46630" and the player
  // is stuck -- on a switch that actually worked. That is the reported
  // "still doesn't switch to the right chain" symptom. Every injected wallet
  // settles within a second; 6s is a ceiling that costs one extra read on the
  // happy path (the first eth_chainId below usually already returns 46630).
  const readChainId = async () => {
    const before = state.chainId;
    const current = fromQuantity(await p.request({ method: "eth_chainId" }));
    state.chainId = current;
    // The wallet's own chainChanged listener updates this too; emit here only
    // when we observed the change ourselves, so listeners fire exactly once.
    if (current !== before && state.account) emit("chain");
    return current;
  };
  const deadline = Date.now() + 6000;
  let chainId = null;
  while (true) {
    try {
      chainId = await readChainId();
    } catch (e) {
      return { ok: false, code: "bad-chain", reason: String(e?.message || e) };
    }
    if (chainId === GAME_CHAIN_ID) return { ok: true, chainId, ...getState() };
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  return {
    ok: false,
    code: "wrong-chain",
    reason: `wallet reports chain ${chainId} after 6s, expected ${GAME_CHAIN_ID}`,
    chainId,
    wrongChain: chainId,
  };
}

// --- write path ------------------------------------------------------------

/** Common preconditions for a write. Returns null when ready. */
function notReady() {
  const p = getProvider();
  if (!p || typeof p.request !== "function") {
    return { ok: false, code: "no-provider", reason: "connect a wallet first" };
  }
  if (!state.account) {
    return {
      ok: false,
      code: "not-connected",
      reason: "connect a wallet first",
    };
  }
  if (state.chainId !== GAME_CHAIN_ID) {
    return {
      ok: false,
      code: "wrong-chain",
      reason: `wallet is on chain ${state.chainId}, game is on ${GAME_CHAIN_ID}`,
    };
  }
  if (!config.gameAddress) {
    return {
      ok: false,
      code: "not-configured",
      reason: "GAME_ADDRESS not set - nothing to send to",
    };
  }
  return null;
}

/**
 * Show/hide the centred signing prompt.
 *
 * It uses the SAME in-scene flash() toast that the repair/sell/settle actions
 * use (via the window.deepwoodFlash hook ForestScene wires up in create()), so
 * "Confirm in wallet…" appears centred over the player and auto-fades exactly
 * like every other action note -- not a bespoke DOM overlay. The DOM #signing
 * element is only a fallback for when the Phaser scene is not alive (e.g. a
 * signing path that runs before/between scenes); it is never the primary.
 *
 * flash() auto-fades after ~2.7s, so there is no explicit "hide" call for the
 * flash path -- a rejection or resolve just lets it fade. The DOM fallback is
 * hidden explicitly on resolve/reject so it never sticks.
 */
function showSigning(text) {
  if (typeof window !== "undefined" && typeof window.deepwoodFlash === "function") {
    window.deepwoodFlash(text);
    return;
  }
  // Fallback: DOM element, only when the scene hook is unavailable.
  if (typeof document === "undefined") return;
  const el = document.getElementById("signing");
  if (!el) return;
  const t = document.getElementById("signing-text");
  if (t && text) t.textContent = text;
  el.hidden = false;
}
function hideSigning() {
  // The flash path self-fades; nothing to hide. Only the DOM fallback needs an
  // explicit hide so a rejection cannot leave it stuck on screen.
  if (typeof document === "undefined") return;
  const el = document.getElementById("signing");
  if (el) el.hidden = true;
}

/** eth_sendTransaction with a typed result and no throw. */
async function send(data, { valueWei } = {}) {
  return sendTo(config.gameAddress, data, { valueWei });
}

/** eth_sendTransaction to an arbitrary contract (e.g. the token for approve). */
export async function sendTo(to, data, { valueWei } = {}) {
  const blocked = notReady();
  if (blocked) return blocked;
  const tx = { from: state.account, to, data: data.startsWith("0x") ? data : "0x" + data };
  if (valueWei !== undefined) tx.value = toQuantity(valueWei);
  // Show the centred "Confirm in wallet" flash for the WHOLE time the wallet is
  // open (signature request -> user approves -> hash back). It is hidden in the
  // finally block so a rejection or a throw never leaves it stuck on screen.
  showSigning("Confirm in wallet…");
  try {
    const hash = await getProvider().request({
      method: "eth_sendTransaction",
      params: [tx],
    });
    return { ok: true, hash, from: state.account, to, tx };
  } catch (e) {
    const code = errCode(e);
    return {
      ok: false,
      code,
      reason:
        code === "rejected"
          ? "transaction rejected in the wallet"
          : String(e?.message || e),
    };
  } finally {
    hideSigning();
  }
}

/**
 * Buy the ONE tool, or upgrade it to the next tier. Costs DEEPWOOD tokens.
 *
 * V6: buyTool(uint8,uint256) is NOT payable. It pulls DEEPWOOD via
 * transferFrom, so the frontend must approve the token spend first.
 *
 * @param {number} tier 1..5
 * @param {object} [o]
 * @param {bigint|number|string} [o.maxTokenCost] DEEPWOOD tokens (18 decimals)
 *        the player is willing to spend. Read from toolCost(tier) on chain.
 * @returns {Promise<{ok:boolean, hash?:string, code?:string, reason?:string}>}
 */
export async function buyTool(tier, { maxTokenCost } = {}) {
  let data;
  try {
    data = calldataBuyTool(tier, maxTokenCost);
  } catch (e) {
    return { ok: false, code: e.code || "bad-arg", reason: e.message };
  }
  return send(data);
}

/** Repair the held tool by burning gems. No arguments, no value. */
export async function repairTool() {
  let data;
  try {
    data = calldataRepairTool();
  } catch (e) {
    return { ok: false, code: e.code || "bad-arg", reason: e.message };
  }
  return send(data);
}

/** Raise the skill level by exactly one, paying gems. */
export async function upgradeSkill(level) {
  let data;
  try {
    data = calldataUpgradeSkill(level);
  } catch (e) {
    return { ok: false, code: e.code || "bad-arg", reason: e.message };
  }
  return send(data);
}

/** Cash gems out for ETH at the contract's quoted payout. */
export async function redeemGems(rarity, count) {
  let data;
  try {
    data = calldataRedeemGems(rarity, count);
  } catch (e) {
    return { ok: false, code: e.code || "bad-arg", reason: e.message };
  }
  return send(data);
}

/**
 * V10 one-shot writes: migrate / descend / study / fuse. Each is a single
 * purpose write with its own confirm discipline in onchain.js; a receipt
 * on this chain is not proof, so the wrappers poll state, not status.
 */
export async function migrateFromV9() {
  return send(calldataMigrateFromV9());
}

export async function descend() {
  return send(calldataDescend());
}

export async function study() {
  return send(calldataStudy());
}

export async function fuse(rarity, times) {
  let data;
  try {
    data = calldataFuse(rarity, times);
  } catch (e) {
    return { ok: false, code: e.code || "bad-arg", reason: e.message };
  }
  return send(data);
}

/**
 * settleBatch -- the ONE write that settles a whole queued session. Called
 * only from the SETTLE button; nothing else in the client may invoke it, so
 * no gameplay action can ever pop a wallet prompt on its own.
 *
 * V6: bests carries the per-hunt bestSingleWei from previewHunt's 6th word.
 * The contract still validates every entry (ResultMismatch on mismatch), so
 * the zeros the migration sent would have reverted every settle.
 *
 * @param {{player:string, tier:number, batch:(bigint|number)[][],
 *          bests:(bigint|number)[]}} args
 */
export async function settleBatch({ player, tier, batch, bests }) {
  let data;
  try {
    data = calldataSettleBatch(player, tier, batch, bests);
  } catch (e) {
    return { ok: false, code: e.code || "bad-arg", reason: e.message };
  }
  return send(data);
}
