// Quest/trophy gem rewards (V10.2 on-chain reward table).
//
// Pure module: the reward TABLE mirrors DeepWoodV102's constructor table
// exactly (same ids, same amounts, Sapphire cap enforced on-chain by
// RewardOverCap). Nothing here mints anything -- a reward only exists once
// the contract's claimReward() applies it, and the contract only applies it
// with a rewardSigner signature plus a fresh claimKey, so the client cannot
// self-grant or double-claim.
//
// Ids are keccak256(utf8(id)) on-chain; `day` is the idempotency clock:
//   scope 'daily'   -> dayNumber(UTC today)
//   scope 'weekend' -> dayNumber(Saturday of the current weekend)
//   scope 'once'    -> 0 (trophies / streak tiers, one-time ever)

import { keccak256, encodePacked, encodeAbiParameters, toBytes } from 'viem';
import { dayNumber, saturdayOf, utcDay } from './engagement.js';

/** Same constant as the contract's CLAIM_TYPEHASH. */
export const CLAIM_TYPEHASH = keccak256(
  toBytes('ClaimReward(address player,bytes32 rewardId,uint64 day)'),
);

/**
 * The approved reward table (owner decision 2026-11-06, reduced + capped at
 * Sapphire). amounts = [Quartz, Amber, Sapphire, Ruby, Diamond] -- Ruby and
 * Diamond are ALWAYS 0 here; the contract rejects them too.
 */
export const REWARDS = {
  // daily quests
  'warm-pick': { amounts: [5n, 0n, 0n, 0n, 0n], scope: 'daily' },
  'prospectors-eye': { amounts: [2n, 1n, 0n, 0n, 0n], scope: 'daily' },
  'keep-it-sharp': { amounts: [5n, 0n, 0n, 0n, 0n], scope: 'daily' },
  // weekend quest
  'big-dig': { amounts: [15n, 3n, 0n, 0n, 0n], scope: 'weekend' },
  // streak tiers (once)
  'streak-3': { amounts: [3n, 0n, 0n, 0n, 0n], scope: 'once' },
  'streak-7': { amounts: [8n, 2n, 0n, 0n, 0n], scope: 'once' },
  'streak-14': { amounts: [15n, 3n, 1n, 0n, 0n], scope: 'once' },
  'streak-30': { amounts: [40n, 10n, 2n, 0n, 0n], scope: 'once' },
  // trophies / badges (once)
  'first-find': { amounts: [2n, 0n, 0n, 0n, 0n], scope: 'once' },
  'amber-rush': { amounts: [0n, 1n, 0n, 0n, 0n], scope: 'once' },
  'deep-blue': { amounts: [0n, 0n, 1n, 0n, 0n], scope: 'once' },
  'ruby-crown': { amounts: [0n, 0n, 3n, 0n, 0n], scope: 'once' },
  'diamond-club': { amounts: [0n, 0n, 5n, 0n, 0n], scope: 'once' },
  'mithril-club': { amounts: [10n, 2n, 1n, 0n, 0n], scope: 'once' },
  'lapidary': { amounts: [10n, 2n, 1n, 0n, 0n], scope: 'once' },
  'century': { amounts: [25n, 2n, 0n, 0n, 0n], scope: 'once' },
  'on-the-board': { amounts: [3n, 1n, 0n, 0n, 0n], scope: 'once' },
  'kindling': { amounts: [3n, 0n, 0n, 0n, 0n], scope: 'once' },
  'furnace': { amounts: [15n, 3n, 1n, 0n, 0n], scope: 'once' },
  'century-digger': { amounts: [12n, 2n, 0n, 0n, 0n], scope: 'once' },
  'grand-digger': { amounts: [50n, 10n, 3n, 0n, 0n], scope: 'once' },
  'patron': { amounts: [0n, 4n, 1n, 0n, 0n], scope: 'once' },
};

/**
 * Engagement ids that share a reward (one grant, no double-pay):
 * the hot-streak badge IS the streak-7 tier reward.
 */
export const REWARD_ALIAS = { 'hot-streak': 'streak-7' };

/** Map an engagement id (quest / badge / streak tier) to its reward id. */
export function rewardIdFor(engagementId) {
  return REWARD_ALIAS[engagementId] ?? engagementId;
}

/** On-chain bytes32 id: keccak256 of the utf8 reward id. */
export function rewardIdHex(rewardId) {
  return keccak256(toBytes(rewardId));
}

/**
 * The idempotency day for a reward, given today's 'YYYY-MM-DD'.
 * daily -> today's day number; weekend -> the Saturday's day number;
 * once -> 0.
 */
export function claimDayFor(rewardId, today = utcDay()) {
  const r = REWARDS[rewardId];
  if (!r) return 0;
  if (r.scope === 'daily') return dayNumber(today);
  if (r.scope === 'weekend') {
    const sat = saturdayOf(today);
    return sat ? dayNumber(sat) : dayNumber(today);
  }
  return 0;
}

/** claimKey: keccak256(abi.encodePacked(player, id, day)) -- mirrors the contract. */
export function claimKeyHex(player, idHex, day) {
  return keccak256(
    encodePacked(['address', 'bytes32', 'uint64'], [player, idHex, BigInt(day)]),
  );
}

/**
 * The digest the rewardSigner signs: keccak256(abi.encode(CLAIM_TYPEHASH,
 * player, rewardId, day)) -- the contract then applies the eth-signed-message
 * prefix itself, so the oracle signs THIS digest with --no-hash.
 */
export function claimDigestHex(player, idHex, day) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint64' }],
      [CLAIM_TYPEHASH, player, idHex, BigInt(day)],
    ),
  );
}

const GEM_NAMES = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

/** '5 Quartz + 2 Amber' -- skips zero slots. */
export function formatReward(amounts) {
  return amounts
    .map((a, i) => (a > 0n ? `${a} ${GEM_NAMES[i]}` : null))
    .filter(Boolean)
    .join(' + ');
}

/** Total gem count across rarities (for the confirm poll). */
export function rewardTotal(amounts) {
  return amounts.reduce((a, b) => a + b, 0n);
}

/** Self-check the table: Sapphire cap and sane scopes. Throws on violation. */
export function assertTableValid() {
  for (const [id, r] of Object.entries(REWARDS)) {
    if (!['daily', 'weekend', 'once'].includes(r.scope)) {
      throw new Error(`reward ${id}: bad scope ${r.scope}`);
    }
    if (r.amounts[3] !== 0n || r.amounts[4] !== 0n) {
      throw new Error(`reward ${id}: Ruby/Diamond not allowed (Sapphire cap)`);
    }
    if (rewardTotal(r.amounts) <= 0n) throw new Error(`reward ${id}: zero amounts`);
  }
}
