/**
 * First-run tutorial overlay.
 *
 * Design constraints (user, 2026-10-05 / refined 2026-10-12):
 *   - one welcome step, then an INTERACTIVE step per HUD control: the card
 *     jumps next to the element being described and a white ring highlights it
 *   - viber.png avatar on every card: the tour guide is one of the vibers
 *   - SKIP at every step, FINISH on the last; the final step keeps the
 *     tree / water warning
 *   - Fix-tool button is ALWAYS visible and the repair step mentions it even
 *     when the tool is fine; clicking when not broken flashes
 *     "Tool not broken. Continue hunting."
 *
 * Storage: localStorage 'dw-tutorial-v4'. Bumped from v3 because the whole
 * step list changed shape.
 *
 * Pure DOM overlay -- no Phaser -- so it works before the scene is ready
 * and never touches gameplay state. The card positions itself next to the
 * target element at paint time via getBoundingClientRect and clamps to the
 * viewport, so steps stay put if the HUD itself rebuilds.
 */

const KEY = "dw-tutorial-v4";

/**
 * `target` is the CSS selector for the element to point at. `pos` is the
 * side of the target the card should prefer. When the target is missing
 * (e.g. a rail that only renders on desktop) the step drops to centred.
 */
const STEPS = [
  {
    title: "Welcome to DeepWood",
    body: "Hunt gems in a procedurally generated forest. Every dig is settled on-chain from a published season seed — your finds are real, verifiable state, not a server's promise. Build a daily streak, clear quests, earn trophies, and redeem your gems for $DEEPWOOD. Tap the card to continue.",
    target: null,
  },
  {
    title: "Your satchel",
    body: "This lemon bar is your satchel. Top row: one icon per gem rarity with the count you hold. Bottom row: your current tool — pickaxe and all — and skill. Earn a skin and the pickaxe wears it here.",
    target: "#gemstrip",
    pos: "below",
  },
  {
    title: "Buy / upgrade tool",
    body: "Double-chevron icon on the left rail: buy your first tool, or upgrade to the next tier. Tap it and choose ETH or $DEEPWOOD (10% off). Next to each pay option there's a link for the testnet faucet or for buying $DEEPWOOD if you're short.",
    target: "#belt-buy",
    pos: "right",
  },
  {
    title: "Upgrade skill",
    body: "Arrow icon on the left rail: climb from Greenhorn → Lapidary. Each rank unlocks the next gem rarity. Skill costs Quartz, which you always mine. A skill only takes effect once you hold the matching tool.",
    target: "#belt-skill",
    pos: "right",
  },
  {
    title: "Fix tool",
    body: "Wrench icon on the left rail: a tool lasts 20-40 digs. You only fix a broken tool.",
    target: "#belt-repair",
    fallback: "#belt-buy",
    pos: "right",
  },
  {
    title: "Settle hunt",
    body: "Checkmark icon on the right rail: digs are queued, not settled one by one. Tap Settle to write up to 20 queued hunts in ONE transaction. Reload or leave with hunts queued and they are lost.",
    target: "#belt-settle",
    pos: "left",
  },
  {
    title: "Wallet, Camp & redeem",
    body: "Wallet chip, top-right corner: tap to open the menu — it works with or without a wallet connected. From here you can view the Leaderboard, open your Camp (daily streak, two rotating quests a day plus the Weekend Big Dig, 15 trophies, and the shelf where your pickaxe tries on earned skins), Redeem gems for $DEEPWOOD, and Connect or Disconnect your wallet.",
    target: "#connect",
    pos: "below",
  },
  {
    title: "Sound",
    body: "Speaker icon on the right rail: sound on / off. No wallet needed.",
    target: "#sound-toggle",
    pos: "left",
  },
  {
    title: "Watch the forest",
    body: "Trees block your path and hide dig sites; deep water ends the world. Spend a moment learning the layout before you burn a pick's durability fighting an invisible boundary. Good hunting, hunter.",
    target: null,
  },
];

export function tutorialDue() {
  try {
    return !localStorage.getItem(KEY);
  } catch {
    return false; // storage unavailable: never trap the player in an overlay
  }
}

export function markTutorialDone() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* private mode: they will see it again, harmless */
  }
}

/** Which side the arrow sits on for a given card placement. */
function arrowSide(pos) {
  if (pos === "left") return "right";
  if (pos === "right") return "left";
  if (pos === "below" || pos === "below-wide") return "top";
  if (pos === "above") return "bottom";
  return "none";
}

/**
 * Place the card next to `target`, clamped to the viewport.
 * The arrow is positioned precisely at the target's centre (not the card's) so
 * it always points at the correct control even when the card has to shift to
 * stay on-screen. Pos semantics: 'left'/'right' = card sits to the left/right of
 * the target, arrow on the opposite side of the card pointing at the target;
 * 'below'/'above'/'below-wide' = card below/above, arrow on top/bottom.
 */
function placeCard(card, arrow, target, pos) {
  const PADDING = 10;
  const GAP = 12;
  if (!target || !pos) {
    card.style.left = "50%";
    card.style.top = "50%";
    card.style.transform = "translate(-50%,-50%)";
    arrow.className = "tut-arrow none";
    return;
  }
  card.style.transform = "none";
  const t = target.getBoundingClientRect();
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const centerX = t.left + t.width / 2;
  const centerY = t.top + t.height / 2;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left;
  let top;
  if (pos === "left") {
    left = t.left - cw - GAP;
    top = centerY - ch / 2;
    top = Math.max(PADDING, Math.min(vh - ch - PADDING, top));
    left = Math.max(PADDING, Math.min(vw - cw - PADDING, left));
  } else if (pos === "right") {
    left = t.left + t.width + GAP;
    top = centerY - ch / 2;
    top = Math.max(PADDING, Math.min(vh - ch - PADDING, top));
    left = Math.max(PADDING, Math.min(vw - cw - PADDING, left));
  } else if (pos === "above") {
    left = centerX - cw / 2;
    top = t.top - ch - GAP;
    top = Math.max(PADDING, Math.min(vh - ch - PADDING, top));
    left = Math.max(PADDING, Math.min(vw - cw - PADDING, left));
  } else {
    // below / below-wide
    left = centerX - cw / 2;
    top = t.top + t.height + GAP;
    top = Math.max(PADDING, Math.min(vh - ch - PADDING, top));
    left = Math.max(PADDING, Math.min(vw - cw - PADDING, left));
  }
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;

  // Position the arrow at the exact centre of the target, relative to the
  // card's computed position, so the nub always lands on the right icon.
  // Each side class sets the triangle's direction; the top/left here turn it
  // into a pixel-perfect pointer.
  arrow.style.margin = "0";
  const side = arrowSide(pos);
  if (side === "right") {
    arrow.className = "tut-arrow right";
    arrow.style.right = "-16px";
    arrow.style.left = "auto";
    arrow.style.top = `${Math.round(centerY - top)}px`;
    arrow.style.bottom = "auto";
    arrow.style.marginTop = "-8px";
    arrow.style.marginLeft = "0";
  } else if (side === "left") {
    arrow.className = "tut-arrow left";
    arrow.style.left = "-16px";
    arrow.style.right = "auto";
    arrow.style.top = `${Math.round(centerY - top)}px`;
    arrow.style.bottom = "auto";
    arrow.style.marginTop = "-8px";
    arrow.style.marginLeft = "0";
  } else if (side === "top") {
    arrow.className = "tut-arrow top";
    arrow.style.top = "-16px";
    arrow.style.bottom = "auto";
    arrow.style.left = `${Math.round(centerX - left)}px`;
    arrow.style.right = "auto";
    arrow.style.marginLeft = "-8px";
    arrow.style.marginTop = "0";
  } else if (side === "bottom") {
    arrow.className = "tut-arrow bottom";
    arrow.style.bottom = "-16px";
    arrow.style.top = "auto";
    arrow.style.left = `${Math.round(centerX - left)}px`;
    arrow.style.right = "auto";
    arrow.style.marginLeft = "-8px";
    arrow.style.marginTop = "0";
  } else {
    arrow.className = "tut-arrow none";
  }
}

/**
 * Show the overlay if it has never been dismissed.
 * @returns {boolean} whether the overlay is up (the caller may pause input)
 */
export function maybeShowTutorial() {
  if (!tutorialDue()) return false;

  const dim = document.createElement("div");
  dim.id = "tutorial";
  dim.className = "tutorial-dim";

  const card = document.createElement("div");
  card.className = "tutorial-card tut-pointed";
  card.style.position = "fixed";
  card.style.margin = "0";

  const arrow = document.createElement("div");
  arrow.className = "tut-arrow none";
  card.appendChild(arrow);

  // Header: viber avatar + step title.
  const head = document.createElement("div");
  head.className = "tut-head";
  const avatar = document.createElement("img");
  avatar.className = "tut-avatar";
  avatar.src = "/art/viber.png";
  avatar.alt = "tutor";
  head.appendChild(avatar);
  const h = document.createElement("h2");
  head.appendChild(h);
  card.appendChild(head);

  const b = document.createElement("p");
  card.appendChild(b);

  const steps = document.createElement("div");
  steps.className = "tutorial-steps";
  card.appendChild(steps);

  const foot = document.createElement("div");
  foot.className = "tut-foot";
  const skip = document.createElement("button");
  skip.className = "tutorial-skip";
  skip.textContent = "skip";
  const next = document.createElement("button");
  next.className = "tutorial-next";
  next.textContent = "next";
  foot.appendChild(skip);
  foot.appendChild(next);
  card.appendChild(foot);

  dim.appendChild(card);
  document.body.appendChild(dim);

  let i = 0;
  let highlighted = null;

  const clearHighlight = () => {
    if (highlighted) {
      highlighted.classList.remove("tut-hot");
      highlighted = null;
    }
  };

  const paint = () => {
    clearHighlight();
    const s = STEPS[i];
    h.textContent = s.title;
    b.textContent = s.body;
    steps.innerHTML = STEPS.map(
      (_, k) => `<span class="dot${k === i ? " on" : ""}"></span>`,
    ).join("");
    next.textContent = i === STEPS.length - 1 ? "finish" : "next";
    // Resolve the target AFTER the card has its new content so the position
    // math reads a fully laid-out element. Falls back to `fallback` when the
    // main target is not on screen (e.g. Fix tool before the first buy).
    requestAnimationFrame(() => {
      let el = s.target ? document.querySelector(s.target) : null;
      if (!el && s.fallback) el = document.querySelector(s.fallback);
      if (el && el.offsetParent !== null) {
        el.classList.add("tut-hot");
        highlighted = el;
        placeCard(card, arrow, el, s.pos || "below");
      } else {
        placeCard(card, arrow, null, null);
      }
    });
  };

  const close = () => {
    markTutorialDone();
    clearHighlight();
    dim.remove();
  };

  const advance = () => {
    i += 1;
    if (i >= STEPS.length) close();
    else paint();
  };

  card.addEventListener("click", (e) => {
    if (e.target === skip || e.target === next) return;
    advance();
  });
  next.addEventListener("click", (e) => { e.stopPropagation(); advance(); });
  skip.addEventListener("click", (e) => { e.stopPropagation(); close(); });

  paint();
  return true;
}
