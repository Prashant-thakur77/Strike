// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ILiquidityReserve} from "./ILiquidityReserve.sol";
import {
    ApproxParams,
    IPendleMarket,
    IPendlePYLpOracle,
    IPendleRouter,
    IStandardizedYield,
    LimitOrderData,
    SwapData,
    TokenInput,
    TokenOutput
} from "./IPendle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PendleCollateralAdapter
/// @notice Prototype, not deployed. A collateral sleeve for one cash-secured-put vault: it holds the vault's USDG and
///         may put the part no series can need into a Pendle principal token (PT), which matures at par. The part a
///         series could need stays liquid USDG, always.
/// @dev Rules the contract enforces, whoever calls:
///      - after every allocation, liquid USDG >= `requiredLiquidity()`: the reserve's worst case for the vault's
///        series (`ILiquidityReserve`, e.g. StrikePutReserve) plus the curator's buffer on top;
///      - the PT position at cost stays under the curator's cap, itself under an immutable hard cap;
///      - PT is bought and sold within `maxSlippageBps` of Pendle's TWAP oracle price, and only while the market keeps
///        enough observations for that TWAP;
///      - no allocation into a PT that matures later than `maxTimeToMaturity` from now;
///      - the vault (`owner`) can always take liquid USDG out and can always sell PT at its own price limit; after
///        maturity anyone can redeem the PT back to USDG.
///      The allocator (the vault's agent) only chooses how much and when, inside those bounds, as it does for strikes.
///      Every state-changing function is `nonReentrant`. Trade outputs are the router's returned amounts, checked
///      against the caller's minimum; the cap and reserve checks read live balances after the trade.
contract PendleCollateralAdapter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant ONE = 1e18;
    /// @notice Highest slippage the curator may allow against the oracle price: 3%.
    uint256 public constant MAX_SLIPPAGE_BPS = 300;
    /// @notice Shortest TWAP window the adapter accepts. Pendle's integration guide suggests 900 s.
    uint32 public constant MIN_TWAP_DURATION = 900;

    struct Config {
        address usdg;
        address router;
        address oracle;
        address market;
        address owner;
        address curator;
        address allocator;
        address reserve;
        uint32 twapDuration;
        uint32 maxTimeToMaturity;
        uint256 hardCap;
    }

    IERC20 public immutable usdg;
    IPendleRouter public immutable router;
    IPendlePYLpOracle public immutable oracle;
    address public immutable market;
    IERC20 public immutable pt;
    address public immutable yt;
    /// @notice The PT's maturity (the market's expiry), unix seconds.
    uint256 public immutable maturity;
    /// @notice The vault whose collateral this is: the only account that deposits and withdraws.
    address public immutable owner;
    /// @notice The vault's curator: turns the adapter on and off and sets the limits.
    address public immutable curator;
    ILiquidityReserve public immutable reserve;
    uint32 public immutable twapDuration;
    /// @notice Longest time to maturity accepted when buying PT.
    uint32 public immutable maxTimeToMaturity;
    /// @notice The highest cap the curator can ever set.
    uint256 public immutable hardCap;

    /// @notice The vault's agent, which proposes allocations inside the limits.
    address public allocator;
    bool public enabled;
    /// @notice Largest PT position, valued at the oracle, after an allocation.
    uint256 public cap;
    /// @notice Liquid USDG kept on top of the reserve's worst case, in bps of the collateral.
    uint16 public bufferBps;
    /// @notice Largest distance from the oracle price accepted on a buy or a sale by the allocator or curator.
    uint16 public maxSlippageBps;

    event Deposited(uint256 assets);
    event Withdrawn(address indexed to, uint256 assets);
    event Allocated(address indexed by, uint256 usdgIn, uint256 ptOut, uint256 oracleRate);
    event Deallocated(address indexed by, uint256 ptIn, uint256 usdgOut, uint256 oracleRate);
    event Redeemed(uint256 ptIn, uint256 usdgOut);
    event EnabledSet(bool enabled);
    event LimitsSet(uint256 cap, uint16 bufferBps, uint16 maxSlippageBps);
    event AllocatorSet(address allocator);

    error ZeroAddress();
    error ZeroAmount();
    error Unauthorized(address caller);
    error Disabled();
    error WrongAsset(address syAsset, address usdg);
    error DecimalsMismatch(uint8 pt, uint8 usdg);
    error TwapTooShort(uint32 duration);
    error LimitTooHigh();
    error MarketExpired();
    error MarketNotExpired();
    error MaturityTooFar(uint256 timeToMaturity, uint256 max);
    error OracleNotReady();
    error CapExceeded(uint256 position, uint256 cap);
    error ReserveBreached(uint256 liquidAfter, uint256 required);
    error SlippageBoundTooLoose(uint256 minOut, uint256 floor);
    error InsufficientLiquid(uint256 requested, uint256 liquid);
    error OutputTooLow(uint256 received, uint256 minOut);

    modifier only(address who) {
        if (msg.sender != who) revert Unauthorized(msg.sender);
        _;
    }

    constructor(Config memory c) {
        if (
            c.usdg == address(0) || c.router == address(0) || c.oracle == address(0) || c.market == address(0)
                || c.owner == address(0) || c.curator == address(0) || c.reserve == address(0)
        ) revert ZeroAddress();
        if (c.twapDuration < MIN_TWAP_DURATION) revert TwapTooShort(c.twapDuration);
        (address sy, address pt_, address yt_) = IPendleMarket(c.market).readTokens();
        (, address syAsset,) = IStandardizedYield(sy).assetInfo();
        if (syAsset != c.usdg) revert WrongAsset(syAsset, c.usdg);
        uint8 ptDecimals = IERC20Metadata(pt_).decimals();
        uint8 usdgDecimals = IERC20Metadata(c.usdg).decimals();
        if (ptDecimals != usdgDecimals) revert DecimalsMismatch(ptDecimals, usdgDecimals);
        usdg = IERC20(c.usdg);
        router = IPendleRouter(c.router);
        oracle = IPendlePYLpOracle(c.oracle);
        market = c.market;
        pt = IERC20(pt_);
        yt = yt_;
        maturity = IPendleMarket(c.market).expiry();
        owner = c.owner;
        curator = c.curator;
        allocator = c.allocator;
        reserve = ILiquidityReserve(c.reserve);
        twapDuration = c.twapDuration;
        maxTimeToMaturity = c.maxTimeToMaturity;
        hardCap = c.hardCap;
        // Off until the curator turns it on; 1% slippage until the curator says otherwise.
        maxSlippageBps = 100;
    }

    // ================================================================== vault side

    /// @notice Move USDG collateral in from the vault.
    function deposit(uint256 assets) external only(owner) nonReentrant {
        if (assets == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), assets);
        emit Deposited(assets);
    }

    /// @notice Take liquid USDG out, for a settlement payout or a redemption. Never blocked by the adapter's state.
    function withdraw(uint256 assets, address to) external only(owner) nonReentrant {
        if (assets == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 liquid = liquidAssets();
        if (assets > liquid) revert InsufficientLiquid(assets, liquid);
        usdg.safeTransfer(to, assets);
        emit Withdrawn(to, assets);
    }

    // ================================================================== allocator side

    /// @notice Buy PT with `usdgIn` of liquid USDG. Reverts unless every rule in the contract notes holds afterwards.
    /// @param minPtOut At least `usdgIn` at the oracle price less `maxSlippageBps`.
    function allocate(uint256 usdgIn, uint256 minPtOut) external only(allocator) nonReentrant returns (uint256 ptOut) {
        if (!enabled) revert Disabled();
        if (usdgIn == 0) revert ZeroAmount();
        if (block.timestamp >= maturity) revert MarketExpired();
        if (maturity - block.timestamp > maxTimeToMaturity) {
            revert MaturityTooFar(maturity - block.timestamp, maxTimeToMaturity);
        }
        uint256 rate = _oracleRate();
        uint256 floor = usdgIn.mulDiv(ONE, rate).mulDiv(BPS - maxSlippageBps, BPS);
        if (minPtOut < floor) revert SlippageBoundTooLoose(minPtOut, floor);

        usdg.forceApprove(address(router), usdgIn);
        (ptOut,,) = router.swapExactTokenForPt(
            address(this),
            market,
            minPtOut,
            ApproxParams(0, type(uint256).max, 0, 256, 1e14),
            TokenInput(address(usdg), usdgIn, address(usdg), address(0), _noSwap()),
            _noLimitOrders()
        );
        if (ptOut < minPtOut) revert OutputTooLow(ptOut, minPtOut);

        uint256 position = ptValue();
        if (position > cap) revert CapExceeded(position, cap);
        uint256 liquid = liquidAssets();
        uint256 required = requiredLiquidity();
        if (liquid < required) revert ReserveBreached(liquid, required);
        emit Allocated(msg.sender, usdgIn, ptOut, rate);
    }

    /// @notice Turn `ptIn` of PT back into USDG: sold on the market before maturity, redeemed at par after it.
    /// @dev The allocator and the curator are held to `maxSlippageBps` from the oracle price. The vault (`owner`)
    ///      sets its own limit, so it can always raise cash, for example for redemptions in a stressed market.
    function deallocate(uint256 ptIn, uint256 minUsdgOut) external nonReentrant returns (uint256 usdgOut) {
        if (msg.sender != owner && msg.sender != allocator && msg.sender != curator) revert Unauthorized(msg.sender);
        if (ptIn == 0) revert ZeroAmount();
        if (block.timestamp >= maturity) return _redeem(ptIn, minUsdgOut);
        // The vault's own sales do not read the oracle, so they work even if it cannot answer.
        uint256 rate = 0;
        if (msg.sender != owner) {
            rate = _oracleRate();
            uint256 floor = ptIn.mulDiv(rate, ONE).mulDiv(BPS - maxSlippageBps, BPS);
            if (minUsdgOut < floor) revert SlippageBoundTooLoose(minUsdgOut, floor);
        }
        pt.forceApprove(address(router), ptIn);
        (usdgOut,,) = router.swapExactPtForToken(
            address(this),
            market,
            ptIn,
            TokenOutput(address(usdg), minUsdgOut, address(usdg), address(0), _noSwap()),
            _noLimitOrders()
        );
        if (usdgOut < minUsdgOut) revert OutputTooLow(usdgOut, minUsdgOut);
        emit Deallocated(msg.sender, ptIn, usdgOut, rate);
    }

    /// @notice After maturity, anyone can turn all the PT back into USDG at par.
    function redeemMatured() external nonReentrant returns (uint256 usdgOut) {
        if (block.timestamp < maturity) revert MarketNotExpired();
        uint256 bal = pt.balanceOf(address(this));
        if (bal == 0) revert ZeroAmount();
        // PT redeems one for one into the SY, which redeems into USDG; the SY's own rate sets the floor.
        return _redeem(bal, 0);
    }

    // ================================================================== curator side

    function setEnabled(bool on) external only(curator) nonReentrant {
        enabled = on;
        emit EnabledSet(on);
    }

    /// @notice A lower cap or a higher buffer stops new allocations; the curator or the agent then sells down.
    function setLimits(uint256 cap_, uint16 bufferBps_, uint16 maxSlippageBps_) external only(curator) nonReentrant {
        if (cap_ > hardCap || bufferBps_ > BPS || maxSlippageBps_ > MAX_SLIPPAGE_BPS) revert LimitTooHigh();
        cap = cap_;
        bufferBps = bufferBps_;
        maxSlippageBps = maxSlippageBps_;
        emit LimitsSet(cap_, bufferBps_, maxSlippageBps_);
    }

    function setAllocator(address allocator_) external only(curator) nonReentrant {
        allocator = allocator_;
        emit AllocatorSet(allocator_);
    }

    // ================================================================== views

    /// @notice USDG held here: what the vault can withdraw now.
    function liquidAssets() public view returns (uint256) {
        return usdg.balanceOf(address(this));
    }

    function ptBalance() public view returns (uint256) {
        return pt.balanceOf(address(this));
    }

    /// @notice USDG per PT, 18 decimals: Pendle's TWAP rate, never above par; par from maturity.
    function ptRate() public view returns (uint256) {
        if (block.timestamp >= maturity) return ONE;
        return Math.min(oracle.getPtToAssetRate(market, twapDuration), ONE);
    }

    /// @notice The PT position in USDG at `ptRate`, rounded down.
    function ptValue() public view returns (uint256) {
        uint256 bal = ptBalance();
        return bal == 0 ? 0 : bal.mulDiv(ptRate(), ONE);
    }

    /// @notice Liquid USDG plus the PT position at the oracle: the vault's collateral.
    function totalAssets() public view returns (uint256) {
        return liquidAssets() + ptValue();
    }

    /// @notice USDG that must stay liquid: the reserve's worst case plus the buffer, at most the whole collateral.
    function requiredLiquidity() public view returns (uint256) {
        uint256 total = totalAssets();
        uint256 need = reserve.requiredLiquidity(total) + total.mulDiv(bufferBps, BPS, Math.Rounding.Ceil);
        return Math.min(need, total);
    }

    /// @notice Liquid USDG missing under `requiredLiquidity()`, after a withdrawal or a fall in the PT's price: what
    ///         the vault, curator or agent should raise by selling PT. Zero when the rule holds.
    function shortfall() external view returns (uint256) {
        uint256 liquid = liquidAssets();
        uint256 required = requiredLiquidity();
        return required > liquid ? required - liquid : 0;
    }

    /// @notice The most USDG an allocation can spend now under the reserve and the cap, before slippage.
    function allocatable() external view returns (uint256) {
        if (!enabled || block.timestamp >= maturity) return 0;
        uint256 liquid = liquidAssets();
        uint256 required = requiredLiquidity();
        uint256 position = ptValue();
        if (liquid <= required || position >= cap) return 0;
        return Math.min(liquid - required, cap - position);
    }

    /// @notice True when the market keeps enough observations for a TWAP over `twapDuration`.
    function oracleReady() public view returns (bool) {
        (bool increaseCardinalityRequired,, bool oldestObservationSatisfied) =
            oracle.getOracleState(market, twapDuration);
        return !increaseCardinalityRequired && oldestObservationSatisfied;
    }

    // ================================================================== internals

    function _oracleRate() internal view returns (uint256) {
        if (!oracleReady()) revert OracleNotReady();
        return ptRate();
    }

    function _redeem(uint256 ptIn, uint256 minUsdgOut) internal returns (uint256 usdgOut) {
        pt.forceApprove(address(router), ptIn);
        (usdgOut,) = router.redeemPyToToken(
            address(this), yt, ptIn, TokenOutput(address(usdg), minUsdgOut, address(usdg), address(0), _noSwap())
        );
        if (usdgOut < minUsdgOut) revert OutputTooLow(usdgOut, minUsdgOut);
        emit Redeemed(ptIn, usdgOut);
    }

    function _noSwap() internal pure returns (SwapData memory s) {}

    function _noLimitOrders() internal pure returns (LimitOrderData memory l) {}
}
