// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GasDrip (TESTNETS ONLY)
/// @notice A team-funded starter drip of testnet ETH, so a brand-new wallet can pay for its first transactions without
///         an outside faucet. A wallet with no gas cannot call anything, so a relayer the owner names sends `drip(to)`
///         on the wallet's behalf (Strike's `/api/gas-drip` route). The limits live here, not only in the relayer:
///         one drip per address ever, only to an address holding less than `amount`, and at most `dailyCap` drips per
///         UTC day. A leaked relayer key can therefore cost at most `dailyCap * amount` per day. Testnet ETH has no value.
contract GasDrip is Ownable {
    /// @notice The largest `amount` the constructor accepts, so a typo cannot hand out a whole balance per drip.
    uint256 public constant MAX_AMOUNT = 0.01 ether;
    /// @notice The largest `dailyCap` the constructor accepts.
    uint256 public constant MAX_DAILY_CAP = 1000;

    /// @notice Wei per drip.
    uint256 public immutable amount;
    /// @notice Drips allowed per UTC day, across all addresses.
    uint256 public immutable dailyCap;

    /// @notice Addresses allowed to call `drip`.
    mapping(address relayer => bool) public isRelayer;
    /// @notice Whether an address has had its one drip.
    mapping(address account => bool) public dripped;
    /// @notice The UTC day (`block.timestamp / 1 days`) that `dripsToday` counts.
    uint256 public day;
    /// @notice Drips sent on `day`.
    uint256 public dripsToday;

    event Dripped(address indexed to, address indexed relayer, uint256 amount);
    event RelayerSet(address indexed relayer, bool allowed);
    event Refilled(address indexed from, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    /// @notice The caller is not a relayer.
    error NotRelayer();
    /// @notice `to` is the zero address.
    error ZeroRecipient();
    /// @notice `to` already had its drip.
    error AlreadyDripped(address to);
    /// @notice `to` already holds at least `amount` wei: it does not need a starter drip.
    error HasGas(uint256 balance);
    /// @notice Today's `dailyCap` drips are spent; the count resets at `resetsAt` (00:00 UTC).
    error DailyCapReached(uint256 resetsAt);
    /// @notice The contract holds less than `amount`.
    error Empty();
    /// @notice The constructor got `amount` or `dailyCap` of 0 or above its maximum.
    error BadParams();
    /// @notice Sending ETH failed.
    error SendFailed();

    constructor(address owner_, address relayer, uint256 amount_, uint256 dailyCap_) Ownable(owner_) {
        if (amount_ == 0 || amount_ > MAX_AMOUNT || dailyCap_ == 0 || dailyCap_ > MAX_DAILY_CAP) revert BadParams();
        amount = amount_;
        dailyCap = dailyCap_;
        if (relayer != address(0)) _setRelayer(relayer, true);
    }

    /// @notice Anyone can fund the drip with a plain transfer.
    receive() external payable {
        emit Refilled(msg.sender, msg.value);
    }

    /// @notice Send `amount` wei to `to`: once per address, only while `to` holds less than `amount`, at most
    ///         `dailyCap` times per UTC day. Relayers only.
    function drip(address to) external {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        if (to == address(0)) revert ZeroRecipient();
        if (dripped[to]) revert AlreadyDripped(to);
        if (to.balance >= amount) revert HasGas(to.balance);
        uint256 today = block.timestamp / 1 days;
        if (today != day) {
            day = today;
            dripsToday = 0;
        }
        if (dripsToday >= dailyCap) revert DailyCapReached((today + 1) * 1 days);
        if (address(this).balance < amount) revert Empty();
        dripped[to] = true;
        ++dripsToday;
        emit Dripped(to, msg.sender, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    /// @notice Allow or stop a relayer.
    function setRelayer(address relayer, bool allowed) external onlyOwner {
        _setRelayer(relayer, allowed);
    }

    /// @notice Recover `value` wei to `to`.
    function sweep(address payable to, uint256 value) external onlyOwner {
        emit Swept(to, value);
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert SendFailed();
    }

    /// @notice Wei left in the drip.
    function remaining() public view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Drips still allowed today.
    function dripsLeftToday() public view returns (uint256) {
        return block.timestamp / 1 days == day ? dailyCap - dripsToday : dailyCap;
    }

    /// @notice Whether `drip(to)` would succeed now, and if not the error selector it would revert with (0 when it
    ///         would succeed). Lets the relayer and the app explain a refusal before sending anything.
    function check(address to) external view returns (bool ok, bytes4 reason) {
        if (to == address(0)) return (false, ZeroRecipient.selector);
        if (dripped[to]) return (false, AlreadyDripped.selector);
        if (to.balance >= amount) return (false, HasGas.selector);
        if (dripsLeftToday() == 0) return (false, DailyCapReached.selector);
        if (address(this).balance < amount) return (false, Empty.selector);
        return (true, bytes4(0));
    }

    function _setRelayer(address relayer, bool allowed) private {
        isRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }
}
