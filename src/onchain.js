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
  settleHunt as wSettleHunt,
} from './wallet.js';
import { rpcCall } from './rpc.js';
import { connect as readConnect } from './chain.js';
import { config } from './config.js';

/** Rarities the contract sells. Rare+ are hunt-only and revert. */
// V1 sold gems for Common/Uncommon only. V2 has no gem SHOP at all: gems are
// mined, and every rarity the player holds is redeemable. These lists survive
// only so callers that iterate rarities have a single source of truth for the
// five-slot shape.
export const ALL_RARITIES = [0, 1, 2, 3, 4];
export const RARITY_NAMES = {
  0: 'Quartz', 1: 'Amber', 2: 'Sapphire', 3: 'Ruby', 4: 'Diamond',
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
  const { getState } = await import('./wallet.js');
  const { account } = getState();
  if (!config.rpcUrl || !account) return null;
  try {
    // Failover: an endpoint answering with a 1-byte hex string instead of a
    // balance is a WRONG answer, not a failed one, so it must not be believed.
    // A balance is a 32-byte word, so anything shorter than 64 hex chars
    // (the 0x excluded) is implausible and worth retrying elsewhere.
    const hex = await rpcCall('eth_getBalance', [account, 'latest'], { minHexChars: 64 });
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
  if (!config.gameAddress) return 'offline';
  return onchainActive() ? 'onchain' : 'preview';
}

/**
 * Buy the ONE tool, or upgrade to the next tier, paying ETH.
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
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, hash?:string,
 *                    confirmed?:boolean, tier?:number, durability?:bigint}>}
 */
export async function buyToolOnchain(tier, costWei) {
  const r = await getReader();
  if (!r) return fail('not-configured', 'GAME_ADDRESS not set - no contract to write to');
  if (costWei === undefined || costWei === null) {
    // Never guess a price. Reading it live is one call; inventing it sends the
    // player to sign a transaction the chain will reject with Underpaid.
    return fail('bad-arg', 'buyToolOnchain needs { costWei } from toolCost(tier)');
  }

  const { account } = getState();
  const before = await r.toolOf(account);

  const sent = await wBuyTool(tier, { valueWei: costWei });
  if (!sent.ok) return fail(sent.code || 'send-failed', sent.reason || 'transaction was not sent');

  const after = await pollUntilChanged(
    () => r.toolOf(account),
    before,
    (b, a) => a.tier > b.tier,
  );

  if (!after.changed) {
    // The tx was broadcast but the contract never applied it: it reverted. A
    // duplicate buy, a skipped tier, or a wrong value all land here.
    return fail('reverted', 'contract did not apply the purchase (it reverted) - nothing granted');
  }
  if (after.value.tier !== tier) {
    return fail('wrong-tier', `bought tier ${tier} but the chain holds tier ${after.value.tier}`);
  }

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
  if (!r) return fail('not-configured', 'GAME_ADDRESS not set - no contract to write to');

  const { account } = getState();
  const before = await r.toolOf(account);

  // Refuse locally rather than paying gas to be told: the contract reverts
  // NotBroken when durability is above zero, and ToolNotOwned when there is no
  // tool at all. Both are states the button can see coming.
  if (before.tier === 0) return fail('no-tool', 'you do not own a tool yet');
  if (!before.broken) return fail('not-broken', 'the tool is not broken - no repair needed');

  const sent = await wRepairTool();
  if (!sent.ok) return fail(sent.code || 'send-failed', sent.reason || 'transaction was not sent');

  const after = await pollUntilChanged(
    () => r.toolOf(account),
    before,
    (b, a) => b.broken === true && a.broken === false,
  );

  if (!after.changed) {
    return fail('reverted', 'contract did not apply the repair (it reverted) - gems not burned');
  }

  return { ok: true, hash: sent.hash, confirmed: true, durability: after.value.durability };
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
  if (!r) return fail('not-configured', 'GAME_ADDRESS not set - no contract to write to');
  if (currentSkill !== undefined && level !== currentSkill + 1) {
    // Caught before the wallet opens. The contract's own guard is
    // RarityLocked, but paying gas to be told you skipped a level is silly.
    return fail('skill-not-next', `skill must go ${currentSkill + 1}, not ${level}`);
  }

  const { account } = getState();
  const before = await r.skillOf(account);

  const sent = await wUpgradeSkill(level);
  if (!sent.ok) return fail(sent.code || 'send-failed', sent.reason || 'transaction was not sent');

  const after = await pollUntilChanged(
    () => r.skillOf(account),
    before,
    (b, a) => a > b,
  );

  if (!after.changed) {
    return fail('reverted', 'contract did not apply the skill (it reverted) - gems not spent');
  }
  if (after.value !== level) {
    return fail('wrong-level', `asked for skill ${level} but the chain reads ${after.value}`);
  }

  return { ok: true, hash: sent.hash, confirmed: true, skill: after.value };
}

/**
 * Cash gems out for ETH.
 *
 * Confirmation signal: the gem balance FELL by the amount redeemed. The ETH
 * arrives asynchronously in the same transaction, so there is nothing to poll
 * on the ETH side -- and the payout is the contract's, not the client's, so it
 * must never be computed locally or shown as guaranteed.
 *
 * The 0.005 ETH floor is enforced on chain with BelowMinRedeem. Ask the
 * contract's own `redeemQuote` before sending so the button can explain why a
 * redemption is too small, rather than letting the player sign and fail.
 */
export async function redeemGemsOnchain(rarity, count) {
  const r = await getReader();
  if (!r) return fail('not-configured', 'GAME_ADDRESS not set - no contract to write to');
  if (!Number.isInteger(count) || count <= 0) {
    return fail('bad-arg', `count must be a positive integer, got ${count}`);
  }

  const { account } = getState();
  const before = await r.gemsOf(account, rarity);

  if (before < BigInt(count)) {
    return fail('insufficient-gems', `you hold ${before}, cannot redeem ${count}`);
  }

  // Quote first: the floor is a real rejection, not a formality.
  const [payout, aboveFloor] = await r.redeemQuote(rarity, count);
  if (!aboveFloor) {
    return fail(
      'below-floor',
      `that redeems for ${payout} wei, below the ${r.minRedeemWei?.() ?? 'minimum'} minimum`,
    );
  }

  const sent = await wRedeemGems(rarity, count);
  if (!sent.ok) return fail(sent.code || 'send-failed', sent.reason || 'transaction was not sent');

  const after = await pollUntilChanged(
    () => r.gemsOf(account, rarity),
    before,
    (b, a) => a < b,
  );

  if (!after.changed) {
    return fail('reverted', 'contract did not apply the redemption (it reverted) - gems not spent');
  }

  return {
    ok: true,
    hash: sent.hash,
    confirmed: true,
    // The chain's own number, never a locally computed one.
    payoutWei: payout,
  };
}

/**
 * Settle your own hunt on chain.
 *
 * Same rule as every other write in this module: send, then poll until the
 * contract's own state proves it applied. Here the signal is
 * `huntIndexOf(player)`, which settleHunt increments exactly once.
 *
 * The counts are NOT computed locally. They are read from the contract's own
 * `previewHunt`, because settleHunt recomputes the result from the committed
 * season seed and reverts ResultMismatch on any difference. Rolling it here
 * would produce finds the chain refuses -- which is exactly what happened when
 * `rollHunt` hashed the 0x-prefixed address.
 *
 * @param {number} tier 1..4
 * @returns {Promise<{ok:boolean, counts?:bigint[], bestSingleWei?:bigint,
 *                    hash?:string, code?:string, reason?:string}>}
 */
export async function settleHuntOnchain(tier) {
  const r = await getReader();
  if (!r) return fail('not-configured', 'GAME_ADDRESS not set - no contract to write to');

  const { account } = getState();

  // A season with no committed seed cannot settle anything. Say that plainly
  // rather than letting the player pay gas to be rejected with SeedNotCommitted.
  let season;
  try {
    season = await r.current();
  } catch {
    return fail('read-failed', 'could not read the current season');
  }
  if (!season.seedCommitted) {
    return fail('no-seed', 'this season has no committed seed yet, so hunts cannot be settled');
  }

  let preview;
  try {
    preview = await r.previewHunt(account, tier);
  } catch (e) {
    return fail('read-failed', `could not preview the hunt: ${e.message}`);
  }

  const before = await r.huntIndexOf(account);
  const sent = await wSettleHunt({
    player: account,
    tier,
    counts: preview.counts,
    bestSingleWei: preview.bestSingleWei,
  });
  if (!sent.ok) return fail(sent.code || 'send-failed', sent.reason || 'transaction was not sent');

  const after = await pollUntilChanged(
    () => r.huntIndexOf(account),
    before,
    (b, a) => a > b,
  );
  if (!after.changed) {
    // Same shape as the other writes: a receipt here proves nothing. On 46630 a
    // reverted call still yields status 0x1.
    return fail('reverted', 'contract did not apply the settlement (it reverted) - find not credited');
  }

  return {
    ok: true,
    hash: sent.hash,
    confirmed: true,
    counts: preview.counts,
    bestSingleWei: preview.bestSingleWei,
    huntIndex: after.value,
  };
}

/**
 * The result the chain will accept for this player's next hunt, or null when
 * there is no contract / no committed seed. Read-only: safe to call for the
 * HUD without a wallet connected.
 *
 * @param {number} tier 1..4
 * @returns {Promise<{counts:bigint[], bestSingleWei:bigint}|null>}
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
