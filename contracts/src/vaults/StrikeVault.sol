// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IStrikeVault} from "../interfaces/IStrikeVault.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title StrikeVault
/// @notice ERC-4626 options vault. A call vault holds a Robinhood Chain stock token and sells covered calls; a put
///         vault holds USDG and sells cash-secured puts. Premium is paid to shareholders in USDG.
/// @dev Deployed as EIP-1167 clones by `VaultFactory`; the `EpochManager` is the only address that can lock the
///      vault, take settlement payouts and deliver premium.
///
///      Between epochs the vault is unlocked and the standard ERC-4626 functions work instantly. While an epoch runs
///      the vault is locked: `requestDeposit` / `requestRedeem` queue instead, and the queue is processed at
///      settlement at that epoch's closing share price. Claims are lazy.
///
///      Accounting is internal (`totalAssets` never reads `balanceOf`), so donations cannot move the share price.
///      Premium uses a per-share accumulator with per-account checkpoints, so the vault can never owe more premium
///      than it received.
contract StrikeVault is ERC4626Upgradeable, ReentrancyGuardTransient, IStrikeVault {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 internal constant ACC_PRECISION = 1e36;

    struct Request {
        uint64 epoch;
        uint192 amount;
    }

    struct EpochSnapshot {
        uint256 assets; // managed assets after payout, before the queue
        uint256 supply; // total supply before the queue
        uint256 accPremium; // accumulator right after this epoch's premium
        uint256 premiumPerShare; // accumulator increase from this epoch's premium
    }

    // ------------------------------------------------------------------ configuration (set once)

    /// @notice The EpochManager allowed to lock, settle and deliver premium.
    address public manager;
    /// @notice The stock token the options are written on.
    address public underlying;
    /// @notice True for a covered-call vault, false for a cash-secured-put vault.
    bool public isCall;
    /// @notice Maximum managed assets (TVL cap).
    uint256 public depositCap;
    IERC20 internal _premiumToken;

    // ------------------------------------------------------------------ epoch state

    /// @notice True while an epoch runs.
    bool public locked;
    /// @notice Number of epochs started. Requests are tagged with the epoch they wait for.
    uint64 public currentEpoch;
    /// @notice The last epoch whose queue has been processed.
    uint64 public lastProcessedEpoch;

    uint256 internal _managedAssets;
    /// @notice Assets waiting in the deposit queue (not collateral yet).
    uint256 public pendingDepositAssets;
    /// @notice Shares escrowed in the redemption queue.
    uint256 public pendingRedeemShares;
    /// @notice Assets set aside for processed redemptions that have not been claimed.
    uint256 public reservedRedeemAssets;

    mapping(address account => Request) public depositRequests;
    mapping(address account => Request) public redeemRequests;
    mapping(uint64 epoch => EpochSnapshot) public epochSnapshots;

    // ------------------------------------------------------------------ premium

    /// @notice USDG premium per share, scaled by 1e36.
    uint256 public accPremiumPerShare;
    /// @notice Premium received while the supply was zero; distributed with the next premium.
    uint256 public unallocatedPremium;
    mapping(address account => uint256) public premiumCheckpoint;
    mapping(address account => uint256) internal _premiumOwed;

    // ------------------------------------------------------------------ events & errors

    event EpochLocked(uint64 indexed epoch);
    event EpochSettled(
        uint64 indexed epoch, uint256 payout, uint256 premium, uint256 assets, uint256 supply, uint256 accPremium
    );
    event DepositRequested(address indexed account, uint64 indexed epoch, uint256 assets);
    event DepositRequestCancelled(address indexed account, uint64 indexed epoch, uint256 assets);
    event DepositClaimed(address indexed account, uint64 indexed epoch, uint256 assets, uint256 shares);
    event RedeemRequested(address indexed account, uint64 indexed epoch, uint256 shares);
    event RedeemClaimed(address indexed account, uint64 indexed epoch, uint256 shares, uint256 assets);
    event PremiumClaimed(address indexed account, uint256 amount);

    error NotManager();
    error ZeroAddress();
    error ZeroAmount();
    error VaultLocked();
    error VaultNotLocked();
    error DepositCapExceeded(uint256 requested, uint256 available);
    error NoProcessedRequest();
    error NoPendingRequest();
    error PayoutExceedsAssets(uint256 payout, uint256 assets);

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IStrikeVault
    function initialize(InitParams calldata p) external initializer {
        if (p.asset == address(0) || p.premiumToken == address(0) || p.underlying == address(0)) revert ZeroAddress();
        if (p.manager == address(0)) revert ZeroAddress();
        __ERC20_init(p.name, p.symbol);
        __ERC4626_init(IERC20(p.asset));
        manager = p.manager;
        underlying = p.underlying;
        isCall = p.isCall;
        depositCap = p.depositCap;
        _premiumToken = IERC20(p.premiumToken);
    }

    // ================================================================== ERC-4626 (unlocked only)

    /// @notice Collateral under management. Excludes queued deposits, reserved redemptions and premium.
    function totalAssets() public view override returns (uint256) {
        return _managedAssets;
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (locked) return 0;
        return depositCap > _managedAssets ? depositCap - _managedAssets : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return _convertToShares(maxDeposit(receiver), Math.Rounding.Floor);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return locked ? 0 : super.maxWithdraw(owner);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return locked ? 0 : super.maxRedeem(owner);
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        _managedAssets += assets;
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        _managedAssets -= assets;
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    // ================================================================== queue (locked only)

    /// @notice Queue a deposit for the end of the running epoch. Claim the shares with `claimDeposit`.
    function requestDeposit(uint256 assets, address receiver) external nonReentrant {
        if (!locked) revert VaultNotLocked();
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 used = _managedAssets + pendingDepositAssets;
        uint256 available = depositCap > used ? depositCap - used : 0;
        if (assets > available) revert DepositCapExceeded(assets, available);

        _claimDepositIfProcessed(receiver);
        Request storage r = depositRequests[receiver];
        r.epoch = currentEpoch;
        r.amount += SafeCast.toUint192(assets);
        pendingDepositAssets += assets;

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
        emit DepositRequested(receiver, currentEpoch, assets);
    }

    /// @notice Withdraw a queued deposit before its epoch settles.
    function cancelDepositRequest() external nonReentrant {
        Request memory r = depositRequests[msg.sender];
        if (r.amount == 0 || r.epoch <= lastProcessedEpoch) revert NoPendingRequest();
        delete depositRequests[msg.sender];
        pendingDepositAssets -= r.amount;
        IERC20(asset()).safeTransfer(msg.sender, r.amount);
        emit DepositRequestCancelled(msg.sender, r.epoch, r.amount);
    }

    /// @notice Move the shares of a processed deposit request to its owner. Anyone may call.
    function claimDeposit(address account) external nonReentrant returns (uint256 shares) {
        _requireProcessed(depositRequests[account]);
        shares = _claimDepositIfProcessed(account);
    }

    /// @notice Queue shares for redemption at the end of the running epoch. Claim assets with `claimRedeem`.
    function requestRedeem(uint256 shares) external nonReentrant {
        if (!locked) revert VaultNotLocked();
        if (shares == 0) revert ZeroAmount();

        _claimRedeemIfProcessed(msg.sender);
        _transfer(msg.sender, address(this), shares);
        Request storage r = redeemRequests[msg.sender];
        r.epoch = currentEpoch;
        r.amount += SafeCast.toUint192(shares);
        pendingRedeemShares += shares;
        emit RedeemRequested(msg.sender, currentEpoch, shares);
    }

    /// @notice Pay out a processed redemption to its owner. Anyone may call.
    function claimRedeem(address account) external nonReentrant returns (uint256 assets) {
        _requireProcessed(redeemRequests[account]);
        assets = _claimRedeemIfProcessed(account);
    }

    /// @dev A processed request can always be claimed, even if it rounds to zero shares or assets (the premium it
    ///      earned is still credited).
    function _requireProcessed(Request memory r) internal view {
        if (r.amount == 0 || r.epoch > lastProcessedEpoch) revert NoProcessedRequest();
    }

    function _claimDepositIfProcessed(address account) internal returns (uint256 shares) {
        Request memory r = depositRequests[account];
        if (r.amount == 0 || r.epoch > lastProcessedEpoch) return 0;
        EpochSnapshot memory s = epochSnapshots[r.epoch];
        delete depositRequests[account];
        shares = uint256(r.amount).mulDiv(s.supply + 1, s.assets + 1, Math.Rounding.Floor);
        _transfer(address(this), account, shares);
        // Premium those shares earned while the vault held them.
        _premiumOwed[account] += shares.mulDiv(accPremiumPerShare - s.accPremium, ACC_PRECISION);
        emit DepositClaimed(account, r.epoch, r.amount, shares);
    }

    function _claimRedeemIfProcessed(address account) internal returns (uint256 assets) {
        Request memory r = redeemRequests[account];
        if (r.amount == 0 || r.epoch > lastProcessedEpoch) return 0;
        EpochSnapshot memory s = epochSnapshots[r.epoch];
        delete redeemRequests[account];
        assets = uint256(r.amount).mulDiv(s.assets + 1, s.supply + 1, Math.Rounding.Floor);
        reservedRedeemAssets -= assets;
        // Premium of the epoch these shares exited in (they carried its risk).
        _premiumOwed[account] += uint256(r.amount).mulDiv(s.premiumPerShare, ACC_PRECISION);
        emit RedeemClaimed(account, r.epoch, r.amount, assets);
        if (assets != 0) IERC20(asset()).safeTransfer(account, assets);
    }

    // ================================================================== premium

    /// @notice USDG premium claimable by `account`.
    function pendingPremium(address account) public view returns (uint256) {
        if (account == address(this)) return 0;
        return _premiumOwed[account]
            + balanceOf(account).mulDiv(accPremiumPerShare - premiumCheckpoint[account], ACC_PRECISION);
    }

    /// @notice Claim accrued USDG premium.
    function claimPremium() external nonReentrant returns (uint256 amount) {
        _checkpoint(msg.sender);
        amount = _premiumOwed[msg.sender];
        if (amount == 0) return 0;
        _premiumOwed[msg.sender] = 0;
        _premiumToken.safeTransfer(msg.sender, amount);
        emit PremiumClaimed(msg.sender, amount);
    }

    function premiumToken() external view returns (address) {
        return address(_premiumToken);
    }

    function _checkpoint(address account) internal {
        uint256 acc = accPremiumPerShare;
        uint256 last = premiumCheckpoint[account];
        if (acc != last) {
            _premiumOwed[account] += balanceOf(account).mulDiv(acc - last, ACC_PRECISION);
            premiumCheckpoint[account] = acc;
        }
    }

    /// @dev Checkpoints both sides before any balance change. The vault's own balance (queued shares) is excluded;
    ///      queued shares receive their premium through the epoch snapshots instead.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from != address(this)) _checkpoint(from);
        if (to != address(0) && to != address(this) && to != from) _checkpoint(to);
        super._update(from, to, value);
    }

    /// @return perShare Accumulator increase.
    function _distributePremium(uint256 amount) internal returns (uint256 perShare) {
        uint256 total = amount + unallocatedPremium;
        if (total == 0) return 0;
        uint256 supply = totalSupply();
        if (supply == 0) {
            unallocatedPremium = total;
            return 0;
        }
        unallocatedPremium = 0;
        perShare = total.mulDiv(ACC_PRECISION, supply);
        accPremiumPerShare += perShare;
    }

    // ================================================================== manager hooks

    /// @inheritdoc IStrikeVault
    function lock() external onlyManager {
        if (locked) revert VaultLocked();
        locked = true;
        uint64 epoch = ++currentEpoch;
        emit EpochLocked(epoch);
    }

    /// @inheritdoc IStrikeVault
    function settleEpoch(uint256 payout, uint256 premium) external onlyManager nonReentrant {
        if (!locked) revert VaultNotLocked();
        if (payout > _managedAssets) revert PayoutExceedsAssets(payout, _managedAssets);
        _managedAssets -= payout;
        uint256 perShare = _distributePremium(premium);

        uint64 epoch = currentEpoch;
        uint256 assets = _managedAssets;
        uint256 supply = totalSupply();
        epochSnapshots[epoch] = EpochSnapshot(assets, supply, accPremiumPerShare, perShare);

        uint256 redeemShares = pendingRedeemShares;
        if (redeemShares != 0) {
            uint256 redeemAssets = redeemShares.mulDiv(assets + 1, supply + 1, Math.Rounding.Floor);
            pendingRedeemShares = 0;
            _burn(address(this), redeemShares);
            _managedAssets -= redeemAssets;
            reservedRedeemAssets += redeemAssets;
        }
        uint256 depositAssets = pendingDepositAssets;
        if (depositAssets != 0) {
            uint256 depositShares = depositAssets.mulDiv(supply + 1, assets + 1, Math.Rounding.Floor);
            pendingDepositAssets = 0;
            _managedAssets += depositAssets;
            _mint(address(this), depositShares);
        }

        lastProcessedEpoch = epoch;
        locked = false;
        emit EpochSettled(epoch, payout, premium, assets, supply, accPremiumPerShare);

        if (payout != 0) IERC20(asset()).safeTransfer(manager, payout);
    }

    // ================================================================== views

    /// @notice Shares `account` can claim from a processed deposit request.
    function claimableDepositShares(address account) external view returns (uint256) {
        Request memory r = depositRequests[account];
        if (r.amount == 0 || r.epoch > lastProcessedEpoch) return 0;
        EpochSnapshot memory s = epochSnapshots[r.epoch];
        return uint256(r.amount).mulDiv(s.supply + 1, s.assets + 1, Math.Rounding.Floor);
    }

    /// @notice Assets `account` can claim from a processed redemption request.
    function claimableRedeemAssets(address account) external view returns (uint256) {
        Request memory r = redeemRequests[account];
        if (r.amount == 0 || r.epoch > lastProcessedEpoch) return 0;
        EpochSnapshot memory s = epochSnapshots[r.epoch];
        return uint256(r.amount).mulDiv(s.assets + 1, s.supply + 1, Math.Rounding.Floor);
    }
}
