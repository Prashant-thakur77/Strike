// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAgentRegistry} from "../interfaces/IAgentRegistry.sol";
import {IERC8004Reputation} from "../interfaces/IERC8004Reputation.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title AgentRegistry
/// @notice AI agents that propose strikes for Strike vaults. Each agent has an owner, a signer key (the only key that
///         may propose), a payout address for its fee share, an optional ERC-8004 identity, and a USDG bond.
/// @dev A proposal the vault's mandate rejects costs the agent `slashAmount` of its bond (paid to that vault's
///      depositors) and a strike; at `maxStrikes` the agent is suspended. Unbonding takes `unbondDelay`, and bond in
///      the unbonding queue can still be slashed, so an agent cannot misbehave and exit in the same week.
///      A signer key that is not the caller must consent with an EIP-712 signature (`Register` or `SetSigner`), so
///      nobody can bind someone else's address as a signer and block it ("one agent per signer").
contract AgentRegistry is AccessControl, EIP712, Nonces, IAgentRegistry {
    using SafeERC20 for IERC20;

    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    /// @notice The signer's consent to be registered as the signer of a new agent owned by `owner`.
    bytes32 public constant REGISTER_TYPEHASH =
        keccak256("Register(address owner,address payout,uint256 erc8004Id,uint256 nonce,uint256 deadline)");
    /// @notice The signer's consent to become the signer of agent `agentId`, owned by `owner`.
    bytes32 public constant SET_SIGNER_TYPEHASH =
        keccak256("SetSigner(address owner,uint256 agentId,uint256 nonce,uint256 deadline)");

    enum Status {
        None,
        Active,
        Suspended,
        Retired
    }

    struct Agent {
        address owner;
        address signer;
        address payout;
        Status status;
        uint32 strikes;
        uint32 accepted;
        uint32 rejected;
        uint64 unbondAt;
        uint256 erc8004Id;
        uint256 bond;
        uint256 unbonding;
    }

    IERC20 public immutable usdg;
    /// @notice ERC-8004 Identity Registry (ERC-721). Zero disables identity checks.
    IERC721 public identityRegistry;
    uint256 public minBond;
    uint256 public slashAmount;
    uint32 public maxStrikes;
    uint32 public unbondDelay;

    /// @notice ERC-8004 Reputation Registry. When set, settled epochs and mandate rejections are posted as feedback
    ///         to the agent's linked ERC-8004 identity. Zero disables feedback.
    IERC8004Reputation public reputationRegistry;

    struct Track {
        uint32 settledEpochs;
        int256 cumulativePnl; // USDG base units
    }

    uint256 public agentCount;
    /// @notice On-chain track record per agent.
    mapping(uint256 agentId => Track) public track;
    mapping(uint256 agentId => Agent) internal _agents;
    /// @notice Agent id for a signer key (0 if none).
    mapping(address signer => uint256 agentId) public agentOfSigner;

    event AgentRegistered(uint256 indexed agentId, address indexed owner, address signer, uint256 erc8004Id);
    event SignerSet(uint256 indexed agentId, address signer);
    event PayoutSet(uint256 indexed agentId, address payout);
    event BondPosted(uint256 indexed agentId, address indexed from, uint256 amount);
    event UnbondRequested(uint256 indexed agentId, uint256 amount, uint64 availableAt);
    event Unbonded(uint256 indexed agentId, address to, uint256 amount);
    event Slashed(uint256 indexed agentId, address indexed recipient, uint256 amount, uint32 strikes);
    event StatusSet(uint256 indexed agentId, Status status);
    event ProposalRecorded(uint256 indexed agentId, bool accepted);
    event ParamsSet(uint256 minBond, uint256 slashAmount, uint32 maxStrikes, uint32 unbondDelay);
    event IdentityRegistrySet(address registry);
    event ReputationRegistrySet(address registry);
    event EpochResultRecorded(uint256 indexed agentId, int256 pnl, uint32 settledEpochs, int256 cumulativePnl);
    event ReputationFeedback(uint256 indexed agentId, uint256 indexed erc8004Id, int128 value, string tag, bool posted);

    error ZeroAddress();
    error NotOwner(uint256 agentId);
    error UnknownAgent(uint256 agentId);
    error SignerTaken(address signer);
    error NotIdentityOwner(uint256 erc8004Id);
    error ZeroAmount();
    error InsufficientBond(uint256 requested, uint256 available);
    error NothingUnbonding();
    error UnbondPending(uint64 availableAt);
    error InvalidParams();
    error InvalidStatus(Status status);
    error ConsentExpired(uint256 deadline);
    error InvalidConsent(address signer);

    constructor(
        address admin,
        IERC20 usdg_,
        IERC721 identityRegistry_,
        uint256 minBond_,
        uint256 slashAmount_,
        uint32 maxStrikes_,
        uint32 unbondDelay_
    ) EIP712("Strike AgentRegistry", "1") {
        if (admin == address(0) || address(usdg_) == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdg = usdg_;
        identityRegistry = identityRegistry_;
        _setParams(minBond_, slashAmount_, maxStrikes_, unbondDelay_);
    }

    // ------------------------------------------------------------------ agent owner

    /// @notice Register an agent owned by the caller. With an ERC-8004 id, the caller must own that identity.
    /// @param deadline Last timestamp at which the signer's consent is valid.
    /// @param signature The signer's EIP-712 `Register` consent. Both are ignored (pass 0 and empty bytes) when the
    ///        caller registers itself as the signer.
    function register(address signer, address payout, uint256 erc8004Id, uint256 deadline, bytes calldata signature)
        external
        returns (uint256 agentId)
    {
        if (signer == address(0) || payout == address(0)) revert ZeroAddress();
        if (agentOfSigner[signer] != 0) revert SignerTaken(signer);
        if (signer != msg.sender) {
            bytes32 structHash =
                keccak256(abi.encode(REGISTER_TYPEHASH, msg.sender, payout, erc8004Id, _useNonce(signer), deadline));
            _checkConsent(signer, structHash, deadline, signature);
        }
        _checkIdentity(erc8004Id);
        agentId = ++agentCount;
        Agent storage a = _agents[agentId];
        a.owner = msg.sender;
        a.signer = signer;
        a.payout = payout;
        a.erc8004Id = erc8004Id;
        a.status = Status.Active;
        agentOfSigner[signer] = agentId;
        emit AgentRegistered(agentId, msg.sender, signer, erc8004Id);
    }

    /// @notice Rotate the signer key (for example after a key compromise).
    /// @param deadline Last timestamp at which the new signer's consent is valid.
    /// @param signature The new signer's EIP-712 `SetSigner` consent. Both are ignored when the owner sets itself.
    function setSigner(uint256 agentId, address signer, uint256 deadline, bytes calldata signature) external {
        Agent storage a = _owned(agentId);
        if (signer == address(0)) revert ZeroAddress();
        if (agentOfSigner[signer] != 0) revert SignerTaken(signer);
        if (signer != msg.sender) {
            bytes32 structHash =
                keccak256(abi.encode(SET_SIGNER_TYPEHASH, msg.sender, agentId, _useNonce(signer), deadline));
            _checkConsent(signer, structHash, deadline, signature);
        }
        delete agentOfSigner[a.signer];
        a.signer = signer;
        agentOfSigner[signer] = agentId;
        emit SignerSet(agentId, signer);
    }

    function setPayout(uint256 agentId, address payout) external {
        Agent storage a = _owned(agentId);
        if (payout == address(0)) revert ZeroAddress();
        a.payout = payout;
        emit PayoutSet(agentId, payout);
    }

    /// @notice Link (or change) the ERC-8004 identity. The caller must own it.
    function setIdentity(uint256 agentId, uint256 erc8004Id) external {
        Agent storage a = _owned(agentId);
        _checkIdentity(erc8004Id);
        a.erc8004Id = erc8004Id;
        emit AgentRegistered(agentId, a.owner, a.signer, erc8004Id);
    }

    /// @notice Add USDG to an agent's bond. Anyone may top up.
    function postBond(uint256 agentId, uint256 amount) external {
        Agent storage a = _known(agentId);
        if (amount == 0) revert ZeroAmount();
        a.bond += amount;
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit BondPosted(agentId, msg.sender, amount);
    }

    /// @notice Start unbonding. The amount stays slashable until it is withdrawn.
    function requestUnbond(uint256 agentId, uint256 amount) external {
        Agent storage a = _owned(agentId);
        if (amount == 0) revert ZeroAmount();
        if (amount > a.bond) revert InsufficientBond(amount, a.bond);
        a.bond -= amount;
        a.unbonding += amount;
        a.unbondAt = uint64(block.timestamp) + unbondDelay;
        emit UnbondRequested(agentId, amount, a.unbondAt);
    }

    function withdrawUnbonded(uint256 agentId, address to) external returns (uint256 amount) {
        Agent storage a = _owned(agentId);
        if (to == address(0)) revert ZeroAddress();
        amount = a.unbonding;
        if (amount == 0) revert NothingUnbonding();
        if (block.timestamp < a.unbondAt) revert UnbondPending(a.unbondAt);
        a.unbonding = 0;
        usdg.safeTransfer(to, amount);
        emit Unbonded(agentId, to, amount);
    }

    /// @notice An owner can retire their agent at once (it can no longer propose).
    function retire(uint256 agentId) external {
        _owned(agentId).status = Status.Retired;
        emit StatusSet(agentId, Status.Retired);
    }

    // ------------------------------------------------------------------ protocol

    /// @notice Penalise a rejected proposal: move up to `slashAmount` (bond first, then unbonding) to `recipient`.
    function slash(uint256 agentId, address recipient) external onlyRole(SLASHER_ROLE) returns (uint256 amount) {
        Agent storage a = _known(agentId);
        if (recipient == address(0)) revert ZeroAddress();
        amount = slashAmount;
        uint256 fromBond = amount < a.bond ? amount : a.bond;
        a.bond -= fromBond;
        uint256 rest = amount - fromBond;
        uint256 fromUnbonding = rest < a.unbonding ? rest : a.unbonding;
        a.unbonding -= fromUnbonding;
        amount = fromBond + fromUnbonding;

        uint32 strikes = ++a.strikes;
        ++a.rejected;
        if (strikes >= maxStrikes && a.status == Status.Active) {
            a.status = Status.Suspended;
            emit StatusSet(agentId, Status.Suspended);
        }
        emit Slashed(agentId, recipient, amount, strikes);
        _feedback(agentId, a.erc8004Id, -SafeCast.toInt128(SafeCast.toInt256(amount)), "strike.mandate.rejection");
        if (amount != 0) usdg.safeTransfer(recipient, amount);
    }

    /// @notice Count an accepted proposal (the on-chain track record).
    function recordAccepted(uint256 agentId) external onlyRole(SLASHER_ROLE) {
        ++_known(agentId).accepted;
        emit ProposalRecorded(agentId, true);
    }

    /// @notice Record a settled epoch and post it to ERC-8004 as feedback (value = PnL in USDG, 6 decimals).
    function recordEpochResult(uint256 agentId, int256 pnl) external onlyRole(SLASHER_ROLE) {
        Agent storage a = _known(agentId);
        Track storage t = track[agentId];
        ++t.settledEpochs;
        t.cumulativePnl += pnl;
        emit EpochResultRecorded(agentId, pnl, t.settledEpochs, t.cumulativePnl);
        // Clamp into int128 (PnL of a single epoch never gets close).
        int256 v =
            pnl > type(int128).max ? int256(type(int128).max) : pnl < type(int128).min ? int256(type(int128).min) : pnl;
        // forge-lint: disable-next-line(unsafe-typecast)
        _feedback(agentId, a.erc8004Id, int128(v), "strike.epoch.pnl");
    }

    // ------------------------------------------------------------------ admin

    /// @notice Suspend or reinstate an agent (reinstating clears its strikes).
    function setStatus(uint256 agentId, Status status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Agent storage a = _known(agentId);
        if (status == Status.None) revert InvalidStatus(status);
        if (status == Status.Active) a.strikes = 0;
        a.status = status;
        emit StatusSet(agentId, status);
    }

    function setParams(uint256 minBond_, uint256 slashAmount_, uint32 maxStrikes_, uint32 unbondDelay_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setParams(minBond_, slashAmount_, maxStrikes_, unbondDelay_);
    }

    function setReputationRegistry(IERC8004Reputation registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        reputationRegistry = registry;
        emit ReputationRegistrySet(address(registry));
    }

    function setIdentityRegistry(IERC721 registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        identityRegistry = registry;
        emit IdentityRegistrySet(address(registry));
    }

    // ------------------------------------------------------------------ views

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return _agents[agentId];
    }

    /// @notice May propose: active, bonded at least `minBond`, under the strike limit.
    function isActive(uint256 agentId) public view returns (bool) {
        Agent storage a = _agents[agentId];
        return a.status == Status.Active && a.bond >= minBond && a.strikes < maxStrikes;
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest `signer` signs to consent to `register` by `owner` (at the signer's next nonce).
    function registerDigest(address signer, address owner, address payout, uint256 erc8004Id, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(REGISTER_TYPEHASH, owner, payout, erc8004Id, nonces(signer), deadline))
        );
    }

    /// @notice The EIP-712 digest `signer` signs to consent to `setSigner` on `agentId` (at the signer's next nonce).
    function setSignerDigest(address signer, uint256 agentId, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SET_SIGNER_TYPEHASH, _agents[agentId].owner, agentId, nonces(signer), deadline))
        );
    }

    function signerOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].signer;
    }

    function payoutOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].payout;
    }

    // ------------------------------------------------------------------ internals

    function _known(uint256 agentId) internal view returns (Agent storage a) {
        a = _agents[agentId];
        if (a.status == Status.None) revert UnknownAgent(agentId);
    }

    function _owned(uint256 agentId) internal view returns (Agent storage a) {
        a = _known(agentId);
        if (msg.sender != a.owner) revert NotOwner(agentId);
    }

    /// @dev Best effort: a failing or missing reputation registry never blocks settlement or slashing.
    function _feedback(uint256 agentId, uint256 erc8004Id, int128 value, string memory tag) internal {
        if (erc8004Id == 0 || address(reputationRegistry) == address(0)) return;
        bool posted;
        // Only while the agent's owner still holds the identity: a transferred identity keeps no Strike record.
        if (_holdsIdentity(_agents[agentId].owner, erc8004Id)) {
            try reputationRegistry.giveFeedback(erc8004Id, value, 6, tag, "", "", "", bytes32(0)) {
                posted = true;
            } catch {}
        }
        emit ReputationFeedback(agentId, erc8004Id, value, tag, posted);
    }

    function _holdsIdentity(address owner, uint256 erc8004Id) internal view returns (bool) {
        if (address(identityRegistry) == address(0)) return true;
        try identityRegistry.ownerOf(erc8004Id) returns (address holder) {
            return holder == owner;
        } catch {
            return false;
        }
    }

    /// @dev The nonce is already consumed by the caller, so a signature works once. Only ECDSA (EOA) signers can
    ///      consent; a contract signer registers itself (`signer == msg.sender`).
    function _checkConsent(address signer, bytes32 structHash, uint256 deadline, bytes calldata signature)
        internal
        view
    {
        if (block.timestamp > deadline) revert ConsentExpired(deadline);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), signature);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert InvalidConsent(signer);
    }

    function _checkIdentity(uint256 erc8004Id) internal view {
        if (erc8004Id == 0 || address(identityRegistry) == address(0)) return;
        if (identityRegistry.ownerOf(erc8004Id) != msg.sender) revert NotIdentityOwner(erc8004Id);
    }

    function _setParams(uint256 minBond_, uint256 slashAmount_, uint32 maxStrikes_, uint32 unbondDelay_) internal {
        if (maxStrikes_ == 0 || unbondDelay_ < 1 days || unbondDelay_ > 60 days) revert InvalidParams();
        (minBond, slashAmount, maxStrikes, unbondDelay) = (minBond_, slashAmount_, maxStrikes_, unbondDelay_);
        emit ParamsSet(minBond_, slashAmount_, maxStrikes_, unbondDelay_);
    }
}
