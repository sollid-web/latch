#!/usr/bin/env bash
# Latch v2 on X Layer MAINNET: tape out strategy circuit #2, check it on all 65,536 inputs, deploy LatchFactory2.
# Run ./scripts/preflight-v2.sh first (free). Every spend asks you to type YES first.
#
#   ./scripts/golive-v2.sh                 (re-run the same command to resume; FACTORY2=0x… resumes after the deploy)
#
# Costs: one NAND mint (0.01 BEM), tapeout 0.0013 OKB, gas (well under 0.005 OKB at X Layer prices).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
: "${OWNER_PRIVATE_KEY:?put OWNER_PRIVATE_KEY in keeper/.env}" "${KEEPER_PRIVATE_KEY:?put KEEPER_PRIVATE_KEY in keeper/.env}"
RPC="${RPC:-https://rpc.xlayer.tech}"; CHAIN_ID=196
. ./scripts/v2-addresses.sh
step(){ printf '\n== %s\n' "$*"; }
fail(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
first(){ awk '{print $1}'; }
lc(){ printf '%s' "$1" | tr A-F a-f; }
yes_or_stop(){ if [ "${YES:-}" != "1" ]; then printf '\n%s\nType YES to continue: ' "$1"; read -r ans; [ "$ans" = "YES" ] || fail "stopped by you; nothing more was sent"; fi; }
OWNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
BOT=$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY")
[ -f .preflight-v2-ok ] || fail "run ./scripts/preflight-v2.sh first; it must end with REHEARSAL OK"

step "Checking chain, Uniswap and TapeOut"
[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || fail "RPC is not X Layer"
[ "$(lc "$(cast call "$ROUTER" "factory()(address)" --rpc-url "$RPC")")" = "$(lc "$UNI_FACTORY")" ] || fail "router.factory() mismatch"
POOL=$(cast call "$UNI_FACTORY" "getPool(address,address,uint24)(address)" "$USDT" "$WOKB" "$POOL_FEE" --rpc-url "$RPC")
[ "$(lc "$POOL")" = "$POOL_EXPECTED" ] || fail "unexpected pool $POOL"
[ "$(cast code "$TREASURY" --rpc-url "$RPC")" = "0x" ] || fail "treasury must be a wallet"
[ "$(lc "$BOT")" != "$(lc "$OWNER")" ] || fail "hosted bot key must differ from the owner key"
echo "owner $OWNER · hosted bot $BOT · treasury $TREASURY · pool $POOL"

step "1. Tape out circuit #2 (dry run first)"
( cd keeper && [ -d node_modules ] || npm install --silent ) >/dev/null
if [ ! -f keeper/tapeout2-state.json ] || ! grep -q circuitId keeper/tapeout2-state.json; then
  DRY=$(cd keeper && node tapeout2.mjs 2>&1) || { echo "$DRY"; fail "dry run failed — send this output to Claude"; }
  echo "$DRY"
  echo "$DRY" | grep -q "already on chain" || yes_or_stop "This mints the NAND gates (0.01 BEM) and tapes out circuit #2 (0.0013 OKB) on mainnet."
fi
TOUT=$(cd keeper && SEND=1 node tapeout2.mjs 2>&1) || { echo "$TOUT"; fail "tapeout stopped — run the same command again to resume, or send this to Claude"; }
echo "$TOUT"
CID=$(echo "$TOUT" | awk -F= '/^CIRCUIT2_ID=/{print $2}'); [ -n "$CID" ] || fail "no circuit id"

step "2. Asking mainnet about all 65,536 inputs of circuit #$CID (read-only, a few minutes)"
if [ "$(cat .circuit2-verified 2>/dev/null)" = "$CID" ]; then echo "already checked on mainnet earlier: CIRCUIT OK"; else
  node scripts/verify-circuit2.mjs "$RPC" "$PROCESSOR" "$CID" || fail "circuit #$CID does not match the rules on mainnet (or the RPC gave up) — do NOT deploy; send this to Claude"
  echo "$CID" > .circuit2-verified
fi

if [ -n "${FACTORY2:-}" ]; then
  FAC="$FACTORY2"; step "Resuming with the already-deployed factory $FAC"
  [ "$(cast code "$FAC" --rpc-url "$RPC")" != "0x" ] || fail "no contract at $FAC"
else
  yes_or_stop "Next: deploy LatchFactory2 (circuit #$CID, min Buy 1 USDT0, min Take Profit 0.01 OKB). Gas only."
  step "3. Deploying LatchFactory2"
  PINS="($PROCESSOR,$CID,$ROUTER,$POOL,$USDT,$WOKB,$TREASURY,$BOT,$TWAP,$SLIPPAGE_BPS,$MIN_BUY,$MIN_SELL)"
  OUT=$(forge create contracts/LatchFactory2.sol:LatchFactory2 --optimize --optimizer-runs 200 --evm-version cancun \
    --rpc-url "$RPC" --chain "$CHAIN_ID" --private-key "$OWNER_PRIVATE_KEY" --broadcast --constructor-args "$PINS" 2>&1) || { echo "$OUT"; fail "deploy failed"; }
  echo "$OUT" | grep -E "Deployed to|Transaction hash"
  FAC=$(echo "$OUT" | awk '/Deployed to/{print $3}'); [ -n "$FAC" ] || fail "deploy failed"
fi

step "4. Verifying every pinned setting"
check(){ local got; got=$(cast call "$FAC" "$1" --rpc-url "$RPC" | first); echo "$1 = $got"; [ "$(lc "$got")" = "$(lc "$2")" ] || fail "$1 is $got, expected $2"; }
check "admin()(address)" "$OWNER"; check "hostedKeeper()(address)" "$BOT"; check "treasury()(address)" "$TREASURY"
check "processor()(address)" "$PROCESSOR"; check "circuitId()(uint256)" "$CID"; check "router()(address)" "$ROUTER"; check "pool()(address)" "$POOL"
check "quoteToken()(address)" "$USDT"; check "baseToken()(address)" "$WOKB"; check "twapWindow()(uint32)" "$TWAP"
check "slippageBps()(uint256)" "$SLIPPAGE_BPS"; check "minBuy()(uint256)" "$MIN_BUY"; check "minSell()(uint256)" "$MIN_SELL"
CV="createVault(uint8,uint8,address,uint256,uint256,uint256,uint256,uint256,uint256,address)(address)"
cast call "$FAC" "$CV" 0 2 0x00000000000000000000000000000000CafE0001 1000000 3000000 6000000 100000000 120000000 86400 0x0000000000000000000000000000000000000000 --from "$OWNER" --rpc-url "$RPC" >/dev/null || fail "simulated Buy vault fails"
cast call "$FAC" "$CV" 1 2 0x00000000000000000000000000000000CafE0001 10000000000000000 30000000000000000 100000000000000000 70000000 75000000 0 0x0000000000000000000000000000000000000000 --from "$OWNER" --rpc-url "$RPC" >/dev/null || fail "simulated Take Profit vault fails"
echo "simulated Buy vault and Take Profit vault: OK"

step "5. Writing config"
python3 - "$FAC" "$CID" <<'PY'
import json, sys, datetime
fac, cid = sys.argv[1], int(sys.argv[2])
p = 'deployments/web-config.json'; web = json.load(open(p)); web.update({"factory2": fac, "circuit2Id": cid}); json.dump(web, open(p, 'w'), indent=2)
p = 'deployments/xlayer-latch.json'; d = json.load(open(p)); d.update({"LatchFactory2": fac, "circuit2Id": cid, "v2DeployedAt": datetime.datetime.utcnow().isoformat() + "Z"}); json.dump(d, open(p, 'w'), indent=2)
print('wrote deployments/web-config.json and deployments/xlayer-latch.json')
PY
cat <<EOF

Done. Circuit #$CID on $PROCESSOR · LatchFactory2 $FAC
Next: git add deployments && git commit -m "v2 live" && git push   — then tell Claude, who updates the bot and the site.
EOF
