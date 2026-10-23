/**
 * The fusion card: burn N of a gem, receive the next tier up.
 *
 * Same lifecycle rules as redeemcard.js (kept out of ForestScene because
 * this is DOM, not canvas): reparent to <body> so #hud's stacking context
 * and pointer-events rule cannot blur or deaden the card, own the whole
 * open/submit/close flow, and quote ONLY from the chain's own live
 * numbers -- fusionRates is owner-settable, so a mirrored constant would
 * silently lie after any retune.
 *
 * HONEST MATH: every row shows the sink percent (what the recipe burns
 * over what it pays). Fusion is a convenience, never value-neutral
 * unless the table says so -- and the Ruby->Diamond step at the default
 * rate is exactly neutral, which the card must be able to show truthfully
 * too (0% sink, not "--").
 */

import { fusionRows } from './v10.js';

const GEM_COLORS = ['#cfd6dd', '#d9a441', '#3a6fd8', '#d83a5a', '#8a3ad8'];
const RARITY_NAMES = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

/**
 * Create the fusion card controller.
 *
 * @param {object} o
 * @param {() => (bigint|number)[]} o.getBalances    live gem balances (5)
 * @param {() => Promise<bigint[]|null>} o.readRates live fusionRates(0..3)
 * @param {(rarity:number, times:number) => Promise<{ok:boolean, reason?:string}>} o.onFuse
 * @param {() => void} o.onDone                       repaint after a confirmed fuse
 * @param {(msg:string, kind?:string) => void} [o.onStatus]
 */
export function createFusionCard({ getBalances, readRates, onFuse, onDone, onStatus }) {
  const card = document.getElementById('fusion-card');
  if (!card) return null;

  // Same reparenting rule as the redeem card: #hud is a stacking context
  // with pointer-events: none -- the card must live on <body> to be sharp
  // and clickable.
  document.body.appendChild(card);

  const backdrop = document.createElement('div');
  backdrop.className = 'redeem-backdrop hidden';
  document.body.appendChild(backdrop);

  const elRows = document.getElementById('fusion-rows');
  const elInput = document.getElementById('fusion-input');
  const elOf = document.getElementById('fusion-of');
  const elPcts = document.getElementById('fusion-pcts');
  const elQuote = document.getElementById('fusion-quote');
  const elQuoteCur = document.getElementById('fusion-quote-cur');
  const elMsg = document.getElementById('fusion-msg');
  const elGo = document.getElementById('fusion-go');
  const elClose = document.getElementById('fusion-close');

  let selected = 0;
  let times = 1;
  let rows = [];
  let busy = false;

  const held = (r) => {
    const b = getBalances?.() ?? [];
    const v = b[r];
    try { return typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0)); }
    catch { return 0n; }
  };

  const maxSteps = () => {
    const r = rows[selected];
    if (!r || !r.enabled) return 0n;
    return held(selected) / BigInt(r.rate);
  };

  const fmt = (v) => BigInt(v).toLocaleString('en-US');

  const say = (msg, kind = '') => {
    elMsg.textContent = msg ?? '';
    elMsg.className = `redeem-msg ${kind}`.trim();
  };

  // --- rows ---------------------------------------------------------------

  const renderRows = () => {
    elRows.replaceChildren();
    rows.forEach((r, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fusion-row' + (i === selected ? ' sel' : '') + (r.enabled ? '' : ' off');
      b.disabled = !r.enabled;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', i === selected ? 'true' : 'false');
      const sink = r.sinkPct === 0 ? 'even trade' : `\u2212${r.sinkPct}% value`;
      b.innerHTML =
        `<span class="fusion-rate">${fmt(r.rate)}\u00d7 ${RARITY_NAMES[r.rarity]}</span>` +
        `<span class="fusion-arrow" aria-hidden="true">\u2192</span>` +
        `<span class="fusion-out">1 ${RARITY_NAMES[r.rarity + 1]}</span>` +
        `<span class="fusion-sink">${r.enabled ? sink : 'not set'}</span>`;
      b.addEventListener('click', () => {
        if (!r.enabled || busy) return;
        selected = i;
        times = 1;
        elInput.value = '1';
        render();
      });
      elRows.appendChild(b);
    });
  };

  const render = () => {
    renderRows();
    const r = rows[selected];
    const max = maxSteps();
    elOf.textContent = `of ${fmt(max)}`;

    // percentage chips: 25 / 50 / 75 / max, same affordance as redeem
    elPcts.replaceChildren();
    for (const pct of [25, 50, 75, 100]) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'redeem-pct';
      c.textContent = pct === 100 ? 'max' : `${pct}%`;
      c.disabled = max === 0n;
      c.addEventListener('click', () => {
        times = Number((max * BigInt(pct)) / 100n) || (pct === 100 ? Number(max) : 0);
        if (pct === 100) times = Number(max);
        elInput.value = String(times);
        render();
      });
      elPcts.appendChild(c);
    }

    const valid = r?.enabled && times >= 1 && times <= Number(max);
    if (r?.enabled && times > 0 && times <= Number(max)) {
      elQuote.textContent = fmt(BigInt(times));
      elQuoteCur.textContent = `${RARITY_NAMES[selected + 1]}${times === 1 ? '' : 's'} (burns ${fmt(BigInt(times) * BigInt(r.rate))} ${RARITY_NAMES[selected]})`;
      elGo.disabled = busy;
      say(max === 0n
        ? `You hold ${fmt(held(selected))} ${RARITY_NAMES[selected]} \u2014 need ${fmt(r.rate)} per fuse.`
        : '');
    } else {
      elQuote.textContent = '--';
      elQuoteCur.textContent = RARITY_NAMES[selected + 1] ?? '';
      elGo.disabled = true;
      if (r?.enabled && times > Number(max)) say(`Only ${fmt(max)} step${max === 1n ? '' : 's'} possible with ${fmt(held(selected))} held.`);
    }
  };

  // --- input ---------------------------------------------------------------

  elInput.addEventListener('input', () => {
    const v = Math.trunc(Number(elInput.value.replace(/[^0-9]/g, '')) || 0);
    times = v;
    render();
  });

  elGo.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    elGo.disabled = true;
    say('Confirm the fusion in your wallet\u2026', 'busy');
    const r = rows[selected];
    const res = await onFuse(selected, times);
    busy = false;
    if (!res.ok) {
      say(res.reason || 'Fusion failed.', 'bad');
      onStatus?.(res.reason || 'Fusion failed.', 'bad');
      render();
      return;
    }
    say(`Fused ${fmt(times)}\u00d7: ${fmt(BigInt(times) * BigInt(r.rate))} ${RARITY_NAMES[selected]} \u2192 ${fmt(times)} ${RARITY_NAMES[selected + 1]}.`, 'ok');
    onStatus?.(`Fused into ${RARITY_NAMES[selected + 1]}.`, 'ok');
    onDone?.();
    await refresh();
    times = 1;
    elInput.value = '1';
    render();
  });

  const close = () => {
    card.classList.add('hidden');
    backdrop.classList.add('hidden');
  };
  elClose.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const refresh = async () => {
    const rates = await readRates();
    if (rates) rows = fusionRows(rates);
    render();
  };

  const open = async () => {
    say('');
    times = 1;
    elInput.value = '1';
    await refresh();
    card.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    import('./analytics.js').then(({ track }) => track('fusion_card_open'));
  };

  return { open, close, refresh };
}
