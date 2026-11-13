# LatchRelay — audit pack

Everything an auditor needs to start on the first hour of the review, and nothing
that belongs in the shipped page. The contract is `contracts/Main.sol`
(`LatchRelay`, ~250 lines, no imports). The suite is
`audit/test/LatchRelay.t.sol.txt`.

## Why the test file ends in `.txt`

This project's deploy compiler compiles every `.sol` file it can see. Foundry's
`forge-std` is not vendored here, so a real `.t.sol` in the tree breaks the
deploy build (verified: `ParserError: Source "forge-std/Test.sol" not found`).
The suite is therefore kept as `.txt` and run from a scratch copy.

## Running the suite

```sh
mkdir -p ../latch-audit
cp -r contracts audit foundry.toml ../latch-audit/
cd ../latch-audit
mv audit/test/LatchRelay.t.sol.txt audit/test/LatchRelay.t.sol
forge install foundry-rs/forge-std      # or: forge init --force .
forge test -vv
```

If `forge install` refuses (no git repo), vendor it by hand:

```sh
mkdir -p lib && curl -L https://github.com/foundry-rs/forge-std/archive/refs/tags/v1.9.4.tar.gz \
  | tar xz -C lib --strip-components=1
```

Static analysis, same scratch copy:

```sh
pip install slither-analyzer
slither contracts/Main.sol --solc 0.8.24
```

## What the contract claims

A savings sweep for a treasury. The treasury's tokens sit in the relay. A keeper
key, funded only for gas, calls `tick(amount)`; the relay sends `amount` to one
whitelisted savings address and a fee to a treasury address. The fee starts at 1%
and falls with cumulative swept volume: 100 bps below 1 000, 75 to 5 000, 50 to
20 000, 25 above (`feeBpsFor(volume)`, pure and public; `feeBpsNow()`; `feeOn()`).
`volumeSwept` accumulates principal only, never fees, and `TierChanged` fires on
the sweep that crosses a step. Every path except `savings` and `treasury` requires
an owner call, and the owner is the circuit container, not an EOA.

Seven bits, bit 0 least significant, in one byte: 0 paused, 1 caller is the
keeper, 2 target is the savings whitelist, 3 action is the sweep, 4 amount is
inside the per-tx cap, 5 amount is inside the daily cap, 6 the vault holds
amount + fee. `preview(amount)` returns that byte and the allow verdict for the
real caller, so an off-chain display cannot disagree with what `tick` will do.

Numbers, all literals: per-tx 50, per-day 150, activation 5, day boundary UTC
midnight, fee ladder 100 / 75 / 50 / 25 bps at 1 000 / 5 000 / 20 000 of swept
volume. Caps only move down. The token must have 18 decimals and is fixed once
armed or once the vault holds a balance.

## Threat model

| Actor | Can | Cannot |
| --- | --- | --- |
| Owner (circuit container) | set token, keeper, savings, treasury, pause, tighten caps, arm, rescue | raise a cap above its deployed value, bypass the token's own rules |
| Keeper (hot key, gas only) | call `tick` within caps | choose a destination, change an address, unpause, set caps, rescue, arm |
| Stranger | read everything, call `preview` | call `tick`, call any admin function |
| Token contract | refuse transfers, reenter | pass `setToken` if it is not 18 decimals or has no code |
| Savings / treasury address | receive | pull |

The severe case to reason about is a compromised keeper key: it can burn gas and
trigger legal sweeps until the cap is exhausted, which moves funds to the
whitelisted savings address, not to the attacker. The severe case for the owner
key is a malicious owner, who can rescue everything — that is intended, and
disclosed below.

## Disclosed limitations (read this before writing findings)

1. **The owner can rescue the entire balance.** `withdraw` is `onlyOwner` and
   unrestricted in destination. Deliberate: the funds belong to the owner, and
   the alternative is a contract that can strand them. It is the only function
   that can move funds outside `savings` and `treasury`.
2. **Keeper, savings and treasury all default to `owner`.** A careless deploy
   that arms without calling `setKeeper` leaves the owner key as the keeper.
   Intentional default, documented in the deploy checklist.
3. **18 decimals only, enforced with `decimals()`.** Rejects 6-decimal USDT,
   which exists on X Layer. This is a deliberate restriction so the literal caps
   cannot be off by 10^12, not an oversight.
4. **The fee rounds down and is zero below 100 base units** (0.0000000000000001
   of a token at 18 decimals). Not economically reachable through `tick`, which
   is keeper-gated, but it is stated rather than hidden.
5. **The day is UTC calendar midnight**, not a rolling 24 hours. A sweep at
   23:59 and one at 00:01 are in different days.
6. **`setCaps` cannot raise caps**, so a mistake in the deployed numbers needs a
   new deployment. Same for the fee and the activation fee, which are constants.
7. **The only external call is `token.transfer`**, guarded by a `nonReentrant`
   lock and checked for a `false` return. Fee-on-transfer and rebasing tokens are
   not supported; the caps assume the received amount equals the sent amount.
8. **No upgrade path, no pause of `withdraw`**, by design.
9. **`_bits` reads the token balance twice** in `tick` (once for the day check,
   once inside `_bits`) — no state changes between them, so no inconsistency,
   but it is an extra static call.
10. **The fee for a sweep is chosen by volume before it, not including it.** A
    vault that crosses 1 000 on its current sweep pays the old rate for that
    sweep and the new one thereafter. Deliberate: it keeps the computation
    monotone and makes `feeOn(amount)` a truthful preview. `volumeSwept` counts
    principal only, so fees paid never push a vault up a tier.
11. **The ladder is a constant, so the owner cannot raise the rate — and cannot
    retune pricing either.** Changing the steps needs a new deployment. This is
    the intended trade: no fee switch is a smaller trust surface, and it is also
    why `feeBpsFor` is safe to call from anywhere.

## Coverage

The suite asserts: owner comes from the constructor rather than `msg.sender`;
defaults; the published constants; rejection of 0-decimals-wrong tokens, EOAs
and self-referential tokens; token lock after arming and after funding; activation
fee accounting; `arm` guards; keeper-only `tick`; pause; unarmed tick; zero
amount; per-tx boundary at exactly 50 and 50 + 1; daily boundary at exactly 150;
day roll-over; underfunded vault; fee rounding below 100 units; the published fee
ladder at every boundary (999 / 1 000 / 4 999 / 5 000 / 19 999 / 20 000); the
ladder never rising across 0–25 000; the rate actually falling after a thousand
is swept and `feeOn(50)` dropping from 0.5 to 0.375; reentrant token
that calls back into `tick`; caps tightening but never rising; per-tx above daily
rejected; zero caps rejected; only-owner caps; `preview` agreeing with `tick` on
every bit, with the keeper bit following the caller, the cap bit dropping over
the limit and the pause bit set, plus the verdict false while unarmed; owner rescue and its guards; keeper rescue
denied; and a fuzz test that no amount between 1 and 200 tokens ever escapes the
per-tx cap or the daily counter.

Not covered, and out of scope for a contract audit: the daemon that calls `tick`
(it lives outside this repo and is currently unfixed — a hand-rolled secp256k1
that does not normalise `s` to the low half, and a 10^18 sweep amount that is
wrong for 6-decimal tokens), the Cloudflare Worker, and the page.

## Questions worth paying an auditor to answer

1. Is `_spentToday()`'s read-only roll over correct with respect to `_rollDay()`
   in `tick` — can a sweep ever be counted against the wrong day?
2. Does the reentrancy lock cover `withdraw` interacting with a token that calls
   back during the activation fee transfer in `arm`?
3. **Answered while writing this pack:** no. `preview` omitted `armed`, so it
   returned `allow = true` for a vault that had never armed, where `tick` reverts
   `NotArmed`. `preview` now requires `armed` (folded into the verdict, not into
   the byte, so the seven bits are unchanged) and
   `testPreviewReportsUnarmed` pins it. Worth a second opinion: any other state
   where the verdict and `tick` can disagree, in particular a token that lies
   about `balanceOf` between the two calls.
4. Should `setCaps` be allowed to lower `dailyCap` below `spentToday`?
