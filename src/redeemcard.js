// The redemption card: pick one rarity and an amount, redeem for $DEEPWOOD.
//
// Kept out of ForestScene.js because it is DOM, not canvas, and out of
// index.html because that file is already the boot script's home. This module
// owns the card's whole lifecycle: open, quote, submit, close.
//
// The quote comes from the CONTRACT (redeemQuoteToken), never from local
// arithmetic -- the pool price moves and the payout spread lives on chain, so a
// locally-derived number would drift from what the player actually receives.

import { PERCENT_STEPS, percentAmount, clampAmount, rarityRows, redeemState, fmtToken } from './redeem.js';

const GEM_COLORS = ['#cfd6dd', '#d9a441', '#3a6fd8', '#d83a5a', '#8a3ad8'];

/** Human label for a rarity index, for status messages. */
const RARITY_NAMES = ['Quartz', 'Amber', 'Sapphire', 'Ruby', 'Diamond'];

/**
 * Create the card controller.
 *
 * @param {object} o
 * @param {() => number[]} o.getBalances   live gem balances (5 entries)
 * @param {() => boolean}  o.railActive    is token redemption open?
 * @param {(rarity:number, amount:number) => Promise<{ok:boolean, reason?:string, payout?:bigint}>} o.onRedeem
 * @param {(rarity:number, amount:number) => Promise<{tokens:bigint, aboveFloor:boolean}|null>} o.onQuote
 * @param {(msg:string, kind?:string) => void} [o.onStatus]
 */
export function createRedeemCard({
  getBalances, railActive, onRedeem, onQuote, onStatus,
}) {
  const card = document.getElementById('redeem-card');
  if (!card) return null;

  const backdrop = document.createElement('div');
  backdrop.className = 'redeem-backdrop hidden';
  document.body.appendChild(backdrop);

  const elRarities = document.getElementById('redeem-rarities');
  const elInput = document.getElementById('redeem-input');
  const elOf = document.getElementById('redeem-of');
  const elPcts = document.getElementById('redeem-pcts');
  const elQuote = document.getElementById('redeem-quote');
  const elMsg = document.getElementById('redeem-msg');
  const elGo = document.getElementById('redeem-go');
  const elClose = document.getElementById('redeem-close');

  let selected = 0;
  let amount = 0;
  let quoteWei = null;
  let busy = false;
  let quoteSeq = 0; // guards against an out-of-order quote response

  const held = () => {
    const b = getBalances?.() ?? [];
    return Math.max(0, Math.floor(Number(b[selected]) || 0));
  };

  // --- rendering -----------------------------------------------------------

  function renderRarities() {
    const rows = rarityRows(getBalances?.() ?? []);
    elRarities.innerHTML = rows.map((r) => (
      `<button type="button" class="redeem-rarity" role="radio"`
      + ` data-rarity="${r.rarity}" aria-checked="${r.rarity === selected}"`
      + `${r.selectable ? '' : ' disabled'}>`
      + `<span class="dot" style="background:${GEM_COLORS[r.rarity]}"></span>`
      + `<span class="nm">${r.name}</span>`
      + `<span class="ct">${r.held}</span>`
      + '</button>'
    )).join('');
    elRarities.querySelectorAll('.redeem-rarity').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        selected = Number(btn.dataset.rarity) || 0;
        amount = 0;
        elInput.value = '';
        render();
      });
    });
  }

  function renderPcts() {
    const h = held();
    elPcts.innerHTML = PERCENT_STEPS.map((p) => (
      `<button type="button" class="redeem-pct" data-pct="${p}"`
      + `${h > 0 ? '' : ' disabled'}>${p}%</button>`
    )).join('');
    elPcts.querySelectorAll('.redeem-pct').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        amount = percentAmount(held(), Number(btn.dataset.pct) || 0);
        elInput.value = String(amount);
        render();
      });
    });
  }

  function render() {
    const h = held();
    // Selection may point at a rarity that just went empty (a redemption
    // landed). Fall back to the first non-empty one so the card is never
    // stuck on a dead row.
    if (h <= 0) {
      const rows = rarityRows(getBalances?.() ?? []);
      const first = rows.find((r) => r.selectable);
      if (first) selected = first.rarity;
    }

    elRarities.querySelectorAll('.redeem-rarity').forEach((btn) => {
      btn.setAttribute('aria-checked', Number(btn.dataset.rarity) === selected ? 'true' : 'false');
    });
    elOf.textContent = `of ${held()}`;

    const st = redeemState({
      held: held(), amount, quoteWei, floorWei: null, railActive: railActive?.() ?? true,
    });
    elGo.disabled = busy || !st.ok;
    elMsg.textContent = st.reason || '';
    elMsg.className = `redeem-msg${st.ok ? '' : ' bad'}`;
    elQuote.textContent = quoteWei == null ? '--' : fmtToken(quoteWei);
  }

  /**
   * Re-quote the current selection. Debounced by sequence number: a fast
   * typist fires several reads and only the newest may paint, otherwise an
   * older (smaller) quote lands last and the card understates the payout.
   */
  async function refreshQuote() {
    if (!onQuote || amount <= 0 || held() <= 0) {
      quoteWei = null;
      render();
      return;
    }
    const seq = ++quoteSeq;
    let q = null;
    try {
      q = await onQuote(selected, amount);
    } catch {
      q = null;
    }
    if (seq !== quoteSeq) return; // a newer quote is already in flight
    quoteWei = q && q.tokens != null ? q.tokens : null;
    render();
  }

  // --- open / close --------------------------------------------------------

  function open() {
    busy = false;
    amount = 0;
    quoteWei = null;
    elInput.value = '';
    // Preselect the first rarity the player actually holds.
    const rows = rarityRows(getBalances?.() ?? []);
    const first = rows.find((r) => r.selectable);
    selected = first ? first.rarity : 0;
    renderRarities();
    renderPcts();
    render();
    card.classList.remove('hidden');
    backdrop.classList.remove('hidden');
  }

  function close() {
    card.classList.add('hidden');
    backdrop.classList.add('hidden');
  }

  const isOpen = () => !card.classList.contains('hidden');

  // --- wiring --------------------------------------------------------------

  elInput.addEventListener('input', () => {
    amount = clampAmount(elInput.value, held());
    // Write the clamped value back so the field cannot display 9999 while the
    // card is about to redeem 1600.
    if (elInput.value !== '' && String(amount) !== elInput.value) {
      elInput.value = String(amount);
    }
    render();
    refreshQuote();
  });

  elClose.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });

  elGo.addEventListener('click', async () => {
    if (busy) return;
    const st = redeemState({
      held: held(), amount, quoteWei, floorWei: null, railActive: railActive?.() ?? true,
    });
    if (!st.ok) return;
    busy = true;
    elGo.disabled = true;
    elMsg.textContent = 'Confirm in your wallet…';
    elMsg.className = 'redeem-msg';
    let res;
    try {
      res = await onRedeem(selected, amount);
    } catch (err) {
      res = { ok: false, reason: err?.message || 'redemption failed' };
    }
    busy = false;
    if (res?.ok) {
      onStatus?.(`Redeemed ${amount} ${RARITY_NAMES[selected]} for $DEEPWOOD.`, 'ok');
      close();
      return;
    }
    elMsg.textContent = res?.reason || 'redemption failed';
    elMsg.className = 'redeem-msg bad';
    elGo.disabled = false;
  });

  return { open, close, isOpen, refresh: render };
}
