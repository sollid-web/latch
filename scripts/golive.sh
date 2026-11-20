#!/usr/bin/env bash
# Deploy LatchRelay (self-custody vault gated by a taped-out TapeOut circuit)
# on X Layer, prove on mainnet that funds can come back out, and point the
# console at it.
#
#   OWNER_KEY=0x…     owner/deployer key (a little OKB for gas, ≥ 0.1 token for the round-trip test)
#   PROCESSOR=0x…     TapeOut processor holding your circuit
#   CIRCUIT_ID=…      circuit ID (eval must allow 0x7e and deny 0x7f)
#   USDT=0x…          token the vault holds (X Layer USDT0 0x779D…3736, 6 decimals)
#   SAVINGS=0x…       where sweeps go
#   TREASURY=0x…      where fees go
#   KEEPER=0x…        address of the keeper's gas-only key
# Optional: PER_TX / DAILY / ACTIVATION in whole tokens (default 2 / 6 / 1),
#           RPC (default https://rpc.xlayer.tech), CHAIN_ID (default 196),
#           SMOKE in base units for the round-trip test (default 100000 = 0.1 at 6 decimals).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${OWNER_KEY:?}" "${PROCESSOR:?}" "${CIRCUIT_ID:?}" "${USDT:?}" "${SAVINGS:?}" "${TREASURY:?}" "${KEEPER:?}"
RPC="${RPC:-https://rpc.xlayer.tech}"
CHAIN_ID="${CHAIN_ID:-196}"
PER_TX="${PER_TX:-2}"; DAILY="${DAILY:-6}"; ACTIVATION="${ACTIVATION:-1}"
SMOKE="${SMOKE:-100000}"

step(){ printf '\n== %s\n' "$*"; }
fail(){ printf 'STOP: %s\n' "$*" >&2; exit 1; }
first(){ awk '{print $1}'; }
OWNER=$(cast wallet address --private-key "$OWNER_KEY")
tokbal(){ cast call "$USDT" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | first; }
# Send a transaction and require status 1.
sendok(){
  local label="$1"; shift
  local out
  out=$(cast send "$@" --private-key "$OWNER_KEY" --rpc-url "$RPC" --json) || fail "$label could not be sent"
  local st; st=$(printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status",""), d.get("transactionHash",""))')
  echo "$label: $st"
  case "$st" in 0x1*|1\ *) ;; *) fail "$label reverted on chain";; esac
}

step "Checking chain and addresses"
[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || fail "RPC is not chain $CHAIN_ID"
for name in PROCESSOR USDT; do
  [ "$(cast code "${!name}" --rpc-url "$RPC")" != "0x" ] || fail "$name ${!name} has no code on chain $CHAIN_ID"
done
DEC=$(cast call "$USDT" "decimals()(uint8)" --rpc-url "$RPC" | first)
UNIT=$(python3 -c "print(10**$DEC)")
OWNER_BAL=$(tokbal "$OWNER")
echo "owner $OWNER · token decimals $DEC · owner token balance $OWNER_BAL"
[ "$OWNER_BAL" -ge "$SMOKE" ] || fail "owner needs at least $SMOKE base units of the token for the round-trip test"

step "Checking the taped-out circuit directly (0x7e allow, 0x7f deny)"
ALLOW=$(cast call "$PROCESSOR" "eval(uint256,bytes)(bytes)" "$CIRCUIT_ID" 0x7e --rpc-url "$RPC" 2>/dev/null) \
  || fail "processor.eval reverted for circuit $CIRCUIT_ID — check PROCESSOR and CIRCUIT_ID"
DENY=$(cast call "$PROCESSOR" "eval(uint256,bytes)(bytes)" "$CIRCUIT_ID" 0x7f --rpc-url "$RPC" 2>/dev/null) \
  || fail "processor.eval reverted for circuit $CIRCUIT_ID"
echo "eval(0x7e) = $ALLOW · eval(0x7f) = $DENY"
[ $(( 0x${ALLOW:2:2} & 1 )) -eq 1 ] || fail "circuit does not allow 0x7e"
[ $(( 0x${DENY:2:2} & 1 )) -eq 0 ] || fail "circuit allows 0x7f (paused)"

step "Deploying LatchRelay"
OUT=$(forge create contracts/LatchRelay.sol:LatchRelay \
  --rpc-url "$RPC" --chain "$CHAIN_ID" --private-key "$OWNER_KEY" --broadcast \
  --constructor-args "$PROCESSOR" "$CIRCUIT_ID" "$USDT" "$SAVINGS" "$TREASURY" "$KEEPER" \
    $((PER_TX * UNIT)) $((DAILY * UNIT)) $((ACTIVATION * UNIT)))
echo "$OUT"
RELAY=$(echo "$OUT" | awk '/Deployed to/{print $3}')
[ -n "$RELAY" ] || fail "deploy failed"

step "Verifying the deployed settings"
check(){
  local got; got=$(cast call "$RELAY" "$1" "${@:3}" --rpc-url "$RPC" | first)
  echo "$1 ${*:3} = $got"
  [ "$(echo "$got" | tr A-F a-f)" = "$(echo "$2" | tr A-F a-f)" ] || fail "$1 is $got, expected $2"
}
check "owner()(address)" "$OWNER"
check "processor()(address)" "$PROCESSOR"
check "circuitId()(uint256)" "$CIRCUIT_ID"
check "token()(address)" "$USDT"
check "savings()(address)" "$SAVINGS"
check "treasury()(address)" "$TREASURY"
check "keeper()(address)" "$KEEPER"
check "perTxCap()(uint256)" "$((PER_TX * UNIT))"
check "dailyCap()(uint256)" "$((DAILY * UNIT))"
check "circuitAllows(uint8)(bool)" "true" 126
check "circuitAllows(uint8)(bool)" "false" 127

step "Round-trip test on mainnet: fund $SMOKE base units, withdraw them back"
BEFORE=$(tokbal "$OWNER")
sendok "fund vault" "$USDT" "transfer(address,uint256)" "$RELAY" "$SMOKE"
[ "$(tokbal "$RELAY")" = "$SMOKE" ] || fail "vault balance is not $SMOKE after funding"
cast call "$RELAY" "withdraw(address,uint256)" "$OWNER" "$SMOKE" --from "$OWNER" --rpc-url "$RPC" >/dev/null \
  || fail "withdraw simulation fails — DO NOT FUND THIS RELAY; send this output to Claude"
sendok "withdraw back" "$RELAY" "withdraw(address,uint256)" "$OWNER" "$SMOKE"
[ "$(tokbal "$RELAY")" = "0" ] || fail "vault not empty after withdraw"
[ "$(tokbal "$OWNER")" = "$BEFORE" ] || fail "owner balance did not return to $BEFORE"
echo "round trip OK: money goes in and comes back out of $RELAY on mainnet"

step "Pointing the console at the relay"
python3 - "$RELAY" "$CHAIN_ID" <<'PY'
import json, re, sys
relay, chain = sys.argv[1], int(sys.argv[2])
html = open('index.html').read()
m = re.search(r'window\.APP_CONFIG=(\{.*?\});</script>', html)
cfg = json.loads(m.group(1)) if m else {}
cfg['chainId'] = chain
cfg.setdefault('contracts', {})['LatchRelay'] = {'address': relay}
line = 'window.APP_CONFIG=' + json.dumps(cfg, separators=(',', ':')) + ';</script>'
html = html[:m.start()] + line + html[m.end():] if m else html
open('index.html', 'w').write(html)
print('index.html APP_CONFIG ->', json.dumps(cfg))
PY

cat <<EOF

Done. Relay: $RELAY
Next, in order (check each with Claude):
  1. Fund the vault: send USDT0 to $RELAY (a plain transfer).
  2. Arm (simulate first):
       cast call $RELAY "arm()" --from $OWNER --rpc-url $RPC
       cast send $RELAY "arm()" --private-key \$OWNER_PRIVATE_KEY --rpc-url $RPC
  3. keeper/.env: RELAY_ADDRESS=$RELAY and KEEPER_PRIVATE_KEY=…, then: cd keeper && node daemon.mjs
  4. Commit index.html and redeploy the site.
EOF
