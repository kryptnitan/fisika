// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {FisikaExecutor, IERC20Min} from "../src/FisikaExecutor.sol";

interface IUniV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface IMentoRouter {
    struct Route {
        address from;
        address to;
        address factory;
    }

    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, address to, uint256 deadline)
        external
        returns (uint256[] memory);
}

/// @notice Runs against a Celo mainnet fork. Skipped unless CELO_RPC_URL is set.
contract FisikaExecutorForkTest is Test {
    // Celo mainnet (42220) — sources in packages/core/src/addresses.ts, verified by scripts/verify-onchain.ts
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address constant USDM = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant UNI_FACTORY = 0xAfE208a311B21f13EF87E33A90049fC17A7acDEc;
    address constant SWAP_ROUTER_02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    address constant MENTO_ROUTER = 0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6;

    uint16 constant NP = type(uint16).max;
    // SwapRouter02.exactInputSingle: selector(4) + tokenIn, tokenOut, fee, recipient (4 words) -> amountIn at 132
    uint16 constant UNI_AMOUNT_OFFSET = 132;
    // Mento Router.swapExactTokensForTokens: amountIn is the first argument -> offset 4
    uint16 constant MENTO_AMOUNT_OFFSET = 4;

    FisikaExecutor ex;
    address user = address(0xBEEF);
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("CELO_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        ex = new FisikaExecutor(address(this), address(this));
        ex.setTarget(SWAP_ROUTER_02, true);
        ex.setSpender(SWAP_ROUTER_02, true);
        ex.setTarget(MENTO_ROUTER, true);
        ex.setSpender(MENTO_ROUTER, true);
    }

    function _deepestUniFee(address a, address b) internal view returns (uint24 best) {
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        uint256 bestBal;
        for (uint256 i; i < 4; i++) {
            address pool = IUniV3Factory(UNI_FACTORY).getPool(a, b, fees[i]);
            if (pool == address(0)) continue;
            uint256 bal = IERC20Min(b).balanceOf(pool);
            if (bal > bestBal) {
                bestBal = bal;
                best = fees[i];
            }
        }
    }

    function _uniStep(address tin, address tout, uint24 fee, uint256 amt) internal view returns (FisikaExecutor.Step memory) {
        return FisikaExecutor.Step({
            target: SWAP_ROUTER_02,
            spender: SWAP_ROUTER_02,
            tokenIn: tin,
            amountIn: amt,
            amountOffset: amt == 0 ? UNI_AMOUNT_OFFSET : NP,
            data: abi.encodeCall(
                ISwapRouter02.exactInputSingle,
                (ISwapRouter02.ExactInputSingleParams(tin, tout, fee, address(ex), amt, 0, 0))
            )
        });
    }

    function _mentoStep(address tin, address tout, uint256 amt) internal view returns (FisikaExecutor.Step memory) {
        IMentoRouter.Route[] memory r = new IMentoRouter.Route[](1);
        r[0] = IMentoRouter.Route(tin, tout, address(0));
        return FisikaExecutor.Step({
            target: MENTO_ROUTER,
            spender: MENTO_ROUTER,
            tokenIn: tin,
            amountIn: amt,
            amountOffset: amt == 0 ? MENTO_AMOUNT_OFFSET : NP,
            data: abi.encodeCall(IMentoRouter.swapExactTokensForTokens, (amt, 0, r, address(ex), block.timestamp + 60))
        });
    }

    function test_fork_uniswapSingleLeg() public {
        if (!forked) return;
        uint24 fee = _deepestUniFee(USDT, USDC);
        assertGt(fee, 0, "no USDT/USDC pool");
        deal(USDT, user, 100e6);
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _uniStep(USDT, USDC, fee, 100e6);
        vm.startPrank(user);
        (bool ok,) = USDT.call(abi.encodeWithSignature("approve(address,uint256)", address(ex), 100e6));
        require(ok);
        uint256 out = ex.execute(bytes32("fork1"), s, USDT, 100e6, USDC, 98e6, user, block.timestamp + 60, 0, address(0));
        vm.stopPrank();
        console2.log("USDT->USDC uni fee", fee, "out", out);
        assertEq(IERC20Min(USDC).balanceOf(address(ex)), 0);
        assertEq(IERC20Min(USDT).balanceOf(address(ex)), 0);
    }

    function test_fork_mentoQuoteMatchesExecution() public {
        if (!forked) return;
        IMentoRouter.Route[] memory r = new IMentoRouter.Route[](1);
        r[0] = IMentoRouter.Route(USDC, USDM, address(0));
        uint256[] memory q = IMentoRouter(MENTO_ROUTER).getAmountsOut(100e6, r);
        deal(USDC, user, 100e6);
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _mentoStep(USDC, USDM, 100e6);
        vm.startPrank(user);
        IERC20Min(USDC).approve(address(ex), 100e6);
        uint256 out = ex.execute(bytes32("fork2"), s, USDC, 100e6, USDM, 0, user, block.timestamp + 60, 0, address(0));
        vm.stopPrank();
        console2.log("USDC->USDm mento quoted", q[q.length - 1], "executed", out);
        assertEq(out, q[q.length - 1], "quote must equal execution in the same block");
    }

    function test_fork_crossVenueTwoHopAtomic() public {
        if (!forked) return;
        uint24 fee = _deepestUniFee(USDT, USDC);
        deal(USDT, user, 100e6);
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](2);
        s[0] = _uniStep(USDT, USDC, fee, 100e6);
        s[1] = _mentoStep(USDC, USDM, 0); // amount patched with the USDC actually received
        vm.startPrank(user);
        (bool ok,) = USDT.call(abi.encodeWithSignature("approve(address,uint256)", address(ex), 100e6));
        require(ok);
        uint256 out = ex.execute(bytes32("fork3"), s, USDT, 100e6, USDM, 97e18, user, block.timestamp + 60, 10, address(0xFEE));
        vm.stopPrank();
        console2.log("USDT->USDC->USDm out", out);
        assertGt(IERC20Min(USDM).balanceOf(address(0xFEE)), 0, "fee collected");
        assertEq(IERC20Min(USDC).balanceOf(address(ex)), 0, "no intermediate left behind");
    }

    function test_fork_slippageGuardRevertsWholeRoute() public {
        if (!forked) return;
        uint24 fee = _deepestUniFee(USDT, USDC);
        deal(USDT, user, 100e6);
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](2);
        s[0] = _uniStep(USDT, USDC, fee, 100e6);
        s[1] = _mentoStep(USDC, USDM, 0);
        vm.startPrank(user);
        (bool ok,) = USDT.call(abi.encodeWithSignature("approve(address,uint256)", address(ex), 100e6));
        require(ok);
        vm.expectRevert();
        ex.execute(bytes32("fork4"), s, USDT, 100e6, USDM, 101e18, user, block.timestamp + 60, 0, address(0));
        vm.stopPrank();
        assertEq(IERC20Min(USDT).balanceOf(user), 100e6, "first leg rolled back");
    }
}
