// The bottom wallet note is shown once, then never again.
//
// It read "Wallet 0xd1bd...848d on chain 46630. Buy gems and claim tools in the
// shop." and sat permanently across the bottom of the playfield. It is a
// one-time orientation line: once the player has seen which chain they are on
// and what the shop is for, repeating it every session is noise.
//
// One shot per browser, not a fade-and-return. A previous version faded BOTH
// cards after 5s and brought them back on any tap, which is just a permanent
// card with extra steps -- the player could never get it out of the way for
// good. It does NOT come back on tap, on a chain state change, or on reconnect.

const SEEN = 'deepwood.walletfoot.seen';

/**
 * Hide the wallet note immediately. Used when the player acts: a message the
 * player has already read should not still be on screen when they do something
 * about it.
 */
export function retireWalletFoot() {
  let el = null;
  try { el = document.getElementById('hint'); } catch { /* no DOM */ }
  if (!el) return;
  el.classList.add('retired');
  el.hidden = true;
}

/**
 * Show the note once, for a beat, then retire it. Subsequent loads in the same
 * browser hide it before it can ever flash, so there is no "appear once per
 * visit" behaviour by accident.
 */
export function initWalletFootOnce() {
  let el = null;
  try { el = document.getElementById('hint'); } catch { /* no DOM */ }
  if (!el) return;

  let seen = false;
  try { seen = localStorage.getItem(SEEN) === '1'; } catch { /* private mode */ }
  if (seen) {
    // Seen before: gone before first paint, and permanently.
    el.hidden = true;
    el.classList.add('retired');
    return;
  }

  try { localStorage.setItem(SEEN, '1'); } catch { /* private mode */ }
  setTimeout(retireWalletFoot, 6000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWalletFootOnce, { once: true });
} else {
  initWalletFootOnce();
}