#!/usr/bin/env bash
# FREE rehearsal of the whole LatchSwap lifecycle on a local copy (fork) of X Layer mainnet:
# the REAL USDT0, WOKB, Uniswap V3 pool + SwapRouter02 and TapeOut processor. Nothing is sent
# to mainnet. Run from the repo root:   ./scripts/preflight-swap.sh
#
# Reads keeper/.env for OWNER_PRIVATE_KEY (only to derive the owner address) and
# KEEPER_PRIVATE_KEY (only to derive the keeper address). Optional env overrides:
#   POOL_FEE (default 3000)  PER_TX / DAILY (whole USDT0, default 1 / 3)  ACTIVATION (default 0)
#   SLIPPAGE_BPS (default 150)  TWAP (seconds, default 600)  SAVINGS / TREASURY
#   LOCAL_RPC=http://…  use an already-running unlocked test chain instead of forking (for CI)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
: "${OWNER_PRIVATE_KEY:?put OWNER_PRIVATE_KEY in keeper/.env}" "${KEEPER_PRIVATE_KEY:?put KEEPER_PRIVATE_KEY in keeper/.env}"
RPC="${RPC:-https://rpc.xlayer.tech}"
PROCESSOR="${PROCESSOR:-0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813}"; CIRCUIT_ID="${CIRCUIT_ID:-1}"
USDT="${USDT:-0x779Ded0c9e1022225f8E0630b35a9b54bE713736}"
WOKB="${WOKB:-0xe538905cf8410324e03A5A23C1c177a474D59b2b}"
ROUTER="${ROUTER:-0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca}"
FACTORY="${FACTORY:-0x4B2ab38DBF28D31D467aA8993f6c2585981D6804}"
SAVINGS="${SAVINGS:-0x9005cb6847903AFC626eB4Dee5137606C567FeE7}"
TREASURY="${TREASURY:-0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4}"
POOL_FEE="${POOL_FEE:-3000}"; PER_TX="${PER_TX:-1}"; DAILY="${DAILY:-3}"; ACTIVATION="${ACTIVATION:-0}"
SLIPPAGE_BPS="${SLIPPAGE_BPS:-150}"; TWAP="${TWAP:-600}"

fail(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
ok(){ printf '  ok  %s\n' "$*"; }
first(){ awk '{print $1}'; }
ge(){ python3 -c "import sys; sys.exit(0 if int('$1') >= int('$2') else 1)"; }
OWNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
KEEPER=$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY")
STRANGER=0x000000000000000000000000000000000000dEaD

if [ -n "${LOCAL_RPC:-}" ]; then
  F="$LOCAL_RPC"
else
  F="http://127.0.0.1:${FORK_PORT:-8548}"
  echo "Starting a local copy of X Layer mainnet (nothing is sent to the real chain)…"
  anvil --fork-url "$RPC" --port "${FORK_PORT:-8548}" --auto-impersonate --silent &
  ANVIL=$!; trap 'kill $ANVIL 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do cast chain-id --rpc-url "$F" >/dev/null 2>&1 && break; sleep 1; done
  [ "$(cast chain-id --rpc-url "$F")" = "196" ] || fail "fork is not chain 196"
fi

bal(){ cast call "$1" "balanceOf(address)(uint256)" "$2" --rpc-url "$F" | first; }
tx(){ local from="$1"; shift
  local st; st=$(cast send --unlocked --from "$from" "$@" --rpc-url "$F" --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))' || true)
  [ "$st" = "0x1" ] || fail "transaction from $from failed: $*"; }
mustrevert(){ local label="$1" from="$2"; shift 2
  if cast call --from "$from" "$@" --rpc-url "$F" >/dev/null 2>&1; then fail "$label: expected the chain to refuse, but it allowed it"; fi
  ok "$label (refused, as it should be)"; }
cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "$F" >/dev/null
cast rpc anvil_setBalance "$KEEPER" 0x56BC75E2D63100000 --rpc-url "$F" >/dev/null

echo "== Pool"
POOL=$(cast call "$FACTORY" "getPool(address,address,uint24)(address)" "$USDT" "$WOKB" "$POOL_FEE" --rpc-url "$F")
[ "$POOL" != "0x0000000000000000000000000000000000000000" ] || fail "no Uniswap V3 USDT0/WOKB pool with fee $POOL_FEE — run keeper/poolprobe.mjs and set POOL_FEE"
S0=$(cast call "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$F" | tr '\n' ' ')
ok "pool $POOL · slot0: $S0"

DEC=$(cast call "$USDT" "decimals()(uint8)" --rpc-url "$F" | first); UNIT=$(python3 -c "print(10**$DEC)")
PT=$(python3 -c "print(int(round($PER_TX*$UNIT)))"); DC=$(python3 -c "print(int(round($DAILY*$UNIT)))"); AF=$(python3 -c "print(int(round($ACTIVATION*$UNIT)))")
HIGH=$(python3 -c "print(1000000*$UNIT)")   # max price so high any price passes (rehearsal only)

echo "== Deploy LatchSwap on the copy"
ARGS="($PROCESSOR,$CIRCUIT_ID,$USDT,$WOKB,$ROUTER,$POOL,$SAVINGS,$TREASURY,$KEEPER,$PT,$DC,$AF,$HIGH,$SLIPPAGE_BPS,$TWAP)"
OUT=$(forge create contracts/LatchSwap.sol:LatchSwap --rpc-url "$F" --unlocked --from "$OWNER" --broadcast --constructor-args "$ARGS" 2>&1) \
  || { echo "$OUT"; fail "deploy failed on the copy"; }
VAULT=$(echo "$OUT" | awk '/Deployed to/{print $3}'); [ -n "$VAULT" ] || { echo "$OUT"; fail "deploy failed"; }
ok "vault $VAULT"
Q=$(cast call "$VAULT" "quote(uint256)(uint256,uint256,uint256)" "$PT" --rpc-url "$F" 2>&1) \
  || fail "the pool cannot give a ${TWAP}s average price (too little history?). Output: $Q"
PRICE=$(echo "$Q" | sed -n 1p | first); EXP=$(echo "$Q" | sed -n 2p | first); MINOUT=$(echo "$Q" | sed -n 3p | first)
ok "10-min average OKB price: $(python3 -c "print($PRICE/$UNIT)") USDT0 · $PER_TX USDT0 → expect $(python3 -c "print($EXP/1e18)") WOKB (accept ≥ $(python3 -c "print($MINOUT/1e18)"))"

echo "== Fund and switch on"
NEED=$(python3 -c "print($AF + $PT + $PT*100//10000)")
OB=$(bal "$USDT" "$OWNER"); ge "$OB" "$NEED" || fail "owner has $OB USDT0 base units on mainnet; the rehearsal needs $NEED"
tx "$OWNER" "$USDT" "transfer(address,uint256)" "$VAULT" "$NEED"
mustrevert "buy before switching on" "$KEEPER" "$VAULT" "tick(uint256)" "$PT"
tx "$OWNER" "$VAULT" "arm()"; ok "switched on"

echo "== Price guard"
tx "$OWNER" "$VAULT" "setMaxPrice(uint256)" 1
mustrevert "buy when OKB is above the owner's max price" "$KEEPER" "$VAULT" "tick(uint256)" "$PT"
tx "$OWNER" "$VAULT" "setMaxPrice(uint256)" "$HIGH"
P=$(cast call --from "$KEEPER" "$VAULT" "preview(uint256)(uint8,bool)" "$PT" --rpc-url "$F" | tr '\n' ' ')
case "$P" in "126 true"*) ok "preview as helper bot: 126 (0x7e) allowed";; *) fail "preview is '$P', expected 126 true";; esac

echo "== Attacks"
mustrevert "stranger calls buy" "$STRANGER" "$VAULT" "tick(uint256)" "$PT"
mustrevert "helper bot tries 500 USDT0" "$KEEPER" "$VAULT" "tick(uint256)" "$(python3 -c "print(500*$UNIT)")"
mustrevert "helper bot tries to withdraw" "$KEEPER" "$VAULT" "withdraw(address,address,uint256)" "$USDT" "$KEEPER" 1
mustrevert "helper bot tries to raise max price" "$KEEPER" "$VAULT" "setMaxPrice(uint256)" 1

echo "== One real swap on the copy (real Uniswap pool)"
W0=$(bal "$WOKB" "$SAVINGS"); V0=$(bal "$USDT" "$VAULT")
GAS=$(cast estimate --from "$KEEPER" "$VAULT" "tick(uint256)" "$PT" --rpc-url "$F") || fail "the swap would fail (gas estimate reverted)"
tx "$KEEPER" "$VAULT" "tick(uint256)" "$PT"
GOT=$(python3 -c "print($(bal "$WOKB" "$SAVINGS") - $W0)")
SPENT=$(python3 -c "print($V0 - $(bal "$USDT" "$VAULT"))")
ge "$GOT" "$MINOUT" || fail "savings got $GOT WOKB units, less than the minimum $MINOUT"
[ "$SPENT" = "$(python3 -c "print($PT + $PT*100//10000)")" ] || fail "vault spent $SPENT, expected amount + 1% fee"
[ "$(cast call "$USDT" "allowance(address,address)(uint256)" "$VAULT" "$ROUTER" --rpc-url "$F" | first)" = "0" ] || fail "router allowance not reset"
ok "bought $(python3 -c "print($GOT/1e18)") WOKB into savings for $PER_TX USDT0 (+1% fee) · gas $GAS"

echo "== Emergency exit"
tx "$OWNER" "$VAULT" "setPaused(bool)" true
mustrevert "buy while paused" "$KEEPER" "$VAULT" "tick(uint256)" "$PT"
REST=$(bal "$USDT" "$VAULT")
if [ "$REST" != "0" ]; then tx "$OWNER" "$VAULT" "withdraw(address,address,uint256)" "$USDT" "$OWNER" "$REST"; fi
[ "$(bal "$USDT" "$VAULT")" = "0" ] || fail "vault not empty after withdraw"
ok "paused and withdrew everything"

echo
echo "REHEARSAL OK: deploy, switch on, price guard, attacks refused, real Uniswap swap, pause, withdraw-all."
echo "Nothing was sent to mainnet. Pool fee tier used: $POOL_FEE"
