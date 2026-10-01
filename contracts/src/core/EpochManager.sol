// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAgentRegistry} from "../interfaces/IAgentRegistry.sol";
import {IRiskEngine} from "../interfaces/IRiskEngine.sol";
import {IStockOracle} from "../interfaces/IStockOracle.sol";
import {IStrikeVault} from "../interfaces/IStrikeVault.sol";
import {Decimals} from "../libraries/Decimals.sol";
import {MandateGuard} from "../libraries/MandateGuard.sol";
import {OptionToken} from "../tokens/OptionToken.sol";
import {FeeManager} from "./FeeManager.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title EpochManager
/// @notice Runs every Strike vault's weekly epoch: open → propose → sell → settle. It is the only contract that can
///         lock a vault or move its collateral, and every price it uses is checked before use.
/// @dev Premiums are escrowed here until settlement; payouts are pulled by option holders (`redeem`).
contract EpochManager is AccessControl, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using Math for uint256;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant FACTORY_ROLE = keccak256("FACTORY_ROLE");
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    /// @notice Largest relative sigma change per keeper update, and the minimum time between updates.
    uint256 public constant MAX_SIGMA_STEP_BPS = 2500;
    uint256 public constant SIGMA_UPDATE_INTERVAL = 1 hours;
    uint256 internal constant MAX_SPOT_BUFFER_BPS = 200;

    // ------------------------------------------------------------------ types

    struct UnderlyingConfig {
        uint8 tokenDecimals;
        bool allowed;
        uint64 sigma; // annualised implied volatility used for fair value, WAD
        uint64 minSigma;
        uint64 maxSigma;
        uint16 spotBufferBps; // feed deviation threshold: buys are priced this far against the buyer
        uint32 sigmaUpdatedAt; // last keeper sigma update
    }

    struct VaultConfig {
        address curator;
        uint256 agentId;
        bool registered;
        MandateGuard.Mandate mandate;
    }

    enum EpochState {
        Idle,
        Open,
        Selling
    }

    /// @dev Proposals are judged against the market snapshot taken at open, so a sigma or price update that lands
    ///      between an agent's dry run and its transaction cannot turn an honest proposal into a slash.
    struct VaultEpoch {
        EpochState state;
        uint64 openedAt;
        uint256 seriesId;
        uint128 openSpot; // WAD per raw token
        uint64 openSigma; // WAD
    }

    struct Series {
        address vault;
        address underlying;
        uint256 agentId;
        uint64 expiry;
        uint16 premiumBps;
        bool isCall;
        bool settled;
        bool cancelled;
        uint256 strike; // WAD per raw token
        uint256 size; // max options for sale
        uint256 sold;
        uint256 premium; // USDG escrowed
        uint256 collateral; // vault collateral locked for sold options
        uint256 settlementPrice; // WAD
        uint256 payoutPerOption; // calls: token fraction (WAD); puts: USD per token (WAD)
        uint256 escrow; // payout (or premium refund) still owed to holders
    }

    // ------------------------------------------------------------------ storage

    IERC20 public immutable usdg;
    uint8 public immutable usdgDecimals;
    OptionToken public immutable optionToken;
    /// @notice Black-Scholes pricer and risk engine (Solidity `BlackScholesRef` or the Stylus contract).
    IRiskEngine public pricer;
    FeeManager public feeManager;
    /// @notice Safe stock prices (SafeStockFeed) and NYSE hours.
    IStockOracle public oracle;
    /// @notice Bonded agents that may propose.
    IAgentRegistry public immutable agents;

    /// @notice An agent must propose within this long after the epoch opens, or anyone may abort it.
    uint32 public proposalTimeout = 1 days;
    /// @notice Sales stop this long before expiry.
    uint32 public saleCutoff = 1 hours;
    /// @notice After expiry + this, the guardian may cancel a series that could not be settled.
    uint32 public settlementGrace = 7 days;

    mapping(address token => UnderlyingConfig) public underlyings;
    mapping(address vault => VaultConfig) internal _vaults;
    mapping(address vault => VaultEpoch) public epochs;
    mapping(uint256 id => Series) internal _series;
    /// @notice Slashed agent bonds waiting to be paid to a vault's depositors when its epoch closes.
    mapping(address vault => uint256) public compensation;
    address[] public allVaults;

    // ------------------------------------------------------------------ events

    event UnderlyingSet(address indexed token, bool allowed);
    event OracleSet(address oracle);
    event SigmaSet(address indexed token, uint64 sigma, uint64 minSigma, uint64 maxSigma);
    event SpotBufferSet(address indexed token, uint16 bps);
    event PricerSet(address pricer);
    event FeeManagerSet(address feeManager);
    event TimingsSet(uint32 proposalTimeout, uint32 saleCutoff, uint32 settlementGrace);
    event VaultRegistered(
        address indexed vault, address indexed curator, uint256 indexed agentId, address underlying, bool isCall
    );
    event VaultAgentSet(address indexed vault, uint256 indexed agentId);
    event EpochOpened(address indexed vault, uint64 indexed epoch, uint256 spot);
    event SeriesProposed(
        address indexed vault,
        uint64 indexed epoch,
        uint256 indexed seriesId,
        uint256 strike,
        uint64 expiry,
        uint256 size,
        uint16 premiumBps,
        uint256 fairValue,
        int256 delta
    );
    /// @notice Greeks of one option of an accepted series at proposal (the epoch's opening spot and sigma, the tenor
    ///         at proposal), WAD: delta, gamma per $1 of spot, vega per 1.00 of volatility, theta per day. The vault
    ///         is short: its exposure is minus these times the options sold.
    event SeriesRisk(uint256 indexed seriesId, int256 delta, uint256 gamma, uint256 vega, int256 theta);
    event ProposalRejected(
        address indexed vault,
        uint64 indexed epoch,
        uint256 indexed agentId,
        MandateGuard.Reason reason,
        uint256 slashed,
        uint256 strike,
        uint64 expiry,
        uint256 size,
        uint16 premiumBps
    );
    event OptionsBought(
        uint256 indexed seriesId, address indexed buyer, address indexed recipient, uint256 amount, uint256 premium
    );
    event EpochSettled(
        address indexed vault,
        uint64 indexed epoch,
        uint256 indexed seriesId,
        uint256 settlementPrice,
        uint256 payout,
        uint256 premium,
        uint256 fee
    );
    event EpochAborted(address indexed vault, uint64 indexed epoch);
    event SeriesCancelled(address indexed vault, uint64 indexed epoch, uint256 indexed seriesId);
    event OptionsRedeemed(
        uint256 indexed seriesId, address indexed holder, address indexed recipient, uint256 amount, uint256 paid
    );

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error UnderlyingNotAllowed(address token);
    error VaultNotRegistered(address vault);
    error VaultAlreadyRegistered(address vault);
    error NotAgent(address caller);
    error AgentNotActive(uint256 agentId);
    error NotCurator(address caller);
    error WrongState(EpochState expected, EpochState actual);
    error SigmaOutOfBounds(uint64 sigma);
    error InvalidTimings();
    error MarketClosed(uint256 timestamp);
    error UnsupportedByOracle(address token);
    error NotExpired(uint64 expiry);
    error SaleClosed(uint64 expiry);
    error SeriesUnknown(uint256 seriesId);
    error SeriesExists(uint256 seriesId);
    error SeriesNotFinal(uint256 seriesId);
    error ExceedsSize(uint256 requested, uint256 remaining);
    error ExceedsCapacity(uint256 required, uint256 available);
    error ZeroAmount();
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);
    error TooEarly(uint256 availableAt);
    error StrikeInTheMoney(uint256 strike, uint256 spot);
    error SettlementAvailable(uint256 price);

    // ------------------------------------------------------------------ setup

    constructor(
        address admin,
        IERC20 usdg_,
        OptionToken optionToken_,
        IRiskEngine pricer_,
        FeeManager feeManager_,
        IStockOracle oracle_,
        IAgentRegistry agents_
    ) {
        if (admin == address(0) || address(usdg_) == address(0) || address(optionToken_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(pricer_) == address(0) || address(feeManager_) == address(0) || address(oracle_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(agents_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        agents = agents_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        usdg = usdg_;
        usdgDecimals = IERC20Metadata(address(usdg_)).decimals();
        optionToken = optionToken_;
        pricer = pricer_;
        feeManager = feeManager_;
    }

    /// @notice Allow-list a stock token. Its feed must already be registered in the oracle.
    function setUnderlying(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (allowed && !oracle.isSupported(token)) revert UnsupportedByOracle(token);
        UnderlyingConfig storage c = underlyings[token];
        c.tokenDecimals = IERC20Metadata(token).decimals();
        c.allowed = allowed;
        emit UnderlyingSet(token, allowed);
    }

    function setOracle(IStockOracle oracle_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    /// @notice Admin sets the volatility bounds; the keeper moves sigma inside them.
    function setSigmaBounds(address token, uint64 minSigma, uint64 maxSigma, uint64 sigma)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (minSigma > maxSigma || sigma < minSigma || sigma > maxSigma) revert SigmaOutOfBounds(sigma);
        UnderlyingConfig storage c = underlyings[token];
        (c.minSigma, c.maxSigma, c.sigma) = (minSigma, maxSigma, sigma);
        emit SigmaSet(token, sigma, minSigma, maxSigma);
    }

    /// @notice Keeper volatility update: inside the admin bounds, at most 25% from the current value, once an hour.
    ///         A single keeper key cannot reprice live series by orders of magnitude.
    function setSigma(address token, uint64 sigma) external onlyRole(KEEPER_ROLE) {
        UnderlyingConfig storage c = underlyings[token];
        if (sigma < c.minSigma || sigma > c.maxSigma || sigma == 0) revert SigmaOutOfBounds(sigma);
        uint256 step = sigma > c.sigma ? sigma - c.sigma : c.sigma - sigma;
        if (step * BPS > uint256(c.sigma) * MAX_SIGMA_STEP_BPS) revert SigmaOutOfBounds(sigma);
        if (block.timestamp < uint256(c.sigmaUpdatedAt) + SIGMA_UPDATE_INTERVAL) {
            revert TooEarly(uint256(c.sigmaUpdatedAt) + SIGMA_UPDATE_INTERVAL);
        }
        c.sigma = sigma;
        c.sigmaUpdatedAt = uint32(block.timestamp);
        emit SigmaSet(token, sigma, c.minSigma, c.maxSigma);
    }

    /// @notice Price buys at spot moved this far against the buyer: a Chainlink feed only prints on a deviation-
    ///         threshold move, so the market can sit up to that far from the last print. Set it to the threshold.
    function setSpotBuffer(address token, uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_SPOT_BUFFER_BPS) revert InvalidTimings();
        underlyings[token].spotBufferBps = bps;
        emit SpotBufferSet(token, bps);
    }

    function setPricer(IRiskEngine pricer_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(pricer_) == address(0)) revert ZeroAddress();
        pricer = pricer_;
        emit PricerSet(address(pricer_));
    }

    function setFeeManager(FeeManager feeManager_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(feeManager_) == address(0)) revert ZeroAddress();
        feeManager = feeManager_;
        emit FeeManagerSet(address(feeManager_));
    }

    function setTimings(uint32 proposalTimeout_, uint32 saleCutoff_, uint32 settlementGrace_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (proposalTimeout_ == 0 || proposalTimeout_ > 7 days) revert InvalidTimings();
        if (saleCutoff_ > 1 days || settlementGrace_ < 1 days || settlementGrace_ > 30 days) revert InvalidTimings();
        (proposalTimeout, saleCutoff, settlementGrace) = (proposalTimeout_, saleCutoff_, settlementGrace_);
        emit TimingsSet(proposalTimeout_, saleCutoff_, settlementGrace_);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    /// @notice Called by the factory for each new vault. The agent must exist and be active (bonded, not suspended).
    function registerVault(address vault, address curator, uint256 agentId, MandateGuard.Mandate calldata mandate)
        external
        onlyRole(FACTORY_ROLE)
    {
        if (vault == address(0) || curator == address(0)) revert ZeroAddress();
        if (_vaults[vault].registered) revert VaultAlreadyRegistered(vault);
        if (!agents.isActive(agentId)) revert AgentNotActive(agentId);
        address token = IStrikeVault(vault).underlying();
        if (!underlyings[token].allowed) revert UnderlyingNotAllowed(token);
        MandateGuard.validate(mandate);
        _vaults[vault] = VaultConfig({curator: curator, agentId: agentId, registered: true, mandate: mandate});
        allVaults.push(vault);
        emit VaultRegistered(vault, curator, agentId, token, IStrikeVault(vault).isCall());
    }

    /// @notice The curator (or admin) can replace the vault's agent at any time, effective immediately. The new agent
    ///         must be active; agent id 0 detaches the vault from any agent (nobody can propose until one is set).
    function setVaultAgent(address vault, uint256 agentId) external {
        VaultConfig storage v = _vault(vault);
        if (msg.sender != v.curator && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotCurator(msg.sender);
        if (agentId != 0 && !agents.isActive(agentId)) revert AgentNotActive(agentId);
        v.agentId = agentId;
        emit VaultAgentSet(vault, agentId);
    }

    // ------------------------------------------------------------------ lifecycle

    /// @notice Start an epoch: checks the feed and locks the vault (deposits and redemptions queue from here on).
    ///         The vault's agent must be active, since nobody else could propose in the epoch.
    function openEpoch(address vault) external whenNotPaused nonReentrant {
        VaultConfig storage v = _vault(vault);
        if (msg.sender != agents.signerOf(v.agentId) && !hasRole(KEEPER_ROLE, msg.sender)) revert NotAgent(msg.sender);
        if (!agents.isActive(v.agentId)) revert AgentNotActive(v.agentId);
        VaultEpoch storage ep = epochs[vault];
        _expectState(ep, EpochState.Idle);
        _requireMarketOpen();
        address token = IStrikeVault(vault).underlying();
        uint256 spotPrice = _spot(token);

        ep.state = EpochState.Open;
        ep.openedAt = uint64(block.timestamp);
        ep.openSpot = SafeCast.toUint128(spotPrice);
        ep.openSigma = underlyings[token].sigma;
        IStrikeVault(vault).lock();
        emit EpochOpened(vault, IStrikeVault(vault).currentEpoch(), spotPrice);
    }

    /// @notice The vault's agent proposes this epoch's option. A proposal outside the mandate does not revert: it
    ///         is rejected with a reason (and, once agents are bonded, penalised).
    /// @return accepted Whether the series was created.
    /// @return seriesId The new series id (0 if rejected).
    function proposeSeries(address vault, uint256 strike, uint64 expiry, uint256 size, uint16 premiumBps)
        external
        whenNotPaused
        nonReentrant
        returns (bool accepted, uint256 seriesId)
    {
        return _propose(vault, strike, expiry, size, premiumBps);
    }

    /// @notice Propose by target delta: the strike is solved on-chain (Stylus pricer) against the epoch's opening
    ///         snapshot, so the agent knows the exact strike and delta before it sends the transaction.
    /// @param targetDeltaBps |delta| in bps of 1 (2000 = 0.20). The strike is rounded to a whole cent, toward the
    ///        middle of the mandate's delta band, so a target on the band edge stays inside it.
    function proposeByDelta(address vault, uint16 targetDeltaBps, uint64 expiry, uint256 size, uint16 premiumBps)
        external
        whenNotPaused
        nonReentrant
        returns (bool accepted, uint256 seriesId, uint256 strike)
    {
        VaultEpoch storage ep = epochs[vault];
        _expectState(ep, EpochState.Open);
        bool isCall = IStrikeVault(vault).isCall();
        uint256 tenor = expiry > block.timestamp ? expiry - block.timestamp : 1;
        strike = pricer.strikeForDelta(ep.openSpot, uint256(targetDeltaBps) * 1e14, tenor, ep.openSigma, isCall);
        // A higher call strike (lower put strike) lowers |delta|: round that way when the target sits in the upper
        // half of the band. Not randomness: Slither's weak-prng detector flags any modulo on a value derived from
        // block.timestamp (here the tenor).
        MandateGuard.Mandate storage m = _vault(vault).mandate;
        // slither-disable-next-line weak-prng
        uint256 cents = strike % 1e16;
        strike -= cents;
        if (cents != 0 && (isCall == (2 * uint256(targetDeltaBps) >= uint256(m.minDeltaBps) + m.maxDeltaBps))) {
            strike += 1e16;
        }
        (accepted, seriesId) = _propose(vault, strike, expiry, size, premiumBps);
    }

    function _propose(address vault, uint256 strike, uint64 expiry, uint256 size, uint16 premiumBps)
        internal
        returns (bool accepted, uint256 seriesId)
    {
        VaultConfig storage v = _vault(vault);
        if (msg.sender != agents.signerOf(v.agentId)) revert NotAgent(msg.sender);
        if (!agents.isActive(v.agentId)) revert AgentNotActive(v.agentId);
        VaultEpoch storage ep = epochs[vault];
        _expectState(ep, EpochState.Open);

        (MandateGuard.Reason reason, MandateGuard.Proposal memory p) =
            _evaluate(vault, v, strike, expiry, size, premiumBps);
        // The live feed must still be healthy.
        uint256 live = _spot(IStrikeVault(vault).underlying());
        if (reason != MandateGuard.Reason.None) {
            _reject(vault, v.agentId, reason, p, expiry);
            return (false, 0);
        }
        // If spot crossed the strike since the snapshot, revert: nothing is sold in the money, nobody is slashed.
        if (p.isCall ? strike <= live : strike >= live) revert StrikeInTheMoney(strike, live);
        seriesId = _createSeries(vault, v.agentId, ep, p, expiry);
        agents.recordAccepted(v.agentId);
        return (true, seriesId);
    }

    /// @notice Buy options. Price = Black-Scholes fair value at the current spot × the series' premium factor.
    /// @param maxPremium Slippage bound in USDG.
    /// @return premium USDG paid.
    function buy(uint256 seriesId, uint256 amount, uint256 maxPremium, address to)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 premium)
    {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Series storage s = _series[seriesId];
        if (s.vault == address(0)) revert SeriesUnknown(seriesId);
        VaultEpoch storage ep = epochs[s.vault];
        if (ep.state != EpochState.Selling || ep.seriesId != seriesId) revert WrongState(EpochState.Selling, ep.state);
        if (block.timestamp + saleCutoff >= s.expiry) revert SaleClosed(s.expiry);
        _requireMarketOpen();
        if (s.sold + amount > s.size) revert ExceedsSize(amount, s.size - s.sold);

        uint256 collateral;
        (premium, collateral) = _quoteBuy(s, amount);
        if (premium > maxPremium) revert PremiumTooHigh(premium, maxPremium);
        uint256 available = IERC4626(s.vault).totalAssets();
        if (s.collateral + collateral > available) revert ExceedsCapacity(s.collateral + collateral, available);

        s.sold += amount;
        s.premium += premium;
        s.collateral += collateral;

        usdg.safeTransferFrom(msg.sender, address(this), premium);
        optionToken.mint(to, seriesId, amount);
        emit OptionsBought(seriesId, msg.sender, to, amount, premium);
    }

    /// @notice Settle an expired series and close the epoch. Anyone may call; retrying is safe.
    /// @param roundId The first feed round at or after expiry (verified on-chain). Ignored when nothing was sold.
    function settle(address vault, uint80 roundId) external nonReentrant {
        VaultEpoch storage ep = epochs[vault];
        _expectState(ep, EpochState.Selling);
        uint256 seriesId = ep.seriesId;
        Series storage s = _series[seriesId];
        if (block.timestamp < s.expiry) revert NotExpired(s.expiry);

        uint256 payout = 0;
        uint256 payoutValue = 0;
        if (s.sold != 0) {
            uint256 price = oracle.recordSettlementPrice(s.underlying, s.expiry, roundId);
            (payout, payoutValue) = _settleMath(s, price);
            s.settlementPrice = price;
        }
        s.settled = true;
        s.escrow = payout;
        ep.state = EpochState.Idle;
        ep.seriesId = 0;

        // Charged only on net premium above the vault's carried losses (high-water mark, FeeManager.lossCarried).
        (uint256 fee, uint256 agentCut) = feeManager.chargeFee(vault, s.premium, payoutValue);
        uint256 toVault = s.premium - fee + _takeCompensation(vault);
        uint64 epoch = IStrikeVault(vault).currentEpoch();

        if (fee != 0) {
            usdg.safeTransfer(address(feeManager), fee);
            feeManager.creditFees(agents.payoutOf(s.agentId), agentCut, fee - agentCut);
        }
        if (toVault != 0) usdg.safeTransfer(vault, toVault);
        IStrikeVault(vault).settleEpoch(payout, toVault);
        // The agent's track record (and its ERC-8004 reputation): depositors' premium minus what buyers were paid.
        agents.recordEpochResult(s.agentId, SafeCast.toInt256(s.premium) - SafeCast.toInt256(payoutValue));
        emit EpochSettled(vault, epoch, seriesId, s.settlementPrice, payout, s.premium, fee);
    }

    /// @notice Burn settled (or cancelled) options and receive the payout (or the premium refund).
    function redeem(uint256 seriesId, uint256 amount, address to) external nonReentrant returns (uint256 paid) {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Series storage s = _series[seriesId];
        if (s.vault == address(0)) revert SeriesUnknown(seriesId);
        if (!s.settled && !s.cancelled) revert SeriesNotFinal(seriesId);

        IERC20 token;
        if (s.cancelled) {
            // Pro-rata refund of the escrowed premium.
            paid = amount.mulDiv(s.premium, s.sold);
            token = usdg;
        } else if (s.isCall) {
            paid = amount.mulDiv(s.payoutPerOption, WAD);
            token = IERC20(s.underlying);
        } else {
            paid = Decimals.valueInUsd(
                amount, s.payoutPerOption, underlyings[s.underlying].tokenDecimals, usdgDecimals, Math.Rounding.Floor
            );
            token = usdg;
        }
        s.escrow -= paid;
        optionToken.burn(msg.sender, seriesId, amount);
        if (paid != 0) token.safeTransfer(to, paid);
        emit OptionsRedeemed(seriesId, msg.sender, to, amount, paid);
    }

    /// @notice Close an epoch that never got a valid proposal. Anyone after the timeout; the curator any time.
    function abortEpoch(address vault) external nonReentrant {
        VaultConfig storage v = _vault(vault);
        VaultEpoch storage ep = epochs[vault];
        _expectState(ep, EpochState.Open);
        bool privileged = msg.sender == v.curator || hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!privileged && block.timestamp < ep.openedAt + proposalTimeout) {
            revert TooEarly(ep.openedAt + proposalTimeout);
        }
        ep.state = EpochState.Idle;
        uint64 epoch = IStrikeVault(vault).currentEpoch();
        _closeWithoutPayout(vault);
        emit EpochAborted(vault, epoch);
    }

    /// @notice Last resort if the feed never produced a settlement price: collateral stays with the vault and
    ///         option holders get the premium back.
    function emergencyCancel(address vault) external onlyRole(GUARDIAN_ROLE) nonReentrant {
        VaultEpoch storage ep = epochs[vault];
        _expectState(ep, EpochState.Selling);
        uint256 seriesId = ep.seriesId;
        Series storage s = _series[seriesId];
        if (block.timestamp < uint256(s.expiry) + settlementGrace) {
            revert TooEarly(uint256(s.expiry) + settlementGrace);
        }
        // A recorded price means `settle` works: cancelling would turn a payout into a premium refund.
        uint256 recorded = oracle.settlementPrice(s.underlying, s.expiry);
        if (recorded != 0) revert SettlementAvailable(recorded);
        s.cancelled = true;
        s.escrow = s.premium;
        ep.state = EpochState.Idle;
        ep.seriesId = 0;
        uint64 epoch = IStrikeVault(vault).currentEpoch();
        _closeWithoutPayout(vault);
        emit SeriesCancelled(vault, epoch, seriesId);
    }

    // ------------------------------------------------------------------ views

    function seriesIdOf(address vault, address token, uint256 strike, uint64 expiry, bool isCall)
        public
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(vault, token, strike, expiry, isCall)));
    }

    function getSeries(uint256 seriesId) external view returns (Series memory) {
        return _series[seriesId];
    }

    function vaultConfig(address vault) external view returns (VaultConfig memory) {
        return _vaults[vault];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    /// @notice Dry-run a proposal: the mandate verdict, fair value and delta. Agents call this before proposing.
    function previewProposal(address vault, uint256 strike, uint64 expiry, uint256 size, uint16 premiumBps)
        external
        view
        returns (MandateGuard.Reason reason, uint256 fairValue, int256 delta, uint256 capacity)
    {
        MandateGuard.Proposal memory p;
        (reason, p) = _evaluate(vault, _vault(vault), strike, expiry, size, premiumBps);
        return (reason, p.fairValue, p.delta, p.capacity);
    }

    /// @notice USDG premium and vault collateral for buying `amount` options now.
    function quoteBuy(uint256 seriesId, uint256 amount) external view returns (uint256 premium, uint256 collateral) {
        Series storage s = _series[seriesId];
        if (s.vault == address(0)) revert SeriesUnknown(seriesId);
        return _quoteBuy(s, amount);
    }

    /// @notice Current spot (WAD per raw token) after all feed checks.
    function spot(address token) external view returns (uint256) {
        return _spot(token);
    }

    // ------------------------------------------------------------------ internals

    function _vault(address vault) internal view returns (VaultConfig storage v) {
        v = _vaults[vault];
        if (!v.registered) revert VaultNotRegistered(vault);
    }

    function _expectState(VaultEpoch storage ep, EpochState expected) internal view {
        if (ep.state != expected) revert WrongState(expected, ep.state);
    }

    function _evaluate(
        address vault,
        VaultConfig storage v,
        uint256 strike,
        uint64 expiry,
        uint256 size,
        uint16 premiumBps
    ) internal view returns (MandateGuard.Reason, MandateGuard.Proposal memory p) {
        address token = IStrikeVault(vault).underlying();
        UnderlyingConfig storage u = underlyings[token];
        VaultEpoch storage ep = epochs[vault];
        bool open = ep.state == EpochState.Open;
        p.isCall = IStrikeVault(vault).isCall();
        p.spot = open ? ep.openSpot : _spot(token);
        p.strike = strike;
        p.size = size;
        p.premiumBps = premiumBps;
        p.tenor = expiry > block.timestamp ? expiry - block.timestamp : 0;
        p.validExpiry = _isValidExpiry(expiry);
        p.capacity = _capacity(vault, p.isCall, strike, u.tokenDecimals);
        if (p.tenor == 0) return (MandateGuard.Reason.TenorOutOfRange, p);
        (p.fairValue, p.delta) = pricer.quote(p.spot, strike, p.tenor, open ? ep.openSigma : u.sigma, p.isCall);
        return (MandateGuard.check(v.mandate, p), p);
    }

    /// @dev The agent's bond pays for the rejected proposal; the vault's depositors receive it at epoch close.
    function _reject(
        address vault,
        uint256 agentId,
        MandateGuard.Reason reason,
        MandateGuard.Proposal memory p,
        uint64 expiry
    ) internal {
        uint256 slashed = agents.slash(agentId, address(this));
        compensation[vault] += slashed;
        emit ProposalRejected(
            vault, IStrikeVault(vault).currentEpoch(), agentId, reason, slashed, p.strike, expiry, p.size, p.premiumBps
        );
    }

    function _takeCompensation(address vault) internal returns (uint256 amount) {
        amount = compensation[vault];
        if (amount != 0) compensation[vault] = 0;
    }

    /// @dev Close the epoch with no payout; any slashed bonds still go to depositors.
    function _closeWithoutPayout(address vault) internal {
        uint256 comp = _takeCompensation(vault);
        if (comp != 0) usdg.safeTransfer(vault, comp);
        IStrikeVault(vault).settleEpoch(0, comp);
    }

    function _createSeries(
        address vault,
        uint256 agentId,
        VaultEpoch storage ep,
        MandateGuard.Proposal memory p,
        uint64 expiry
    ) internal returns (uint256 seriesId) {
        address token = IStrikeVault(vault).underlying();
        seriesId = seriesIdOf(vault, token, p.strike, expiry, p.isCall);
        if (_series[seriesId].vault != address(0)) revert SeriesExists(seriesId);
        Series storage s = _series[seriesId];
        s.vault = vault;
        s.underlying = token;
        s.agentId = agentId;
        s.expiry = expiry;
        s.premiumBps = p.premiumBps;
        s.isCall = p.isCall;
        s.strike = p.strike;
        s.size = p.size;

        ep.state = EpochState.Selling;
        ep.seriesId = seriesId;
        emit SeriesProposed(
            vault,
            IStrikeVault(vault).currentEpoch(),
            seriesId,
            p.strike,
            expiry,
            p.size,
            p.premiumBps,
            p.fairValue,
            p.delta
        );
        (int256 delta, uint256 gamma, uint256 vega, int256 theta) =
            pricer.greeks(p.spot, p.strike, p.tenor, ep.openSigma, p.isCall);
        emit SeriesRisk(seriesId, delta, gamma, vega, theta);
    }

    /// @dev Options the vault's collateral can back: one token per call, the strike in USDG per put.
    function _capacity(address vault, bool isCall, uint256 strike, uint8 tokenDecimals)
        internal
        view
        returns (uint256)
    {
        uint256 assets = IERC4626(vault).totalAssets();
        if (isCall) return assets;
        if (strike == 0) return 0;
        return assets.mulDiv(10 ** tokenDecimals * WAD, strike * 10 ** usdgDecimals);
    }

    function _quoteBuy(Series storage s, uint256 amount) internal view returns (uint256 premium, uint256 collateral) {
        UnderlyingConfig storage u = underlyings[s.underlying];
        // The last print can lag the market by up to the feed's deviation threshold: price against the buyer.
        uint256 spot_ = _spot(s.underlying);
        spot_ = spot_ * (s.isCall ? BPS + u.spotBufferBps : BPS - u.spotBufferBps) / BPS;
        uint256 tenor = s.expiry > block.timestamp ? s.expiry - block.timestamp : 1;
        (uint256 fair,) = pricer.quote(spot_, s.strike, tenor, u.sigma, s.isCall);
        // Never below intrinsic value: an in-the-money option is not sold at a discount to its exercise value.
        uint256 intrinsic =
            s.isCall ? (spot_ > s.strike ? spot_ - s.strike : 0) : (s.strike > spot_ ? s.strike - spot_ : 0);
        uint256 perOption = Math.max(fair * s.premiumBps / BPS, intrinsic);
        premium = Decimals.valueInUsd(amount, perOption, u.tokenDecimals, usdgDecimals, Math.Rounding.Ceil);
        if (premium == 0) premium = 1; // never sell options for free
        collateral = s.isCall
            ? amount
            : Decimals.valueInUsd(amount, s.strike, u.tokenDecimals, usdgDecimals, Math.Rounding.Ceil);
    }

    /// @return payout Collateral owed to holders (tokens for calls, USDG for puts), rounded down.
    /// @return payoutValue The payout's value in USDG, for the performance fee.
    function _settleMath(Series storage s, uint256 price) internal returns (uint256 payout, uint256 payoutValue) {
        uint8 tokenDecimals = underlyings[s.underlying].tokenDecimals;
        if (s.isCall) {
            uint256 ppo = price > s.strike ? (price - s.strike).mulDiv(WAD, price) : 0;
            s.payoutPerOption = ppo;
            payout = s.sold.mulDiv(ppo, WAD);
            payoutValue = Decimals.valueInUsd(payout, price, tokenDecimals, usdgDecimals, Math.Rounding.Floor);
        } else {
            uint256 ppo = s.strike > price ? s.strike - price : 0;
            s.payoutPerOption = ppo;
            payout = Decimals.valueInUsd(s.sold, ppo, tokenDecimals, usdgDecimals, Math.Rounding.Floor);
            payoutValue = payout;
        }
    }

    /// @dev Live spot (WAD per raw token) through SafeStockFeed: fresh, unpaused, no corporate action in progress.
    function _spot(address token) internal view returns (uint256 price) {
        if (!underlyings[token].allowed) revert UnderlyingNotAllowed(token);
        (price,) = oracle.latestPrice(token);
    }

    /// @dev Expiries must be an NYSE session close (Friday 16:00 New York for weekly options).
    function _isValidExpiry(uint64 expiry) internal view returns (bool) {
        return expiry > block.timestamp && oracle.isValidExpiry(expiry);
    }

    function _requireMarketOpen() internal view {
        if (!oracle.isMarketOpen()) revert MarketClosed(block.timestamp);
    }
}
