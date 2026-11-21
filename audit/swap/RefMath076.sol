// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

// Reference: the ORIGINAL Uniswap libraries compiled with solc 0.7.6 (test only).
import '@uniswap/v3-core/contracts/libraries/TickMath.sol';
import '@uniswap/v3-core/contracts/libraries/FullMath.sol';
import '@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol';

interface IObs {
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
}

contract RefMath076 {
    function sqrtAt(int24 t) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(t);
    }

    function sqrtBatch(int24[] calldata ts) external pure returns (uint160[] memory r) {
        r = new uint160[](ts.length);
        for (uint256 i = 0; i < ts.length; i++) r[i] = TickMath.getSqrtRatioAtTick(ts[i]);
    }

    function quoteBatch(int24[] calldata ts, uint128[] calldata bs, address x, address y)
        external
        pure
        returns (uint256[] memory r)
    {
        r = new uint256[](ts.length);
        for (uint256 i = 0; i < ts.length; i++) r[i] = OracleLibrary.getQuoteAtTick(ts[i], bs[i], x, y);
    }

    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return FullMath.mulDiv(a, b, d);
    }

    /// The tick half of OracleLibrary.consult, verbatim (the liquidity half divides by
    /// secondsPerLiquidity and is not used by LatchSwap).
    function meanTick(address pool, uint32 secondsAgo) public view returns (int24 arithmeticMeanTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives, ) = IObs(pool).observe(secondsAgos);
        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
        arithmeticMeanTick = int24(tickCumulativesDelta / secondsAgo);
        if (tickCumulativesDelta < 0 && (tickCumulativesDelta % secondsAgo != 0)) arithmeticMeanTick--;
    }

    function consultQuote(address pool, uint32 w, uint128 base, address bt, address qt)
        external
        view
        returns (int24 t, uint256 q)
    {
        t = meanTick(pool, w);
        q = OracleLibrary.getQuoteAtTick(t, base, bt, qt);
    }
}
