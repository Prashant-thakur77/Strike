// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// In your own project, with `@strike/=lib/Strike/contracts/src/` in remappings.txt, these imports read
// "@strike/interfaces/IAggregatorV3.sol" and so on. Inside the Strike repo they are relative (docs/safestockfeed.md).
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {SafeStockFeed} from "../src/libraries/SafeStockFeed.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title StockCollateral
/// @notice Example SafeStockFeed consumer: the collateral side of a lending market that accepts one Robinhood Chain
///         stock token. Users deposit the token; the market values it in USD and derives a borrow limit. Borrowing,
///         interest and liquidation are left out so that only the price handling is on show.
/// @dev Every USD figure comes from `SafeStockFeed.latest`, so a read reverts with the library's own errors when it
///      should not be trusted:
///      - `TokenPaused(token)` / `FeedPaused(token)`: the issuer paused the token or its oracle side;
///      - `StalePrice(updatedAt, maxAge)`: the feed is older than `maxPriceAge` (weekends, halts, outages);
///      - `CorporateActionPending(token, effectiveAt)`: an ERC-8056 split or dividend is scheduled or just applied;
///      - `InvalidPrice(answer)`: a zero, negative or future-dated round;
///      - `SequencerDown()` / `SequencerGracePeriod(since)`: only when a sequencer uptime feed is configured.
///      A lending market must not liquidate on a price it cannot trust, so it lets these reverts through.
///
///      THE MULTIPLIER RULE. ERC-8056 tokens keep raw balances unchanged through splits and dividends and publish a
///      `uiMultiplier` instead (UI balance = raw balance × uiMultiplier). The Chainlink stock feed prices one *raw*
///      token and already includes the multiplier. So:
///        value = rawBalance × feedPrice                  (correct)
///        value = rawBalance × feedPrice × uiMultiplier   (wrong: the multiplier is counted twice)
///        value = balanceOfUI × feedPrice                 (the same mistake, written differently)
///      After a 2-for-1 split the wrong versions double every user's collateral value, and an attacker can borrow
///      against value that does not exist. The multiplier is only ever used to *divide*: the price of one UI share,
///      the number a holder sees in their wallet, is feedPrice ÷ uiMultiplier (`sharePrice`).
contract StockCollateral {
    using SafeERC20 for IERC20;
    using SafeStockFeed for SafeStockFeed.Config;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @notice The stock token accepted as collateral (ERC-8056, 18 decimals).
    address public immutable token;
    /// @notice Share of collateral value that can be borrowed, in basis points.
    uint256 public immutable ltvBps;
    /// @notice Chainlink L2 sequencer uptime feed; zero skips the check (Robinhood Chain has none published yet).
    IAggregatorV3 public immutable sequencerFeed;
    uint32 public immutable sequencerGrace;

    IAggregatorV3 internal immutable _feed;
    uint32 internal immutable _maxPriceAge;
    uint32 internal immutable _corporateActionGrace;
    uint8 internal immutable _feedDecimals;

    /// @notice Deposited collateral per user, in raw token units (what `balanceOf` reports, never the UI amount).
    mapping(address user => uint256 raw) public collateralOf;

    event Deposited(address indexed user, uint256 raw);
    event Withdrawn(address indexed user, uint256 raw);

    error ZeroAddress();
    error LtvTooHigh(uint256 ltvBps);
    error InsufficientCollateral(uint256 requested, uint256 available);

    /// @param token_ The stock token accepted as collateral.
    /// @param feed Chainlink feed for `token_` (for example the NVDA / USD feed on chain 4663).
    /// @param maxPriceAge Staleness limit. Stock feeds have a 24 h heartbeat and pause over weekends and holidays.
    /// @param corporateActionGrace How long around a multiplier change prices are refused.
    /// @param ltvBps_ Borrowable share of collateral value, in basis points (below 100%).
    /// @param sequencerFeed_ Chainlink L2 sequencer uptime feed, or zero to skip the check.
    /// @param sequencerGrace_ Time the sequencer must have been back up before prices are used again.
    constructor(
        address token_,
        IAggregatorV3 feed,
        uint32 maxPriceAge,
        uint32 corporateActionGrace,
        uint256 ltvBps_,
        IAggregatorV3 sequencerFeed_,
        uint32 sequencerGrace_
    ) {
        if (token_ == address(0) || address(feed) == address(0)) revert ZeroAddress();
        if (ltvBps_ >= BPS) revert LtvTooHigh(ltvBps_);
        token = token_;
        ltvBps = ltvBps_;
        sequencerFeed = sequencerFeed_;
        sequencerGrace = sequencerGrace_;
        _feed = feed;
        _maxPriceAge = maxPriceAge;
        _corporateActionGrace = corporateActionGrace;
        _feedDecimals = feed.decimals();
    }

    function deposit(uint256 raw) external {
        collateralOf[msg.sender] += raw;
        IERC20(token).safeTransferFrom(msg.sender, address(this), raw);
        emit Deposited(msg.sender, raw);
    }

    /// @dev No debt in this example, so no price check. A real market would require the remaining collateral to
    ///      cover the user's debt, which means a withdrawal reverts whenever the price cannot be trusted.
    function withdraw(uint256 raw) external {
        uint256 available = collateralOf[msg.sender];
        if (raw > available) revert InsufficientCollateral(raw, available);
        collateralOf[msg.sender] = available - raw;
        IERC20(token).safeTransfer(msg.sender, raw);
        emit Withdrawn(msg.sender, raw);
    }

    /// @notice Safe feed price of one raw token, in USD with 18 decimals. Reverts with a SafeStockFeed error.
    function price() public view returns (uint256 priceWad) {
        SafeStockFeed.checkSequencer(sequencerFeed, sequencerGrace);
        (priceWad,) = _config().latest(token);
    }

    /// @notice USD value (18 decimals) of a user's collateral: raw balance × feed price. No multiplier.
    function collateralValue(address user) public view returns (uint256 usdWad) {
        return collateralOf[user] * price() / WAD;
    }

    /// @notice How much USD (18 decimals) the user could borrow against their collateral.
    function borrowLimit(address user) external view returns (uint256 usdWad) {
        return collateralValue(user) * ltvBps / BPS;
    }

    /// @notice Display only: USD price of one share as the holder's wallet shows it (feed price ÷ uiMultiplier).
    /// @dev A wallet shows `balanceOfUI = raw × m`; this price is `feed ÷ m`; their product is `raw × feed`, the same
    ///      value as `collateralValue`. Never use it with raw balances, and never multiply the feed by `m`.
    function sharePrice() external view returns (uint256 usdWad) {
        return price() * WAD / uiMultiplier();
    }

    /// @notice The token's current ERC-8056 multiplier (1e18 = 1.0); 1.0 for a plain ERC-20.
    function uiMultiplier() public view returns (uint256 m) {
        try IStockToken(token).uiMultiplier() returns (uint256 value) {
            m = value == 0 ? WAD : value;
        } catch {
            m = WAD;
        }
    }

    function _config() internal view returns (SafeStockFeed.Config memory) {
        return SafeStockFeed.Config({
            feed: _feed,
            maxPriceAge: _maxPriceAge,
            corporateActionGrace: _corporateActionGrace,
            feedDecimals: _feedDecimals
        });
    }
}
