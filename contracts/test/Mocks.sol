// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockERC20 {
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory s, uint8 d) {
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external virtual returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external virtual returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external virtual returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// @dev USDT-style: no return values, and approve(nonzero -> nonzero) reverts.
contract MockUSDT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external {
        require(a == 0 || allowance[msg.sender][s] == 0, "USDT: approve race");
        allowance[msg.sender][s] = a;
    }

    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }

    function transferFrom(address f, address to, uint256 a) external {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
    }
}

interface IERC20Like {
    function transferFrom(address, address, uint256) external;
    function transfer(address, uint256) external;
}

/// @dev Fixed-rate venue. amountIn is the 3rd argument, i.e. byte offset 4 + 32*2 = 68 in calldata.
contract MockRouter {
    uint256 public num;
    uint256 public den;
    bool public pullOnlyHalf;

    constructor(uint256 num_, uint256 den_) {
        num = num_;
        den = den_;
    }

    function setPullOnlyHalf(bool v) external {
        pullOnlyHalf = v;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out) {
        uint256 pulled = pullOnlyHalf ? amountIn / 2 : amountIn;
        // low-level so it works for both bool-returning and USDT-style tokens
        (bool ok,) = tokenIn.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), pulled));
        require(ok, "pull failed");
        out = (pulled * num) / den;
        require(out >= minOut, "router: slippage");
        (ok,) = tokenOut.call(abi.encodeWithSignature("transfer(address,uint256)", to, out));
        require(ok, "pay failed");
    }
}

interface IExecutorLike {
    function pause() external;
}

/// @dev Token whose transferFrom tries to re-enter the executor.
contract ReentrantToken is MockERC20 {
    address public target;
    bytes public payload;
    bool public reentered;
    bytes public reentryRevert;

    constructor() MockERC20("RE", 18) {}

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function transferFrom(address f, address to, uint256 a) external override returns (bool) {
        if (target != address(0) && !reentered) {
            reentered = true;
            (bool ok, bytes memory ret) = target.call(payload);
            require(!ok, "reentry unexpectedly succeeded");
            reentryRevert = ret;
        }
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}
