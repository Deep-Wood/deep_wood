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
import {
  getState,
  buyTool as wBuyTool,
  repairTool as wRepairTool,
  upgradeSkill as wUpgradeSkill,
  redeemGems as wRedeemGems,
} from "./wallet.js";
import { rpcCall } from "./rpc.js";
import { connect as readConnect } from "./chain.js";
import { config } from "./config.js";
// Formats an 18-decimal $DEEPWOOD amount for humans. Without it the
// below-floor message printed the raw integer (1440000000000000000000).
import { fmtToken } from "./redeem.js";

/** Rarities the contract sells. Rare+ are hunt-only and revert. */
// V1 sold gems for Common/Uncommon only. V2 has no gem SHOP at all: gems are
// mined, and every rarity the player holds is redeemable. These lists survive
// only so callers that iterate rarities have a single source of truth for the
// five-slot shape.
export const ALL_RARITIES = [0, 1, 2, 3, 4];
export const RARITY_NAMES = {
  0: "Quartz",
  1: "Amber",
  2: "Sapphire",
  3: "Ruby",
  4: "Diamond",
};

const POLL_INTERVAL_MS = 1200;
const POLL_ATTEMPTS = 20; // ~24s; a testnet block is sub-second in practice

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A failed result, shaped like wallet.js's so callers handle one shape. */
const fail = (code, reason) => ({ ok: false, code, reason });

/**
 * Poll `read()` until it returns a value that satisfies `moved`, or give up.
 * @returns {Promise<{changed: boolean, value: any, waited: number}>}
 */
export async function pollUntilChanged(read, before, moved) {
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

/**
 * Lazily open (and reuse) the read-only handle.
 *
 * Exported because the UI must read chain state to render honestly -- the
 * season title comes from phase(), not from a string baked into the HTML.
 */
export async function getReader() {
  if (reader) return reader;
  if (!config.gameAddress) return null;
  reader = await readConnect({
    rpcUrl: config.rpcUrl,
    fallbackRpcUrls: config.fallbackRpcUrls,
    address: config.gameAddress,
  });
  return reader;
}

/** True when writes would go to the chain rather than the local simulation. */
/**
 * The player's spendable ETH, in wei.
 *
 * Preview mode has no wallet, so ForestScene used a simulated `simBalance`.
 * That is exactly the kind of number that must never reach a real transaction:
 * it would size a buy against a fiction. When the chain is active this reads
 * the actual balance, and callers should route through here rather than
 * reading a balance themselves.
 */
export async function walletBalanceWeiOnchain() {
  const { getState } = await import("./wallet.js");
  const { account } = getState();
  if (!config.rpcUrl || !account) return null;
  try {
    // Failover: an endpoint answering with a 1-byte hex string instead of a
    // balance is a WRONG answer, not a failed one, so it must not be believed.
    // Judge the DECODED byte width, NOT the trimmed hex-char count: RPCs trim
    // leading zeros from a uint256, so a real 11 ETH balance arrives as ~8 bytes
    // of hex, not 32. Demanding 32 bytes here rejected every real balance on
    // 46630 and left the buy/upgrade button greyed against a funded wallet.
    // 4 bytes still rejects a degenerate 0x0/0x1 stub.
    const hex = await rpcCall("eth_getBalance", [account, "latest"], {
      minBytes: 4,
    });
    if (!hex) return null;
    return BigInt(hex);
  } catch {
    // A failed balance read must not be reported as zero -- "you have nothing"
    // would disable every button and read as a real answer. null means unknown.
    return null;
  }
}

export function onchainActive() {
  return getState().connected && Boolean(config.gameAddress);
}

/** How the UI should describe itself right now. */
export function mode() {
  if (!config.gameAddress) return "offline";
  return onchainActive() ? "onchain" : "preview";
}

/**
 * Buy the ONE tool, or upgrade to the next tier, paying DEEPWOOD tokens.
 *
 * V6: buyTool(uint8,uint256) is NOT payable. It pulls DEEPWOOD via
 * transferFrom, so the frontend must approve the token spend first.
 *
 * Confirmation signal: `toolOf(account)` returns (tier, durability, broken),
 * and the tier must have RISEN to the one requested. In V2 exactly one tool is
 * held, so this is a single tuple rather than V1's growing `toolCount`.
 *
 * Grants nothing unless the chain's own state proves it applied. On 46630 a
 * reverted call still yields a receipt with status 0x1, so a hash proves
 * nothing.
 *
 * @param {number} tier 1..5
 * @param {bigint|number} maxTokenCost DEEPWOOD tokens (18 decimals) the player
 *        is willing to spend. Read from toolCost(tier) on chain.
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, hash?:string,
 *                    confirmed?:boolean, tier?:number, durability?:bigint}>}
 */
export async function buyToolOnchain(tier, maxTokenCost) {
  const r = await getReader();
  if (!r)
    return fail(
      "not-configured",
      "GAME_ADDRESS not set - no contract to write to",
    );
  if (maxTokenCost === undefined || maxTokenCost === null) {
    // Never guess a price. Reading it live is one call; inventing it sends the
    // player to sign a transaction the chain will revert.
    return fail(
      "bad-arg",
      "buyToolOnchain needs { maxTokenCost } from toolCost(tier)",
    );
  }

  const { account } = getState();
  const before = await r.toolOf(account);

  // V6: approve DEEPWOOD token spend first (buyTool pulls via transferFrom)
  const { buyToolTx, approveTokenTx } = await import("./chain.js");
  const { sendTo } = await import("./wallet.js");

  // Check current allowance
  const tokenAddr = await r.token();
  const { getAllowance, getTokenBalance } = await import("./chain.js");
  const allowance = await getAllowance(
    config.rpcUrl, config.fallbackRpcUrls, tokenAddr, account, config.gameAddress
  );
  const tokenCost = BigInt(maxTokenCost);

  if (allowance < tokenCost) {
    // Approve the game contract to spend DEEPWOOD
    const approveData = approveTokenTx(config.gameAddress, tokenCost);
    const approveResult = await sendTo(tokenAddr, approveData);
    if (!approveResult?.ok) {
      return fail(
        approveResult?.code || "send-failed",
        approveResult?.reason || "token approval failed",
      );
    }
    // Wait for the approval to propagate
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Now call buyTool(uint8,uint256) -- NOT payable, no ETH value
  const txData = buyToolTx(tier, tokenCost);
  const sent = await sendTo(config.gameAddress, txData);
  if (!sent.ok)
    return fail(
      sent.code || "send-failed",
      sent.reason || "transaction was not sent",
    );

  const after = await pollUntilChanged(
    () => r.toolOf(account),
    before,
    (b, a) => a.tier > b.tier,
  );

  if (!after.changed) {
    // The tx was broadcast but the contract never applied it: it reverted. A
    // duplicate buy, a skipped tier, or a wrong value all land here.
    return fail(
      "reverted",
      "contract did not apply the purchase (it reverted) - nothing granted",
    );
  }
  if (after.value.tier !== tier) {
    return fail(
      "wrong-tier",
      `bought tier ${tier} but the chain holds tier ${after.value.tier}`,
    );
  }

  const { track } = await import('./analytics.js');
  track('tool_buy', {rail: 'token'});
  return {
    ok: true,
    hash: sent.hash,
    confirmed: true,
    tier: after.value.tier,
    durability: after.value.durability,
  };
}

/**
 * Buy tool with DEEPWOOD token. V6: buyToolWithToken(uint8,uint256) pulls
 * DEEPWOOD via transferFrom, so the frontend must approve the token spend
 * first -- same pattern as buyToolOnchain.
 *
 * @param {number} tier 1..5
 * @param {bigint|number} maxTokenCost DEEPWOOD tokens (18 decimals) the player
 *        is willing to spend. Read from toolCost(tier) on chain.
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, hash?:string,
 *                    confirmed?:boolean, tier?:number, durability?:bigint}>}
 */
export async function buyToolWithTokenOnchain(tier, maxTokenCost) {
  const r = await getReader();
  if (!r)
    return fail(
      "not-configured",
      "GAME_ADDRESS not set - no contract to write to",
    );
  if (maxTokenCost === undefined || maxTokenCost === null) {
    return fail(
      "bad-arg",
      "buyToolWithTokenOnchain needs { maxTokenCost } from toolCost(tier)",
    );
  }

  const { account } = getState();
  const before = await r.toolOf(account);

  const { buyToolWithTokenTx, approveTokenTx } = await import("./chain.js");
  const { sendTo } = await import("./wallet.js");

  const tokenAddr = await r.token();

  // Always read the ACTUAL on-chain cost, never trust the local cache.
  // The owner can change tool prices via setToolPrices(); a stale cached
  // value sends a maxTokenCost that's too low, and the contract reverts
  // AboveMaxCost (cost > maxTokenCost).
  const onchainCost = await r.toolCost(tier);
  const tokenCost = onchainCost && onchainCost > 0n ? onchainCost : BigInt(maxTokenCost);

  const { getAllowance } = await import("./chain.js");
  const allowance = await getAllowance(
    config.rpcUrl, config.fallbackRpcUrls, tokenAddr, account, config.gameAddress
  );

  if (allowance < tokenCost) {
    const approveData = approveTokenTx(config.gameAddress, tokenCost);
    const approveResult = await sendTo(tokenAddr, approveData);
    if (!approveResult?.ok) {
      return fail(
        approveResult?.code || "send-failed",
        approveResult?.reason || "token approval failed",
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const txData = buyToolWithTokenTx(tier, tokenCost);
  const sent = await sendTo(config.gameAddress, txData);
  if (!sent.ok)
    return fail(
      sent.code || "send-failed",
      sent.reason || "transaction was not sent",
    );

  const after = await pollUntilChanged(
    () => r.toolOf(account),
    before,
    (b, a) => a.tier > b.tier,
  );

  if (!after.changed) {
    return fail(
      "reverted",
      "contract did not apply the purchase (it reverted) - nothing granted",
    );
  }
  if (after.value.tier !== tier) {
    return fail(
      "wrong-tier",
      `bought tier ${tier} but the chain holds tier ${after.value.tier}`,
    );
  }

  const { track } = await import('./analytics.js');
  track('tool_buy', {rail: 'token'});
  return {
    ok: true,
    hash: sent.hash,
    confirmed: true,
    tier: after.value.tier,
    durability: after.value.durability,
  };
}

/**
 * Buy tool with ETH. V6: buyToolWithEth(uint8,bytes,uint256) is the ONLY
 * payable buy path. It swaps ETH→DEEPWOOD via Universal Router, then buys
 * the tool in the same transaction.
 *
 * @param {number} tier 1..5
 * @param {string|Buffer} swapData encoded swap path for the Universal Router
 * @param {bigint} minTokens minimum DEEPWOOD tokens out (slippage protection)
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, hash?:string,
 *                    confirmed?:boolean, tier?:number, durability?:bigint}>}
 */
export async function buyToolWithEthOnchain(tier, swapData, minTokens) {
  const r = await getReader();
  if (!r)
    return fail(
      "not-configured",
      "GAME_ADDRESS not set - no contract to write to",
    );

  const { account } = getState();
  const before = await r.toolOf(account);

  const { buyToolWithEthTx } = await import("./chain.js");
  const { sendTo } = await import("./wallet.js");

  const txData = buyToolWithEthTx(tier, swapData, minTokens);
  const sent = await sendTo(config.gameAddress, txData);
  if (!sent.ok)
    return fail(
      sent.code || "send-failed",
      sent.reason || "transaction was not sent",
    );

  const after = await pollUntilChanged(
    () => r.toolOf(account),
    before,
    (b, a) => a.tier > b.tier,
  );

  if (!after.changed) {
    return fail(
      "reverted",
      "contract did not apply the purchase (it reverted) - nothing granted",
    );
  }
  if (after.value.tier !== tier) {
    return fail(
      "wrong-tier",
      `bought tier ${tier} but the chain holds tier ${after.value.tier}`,
    );
  }

  const { track } = await import('./analytics.js');
  track('tool_buy', {rail: 'eth'});
  return {
    ok: true,
    hash: sent.hash,
    confirmed: true,
    tier: after.value.tier,
    durability: after.value.durability,
  };
}

/**
 * Repair the held tool by burning gems.
 *
 * Confirmation signal: `toolOf(account).broken` goes from true to false, and
 * durability returns to the tier's maximum. Checking `broken` rather than the
 * durability value alone matters because a repair restores a KNOWN number --
 * a poll on "durability increased" would be satisfied by any partial change.
 *
 * The gem vector is NOT sent. `repairTool()` takes no arguments; the contract
 * derives the exact cost per tier, so the client cannot get it wrong and must
 * not try.
 */
export async function repairToolOnchain() {
  const r = await getReader();
  if (!r)
    return fail(
      "not-configured",
      "GAME_ADDRESS not set - no contract to write to",
    );

  const { account } = getState();
  const before = await r.toolOf(account);

  // Refuse locally rather than paying gas to be told: the contract reverts
  // NotBroken when durability is above zero, and ToolNotOwned when there is no
  // tool at all. Both are states the button can see coming.
  if (before.tier === 0) return fail("no-tool", "you do not own a tool yet");
  if (!before.broken)
    return fail("not-broken", "the tool is not broken - no repair needed");

  const sent = await wRepairTool();
  if (!sent.ok)
    return fail(
      sent.code || "send-failed",
      sent.reason || "transaction was not sent",
    );

  const after = await pollUntilChanged(
    () => r.toolOf(account),
    before,
    (b, a) => b.broken === true && a.broken === false,
  );

  if (!after.changed) {
    return fail(
      "reverted",
      "contract did not apply the repair (it reverted) - gems not burned",
    );
  }

  const { track } = await import('./analytics.js');
  track('tool_repair', {});
  return {
    ok: true,
    hash: sent.hash,
    confirmed: true,
    durability: after.value.durability,
  };
}

/**
 * Raise the skill level by one, paying gems.
 *
 * Confirmation signal: `skillOf(account)` rose to exactly the level asked for.
 * The contract only accepts `skill + 1`, so anything else is a revert and must
 * not be reported as a purchase.
 *
 * @param {number} level 1..4, and must be the player's current skill + 1
 */
export async function upgradeSkillOnchain(level, currentSkill) {
  const r = await getReader();
  if (!r)
    return fail(
      "not-configured",
      "GAME_ADDRESS not set - no contract to write to",
    );
  if (currentSkill !== undefined && level !== currentSkill + 1) {
    // Caught before the wallet opens. The contract's own guard is
    // RarityLocked, but paying gas to be told you skipped a level is silly.
    return fail(
      "skill-not-next",
      `skill must go ${currentSkill + 1}, not ${level}`,
    );
  }

  const { account } = getState();
  const before = await r.skillOf(account);

  const sent = await wUpgradeSkill(level);
  if (!sent.ok)
    return fail(
      sent.code || "send-failed",
      sent.reason || "transaction was not sent",
    );

  const after = await pollUntilChanged(
    () => r.skillOf(account),
    before,
    (b, a) => a > b,
  );

  if (!after.changed) {
    return fail(
      "reverted",
      "contract did not apply the skill (it reverted) - gems not spent",
    );
  }
  if (after.value !== level) {
    return fail(
      "wrong-level",
      `asked for skill ${level} but the chain reads ${after.value}`,
    );
  }

  const { track } = await import('./analytics.js');
  track('skill_upgrade', {});
  return { ok: true, hash: sent.hash, confirmed: true, skill: after.value };
}

/**
 * Cash gems out for $DEEPWOOD.
 *
 * V6: redeemQuote returns DEEPWOOD (18 decimals), not ETH wei.
 *
 * Confirmation signal: the gem balance FELL by the amount redeemed. The token
 * arrives in the same transaction, so there is nothing to poll on the token
 * side -- and the payout is the contract's, not the client's, so it must never
 * be computed locally or shown as guaranteed.
 *
 * The floor is enforced on chain with BelowMinRedeem. Ask the contract's own
 * `redeemQuote` before sending so the button can explain why a redemption
 * is too small, rather than letting the player sign and fail.
 */
export async function redeemGemsOnchain(rarity, count) {
  const r = await getReader();
  if (!r)
    return fail(
      "not-configured",
      "GAME_ADDRESS not set - no contract to write to",
    );
  // Count is a raw whole-gem amount; BigInt flows through from the redeem
  // card. Accept legacy positive Numbers too.
  const asBig = typeof count === 'bigint' ? count
    : (Number.isInteger(count) && count > 0 ? BigInt(count) : 0n);
  if (asBig <= 0n) {
    return fail("bad-arg", `count must be a positive integer, got ${count}`);
  }

  const { account } = getState();
  const before = await r.gemsOf(account, rarity);

  if (before < asBig) {
    return fail(
      "insufficient-gems",
      `you hold ${before}, cannot redeem ${count}`,
    );
  }

  // V6: redeemQuote returns DEEPWOOD (18 decimals), not ETH wei.
  let payout = 0n;
  try {
    const [tokenPayout, aboveFloor] = await r.redeemQuote(rarity, asBig);
    payout = tokenPayout;
    if (!aboveFloor) {
      return fail(
        "below-floor",
        `that redeems for ${fmtToken(payout)} $DEEPWOOD, below the contract's minimum`,
      );
    }
  } catch {
    return fail("read-failed", "could not read redemption quote from chain");
  }

  const sent = await wRedeemGems(rarity, asBig);
  if (!sent.ok)
    return fail(
      sent.code || "send-failed",
      sent.reason || "transaction was not sent",
    );

  const after = await pollUntilChanged(
    () => r.gemsOf(account, rarity),
    before,
    (b, a) => a < b,
  );

  if (!after.changed) {
    return fail(
      "reverted",
      "contract did not apply the redemption (it reverted) - gems not spent",
    );
  }

  const { track } = await import('./analytics.js');
  track('gems_redeem', {});
  return {
    ok: true,
    hash: sent.hash,
    confirmed: true,
    // V6: payout is in DEEPWOOD (18 decimals), not ETH wei.
    payoutTokens: payout,
  };
}

/**
 * V10 one-shot writes, same rule as every other write in this module:
 * send, then poll until the contract's own state proves it applied. On
 * 46630 a reverted call still yields a status-0x1 receipt, so a hash
 * proves nothing; only a moved read does.
 */

/**
 * Carry your V9 progress into V10. One-shot per player.
 *
 * Signal: `migratedV9(player)` flips to true. Everything the migration
 * pulled is then readable through the normal V10 getters.
 *
 * @returns {Promise<{ok:boolean, hash?:string, code?:string, reason?:string}>}
 */
export async function migrateFromV9Onchain() {
  const r = await getReader();
  if (!r) return fail("not-configured", "GAME_ADDRESS not set - no contract to write to");
  const { account } = getState();
  let before;
  try {
    before = await r.migratedV9(account);
  } catch {
    return fail("read-failed", "could not read the migration flag");
  }
  if (before) return fail("already", "this wallet already carried its progress over");

  const { migrateFromV9 } = await import("./wallet.js");
  const sent = await migrateFromV9();
  if (!sent.ok) return fail(sent.code || "send-failed", sent.reason || "transaction was not sent");

  const after = await pollUntilChanged(() => r.migratedV9(account), before, (b, a) => a === true);
  if (!after.changed) {
    return fail("reverted", "contract did not apply the migration (it reverted)");
  }
  const { track } = await import('./analytics.js');
  track('v9_migrate', {});
  return { ok: true, hash: sent.hash, confirmed: true };
}

/**
 * Prestige: wipe satchel, tool and skill for a permanent find-weight
 * multiplier. Signal: `prestigeCount(player)` increments.
 *
 * @returns {Promise<{ok:boolean, hash?:string, code?:string,
 *                    reason?:string, prestigeCount?:number}>}
 */
export async function descendOnchain() {
  const r = await getReader();
  if (!r) return fail("not-configured", "GAME_ADDRESS not set - no contract to write to");
  const { account } = getState();
  let before;
  try {
    before = await r.prestigeCount(account);
  } catch {
    return fail("read-failed", "could not read the prestige count");
  }

  const { descend } = await import("./wallet.js");
  const sent = await descend();
  if (!sent.ok) return fail(sent.code || "send-failed", sent.reason || "transaction was not sent");

  const after = await pollUntilChanged(() => r.prestigeCount(account), before, (b, a) => a > b);
  if (!after.changed) {
    return fail("reverted", "contract did not apply the descend (it reverted)");
  }
  const { track } = await import('./analytics.js');
  track('descend', {});
  return { ok: true, hash: sent.hash, confirmed: true, prestigeCount: after.value };
}

/**
 * Buy one luck research level. Signal: `researchOf(player)` packed value
 * grows (the luck byte is 2, so +1 level adds 0x100 to the packed word).
 *
 * @returns {Promise<{ok:boolean, hash?:string, code?:string, reason?:string}>}
 */
export async function studyOnchain() {
  const r = await getReader();
  if (!r) return fail("not-configured", "GAME_ADDRESS not set - no contract to write to");
  const { account } = getState();
  let before;
  try {
    before = await r.researchOf(account);
  } catch {
    return fail("read-failed", "could not read the research levels");
  }

  const { study } = await import("./wallet.js");
  const sent = await study();
  if (!sent.ok) return fail(sent.code || "send-failed", sent.reason || "transaction was not sent");

  const after = await pollUntilChanged(() => r.researchOf(account), before, (b, a) => a > b);
  if (!after.changed) {
    return fail("reverted", "contract did not apply the study (it reverted)");
  }
  const { track } = await import('./analytics.js');
  track('study', {});
  return { ok: true, hash: sent.hash, confirmed: true };
}

/**
 * Fuse `times` steps of gem `rarity` up into gem `rarity + 1`. Signal:
 * the credited gem balance grows by exactly `times`.
 *
 * @param {number} rarity 0..3
 * @param {number} times   >= 1
 * @returns {Promise<{ok:boolean, hash?:string, code?:string, reason?:string}>}
 */
export async function fuseOnchain(rarity, times) {
  const r = await getReader();
  if (!r) return fail("not-configured", "GAME_ADDRESS not set - no contract to write to");
  const { account } = getState();
  let before;
  try {
    before = await r.gemsOf(account, rarity + 1);
  } catch {
    return fail("read-failed", "could not read the gem balance");
  }

  const { fuse } = await import("./wallet.js");
  const sent = await fuse(rarity, times);
  if (!sent.ok) return fail(sent.code || "send-failed", sent.reason || "transaction was not sent");

  const after = await pollUntilChanged(
    () => r.gemsOf(account, rarity + 1),
    before,
    (b, a) => a >= b + BigInt(times),
  );
  if (!after.changed) {
    return fail("reverted", "contract did not apply the fusion (it reverted)");
  }
  const { track } = await import('./analytics.js');
  track('fuse', { rarity, times });
  return { ok: true, hash: sent.hash, confirmed: true };
}

/**
 * The result the chain will accept for this player's next hunt, or null when
 * there is no contract / no committed seed. Read-only: safe to call for the
 * HUD without a wallet connected.
 *
 * V6: returns { counts: bigint[5] } (no bestSingleWei).
 *
 * @param {number} tier 1..4
 * @returns {Promise<{counts:bigint[]}|null>}
 */
export async function previewHuntFor(tier) {
  const r = await getReader();
  if (!r) return null;
  const { account } = getState();
  if (!account) return null;
  try {
    return await r.previewHunt(account, tier);
  } catch {
    return null;
  }
}

/**
 * Settle the whole queued session in ONE transaction. Invoked only by the
 * SETTLE button -- never by gameplay.
 *
 * Same confirm discipline as every write in this module: huntIndexOf(player)
 * must advance by exactly `n`, because on 46630 a receipt proves nothing. A
 * short move means the batch reverted and NOTHING was credited -- the queue
 * stays intact and the player can retry.
 *
 * @param {import('./queue.js').HuntQueue} queue
 * @returns {Promise<{ok:boolean, settled?:number, hash?:string,
 *                    code?:string, reason?:string}>}
 */
export async function settleBatchOnchain(queue) {
  const r = await getReader();
  if (!r)
    return fail(
      "not-configured",
      "GAME_ADDRESS not set - no contract to write to",
    );
  if (queue.empty) return fail("empty", "nothing to settle");

  const { account } = getState();
  const { batch, bests } = queue.toCalldata();

  // Refuse to open the wallet for a queue the contract is certain to reject:
  // a moved hunt index means a settle happened underneath us, and a tier
  // change means the queued rolls were computed against another tool.
  let before;
  try {
    before = await r.huntIndexOf(account);
  } catch {
    return fail("read-failed", "could not read the hunt index");
  }
  if (queue.stale(before)) {
    return fail(
      "stale",
      "the hunt index moved - another session settled first. Clear and re-dig.",
    );
  }

  const { settleBatch: wSettleBatch } = await import("./wallet.js");
  const sent = await wSettleBatch({
    player: account,
    tier: queue.tier,
    batch,
    bests,
  });
  if (!sent.ok)
    return fail(
      sent.code || "send-failed",
      sent.reason || "transaction was not sent",
    );

  const after = await pollUntilChanged(
    () => r.huntIndexOf(account),
    before,
    (b, a) => a >= b + BigInt(queue.size),
  );
  if (!after.changed) {
    return fail(
      "reverted",
      "contract did not apply the batch (it reverted) - queue kept, retry or clear",
    );
  }

  const { track } = await import('./analytics.js');
  track('hunt_settle', {mode: 'batch'});
  return {
    ok: true,
    hash: sent.hash,
    confirmed: true,
    settled: queue.size,
  };
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
