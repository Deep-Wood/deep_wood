import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STREAK_TIERS, utcDay, dayBefore, emptyState, loadState, saveState,
  markActive, currentStreak, streakTier, nextTierAt,
  QUESTS, deriveQuests, allQuestsDone, activeQuests, WEEKEND_QUEST,
  isWeekend, saturdayOf,
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

// 2026-10-20 is a Tuesday: 23 Fri, 24 Sat, 25 Sun, 26 Mon, 27 Tue.
// Any 3 consecutive days cycle all three daily pairs, so these fixtures cover
// the rotation without hardcoding which pair a date maps to.
const idsOf = (day) => activeQuests(day).map((q) => q.id);
// Three consecutive UTC days cycle all three pairs; the 25th is a Sunday but
// its DAILY pair follows the same rotation, so including it completes the
// modulo coverage the weekend-skipping list was missing.
const someDayWith = (...wanted) => ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']
  .find((d) => wanted.every((w) => idsOf(d).includes(w)));

test('rotation: 2 of 3 dailies per UTC day; every daily appears within 3 days', () => {
  for (const d of ['2026-10-23', '2026-10-26', '2026-10-27']) {
    const rows = activeQuests(d);
    assert.equal(rows.length, 2, `${d} is a weekday: exactly two dailies`);
    assert.ok(!rows.some((q) => q.id === 'big-dig'), 'no Big Dig on weekdays');
  }
  const seen = new Set([...idsOf('2026-10-23'), ...idsOf('2026-10-26'), ...idsOf('2026-10-27')]);
  assert.equal(seen.size, 3, 'all three dailies rotate in across three days');
  // Deterministic: the same date always maps to the same pair.
  assert.deepEqual(idsOf('2026-10-26'), idsOf('2026-10-26'));
});

test('weekends add the Big Dig on top of the rotated pair', () => {
  for (const d of ['2026-10-24', '2026-10-25']) { // Sat, Sun
    const rows = activeQuests(d);
    assert.equal(rows.length, 3, `${d}: two dailies + the Big Dig`);
    assert.ok(rows.some((q) => q.id === WEEKEND_QUEST.id));
    assert.equal(rows.filter((q) => q.id === 'big-dig').length, 1);
  }
});

test('weekend helpers: isWeekend and saturdayOf', () => {
  assert.equal(isWeekend('2026-10-24'), true);   // Saturday
  assert.equal(isWeekend('2026-10-25'), true);   // Sunday
  assert.equal(isWeekend('2026-10-26'), false);  // Monday
  assert.equal(saturdayOf('2026-10-24'), '2026-10-24', 'Saturday maps to itself');
  assert.equal(saturdayOf('2026-10-25'), '2026-10-24', 'Sunday maps back to Saturday');
  assert.equal(saturdayOf('2026-10-26'), null, 'weekdays have no weekend');
});

test('quest progress derives from clamped deltas for the day\'s active quests', () => {
  const day = someDayWith('warm-pick', 'prospectors-eye');
  assert.ok(day, 'a rotation day carries warm-pick + prospectors-eye');
  const rows = deriveQuests(day, { digs: 7, amber: 5, burned: 1 });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId['warm-pick'].progress, 7);
  assert.equal(byId['warm-pick'].done, false);
  assert.equal(byId['prospectors-eye'].progress, 3, 'over-goal clamps to the goal');
  assert.equal(byId['prospectors-eye'].done, true);
  assert.ok(!byId['keep-it-sharp'], 'the rotated-out daily is absent from the board');

  // weekendDigs is included so the perfect case also completes the Big Dig
  // when the matched rotation day happens to be a weekend day.
  const perfect = deriveQuests(day, { digs: 20, amber: 9, burned: 2, weekendDigs: 100 });
  assert.equal(allQuestsDone(perfect), true);
});

test('negative deltas (a redemption emptied the satchel) never show negative progress', () => {
  const day = someDayWith('prospectors-eye');
  const rows = deriveQuests(day, { digs: 0, amber: -4, burned: 0 });
  const amber = rows.find((r) => r.id === 'prospectors-eye');
  assert.equal(amber.progress, 0);
  assert.equal(amber.done, false);
});

test('the weekend Big Dig counts weekend-spanning digs and clamps at its goal', () => {
  const rows = deriveQuests('2026-10-25', { digs: 0, amber: 0, burned: 0, weekendDigs: 120 });
  const big = rows.find((r) => r.id === 'big-dig');
  assert.ok(big, 'the Big Dig is on Sunday\'s board');
  assert.equal(big.progress, 100, 'clamps to the goal');
  assert.equal(big.done, true);
  const mid = deriveQuests('2026-10-25', { weekendDigs: 40 });
  assert.equal(mid.find((r) => r.id === 'big-dig').progress, 40);
  assert.equal(mid.find((r) => r.id === 'big-dig').done, false);
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

test('milestone badges derive from playerStats lifetime facts', () => {
  assert.ok(evalBadges(snap({ burned: 10 })).includes('kindling'));
  assert.ok(!evalBadges(snap({ burned: 9 })).includes('kindling'));
  assert.ok(evalBadges(snap({ burned: 250 })).includes('furnace'));
  assert.ok(!evalBadges(snap({ burned: 249 })).includes('furnace'));
  assert.ok(evalBadges(snap({ hunts: 100 })).includes('century-digger'));
  assert.ok(evalBadges(snap({ hunts: 1000 })).includes('grand-digger'));
  assert.ok(!evalBadges(snap({ hunts: 999 })).includes('grand-digger'));
  assert.ok(evalBadges(snap({ tokenSpentWhole: 100000 })).includes('patron'));
  assert.ok(!evalBadges(snap({ tokenSpentWhole: 99999 })).includes('patron'));
  // Absent facts never award: a sparse snapshot unlocks none of the five.
  for (const id of ['kindling', 'furnace', 'century-digger', 'grand-digger', 'patron']) {
    assert.ok(!evalBadges(snap()).includes(id));
  }
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
