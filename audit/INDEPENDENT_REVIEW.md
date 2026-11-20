# Independent review — LatchRelay (self-custody vault), Nov 2026

Reviewed by a separate agent with no access to the author's reasoning, before
the mainnet relaunch, after the first relay lost 15 USDT0 to an unpaid TapeOut
container fee. Scope: `contracts/LatchRelay.sol`, the test suite,
`scripts/golive.sh`, and the keeper's interaction with the contract. Method:
code review, Slither, 13 proof-of-concept tests (`audit/test/Poc.t.sol.txt`),
a local chain-196 run of golive.sh, and an external-assumption audit.

**Verdict:** no contract bug sends funds anywhere but savings/treasury or locks
them; `withdraw` does not depend on the processor, pause, arming or keeper
(tested with a processor that reverts, writes state, loops, returns 3 MB, or
requires value). The v1 failure class does not exist here. Safe to deploy with
~5 USDT0 once the deploy-script checks below were added.

## Findings and resolution

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| M-1 | Medium | golive.sh only checked SAVINGS/TREASURY/KEEPER against themselves; a pasted processor, token or stuck-container address would be accepted and sweeps lost | **Fixed**: address format, not processor/token/old relay/old container, must be a wallet (no code), keeper ≠ owner, token blocklist check, printed summary and typed `YES`. Constructor also rejects savings/treasury = token/processor/self |
| M-2 | Medium | Token issuer can pause USDT0 or block the relay; no contract can avoid it | **Disclosed** in the contract header and audit README; keep balances small |
| M-3 | Medium | One-step `transferOwnership` typo could lock funds | **Fixed**: two-step `transferOwnership` + `acceptOwnership` |
| L-1 | Low | No withdraw-all; a keeper tick could make an exact full withdraw fail | **Fixed**: `withdraw(to, type(uint256).max)`; emergency one-liner printed by golive.sh |
| L-2 | Low | golive.sh never exercised arm/tick on mainnet code before real funds | **Fixed**: `scripts/preflight-fork.sh` rehearses deploy, fund, arm, preview, tick, fee, pause, withdraw-all on a free local fork of mainnet with real USDT0 and processor code |
| L-3 | Low | golive.sh: `cast code` failure passed silently; activationFee/unit/armed/paused not checked; shell arithmetic overflow; wrong key variable in help text; silent no-op if APP_CONFIG missing | **Fixed** |
| L-4 | Low | Keeper: asked for more than balance-minus-fee; first-loop error killed it; no receipt wait; no gas-price cap | **Fixed**: clamp to affordable, catch first loop, wait for receipt, `MAX_GAS_GWEI` (default 50) |
| Info | — | Circuit can only ever see 0x7e inside `tick` (Solidity rejects other patterns first): it is a veto, not an extra filter; fee rounds to 0 below 100 base units; daily cap counts principal only | Accepted / documented |

## External assumptions and how they are proven before funding

| Assumption | If false | Proven by |
|---|---|---|
| `eval` callable as a view, 1 input byte, allow = bit 0 of out[0] | Sweeps stop (funds safe) | golive.sh `circuitAllows(126/127)`; preflight tick on fork |
| Processor not upgraded to block/gate `eval` | Sweeps stop (funds safe) | Deploy-time only; preflight prints implementation slots to watch |
| USDT0 returns true/reverts, no fee-on-transfer | Handled / funding check stops | golive.sh round trip; preflight exact-amount checks |
| Relay not blocked, token not paused | **Funds frozen** (issuer risk) | Deploy-time blocklist check; small balances |
| Owner/keeper hold OKB; sequencer live | Delay only | — |

Status after fixes: 48 tests pass (35 suite + 13 PoC); Slither, all 102
detectors including informational: 0 results.
