// The engagement pack: daily streak, daily quests, badges.
//
// WHY THIS EXISTS
// ===============
// The dig loop is cyclical but flat: log in, dig, log out. The idle/tap
// genre's retention engines -- streaks, daily quests, collections,
// celebration moments -- were all missing. This module is the pure logic;
// src/camp.js owns the DOM, ForestScene owns the wiring.
//
// HONESTY RULES (these are why the module looks the way it does)
// ==============================================================
// 1. Every number derives from ON-CHAIN facts -- huntIndex deltas, gem
//    balances, playerStats. Nothing is granted locally: the client cannot
//    mint gems, so streaks and quests pay out in honors (titles, badges,
//    celebration), never fake balances. No number is ever invented.
// 2. UTC days, so the streak means the same thing for every player.
// 3. Storage is localStorage ONLY as a cache of derived facts: the chain
//    remains the source of truth, and clearing storage re-derives
//    everything except the "already toasted" flags.
// 4. A missed day resets the streak to 0 but keeps `best`. Honesty over
//    generosity -- a streak that cannot break is not a streak.

const KEY = 'dw-engagement';

// ---------------------------------------------------------------------------
// Streak: consecutive UTC days with at least one SETTLED hunt.
// ---------------------------------------------------------------------------

/** Highest streak honors, in order. The title in the card comes from these. */
export const STREAK_TIERS = [
  { d: 3, title: 'Warming Up' },
  { d: 7, title: 'Hot Streak' },
  { d: 14, title: 'Deep Habit' },
  { d: 30, title: 'Woodborn' },
];

/** 'YYYY-MM-DD' for a ms timestamp, in UTC. */
export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** The UTC day before a 'YYYY-MM-DD' string. */
export function dayBefore(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function emptyState() {
  return { days: {}, best: 0, badgesSeen: [], baseline: null };
}

/** Load from localStorage; corrupt/absent data = fresh state, never a crash. */
export function loadState(store) {
  try {
    const raw = store?.getItem?.(KEY);
    if (!raw) return emptyState();
    const s = JSON.parse(raw);
    if (typeof s !== 'object' || s === null) return emptyState();
    return {
      days: (s.days && typeof s.days === 'object') ? s.days : {},
      best: Number(s.best) || 0,
      badgesSeen: Array.isArray(s.badgesSeen) ? s.badgesSeen : [],
      baseline: (s.baseline && typeof s.baseline === 'object') ? s.baseline : null,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state, store) {
  try {
    // Keep at most the last 60 days: the streak only walks back until the
    // first gap, and unbounded growth would one day make the JSON slow.
    const days = state.days;
    const keys = Object.keys(days).sort();
    while (keys.length > 60) delete days[keys.shift()];
    store?.setItem?.(KEY, JSON.stringify(state));
  } catch { /* private mode / full disk: engagement degrades to per-session */ }
}

/** Mark a UTC day as active. Returns true if it was new (streak may grow). */
export function markActive(state, day) {
  if (!state.days[day]) {
    state.days[day] = 1;
    return true;
  }
  return false;
}

/** Consecutive active days ending today (or yesterday, if today is not yet active). */
export function currentStreak(state, today) {
  let streak = 0;
  let day = state.days[today] ? today : dayBefore(today);
  while (state.days[day]) {
    streak += 1;
    day = dayBefore(day);
  }
  return streak;
}

/** The highest honor earned at a streak length. */
export function streakTier(streak) {
  let tier = null;
  for (const t of STREAK_TIERS) if (streak >= t.d) tier = t;
  return tier;
}

/** Streak length the NEXT honor unlocks at (null when all are held). */
export function nextTierAt(streak) {
  for (const t of STREAK_TIERS) if (streak < t.d) return t.d;
  return null;
}

// ---------------------------------------------------------------------------
// Daily quests: derived entirely from on-chain deltas since UTC midnight.
// ---------------------------------------------------------------------------

/**
 * The quest board. `key` indexes the deltas object the wiring computes:
 *   digs   -- huntIndex advanced since the day's first sample (settles only)
 *   amber  -- Amber gained since the day's first sample (clamped at 0)
 *   burned -- gems burned since the day's first sample (repair or skill)
 */
export const QUESTS = [
  { id: 'warm-pick', title: 'Warm Pick', desc: 'Settle 20 digs today', goal: 20, unit: 'digs', key: 'digs' },
  { id: 'prospectors-eye', title: "Prospector's Eye", desc: 'Find 3 Amber today', goal: 3, unit: 'Amber', key: 'amber' },
  { id: 'keep-it-sharp', title: 'Keep It Sharp', desc: 'Burn gems on a repair or skill today', goal: 1, unit: 'repair', key: 'burned' },
];

/** Quest progress rows for the card. `deltas` values are clamped >= 0 here. */
export function deriveQuests(deltas = {}) {
  return QUESTS.map((q) => {
    const raw = Number(deltas[q.key] ?? 0);
    const progress = Math.max(0, Math.min(raw, q.goal));
    return { ...q, progress, done: progress >= q.goal };
  });
}

/** True when every quest is complete ("perfect day" flag). */
export function allQuestsDone(quests) {
  return quests.length > 0 && quests.every((q) => q.done);
}

// ---------------------------------------------------------------------------
// Badges: on-chain lifetime facts, evaluated against a snapshot.
// ---------------------------------------------------------------------------

const gemAt = (s, r) => {
  const v = s.gems?.[r] ?? 0;
  return typeof v === 'bigint' ? Number(v) : Number(v || 0);
};
const gemSum = (s) => (s.gems || []).reduce((a, v) => a + (typeof v === 'bigint' ? Number(v) : Number(v || 0)), 0);

/**
 * The trophy shelf. Every `test` reads facts the chain reports -- never a
 * local-only assertion -- so a badge cannot be faked by editing storage.
 */
export const BADGES = [
  { id: 'first-find', name: 'First Find', how: 'Find your first gem', test: (s) => gemSum(s) > 0 || (s.totalEarned ?? 0) > 0 },
  { id: 'amber-rush', name: 'Amber Rush', how: 'Hold an Amber', test: (s) => gemAt(s, 1) > 0 },
  { id: 'deep-blue', name: 'Deep Blue', how: 'Hold a Sapphire', test: (s) => gemAt(s, 2) > 0 },
  { id: 'ruby-crown', name: 'Ruby Crown', how: 'Hold a Ruby', test: (s) => gemAt(s, 3) > 0 },
  { id: 'diamond-club', name: 'Diamond Club', how: 'Hold a Diamond', test: (s) => gemAt(s, 4) > 0 },
  { id: 'mithril-club', name: 'Mithril Club', how: 'Wield the Mithril pick', test: (s) => (s.tier ?? 0) >= 5 },
  { id: 'lapidary', name: 'Lapidary', how: 'Reach skill 5', test: (s) => (s.skill ?? 0) >= 5 },
  { id: 'century', name: 'Century Club', how: 'Earn 100 gems lifetime', test: (s) => (s.totalEarned ?? 0) >= 100 },
  { id: 'on-the-board', name: 'On The Board', how: 'Enter the ROI leaderboard', test: (s) => s.onRoiBoard === true },
  { id: 'hot-streak', name: 'Hot Streak', how: 'A 7-day dig streak', test: (s) => (s.streak ?? 0) >= 7 },
];

/** IDs of every badge whose test passes on this snapshot. */
export function evalBadges(snapshot) {
  return BADGES.filter((b) => {
    try { return !!b.test(snapshot); } catch { return false; }
  }).map((b) => b.id);
}
