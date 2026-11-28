# latch-xlayer

The `latch` command-line tool for AI agents using **Latch** on X Layer: vaults that buy OKB on dips or take profit on rises, with every trade sized on chain by a TapeOut circuit.

It **reads** Latch on X Layer (chain 196) and **prepares** transactions. It never holds, asks for or sees a private key: each write is printed as JSON with a ready `onchainos wallet contract-call` command, so the **OKX Agentic Wallet** signs it inside OKX's TEE after the user confirms.

```
npx latch-xlayer market                     # live OKB price as Latch vaults see it
npx latch-xlayer try --dir buy --mode smart --ref 95 --limit 100 --base 2
npx latch-xlayer vaults --owner 0x…
```

Or install once and use `latch`:

```
npm install -g latch-xlayer
latch --help
```

Commands: `market`, `try`, `vaults`, `status`, `create`, `fund`, `wrap`, `pause`, `resume`, `strategy`, `withdraw`, `tick`. Run `latch --help` for details.

- App: https://okblatch.xyz · Agents guide: https://okblatch.xyz/#/agents
- Skill for AI agents: `npx skills add sollid-web/latch`
- Source, tests and contracts: https://github.com/sollid-web/latch

Independent project on X Layer. Not affiliated with OKX. License: GPL-2.0-or-later.
