#!/usr/bin/env bash
# Publish the source of Latch's live contracts on Sourcify (free, no account), so anyone can read the exact code
# at each address on explorers. Read-only for your wallet: sends no transaction and costs nothing.
#   ./scripts/verify-sourcify.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
V="forge verify-contract --verifier sourcify --chain 196 --compiler-version 0.8.24 --optimizer-runs 200"
echo "== LatchFactory2 (v2 factory; built with via-IR)"
$V --via-ir 0x4Af276338A81DA70e5dA4108FA0A7F6d294381b8 contracts/LatchFactory2.sol:LatchFactory2 --evm-version cancun \
  --constructor-args "$(cast abi-encode 'c((address,uint256,address,address,address,address,address,address,uint32,uint256,uint256,uint256))' \
  '(0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813,2,0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA,0xe3BE6A0137f1b0602Fc1a4841686f43B340a5082,0x779Ded0c9e1022225f8E0630b35a9b54bE713736,0xe538905cf8410324e03A5A23C1c177a474D59b2b,0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4,0x61A84AF1f9306A7103AA3D33Cc62E045e398dDBd,1800,100,1000000,10000000000000000)')"
IMPL=$(cast call 0x4Af276338A81DA70e5dA4108FA0A7F6d294381b8 "implementation()(address)" --rpc-url https://rpc.xlayer.tech)
echo "== LatchVault template $IMPL"
$V --via-ir "$IMPL" contracts/LatchVault.sol:LatchVault --evm-version cancun
echo
echo "Check: https://repo.sourcify.dev/196/0x4Af276338A81DA70e5dA4108FA0A7F6d294381b8"
