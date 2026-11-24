#!/usr/bin/env bash
# FREE rehearsal of Latch v2 on a local copy (fork) of X Layer mainnet. Nothing is sent to mainnet.
#   1. tapes out strategy circuit #2 on the real Latch processor (with your real wallet, on the copy)
#   2. asks the real processor about all 65,536 inputs and compares with the rules
#   3. deploys LatchFactory2, then a Buy vault (smart DCA) and a Take Profit vault trade on the real pool
#   4. attacks refused, stolen-bot drill, the owner withdraws everything
#
#   ./scripts/preflight-v2.sh
#
# Reads keeper/.env: OWNER_PRIVATE_KEY (you: tapes out, deploys, plays the user), KEEPER_PRIVATE_KEY (hosted bot).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
: "${OWNER_PRIVATE_KEY:?put OWNER_PRIVATE_KEY in keeper/.env}" "${KEEPER_PRIVATE_KEY:?put KEEPER_PRIVATE_KEY in keeper/.env}"
RPC="${RPC:-https://rpc.xlayer.tech}"
. ./scripts/v2-addresses.sh
if [ -n "${LOCAL_RPC:-}" ]; then . "$LOCAL_ENV"; RPC="$LOCAL_RPC"; fi   # CI self-test only
USERSAVE=0x00000000000000000000000000000000CafE0001   # where the rehearsal user's output goes
ZERO=0x0000000000000000000000000000000000000000

fail(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
ok(){ printf '  ok  %s\n' "$*"; }
first(){ awk '{print $1}'; }
ge(){ python3 -c "import sys; sys.exit(0 if int('$1') >= int('$2') else 1)"; }
py(){ python3 -c "print($1)"; }
OWNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
BOT=$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY")
STRANGER=0x000000000000000000000000000000000000dEaD

echo "== Your real balances on X Layer (read-only)"
R_OKB=$(cast balance "$OWNER" --rpc-url "$RPC"); R_BEM=$(cast call "$BEM" "balanceOf(address)(uint256)" "$OWNER" --rpc-url "$RPC" | first)
echo "  owner $OWNER: $(cast from-wei "$R_OKB") OKB · $(py "$R_BEM/1e8") BEM"
echo "  mainnet go-live needs about 0.005 OKB (tapeout 0.0013 + gas) and 0.01 BEM (one NAND mint)"
ge "$R_BEM" 1000000 && BEM_OK=1 || { BEM_OK=0; echo "  NOTE: you have less than 0.01 BEM — the rehearsal lends you some on the copy, but buy 0.01 BEM before going live."; }

if [ -n "${LOCAL_RPC:-}" ]; then F="$LOCAL_RPC"; else
  F="http://127.0.0.1:${FORK_PORT:-8549}"
  echo "Starting a local copy of X Layer mainnet…"
  anvil --fork-url "$RPC" --port "${FORK_PORT:-8549}" --auto-impersonate --silent &
  ANVIL=$!; trap 'kill $ANVIL 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do cast chain-id --rpc-url "$F" >/dev/null 2>&1 && break; sleep 1; done
fi
bal(){ cast call "$1" "balanceOf(address)(uint256)" "$2" --rpc-url "$F" | first; }
tx(){ local from="$1"; shift; local out st h
  out=$(cast send --unlocked --from "$from" "$@" --rpc-url "$F" --json 2>&1) || true
  st=$(printf '%s' "$out" | python3 -c 'import sys,json
try: d=json.loads(sys.stdin.read()); print(d.get("status",""), d.get("transactionHash",""))
except Exception: print("")')
  [ "${st%% *}" = "0x1" ] && return 0
  echo "---- what the chain said ----"; printf '%s\n' "$out" | tail -n 15
  h="${st#* }"; if [ -n "$h" ] && [ "$h" != "$st" ]; then cast run "$h" --rpc-url "$F" 2>&1 | tail -n 40 || true; fi
  fail "transaction from $from failed: $*"; }
mustrevert(){ local label="$1" from="$2"; shift 2
  if cast call --from "$from" "$@" --rpc-url "$F" >/dev/null 2>&1; then fail "$label: expected the chain to refuse, but it allowed it"; fi
  ok "$label (refused, as it should be)"; }
for a in "$OWNER" "$BOT"; do cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$F" >/dev/null; done
if [ "$BEM_OK" = 0 ]; then   # lend 1 BEM on the copy only (BEM balances: mapping at slot 5)
  SLOT=$(cast index address "$OWNER" 5); cast rpc anvil_setStorageAt "$BEM" "$SLOT" "$(cast to-uint256 100000000)" --rpc-url "$F" >/dev/null
  ge "$(bal "$BEM" "$OWNER")" 1000000 || fail "could not lend BEM on the copy; buy 0.01 BEM and run again"
fi

echo "== 1. Tape out circuit #2 on the real processor (copy)"
if [ -n "${LOCAL_CID:-}" ]; then TOUT="CIRCUIT2_ID=$LOCAL_CID"; else
( cd keeper && [ -d node_modules ] || npm install --silent ) >/dev/null
TOUT=$(cd keeper && RPC_URL="$F" STATE="$(mktemp)" SEND=1 node tapeout2.mjs 2>&1) || { echo "$TOUT"; fail "tapeout rehearsal failed"; }
fi
echo "$TOUT" | sed 's/^/  | /'
CID=$(echo "$TOUT" | awk -F= '/^CIRCUIT2_ID=/{print $2}'); [ -n "$CID" ] || fail "no circuit id"
ok "circuit #$CID taped out on the copy"

echo "== 2. Ask the real processor about all 65,536 inputs"
node scripts/verify-circuit2.mjs "$F" "$PROCESSOR" "$CID" | tail -n 2 | sed 's/^/  | /'
node scripts/verify-circuit2.mjs "$F" "$PROCESSOR" "$CID" >/dev/null 2>&1 || fail "circuit #$CID does not match the rules"
ok "every input matches the rules"

echo "== 3. Deploy LatchFactory2 (copy)"
POOL=$(cast call "$UNI_FACTORY" "getPool(address,address,uint24)(address)" "$USDT" "$WOKB" "$POOL_FEE" --rpc-url "$F")
PINS="($PROCESSOR,$CID,$ROUTER,$POOL,$USDT,$WOKB,$TREASURY,$BOT,$TWAP,$SLIPPAGE_BPS,$MIN_BUY,$MIN_SELL)"
OUT=$(forge create contracts/LatchFactory2.sol:LatchFactory2 --optimize --optimizer-runs 200 --evm-version cancun \
  --rpc-url "$F" --unlocked --from "$OWNER" --broadcast --constructor-args "$PINS" 2>&1) || { echo "$OUT"; fail "factory deploy failed"; }
FAC=$(echo "$OUT" | awk '/Deployed to/{print $3}'); [ -n "$FAC" ] || { echo "$OUT"; fail "factory deploy failed"; }
ok "factory $FAC · vault template $(cast call "$FAC" "implementation()(address)" --rpc-url "$F")"
CV="createVault(uint8,uint8,address,uint256,uint256,uint256,uint256,uint256,uint256,address)"
SS="setStrategy(uint256,uint256,uint256,uint256,uint256,uint256,uint8)"
PV="preview(address)(uint16,uint8,uint256,uint256,uint256,uint256)"
lastvault(){ cast call "$FAC" "vaultsOf(address)(address[])" "$OWNER" --rpc-url "$F" | tr -d '[] ' | tr ',' '\n' | tail -n1; }
fund(){ # token amount → owner (real balance if enough, else borrowed from the pool on the copy)
  if ! ge "$(bal "$1" "$OWNER")" "$2"; then
    cast rpc anvil_setBalance "$POOL" 0xDE0B6B3A7640000 --rpc-url "$F" >/dev/null
    tx "$POOL" "$1" "transfer(address,uint256)" "$OWNER" "$2"; echo "  (copy only: borrowed $2 units of $1 for the rehearsal)"
  fi; }

echo "== 4. Buy vault, smart DCA: OKB ~12% under the reference → chip should pick 2x"
tx "$OWNER" "$FAC" "$CV" 0 2 "$USERSAVE" 1000000 3000000 6000000 1 1000000000000 0 "$ZERO"
BV=$(lastvault); P=$(cast call "$BV" "twapPrice()(uint256)" --rpc-url "$F" | first)
echo "  30-min average price: $(py "$P/1e6") USDT0 per OKB"
tx "$OWNER" "$BV" "$SS" 1000000 3000000 6000000 "$(py "$P*100//88")" "$(py "$P*105//100")" 3600 2
fund "$USDT" 2050000; tx "$OWNER" "$USDT" "transfer(address,uint256)" "$BV" 2050000
PREV=$(cast call "$BV" "$PV" "$BOT" --rpc-url "$F" | first | tr '\n' ' '); echo "  preview (inputs, k, amount, fee, minOut, price): $PREV"
set -- $PREV; [ "$2" = "2" ] && [ "$3" = "2000000" ] || fail "expected the chip to pick 2x = 2 USDT0, got k=$2 amount=$3"
mustrevert "stranger trades" "$STRANGER" "$BV" "tick()"
W0=$(bal "$WOKB" "$USERSAVE")
GAS=$(cast estimate --from "$BOT" "$BV" "tick()" --rpc-url "$F") || fail "trade simulation failed"
tx "$BOT" "$BV" "tick()" --gas-limit "$((GAS * 3 / 2))"
GOT=$(py "$(bal "$WOKB" "$USERSAVE") - $W0"); ge "$GOT" 1 || fail "no OKB arrived"
ok "bought $(py "$GOT/1e18") OKB for 2 USDT0 (chip: 2x) · gas $GAS"
mustrevert "second trade within the hour" "$BOT" "$BV" "tick()"

echo "== 5. Take Profit vault: OKB ~13.6% above the reference → chip should pick 2x"
tx "$OWNER" "$FAC" "$CV" 1 2 "$USERSAVE" 10000000000000000 30000000000000000 100000000000000000 1 1 0 "$ZERO"
SV=$(lastvault)
tx "$OWNER" "$SV" "$SS" 10000000000000000 30000000000000000 100000000000000000 "$(py "$P*88//100")" "$(py "$P*95//100")" 0 2
fund "$WOKB" 20500000000000000; tx "$OWNER" "$WOKB" "transfer(address,uint256)" "$SV" 20500000000000000
PREV=$(cast call "$SV" "$PV" "$BOT" --rpc-url "$F" | first | tr '\n' ' '); echo "  preview: $PREV"
set -- $PREV; [ "$2" = "2" ] && [ "$3" = "20000000000000000" ] || fail "expected 2x = 0.02 OKB, got k=$2 amount=$3"
U0=$(bal "$USDT" "$USERSAVE")
GAS=$(cast estimate --from "$BOT" "$SV" "tick()" --rpc-url "$F") || fail "take-profit simulation failed"
tx "$BOT" "$SV" "tick()" --gas-limit "$((GAS * 3 / 2))"
GOT=$(py "$(bal "$USDT" "$USERSAVE") - $U0"); ge "$GOT" 1 || fail "no USDT0 arrived"
ok "sold 0.02 OKB for $(py "$GOT/1e6") USDT0 (chip: 2x) · gas $GAS"
tx "$OWNER" "$SV" "$SS" 10000000000000000 30000000000000000 100000000000000000 "$(py "$P*88//100")" "$(py "$P*120//100")" 0 2
mustrevert "selling below the owner's floor price" "$BOT" "$SV" "tick()"

echo "== 6. Attacks and rules"
mustrevert "bot withdraws" "$BOT" "$BV" "withdraw(address,address,uint256)" "$USDT" "$BOT" 1
mustrevert "raise the daily limit" "$OWNER" "$BV" "$SS" 1000000 3000000 9000000 "$(py "$P*100//88")" "$(py "$P*105//100")" 3600 2
mustrevert "savings = the factory" "$OWNER" "$FAC" "$CV" 0 0 "$FAC" 1000000 1000000 1000000 1 1000000000 0 "$ZERO"
mustrevert "dust vault (0.5 USDT0)" "$OWNER" "$FAC" "$CV" 0 0 "$USERSAVE" 500000 1000000 1000000 1 1000000000 0 "$ZERO"
tx "$OWNER" "$FAC" "setRevoked(address,bool)" "$BOT" true
cast rpc evm_increaseTime 3700 --rpc-url "$F" >/dev/null; cast rpc evm_mine --rpc-url "$F" >/dev/null
mustrevert "revoked bot trades" "$BOT" "$BV" "tick()"
tx "$OWNER" "$FAC" "setRevoked(address,bool)" "$BOT" false; ok "un-revoked"

echo "== 7. The user takes everything out"
tx "$OWNER" "$BV" "withdraw(address,address,uint256)" "$USDT" "$OWNER" "$(cast max-uint)"
tx "$OWNER" "$SV" "withdraw(address,address,uint256)" "$WOKB" "$OWNER" "$(cast max-uint)"
[ "$(bal "$USDT" "$BV")" = "0" ] && [ "$(bal "$WOKB" "$SV")" = "0" ] || fail "vaults not empty"; ok "both vaults empty"

[ -n "${LOCAL_RPC:-}" ] || date -u > .preflight-v2-ok
echo
echo "REHEARSAL OK: circuit #2 taped out and checked on all 65,536 inputs, factory v2, a 2x Buy and a 2x Take Profit"
echo "on the real pool, attacks refused, revoke drill, withdrawals. Nothing was sent to mainnet."
[ "$BEM_OK" = 1 ] || echo "Before going live: get 0.01 BEM into $OWNER on X Layer."
