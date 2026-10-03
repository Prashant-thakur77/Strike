// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ApproxParams, LimitOrderData, TokenInput, TokenOutput} from "../../src/yield/IPendle.sol";
import {MockERC20} from "./MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Stand-ins for Pendle V2 (router, PT/YT/LP oracle, market, SY) with the behaviour the adapter relies on:
///         PT bought and sold at a set rate less a set price impact, redeemed at par after expiry, and an oracle whose
///         rate and readiness the test sets. The real contracts are exercised by test/fork/PendleCollateralFork.t.sol.
contract MockPT is MockERC20 {
    constructor(uint8 decimals_) MockERC20("PT Global Dollar", "PT-USDG", decimals_) {}

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockSY {
    address public asset;

    constructor(address asset_) {
        asset = asset_;
    }

    function assetInfo() external view returns (uint8, address, uint8) {
        return (0, asset, 6);
    }
}

contract MockPendleMarket {
    address public sy;
    address public pt;
    address public yt;
    uint256 public expiry;
    uint16 public cardinalityNext = 1;

    constructor(address sy_, address pt_, address yt_, uint256 expiry_) {
        sy = sy_;
        pt = pt_;
        yt = yt_;
        expiry = expiry_;
    }

    function readTokens() external view returns (address, address, address) {
        return (sy, pt, yt);
    }

    function isExpired() external view returns (bool) {
        return block.timestamp >= expiry;
    }

    function increaseObservationsCardinalityNext(uint16 next) external {
        cardinalityNext = next;
    }
}

contract MockPendleOracle {
    uint256 public rate = 0.985e18;
    bool public increaseRequired;
    bool public oldestSatisfied = true;
    bool public broken;

    function set(uint256 rate_, bool increaseRequired_, bool oldestSatisfied_) external {
        rate = rate_;
        increaseRequired = increaseRequired_;
        oldestSatisfied = oldestSatisfied_;
    }

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function getPtToAssetRate(address, uint32) external view returns (uint256) {
        require(!broken, "OracleTargetTooOld");
        return rate;
    }

    function getOracleState(address, uint32) external view returns (bool, uint16, bool) {
        return (increaseRequired, 901, oldestSatisfied);
    }
}

contract MockPendleRouter {
    MockERC20 public immutable usdg;
    MockPT public immutable pt;
    MockPendleMarket public immutable market;
    /// USDG per PT the router trades at, 18 decimals (the oracle's TWAP can differ).
    uint256 public execRate = 0.985e18;
    /// Price impact against the trader, in bps.
    uint256 public impactBps = 20;
    /// When set, the router pays less than the caller's minimum without reverting (to test the adapter's own check).
    bool public ignoreMin;

    constructor(MockERC20 usdg_, MockPT pt_, MockPendleMarket market_) {
        usdg = usdg_;
        pt = pt_;
        market = market_;
    }

    function set(uint256 execRate_, uint256 impactBps_, bool ignoreMin_) external {
        execRate = execRate_;
        impactBps = impactBps_;
        ignoreMin = ignoreMin_;
    }

    function swapExactTokenForPt(
        address receiver,
        address,
        uint256 minPtOut,
        ApproxParams calldata,
        TokenInput calldata input,
        LimitOrderData calldata
    ) external payable returns (uint256 netPtOut, uint256, uint256) {
        require(!market.isExpired(), "expired");
        IERC20(input.tokenIn).transferFrom(msg.sender, address(this), input.netTokenIn);
        netPtOut = input.netTokenIn * 1e18 / execRate * (10_000 - impactBps) / 10_000;
        require(ignoreMin || netPtOut >= minPtOut, "Slippage: INSUFFICIENT_PT_OUT");
        pt.mint(receiver, netPtOut);
        return (netPtOut, 0, 0);
    }

    function swapExactPtForToken(
        address receiver,
        address,
        uint256 exactPtIn,
        TokenOutput calldata output,
        LimitOrderData calldata
    ) external returns (uint256 netTokenOut, uint256, uint256) {
        require(!market.isExpired(), "expired");
        pt.burn(msg.sender, exactPtIn);
        netTokenOut = exactPtIn * execRate / 1e18 * (10_000 - impactBps) / 10_000;
        require(ignoreMin || netTokenOut >= output.minTokenOut, "Slippage: INSUFFICIENT_TOKEN_OUT");
        usdg.mint(receiver, netTokenOut);
        return (netTokenOut, 0, 0);
    }

    function redeemPyToToken(address receiver, address, uint256 netPyIn, TokenOutput calldata output)
        external
        returns (uint256 netTokenOut, uint256)
    {
        require(market.isExpired(), "not expired");
        pt.burn(msg.sender, netPyIn);
        netTokenOut = ignoreMin ? netPyIn / 2 : netPyIn;
        require(ignoreMin || netTokenOut >= output.minTokenOut, "Slippage: INSUFFICIENT_TOKEN_OUT");
        usdg.mint(receiver, netTokenOut);
        return (netTokenOut, 0);
    }
}

/// @notice A reserve that asks for a fixed share of the collateral plus a fixed amount.
contract MockReserve {
    uint256 public shareBps;
    uint256 public extra;

    function set(uint256 shareBps_, uint256 extra_) external {
        shareBps = shareBps_;
        extra = extra_;
    }

    function requiredLiquidity(uint256 collateral) external view returns (uint256) {
        return collateral * shareBps / 10_000 + extra;
    }
}
