// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

/// @dev Transfers that tolerate tokens returning no bool (USDT-style).
library SafeTx {
    error TransferFailed(address token);
    error ApproveFailed(address token);

    function _call(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || abi.decode(ret, (bool))) && token.code.length > 0;
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        if (!_call(token, abi.encodeCall(IERC20Min.transfer, (to, amount)))) revert TransferFailed(token);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        if (!_call(token, abi.encodeCall(IERC20Min.transferFrom, (from, to, amount)))) revert TransferFailed(token);
    }

    /// @dev Exact approval that also works for tokens rejecting nonzero -> nonzero changes.
    function forceApprove(address token, address spender, uint256 amount) internal {
        bytes memory data = abi.encodeCall(IERC20Min.approve, (spender, amount));
        if (!_call(token, data)) {
            if (!_call(token, abi.encodeCall(IERC20Min.approve, (spender, 0))) || !_call(token, data)) revert ApproveFailed(token);
        }
    }
}

/// @title FisikaExecutor
/// @notice Executes a multi-leg, multi-venue swap atomically: every leg succeeds and the net output clears
///         `minOut`, or the whole transaction reverts. Holds no inventory between calls.
/// @dev Funds are only ever pulled from msg.sender, so a caller can only spend its own tokens. Venue calls are
///      restricted to an owner-managed allowlist of router/reactor contracts; tokens must never be allowlisted.
contract FisikaExecutor {
    using SafeTx for address;

    struct Step {
        /// Venue contract to call (Mento Router, Uniswap SwapRouter02, Textile reactor).
        address target;
        /// Contract that pulls tokenIn (usually == target). address(0) = no approval needed.
        address spender;
        address tokenIn;
        /// Fixed input for this step. 0 = use this contract's whole tokenIn balance (output of earlier steps).
        uint256 amountIn;
        /// Byte offset inside `data` where the uint256 input amount sits, patched when amountIn == 0.
        /// NO_PATCH when the venue call carries no amount (e.g. a pre-signed Textile order).
        uint16 amountOffset;
        bytes data;
    }

    uint16 public constant NO_PATCH = type(uint16).max;
    uint16 public constant MAX_FEE_BPS = 100;

    address public owner;
    address public pendingOwner;
    /// @notice Hot key that can only pause: the dashboard kill switch.
    address public guardian;
    bool public paused;
    uint256 private _lock = 1;

    mapping(address => bool) public allowedTarget;
    mapping(address => bool) public allowedSpender;

    event Executed(
        bytes32 indexed routeId,
        address indexed sender,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        uint256 fee,
        address recipient
    );
    event TargetSet(address indexed target, bool allowed);
    event SpenderSet(address indexed spender, bool allowed);
    event Paused(address by);
    event Unpaused(address by);
    event GuardianSet(address guardian);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotGuardian();
    error IsPaused();
    error Reentrancy();
    error Expired();
    error FeeTooHigh();
    error NoFeeRecipient();
    error TargetNotAllowed(address target);
    error SpenderNotAllowed(address spender);
    error BadPatchOffset();
    error InsufficientOutput(uint256 out, uint256 minOut);
    error StepFailed(uint256 index, bytes reason);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address owner_, address guardian_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        guardian = guardian_;
        emit OwnershipTransferred(address(0), owner_);
        emit GuardianSet(guardian_);
    }

    /// @param routeId   Off-chain route/receipt id, emitted for receipt reconciliation.
    /// @param minOut    Minimum output AFTER the service fee. For arbitrage cycles (tokenIn == tokenOut) set
    ///                  minOut >= amountIn + required profit, so a losing cycle reverts instead of filling.
    function execute(
        bytes32 routeId,
        Step[] calldata steps,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minOut,
        address recipient,
        uint256 deadline,
        uint16 feeBps,
        address feeTo
    ) external nonReentrant returns (uint256 netOut) {
        if (paused) revert IsPaused();
        if (block.timestamp > deadline) revert Expired();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 outBefore = IERC20Min(tokenOut).balanceOf(address(this));
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);

        for (uint256 i = 0; i < steps.length; i++) {
            _runStep(i, steps[i]);
        }

        uint256 out = IERC20Min(tokenOut).balanceOf(address(this)) - outBefore;
        uint256 fee = (out * feeBps) / 10_000;
        netOut = out - fee;
        if (netOut < minOut) revert InsufficientOutput(netOut, minOut);

        if (fee > 0) {
            if (feeTo == address(0)) revert NoFeeRecipient();
            tokenOut.safeTransfer(feeTo, fee);
        }
        tokenOut.safeTransfer(recipient, netOut);

        // Return any unspent input or intermediate dust to the caller; the contract keeps nothing.
        if (tokenIn != tokenOut) _sweep(tokenIn, msg.sender);
        for (uint256 i = 0; i < steps.length; i++) {
            address t = steps[i].tokenIn;
            if (t != tokenOut) _sweep(t, msg.sender);
        }

        emit Executed(routeId, msg.sender, tokenIn, amountIn, tokenOut, netOut, fee, recipient);
    }

    function _runStep(uint256 index, Step calldata s) private {
        if (!allowedTarget[s.target]) revert TargetNotAllowed(s.target);
        if (s.spender != address(0) && !allowedSpender[s.spender]) revert SpenderNotAllowed(s.spender);

        uint256 amount = s.amountIn == 0 ? IERC20Min(s.tokenIn).balanceOf(address(this)) : s.amountIn;
        bytes memory data = s.data;
        if (s.amountIn == 0 && s.amountOffset != NO_PATCH) {
            uint256 off = s.amountOffset;
            if (off + 32 > data.length) revert BadPatchOffset();
            assembly {
                mstore(add(add(data, 32), off), amount)
            }
        }

        if (s.spender != address(0)) s.tokenIn.forceApprove(s.spender, amount);
        (bool ok, bytes memory ret) = s.target.call(data);
        if (!ok) revert StepFailed(index, ret);
        if (s.spender != address(0)) s.tokenIn.forceApprove(s.spender, 0);
    }

    function _sweep(address token, address to) private {
        uint256 bal = IERC20Min(token).balanceOf(address(this));
        if (bal > 0) token.safeTransfer(to, bal);
    }

    // ---------------------------------------------------------------- admin

    function setTarget(address target, bool allowed) external onlyOwner {
        if (target == address(this)) revert TargetNotAllowed(target);
        allowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    function setSpender(address spender, bool allowed) external onlyOwner {
        allowedSpender[spender] = allowed;
        emit SpenderSet(spender, allowed);
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    /// @notice Kill switch: owner or guardian.
    function pause() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Only the owner can resume, so a leaked guardian key cannot undo a pause.
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Recover tokens sent here by mistake. Normal operation leaves no balance.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
