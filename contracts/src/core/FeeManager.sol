// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeManager
/// @notice Performance fee on each vault's net premium above its high-water mark, split between the proposing agent
///         and the treasury. Fees are USDG and are paid by pull (`claim`).
/// @dev Each vault carries its unrecovered losses forward (`lossCarried`). An epoch's net result
///      (premium − payoutValue) first pays that carry down; only the rest is charged:
///      fee = max(net − lossCarried, 0) × perfFeeBps, and the agent gets agentShareBps of it. So the fee base summed
///      over a vault's epochs equals the highest cumulative net result the vault has reached (never more).
contract FeeManager is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");
    uint256 public constant BPS = 10_000;
    /// @notice Hard cap on the performance fee: 30% of net premium.
    uint256 public constant MAX_PERF_FEE_BPS = 3000;

    IERC20 public immutable usdg;
    address public treasury;
    uint16 public perfFeeBps;
    uint16 public agentShareBps;

    /// @notice USDG each address can claim.
    mapping(address account => uint256) public claimable;
    /// @notice Sum of all claimable balances (always covered by the USDG balance).
    uint256 public totalClaimable;
    /// @notice Net losses (payout value above premium, USDG) a vault has not yet earned back. No fee is charged until
    ///         later epochs have recovered them.
    mapping(address vault => uint256) public lossCarried;

    event FeesSet(uint16 perfFeeBps, uint16 agentShareBps);
    event TreasurySet(address indexed treasury);
    event FeesCredited(address indexed agent, uint256 agentAmount, uint256 treasuryAmount);
    event Claimed(address indexed account, uint256 amount);
    event LossCarried(address indexed vault, uint256 lossCarried);

    error ZeroAddress();
    error FeeTooHigh(uint256 bps);
    error InsufficientFunding(uint256 needed, uint256 available);

    constructor(address admin, IERC20 usdg_, address treasury_, uint16 perfFeeBps_, uint16 agentShareBps_) {
        if (admin == address(0) || address(usdg_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        treasury = treasury_;
        _setFees(perfFeeBps_, agentShareBps_);
    }

    /// @notice Fee on a vault's next epoch, given its current loss carry-forward. Zero unless the epoch's net
    ///         premium exceeds the carried loss; then charged on the excess only.
    /// @param vault The vault whose carry-forward applies.
    /// @param premium Premium collected (USDG).
    /// @param payoutValue Value paid to option holders (USDG).
    function computeFee(address vault, uint256 premium, uint256 payoutValue)
        public
        view
        returns (uint256 fee, uint256 agentCut)
    {
        (fee, agentCut,) = _fee(lossCarried[vault], premium, payoutValue);
    }

    /// @notice Settle one epoch's fee: returns the same values as `computeFee` and updates the vault's carried loss.
    ///         Only the EpochManager (DEPOSITOR_ROLE) calls it, once per settled epoch.
    function chargeFee(address vault, uint256 premium, uint256 payoutValue)
        external
        onlyRole(DEPOSITOR_ROLE)
        returns (uint256 fee, uint256 agentCut)
    {
        uint256 carried = lossCarried[vault];
        uint256 carriedAfter;
        (fee, agentCut, carriedAfter) = _fee(carried, premium, payoutValue);
        if (carriedAfter != carried) {
            lossCarried[vault] = carriedAfter;
            emit LossCarried(vault, carriedAfter);
        }
    }

    /// @notice Record fees whose USDG the caller has already transferred here.
    function creditFees(address agent, uint256 agentAmount, uint256 treasuryAmount) external onlyRole(DEPOSITOR_ROLE) {
        uint256 total = agentAmount + treasuryAmount;
        uint256 available = usdg.balanceOf(address(this)) - totalClaimable;
        if (total > available) revert InsufficientFunding(total, available);
        address agentTo = agent == address(0) ? treasury : agent;
        claimable[agentTo] += agentAmount;
        claimable[treasury] += treasuryAmount;
        totalClaimable += total;
        emit FeesCredited(agentTo, agentAmount, treasuryAmount);
    }

    /// @notice Withdraw your fees.
    function claim() external returns (uint256 amount) {
        amount = claimable[msg.sender];
        if (amount == 0) return 0;
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        usdg.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function setFees(uint16 perfFeeBps_, uint16 agentShareBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setFees(perfFeeBps_, agentShareBps_);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @return fee Performance fee on the net premium above `carried`.
    /// @return agentCut The agent's part of `fee`.
    /// @return carriedAfter The loss still to recover after this epoch.
    function _fee(uint256 carried, uint256 premium, uint256 payoutValue)
        internal
        view
        returns (uint256 fee, uint256 agentCut, uint256 carriedAfter)
    {
        if (premium <= payoutValue) return (0, 0, carried + (payoutValue - premium));
        uint256 net = premium - payoutValue;
        if (net <= carried) return (0, 0, carried - net);
        net -= carried;
        fee = net * perfFeeBps / BPS;
        // One division, so the agent's share is not computed from an already-rounded fee (and never exceeds it).
        agentCut = net * perfFeeBps * agentShareBps / (BPS * BPS);
    }

    function _setFees(uint16 perfFeeBps_, uint16 agentShareBps_) internal {
        if (perfFeeBps_ > MAX_PERF_FEE_BPS) revert FeeTooHigh(perfFeeBps_);
        if (agentShareBps_ > BPS) revert FeeTooHigh(agentShareBps_);
        perfFeeBps = perfFeeBps_;
        agentShareBps = agentShareBps_;
        emit FeesSet(perfFeeBps_, agentShareBps_);
    }
}
