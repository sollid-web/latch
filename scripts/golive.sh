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
# Addresses that must never receive sweeps (old relay and its stuck container).
OLD_ADDRESSES="0xa4b9259279e4d5130fa563cb64b7ab73e2237a02 0xa38eb1b5bf13c423b5ae5d844f08dc6774a9fce0"

step(){ printf '\n== %s\n' "$*"; }
fail(){ printf 'STOP: %s\n' "$*" >&2; exit 1; }
first(){ awk '{print $1}'; }
lc(){ printf '%s' "$1" | tr A-F a-f; }
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
  c=$(cast code "${!name}" --rpc-url "$RPC") || fail "cannot read code at $name"
  [ "$c" != "0x" ] || fail "$name ${!name} has no code on chain $CHAIN_ID"
done
DEC=$(cast call "$USDT" "decimals()(uint8)" --rpc-url "$RPC" | first)
UNIT=$(python3 -c "print(10**$DEC)")
PT=$(python3 -c "print(int(round($PER_TX*$UNIT)))"); DC=$(python3 -c "print(int(round($DAILY*$UNIT)))"); AF=$(python3 -c "print(int(round($ACTIVATION*$UNIT)))")

step "Checking savings, treasury and keeper (sweeps go here and cannot be changed later)"
for name in SAVINGS TREASURY KEEPER; do
  v=$(lc "${!name}")
  [[ "$v" =~ ^0x[0-9a-f]{40}$ ]] || fail "$name is not an address: ${!name}"
  for bad in "$(lc "$PROCESSOR")" "$(lc "$USDT")" $OLD_ADDRESSES; do
    [ "$v" != "$bad" ] || fail "$name must not be $bad (funds sent there cannot come back)"
  done
  c=$(cast code "${!name}" --rpc-url "$RPC") || fail "cannot read code at $name"
  [ "$c" = "0x" ] || [ "${ALLOW_CONTRACT:-}" = "$name" ] || fail "$name is a contract; use a wallet address (or set ALLOW_CONTRACT=$name if you are sure it can move USDT0)"
done
[ "$(lc "$KEEPER")" != "$(lc "$OWNER")" ] || fail "KEEPER must not be the owner (the keeper key lives on a hot machine)"
for a in "$OWNER" "$SAVINGS" "$TREASURY"; do
  b=$(cast call "$USDT" "isBlocked(address)(bool)" "$a" --rpc-url "$RPC" 2>/dev/null || echo "n/a")
  [ "$b" != "true" ] || fail "$a is blocked by the token issuer"
done
printf '\nOWNER    %s\nSAVINGS  %s  (sweeps)\nTREASURY %s  (fees)\nKEEPER   %s  (gas-only key)\nCaps: %s per sweep, %s per day, %s to arm\n' \
  "$OWNER" "$SAVINGS" "$TREASURY" "$KEEPER" "$PER_TX" "$DAILY" "$ACTIVATION"
if [ "${YES:-}" != "1" ]; then
  printf 'Check these against your OKX Wallet. Type YES to deploy: '; read -r ans; [ "$ans" = "YES" ] || fail "aborted"
fi
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
    "$PT" "$DC" "$AF")
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
check "perTxCap()(uint256)" "$PT"
check "dailyCap()(uint256)" "$DC"
check "activationFee()(uint256)" "$AF"
check "unit()(uint256)" "$UNIT"
check "armed()(bool)" "false"
check "paused()(bool)" "false"
check "pendingOwner()(address)" "0x0000000000000000000000000000000000000000"
check "circuitAllows(uint8)(bool)" "true" 126
check "circuitAllows(uint8)(bool)" "false" 127

step "Round-trip test on mainnet: fund $SMOKE base units, withdraw them back"
BEFORE=$(tokbal "$OWNER")
sendok "fund vault" "$USDT" "transfer(address,uint256)" "$RELAY" "$SMOKE"
[ "$(tokbal "$RELAY")" = "$SMOKE" ] || fail "vault balance is not $SMOKE after funding (withdraw it manually: cast send $RELAY 'withdraw(address,uint256)' $OWNER 115792089237316195423570985008687907853269984665640564039457584007913129639935 …)"
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
if not m:
    sys.exit('STOP: APP_CONFIG not found in index.html; the relay is deployed, add it to the page by hand')
cfg = json.loads(m.group(1))
cfg['chainId'] = chain
cfg.setdefault('contracts', {})['LatchRelay'] = {'address': relay}
line = 'window.APP_CONFIG=' + json.dumps(cfg, separators=(',', ':')) + ';</script>'
html = html[:m.start()] + line + html[m.end():]
open('index.html', 'w').write(html)
print('index.html APP_CONFIG ->', json.dumps(cfg))
PY

cat <<EOF

Done. Relay: $RELAY
Next, in order (check each with Claude):
  1. Fund the vault: send USDT0 to $RELAY (a plain transfer).
  2. Arm (simulate first):
       cast call $RELAY "arm()" --from $OWNER --rpc-url $RPC
       cast send $RELAY "arm()" --private-key \$OWNER_KEY --rpc-url $RPC
  3. keeper/.env: RELAY_ADDRESS=$RELAY and KEEPER_PRIVATE_KEY=…, then: cd keeper && node daemon.mjs
  4. Commit index.html and redeploy the site.

Emergency (pause, then withdraw everything to the owner):
  cast send $RELAY "setPaused(bool)" true --private-key \$OWNER_KEY --rpc-url $RPC
  cast send $RELAY "withdraw(address,uint256)" $OWNER 115792089237316195423570985008687907853269984665640564039457584007913129639935 --private-key \$OWNER_KEY --rpc-url $RPC
EOF
