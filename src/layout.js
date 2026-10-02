// Responsive geometry for the overlay panels (TOOLBELT, standings).
//
// These panels were hardcoded: TOOLBELT at 340px docked right, standings at 430px
// centred. Both numbers were picked against a desktop viewport and never
// revisited. On a 390px phone that made the toolbelt cover 87% of the screen,
// and the standings panel -- 430px wide on a 390px screen -- started at x = -56,
// i.e. partly off the left edge of the display.
//
// Two layouts instead of one:
//
//   side panel   wide and tall enough. Right-docked, exactly as before.
//   bottom sheet narrow, or too short for the content. Full-width, docked to the
//               bottom edge, capped at 70% of the height so the forest stays
//               visible above it, which is what a thumb expects from a panel
//               that size. Width is capped too, so a landscape phone gets a
//               centred sheet rather than one stretched across 820px.
//
// Sheet mode also triggers on short viewports regardless of width: a 396px-tall
// panel in a 390px-tall landscape phone would clip its last row, and there is
// plenty of width to spare there anyway.
//
// `sheet` is returned so the caller knows to add a backdrop and make the panel
// body swallow taps; desktop keeps the old bare-panel behaviour.
//
// Pure function, no Phaser, so it is directly unit-testable -- see layout.test.mjs.

/**
 * @returns {{pw:number, ph:number, px:number, py:number, sheet:boolean}}
 */
export function panelFrame(W, H, contentW, contentH) {
  const sheet = W < 560 || H < contentH + 60;
  if (sheet) {
    const pw = Math.min(W - 24, 520);
    const ph = Math.min(contentH, Math.max(220, Math.round(H * 0.7)));
    return {
      pw,
      ph,
      px: Math.round((W - pw) / 2),
      py: Math.max(12, H - ph - 12),
      sheet: true,
    };
  }
  const pw = Math.min(contentW, W - 32);
  return { pw, ph: contentH, px: W - pw - 16, py: 88, sheet: false };
}