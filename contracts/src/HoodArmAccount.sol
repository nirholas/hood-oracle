// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHoodArmAccount} from "./interfaces/IHoodArmAccount.sol";
import {IHoodArmFactory} from "./interfaces/IHoodArmFactory.sol";
import {IHoodOracleAttestations} from "./interfaces/IHoodOracleAttestations.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";
import {Policy, PolicyLib} from "./libraries/PolicyLib.sol";
import {PositionLib} from "./libraries/PositionLib.sol";
import {SpotPriceLib} from "./libraries/SpotPriceLib.sol";
import {
    AlreadyInitialized,
    Concurrency,
    Cooldown,
    DailyBudget,
    DeadlineExpired,
    EthTransferFailed,
    FeesPending,
    InsufficientBalance,
    InsufficientPosition,
    KillSwitch,
    NoPosition,
    NotOperator,
    NotOwner,
    NotOwnerOrOperator,
    NothingPending,
    NothingReceived,
    NothingToClaim,
    OracleGate,
    PerTradeCap,
    PositionsOpen,
    QuoteTokenNotTradable,
    SlippageBound,
    Timelocked,
    ZeroAddress,
    ZeroAmount
} from "./libraries/HoodErrors.sol";

/// @title HoodArmAccount
/// @notice One owner's on-chain arm, deployed as an EIP-1167 clone by
///         HoodArmFactory. The owner funds it, sets the policy, holds the kill
///         switch and can withdraw anything at any time. The operator (the
///         engine's hot key) can only `buy` inside the policy and `sell`.
///
///         The guard order in `buy` mirrors `RiskEngine.check` in
///         `src/guards/risk.ts`: kill switch, amount, cooldown, per-trade cap,
///         daily budget, concurrency, then the oracle gate and the slippage
///         bound. Cheapest and most fatal first, so the revert a dashboard
///         shows is the most meaningful one.
///
///         Sells are exempt from every exposure cap and from the kill switch:
///         a cap that traps a losing position is the exact failure a stop loss
///         exists to prevent, and a kill halts new risk only. Sells still honor
///         the slippage bound, because a sell that executes at any price is a
///         rug of your own making.
///
///         There is deliberately no `panicSellAll`. A forced market exit into
///         thin launch liquidity during whatever caused the panic is usually
///         worse than holding. `kill()` stops new buys and the owner closes
///         positions one at a time with `sell` when they have looked.
contract HoodArmAccount is IHoodArmAccount, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using PolicyLib for Policy;
    using PositionLib for Position;

    /// @notice Delay before a loosening policy change takes effect. Tightening is immediate.
    uint256 public constant POLICY_TIMELOCK = 1 hours;

    address public owner;
    address public pendingOwner;
    address public operator;
    address public factory;
    address public attestations;
    address public weth;
    uint16 public performanceFeeBps;
    bool public killed;
    bool private _initialized;

    Policy private _policy;
    Policy private _pendingPolicy;
    uint256 private _pendingEffectiveAt;

    uint64 public lastTradeAt;
    uint64 private _spendDay;
    uint128 private _spentToday;
    uint256 public openPositionCount;
    uint256 public feesAccruedWei;
    mapping(address token => Position) private _positions;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner && msg.sender != operator) revert NotOwnerOrOperator(msg.sender);
        _;
    }

    /// @dev The implementation itself is never usable: only its clones initialize.
    constructor() {
        _initialized = true;
    }

    /// @notice Accept native ETH. It is wrapped into WETH on demand by the next buy.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @inheritdoc IHoodArmAccount
    function initialize(address owner_, address operator_, Policy calldata policy_, uint16 performanceFeeBps_)
        external
    {
        if (_initialized) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        _initialized = true;
        Policy memory p = policy_;
        p.validate();
        owner = owner_;
        operator = operator_;
        factory = msg.sender;
        attestations = IHoodArmFactory(msg.sender).attestations();
        weth = IHoodArmFactory(msg.sender).weth();
        performanceFeeBps = performanceFeeBps_;
        _policy = p;
        emit Initialized(owner_, operator_, performanceFeeBps_);
        emit PolicyApplied(p);
    }

    // ── trading ──────────────────────────────────────────────────────────────

    /// @inheritdoc IHoodArmAccount
    function buy(address token, uint256 amountInWei, uint256 amountOutMinimum, uint24 fee, uint256 deadline)
        external
        nonReentrant
        onlyOperator
        returns (uint256 amountOut)
    {
        Policy memory p = _policy;
        if (killed) revert KillSwitch();
        if (amountInWei == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (token == p.quoteToken || token == address(0)) revert QuoteTokenNotTradable();
        _checkCooldown(p.cooldownSeconds);
        if (p.perTradeCapWei == 0 || amountInWei > p.perTradeCapWei) revert PerTradeCap(amountInWei, p.perTradeCapWei);
        uint256 wouldSpend = spentTodayWei() + amountInWei;
        if (p.dailyBudgetWei == 0 || wouldSpend > p.dailyBudgetWei) revert DailyBudget(wouldSpend, p.dailyBudgetWei);
        Position storage pos = _positions[token];
        bool opening = pos.tokenAmount == 0;
        if (opening && openPositionCount >= p.maxOpenPositions) {
            revert Concurrency(openPositionCount, p.maxOpenPositions);
        }
        _checkOracleGate(token, p.minOracleScore);
        _checkSlippage(p.allowedRouter, p.maxSlippageBps, p.quoteToken, token, amountInWei, amountOutMinimum, fee);
        _ensureQuote(p.quoteToken, amountInWei);

        _spendDay = PolicyLib.dayIndex(block.timestamp);
        _spentToday = wouldSpend.toUint128();
        lastTradeAt = uint64(block.timestamp);

        amountOut = _swap(p.allowedRouter, p.quoteToken, token, amountInWei, amountOutMinimum, fee);
        if (amountOut == 0) revert NothingReceived(token);
        if (opening) openPositionCount += 1;
        pos.recordBuy(amountOut, amountInWei, uint64(block.timestamp));
        emit Buy(token, amountInWei, amountOut, fee, pos.tokenAmount, pos.costBasisWei);
    }

    /// @inheritdoc IHoodArmAccount
    function sell(address token, uint256 amountIn, uint256 amountOutMinimum, uint24 fee, uint256 deadline)
        external
        nonReentrant
        onlyOwnerOrOperator
        returns (uint256 proceedsWei)
    {
        Policy memory p = _policy;
        if (amountIn == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        Position storage pos = _positions[token];
        uint256 held = pos.tokenAmount;
        if (held == 0) revert NoPosition(token);
        if (amountIn > held) revert InsufficientPosition(token, amountIn, held);
        _checkSlippage(p.allowedRouter, p.maxSlippageBps, token, p.quoteToken, amountIn, amountOutMinimum, fee);

        lastTradeAt = uint64(block.timestamp);
        uint256 basisWei = pos.releaseBasis(amountIn);
        proceedsWei = _swap(p.allowedRouter, token, p.quoteToken, amountIn, amountOutMinimum, fee);
        (int256 realizedWei, uint256 feeWei) = pos.recordSell(proceedsWei, basisWei, performanceFeeBps);
        if (feeWei != 0) feesAccruedWei += feeWei;
        emit Sell(token, amountIn, proceedsWei, fee, realizedWei, feeWei, msg.sender);
        if (pos.tokenAmount == 0) _closePosition(token, pos);
    }

    // ── owner controls ───────────────────────────────────────────────────────

    /// @inheritdoc IHoodArmAccount
    function setPolicy(Policy calldata proposed) external onlyOwner {
        Policy memory next = proposed;
        next.validate();
        if (next.quoteToken != _policy.quoteToken) {
            if (openPositionCount != 0) revert PositionsOpen(openPositionCount);
            if (feesAccruedWei != 0) revert FeesPending(feesAccruedWei);
        }
        if (PolicyLib.isTighterOrEqual(_policy, next)) {
            _policy = next;
            emit PolicyApplied(next);
            return;
        }
        _pendingPolicy = next;
        _pendingEffectiveAt = block.timestamp + POLICY_TIMELOCK;
        emit PolicyProposed(next, _pendingEffectiveAt);
    }

    /// @inheritdoc IHoodArmAccount
    function applyPolicy() external onlyOwner {
        uint256 effectiveAt = _pendingEffectiveAt;
        if (effectiveAt == 0) revert NothingPending();
        if (block.timestamp < effectiveAt) revert Timelocked(effectiveAt);
        Policy memory next = _pendingPolicy;
        if (next.quoteToken != _policy.quoteToken) {
            if (openPositionCount != 0) revert PositionsOpen(openPositionCount);
            // Fees are owed in the quote they were earned in; `claimFees()` is
            // permissionless, so this is one call away and never a lockup.
            if (feesAccruedWei != 0) revert FeesPending(feesAccruedWei);
        }
        _policy = next;
        delete _pendingPolicy;
        _pendingEffectiveAt = 0;
        emit PolicyApplied(next);
    }

    /// @inheritdoc IHoodArmAccount
    function cancelPolicy() external onlyOwner {
        if (_pendingEffectiveAt == 0) revert NothingPending();
        delete _pendingPolicy;
        _pendingEffectiveAt = 0;
        emit PolicyCancelled();
    }

    /// @inheritdoc IHoodArmAccount
    /// @dev Rotating the hot key is always allowed immediately: it only ever tightens.
    function setOperator(address operator_) external onlyOwner {
        emit OperatorSet(operator, operator_);
        operator = operator_;
    }

    /// @inheritdoc IHoodArmAccount
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @inheritdoc IHoodArmAccount
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner(msg.sender);
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @inheritdoc IHoodArmAccount
    function kill() external onlyOwner {
        killed = true;
        emit Killed(msg.sender);
    }

    /// @inheritdoc IHoodArmAccount
    function unkill() external onlyOwner {
        killed = false;
        emit Unkilled(msg.sender);
    }

    /// @inheritdoc IHoodArmAccount
    /// @dev `token == address(0)` withdraws native ETH. The quote token can be
    ///      withdrawn down to the accrued protocol fees. Withdrawing a tracked
    ///      position's token shrinks the position (its cost basis leaves with it).
    function ownerWithdraw(address token, uint256 amount, address to) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            _sendEth(to, amount);
        } else {
            if (token == _policy.quoteToken) {
                uint256 available = withdrawableQuoteWei();
                if (amount > available) revert InsufficientBalance(amount, available);
            } else {
                _shrinkPosition(token, amount);
            }
            IERC20(token).safeTransfer(to, amount);
        }
        emit Withdrawn(token, amount, to);
    }

    /// @inheritdoc IHoodArmAccount
    /// @dev Sends whatever the account holds beyond its books: untracked units
    ///      of a token, quote above the accrued fees, or all native ETH.
    function sweepDust(address token, address to) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount == 0) revert ZeroAmount();
            _sendEth(to, amount);
        } else {
            amount = IERC20(token).balanceOf(address(this));
            uint256 reserved = token == _policy.quoteToken ? feesAccruedWei : _positions[token].tokenAmount;
            amount = amount > reserved ? amount - reserved : 0;
            if (amount == 0) revert ZeroAmount();
            IERC20(token).safeTransfer(to, amount);
        }
        emit DustSwept(token, amount, to);
    }

    /// @inheritdoc IHoodArmAccount
    /// @dev Anyone may push the accrued fees to the protocol's current recipient.
    function claimFees() external nonReentrant returns (uint256 amount) {
        amount = feesAccruedWei;
        if (amount == 0) revert NothingToClaim();
        feesAccruedWei = 0;
        address recipient = IHoodArmFactory(factory).feeRecipient();
        IERC20(_policy.quoteToken).safeTransfer(recipient, amount);
        emit FeesClaimed(recipient, amount);
    }

    // ── views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IHoodArmAccount
    function policy() external view returns (Policy memory) {
        return _policy;
    }

    /// @inheritdoc IHoodArmAccount
    function pendingPolicy() external view returns (Policy memory proposed, uint256 effectiveAt) {
        return (_pendingPolicy, _pendingEffectiveAt);
    }

    /// @inheritdoc IHoodArmAccount
    function position(address token) external view returns (Position memory) {
        return _positions[token];
    }

    /// @inheritdoc IHoodArmAccount
    function spentTodayWei() public view returns (uint256) {
        return _spendDay == PolicyLib.dayIndex(block.timestamp) ? _spentToday : 0;
    }

    /// @inheritdoc IHoodArmAccount
    function remainingDailyBudgetWei() external view returns (uint256) {
        uint256 spent = spentTodayWei();
        uint256 budget = _policy.dailyBudgetWei;
        return budget > spent ? budget - spent : 0;
    }

    /// @inheritdoc IHoodArmAccount
    function cooldownRemaining() public view returns (uint256) {
        uint256 last = lastTradeAt;
        if (last == 0) return 0;
        uint256 until = last + _policy.cooldownSeconds;
        return until > block.timestamp ? until - block.timestamp : 0;
    }

    /// @inheritdoc IHoodArmAccount
    function withdrawableQuoteWei() public view returns (uint256) {
        uint256 balance = IERC20(_policy.quoteToken).balanceOf(address(this));
        uint256 reserved = feesAccruedWei;
        return balance > reserved ? balance - reserved : 0;
    }

    // ── internals ────────────────────────────────────────────────────────────

    function _checkCooldown(uint32 cooldownSeconds) private view {
        if (cooldownSeconds == 0) return;
        uint256 remaining = cooldownRemaining();
        if (remaining != 0) revert Cooldown(remaining);
    }

    /// @dev Fails closed: a policy that asks for a score with no attestations contract refuses.
    function _checkOracleGate(address token, uint8 minScore) private view {
        if (minScore == 0) return;
        if (attestations == address(0)) revert OracleGate(0, minScore, false);
        (IHoodOracleAttestations.Attestation memory a, bool fresh) = IHoodOracleAttestations(attestations).latest(token);
        if (!fresh || a.score < minScore) revert OracleGate(a.score, minScore, fresh);
    }

    function _checkSlippage(
        address router,
        uint16 maxSlippageBps,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint24 fee
    ) private view {
        address pool = SpotPriceLib.poolFor(ISwapRouter02(router).factory(), tokenIn, tokenOut, fee);
        uint256 expected = SpotPriceLib.expectedOut(pool, tokenIn, amountIn, fee);
        uint256 required = SpotPriceLib.minimumOut(expected, maxSlippageBps);
        if (amountOutMinimum < required) revert SlippageBound(amountOutMinimum, required);
    }

    /// @dev Make sure `amountIn` of the quote token is on hand, wrapping ETH when
    ///      the quote is WETH. Accrued fees are NOT trading capital: they are
    ///      already owed to the protocol, so a buy may not spend them. Without
    ///      that reserve a buy could leave `claimFees()` unpayable and
    ///      `withdrawableQuoteWei()` reading zero while the account still held
    ///      quote, which would look to an owner like their funds had vanished.
    function _ensureQuote(address quote, uint256 amountIn) private {
        uint256 balance = IERC20(quote).balanceOf(address(this));
        uint256 reserved = feesAccruedWei;
        uint256 usable = balance > reserved ? balance - reserved : 0;
        if (usable >= amountIn) return;
        uint256 shortfall = amountIn - usable;
        if (quote != weth || address(this).balance < shortfall) {
            revert InsufficientBalance(amountIn, quote == weth ? usable + address(this).balance : usable);
        }
        IWETH9(weth).deposit{value: shortfall}();
        emit Wrapped(shortfall);
    }

    /// @dev Approve exactly `amountIn`, swap with this account as recipient, and
    ///      measure what actually arrived so fee-on-transfer tokens are booked
    ///      at their real delivered amount. Any allowance the router left
    ///      behind is cleared, so the router never holds standing approval.
    function _swap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint24 fee
    ) private returns (uint256 received) {
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(router, amountIn);
        ISwapRouter02(router)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
            );
        if (IERC20(tokenIn).allowance(address(this), router) != 0) IERC20(tokenIn).forceApprove(router, 0);
        received = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    function _shrinkPosition(address token, uint256 amount) private {
        Position storage pos = _positions[token];
        uint256 tracked = pos.tokenAmount;
        if (tracked == 0) return;
        pos.releaseBasis(amount > tracked ? tracked : amount);
        if (pos.tokenAmount == 0) _closePosition(token, pos);
    }

    function _closePosition(address token, Position storage pos) private {
        emit PositionClosed(token, pos.realizedNetWei);
        delete _positions[token];
        openPositionCount -= 1;
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed(to, amount);
    }
}
