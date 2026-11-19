# LatchRelay — audit pack

Everything an auditor needs to start on the first hour of the review, and nothing
that belongs in the shipped page. The contract is `contracts/LatchRelay.sol`
(`LatchRelay`, ~300 lines, no imports). It calls the TapeOut processor's `eval`
and moves funds only through the ERC-6551 container. The suite is
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
slither contracts/LatchRelay.sol --solc 0.8.24
```

## What the contract claims

A savings sweep whose funds never leave the TapeOut circuit container except
through two locks in the same transaction. The tokens sit in an ERC-6551
container; the relay owns the circuit NFT, so only the relay can call
`container.execute`. A keeper key, funded only for gas, calls `tick(amount)`.
Solidity checks keeper, armed, pause, per-tx cap, daily cap and funding; then the
relay builds the 7-bit policy byte and requires `processor.eval(circuitId, byte)`
to return allow. Only then does the container transfer `amount` to the fixed
`savings` address and the fee to the fixed `treasury` address. Neither the
Solidity checks nor the circuit is trusted alone: a lying processor cannot
lift a cap, and a denying processor blocks a sweep the Solidity would allow.

Seven bits, bit 0 least significant: 0 paused, 1 caller is the keeper, 2 target
is savings, 3 action is the sweep, 4 within per-tx cap, 5 within daily cap,
6 container holds amount + fee. The taped-out netlist (13 NAND gates) allows
exactly `0x7e`. `circuitAllows(byte)` exposes the circuit's raw answer so anyone
can check the deployed netlist against that truth table. `preview(amount)`
returns the byte for the real caller and the verdict `tick` would reach.

Units: caps, activation fee and fee tiers are in the token's base units. Tiers
scale with `decimals()` read at deploy (1 000 / 5 000 / 20 000 whole tokens), so
6-decimal X Layer USDT works. Fee ladder 100 / 75 / 50 / 25 bps by cumulative
principal swept. Processor, circuit ID, container, token, savings, treasury and
activation fee are immutable. Caps only move down.

## Threat model

| Actor | Can | Cannot |
| --- | --- | --- |
| Owner (deployer EOA, transferable) | pause, set keeper, tighten caps, arm, withdraw, transfer ownership | raise a cap, change savings/treasury/token/processor, take back the NFT |
| Keeper (hot key, gas only) | call `tick` within caps when the circuit allows | choose a destination, unpause, set caps, withdraw, arm |
| TapeOut processor | deny any sweep | approve a sweep the Solidity checks reject |
| Stranger | read everything, call `preview`/`circuitAllows` | call `tick` or any admin function |
| Token contract | refuse transfers, reenter | reenter past the `nonReentrant` lock |

A compromised keeper can only trigger legal, capped sweeps to `savings`. A
compromised owner key can `withdraw` everything — intended and disclosed.

## Disclosed limitations

1. **The owner can withdraw the entire container balance** to any address. The
   relay holds the circuit NFT permanently, so without this funds could strand.
2. **The NFT is one-way.** Once the relay owns it, the container can only act
   through the relay. A new relay means a new container.
3. **`eval` input/output encoding is assumed**: one input byte, allow = bit 0 of
   the first output byte. Confirm against the TapeOut processor docs on the
   target processor before funding; `circuitAllows(126)`/`(127)` is the check.
4. **The fee rounds down**, and is zero below 100 base units.
5. **The day is UTC calendar midnight**, not a rolling 24 hours.
6. **Wrong deploy numbers need a redeploy**: caps only go down; fee and
   activation fee are fixed.
7. **Fee-on-transfer and rebasing tokens are not supported.**
8. **The fee for a sweep uses the tier before it**, not including it.

## Keeper discipline (off-chain, out of scope)

The contract knows nothing about a "dip" or a market price. It enforces hard
treasury rules — who may call, where funds go, and the caps — and that is what
the audit above covers. Everything that depends on the market lives in the
keeper, so the anomaly handling below needed **zero contract changes and zero
re-tapes**.

The keeper (`keeper/daemon.mjs`) gates every `tick` behind three off-chain
checks, in order:

1. **Multi-source consensus (primary).** OKB/USDT is read from OKX, Binance and
   CoinGecko. A dip must be seen by at least two venues before a sweep is even
   considered. A single venue wicking down (a CoinGecko glitch, a thin-book
   print) is ignored.
2. **Short TWAP (fallback).** If consensus is impossible — one venue
   rate-limited or the pair missing — the 5–10 minute rolling average must also
   be a dip.
3. **Volatility breaker.** An hourly sigma above 3% of log returns, or a
   single-venue spread above 6%, pauses the keeper (its own internal pause, not
   the relay's `paused` bit) for a cooldown and skips execution until the market
   normalises.

The keeper's `paused` is internal and never touches the relay's bit 0. Bit 0
stays the owner-only hard kill switch, so the separation is clean: the circuit
says *what money may move*, the keeper says *whether the market signal is real*.
A compromised keeper can only burn gas and trigger legal, capped sweeps to the
whitelisted savings address; it cannot reinterpret a wick as a dip, move funds,
or pause the relay.

## Coverage

31 tests. The test processor interprets the real TAP-02 netlist bytes from
`src/lib/latch/circuit.ts`, and the test container enforces NFT ownership, so
the suite exercises the actual circuit and custody path: constructor wiring and
rejection of zero addresses, bad cap order and code-less token/processor; the
full 128-entry truth table (only `0x7e` allows); a denying processor reverting
`CircuitDenied` when Solidity passes; a lying processor unable to lift the
per-tx cap; empty `eval` output; arm fee accounting, double arm, owner-only and
underfunded arm; a relay without the NFT unable to move funds; sweep and fee
accounting; keeper-only, unarmed, paused, zero and the 500-USDT rogue amount;
daily cap and UTC rollover; underfunded including fee; false-returning token;
reentrancy; `preview` for keeper, stranger, rogue and paused; caps only down;
owner-only withdraw; ownership transfer; `status`; the fee ladder at 6
decimals; and a fuzz test that two sweeps never exceed the caps.

Not covered: the off-chain keeper, the Cloudflare Worker, and the page.

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
