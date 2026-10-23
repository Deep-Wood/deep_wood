/**
 * V10 client mirror: prestige ("Descend"), research (luck), gem fusion,
 * and the V9 -> V10 migration.
 *
 * THE ONE RULE THIS MODULE ENFORCES
 * ================================
 * Every number these features display is read from the chain (the
 * LIVE_* discipline economy.js uses). The owner can retune every V10
 * knob post-deploy (setV10Config / setFusionRates), so a mirrored
 * constant would silently lie. Defaults here exist only so a build with
 * no contract behind it still renders; bootChain refreshes them.
 *
 * The ROLL MULTIPLIER is correctness-critical, not cosmetic: engine.js
 * applies findWeightBps to locally rolled digs 2-20 exactly as _rollHunt
 * does, or the settle gate reverts the whole batch (ResultMismatch).
 */
import { PRICE } from './engine.js';

/** Live V10 config, refreshed at boot by applyV10Config(). */
export let LIVE_V10_CONFIG = {
  coeff: 2500n,
  cap: 30000n,
  minLeq: 1n,
  researchSurvives: true,
  luckBpsPerLevel: 250n,
  luckBase: 50n,
};

/** Live fusion rates [Q->A, A->S, S->R, R->D], refreshed at boot. */
export let LIVE_FUSION_RATES = [20n, 12n, 12n, 4n];

export function applyV10Config(cfg) {
  LIVE_V10_CONFIG = { ...LIVE_V10_CONFIG, ...cfg };
}

export function applyFusionRates(rates) {
  LIVE_FUSION_RATES = rates.map((r) => BigInt(r));
}

/** Luck level from the packed research word: byte 2 (bits 16-23). */
export function luckLevelOf(packed) {
  return Number((BigInt(packed) >> 16n) & 0xffn);
}

/** Luck bps added to the find-weight multiplier at this packed level. */
export function luckBpsOf(packed, bpsPerLevel = LIVE_V10_CONFIG.luckBpsPerLevel) {
  return BigInt(luckLevelOf(packed)) * BigInt(bpsPerLevel);
}

/**
 * The multiplier engine.js must apply to local rolls:
 * prestigeBpsOf(leq) + luckBps(packed). prestigeBps comes from the
 * CONTRACT (prestigeBpsOf is a public view), so the sqrt and the cap can
 * never drift between client and chain.
 */
export async function findWeightBps(reader, account) {
  const [stats, packed] = await Promise.all([
    reader.playerStats(account),
    reader.researchOf(account),
  ]);
  const [bps, cfg] = await Promise.all([
    reader.prestigeBpsOf(stats.leq),
    reader.v10Config(),
  ]);
  return {
    findWeightBps: bps + BigInt(luckLevelOf(packed)) * BigInt(cfg.luckBpsPerLevel),
    packed,
    leq: stats.leq,
    prestigeBps: bps,
    config: cfg,
  };
}

/** Next study cost: luckBase << level (doubles per level, 50/100/200/400/800). */
export function studyCost(level, base = LIVE_V10_CONFIG.luckBase) {
  return BigInt(base) << BigInt(level);
}

/**
 * One fusion row for the UI: value-honest math so the card can show the
 * sink instead of hiding it.
 *
 *   burnValue  = rate * PRICE[rarity]       (what you give up)
 *   gettValue  = PRICE[rarity + 1]          (what you receive)
 *   sinkPct    = 1 - gettValue / burnValue  (>= 0: never mints value)
 */
export function fusionRow(rarity, rate = LIVE_FUSION_RATES[rarity]) {
  const burnValue = BigInt(rate) * BigInt(PRICE[rarity]);
  const gettValue = BigInt(PRICE[rarity + 1]);
  const sinkPct =
    burnValue === 0n
      ? 0n
      : Number(((burnValue - gettValue) * 10000n) / burnValue) / 100;
  return {
    rarity,
    rate: BigInt(rate),
    burnValue,
    gettValue,
    sinkPct,
    enabled: BigInt(rate) > 0n,
  };
}

/** All four rows, cheapest-first order preserved. */
export function fusionRows(rates = LIVE_FUSION_RATES) {
  return [0, 1, 2, 3].map((r) => fusionRow(r, rates[r]));
}

/**
 * What a descend keeps vs wipes -- the panel's honest list. Static
 * FACTS of the contract (not owner-tunable), worded for the card.
 */
export const DESCEND_RESETS = ['Satchel', 'Tool', 'Skill'];
export const DESCEND_KEEPS = [
  'Research levels',
  'Lifetime stats (leq)',
  'Board standing',
];

/**
 * Fetch everything the V10 panels display, in one parallel batch.
 * Cheap views; called on card open and after any V10 write.
 */
export async function readV10Panels(reader, account) {
  const [cfg, rates, packed, prest, stats, migrated] = await Promise.all([
    reader.v10Config(),
    Promise.all([0, 1, 2, 3].map((i) => reader.fusionRates(i))),
    reader.researchOf(account),
    reader.prestigeCount(account),
    reader.playerStats(account),
    reader.migratedV9(account).catch(() => true),
  ]);
  applyV10Config(cfg);
  applyFusionRates(rates);
  const level = luckLevelOf(packed);
  return {
    config: cfg,
    fusionRates: rates,
    luckLevel: level,
    luckBps: BigInt(level) * BigInt(cfg.luckBpsPerLevel),
    maxLuckLevel: 5,
    nextStudyCost: level >= 5 ? null : studyCost(level, cfg.luckBase),
    prestigeCount: prest,
    leq: stats.leq,
    migratedV9: migrated,
  };
}
