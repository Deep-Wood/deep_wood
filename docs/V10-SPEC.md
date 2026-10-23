# DeepWood V10 — Design Spec (DRAFT for sign-off)

_Status: DESIGN. Nothing in this doc touches the chain until the owner signs
off and explicitly says deploy. Sequence: this spec → owner review → implement
→ full local tests → owner go → deploy + migrate + verify._

_Date: 2026-10-21. Grounded against the live V9 contract
(`0x8c69…52ac6`, EIP-170 full at 24,563/24,576) and the verified live price
ladder (400 / 7,800 / 86,000 / 1,000,000 / 4,000,000 $DEEPWOOD)._

---

## 0. Scope

**In the V10 bundle** (one deploy, one migration):

1. Prestige — "Descend" (the headline retention lever)
2. Gem fusion (economic rule already decided 2026-10-21)
3. Research/talent tree (designed with prestige, shares the meta space)

**Out of V10** (decided or deferred): referrals (sybil design still open),
skill 6+ / new rarity band (DEFERRED, roadmap §5.6), season prizes
(operational — treasury airdrops, no contract needed).

---

## 1. Prestige — "Descend"

The idle-genre headline: reset progress for a permanent find-weight
multiplier. Must feel like acceleration within 30 seconds of the reset.

### Curve input — already on-chain (free)

V9's `playerStats(player)` already tracks **lifetime `leq`
(legendary-equivalents)**, accumulated per settle in V8's `_creditAll`
override. No new accounting, no new accumulator. `leq` is LIFETIME and does
not reset on descend — the multiplier derives from it at read time, so there
is no snapshot state to store or drift.

### The multiplier

`findWeightBps(player)` applied **at roll time, inside `_rollHunt`, after the
skill fold**: each non-quartz weight `table[r] *= findWeightBps / 10_000`,
then `table[0] = 10_000 − Σ scaled` so the roll space stays 10,000. The
multiplier touches **weights only, never the seed** — rolls stay
independent, fair draws from the committed season seed; only odds tilt.

Two candidate curves (sqrt of lifetime leq, both capped):

- **P1 "punchy" (recommended):** `bps = 10_000 + 2_500·√leq`, cap 30_000.
  First Ruby (+1 leq) → **+25%** find weight; 16 leq → +100%; cap 3× at 64 leq.
  Early resets feel big — the genre requirement.
- **P2 "gradual":** `bps = 10_000 + 625·√leq`, cap 25_000.
  4 leq → +25%; 16 leq → +50%; 64 leq → +100%.

**OPEN DECISION 1 — pick P1 or P2.**

### What descend() does

`descend()` external, requires `leq ≥ 1` (nothing to prestige without at
least one legendary-equivalent) **OPEN DECISION 2 — gate at leq ≥ 1?**

- Resets to zero: gems[0..4] (whole satchel), tool tier + durability, skill.
- **Keeps:** research levels (see §3), lifetime stats (leq, totalEarned,
  burned, hunts), season score/board standing, streak/honors (client-side).
- Increments `prestigeCount` (new Player field, 4 bytes — packs into an
  existing slot).
- Emits `Descended(player, bps)` — the one event this feature gets; first
  on the cut list if bytes demand.

**OPEN DECISION 3 — confirm research survives descend (recommended: yes;
it is the "keep" that makes repeated resets tolerable).**

Client honesty: the Descend panel shows exactly what is lost/kept, the
current bps, and the post-reset bps preview. Confirm modal is mandatory.

---

## 2. Gem fusion (economic rule decided 2026-10-21)

Recipe tracks face value per step; **fusion never mints value; rounding is
always up (sink-side)**. Initial rates (owner-settable, re-derivable if
prices are retuned):

- 20 Quartz → 1 Amber (sinks 2.5%)
- 12 Amber → 1 Sapphire (sinks 8.1%)
- 12 Sapphire → 1 Ruby (sinks 3.1%)
- 4 Ruby → 1 Diamond (exactly neutral)

On-chain shape:

- `fusionRates` — `uint256[4]` public, owner-settable via
  `setFusionRates(uint256[4] calldata)` (same pattern as `setGemPrices`).
  Zero disables a step. Rates are COUNTS, not bps — the value rule lives in
  the owner's head + the roadmap entry; the contract can't verify it, and
  deriving from `priceOf` at runtime costs more bytecode than a table.
- `fuse(uint8 rarity, uint8 times)` — validates `rarity < 4`,
  `times > 0`, `fusionRates[rarity] > 0`; burns
  `fusionRates[rarity] · times` of gem `rarity`, credits `times` of
  `rarity + 1`. Reverts `NotEnoughGems` / `FusionDisabled`.
- No event (client re-reads the satchel after the tx, same as repair).

Client: a fuse action in the satchel sheet; each recipe shows the honest
sink ("burns 8,000 worth, receives 7,800 — 2.5% burned"). Batchable via
`times`.

---

## 3. Research / talent tree

Designed to share the Camp card's meta space with prestige. Three perks,
five levels each, paid by **burning Quartz** (the glut sink stacking with
fusion):

| Perk | Effect per level | Max (L5) |
|---|---|---|
| DURABILITY | +1 max durability on next tool purchase | +5 |
| FRUGALITY | −5% repair cost | −25% |
| LUCK | +250 bps added to the player's findWeightBps | +1,250 bps |

**OPEN DECISION 4 — these perk numbers OK?**

- `study(uint8 perk)` — burns `researchCost(perk, level)` Quartz
  (`gems[Quartz]`), `level[perk] < 5`. Levels never reset (except if
  DECISION 3 goes the other way).
- Costs: `researchBase[3]` owner-settable counts;
  `cost(level) = researchBase[perk] << level` (doubling ladder). Initial
  proposal: 20 / 30 / 50 Quartz (durability / frugality / luck).
  **OPEN DECISION 5 — base costs.**
- LUCK piggybacks the SAME post-fold weight scaling as prestige (one shared
  helper — bytes matter).
- DURABILITY applies at tool purchase (max = `durabilityOf(tier) + level`);
  FRUGALITY scales the repair charge. Both hooks are one multiplication each
  in existing paths.

Bytecode note: three effect hooks in hot paths (buy/repair/roll) are the
expensive part; the shared luck+prestige scaling helper is non-negotiable.

---

## 4. Bytecode budget (V9 is FULL: 24,563/24,576)

Additions (est.): prestige ~600–900 B, fusion ~350–450 B, research ~500–700 B,
migrate ~300–400 B → **~1,800–2,400 B to fund.**

Cuts, in order:

1. **`settleHunt` + its signature-verification machinery** — the client's
   settle path is batch-only; `settleHuntOnchain` exists in `onchain.js` but
   appears uncalled (VERIFY before cutting — if dead, this is the single
   biggest saving; signature check + single-hunt accounting is large).
2. **`migrateLegacyGems` / `migrateLegacyStats` / `migrateFromV2`** — the
   V8/V9-era legacy pulls are superseded by `migrateFromV9` (§5). Cut.
3. **Events**: no new events for fusion/research; `Descended` is first on
   the sacrificial list; `ConfigUpdated` second.
4. **Views fold**: `prestigeBps` and research levels fold into one
   `playerMeta(player)` view (or extend `playerStats`'s return tuple —
   cheaper than a new function).
5. Optimizer runs via foundry config; measure after each feature lands.
   Budget check is a hard CI gate: build fails if > 24,576.

---

## 5. Migration V9 → V10

- `DeepWoodV10 is DeepWoodV9`… new lineage file, constructor takes:
  `address legacy` (V9, immutable), token, treasury, owner.
- `migrateFromV9()` — **self-serve per player, one-shot** (better than the
  owner-attestation pattern used for V2: no owner bottleneck): pulls from
  V9 via its views — satchel counts (capped by the existing
  `setMaxMigrateGems` precedent), `toolOf`, `skillOf`, `huntIndexOf` — and
  marks `migratedV9[player] = true`. Second call reverts `AlreadyMigrated`.
- **Seed continuity (critical):** the constructor commits the SAME
  preseason seed V9 actually carries on-chain: `0xc05f61e5…`
  (keccak256('deepwood-v9-preseason')). (The `0xd1aff9…` value recorded
  earlier in this doc was the V3-era sha256 seed and would have silently
  broken roll continuity — resolved 2026-10-22 by reading `seasonSeed()`
  from the live V9 before deploying.) Same seed + migrated hunt index ⇒
  every player's future rolls continue exactly where V9 left them — no
  preview drift, no re-verification of the fairness model needed.
- Token address unchanged ($DEEPWOOD), treasury unchanged.
- V9 is left paused (never drained for gameplay; `emergencyWithdraw` only
  if ever needed). **Resolved 2026-10-22, post-cutover:** V9's remaining
  DEEP balance — 21,839,940 DEEP, refilled by purchases after the 10-19
  owner sweep — was moved to V10.1 as redemption backing via
  `emergencyWithdraw(DEEP, full, V10.1)` (tx `0x8248e275…`), because
  V10.1's own balance (180,000 DEEP from flow-test tool buys) was SHORT of
  trader2's migrated satchel liability (234,720 DEEP) — a full redeem would
  have reverted `InsufficientTokenBalance`. V9 now holds 0 DEEP; V10.1
  holds 22,019,940 DEEP against ~235k outstanding migrated liability
  (21.8M headroom). V9's gem-state views remain readable for migration.

---

## 6. Client work (deepwood-site)

- **Roll parity (correctness-critical):** the local batch rolls
  (digs 2–20, `engine.js rollHunt`) must apply the same
  `findWeightBps = prestigeBps + luck` post-fold scaling, or every locally
  rolled dig after the first becomes a ResultMismatch revert at settle —
  the same bug class as the tier/skill label drift fixed on 2026-10-21.
  Preview-first-dig already reads the chain, so only local rolls need this.
- Camp card: Descend panel (lost/kept list, bps now → after, confirm),
  Research panel (perks, costs, effect text).
- Satchel: fusion UI with honest per-recipe sink %.
- Mirrors live-preferred: `fusionRates`, `researchBase`, `playerMeta` —
  same getter discipline as `LIVE_REPAIR_COST_TABLE` (roadmap §6).
- Analytics: `descend`, `fuse`, `study` events — **must be added to the
  collector's `ALLOWED_EVENTS`** (dw-analytics :8788) or they are dropped.
- Tests: node --test for the client mirror + roll parity with multiplier;
  fusion recipe display; camp panel logic.

---

## 7. Contract test plan (forge 1.8.4 at ~/.foundry/bin)

- Descend: reset correctness (gems/tool/skill zeroed; research/stats kept),
  bps derivation P-curve math, gate enforcement, re-entrancy of descend.
- Fusion: rate-table honesty vs `priceOf` at the SET rates (property test:
  no step mints value at the live ladder), burns/credits exactness,
  disabled step, batch `times`.
- Research: cost ladder doubling, level caps, effect math (durability at
  buy, repair discount, luck bps stacking with prestige).
- Roll integrity: `_rollHunt` with multiplier still sums to 10,000;
  same seed/index continuity across migration (fork-test against V9 state).
- Migration: one-shot, cap enforcement, seed/index carry-over.
- Size gate: CI-fail over 24,576.

---

## 8. Deployment checklist — ALL GATED ON OWNER "GO"

1. Owner signs off this spec (decisions 1–5 below).
2. Implement + forge suite green + client suites at known baseline.
3. Bytecode < 24,576 confirmed in CI.
4. Deploy to a THROWAWAY testnet address first (never the real one),
   point a preview client at it, run the full player flow: buy → dig →
   settle → fuse → study → descend → dig (verify the multiplier visibly
   accelerates within 30s) → migrate parity checks.
5. Owner reviews the preview results. **Owner says GO.**
6. Deploy real V10, migrate (self-serve; owner covers edge wallets),
   verify state byte-for-byte against V9 reads, pause V9, announce on
   t.me/deepwoodann.

---

## 9. Open decisions for the owner

1. **Prestige curve:** P1 punchy (rec) or P2 gradual?
2. **Descend gate:** leq ≥ 1 (rec)?
3. **Research survives descend:** yes (rec)?
4. **Research perk numbers:** +1 dur / −5% repair / +250 bps luck per level?
5. **Research base costs:** 20 / 30 / 50 Quartz, doubling per level?
6. **`settleHunt` cut:** confirm the single-hunt path can die in V10
   (client is batch-only; will verify no caller remains).

---

## 10. Resolution — 2026-10-22 (owner: "make them owner settable, go with the recommendation")

**All decisions are now LIVE OWNER KNOBS, not one-time choices.** Defaults
are the recommended values; every one can be retuned post-deploy without a
redeploy. Bytecode constraint (EIP-170) forced a bundled shape:

- `setV10Config(coeff, cap, minLeq, researchSurvives, luckBps, durBonus, frugBps)` —
  one owner-only tx retunes decisions 1–4. Defaults: **P1** (2500 / 30,000 =
  3× cap), **leq ≥ 1**, **research survives**, **250 bps / +1 dur / 500 bps**.
- `v10Config()` — one view call reads all seven (client mirror for the
  Descend/Research panels and roll parity).
- Decision 5 (research costs) stays on `setResearchBase` (20/30/50 default);
  fusion table stays on `setFusionRates` (20/12/12/4 default).
- Decision 6: `settleHunt` cut from V6 — confirmed dead (client batch-only).

**Trade-offs paid for the bytecode (~350 B the config system costs):**

1. All three V10 events (`Descended`, `Fused`, `Studied`) were cut — spec §4's
   sacrificial order. The client re-reads state after the tx (`prestigeCount`,
   satchel, and config are public); dw-analytics gets no new event stream from
   V10 actions — use tx receipts instead.
2. Deployed size: **24,194 / 24,576** (382 B headroom after the perk strip).

**Known gap → RESOLVED 2026-10-22 (owner decision): perks stripped entirely.**
The durability and frugality perk *effect hooks* were never wired (helpers
existed, zero call sites — only luck fed `_rollHunt`), and the ~300–500 B
the hooks need does not fit EIP-170. Rather than sell promise-without-effect,
both perks were **removed from the contract**:
- `study()` is now parameterless and **luck-only** (default base 50 Quartz,
  doubling per level; bytes 0–1 of the packed map stay reserved for a V11
  re-add WITH hooks).
- `setResearchBase` is gone; the luck base is the 6th param of
  `setV10Config(coeff, cap, minLeq, researchSurvives, luckBps, luckBase)` /
  `v10Config()`.
- Research = **one perk, fully functional**. The client Research panel shows
  luck only. Decision 4's "+1 dur / −5% repair" numbers retire with the perks;
  decision 5 collapses to the luck base (50 Quartz default).
