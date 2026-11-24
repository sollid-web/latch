# Submitting `latch-plugin` to the OKX Plugin Store

The plugin lives in `plugin/latch-plugin/`. Its source, the `latch` tool, stays in this repo (`agent/`), pinned
to a commit in `plugin.yaml` (`build.source_commit`), and OKX's CI builds it from there.

1. On GitHub, open https://github.com/okx/plugin-store and click **Fork**. This creates `<you>/plugin-store`.
2. On your computer, from the folder that contains `latch`:
   ```bash
   git clone https://github.com/<you>/plugin-store.git
   cd plugin-store
   git checkout -b latch-plugin
   cp -r ../latch/plugin/latch-plugin skills/latch-plugin
   git add skills/latch-plugin
   git commit -m "Add latch-plugin: Latch on X Layer (buy OKB on dips / take profit, TapeOut-sized trades) for the OKX Agentic Wallet"
   git push -u origin latch-plugin
   ```
3. On GitHub, open your fork. Click **Compare & pull request**, with the base `okx/plugin-store` `main`, then fill in:
   - **Title:** `Add latch-plugin (X Layer: buy OKB on dips / take profit, sized by a TapeOut circuit)`
   - **Body:** what it does (two lines from SUMMARY.md), how it signs (OKX Agentic Wallet via `onchainos wallet contract-call`, the user confirms each one, the tool never touches keys), its only network call (the X Layer RPC), and the test (`agent/test.mjs`, 24 checks on a local chain).
4. OKX's CI lints the plugin and adds its install blocks to SKILL.md on your branch. Fix anything it reports and push again.

`author.github` in `plugin.yaml` must match the GitHub account that opens the pull request (`sollid-web`).
After any change to `agent/`, put the new commit into `build.source_commit` (`git rev-parse HEAD`).
