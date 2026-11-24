#!/usr/bin/env bash
# Publish the exact source of every live Latch contract, so OKLink (X Layer's explorer) and Sourcify show
# "verified" and anyone can read the code behind each address. Sends no transaction, costs nothing.
#
#   ./scripts/verify-contracts.sh
#
# OKLink: the X Layer docs (Verifying with Foundry) need only --verifier oklink and the verifier URL. If OKLink
# ever asks for a key, put OKLINK_API_KEY=... in keeper/.env and it is used automatically.
# SKIP_SOURCIFY=1 skips Sourcify (already verified).
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f keeper/.env ]; then set -a; . ./keeper/.env; set +a; fi
RPC="${RPC:-https://rpc.xlayer.tech}"
OKLINK_URL="https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER"
FAC2=0x4Af276338A81DA70e5dA4108FA0A7F6d294381b8
FAC1=0xc700C9865f237612b0bA86408BB4C182D41ABD11
first(){ awk '{print $1}'; }
ok=0; bad=0; results=()

# verify <label> <address> <contract path:name> <constructor-args hex or ""> <extra forge flags...>
verify() {
  local label="$1" addr="$2" target="$3" args="$4"; shift 4
  local common=(--chain 196 --compiler-version 0.8.24 --optimizer-runs 200 --rpc-url "$RPC" "$@")
  [ -n "$args" ] && common+=(--constructor-args "$args")
  for where in sourcify oklink; do
    if [ "$where" = sourcify ] && [ "${SKIP_SOURCIFY:-}" = 1 ]; then continue; fi
    local extra=(--verifier sourcify)
    if [ "$where" = oklink ]; then
      extra=(--verifier oklink --verifier-url "$OKLINK_URL")   # X Layer docs: no key needed
      [ -n "${OKLINK_API_KEY:-}" ] && extra+=(--verifier-api-key "$OKLINK_API_KEY")
    fi
    echo; echo "== $label → $where"
    local out; out=$(forge verify-contract "$addr" "$target" "${common[@]}" "${extra[@]}" --watch 2>&1)
    echo "$out" | tail -n 6
    if echo "$out" | grep -qiE "successfully verified|already verified|Pass - Verified|is already verified|verification successful"; then
      results+=("OK    $label on $where"); ok=$((ok + 1))
    else
      results+=("FAIL  $label on $where"); bad=$((bad + 1))
    fi
  done
}

echo "Reading the deploy settings from the chain…"
PINS2=$(cast abi-encode 'c((address,uint256,address,address,address,address,address,address,uint32,uint256,uint256,uint256))' \
  "($(cast call $FAC2 'processor()(address)' --rpc-url "$RPC"),$(cast call $FAC2 'circuitId()(uint256)' --rpc-url "$RPC" | first),$(cast call $FAC2 'router()(address)' --rpc-url "$RPC"),$(cast call $FAC2 'pool()(address)' --rpc-url "$RPC"),$(cast call $FAC2 'quoteToken()(address)' --rpc-url "$RPC"),$(cast call $FAC2 'baseToken()(address)' --rpc-url "$RPC"),$(cast call $FAC2 'treasury()(address)' --rpc-url "$RPC"),$(cast call $FAC2 'hostedKeeper()(address)' --rpc-url "$RPC"),$(cast call $FAC2 'twapWindow()(uint32)' --rpc-url "$RPC" | first),$(cast call $FAC2 'slippageBps()(uint256)' --rpc-url "$RPC" | first),$(cast call $FAC2 'minBuy()(uint256)' --rpc-url "$RPC" | first),$(cast call $FAC2 'minSell()(uint256)' --rpc-url "$RPC" | first))")
IMPL=$(cast call $FAC2 'implementation()(address)' --rpc-url "$RPC")
ARGS1=$(cast abi-encode 'c(address,uint256,address,address,address,address,address,address,uint32,uint256,uint256)' \
  "$(cast call $FAC1 'processor()(address)' --rpc-url "$RPC")" "$(cast call $FAC1 'circuitId()(uint256)' --rpc-url "$RPC" | first)" \
  "$(cast call $FAC1 'tokenIn()(address)' --rpc-url "$RPC")" "$(cast call $FAC1 'tokenOut()(address)' --rpc-url "$RPC")" \
  "$(cast call $FAC1 'router()(address)' --rpc-url "$RPC")" "$(cast call $FAC1 'pool()(address)' --rpc-url "$RPC")" \
  "$(cast call $FAC1 'treasury()(address)' --rpc-url "$RPC")" "$(cast call $FAC1 'hostedKeeper()(address)' --rpc-url "$RPC")" \
  "$(cast call $FAC1 'twapWindow()(uint32)' --rpc-url "$RPC" | first)" "$(cast call $FAC1 'slippageBps()(uint256)' --rpc-url "$RPC" | first)" \
  "$(cast call $FAC1 'minAmount()(uint256)' --rpc-url "$RPC" | first)")

# v2: built with via-IR, cancun (scripts/golive-v2.sh)
verify "LatchFactory2 $FAC2" "$FAC2" contracts/LatchFactory2.sol:LatchFactory2 "$PINS2" --via-ir --evm-version cancun
verify "LatchVault template $IMPL" "$IMPL" contracts/LatchVault.sol:LatchVault "" --via-ir --evm-version cancun
# v1 classic: built with foundry.toml defaults (no via-IR). Try the EVM versions Foundry has used by default.
for evm in cancun prague shanghai; do
  before=$bad
  verify "LatchFactory (classic) $FAC1 [evm $evm]" "$FAC1" contracts/LatchFactory.sol:LatchFactory "$ARGS1" --evm-version "$evm"
  [ "$bad" = "$before" ] && break
done

echo; echo "================ summary"; printf '%s\n' "${results[@]}"
echo
echo "OKLink:   https://www.oklink.com/xlayer/address/$FAC2#code"
echo "Sourcify: https://repo.sourcify.dev/196/$FAC2"
echo "Vaults are small copies (EIP-1167 clones) of the verified template, so explorers show their code through it."
[ "$bad" = 0 ] || echo "Some attempts failed: paste this whole output to Claude."
