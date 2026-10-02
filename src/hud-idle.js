// The HUD is transient.
//
// Both cards -- the season/toolbelt card at the top and the wallet note at the
// bottom -- sat permanently over the playfield. The complaint was not their size
// but their permanence: a player cannot get them out of the way at all. They
// carry the same information every time you look, so they show themselves, say
// it, and get out of the way.
//
// Any input brings them straight back: a tap, a drag, a key, a wheel, a touch.
// That includes the d-pad, so moving the character restores the HUD and then it
// fades again -- the player is never left unable to read their own state.

const IDLE_MS = 5000;

const SHOW = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

let timer = null;

function show() {
  document.body.classList.remove('hud-idle');
  if (timer) clearTimeout(timer);
  timer = setTimeout(hide, IDLE_MS);
}

function hide() {
  document.body.classList.add('hud-idle');
}

export function hudKeepAwake(ms = IDLE_MS) {
  show();
  // A message just landed (a claim, a purchase, a chain state change) -- hold
  // the HUD up long enough for the player to actually read it before it goes.
  if (timer) clearTimeout(timer);
  timer = setTimeout(hide, ms);
}

export function startHudIdle() {
  for (const ev of SHOW) {
    // passive so this never blocks scrolling or the d-pad's own handling
    window.addEventListener(ev, show, { passive: true, capture: true });
  }
  // A tab that comes back to the foreground should not show stale state.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hide(); else show();
  });
  show();
}

// Starts as soon as the module loads, so the HUD behaves this way from the
// first frame without every caller having to remember to turn it on.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startHudIdle, { once: true });
} else {
  startHudIdle();
}
