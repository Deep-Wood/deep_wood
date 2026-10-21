# DeepWood — Engagement Roadmap & State

_Last updated: 2026-10-21. Engagement pack MERGED to main and live on production._
_Primed by: production V9 deploy-day (discount restore, sweeps, UI fixes) + the engagement-pack preview._

---

## 1. Current state

### Production (main @ `525990c`, auto-deploying on merge)
| Thing | State |
|---|---|
| Contract | **V9** `0x8c6915aA8F3eE2958E29013ef043CbDeDFB52ac6` (block 138807361), 10% token-buy discount on both rails, `drainAll`, `migrateLegacyStats`. **EIP-170 FULL: 24,563/24,576 bytes — any contract change requires a V10.** |
| Owner wallet | `0xd940…` holds ~57.5M DEEPWOOD (sweeps recovered +10.87M) + ETH. V8/V6/V7 retired & swept; residues ~57.4k DEEP stranded on `0x4b4b`+`0xc4E4`, V2 ETH permanently locked. |
| Client | Engagement pack live (Camp card, streak/quests/trophies, Lucky Strike, vein tease). Redeem card shows the contract's 20,000 $DEEPWOOD minimum (no raw wei). Satchel strip is a full-bleed top band (brand/wallet overlay it in place; upgrade-tool + settle buttons ride the band at every screen size; gem row lifted toward the wordmark). Wallet menu opens with no session and its bottom item flips Connect/Disconnect. Tutorial texts updated. Estimate bug fixed (`normalizeRedeemQuote`), repair-reserve warning, repair mirror reconciled live-preferred, redeem/skill satchel-refresh fix, first-party analytics live (`/collect` → VPS collector :8788, dashboard `http://69.197.164.218:8788/stats`). |
| Legacy rot | 30 test failures in `src/economy.test.mjs` + `src/player.test.mjs` (ETH-era price ladders, "Iron/Steel" tier names, rotted tier-climb fixtures). Pre-existing, identical set before/after every change this day. Not yet modernized — offered, deferred. |

### Engagement pack: SHIPPED (2026-10-20)
- **Merged to main and live on production** (deepwood-two.vercel.app). Merged at
  `7f762ec`; everything after it shipped straight to main through `525990c`:
  camp launcher in the wallet menu, redeem-card contract minimum, full-bleed
  satchel band, upgrade-tool/settle buttons on the band (all screen sizes),
  PRESEASON wordmark ink, wallet menu without a session (Connect wallet /
  Disconnect flip), gem row lifted toward the wordmark.
- Contains: **Camp card** (streak / daily quests / trophies), **Lucky Strike**
  celebration, **vein tease**, badge/streak toasts, analytics events
  (`camp_open`, `badge_unlocked`, `streak_day`, `lucky_strike` — whitelisted in
  the collector already).
- Honesty rules (do not weaken when touching this): every number derives from
  on-chain deltas (`huntIndex` / `gemsOf` / `playerStats.burned`) since UTC midnight;
  localStorage is only a cache; streaks/quests pay in honors, never fake balances.
- Files: `src/engagement.js` (pure logic, 10 tests), `src/camp.js` (DOM),
  ForestScene wiring (`engagementSync()` + settle-path celebration/tease), DOM+CSS in
  `index.html` / `src/hud.css`.
- **Cleanup DONE (2026-10-20)**: `deepwood-preview.service` disabled and
  stopped, port 8789 free; the stale build dir
  (`~/.hermes/profiles/hunter/preview/deepwood-engagement`) and its 18MB
  `build.tar.gz` deleted. The server code and certs stay in
  `~/.hermes/profiles/hunter/preview/` in case a shareable preview is ever
  wanted again.

### Post-merge cleanup
1. ~~Disable `deepwood-preview.service` and delete the preview build~~ —
   done 2026-10-20 (above).
2. Vercel previews stay login-walled (Deployment Protection); production is the
   shareable link now.

---

## 2. Research basis (why these features)

Idle/clicker genre design (prestige, offline progress, variable rewards, events,
research trees, feedback juice — designthegame.com; "7 idle games in 30 days" dev.to:
prestige must feel like acceleration, offline at ~50% rate, 3–5 minute phase
transitions) and the Telegram tap-to-earn playbook (Notcoin / Hamster Kombat:
daily streaks, quests, combos, boosts, referrals — retention came from DAILY
habit loops, not depth). DeepWood's dig loop is cyclical but flat: the
retention engines were absent. The engagement pack ships the client-only set;
the on-chain set is below.

---

## 3. Shipped in the pack — LIVE on production (recap for design review)

- **Streak** — UTC day counts when ≥1 dig settled. Honors 3/7/14/30 (Warming Up,
  Hot Streak, Deep Habit, Woodborn). Miss a day → reset, best kept.
- **Daily quests** — Warm Pick (settle 20 digs), Prospector's Eye (find 3 Amber),
  Keep It Sharp (burn gems on repair/skill). Progress bars, 00:00 UTC reset.
- **Trophies (10 badges)** — First Find, Amber Rush, Deep Blue, Ruby Crown,
  Diamond Club, Mithril Club, Lapidary, Century Club (100 lifetime gems),
  On The Board (ROI board), Hot Streak. Toast once on unlock.
- **Lucky Strike** — Sapphire+ in a settled batch → overlay + camera shake + sting.
- **Vein tease** — next dig's public pre-roll holds Ruby+ → hint-chip whisper.

---

## 4. Client-only backlog (no contract work)

1. ~~**Tool skins**~~ — **DONE (2026-10-20)**: five earned skins on the pickaxe
   avatar (Ember Grip / Ember Trim / Wolfsbane Wrap / Golden Haft / Etched
   Haft), unlocked by the same on-chain facts as badges. The strip's tool
   cell shows the pickaxe inline with the name (band geometry unchanged);
   the Camp card has the picker shelf; the choice reverts to base wood when
   the honor lapses. `camp_skin_pick` allowlisted in the collector.
2. ~~**Night dig / offline shift**~~ — **DONE (2026-10-20)**: the settle queue
   persists to localStorage (mirrored per dig), survives reload/tab close, and
   re-attaches only when the chain's hunt index still equals its base (and the
   held tier matches). On return a "shift returns" card shows the haul + the
   required hard-refresh/cache warning, and offers settle-now or keep-digging.
   The unload dialog now fires only when persistence failed. Honest limits:
   nothing accrues while away; nothing exists on-chain until settle; another
   device settling drops the shift. `shift_return` allowlisted in the collector.
3. ~~**Weekly quest rotation**~~ — **DONE (2026-10-20)**: 2 of 3 dailies rotate
   per UTC day (same pair for every player, day-number keyed), weekends add the
   Big Dig (100 digs, Sat 00:00 → Mon 00:00 UTC, weekend-frozen baseline).
4. ~~**More badges**~~ — **DONE (2026-10-20)**: shelf is 15. Kindling (burn 10) /
   Furnace (burn 250) / Century Digger (100 hunts) / Grand Excavation (1,000
   hunts) / Patron (100k $DEEPWOOD spent). NOTE: the "redemption milestone"
   idea was replaced by Patron — the contract keeps no lifetime redemption
   counter, and the honesty rule forbids inventing one; tokenSpent is the
   on-chain mirror image.
5. **Analytics-driven tuning** — the funnel (pageview → wallet_connect →
   tool_buy → hunt_settle → gems_redeem + camp events) can now show which
   features move retention; check `/stats` before/after shipping anything above.
   **Baseline at ship time (2026-10-20, all-time):** 200 events · pageview 77
   (12 visitors) · wallet_connect 33 (9) · hunt_settle 14 (5) · badge_unlocked
   60 (6) · camp_open 6 (4) · gems_redeem 3. Day of ship: 57 pageviews, 11
   visitors, 155 events. Re-check after the first full weekend with the Big Dig.
6. **Gem Rush events — ZERO CODE, do this first**: retune
   `dropTableTiers`/`rarityWeightTable` (already owner-settable) for a weekend,
   announce on t.me/deepwoodann, revert Monday. This validates the event loop
   before anything is built for it.

## 5. On-chain backlog (requires a V10 — EIP-170 is full)

Design note: bundle these into ONE V10 to pay the deploy/migration cost once.
The migration machinery (V9's `migrateLegacyGems`/`migrateLegacyStats`) is proven.

1. **Prestige — "Descend"** *(the headline; biggest retention lever in the genre)*
   - Reset tool + gems + skills; keep a permanent find-weight multiplier.
   - Curve: ~√ of lifetime legendary-equivalents (early resets feel big, later
     ones diminish). Multiplier applies to rarity weights, NOT to the seed.
   - Must feel like acceleration: visibly faster within 30s of the reset.
   - State: `prestigeCount`, `findWeightBps` per player; entry `descend()`; a
     `prestigeMultiplierOf(player)` view. Roughly 600–900 bytes — needs EIP-170
     budgeting from day one (drop an event or fold views; V9 experience: docs
     are free, events are not).
2. **Gem fusion** — burn lower gems → 1 higher gem. Sink for the common-gem
   glut; strategic hold-vs-craft decision against redeeming.
   `fuse(rarity, times)` + rate table in the owner-settable config.
   **REDESIGN DECISION (user, 2026-10-21): the recipe must track face value
   step by step — fusion must NEVER mint value.** The original 5→1 sketch is
   rejected: computed against live prices it gifts +290% on Quartz→Amber,
   +121% on Amber→Sapphire, +133% on Sapphire→Ruby, and destroys −20% on
   Ruby→Diamond. The true value ratios (live prices 400 / 7,800 / 86,000 /
   1,000,000 / 4,000,000 $DEEPWOOD) are deliberately non-uniform:
   **19.5 : 11.03 : 11.63 : 4.0** — so there is no single count ratio.
   Value-matched integer recipes (rounding UP = sink-side, never down):
   - **20 Quartz → 1 Amber** (burns 8,000 for 7,800 — sinks 2.5%)
   - **12 Amber → 1 Sapphire** (93,600 for 86,000 — sinks 8.1%; 11:1 would
     gift 0.23%, so 12 it is)
   - **12 Sapphire → 1 Ruby** (1,032,000 for 1,000,000 — sinks 3.1%)
   - **4 Ruby → 1 Diamond** (4,000,000 for 4,000,000 — exactly neutral;
     5:1 would be a heavy 20% overcharge)
   Consequences for the V10 spec: (a) the fusion rates live in an
   **owner-settable config table** (or are derived from `priceOf` at fusion
   time) — hardcoding counts would let any price retune silently reopen the
   gift, and `priceOf` is already owner-tunable; (b) rounding is always up;
   (c) every fusion at these recipes slightly SHRINKS redemption exposure,
   which is the point of a sink. Numbers are as of 2026-10-21 prices —
   re-derive if the price ladder is ever retuned.
3. **Research/talent tree** — Quartz-bought branching perks (+durability,
   cheaper repairs, +luck band). Pairs with prestige; both consume the same
   "meta-progression" UI space, so design them together.
4. **Referral digs** — inviter + invitee get a bonus pre-roll each. Needs sybil
   thought even on testnet (one-per-claim via a merkle/claim index).
5. **Season prizes / weekly bounties** — treasury-funded (owner wallet holds the
   swept 57.5M DEEP). Weekly leaderboard snapshot posted to Telegram; prizes
   via owner airdrop against a published winner list.
6. **Skill 6+ / new rarity band** — **DEFERRED (user, 2026-10-21): NOT in the
   V10 bundle.** Tier 5 already costs a lot — Mithril is 150,000,000
   $DEEPWOOD live, Lapidary costs 80 Quartz, and a Diamond's face value is
   4,000,000 $DEEPWOOD — so the top of the current ladder has plenty of
   headroom; no new tier is needed now. Revisit in a future upgrade round.
   If revived, the original bar stands: only if the economy math survives
   it (the 5×5×5 space is well-balanced) and it is budgeted from day one as
   the most invasive item in whatever bundle carries it (roll math, every
   tier's drop table, pricing, UI, value ladder).

## 6. Constraints & gotchas for whoever picks this up

- **EIP-170: V9 is 13 bytes under the limit.** No contract additions fit. V10
  planning must include a bytecode budget from the first sketch; comments are
  free, events/setters are not.
- **Client mirrors must PREFER live reads** (`repairCost()` now reads
  `LIVE_REPAIR_COST_TABLE` first). The repair-drift bug (UI showed the old V4/V5
  ladder 9Q/5+4 while the chain charged 5Q/3+2) is the cautionary tale — any
  new mirror must go through a live-preferred getter.
- **Post-tx reads are safe** on this RPC after `pollUntilChanged` (redeem polls
  `gemsOf` until it falls; buy polls `toolOf`). Historical `eth_call` at old
  blocks works ONLY on `robinhood-testnet.drpc.org` (primary RPC prunes).
- **Vercel previews are login-walled** (Deployment Protection) — the VPS static
  preview pattern (`deepwood-preview.service` :8789) is the shareable-link
  mechanism; it's also what the owner asked for ("custom link before prod").
- **Analytics collector**: `~/.hermes/profiles/hunter/analytics/collector.py`,
  systemd `dw-analytics.service` :8788, SQLite `events.db`. New event names must
  be added to `ALLOWED_EVENTS` there or they are dropped server-side.
- Weekly key-vault backup cron `9c4e7e790690` runs Mondays 09:00 UTC
  (repo: Esc1200/vps-key-vault, passphrase file on this box).
- The 30 legacy test failures are documented above — do not mistake them for
  regressions when running suites; compare against the known-baseline list.
