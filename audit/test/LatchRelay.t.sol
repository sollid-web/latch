// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The Foundry suite for LatchRelay lives in LatchRelay.t.sol.txt so that the
// project's deploy compiler (which compiles every .sol it can see) never tries
// to resolve forge-std, which is not vendored here.
//
// To run it, work in a scratch copy:
//   mkdir -p ../latch-audit && cp -r contracts audit foundry.toml ../latch-audit/
//   cd ../latch-audit && mv audit/test/LatchRelay.t.sol.txt audit/test/LatchRelay.t.sol
//   forge install foundry-rs/forge-std && forge test -vv
//
// See audit/README.md for the spec, the threat model and the disclosed limits.
