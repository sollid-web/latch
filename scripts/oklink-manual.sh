#!/usr/bin/env bash
# Files for OKLink's manual "Verify and publish" form, for the two v2 contracts (built with via-IR, which the
# automatic OKLink route rejects). Writes into ./oklink-verify/ and prints what to enter in the form.
#   ./scripts/oklink-manual.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-https://rpc.xlayer.tech}"
FAC2=0x4Af276338A81DA70e5dA4108FA0A7F6d294381b8
IMPL=$(cast call $FAC2 'implementation()(address)' --rpc-url "$RPC")
first(){ awk '{print $1}'; }
mkdir -p oklink-verify
COMMON=(--chain 196 --compiler-version 0.8.24 --optimizer-runs 200 --via-ir --evm-version cancun --show-standard-json-input)
forge verify-contract $FAC2 contracts/LatchFactory2.sol:LatchFactory2 "${COMMON[@]}" > oklink-verify/LatchFactory2.json
forge verify-contract "$IMPL" contracts/LatchVault.sol:LatchVault "${COMMON[@]}" > oklink-verify/LatchVault.json
c(){ cast call $FAC2 "$1" --rpc-url "$RPC" | first; }
ARGS=$(cast abi-encode 'c((address,uint256,address,address,address,address,address,address,uint32,uint256,uint256,uint256))' \
  "($(c 'processor()(address)'),$(c 'circuitId()(uint256)'),$(c 'router()(address)'),$(c 'pool()(address)'),$(c 'quoteToken()(address)'),$(c 'baseToken()(address)'),$(c 'treasury()(address)'),$(c 'hostedKeeper()(address)'),$(c 'twapWindow()(uint32)'),$(c 'slippageBps()(uint256)'),$(c 'minBuy()(uint256)'),$(c 'minSell()(uint256)'))")
echo "${ARGS#0x}" > oklink-verify/LatchFactory2.constructor-args.txt
ls -la oklink-verify
cat <<TXT

Files are in $(pwd)/oklink-verify

For EACH contract, on OKLink: open the address → "Contract" tab → "Verify and publish" (or "Verify contract"), then:
  Compiler type ............ Solidity (Standard-Json-Input)
  Compiler version ......... v0.8.24+commit.e11b9ed9
  License .................. GNU GPLv2 or later (GPL-2.0-or-later)
  File ..................... upload the .json below

1) LatchFactory2   https://www.oklink.com/xlayer/address/$FAC2
   file: oklink-verify/LatchFactory2.json     contract name: LatchFactory2
   constructor arguments (paste if asked, no 0x): oklink-verify/LatchFactory2.constructor-args.txt
2) LatchVault template   https://www.oklink.com/xlayer/address/$IMPL
   file: oklink-verify/LatchVault.json        contract name: LatchVault     constructor arguments: none
TXT
