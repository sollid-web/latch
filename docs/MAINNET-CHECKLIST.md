# Latch mainnet checklist

Run before the feature freeze (4 December) and again before recording. Everything here is real, on X Layer mainnet.
Small amounts are enough: about 4 USDT0 and a little OKB for gas.

**Part A is automatic. Part B is on your phone.** Write down anything that looks wrong, confusing or slow, with a
screenshot. Those go to Claude before anything else.

---

## Part A: automatic check (2 minutes, free, read-only)

```
cd ~/latch && git pull --rebase && node scripts/check-mainnet.mjs
```

- [ ] Ends with **ALL OK**

It checks the contracts, circuit #2's answer on chain, the deposit helper, the vaults, the live website and its
version, Latch's agent and its price sources, the trade history, the on-chain DeWEB copy, and Sourcify verification.

---

## Part B: on your phone (about 30 minutes)

Use https://latch.tapeguard.workers.dev in your phone's browser unless a step says otherwise.

### 1. First look, no wallet

- [ ] **Home** loads fast; the OKB price and "Latest trades" show real numbers (not "…")
- [ ] The menu scrolls sideways and every page opens: Home, Demo, Try it, Create, My vaults, The chip, Activity, Agents, Safety
- [ ] **Demo:** Create demo vault → slide to −25% → tap **calm** → **Let the agent check now** → "Bought … chip 3×"
- [ ] **Demo:** Pause → check again → no new trade · Withdraw all → play wallet goes up · Start over works
- [ ] **Try it:** change the strategy and prices → the verdict changes · **Ask the real chip** → "Chain says: …"
- [ ] **The chip:** move the controls → the gates and verdict change
- [ ] **Activity:** totals show; the trade list shows **both** of your classic buys (full history)
- [ ] **Agents** and **Safety** read well, with no broken links

### 2. Wallet

- [ ] **Connect wallet** opens the picker (not an instant connect)
- [ ] **OKX Wallet app** → approve → back on the page, your address shows at the top
- [ ] Reload the page → still connected
- [ ] **Disconnect** → reload → still disconnected → Connect shows the picker again
- [ ] On a computer, if you have one: **Scan with a phone wallet** → QR → scan with OKX Wallet → connected

### 3. Create a vault (real, small)

Make sure "Send the OKB to" is **not** your fee wallet `0xb4bD…23a4`: use another account of yours.

- [ ] **Create** → Buy OKB → Smart → base **1** USDT0 → reference about today's price → ceiling about +20%
- [ ] Switch to the OKX app and back while filling in → your values are still there
- [ ] **Review** reads as a clear sentence → **Create** → approve → it moves to **Add funds**
- [ ] **Add funds 3 USDT0** → approve (the first time: "Approve" and then the deposit; the wallet may say "Unknown") → it moves to My vaults

### 4. The vault works

- [ ] **My vaults** shows the new vault with 3.00 USDT0 and "What the chip sees now"
- [ ] Within a few minutes, if the market isn't very jumpy, Latch's agent buys (1 USDT0 at today's price) → **Trades 1**, "Recent trades" shows it with a transaction link
- [ ] The OKB arrives in the "Send the OKB to" wallet (check in the OKX app)
- [ ] **Activity** shows the new trade at the top
- [ ] **Copy address** on the card copies the vault address

### 5. Owner controls

- [ ] **Add USDT0** on the card (1 USDT0) → approve → balance goes up (no "Approve" this time if you chose Unlimited)
- [ ] **Change strategy** → for example Steady → the card says Steady
- [ ] **Pause** → card says Paused, no trades · **Resume** → back on
- [ ] **Withdraw all** → USDT0 back in your wallet; the card shows 0.00 and "This vault is empty"

### 6. On-chain copy (DeWEB)

- [ ] https://2-2-435.tapekit.org/ loads the latest site (it has Demo)
- [ ] The Demo works there too; connecting there works inside the OKX app's own browser (Discover)

### 7. AI agent (terminal, optional)

- [ ] `cd ~/latch/agent && node latch.mjs market` → live price and chip answer
- [ ] `node latch.mjs vaults --owner 0xFd6Afa2b7b7F50Be33050d5adB118fcD85b3721C` → the Agentic Wallet vault

---

## Results

| Date | Part A | Part B | Problems found |
|---|---|---|---|
| | | | |
