# DeepWood — Engagement Roadmap & State

_Last updated: 2026-10-19 (late UTC). Owner picks this up when ready._
_Primed by: production V9 deploy-day (discount restore, sweeps, UI fixes) + the engagement-pack preview._

---

## 1. Current state

### Production (main @ `5825e95`, auto-deploying on merge)
| Thing | State |
|---|---|
| Contract | **V9** `0x8c6915aA8F3eE2958E29013ef043CbDeDFB52ac6` (block 138807361), 10% token-buy discount on both rails, `drainAll`, `migrateLegacyStats`. **EIP-170 FULL: 24,563/24,576 bytes — any contract change requires a V10.** |
| Owner wallet | `0xd940…` holds ~57.5M DEEPWOOD (sweeps recovered +10.87M) + ETH. V8/V6/V7 retired & swept; residues ~57.4k DEEP stranded on `0x4b4b`+`0xc4E4`, V2 ETH permanently locked. |
| Client | Estimate bug fixed (`normalizeRedeemQuote`), repair-reserve warning, repair mirror reconciled to the chain table (live-preferred), redeem/skill satchel-refresh fix, first-party analytics live (`/collect` → VPS collector :8788, dashboard `http://69.197.164.218:8788/stats`). |
| Legacy rot | 30 test failures in `src/economy.test.mjs` + `src/player.test.mjs` (ETH-era price ladders, "Iron/Steel" tier names, rotted tier-climb fixtures). Pre-existing, identical set before/after every change this day. Not yet modernized — offered, deferred. |

### Awaiting user sign-off: the engagement pack (branch `engagement-pack` @ `58cd2f3`)
- **NOT merged.** Production does not have it. Vercel preview exists but sits behind
  Vercel's Deployment Protection login wall — the shareable test link is the VPS-hosted
  build: **http://69.197.164.218:8789/** (`deepwood-preview.service`, serves
  `~/.hermes/profiles/hunter/preview/deepwood-engagement`).
- Contains: **Camp card** (streak / daily quests / trophies), **Lucky Strike**
  celebration, **vein tease**, badge/streak toasts, analytics events
  (`camp_open`, `badge_unlocked`, `streak_day`, `lucky_strike` — whitelisted in the
  collector already).
- Honesty rules (do not weaken when touching this): every number derives from
  on-chain deltas (`huntIndex` / `gemsOf` / `playerStats.burned`) since UTC midnight;
  localStorage is only a cache; streaks/quests pay in honors, never fake balances.
- Files: `src/engagement.js` (pure logic, 10 tests), `src/camp.js` (DOM),
  ForestScene wiring (`engagementSync()` + settle-path celebration/tease), DOM+CSS in
  `index.html` / `src/hud.css`.
- The preview talks to the REAL V9 contract — test actions are real transactions.
- Analytics 404s harmlessly on the preview (same-origin `/collect` has no rewrite off
  Vercel), so test traffic never pollutes the production funnel.

### Pickup procedure
1. After user approval: `git checkout main && git merge engagement-pack && git push` →
   Vercel auto-deploys; then `systemctl --user disable --now deepwood-preview.service`
   and delete `~/.hermes/profiles/hunter/preview/deepwood-engagement`.
2. To re-serve a newer preview build: `npm run build`, copy `dist/` over the preview dir,
   `systemctl --user restart deepwood-preview.service` (server code:
   `~/.hermes/profiles/hunter/preview/preview_server.py`, port 8789).
3. If a Vercel preview is wanted shareable instead, the owner must disable Deployment
   Protection in the Vercel dashboard (no CLI access from this box; token dead).

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

## 3. Shipped in the pack (recap for design review)

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

1. **Tool skins** — earned cosmetics on the existing SVG avatar system (streak
   honors, event badges, rebirth skins later). Endowment effect; pure display.
2. **Night dig / offline shift** — queue a 20-hunt shift on exit, settle on return
   with the full reveal. `settleBatch` + `previewHuntAt` already support it; the
   work is UX choreography + the unload warning interplay.
3. **Weekly quest rotation** — rotate 2 of 3 quests daily, add a weekend "big dig".
4. **More badges** — lifetime burned thresholds, redemption milestones,
  "settled 1,000 hunts" (playerStats.hunts).
5. **Analytics-driven tuning** — the funnel (pageview → wallet_connect →
   tool_buy → hunt_settle → gems_redeem + camp events) can now show which
   features move retention; check `/stats` before/after shipping anything above.
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
2. **Gem fusion** — burn 5 Quartz → 1 Amber etc. (5→1 down the ladder). Sink for
   the common-gem glut; strategic hold-vs-craft decision against redeeming.
   `fuse(rarity, times)` + table in the owner-settable config.
3. **Research/talent tree** — Quartz-bought branching perks (+durability,
   cheaper repairs, +luck band). Pairs with prestige; both consume the same
   "meta-progression" UI space, so design them together.
4. **Referral digs** — inviter + invitee get a bonus pre-roll each. Needs sybil
   thought even on testnet (one-per-claim via a merkle/claim index).
5. **Season prizes / weekly bounties** — treasury-funded (owner wallet holds the
   swept 57.5M DEEP). Weekly leaderboard snapshot posted to Telegram; prizes
   via owner airdrop against a published winner list.
6. **Skill 6+ / new rarity band** — only if the economy math survives it; the
   current 5×5×5 space is well-balanced, this is the most invasive idea.

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
