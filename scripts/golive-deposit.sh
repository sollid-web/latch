#!/usr/bin/env bash
# Deploy LatchDeposit (the deposit helper behind "Add USDT0") on X Layer MAINNET, then verify its source.
#
#   ./scripts/golive-deposit.sh
#
# 1. Rehearses on a local copy of mainnet (anvil --fork-url): deploys, then checks it knows both Latch factories,
#    refuses non-vaults, and accepts a real Latch vault. Free.
# 2. Asks you to type YES, then deploys on mainnet with OWNER_PRIVATE_KEY (gas only, far under 0.001 OKB).
# 3. Writes the address into deployments/web-config.json ("depositor") and verifies on Sourcify + OKLink.
# Re-run with DEPOSITOR=0x… to skip the deploy and only check, save and verify.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
: "${OWNER_PRIVATE_KEY:?put OWNER_PRIVATE_KEY in keeper/.env}"
RPC="${RPC:-https://rpc.xlayer.tech}"; CHAIN_ID=196
FAC1=0xc700C9865f237612b0bA86408BB4C182D41ABD11
FAC2=$(python3 -c "import json;print(json.load(open('deployments/web-config.json'))['factory2'])")
USDT0=$(python3 -c "import json;print(json.load(open('deployments/web-config.json'))['usdt'])")
step(){ printf '\n== %s\n' "$*"; }
fail(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
lc(){ printf '%s' "$1" | tr A-F a-f; }
BUILD=(--optimize --optimizer-runs 200 --evm-version cancun)
ARGS=("$FAC1" "$FAC2" "$USDT0")

step "Checking mainnet"
[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || fail "RPC is not X Layer"
[ "$(lc "$(cast call "$FAC2" 'quoteToken()(address)' --rpc-url "$RPC")")" = "$(lc "$USDT0")" ] || fail "factory2 quote token is not USDT0"
[ "$(lc "$(cast call "$FAC1" 'tokenIn()(address)' --rpc-url "$RPC")")" = "$(lc "$USDT0")" ] || fail "classic factory token is not USDT0"
SOME_VAULT=$(cast call "$FAC2" 'vaults(uint256)(address)' 0 --rpc-url "$RPC" 2>/dev/null || true)
OWNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
echo "classic factory $FAC1 · factory2 $FAC2 · USDT0 $USDT0 · deployer $OWNER"

check(){ # check <rpc> <address>
  local r="$1" a="$2"
  [ "$(lc "$(cast call "$a" 'factory2()(address)' --rpc-url "$r")")" = "$(lc "$FAC2")" ] || fail "helper does not point at factory2"
  [ "$(lc "$(cast call "$a" 'classicFactory()(address)' --rpc-url "$r")")" = "$(lc "$FAC1")" ] || fail "helper does not point at the classic factory"
  [ "$(lc "$(cast call "$a" 'classicToken()(address)' --rpc-url "$r")")" = "$(lc "$USDT0")" ] || fail "helper token is not USDT0"
  if cast call "$a" 'deposit(address,address,uint256)' "$USDT0" "$OWNER" 1 --from "$OWNER" --rpc-url "$r" >/dev/null 2>&1; then fail "helper accepted a non-vault address"; fi
  if [ -n "$SOME_VAULT" ] && [ "$SOME_VAULT" != "0x0000000000000000000000000000000000000000" ]; then
    local out; out=$(cast call "$a" 'deposit(address,address,uint256)' "$USDT0" "$SOME_VAULT" 1 --from 0x000000000000000000000000000000000000dEaD --rpc-url "$r" 2>&1 || true)
    echo "$out" | grep -qiE "NotALatchVault|0x9c01b758|WrongToken" && fail "helper did not recognise a real Latch vault"
  fi
  echo "helper checks OK at $a"
}

if [ -z "${DEPOSITOR:-}" ]; then
  step "1. Rehearsal on a local copy of mainnet (free)"
  anvil --fork-url "$RPC" --port 8657 --silent & APID=$!; trap 'kill $APID 2>/dev/null || true' EXIT
  for i in $(seq 1 90); do cast chain-id --rpc-url http://127.0.0.1:8657 >/dev/null 2>&1 && break; kill -0 $APID 2>/dev/null || fail "the local copy of mainnet (anvil) stopped; check your internet and run again"; sleep 1; done
  cast chain-id --rpc-url http://127.0.0.1:8657 >/dev/null 2>&1 || fail "the local copy of mainnet did not start within 90 s; run again"
  OUT=$(forge create contracts/LatchDeposit.sol:LatchDeposit "${BUILD[@]}" --rpc-url http://127.0.0.1:8657 --private-key "$OWNER_PRIVATE_KEY" --broadcast --constructor-args "${ARGS[@]}" 2>&1) || { echo "$OUT"; fail "rehearsal deploy failed"; }
  check http://127.0.0.1:8657 "$(echo "$OUT" | awk '/Deployed to/{print $3}')"
  kill $APID 2>/dev/null || true; trap - EXIT
  echo "REHEARSAL OK"

  printf '\nNext: deploy LatchDeposit on X Layer mainnet from %s (gas only).\nType YES to continue: ' "$OWNER"; read -r ans; [ "$ans" = "YES" ] || fail "stopped by you; nothing was sent"
  step "2. Deploying on mainnet"
  OUT=$(forge create contracts/LatchDeposit.sol:LatchDeposit "${BUILD[@]}" --rpc-url "$RPC" --chain "$CHAIN_ID" --private-key "$OWNER_PRIVATE_KEY" --broadcast --constructor-args "${ARGS[@]}" 2>&1) || { echo "$OUT"; fail "deploy failed"; }
  echo "$OUT" | grep -E "Deployed to|Transaction hash"
  DEPOSITOR=$(echo "$OUT" | awk '/Deployed to/{print $3}'); [ -n "$DEPOSITOR" ] || fail "deploy failed"
fi
check "$RPC" "$DEPOSITOR"

step "3. Saving the address for the website"
python3 - "$DEPOSITOR" <<'PY'
import json, sys
p = 'deployments/web-config.json'; d = json.load(open(p)); d['depositor'] = sys.argv[1]
open(p, 'w').write(json.dumps(d, indent=2) + '\n')
PY
echo "depositor $DEPOSITOR saved in deployments/web-config.json"

step "4. Verifying the source (Sourcify + OKLink, free)"
ENC=$(cast abi-encode 'c(address,address,address)' "${ARGS[@]}")
for v in sourcify oklink; do
  extra=(--verifier sourcify)
  [ "$v" = oklink ] && extra=(--verifier oklink --verifier-url "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER")
  echo "-- $v"
  forge verify-contract "$DEPOSITOR" contracts/LatchDeposit.sol:LatchDeposit --chain 196 --compiler-version 0.8.24 --optimizer-runs 200 \
    --evm-version cancun --constructor-args "$ENC" --rpc-url "$RPC" "${extra[@]}" --watch 2>&1 | tail -n 4 || true
done

echo
echo "DONE. Helper: https://www.oklink.com/xlayer/address/$DEPOSITOR"
echo "Next: git add deployments/web-config.json && git commit -m 'Deposit helper live' && git push && npm run deploy"
