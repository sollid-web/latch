#!/usr/bin/env bash
# Pre-flight for golive.sh (from the independent review): rehearse the WHOLE lifecycle (deploy, fund,
# arm, tick, pause, withdraw-all) against a local fork of X Layer mainnet, with
# the REAL USDT0 and the REAL TapeOut processor bytecode. Costs nothing on chain.
# Usage: same env as golive.sh (OWNER_KEY is used only to derive OWNER; every tx
# on the fork is sent via impersonation). Run from the project root.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${OWNER_KEY:?}" "${PROCESSOR:?}" "${CIRCUIT_ID:?}" "${USDT:?}" "${SAVINGS:?}" "${TREASURY:?}" "${KEEPER:?}"
RPC="${RPC:-https://rpc.xlayer.tech}"
PER_TX="${PER_TX:-2}"; DAILY="${DAILY:-6}"; ACTIVATION="${ACTIVATION:-1}"
FORK_PORT="${FORK_PORT:-8547}"
F="http://127.0.0.1:$FORK_PORT"
fail(){ printf 'STOP: %s\n' "$*" >&2; exit 1; }
first(){ awk '{print $1}'; }
OWNER=$(cast wallet address --private-key "$OWNER_KEY")

anvil --fork-url "$RPC" --port "$FORK_PORT" --auto-impersonate --silent &
ANVIL=$!; trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do cast chain-id --rpc-url "$F" >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url "$F")" = "196" ] || fail "fork is not chain 196"

bal(){ cast call "$USDT" "balanceOf(address)(uint256)" "$1" --rpc-url "$F" | first; }
tx(){ local from="$1"; shift
  local st; st=$(cast send --unlocked --from "$from" "$@" --rpc-url "$F" --json | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))')
  [ "$st" = "0x1" ] || fail "tx from $from reverted: $*"; }
mustrevert(){ local from="$1"; shift
  if cast call --from "$from" "$@" --rpc-url "$F" >/dev/null 2>&1; then fail "expected revert: $*"; fi; }

cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "$F" >/dev/null
cast rpc anvil_setBalance "$KEEPER" 0x56BC75E2D63100000 --rpc-url "$F" >/dev/null

DEC=$(cast call "$USDT" "decimals()(uint8)" --rpc-url "$F" | first)
UNIT=$(python3 -c "print(10**$DEC)")
PT=$(python3 -c "print($PER_TX*$UNIT)"); DC=$(python3 -c "print($DAILY*$UNIT)"); AF=$(python3 -c "print($ACTIVATION*$UNIT)")

OUT=$(forge create contracts/LatchRelay.sol:LatchRelay --rpc-url "$F" --unlocked --from "$OWNER" --broadcast \
  --constructor-args "$PROCESSOR" "$CIRCUIT_ID" "$USDT" "$SAVINGS" "$TREASURY" "$KEEPER" "$PT" "$DC" "$AF")
RELAY=$(echo "$OUT" | awk '/Deployed to/{print $3}'); [ -n "$RELAY" ] || fail "fork deploy failed"
echo "fork relay $RELAY"

OB=$(bal "$OWNER"); NEED=$(python3 -c "print($AF + $PT + $PT*100//10000)")
[ "$OB" -ge "$NEED" ] || fail "owner has $OB base units on mainnet; need $NEED to rehearse arm + one full sweep"
tx "$OWNER" "$USDT" "transfer(address,uint256)" "$RELAY" "$NEED"
# Snapshot after funding: treasury or savings may be the owner address itself.
S0=$(bal "$SAVINGS"); T0=$(bal "$TREASURY")
[ "$(bal "$RELAY")" = "$NEED" ] || fail "fee-on-transfer or balance mismatch after funding"
mustrevert "$KEEPER" "$RELAY" "tick(uint256)" "$PT"           # NotArmed
tx "$OWNER" "$RELAY" "arm()"
[ "$(bal "$TREASURY")" = "$(python3 -c "print($T0+$AF)")" ] || fail "activation fee not received by treasury"
P=$(cast call --from "$KEEPER" "$RELAY" "preview(uint256)(uint8,bool)" "$PT" --rpc-url "$F" | tr '\n' ' ')
echo "preview as keeper: $P"; case "$P" in "126 true"*) ;; *) fail "preview != (126,true)";; esac
GAS=$(cast estimate --from "$KEEPER" "$RELAY" "tick(uint256)" "$PT" --rpc-url "$F"); echo "tick gas estimate $GAS"
tx "$KEEPER" "$RELAY" "tick(uint256)" "$PT"
[ "$(bal "$SAVINGS")" = "$(python3 -c "print($S0+$PT)")" ] || fail "savings did not receive exactly the sweep"
[ "$(bal "$TREASURY")" = "$(python3 -c "print($T0+$AF+$PT*100//10000)")" ] || fail "treasury fee mismatch"
tx "$OWNER" "$USDT" "transfer(address,uint256)" "$RELAY" 1
tx "$OWNER" "$RELAY" "setPaused(bool)" true
mustrevert "$KEEPER" "$RELAY" "tick(uint256)" 1                # Paused
REST=$(bal "$RELAY"); tx "$OWNER" "$RELAY" "withdraw(address,uint256)" "$OWNER" "$REST"
[ "$(bal "$RELAY")" = "0" ] || fail "vault not empty after paused withdraw"
# Implementation slots, so a later TapeOut / USDT0 upgrade is detectable.
SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
echo "processor impl slot: $(cast storage "$PROCESSOR" $SLOT --rpc-url "$RPC")"
echo "USDT0     impl slot: $(cast storage "$USDT" $SLOT --rpc-url "$RPC")"
echo "FORK REHEARSAL OK: deploy, fund, arm, preview, tick, fee, pause, withdraw-all all work against real mainnet code"
