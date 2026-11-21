#!/usr/bin/env bash
# Point the relay at the keeper key in keeper/.env and give that key gas.
# Reads OWNER_PRIVATE_KEY and KEEPER_PRIVATE_KEY from keeper/.env; checks every
# step and stops on anything unexpected. Run from anywhere:
#
#   ~/latch/scripts/set-keeper.sh
#
# Optional: RELAY (default from deployments/xlayer-mainnet.json), RPC, GAS_OKB (default 0.005).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
lc(){ printf '%s' "$1" | tr A-F a-f; }
RPC="${RPC:-https://rpc.xlayer.tech}"
GAS_OKB="${GAS_OKB:-0.005}"
RELAY="${RELAY:-$(python3 -c 'import json;print(json.load(open("deployments/xlayer-mainnet.json"))["relay"]["address"])')}"

[ -f keeper/.env ] || fail "keeper/.env not found in $ROOT"
getenv(){ { grep -E "^$1=" keeper/.env || true; } | tail -1 | cut -d= -f2- | tr -d ' "\r'"'"; }
OWNER_KEY="$(getenv OWNER_PRIVATE_KEY)"
KEEPER_KEY="$(getenv KEEPER_PRIVATE_KEY)"
[ -n "$OWNER_KEY" ] || fail "OWNER_PRIVATE_KEY missing from keeper/.env"
[ -n "$KEEPER_KEY" ] || fail "KEEPER_PRIVATE_KEY missing from keeper/.env"
[ "$(grep -c '^KEEPER_PRIVATE_KEY=' keeper/.env)" = "1" ] || fail "keeper/.env has more than one KEEPER_PRIVATE_KEY line; keep only one"

OWNER=$(cast wallet address --private-key "$OWNER_KEY" 2>/dev/null) || fail "OWNER_PRIVATE_KEY in keeper/.env is not a valid key"
KEEPER=$(cast wallet address --private-key "$KEEPER_KEY" 2>/dev/null) || fail "KEEPER_PRIVATE_KEY in keeper/.env is not a valid key"
RELAY_OWNER=$(cast call "$RELAY" "owner()(address)" --rpc-url "$RPC")
CURRENT=$(cast call "$RELAY" "keeper()(address)" --rpc-url "$RPC")

echo "relay          $RELAY"
echo "owner key      $OWNER"
echo "relay owner    $RELAY_OWNER"
echo "keeper key     $KEEPER"
echo "relay keeper   $CURRENT"
[ "$(lc "$OWNER")" = "$(lc "$RELAY_OWNER")" ] || fail "OWNER_PRIVATE_KEY is not the relay owner"
[ "$(lc "$KEEPER")" != "$(lc "$OWNER")" ] || fail "the keeper key must not be the owner key"

if [ "$(lc "$CURRENT")" = "$(lc "$KEEPER")" ]; then
  echo "relay already points at this keeper"
else
  cast call "$RELAY" "setKeeper(address)" "$KEEPER" --from "$OWNER" --rpc-url "$RPC" >/dev/null || fail "setKeeper simulation failed"
  cast send "$RELAY" "setKeeper(address)" "$KEEPER" --private-key "$OWNER_KEY" --rpc-url "$RPC" >/dev/null || fail "setKeeper transaction failed"
  NOW=$(cast call "$RELAY" "keeper()(address)" --rpc-url "$RPC")
  [ "$(lc "$NOW")" = "$(lc "$KEEPER")" ] || fail "relay keeper is $NOW after setKeeper"
  echo "setKeeper OK   relay keeper is now $NOW"
fi

BAL=$(cast balance "$KEEPER" --ether --rpc-url "$RPC")
if python3 -c "import sys; sys.exit(0 if float('$BAL') >= 0.002 else 1)"; then
  echo "keeper gas     $BAL OKB (enough)"
else
  cast send "$KEEPER" --value "${GAS_OKB}ether" --private-key "$OWNER_KEY" --rpc-url "$RPC" >/dev/null || fail "could not send gas to keeper"
  echo "keeper gas     $(cast balance "$KEEPER" --ether --rpc-url "$RPC") OKB (sent $GAS_OKB)"
fi

echo
echo "KEEPER READY. Next: cd $ROOT/keeper && node daemon.mjs"
