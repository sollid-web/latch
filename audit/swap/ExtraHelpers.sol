// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {UniMath} from "./UniMath.sol";

/// Test-only. Exposes the 0.8 port for differential fuzzing against the 0.7.6 originals.
contract PortMath {
    function sqrtAt(int24 t) external pure returns (uint160) {
        return UniMath.getSqrtRatioAtTick(t);
    }

    function sqrtBatch(int24[] calldata ts) external pure returns (uint160[] memory r) {
        r = new uint160[](ts.length);
        for (uint256 i = 0; i < ts.length; i++) r[i] = UniMath.getSqrtRatioAtTick(ts[i]);
    }

    function quoteBatch(int24[] calldata ts, uint128[] calldata bs, address x, address y)
        external
        pure
        returns (uint256[] memory r)
    {
        r = new uint256[](ts.length);
        for (uint256 i = 0; i < ts.length; i++) r[i] = UniMath.getQuoteAtTick(ts[i], bs[i], x, y);
    }

    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return UniMath.mulDiv(a, b, d);
    }
}

interface IQuoteVault {
    function quote(uint256) external view returns (uint256, uint256, uint256);
}

interface IRef {
    function consultQuote(address, uint32, uint128, address, address) external view returns (int24, uint256);
}

/// Reads vault.quote and the 0.7.6 reference in ONE call (same block, same timestamp).
contract Probe {
    function both(address vault, address ref, address pool, uint32 w, uint128 amount, address tin, address tout, uint128 outUnit)
        external
        view
        returns (uint256 vPrice, uint256 vOut, int24 refTick, uint256 rPrice, uint256 rOut)
    {
        (vPrice, vOut,) = IQuoteVault(vault).quote(amount);
        (refTick, rPrice) = IRef(ref).consultQuote(pool, w, outUnit, tout, tin);
        (, rOut) = IRef(ref).consultQuote(pool, w, amount, tin, tout);
    }
}

/// A fake "router + factory + pool" triple: shows the constructor's canonical-pool check is
/// only as good as the router address the deployer types in.
contract FakeFactory {
    address public p;
    constructor(address p_) { p = p_; }
    function getPool(address, address, uint24) external view returns (address) { return p; }
}

contract FakeRouter {
    address public factory;
    function setFactory(address f) external { factory = f; }
}

contract FakePool {
    address public token0;
    address public token1;
    uint24 public fee = 3000;
    constructor(address a, address b) { token0 = a; token1 = b; }
}
