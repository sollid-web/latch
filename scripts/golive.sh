#!/usr/bin/env bash
# Deploy LatchRelay on X Layer, check the taped-out circuit, and point the
# console at it. Run after you have taped out the netlist and opened the
# container (README → "Deploy on X Layer", steps 1–2).
#
#   OWNER_KEY=0x…        owner/deployer key (holds a little OKB for gas)
#   PROCESSOR=0x…        TapeOut processor contract (factory.cpuAt(n))
#   CIRCUIT_ID=…         circuit ID from the tape-out
#   CONTAINER=0x…        opener.accountOf(processor, circuitId)
#   USDT=0x…             X Layer USDT (6 decimals)
#   SAVINGS=0x…          where sweeps go
#   TREASURY=0x…         where fees go
#   KEEPER=0x…           address of the keeper's gas-only key
# Optional: EXEC_FEE in wei, the OKB the container charges per execute
#           (default 1300000000000000 = 0.0013 OKB, TapeOut Nov 2026),
#           RPC (default https://rpc.xlayer.tech), CHAIN_ID (default 196),
#           PER_TX / DAILY / ACTIVATION in whole tokens (default 50 / 150 / 5).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${OWNER_KEY:?}" "${PROCESSOR:?}" "${CIRCUIT_ID:?}" "${CONTAINER:?}" "${USDT:?}" "${SAVINGS:?}" "${TREASURY:?}" "${KEEPER:?}"
RPC="${RPC:-https://rpc.xlayer.tech}"
CHAIN_ID="${CHAIN_ID:-196}"
PER_TX="${PER_TX:-50}"; DAILY="${DAILY:-150}"; ACTIVATION="${ACTIVATION:-5}"
EXEC_FEE="${EXEC_FEE:-1300000000000000}"

step(){ printf '\n== %s\n' "$*"; }
fail(){ printf 'STOP: %s\n' "$*" >&2; exit 1; }

step "Checking chain and addresses"
[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || fail "RPC is not chain $CHAIN_ID"
for name in PROCESSOR CONTAINER USDT; do
  [ "$(cast code "${!name}" --rpc-url "$RPC")" != "0x" ] || fail "$name ${!name} has no code on chain $CHAIN_ID"
done
DEC=$(cast call "$USDT" "decimals()(uint8)" --rpc-url "$RPC")
UNIT=$(python3 -c "print(10**$DEC)")
echo "token decimals: $DEC"

step "Checking the taped-out circuit directly (0x7e allow, 0x7f deny)"
ALLOW=$(cast call "$PROCESSOR" "eval(uint256,bytes)(bytes)" "$CIRCUIT_ID" 0x7e --rpc-url "$RPC" 2>/dev/null) \
  || fail "processor.eval reverted for circuit $CIRCUIT_ID — check PROCESSOR and CIRCUIT_ID"
DENY=$(cast call "$PROCESSOR" "eval(uint256,bytes)(bytes)" "$CIRCUIT_ID" 0x7f --rpc-url "$RPC" 2>/dev/null) \
  || fail "processor.eval reverted for circuit $CIRCUIT_ID"
echo "eval(0x7e) = $ALLOW · eval(0x7f) = $DENY"
[ $(( 0x${ALLOW:2:2} & 1 )) -eq 1 ] || fail "circuit does not allow 0x7e — wrong circuit ID or encoding"
[ $(( 0x${DENY:2:2} & 1 )) -eq 0 ] || fail "circuit allows 0x7f (paused) — wrong netlist"

step "Deploying LatchRelay"
OUT=$(forge create contracts/LatchRelay.sol:LatchRelay \
  --rpc-url "$RPC" --chain "$CHAIN_ID" --private-key "$OWNER_KEY" --broadcast \
  --constructor-args "$PROCESSOR" "$CIRCUIT_ID" "$CONTAINER" "$USDT" "$SAVINGS" "$TREASURY" "$KEEPER" \
    $((PER_TX * UNIT)) $((DAILY * UNIT)) $((ACTIVATION * UNIT)) "$EXEC_FEE")
echo "$OUT"
RELAY=$(echo "$OUT" | awk '/Deployed to/{print $3}')
[ -n "$RELAY" ] || fail "deploy failed"

step "Verifying through the relay"
[ "$(cast call "$RELAY" "circuitAllows(uint8)(bool)" 126 --rpc-url "$RPC")" = "true" ] || fail "relay: circuitAllows(0x7e) is false"
[ "$(cast call "$RELAY" "circuitAllows(uint8)(bool)" 127 --rpc-url "$RPC")" = "false" ] || fail "relay: circuitAllows(0x7f) is true"
echo "relay $RELAY sees the circuit correctly"

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

Done. Remaining, in order:
  1. Check the relay, then transfer the circuit NFT to it:  $RELAY
     (until then container.execute rejects the relay; this is one-way)
     Each container call costs $EXEC_FEE wei of OKB: attach it to arm/withdraw
     (cast send … --value $EXEC_FEE), the keeper attaches execCost() per sweep.
  2. Fund the container $CONTAINER with USDT.
  3. Open the console, connect the owner wallet, press "Arm on chain".
  4. keeper/.env: RELAY_ADDRESS=$RELAY, then: cd keeper && npm install && node daemon.mjs
  5. Commit index.html and redeploy the site:  npx wrangler deploy
EOF
