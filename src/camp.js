// The Camp card + celebration moments: the DOM half of the engagement pack.
//
// Kept out of ForestScene.js because it is DOM, not canvas (same rule as
// redeemcard.js). Owns: the launcher chip state, the card's whole lifecycle,
// the lucky-strike overlay, badge unlock toasts, and the next-vein tease.

import {
  STREAK_TIERS, streakTier, nextTierAt, BADGES, SKINS, chooseSkin,
} from './engagement.js';
import { toolAvatarSkinned } from './economy.js';

const GEM_COLORS = ['#cfd6dd', '#d9a441', '#3a6fd8', '#d83a5a', '#8a3ad8'];
const GEM_NAMES = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

const FLAME_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c0-1.5-1-2-1-3.5C16.5 9 18 11 18 14a6 6 0 0 1-12 0c0-5 4-7 6-12Z" fill="currentColor"/></svg>`;
const TROPHY_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 4h10v2h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 15.9V18h3v2H8v-2h3v-2.1A5 5 0 0 1 8.3 13H8a4 4 0 0 1-4-4V6h3V4Zm0 4H6v1a2 2 0 0 0 2 2V8Zm10 0v3a2 2 0 0 0 2-2V8h-2Z" fill="currentColor"/></svg>`;

const q = (id) => document.getElementById(id);

/**
 * Create the Camp controller.
 *
 * @param {object} o
 * @param {() => {streak:number, quests:object[], baselineDay:string, deltas:object}} o.readEngagement
 *        Live engagement view computed by ForestScene (pure reads, cheap).
 * @param {() => string[]} o.readBadges  IDs of unlocked badges (on-chain facts).
 * @param {() => void} [o.onOpen]        fires when the card opens (analytics).
 */
export function createCamp({ readEngagement, readBadges, onOpen }) {
  const card = q('camp-card');
  if (!card) return null;
  // The camp is opened from the wallet menu now; there is no launcher chip.
  document.body.appendChild(card); // same stacking-context rule as the redeem card
  const backdrop = document.createElement('div');
  backdrop.className = 'redeem-backdrop hidden';
  document.body.appendChild(backdrop);

  const elStreak = q('camp-streak');
  const elStreakTitle = q('camp-streak-title');
  const elStreakNext = q('camp-streak-next');
  const elQuests = q('camp-quests');
  const elBadges = q('camp-badges');
  const elBadgeCount = q('camp-badge-count');
  const elSkins = q('camp-skins');
  const elClose = q('camp-close');

  function render() {
    const { streak, quests, deltas } = readEngagement() ?? {};
    if (streak == null) return;

    const tier = streakTier(streak);
    elStreak.innerHTML = `${FLAME_SVG}<b>${streak}</b><span>day${streak === 1 ? '' : 's'}</span>`;
    elStreak.classList.toggle('lit', streak >= 3);
    // Below the first honor (3 days) the streak is LIVE but unranked: "1 day
    // + No streak yet" read as a contradiction (user, 2026-10-21), so the
    // title says it is building instead of denying it exists.
    elStreakTitle.textContent = tier ? tier.title : (streak > 0 ? 'Streak building' : 'No streak yet');
    const nextAt = nextTierAt(streak);
    elStreakNext.textContent = nextAt
      ? `Next honor at ${nextAt} day${nextAt === 1 ? '' : 's'} — settle at least one dig a day, UTC.`
      : 'Every honor is held. A missed day resets the count — best is kept.';

    elQuests.innerHTML = quests.map((r) => {
      const pct = r.goal > 0 ? Math.round((r.progress / r.goal) * 100) : 0;
      return `<div class="camp-quest${r.done ? ' done' : ''}" title="${r.desc}">
        <div class="cq-top"><span class="cq-name">${r.title}</span>
          <span class="cq-count">${r.progress}/${r.goal}</span></div>
        <div class="cq-bar"><div class="cq-fill" style="width:${pct}%"></div></div>
        <div class="cq-desc">${r.desc}</div>
      </div>`;
    }).join('');

    renderSkins();

    const unlocked = readBadges() ?? [];
    elBadges.innerHTML = BADGES.map((b) => {
      const has = unlocked.includes(b.id);
      return `<div class="camp-badge${has ? '' : ' locked'}" title="${b.how}${has ? '' : ' — locked'}">
        <span class="cb-glyph" style="--bc:${badgeColor(b.id)}">${badgeGlyph(b.id)}</span>
        <span class="cb-name">${b.name}</span>
        <span class="cb-how">${has ? 'Earned' : b.how}</span>
      </div>`;
    }).join('');
    elBadgeCount.textContent = `${unlocked.length}/${BADGES.length}`;
    void deltas;
  }

  function open() {
    render();
    onOpen?.();
    card.classList.remove('hidden');
    backdrop.classList.remove('hidden');
  }
  function close() {
    card.classList.add('hidden');
    backdrop.classList.add('hidden');
  }
  const isOpen = () => !card.classList.contains('hidden');

  /**
   * The tool-skin shelf: the base wood plus one chip per skin. Earned chips
   * are selectable; locked ones show the honor they need and stay disabled.
   * The preview pickaxe uses the held tier's metal (tier 1 shape when no
   * tool is held) so the skin always reads in context.
   */
  function renderSkins() {
    if (!elSkins) return;
    const eng = readEngagement() ?? {};
    const skinIds = eng.skins ?? [];
    const tier = Math.max(1, eng.skinFacts?.tier ?? 0);
    let picked = null;
    try { picked = localStorage.getItem('dw-skin'); } catch { picked = null; }
    const chip = (k) => {
      const earned = k ? skinIds.includes(k.id) : true;
      const sel = k ? picked === k.id : !picked;
      return `<button type="button" class="cs-chip${earned ? '' : ' locked'}${sel ? ' picked' : ''}"
          data-skin="${k ? k.id : ''}" title="${k ? k.how : 'Standard wood'}"${earned ? '' : ' disabled'}>`
        + `<span class="cs-mini">${toolAvatarSkinned(tier, k)}</span>`
        + `<span class="cs-name">${k ? k.name : 'Standard'}</span></button>`;
    };
    elSkins.innerHTML = [chip(null), ...SKINS.map(chip)].join('');
    elSkins.querySelectorAll('.cs-chip').forEach((b) => {
      b.addEventListener('click', () => {
        chooseSkin(b.dataset.skin || null, localStorage);
        import('./analytics.js').then(({ track }) => track('camp_skin_pick', { skin: b.dataset.skin || 'standard' })).catch(() => {});
        window.renderHunter?.();
        render();
      });
    });
  }

  elClose.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

  return { open, close, isOpen, render };
}

function badgeColor(id) {
  if (id === 'ruby-crown') return GEM_COLORS[3];
  if (id === 'diamond-club') return GEM_COLORS[4];
  if (id === 'deep-blue') return GEM_COLORS[2];
  if (id === 'amber-rush') return GEM_COLORS[1];
  if (id === 'first-find') return GEM_COLORS[0];
  if (id === 'kindling') return '#d97a3a';
  if (id === 'furnace') return '#c9431e';
  if (id === 'century-digger') return '#8b9dc3';
  if (id === 'grand-digger') return '#4d6a99';
  return 'var(--gold)';
}

function badgeGlyph(id) {
  // Rarity badges show the gem's letter; milestones show their own mark.
  const gemIds = { 'first-find': 'Q', 'amber-rush': 'A', 'deep-blue': 'S', 'ruby-crown': 'R', 'diamond-club': 'D' };
  if (gemIds[id]) return gemIds[id];
  if (id === 'mithril-club') return 'M5';
  if (id === 'lapidary') return 'Sk5';
  if (id === 'century') return '100';
  if (id === 'on-the-board') return TROPHY_SVG;
  if (id === 'hot-streak') return FLAME_SVG;
  if (id === 'kindling') return 'B10';
  if (id === 'furnace') return 'B250';
  if (id === 'century-digger') return 'H100';
  if (id === 'grand-digger') return 'H1k';
  if (id === 'patron') return '$';
  return '?';
}

// --- celebration moments -----------------------------------------------------

/**
 * Lucky Strike overlay: a rare find (Sapphire or better in the settled batch)
 * earns a full-screen flash. Fire-and-forget; never blocks input for long.
 * @param {{ counts: bigint[]|number[], best: number }} haul  the settled batch
 */
export function celebrateLuckyStrike(haul) {
  const overlay = q('strike-overlay');
  if (!overlay) return null;
  const rar = haul?.best ?? 0;
  if (rar < 2) return null; // Quartz/Amber are ordinary veins; Sapphire+ is a Strike
  const name = GEM_NAMES[rar] ?? 'gem';
  overlay.innerHTML = `<div class="strike-card" style="--bc:${GEM_COLORS[rar]}">
    <div class="strike-title">LUCKY STRIKE</div>
    <div class="strike-gem">${name.toUpperCase()} ×${Number(haul.counts?.[rar] ?? 0)}</div>
    <div class="strike-sub">the vein splits and the rock sings</div>
  </div>`;
  overlay.classList.remove('hidden');
  const kill = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; };
  setTimeout(kill, 2600);
  overlay.addEventListener('click', kill, { once: true });
  return rar;
}

/** Bottom-right unlock toast for a new badge. Auto-dismisses. */
export function badgeToast(badge) {
  const wrap = q('badge-toasts');
  if (!wrap || !badge) return;
  const el = document.createElement('div');
  el.className = 'badge-toast';
  el.innerHTML = `<span class="bt-glyph" style="--bc:${badgeColor(badge.id)}">${badgeGlyph(badge.id)}</span>
    <div class="bt-text"><b>Badge earned — ${badge.name}</b><span>${badge.how}</span></div>`;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('gone'); setTimeout(() => el.remove(), 600); }, 4200);
}

/** Bottom-right toast for a streak honor. */
export function streakToast(days, title) {
  const wrap = q('badge-toasts');
  if (!wrap || !days) return;
  const el = document.createElement('div');
  el.className = 'badge-toast streak';
  el.innerHTML = `<span class="bt-glyph">${FLAME_SVG}</span>
    <div class="bt-text"><b>${days}-day streak — ${title}</b><span>keep settling one dig a day</span></div>`;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('gone'); setTimeout(() => el.remove(), 600); }, 4200);
}

/** Belt tease for the next pre-rolled dig when it is genuinely rare. */
export function veinTease(rarity) {
  if (rarity < 3) return null; // Ruby+ only: rare enough to whisper about
  const line = {
    3: 'The next vein glints red — something ruby stirs in the rock.',
    4: 'The next vein is unnaturally bright. A diamond sleeps there.',
  }[rarity];
  const hint = q('hint');
  if (hint) { hint.textContent = line; hint.classList.add('gold'); setTimeout(() => hint.classList.remove('gold'), 6000); }
  return line;
}
