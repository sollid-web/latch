#!/usr/bin/env bash
# Deploy LatchSwap on X Layer mainnet, verify every setting, and prove on mainnet that money
# put in comes back out. Run ./scripts/preflight-swap.sh first (free) — this script refuses to
# run until that rehearsal has passed on this machine.
#
#   ./scripts/golive-swap.sh
#
# Reads keeper/.env: OWNER_PRIVATE_KEY (deploys, owns the vault), KEEPER_PRIVATE_KEY (only its
# address is used). Optional env: MAX_PRICE (whole USDT0 per OKB, default 48), PER_TX / DAILY
# (default 1 / 3), ACTIVATION (default 0), SLIPPAGE_BPS (default 100), TWAP (default 1800),
# SAVINGS, TREASURY, SMOKE (round-trip test, base units, default 100000 = 0.1 USDT0).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
: "${OWNER_PRIVATE_KEY:?put OWNER_PRIVATE_KEY in keeper/.env}" "${KEEPER_PRIVATE_KEY:?put KEEPER_PRIVATE_KEY in keeper/.env}"

RPC="${RPC:-https://rpc.xlayer.tech}"; CHAIN_ID=196
# Canonical X Layer addresses (Uniswap docs + TapeOut deployment). Not overridable on purpose.
PROCESSOR=0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813; CIRCUIT_ID=1
USDT=0x779Ded0c9e1022225f8E0630b35a9b54bE713736
WOKB=0xe538905cf8410324e03A5A23C1c177a474D59b2b
ROUTER=0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca
FACTORY=0x4B2ab38DBF28D31D467aA8993f6c2585981D6804
POOL_FEE=500
SAVINGS="${SAVINGS:-0x9005cb6847903AFC626eB4Dee5137606C567FeE7}"
TREASURY="${TREASURY:-0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4}"
MAX_PRICE="${MAX_PRICE:-48}"; PER_TX="${PER_TX:-1}"; DAILY="${DAILY:-3}"; ACTIVATION="${ACTIVATION:-0}"
SLIPPAGE_BPS="${SLIPPAGE_BPS:-100}"; TWAP="${TWAP:-1800}"; SMOKE="${SMOKE:-100000}"
OLD="0xa4b9259279e4d5130fa563cb64b7ab73e2237a02 0xa38eb1b5bf13c423b5ae5d844f08dc6774a9fce0 0x7952c9b53347518b29016d2eaed8690a9808a2a0"

step(){ printf '\n== %s\n' "$*"; }
fail(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
first(){ awk '{print $1}'; }
lc(){ printf '%s' "$1" | tr A-F a-f; }
ge(){ python3 -c "import sys; sys.exit(0 if int('$1') >= int('$2') else 1)"; }
OWNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
KEEPER=$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY")
tokbal(){ cast call "$USDT" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | first; }
sendok(){ local label="$1"; shift
  local out; out=$(cast send "$@" --private-key "$OWNER_PRIVATE_KEY" --rpc-url "$RPC" --json) || fail "$label could not be sent"
  local st; st=$(printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status",""), d.get("transactionHash",""))')
  echo "$label: $st"; case "$st" in 0x1*|1\ *) ;; *) fail "$label reverted on chain";; esac; }

[ -f .preflight-swap-ok ] || fail "run ./scripts/preflight-swap.sh first (free rehearsal); it must end with REHEARSAL OK"

step "Checking chain, Uniswap and TapeOut addresses"
[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || fail "RPC is not X Layer ($CHAIN_ID)"
[ "$(lc "$(cast call "$ROUTER" "factory()(address)" --rpc-url "$RPC")")" = "$(lc "$FACTORY")" ] || fail "router.factory() is not the Uniswap V3 factory"
POOL=$(cast call "$FACTORY" "getPool(address,address,uint24)(address)" "$USDT" "$WOKB" "$POOL_FEE" --rpc-url "$RPC")
[ "$(lc "$POOL")" = "0xe3be6a0137f1b0602fc1a4841686f43b340a5082" ] || fail "unexpected pool $POOL"
CARD=$(cast call "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$RPC" | sed -n 4p | first)
ge "$CARD" 100 || fail "pool keeps only $CARD price records"
echo "pool $POOL (0.05%), price records kept: $CARD"
ALLOW=$(cast call "$PROCESSOR" "eval(uint256,bytes)(bytes)" "$CIRCUIT_ID" 0x7e --rpc-url "$RPC"); DENY=$(cast call "$PROCESSOR" "eval(uint256,bytes)(bytes)" "$CIRCUIT_ID" 0x7f --rpc-url "$RPC")
[ $(( 0x${ALLOW:2:2} & 1 )) -eq 1 ] && [ $(( 0x${DENY:2:2} & 1 )) -eq 0 ] || fail "circuit #$CIRCUIT_ID does not allow 0x7e / deny 0x7f"
echo "circuit #$CIRCUIT_ID: eval(0x7e)=$ALLOW eval(0x7f)=$DENY"

step "Checking savings, treasury and helper bot (cannot be changed after deploy, except the bot)"
for name in SAVINGS TREASURY KEEPER; do
  v=$(lc "${!name}"); [[ "$v" =~ ^0x[0-9a-f]{40}$ ]] || fail "$name is not an address"
  for bad in $(lc "$PROCESSOR") $(lc "$USDT") $(lc "$WOKB") $(lc "$ROUTER") $(lc "$POOL") $(lc "$FACTORY") $OLD; do
    [ "$v" != "$bad" ] || fail "$name must not be $bad"
  done
  [ "$(cast code "${!name}" --rpc-url "$RPC")" = "0x" ] || fail "$name is a contract; use a wallet address"
done
[ "$(lc "$KEEPER")" != "$(lc "$OWNER")" ] || fail "the helper bot key must not be the owner key"

DEC=6; UNIT=1000000
PT=$(python3 -c "print(int(round($PER_TX*$UNIT)))"); DC=$(python3 -c "print(int(round($DAILY*$UNIT)))")
AF=$(python3 -c "print(int(round($ACTIVATION*$UNIT)))"); MP=$(python3 -c "print(int(round($MAX_PRICE*$UNIT)))")
NOW=$(cast call "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$RPC" | sed -n 2p | first)
SPOT=$(python3 -c "print(round(1e12/1.0001**$NOW, 2))")
printf '\nOWNER     %s\nSAVINGS   %s  (receives the OKB)\nTREASURY  %s  (fees)\nHELPER BOT %s\nBuys: %s USDT0 each, %s per day, only when OKB 30-min average <= %s (now ~%s)\nSlippage %s bps · switch-on fee %s USDT0\n' \
  "$OWNER" "$SAVINGS" "$TREASURY" "$KEEPER" "$PER_TX" "$DAILY" "$MAX_PRICE" "$SPOT" "$SLIPPAGE_BPS" "$ACTIVATION"
if [ "${YES:-}" != "1" ]; then printf '\nCheck these against your OKX Wallet. Type YES to deploy: '; read -r ans; [ "$ans" = "YES" ] || fail "aborted"; fi
ge "$(tokbal "$OWNER")" "$SMOKE" || fail "owner needs at least $SMOKE USDT0 base units for the round-trip test"

step "Deploying LatchSwap"
ARGS="($PROCESSOR,$CIRCUIT_ID,$USDT,$WOKB,$ROUTER,$POOL,$SAVINGS,$TREASURY,$KEEPER,$PT,$DC,$AF,$MP,$SLIPPAGE_BPS,$TWAP)"
OUT=$(forge create contracts/LatchSwap.sol:LatchSwap --rpc-url "$RPC" --chain "$CHAIN_ID" --private-key "$OWNER_PRIVATE_KEY" --broadcast --constructor-args "$ARGS")
echo "$OUT"; VAULT=$(echo "$OUT" | awk '/Deployed to/{print $3}'); [ -n "$VAULT" ] || fail "deploy failed"

step "Verifying the deployed settings"
check(){ local got; got=$(cast call "$VAULT" "$1" "${@:3}" --rpc-url "$RPC" | first); echo "$1 = $got"
  [ "$(lc "$got")" = "$(lc "$2")" ] || fail "$1 is $got, expected $2"; }
check "owner()(address)" "$OWNER"; check "keeper()(address)" "$KEEPER"
check "savings()(address)" "$SAVINGS"; check "treasury()(address)" "$TREASURY"
check "tokenIn()(address)" "$USDT"; check "tokenOut()(address)" "$WOKB"
check "router()(address)" "$ROUTER"; check "pool()(address)" "$POOL"; check "poolFee()(uint24)" "$POOL_FEE"
check "processor()(address)" "$PROCESSOR"; check "circuitId()(uint256)" "$CIRCUIT_ID"
check "perTxCap()(uint256)" "$PT"; check "dailyCap()(uint256)" "$DC"; check "maxPrice()(uint256)" "$MP"
check "maxSlippageBps()(uint256)" "$SLIPPAGE_BPS"; check "twapWindow()(uint32)" "$TWAP"
check "armed()(bool)" "false"; check "paused()(bool)" "false"
check "circuitAllows(uint8)(bool)" "true" 126; check "circuitAllows(uint8)(bool)" "false" 127
cast call "$VAULT" "quote(uint256)(uint256,uint256,uint256)" "$PT" --rpc-url "$RPC" >/dev/null || fail "quote() fails on the live pool"

step "Round-trip test on mainnet: put $SMOKE in, take it back out"
BEFORE=$(tokbal "$OWNER")
sendok "fund vault" "$USDT" "transfer(address,uint256)" "$VAULT" "$SMOKE"
[ "$(tokbal "$VAULT")" = "$SMOKE" ] || fail "vault balance is not $SMOKE"
cast call "$VAULT" "withdraw(address,address,uint256)" "$USDT" "$OWNER" "$SMOKE" --from "$OWNER" --rpc-url "$RPC" >/dev/null || fail "withdraw simulation fails — DO NOT FUND; send this to Claude"
sendok "withdraw back" "$VAULT" "withdraw(address,address,uint256)" "$USDT" "$OWNER" "$SMOKE"
[ "$(tokbal "$VAULT")" = "0" ] && [ "$(tokbal "$OWNER")" = "$BEFORE" ] || fail "round trip did not return the money"
echo "round trip OK"

python3 - "$VAULT" "$POOL" <<'PY'
import json, sys, datetime
v, p = sys.argv[1], sys.argv[2]
json.dump({"LatchSwap": v, "pool": p, "chainId": 196, "deployedAt": datetime.datetime.utcnow().isoformat() + "Z"},
          open('deployments/xlayer-swap.json', 'w'), indent=2)
print('wrote deployments/xlayer-swap.json')
PY
cat <<EOF

Done. LatchSwap vault: $VAULT
Next (with Claude): fund it with a few USDT0, switch it on (arm), point the helper bot at it.
Emergency: cast send $VAULT "setPaused(bool)" true --private-key \$OWNER_PRIVATE_KEY --rpc-url $RPC
           cast send $VAULT "withdraw(address,address,uint256)" $USDT $OWNER 115792089237316195423570985008687907853269984665640564039457584007913129639935 --private-key \$OWNER_PRIVATE_KEY --rpc-url $RPC
EOF
