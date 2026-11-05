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

interface IBiPoolManager {
    struct Exchange {
        bytes32 exchangeId;
        address[] assets;
    }

    function getExchanges() external view returns (Exchange[] memory);
}

interface IBroker {
    function getAmountOut(address provider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256);
    function swapIn(address provider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin)
        external
        returns (uint256);
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
    address constant MENTO_BROKER = 0x777A8255cA72412f0d706dc03C9D1987306B4CaD;
    address constant BIPOOL_MANAGER = 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901;
    address constant KESM = 0x456a3D042C0DbD3db53D5489e98dFb038553B0d0;
    // Mento v3 FPMM pools (MENTO.fpmmPools, verified on-chain). An FPMM pays out of its own reserves, so a quote can
    // succeed while the swap reverts InsufficientLiquidity() once one side is drained; tests pick a direction the
    // pool can actually fill, exactly as the adapter now caps its curve by the pool's balance.
    address constant FPMM_USDC_USDM = 0x462fe04b4FD719Cbd04C0310365D421D02AaA19E;
    address constant FPMM_USDT_USDM = 0x0FEBa760d93423D127DE1B6ABECdB60E5253228D;

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
        ex.setTarget(MENTO_BROKER, true);
        ex.setSpender(MENTO_BROKER, true);
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

    function _logReserves() internal view {
        console2.log("FPMM USDC/USDm holds USDm", IERC20Min(USDM).balanceOf(FPMM_USDC_USDM) / 1e18, "USDC", IERC20Min(USDC).balanceOf(FPMM_USDC_USDM) / 1e6);
        console2.log("FPMM USDT/USDm holds USDm", IERC20Min(USDM).balanceOf(FPMM_USDT_USDM) / 1e18, "USDT", IERC20Min(USDT).balanceOf(FPMM_USDT_USDM) / 1e6);
    }

    /// A $1-stable the given FPMM can sell `amt` USDm for, or address(0).
    function _usdmSource(uint256 amt) internal view returns (address stable) {
        if (IERC20Min(USDM).balanceOf(FPMM_USDC_USDM) > amt * 11 / 10) return USDC;
        if (IERC20Min(USDM).balanceOf(FPMM_USDT_USDM) > amt * 11 / 10) return USDT;
    }

    function _approve(address token, uint256 amt) internal {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(ex), amt));
        require(ok, "approve");
    }

    function test_fork_mentoQuoteMatchesExecution() public {
        if (!forked) return;
        _logReserves();
        // Whichever direction of USDC/USDm the pool can fill right now.
        bool buyUsdm = IERC20Min(USDM).balanceOf(FPMM_USDC_USDM) > 110e18;
        (address tin, address tout, uint256 amt) = buyUsdm ? (USDC, USDM, uint256(100e6)) : (USDM, USDC, uint256(100e18));
        assertTrue(buyUsdm || IERC20Min(USDC).balanceOf(FPMM_USDC_USDM) > 110e6, "USDC/USDm FPMM cannot fill $100 either way");
        IMentoRouter.Route[] memory r = new IMentoRouter.Route[](1);
        r[0] = IMentoRouter.Route(tin, tout, address(0));
        uint256[] memory q = IMentoRouter(MENTO_ROUTER).getAmountsOut(amt, r);
        deal(tin, user, amt);
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _mentoStep(tin, tout, amt);
        vm.startPrank(user);
        _approve(tin, amt);
        uint256 out = ex.execute(bytes32("fork2"), s, tin, amt, tout, 0, user, block.timestamp + 60, 0, address(0));
        vm.stopPrank();
        console2.log(buyUsdm ? "USDC->USDm mento quoted" : "USDm->USDC mento quoted", q[q.length - 1], "executed", out);
        assertEq(out, q[q.length - 1], "quote must equal execution in the same block");
    }

    function test_fork_crossVenueTwoHopAtomic() public {
        if (!forked) return;
        uint24 fee = _deepestUniFee(USDT, USDC);
        bool buyUsdm = IERC20Min(USDM).balanceOf(FPMM_USDC_USDM) > 110e18;
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](2);
        uint256 out;
        vm.startPrank(user);
        if (buyUsdm) {
            // USDT -(Uniswap)-> USDC -(Mento)-> USDm, second amount patched with the USDC actually received.
            deal(USDT, user, 100e6);
            s[0] = _uniStep(USDT, USDC, fee, 100e6);
            s[1] = _mentoStep(USDC, USDM, 0);
            _approve(USDT, 100e6);
            out = ex.execute(bytes32("fork3"), s, USDT, 100e6, USDM, 97e18, user, block.timestamp + 60, 10, address(0xFEE));
            assertGt(IERC20Min(USDM).balanceOf(address(0xFEE)), 0, "fee collected");
        } else {
            // The pool is short of USDm: the same two venues the other way, USDm -(Mento)-> USDC -(Uniswap)-> USDT.
            deal(USDM, user, 100e18);
            s[0] = _mentoStep(USDM, USDC, 100e18);
            s[1] = _uniStep(USDC, USDT, fee, 0);
            _approve(USDM, 100e18);
            out = ex.execute(bytes32("fork3"), s, USDM, 100e18, USDT, 97e6, user, block.timestamp + 60, 10, address(0xFEE));
            assertGt(IERC20Min(USDT).balanceOf(address(0xFEE)), 0, "fee collected");
        }
        vm.stopPrank();
        console2.log(buyUsdm ? "USDT->USDC->USDm out" : "USDm->USDC->USDT out", out);
        assertEq(IERC20Min(USDC).balanceOf(address(ex)), 0, "no intermediate left behind");
    }

    function test_fork_slippageGuardRevertsWholeRoute() public {
        if (!forked) return;
        uint24 fee = _deepestUniFee(USDT, USDC);
        deal(USDT, user, 100e6);
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](2);
        // USDT -> USDC (Uniswap) -> USDT (Uniswap again, other leg) can never return 101 USDT for 100.
        s[0] = _uniStep(USDT, USDC, fee, 100e6);
        s[1] = _uniStep(USDC, USDT, fee, 0);
        vm.startPrank(user);
        _approve(USDT, 100e6);
        vm.expectRevert();
        ex.execute(bytes32("fork4"), s, USDT, 100e6, USDT, 101e6, user, block.timestamp + 60, 0, address(0));
        vm.stopPrank();
        assertEq(IERC20Min(USDT).balanceOf(user), 100e6, "first leg rolled back");
    }

    function _exchangeId(address a, address b) internal view returns (bytes32) {
        IBiPoolManager.Exchange[] memory xs = IBiPoolManager(BIPOOL_MANAGER).getExchanges();
        for (uint256 i; i < xs.length; i++) {
            if (xs[i].assets.length != 2) continue;
            if ((xs[i].assets[0] == a && xs[i].assets[1] == b) || (xs[i].assets[0] == b && xs[i].assets[1] == a)) return xs[i].exchangeId;
        }
        return bytes32(0);
    }

    /// Two-hop route through both Mento generations: USDC -> USDm (v3 Router) -> KESm (v2 Broker), amount patched.
    function test_fork_mentoV3ThenV2BrokerAtomic() public {
        if (!forked) return;
        bytes32 xid = _exchangeId(USDM, KESM);
        assertTrue(xid != bytes32(0), "no USDm/KESm exchange");
        // First hop from whichever FPMM still holds USDm (both USDC and USDT have 6 decimals on Celo).
        address src = _usdmSource(50e18);
        if (src == address(0)) {
            _logReserves();
            console2.log("SKIPPED: neither FPMM holds 55 USDm right now");
            return;
        }
        deal(src, user, 50e6);
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](2);
        s[0] = _mentoStep(src, USDM, 50e6);
        s[1] = FisikaExecutor.Step({
            target: MENTO_BROKER,
            spender: MENTO_BROKER,
            tokenIn: USDM,
            amountIn: 0,
            amountOffset: 132, // selector + provider, exchangeId, tokenIn, tokenOut
            data: abi.encodeCall(IBroker.swapIn, (BIPOOL_MANAGER, xid, USDM, KESM, 0, 0))
        });
        vm.startPrank(user);
        _approve(src, 50e6);
        uint256 out = ex.execute(bytes32("fork5"), s, src, 50e6, KESM, 1, user, block.timestamp + 60, 0, address(0));
        vm.stopPrank();
        console2.log("USDC->USDm->KESm out", out);
        assertGt(out, 50e18 * 100, "expected > 100 KESm per USD");
        assertEq(IERC20Min(USDM).balanceOf(address(ex)), 0);
    }
}
