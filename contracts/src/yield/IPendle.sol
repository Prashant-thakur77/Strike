// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The parts of Pendle V2 that PendleCollateralAdapter calls: Router V4, the PT/YT/LP oracle and a market.
/// @dev Struct layouts and signatures from pendle-core-v2-public (`IPAllActionTypeV3.sol`, `IPActionSwapPTV3.sol`,
///      `IPActionMiscV3.sol`, `IPPYLpOracle.sol`, `IPMarket.sol`). Robinhood Chain mainnet (4663) addresses are in
///      `deployments/4663-core.json` of that repository; docs/design/pendle-collateral.md lists the ones used here.

enum SwapType {
    NONE,
    KYBERSWAP,
    ODOS,
    ETH_WETH,
    OKX,
    ONE_INCH,
    RESERVE_1,
    RESERVE_2,
    RESERVE_3,
    RESERVE_4,
    RESERVE_5
}

struct SwapData {
    SwapType swapType;
    address extRouter;
    bytes extCalldata;
    bool needScale;
}

struct TokenInput {
    address tokenIn;
    uint256 netTokenIn;
    address tokenMintSy;
    address pendleSwap;
    SwapData swapData;
}

struct TokenOutput {
    address tokenOut;
    uint256 minTokenOut;
    address tokenRedeemSy;
    address pendleSwap;
    SwapData swapData;
}

struct ApproxParams {
    uint256 guessMin;
    uint256 guessMax;
    uint256 guessOffchain;
    uint256 maxIteration;
    uint256 eps;
}

enum OrderType {
    SY_FOR_PT,
    PT_FOR_SY,
    SY_FOR_YT,
    YT_FOR_SY
}

struct Order {
    uint256 salt;
    uint256 expiry;
    uint256 nonce;
    OrderType orderType;
    address token;
    address YT;
    address maker;
    address receiver;
    uint256 makingAmount;
    uint256 lnImpliedRate;
    uint256 failSafeRate;
    bytes permit;
}

struct FillOrderParams {
    Order order;
    bytes signature;
    uint256 makingAmount;
}

struct LimitOrderData {
    address limitRouter;
    uint256 epsSkipMarket;
    FillOrderParams[] normalFills;
    FillOrderParams[] flashFills;
    bytes optData;
}

interface IPendleRouter {
    function swapExactTokenForPt(
        address receiver,
        address market,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm);

    function swapExactPtForToken(
        address receiver,
        address market,
        uint256 exactPtIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm);

    function redeemPyToToken(address receiver, address YT, uint256 netPyIn, TokenOutput calldata output)
        external
        returns (uint256 netTokenOut, uint256 netSyInterm);
}

interface IPendlePYLpOracle {
    /// @notice PT price in the SY's asset, 18 decimals, as a TWAP of the market's implied rate over `duration`.
    function getPtToAssetRate(address market, uint32 duration) external view returns (uint256);

    /// @notice Whether the market keeps enough rate observations for a TWAP over `duration`.
    function getOracleState(address market, uint32 duration)
        external
        view
        returns (bool increaseCardinalityRequired, uint16 cardinalityRequired, bool oldestObservationSatisfied);
}

interface IPendleMarket {
    function readTokens() external view returns (address sy, address pt, address yt);
    function expiry() external view returns (uint256);
    function isExpired() external view returns (bool);
    function increaseObservationsCardinalityNext(uint16 cardinalityNext) external;
}

interface IStandardizedYield {
    /// @return assetType 0 for a token, 1 for a liquidity position
    function assetInfo() external view returns (uint8 assetType, address assetAddress, uint8 assetDecimals);
}
