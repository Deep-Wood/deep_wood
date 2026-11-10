# V11 planning notes — emergencyWithdraw accounting (written 2026-11-10)

Author's note: everything below was learned the hard way during the 2026-11-10
free-Wood migration. Read this before writing a single line of V11.

---

## 1. The blind spot, stated precisely

`emergencyWithdraw(token, amount, to)` refuses to move more than the internal
`tokenBacking` counter:

```solidity
// Cannot touch the redemption backing: those tokens are owed to players
// holding gems, and letting the owner pull them would silently break every
// outstanding redemption.
if (tokenAddress == token && amount > tokenBacking) {
    revert InsufficientTokenBalance();   // 0xe4455cae
}
```

The intent is right — never strand players. The implementation has a fatal
gap: **`tokenBacking` only tracks DEEP that entered through the contract's own
accounting functions** (tool-buy keeps, explicit deposits). DEEP that arrives
as a **raw ERC20 transfer** — a refill from a predecessor contract, a
top-up from the owner wallet, token-contract emissions — **never increments
the counter**. The counter and the real balance drift apart permanently, and
the drift is one-directional: the counter understates.

## 2. Case study — 2026-11-10 (all verified on-chain)

| Contract | Real DEEP balance | tokenBacking | Sweepable via emergencyWithdraw |
|---|---|---|---|
| V10.1 `0x950c…fb4c` | 26,919,940 → 21,841,976.64 | was 5,080,000 → now 0 | exactly 5,080,000 (done, tx `0xd3505045…a51417`) |
| V102Flat `0x86cd…517e` | 5,080,000 | **0** | **nothing — from day one** |
| c4E4 `0xc4e4…5574` | 38,750.23 | 0 | nothing |
| 4b4b `0x4b4b…e5ff` | 18,659.78 | 0 | nothing |

- V10.1's 21.8M arrived on 2026-10-22 as a **raw transfer** from V9
  (`emergencyWithdraw(DEEP, full, V10.1)` — that pull worked only because V9's
  counter happened to cover its balance; tool purchases had been crediting it).
  V10.1's counter never saw the refill.
- V102Flat was born with the same defect: the 5.08M top-up (2026-11-10) arrived
  raw, so its counter is 0 while it holds 5.08M.
- Consequence on V10.1: ~21.6M of the 21.84M is very likely surplus (recorded
  outstanding liability was ~235k in October), but it is unreachable — no
  proxy, no backing setter, no drainAll (probed; the V10 lineage ABI has
  exactly one token-moving owner function). It dies with the retired contract
  as players redeem out.

## 3. What V11 must do

**Option A (minimum): pause-gated full drain.**
When the contract is paused — i.e. retired, players done — let
`emergencyWithdraw` drain `balanceOf(token)` in full, ignoring the counter:

```solidity
if (tokenAddress == token && amount > tokenBacking && !paused()) {
    revert InsufficientTokenBalance();
}
```

Cost: ~20 bytes (V9 was 13 bytes under EIP-170; V102Flat is 47 under — budget
it from day one). Retirement is exactly when "pull everything out" is the
point, and a paused contract cannot owe anyone a *future* — outstanding gems
stay redeemable up to whatever remains, and the owner accepts leaving the
tail behind if they drain early. Document that trade-off in the NatSpec.

**Option B (correct, if bytes allow): derive sweepable from state, not a
manual counter.** `sweepable = balanceOf(token) - outstandingLiability()`,
where outstanding liability is computed from the gem state at call time. No
counter to desync, ever. Cost: needs the liability view to already exist;
if it must be added, this likely blows the EIP-170 budget — hence A as the
default and B as the stretch goal.

**Either way, also:** emit a `BackingAdjusted(uint256)` on every path that
mutates the counter, so off-chain tooling can reconcile it against
`balanceOf` instead of guessing.

## 4. Operator notes for the CURRENT contracts (no code can change)

- **Watch real balances, never the counter.** `tokenBacking` on V102Flat is 0
  forever; redemptions are unaffected (they pay from the real balance and only
  floor the counter at 0 — verified in V4-lineage source).
- **If V102Flat's backing ever runs short**, the fix is a plain owner-wallet
  transfer (owner holds ~57.5M DEEP; trader2 `0xd1Bd…E848d` holds ~53M). Raw
  inflow is fine for redemptions.
- **The sanctioned way to drain an old contract is a player redemption** —
  redemptions pay from the real balance and do not consult the counter.
  trader2 on V10.1 holds 33Q/42A/3S ≈ 598,800 DEEP face (~538,900 at the 90%
  spread; the 33 Quartz alone sit under the 20,000 per-call minimum). V9 is
  paused, so its 221,800 face is locked until unpause. c4E4/4b4b are
  ETH-era contracts (priceOf in ETH units) — their DEEP balances are not gem
  backing at all and are effectively stranded.
- **Farming does not scale**: a tier-3 tool cannot find Ruby/Diamond, dig
  cooldowns and the 40-use durability ladder bound throughput. Do not expect
  digs to drain a retired contract.

## 5. Related observation (separate thread)

The live token (`0xf049…a831`) is a newer implementation than the public
`deepwood-contracts` repo: on 2026-11-10 it self-sent 2,036.64 DEEP to V10.1
(unknown event `0x784984f9`) in the same block as the migration. If that is a
scheduled emission aimed at "the live game contract", its target may still be
V10.1 — worth pointing at V102Flat if the token exposes a setter.
