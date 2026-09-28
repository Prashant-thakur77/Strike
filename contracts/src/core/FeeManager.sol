// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeManager
/// @notice Performance fee on each epoch's net premium, split between the proposing agent and the treasury.
///         Fees are USDG and are paid by pull (`claim`).
/// @dev fee = max(premium − payoutValue, 0) × perfFeeBps; the agent gets agentShareBps of it.
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

    event FeesSet(uint16 perfFeeBps, uint16 agentShareBps);
    event TreasurySet(address indexed treasury);
    event FeesCredited(address indexed agent, uint256 agentAmount, uint256 treasuryAmount);
    event Claimed(address indexed account, uint256 amount);

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

    /// @notice Fee on one epoch. Zero when the epoch lost money.
    /// @param premium Premium collected (USDG).
    /// @param payoutValue Value paid to option holders (USDG).
    function computeFee(uint256 premium, uint256 payoutValue) public view returns (uint256 fee, uint256 agentCut) {
        if (premium <= payoutValue) return (0, 0);
        fee = (premium - payoutValue) * perfFeeBps / BPS;
        agentCut = fee * agentShareBps / BPS;
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

    function _setFees(uint16 perfFeeBps_, uint16 agentShareBps_) internal {
        if (perfFeeBps_ > MAX_PERF_FEE_BPS) revert FeeTooHigh(perfFeeBps_);
        if (agentShareBps_ > BPS) revert FeeTooHigh(agentShareBps_);
        perfFeeBps = perfFeeBps_;
        agentShareBps = agentShareBps_;
        emit FeesSet(perfFeeBps_, agentShareBps_);
    }
}
