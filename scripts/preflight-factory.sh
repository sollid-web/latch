#!/usr/bin/env bash
# FREE rehearsal of the whole Latch product on a local copy (fork) of X Layer mainnet:
# deploy the factory, a user creates a vault, funds it, the hosted bot buys real OKB on the
# real Uniswap pool, attacks are refused, a revoke works, the user withdraws everything.
# Nothing is sent to mainnet.     ./scripts/preflight-factory.sh
#
# Reads keeper/.env: OWNER_PRIVATE_KEY (deployer/admin; also plays the user) and
# KEEPER_PRIVATE_KEY (the hosted helper bot). Optional: LOCAL_RPC=… (CI), MIN_CARDINALITY.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
: "${OWNER_PRIVATE_KEY:?put OWNER_PRIVATE_KEY in keeper/.env}" "${KEEPER_PRIVATE_KEY:?put KEEPER_PRIVATE_KEY in keeper/.env}"
RPC="${RPC:-https://rpc.xlayer.tech}"
PROCESSOR="${PROCESSOR:-0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813}"; CIRCUIT_ID="${CIRCUIT_ID:-1}"
USDT="${USDT:-0x779Ded0c9e1022225f8E0630b35a9b54bE713736}"; WOKB="${WOKB:-0xe538905cf8410324e03A5A23C1c177a474D59b2b}"
ROUTER="${ROUTER:-0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca}"; FACTORY_V3="${FACTORY_V3:-0x4B2ab38DBF28D31D467aA8993f6c2585981D6804}"
POOL_FEE="${POOL_FEE:-500}"; MIN_CARDINALITY="${MIN_CARDINALITY:-100}"
TREASURY="${TREASURY:-0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4}"
USERSAVE=0x00000000000000000000000000000000CafE0001   # where the rehearsal user's OKB goes

fail(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
ok(){ printf '  ok  %s\n' "$*"; }
first(){ awk '{print $1}'; }
ge(){ python3 -c "import sys; sys.exit(0 if int('$1') >= int('$2') else 1)"; }
OWNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
BOT=$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY")
STRANGER=0x000000000000000000000000000000000000dEaD
if [ -n "${LOCAL_RPC:-}" ]; then F="$LOCAL_RPC"; else
  F="http://127.0.0.1:${FORK_PORT:-8549}"
  echo "Starting a local copy of X Layer mainnet (nothing is sent to the real chain)…"
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

echo "== Pool"
POOL=$(cast call "$FACTORY_V3" "getPool(address,address,uint24)(address)" "$USDT" "$WOKB" "$POOL_FEE" --rpc-url "$F")
CARD=$(cast call "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$F" | sed -n 4p | first)
ge "$CARD" "$MIN_CARDINALITY" || fail "pool keeps only $CARD price records"
ok "pool $POOL · price records $CARD"

echo "== Deploy the factory on the copy"
OUT=$(forge create contracts/LatchFactory.sol:LatchFactory --rpc-url "$F" --unlocked --from "$OWNER" --broadcast \
  --constructor-args "$PROCESSOR" "$CIRCUIT_ID" "$USDT" "$WOKB" "$ROUTER" "$POOL" "$TREASURY" "$BOT" 1800 100 1000000 2>&1) || { echo "$OUT"; fail "factory deploy failed"; }
FAC=$(echo "$OUT" | awk '/Deployed to/{print $3}'); [ -n "$FAC" ] || { echo "$OUT"; fail "factory deploy failed"; }
ok "factory $FAC"

echo "== A user creates a DCA vault (1 USDT0/day, ceiling 1,000,000) and funds it"
tx "$OWNER" "$FAC" "createVault(address,uint256,uint256,uint256,uint256,address)" "$USERSAVE" 1000000 1000000 1000000000000 86400 0x0000000000000000000000000000000000000000
VAULT=$(cast call "$FAC" "vaultsOf(address)(address[])" "$OWNER" --rpc-url "$F" | tr -d '[] ' | tr ',' '\n' | tail -n1)
ok "vault $VAULT · owner $(cast call "$VAULT" "owner()(address)" --rpc-url "$F") · switched on $(cast call "$VAULT" "armed()(bool)" --rpc-url "$F")"
mustrevert "savings = the factory" "$OWNER" "$FAC" "createVault(address,uint256,uint256,uint256,uint256,address)" "$FAC" 1000000 1000000 1000000000000 0 0x0000000000000000000000000000000000000000
mustrevert "dust vault (0.5 USDT0 per buy)" "$OWNER" "$FAC" "createVault(address,uint256,uint256,uint256,uint256,address)" "$USERSAVE" 500000 1000000 1000000000000 0 0x0000000000000000000000000000000000000000
ge "$(bal "$USDT" "$OWNER")" 1010000 || fail "owner needs 1.01 USDT0 on mainnet for the rehearsal"
tx "$OWNER" "$USDT" "transfer(address,uint256)" "$VAULT" 1010000

echo "== Attacks"
mustrevert "stranger calls buy" "$STRANGER" "$VAULT" "tick(uint256)" 1000000
mustrevert "bot tries 500 USDT0" "$BOT" "$VAULT" "tick(uint256)" 500000000
mustrevert "bot tries to withdraw" "$BOT" "$VAULT" "withdraw(address,address,uint256)" "$USDT" "$BOT" 1

echo "== The hosted bot buys real OKB on the real pool (copy)"
P=$(cast call --from "$BOT" "$VAULT" "preview(uint256)(uint8,bool)" 1000000 --rpc-url "$F" | tr '\n' ' ')
case "$P" in "126 true"*) ok "preview as hosted bot: 126 (0x7e) allowed";; *) fail "preview is '$P'";; esac
W0=$(bal "$WOKB" "$USERSAVE")
GAS=$(cast estimate --from "$BOT" "$VAULT" "tick(uint256)" 1000000 --rpc-url "$F") || fail "swap simulation failed"
tx "$BOT" "$VAULT" "tick(uint256)" 1000000 --gas-limit "$((GAS * 3 / 2))"
GOT=$(python3 -c "print($(bal "$WOKB" "$USERSAVE") - $W0)"); ge "$GOT" 1 || fail "no OKB arrived"
ok "bought $(python3 -c "print($GOT/1e18)") OKB for 1 USDT0 · gas $GAS · counters: buys=$(cast call "$VAULT" "buys()(uint256)" --rpc-url "$F")"
mustrevert "second buy the same day (DCA spacing)" "$BOT" "$VAULT" "tick(uint256)" 1000000

echo "== Stolen-bot drill: admin revokes the bot for every vault"
tx "$OWNER" "$FAC" "setRevoked(address,bool)" "$BOT" true
cast rpc evm_increaseTime 90000 --rpc-url "$F" >/dev/null; cast rpc evm_mine --rpc-url "$F" >/dev/null
mustrevert "revoked bot tries to buy" "$BOT" "$VAULT" "tick(uint256)" 1000000
tx "$OWNER" "$FAC" "setRevoked(address,bool)" "$BOT" false; ok "un-revoked"

echo "== User exits"
tx "$OWNER" "$VAULT" "setPaused(bool)" true
REST=$(bal "$USDT" "$VAULT"); [ "$REST" = "0" ] || tx "$OWNER" "$VAULT" "withdraw(address,address,uint256)" "$USDT" "$OWNER" "$REST"
[ "$(bal "$USDT" "$VAULT")" = "0" ] || fail "vault not empty"; ok "paused and withdrew everything"

[ -n "${LOCAL_RPC:-}" ] || date -u > .preflight-factory-ok
echo
echo "REHEARSAL OK: factory, create, fund, hosted-bot buy on the real pool, attacks refused, revoke drill, withdraw."
echo "Nothing was sent to mainnet."
