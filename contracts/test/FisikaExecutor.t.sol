// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FisikaExecutor} from "../src/FisikaExecutor.sol";
import {MockERC20, MockUSDT, MockRouter, ReentrantToken} from "./Mocks.sol";

contract FisikaExecutorTest is Test {
    FisikaExecutor ex;
    MockERC20 usdc;
    MockERC20 usdm;
    MockUSDT usdt;
    MockRouter r1; // USDT -> USDC at 0.999
    MockRouter r2; // USDC -> USDm at 1.001 (scaled 6 -> 18 decimals)
    MockRouter r3; // USDm -> USDT at 1.002 (18 -> 6)

    address owner = address(0xA11CE);
    address guardian = address(0x6A4D);
    address user = address(0xBEEF);
    address feeTo = address(0xFEE);

    uint16 constant NP = type(uint16).max;

    function setUp() public {
        ex = new FisikaExecutor(owner, guardian);
        usdt = new MockUSDT();
        usdc = new MockERC20("USDC", 6);
        usdm = new MockERC20("USDm", 18);
        r1 = new MockRouter(999, 1000);
        r2 = new MockRouter(1001e12, 1000);
        r3 = new MockRouter(1002, 1000e12);
        usdc.mint(address(r1), 1e12);
        usdm.mint(address(r2), 1e30);
        usdt.mint(address(r3), 1e12);
        vm.startPrank(owner);
        for (uint256 i; i < 3; i++) {
            address r = address([r1, r2, r3][i]);
            ex.setTarget(r, true);
            ex.setSpender(r, true);
        }
        vm.stopPrank();
        usdt.mint(user, 1_000_000e6);
    }

    function _step(MockRouter r, address tin, address tout, uint256 amt) internal view returns (FisikaExecutor.Step memory) {
        return FisikaExecutor.Step({
            target: address(r),
            spender: address(r),
            tokenIn: tin,
            amountIn: amt,
            amountOffset: amt == 0 ? 68 : NP,
            data: abi.encodeCall(MockRouter.swap, (tin, tout, amt, 0, address(ex)))
        });
    }

    function _exec(FisikaExecutor.Step[] memory s, address tin, uint256 amt, address tout, uint256 minOut, uint16 fee)
        internal
        returns (uint256)
    {
        vm.startPrank(user);
        usdt.approve(address(ex), 0);
        usdt.approve(address(ex), amt);
        uint256 out = ex.execute(bytes32("r"), s, tin, amt, tout, minOut, user, block.timestamp, fee, feeTo);
        vm.stopPrank();
        return out;
    }

    function test_singleLeg() public {
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _step(r1, address(usdt), address(usdc), 1000e6);
        uint256 out = _exec(s, address(usdt), 1000e6, address(usdc), 999e6, 0);
        assertEq(out, 999e6);
        assertEq(usdc.balanceOf(user), 999e6);
        assertEq(usdt.allowance(address(ex), address(r1)), 0, "allowance reset");
        assertEq(usdc.balanceOf(address(ex)), 0, "executor holds nothing");
    }

    function test_multiHopWithDynamicAmountsAndArbCycle() public {
        // USDT -> USDC -> USDm -> USDT: 0.999 * 1.001 * 1.002 = 1.002 (profitable cycle)
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](3);
        s[0] = _step(r1, address(usdt), address(usdc), 1000e6);
        s[1] = _step(r2, address(usdc), address(usdm), 0); // patched with actual USDC balance
        s[2] = _step(r3, address(usdm), address(usdt), 0);
        uint256 out = _exec(s, address(usdt), 1000e6, address(usdt), 1001e6, 0);
        assertGt(out, 1001e6);
        assertEq(usdt.balanceOf(address(ex)), 0);
    }

    function test_losingCycleReverts() public {
        vm.prank(owner);
        MockRouter bad = new MockRouter(990, 1000);
        usdc.mint(address(bad), 1e12);
        vm.startPrank(owner);
        ex.setTarget(address(bad), true);
        ex.setSpender(address(bad), true);
        vm.stopPrank();
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](3);
        s[0] = _step(bad, address(usdt), address(usdc), 1000e6);
        s[1] = _step(r2, address(usdc), address(usdm), 0);
        s[2] = _step(r3, address(usdm), address(usdt), 0);
        vm.startPrank(user);
        usdt.approve(address(ex), 1000e6);
        vm.expectRevert();
        ex.execute(bytes32("r"), s, address(usdt), 1000e6, address(usdt), 1000e6 + 1, user, block.timestamp, 0, feeTo);
        vm.stopPrank();
        assertEq(usdt.balanceOf(user), 1_000_000e6, "nothing lost on revert");
    }

    function test_feeTakenFromOutput() public {
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _step(r1, address(usdt), address(usdc), 1000e6);
        uint256 out = _exec(s, address(usdt), 1000e6, address(usdc), 0, 10);
        assertEq(usdc.balanceOf(feeTo), 999e6 * 10 / 10_000);
        assertEq(out, 999e6 - 999e6 * 10 / 10_000);
    }

    function test_feeCap() public {
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](0);
        vm.prank(user);
        vm.expectRevert(FisikaExecutor.FeeTooHigh.selector);
        ex.execute(bytes32(0), s, address(usdt), 0, address(usdc), 0, user, block.timestamp, 101, feeTo);
    }

    function test_minOutReverts() public {
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _step(r1, address(usdt), address(usdc), 1000e6);
        vm.startPrank(user);
        usdt.approve(address(ex), 1000e6);
        vm.expectRevert(abi.encodeWithSelector(FisikaExecutor.InsufficientOutput.selector, 999e6, 999e6 + 1));
        ex.execute(bytes32(0), s, address(usdt), 1000e6, address(usdc), 999e6 + 1, user, block.timestamp, 0, feeTo);
        vm.stopPrank();
    }

    function test_deadline() public {
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](0);
        vm.prank(user);
        vm.expectRevert(FisikaExecutor.Expired.selector);
        ex.execute(bytes32(0), s, address(usdt), 0, address(usdc), 0, user, block.timestamp - 1, 0, feeTo);
    }

    function test_targetMustBeAllowlisted() public {
        // An attacker tries to make the executor call a token's transferFrom against someone's approval.
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = FisikaExecutor.Step({
            target: address(usdt),
            spender: address(0),
            tokenIn: address(usdt),
            amountIn: 1,
            amountOffset: NP,
            data: abi.encodeWithSignature("transferFrom(address,address,uint256)", user, address(0xBAD), 1)
        });
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(FisikaExecutor.TargetNotAllowed.selector, address(usdt)));
        ex.execute(bytes32(0), s, address(usdc), 0, address(usdc), 0, address(0xBAD), block.timestamp, 0, feeTo);
    }

    function test_partialPullSweepsLeftoverToCaller() public {
        r1.setPullOnlyHalf(true);
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _step(r1, address(usdt), address(usdc), 1000e6);
        uint256 before = usdt.balanceOf(user);
        _exec(s, address(usdt), 1000e6, address(usdc), 0, 0);
        assertEq(usdt.balanceOf(user), before - 500e6, "unspent input returned");
        assertEq(usdt.balanceOf(address(ex)), 0);
    }

    function test_pauseByGuardian_unpauseOnlyOwner() public {
        vm.prank(guardian);
        ex.pause();
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](0);
        vm.prank(user);
        vm.expectRevert(FisikaExecutor.IsPaused.selector);
        ex.execute(bytes32(0), s, address(usdt), 0, address(usdc), 0, user, block.timestamp, 0, feeTo);
        vm.prank(guardian);
        vm.expectRevert(FisikaExecutor.NotOwner.selector);
        ex.unpause();
        vm.prank(user);
        vm.expectRevert(FisikaExecutor.NotGuardian.selector);
        ex.pause();
        vm.prank(owner);
        ex.unpause();
        assertFalse(ex.paused());
    }

    function test_badPatchOffset() public {
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _step(r1, address(usdt), address(usdc), 0);
        s[0].amountOffset = uint16(s[0].data.length);
        vm.startPrank(user);
        usdt.approve(address(ex), 1000e6);
        vm.expectRevert(FisikaExecutor.BadPatchOffset.selector);
        ex.execute(bytes32(0), s, address(usdt), 1000e6, address(usdc), 0, user, block.timestamp, 0, feeTo);
        vm.stopPrank();
    }

    function test_reentrancyBlocked() public {
        ReentrantToken re = new ReentrantToken();
        re.mint(user, 1e18);
        FisikaExecutor.Step[] memory none = new FisikaExecutor.Step[](0);
        re.arm(
            address(ex),
            abi.encodeCall(FisikaExecutor.execute, (bytes32(0), none, address(re), 0, address(re), 0, user, block.timestamp, 0, feeTo))
        );
        vm.startPrank(user);
        re.approve(address(ex), 1e18);
        ex.execute(bytes32(0), none, address(re), 1e18, address(re), 0, user, block.timestamp, 0, feeTo);
        vm.stopPrank();
        assertTrue(re.reentered(), "token attempted reentry");
        assertEq(re.reentryRevert(), abi.encodeWithSelector(FisikaExecutor.Reentrancy.selector), "reentry blocked by the lock");
        assertEq(re.balanceOf(user), 1e18, "outer call completed normally");
    }

    function test_ownershipTwoStep() public {
        vm.prank(owner);
        ex.transferOwnership(user);
        assertEq(ex.owner(), owner);
        vm.prank(user);
        ex.acceptOwnership();
        assertEq(ex.owner(), user);
    }

    function testFuzz_feeNeverExceedsCap(uint96 amt, uint16 fee) public {
        fee = uint16(bound(fee, 0, 100));
        amt = uint96(bound(amt, 1e6, 1_000_000e6));
        FisikaExecutor.Step[] memory s = new FisikaExecutor.Step[](1);
        s[0] = _step(r1, address(usdt), address(usdc), amt);
        uint256 out = _exec(s, address(usdt), amt, address(usdc), 0, fee);
        uint256 gross = uint256(amt) * 999 / 1000;
        assertEq(out + usdc.balanceOf(feeTo), gross);
        assertLe(usdc.balanceOf(feeTo), gross / 100);
    }
}
