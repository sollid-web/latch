// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test-only helpers for the LatchSwap suite. Never deployed to mainnet.

contract TestERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, uint8 d) {
        name = n;
        symbol = n;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Same TAP-02 semantics as the live X Layer processor (see audit/test/LatchRelay.t.sol.txt).
contract NetlistProcessor {
    mapping(uint256 => bytes) public netlist;
    mapping(uint256 => uint32) public nInOf;
    mapping(uint256 => uint32) public nOutOf;

    function tape(uint256 id, bytes calldata net, uint32 nIn, uint32 nOut) external {
        netlist[id] = net;
        nInOf[id] = nIn;
        nOutOf[id] = nOut;
    }

    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory out) {
        bytes memory net = netlist[id];
        require(net.length > 0 && net.length % 7 == 0, "no circuit");
        uint256 nIn = nInOf[id];
        uint256 nOut = nOutOf[id];
        require(inputs.length == (nIn + 7) / 8, "bad inputs");
        uint256 n = net.length / 7;
        bool[] memory s = new bool[](2 + nIn + n);
        s[1] = true;
        for (uint256 i = 0; i < nIn; i++) {
            s[2 + i] = (uint8(inputs[i >> 3]) >> (i & 7)) & 1 == 1;
        }
        for (uint256 g = 0; g < n; g++) {
            uint256 o = g * 7;
            uint256 a = (uint256(uint8(net[o + 1])) << 16) | (uint256(uint8(net[o + 2])) << 8) | uint8(net[o + 3]);
            uint256 b = (uint256(uint8(net[o + 4])) << 16) | (uint256(uint8(net[o + 5])) << 8) | uint8(net[o + 6]);
            require(a < 2 + nIn + g && b < 2 + nIn + g, "wire");
            s[2 + nIn + g] = !(s[a] && s[b]);
        }
        out = new bytes((nOut + 7) / 8);
        uint256 base = 2 + nIn + n - nOut;
        for (uint256 k = 0; k < nOut; k++) {
            if (s[base + k]) out[k >> 3] |= bytes1(uint8(1 << (k & 7)));
        }
    }
}

interface IPoolLike {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256, uint256);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256, int256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IERC20Like {
    function transferFrom(address, address, uint256) external returns (bool);
}

/// Adds liquidity and moves the price on a real Uniswap V3 pool (test only).
contract PoolDriver {
    function addLiquidity(address pool, int24 lo, int24 hi, uint128 amount) external {
        IPoolLike(pool).mint(address(this), lo, hi, amount, abi.encode(msg.sender));
    }

    /// Market swap by `payer` (who approved this contract): pushes the price.
    function push(address pool, bool zeroForOne, int256 amountIn, uint160 limit) external {
        IPoolLike(pool).swap(msg.sender, zeroForOne, amountIn, limit, abi.encode(msg.sender));
    }

    function uniswapV3MintCallback(uint256 a0, uint256 a1, bytes calldata data) external {
        address payer = abi.decode(data, (address));
        if (a0 > 0) IERC20Like(IPoolLike(msg.sender).token0()).transferFrom(payer, msg.sender, a0);
        if (a1 > 0) IERC20Like(IPoolLike(msg.sender).token1()).transferFrom(payer, msg.sender, a1);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata data) external {
        address payer = abi.decode(data, (address));
        if (d0 > 0) IERC20Like(IPoolLike(msg.sender).token0()).transferFrom(payer, msg.sender, uint256(d0));
        if (d1 > 0) IERC20Like(IPoolLike(msg.sender).token1()).transferFrom(payer, msg.sender, uint256(d1));
    }
}
