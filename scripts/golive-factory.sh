#!/usr/bin/env bash
# Deploy the LatchFactory on X Layer mainnet, verify every pinned setting, and write the config
# the website and the hosted bot need. Run ./scripts/preflight-factory.sh first (free).
#
#   ./scripts/golive-factory.sh
#
# Reads keeper/.env: OWNER_PRIVATE_KEY (deploys; becomes factory admin, can only revoke bots or
# change the default bot), KEEPER_PRIVATE_KEY (only its address: the hosted helper bot).
# TREASURY (fees) defaults to the owner's wallet 0xb4bD…23a4.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
: "${OWNER_PRIVATE_KEY:?put OWNER_PRIVATE_KEY in keeper/.env}" "${KEEPER_PRIVATE_KEY:?put KEEPER_PRIVATE_KEY in keeper/.env}"
RPC="${RPC:-https://rpc.xlayer.tech}"; CHAIN_ID=196
# Canonical X Layer addresses. Not overridable on purpose.
PROCESSOR=0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813; CIRCUIT_ID=1
USDT=0x779Ded0c9e1022225f8E0630b35a9b54bE713736; WOKB=0xe538905cf8410324e03A5A23C1c177a474D59b2b
ROUTER=0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca; UNI_FACTORY=0x4B2ab38DBF28D31D467aA8993f6c2585981D6804
POOL_EXPECTED=0xe3be6a0137f1b0602fc1a4841686f43b340a5082; POOL_FEE=500
TWAP=1800; SLIPPAGE_BPS=100; MIN_AMOUNT=1000000
TREASURY="${TREASURY:-0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4}"

step(){ printf '\n== %s\n' "$*"; }
fail(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
first(){ awk '{print $1}'; }
lc(){ printf '%s' "$1" | tr A-F a-f; }
OWNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
BOT=$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY")
[ -f .preflight-factory-ok ] || fail "run ./scripts/preflight-factory.sh first; it must end with REHEARSAL OK"

step "Checking chain, Uniswap and TapeOut"
[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || fail "RPC is not X Layer"
[ "$(lc "$(cast call "$ROUTER" "factory()(address)" --rpc-url "$RPC")")" = "$(lc "$UNI_FACTORY")" ] || fail "router.factory() mismatch"
POOL=$(cast call "$UNI_FACTORY" "getPool(address,address,uint24)(address)" "$USDT" "$WOKB" "$POOL_FEE" --rpc-url "$RPC")
[ "$(lc "$POOL")" = "$POOL_EXPECTED" ] || fail "unexpected pool $POOL"
ALLOW=$(cast call "$PROCESSOR" "eval(uint256,bytes)(bytes)" "$CIRCUIT_ID" 0x7e --rpc-url "$RPC"); DENY=$(cast call "$PROCESSOR" "eval(uint256,bytes)(bytes)" "$CIRCUIT_ID" 0x7f --rpc-url "$RPC")
[ $(( 0x${ALLOW:2:2} & 1 )) -eq 1 ] && [ $(( 0x${DENY:2:2} & 1 )) -eq 0 ] || fail "circuit check failed"
[ "$(cast code "$TREASURY" --rpc-url "$RPC")" = "0x" ] || fail "treasury must be a wallet"
[ "$(lc "$BOT")" != "$(lc "$OWNER")" ] || fail "hosted bot key must differ from the owner key"
BOTGAS=$(cast balance "$BOT" --rpc-url "$RPC"); echo "hosted bot $BOT has $(cast from-wei "$BOTGAS") OKB for gas"
printf '\nADMIN (you)   %s  (can only revoke bots / change the default bot)\nTREASURY      %s  (receives the 1%% fees)\nHOSTED BOT    %s\nPool %s (0.05%%) · TWAP %ss · slippage %s bps · min buy 1 USDT0 · circuit #%s\n' \
  "$OWNER" "$TREASURY" "$BOT" "$POOL" "$TWAP" "$SLIPPAGE_BPS" "$CIRCUIT_ID"
if [ -n "${FACTORY:-}" ]; then
  FAC="$FACTORY"; step "Resuming with the already-deployed factory $FAC"
  [ "$(cast code "$FAC" --rpc-url "$RPC")" != "0x" ] || fail "no contract at $FAC"
else
if [ "${YES:-}" != "1" ]; then printf '\nType YES to deploy the factory: '; read -r ans; [ "$ans" = "YES" ] || fail "aborted"; fi

step "Deploying LatchFactory"
OUT=$(forge create contracts/LatchFactory.sol:LatchFactory --rpc-url "$RPC" --chain "$CHAIN_ID" --private-key "$OWNER_PRIVATE_KEY" --broadcast \
  --constructor-args "$PROCESSOR" "$CIRCUIT_ID" "$USDT" "$WOKB" "$ROUTER" "$POOL" "$TREASURY" "$BOT" "$TWAP" "$SLIPPAGE_BPS" "$MIN_AMOUNT")
echo "$OUT"; FAC=$(echo "$OUT" | awk '/Deployed to/{print $3}'); [ -n "$FAC" ] || fail "deploy failed"
fi

step "Verifying"
check(){ local got; got=$(cast call "$FAC" "$1" --rpc-url "$RPC" | first); echo "$1 = $got"; [ "$(lc "$got")" = "$(lc "$2")" ] || fail "$1 is $got, expected $2"; }
check "admin()(address)" "$OWNER"; check "hostedKeeper()(address)" "$BOT"; check "treasury()(address)" "$TREASURY"
check "processor()(address)" "$PROCESSOR"; check "circuitId()(uint256)" "$CIRCUIT_ID"
check "tokenIn()(address)" "$USDT"; check "tokenOut()(address)" "$WOKB"; check "router()(address)" "$ROUTER"; check "pool()(address)" "$POOL"
check "twapWindow()(uint32)" "$TWAP"; check "slippageBps()(uint256)" "$SLIPPAGE_BPS"; check "minAmount()(uint256)" "$MIN_AMOUNT"
# A vault creation must succeed against the live pool (simulated, nothing sent). The savings
# address must not be the treasury (the factory refuses that), so use a neutral test address.
cast call "$FAC" "createVault(address,uint256,uint256,uint256,uint256,address)(address)" 0x00000000000000000000000000000000CafE0001 1000000 3000000 48000000 0 0x0000000000000000000000000000000000000000 --from "$OWNER" --rpc-url "$RPC" >/dev/null \
  || fail "simulated createVault fails on mainnet — send this to Claude"
echo "simulated createVault: OK"

step "Writing config for the website and the hosted bot"
python3 - "$FAC" "$POOL" <<'PY'
import json, sys, datetime, re
fac, pool = sys.argv[1], sys.argv[2]
web = {"chainId": 196, "rpc": ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"], "explorer": "https://www.oklink.com/xlayer",
       "factory": fac, "usdt": "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", "wokb": "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
       "pool": pool, "processor": "0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813", "circuitId": 1, "repo": "https://github.com/sollid-web/latch"}
json.dump(web, open('deployments/web-config.json', 'w'), indent=2)
json.dump({"LatchFactory": fac, "pool": pool, "chainId": 196, "deployedAt": datetime.datetime.utcnow().isoformat() + "Z"}, open('deployments/xlayer-latch.json', 'w'), indent=2)
w = open('keeper-worker/wrangler.jsonc').read()
w = re.sub(r'"FACTORY_ADDRESS": "[^"]*"', f'"FACTORY_ADDRESS": "{fac}"', w)
open('keeper-worker/wrangler.jsonc', 'w').write(w)
print('wrote deployments/web-config.json, deployments/xlayer-latch.json, keeper-worker/wrangler.jsonc')
PY

cat <<EOF

Done. LatchFactory: $FAC
Next (with Claude):
  1. Website:     npm install && npm run deploy
  2. Hosted bot:  cd keeper-worker && npm install && npx wrangler deploy
  3. Commit:      git add deployments keeper-worker/wrangler.jsonc && git commit -m "Factory live" && git push
  4. Open the site, create your vault, add a few USDT0.
EOF
