/**
 * First-run tutorial overlay.
 *
 * Design constraints (user, 2026-10-05):
 *   - step-by-step: one instruction at a time, click the screen to advance
 *   - a SKIP button at every step, skipping the whole tutorial entirely
 *   - covers: move, dig, settle (the V3 batch concept), sell, advance/repair,
 *     and the obstacles (trees block you, water edges the world)
 *
 * Storage: localStorage 'dw-tutorial-v1'. The overlay is pure DOM -- no
 * Phaser dependency -- so it works before the scene is ready and never
 * touches gameplay state. It is a dimmer plus a centered card; clicks land
 * on the CARD to advance (not anywhere, or a click meant for the game
 * would silently eat steps), and skip clears the flag and hides everything.
 */

const KEY = "dw-tutorial-v1";

const STEPS = [
  {
    title: "Welcome to DeepWood",
    body: "Hunt gems in a procedurally generated forest. Everything you find is real on-chain state once your wallet is connected. Click to continue.",
  },
  {
    title: "Move",
    body: "Tap or click where you want to walk. The hunter finds their own path; you can also hold a direction.",
  },
  {
    title: "Dig",
    body: "Walk up to a dig site and press HUNT. Each dig swings the pick three times — the result comes from the chain itself, not the client.",
  },
  {
    title: "Settle when you choose",
    body: "Digs are queued, not settled one by one. When you press SETTLE, every queued hunt is written to the chain in ONE transaction. Warning: reload or leave with hunts queued and they are lost — settle before you go.",
  },
  {
    title: "The tool wears out",
    body: "Twenty digs and the pick is spent. SETTLE your batch, then repair it with gems or upgrade to the next tier. A broken pick digs nothing.",
  },
  {
    title: "Sell",
    body: "Gems in your satchel sell for ETH any time. The satchel always shows your real on-chain balance per rarity.",
  },
  {
    title: "Watch the forest",
    body: "Trees block your path and hide sites; deep water ends the world. Everything else — the leaderboards, ranks, the season — lives in the header card.",
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
  card.className = "tutorial-card";

  const h = document.createElement("h2");
  const b = document.createElement("p");
  const steps = document.createElement("div");
  steps.className = "tutorial-steps";
  const skip = document.createElement("button");
  skip.className = "tutorial-skip";
  skip.textContent = "skip";

  card.appendChild(h);
  card.appendChild(b);
  card.appendChild(steps);
  card.appendChild(skip);
  dim.appendChild(card);
  document.body.appendChild(dim);

  let i = 0;
  const paint = () => {
    const s = STEPS[i];
    h.textContent = s.title;
    b.textContent = s.body;
    // Progress dots: which step you are on, how many remain.
    steps.innerHTML = STEPS.map(
      (_, k) => `<span class="dot${k === i ? " on" : ""}"></span>`,
    ).join("");
    skip.textContent = i === STEPS.length - 1 ? "done" : "skip";
  };

  const close = () => {
    markTutorialDone();
    dim.remove();
  };

  // Advance on ANY click inside the card; the dim layer does not advance, so
  // a click meant for the game world behind it is just a click.
  card.addEventListener("click", (e) => {
    if (e.target === skip) return; // skip has its own handler
    i += 1;
    if (i >= STEPS.length) close();
    else paint();
  });
  skip.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  paint();
  return true;
}
