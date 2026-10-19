import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STREAK_TIERS, utcDay, dayBefore, emptyState, loadState, saveState,
  markActive, currentStreak, streakTier, nextTierAt,
  QUESTS, deriveQuests, allQuestsDone,
  BADGES, evalBadges,
} from './engagement.js';

const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

// --- streak ---------------------------------------------------------------

test('utcDay is UTC-normalized and dayBefore steps back one UTC day', () => {
  assert.equal(utcDay(Date.UTC(2026, 9, 19, 23, 59, 59)), '2026-10-19');
  assert.equal(utcDay(Date.UTC(2026, 9, 20, 0, 0, 0)), '2026-10-20');
  assert.equal(dayBefore('2026-10-20'), '2026-10-19');
  // month boundary
  assert.equal(dayBefore('2026-10-01'), '2026-09-30');
});

test('currentStreak counts consecutive days and survives a not-yet-active today', () => {
  const s = emptyState();
  assert.equal(currentStreak(s, '2026-10-19'), 0);
  markActive(s, '2026-10-18');
  markActive(s, '2026-10-17');
  // today not yet active: streak still counts through yesterday
  assert.equal(currentStreak(s, '2026-10-19'), 2);
  markActive(s, '2026-10-19');
  assert.equal(currentStreak(s, '2026-10-19'), 3);
});

test('a gap breaks the streak; best survives', () => {
  const s = emptyState();
  for (const d of ['2026-10-16', '2026-10-17', '2026-10-18']) markActive(s, d);
  s.best = currentStreak(s, '2026-10-18');
  assert.equal(s.best, 3);
  // skip to the 20th
  markActive(s, '2026-10-20');
  assert.equal(currentStreak(s, '2026-10-20'), 1, 'gap must reset to just today');
  assert.equal(s.best, 3, 'best is not lowered by a reset');
});

test('streak tiers and the next honor', () => {
  assert.equal(streakTier(2), null);
  assert.equal(streakTier(3)?.title, 'Warming Up');
  assert.equal(streakTier(7)?.title, 'Hot Streak');
  assert.equal(streakTier(99)?.title, STREAK_TIERS[STREAK_TIERS.length - 1].title);
  assert.equal(nextTierAt(0), 3);
  assert.equal(nextTierAt(7), 14);
  assert.equal(nextTierAt(30), null);
});

test('storage round-trips and tolerates garbage', () => {
  const store = mem();
  const s = emptyState();
  markActive(s, '2026-10-19');
  s.best = 5;
  saveState(s, store);
  const back = loadState(store);
  assert.equal(back.days['2026-10-19'], 1);
  assert.equal(back.best, 5);
  store.setItem('dw-engagement', '{not json');
  assert.deepEqual(loadState(store), emptyState());
  store.setItem('dw-engagement', 'null');
  assert.deepEqual(loadState(store), emptyState());
});

// --- daily quests ----------------------------------------------------------

test('quest progress derives from clamped deltas', () => {
  const rows = deriveQuests({ digs: 7, amber: 5, burned: 1 });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId['warm-pick'].progress, 7);
  assert.equal(byId['warm-pick'].done, false);
  assert.equal(byId['prospectors-eye'].progress, 3, 'over-goal clamps to the goal');
  assert.equal(byId['prospectors-eye'].done, true);
  assert.equal(byId['keep-it-sharp'].done, true);
  assert.equal(allQuestsDone(rows), false, 'warm-pick is still open');

  const perfect = deriveQuests({ digs: 20, amber: 9, burned: 2 });
  assert.equal(allQuestsDone(perfect), true);
});

test('negative deltas (a redemption emptied the satchel) never show negative progress', () => {
  const rows = deriveQuests({ digs: 0, amber: -4, burned: 0 });
  const amber = rows.find((r) => r.id === 'prospectors-eye');
  assert.equal(amber.progress, 0);
  assert.equal(amber.done, false);
});

// --- badges ----------------------------------------------------------------

const snap = (over = {}) => ({
  gems: [10n, 2n, 1n, 0n, 0n], tier: 3, skill: 3, totalEarned: 40, onRoiBoard: false, streak: 4, ...over,
});

test('badges evaluate from on-chain facts only', () => {
  const ids = evalBadges(snap());
  assert.ok(ids.includes('first-find'));
  assert.ok(ids.includes('amber-rush'));
  assert.ok(ids.includes('deep-blue'));
  assert.ok(!ids.includes('ruby-crown'));
  assert.ok(!ids.includes('mithril-club'));
  assert.ok(!ids.includes('hot-streak'));

  assert.ok(evalBadges(snap({ gems: [0n, 0n, 0n, 1n, 0n] })).includes('ruby-crown'));
  assert.ok(evalBadges(snap({ gems: [0n, 0n, 0n, 0n, 1n] })).includes('diamond-club'));
  assert.ok(evalBadges(snap({ tier: 5 })).includes('mithril-club'));
  assert.ok(evalBadges(snap({ skill: 5 })).includes('lapidary'));
  assert.ok(evalBadges(snap({ totalEarned: 100 })).includes('century'));
  assert.ok(evalBadges(snap({ onRoiBoard: true })).includes('on-the-board'));
  assert.ok(evalBadges(snap({ streak: 7 })).includes('hot-streak'));
});

test('badge tests cannot throw on sparse snapshots', () => {
  assert.doesNotThrow(() => evalBadges({}));
  assert.doesNotThrow(() => evalBadges({ gems: ['x', undefined, null] }));
});

test('badge ids are unique and every badge is reachable', () => {
  assert.equal(new Set(BADGES.map((b) => b.id)).size, BADGES.length);
  for (const b of BADGES) {
    assert.match(b.name, /\S/);
    assert.match(b.how, /\S/);
  }
});
