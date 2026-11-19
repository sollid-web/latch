# Latch

> **Status:** working MVP console; X Layer mainnet deployment in progress (TapeOut Accelerate, Dec 2026).

**At a glance**
- On-chain policy as hardware-style logic: a 13-gate NAND circuit returns a single allow bit for every sweep.
- Keyless custody: USDT sits in an ERC-6551 circuit container; the keeper only pays gas and cannot move funds outside the policy.
- Restart-safe: per-tx and daily caps live in the `LatchRelay` contract, not the daemon.
- Stack: Solidity + Foundry, React console, Cloudflare Workers, Node keeper daemon.

Autonomous savings agent for the X Layer TapeOut Accelerate program.

When OKB trades at or below a threshold, Latch sweeps a capped amount of USDT from a TapeOut **circuit container** to one savings address. A TapeOut **NAND circuit** is the rule. The daemon does not hold a key that can move funds.

This repository’s console is the working MVP. It evaluates the same 13-gate netlist you tape out. Chain deployment is the checklist below — the preview does not broadcast mainnet transactions.

## Use case

OKB dip sweep.

- Trigger: OKB/USDT at or below the threshold (default 48).
- Action: transfer `sweepAmount` USDT (default 50) to the savings whitelist.
- Policy rejects: pause, unknown target, any call that is not the sweep, per-tx cap, daily cap (default 150), or an underfunded container.
- Fee: 5 USDT (or 100 BEM) to arm, then 1% of each sweep to the treasury.

## How the three layers map

| Layer | What it is |
| --- | --- |
| Policy | TapeOut circuit. 7 inputs, 1 allow bit, 13 NAND gates, 0 latches. `eval(circuitId, inputs)`. |
| Body | ERC-6551 container of that circuit. Holds the USDT. Opening cost on X Layer is 0.08 OKB. |
| Daemon | Off-chain listener. Pays gas by calling `LatchRelay.tick`. Restart-safe because caps live on the relay. |

The circuit is pure: it cannot read balances. `contracts/LatchRelay.sol` derives the seven bits from its own storage and the container balance, then requires `processor.eval` to allow before `container.execute`.

Input byte, bit 0 = least significant:

1. `paused`
2. `keeper`
3. `whitelisted`
4. `actionOk` (the call is the sweep)
5. `txCap`
6. `dailyOk`
7. `funded`

`allow = !paused ∧ keeper ∧ whitelisted ∧ actionOk ∧ txCap ∧ dailyOk ∧ funded`

Netlist records follow TAP-02: opcode `0x00`, then operand A and B as uint24 big-endian. The hex is on the Circuit tab.

Tape name on X Layer: `#<circuitId>@2.<processorNumber>` (area code 2, chain id 196).

## Try the console

Once a relay is configured, the **Live relay** card at the top of Operate reads it from X Layer: balances, caps, the next sweep's policy byte and verdict, the processor's answer for `0x7e`/`0x7f`, and recent `Sweep` events with explorer links. Connect the owner wallet to arm or pause; connect the keeper wallet to sweep or send the rogue 500 (it reverts on chain). **Dry-run rogue 500** asks the chain for the revert reason without gas. The Circuit tab can query the deployed processor for any policy byte. To look at a relay before editing the config: `?relay=0x…` (add `&chain=1952` for testnet).

The practice simulator below the live card works without a wallet:

1. Connect (practice session — it does not sign).
2. Arm · 5 USDT.
3. Start.
4. Inject dip. A 50 USDT sweep should execute.
5. Rogue 500 USDT. The circuit denies it.
6. Pause rule, inject another dip. Denied because `paused = 1`.
7. Open Status for the wallet-free DeWEB view.
8. Circuit tab: paste the real processor contract and circuit ID after tape-out. Copy the form text from Brief.

Reload the page while the daemon is running. The feed should say it resumed.

## Deploy on X Layer

Confirm current addresses in the TapeOut docs before you send anything. Factory, opener, and processor numbers move; do not trust a hardcoded processor from a different chain. BNB Chain processor numbers are not X Layer processor numbers.

1. Tape out the netlist on an X Layer processor (TapeCode or the processor UI). Record the processor contract (`factory.cpuAt(n)`) and the circuit ID.
2. Open the container. X Layer fee is **0.08 OKB**. Address is `opener.accountOf(processor, circuitId)`.
3. Deploy, check and wire the console in one step (needs Foundry):

```bash
OWNER_KEY=0x… PROCESSOR=0x… CIRCUIT_ID=… CONTAINER=0x… \
USDT=0x… SAVINGS=0x… TREASURY=0x… KEEPER=0x… \
./scripts/golive.sh
```

   It refuses to deploy unless the processor's `eval` allows `0x7e` and denies `0x7f` for your circuit, deploys `LatchRelay` with caps in USDT's 6-decimal units (50 / 150 / 5 by default), re-checks the circuit through the relay, and writes the relay address into `index.html` so the console goes live.

4. Transfer the circuit NFT to the relay so `container.execute` is authorized. This is one-way; `withdraw(to, amount)` is the owner's way to get funds back out.
5. Fund the container with USDT, then call `arm()` from the owner key (pulls the 5 USDT activation fee to treasury).
6. Run the keeper with a key that holds a little OKB for gas only:

```bash
cd keeper && cp env.example .env   # set KEEPER_PRIVATE_KEY, RPC_URL, RELAY_ADDRESS
npm install && node daemon.mjs
```

   For the demo video, set `THRESHOLD` just above the live OKB price so a real sweep fires on camera, then call `tick` with 500 USDT from the keeper to record the on-chain rejection.

7. Publish the status page as the container’s DeWEB site (`tape://<id>.2.<cpu>.tape` once the name is live).

## Submission

The Brief tab copies a description with processor, circuit ID, users, revenue, and the netlist hex. Deadline for TapeOut Accelerate: 7 December 2026, 23:59 UTC.

Demo video: follow the timestamps on the Brief tab. Keep it under three minutes.
