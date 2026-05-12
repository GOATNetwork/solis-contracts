// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.35;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {ISolisEscrow} from "./interfaces/ISolisEscrow.sol";
import {IUSDCAuth} from "./interfaces/IUSDCAuth.sol";

/// @title SolisEscrow
/// @notice Holds Matter funds after Payor payment, then releases or refunds after Recipient action.
/// @dev This contract is intentionally non-upgradeable. New versions should be deployed separately and
/// discovered through SolisRegistry.
contract SolisEscrow is ISolisEscrow, Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    string public constant ESCROW_VERSION = "1.3.0";

    /// @dev Must match the off-chain SolisMatter typed data exactly.
    bytes32 public constant SOLIS_MATTER_TYPEHASH = keccak256(
        "SolisMatter(bytes32 matterId,bytes32 settlementDigest,address payor,address recipient,address mediator,address platformFeeRecipient,address token,uint256 grossAmount,uint256 recipientAmount,uint256 platformFeeAmount,uint256 mediatorFeeAmount,uint64 paymentDeadline,uint64 confirmationDeadline,uint256 registryVersion)"
    );

    /// @notice Registry version this escrow accepts in signed Matter payloads.
    uint256 public immutable registryVersion;

    /// @notice Token accepted for all Matter funding in this escrow version.
    address public immutable settlementToken;

    /// @notice Registry used by clients for version discovery. It does not control escrowed funds.
    address public immutable registry;

    mapping(bytes32 => Matter) private _matters;
    /// @notice Per-token total currently committed to unreleased or unrefunded Matters.
    mapping(address => uint256) public accountedBalance;
    /// @notice Active platform signers accepted for Matter approvals.
    mapping(address => bool) public platformSigners;
    /// @notice Accounts allowed to pause/unpause Matters and the global contract.
    mapping(address => bool) public pausers;

    /// @dev Signers are tracked in a list for discovery; signature verification uses an explicit signer hint.
    address[] private _platformSignerList;
    mapping(address => bool) private _knownPlatformSigner;

    event MatterPaid(
        bytes32 indexed matterId,
        bytes32 indexed settlementDigest,
        address indexed payor,
        address recipient,
        address mediator,
        address token,
        uint256 grossAmount,
        uint256 recipientAmount,
        uint256 platformFeeAmount,
        uint256 mediatorFeeAmount,
        address platformFeeRecipient,
        uint64 paymentDeadline,
        uint64 confirmationDeadline,
        uint256 registryVersion
    );
    event MatterRecipientConfirmed(
        bytes32 indexed matterId, address indexed recipient, bytes32 settlementDigest, uint64 confirmedAt
    );
    event MatterReleased(
        bytes32 indexed matterId,
        address indexed recipient,
        uint256 recipientAmount,
        address platformFeeRecipient,
        uint256 platformFeeAmount,
        address mediator,
        uint256 mediatorFeeAmount,
        uint64 releasedAt
    );
    event MatterRecipientRejected(
        bytes32 indexed matterId, address indexed recipient, bytes32 settlementDigest, uint64 rejectedAt
    );
    event MatterRefunded(
        bytes32 indexed matterId, address indexed payor, uint256 refundAmount, uint64 refundedAt, bytes32 reason
    );
    event MatterPaused(bytes32 indexed matterId, bytes32 indexed reasonHash, address indexed operator);
    event MatterUnpaused(bytes32 indexed matterId, address indexed operator);
    event PlatformSignerUpdated(address indexed signer, bool active);
    event PauserUpdated(address indexed pauser, bool active);
    event ExcessTokenSwept(address indexed token, address indexed to, uint256 amount);

    error MatterAlreadyExists(bytes32 matterId);
    error MatterNotFound(bytes32 matterId);
    error InvalidStatus(bytes32 matterId, MatterStatus status);
    error InvalidAddress();
    error InvalidToken(address token);
    error InvalidAmount();
    error InvalidDeadline();
    error PaymentDeadlineExpired();
    error ConfirmationDeadlineExpired();
    error ConfirmationDeadlineNotReached();
    error InvalidPlatformSignature();
    error InvalidFundingAmount(address token, uint256 expectedAmount, uint256 actualAmount);
    error Unauthorized();
    error MatterPausedError(bytes32 matterId);
    error InvalidVersion();
    error MatterParameterMismatch(bytes32 matterId);

    bytes32 private constant _REFUND_REASON_RECIPIENT_REJECTED = keccak256("RECIPIENT_REJECTED");
    bytes32 private constant _REFUND_REASON_CONFIRMATION_EXPIRED = keccak256("CONFIRMATION_EXPIRED");

    modifier onlyPauser() {
        if (!_isPlatformOperator(msg.sender)) revert Unauthorized();
        _;
    }

    /// @notice Deploys a single-version escrow instance.
    /// @param initialOwner Owner for configuration operations. Use a multisig in production.
    /// @param initialPlatformSigner First signer authorized to approve platform Matter data.
    /// @param initialPauser First operator authorized to pause Matters or the whole contract.
    /// @param initialToken Settlement token accepted by this escrow version.
    /// @param initialRegistry Registry used for discovery.
    /// @param initialRegistryVersion Version number that signed Matter payloads must include.
    constructor(
        address initialOwner,
        address initialPlatformSigner,
        address initialPauser,
        address initialToken,
        address initialRegistry,
        uint256 initialRegistryVersion
    ) Ownable(initialOwner) EIP712("SolisEscrow", "1") {
        if (initialRegistryVersion == 0) revert InvalidVersion();
        if (initialToken == address(0) || initialRegistry == address(0) || initialRegistry.code.length == 0) {
            revert InvalidAddress();
        }

        settlementToken = initialToken;
        registry = initialRegistry;
        registryVersion = initialRegistryVersion;

        _setPlatformSigner(initialPlatformSigner, true);
        _setPauser(initialPauser, true);
    }

    /// @notice Payor funds a platform-approved Matter through USDC receiveWithAuthorization.
    /// @dev Payor submits the transaction; the USDC authorization moves exactly `grossAmount` into escrow.
    function payAndSubmitMatter(
        MatterParams calldata params,
        PlatformSignature calldata platformSig,
        USDCAuthorization calldata auth
    ) external nonReentrant whenNotPaused {
        if (msg.sender != params.payor) revert Unauthorized();
        _validateNewMatterParams(params);
        _requireValidPlatformSignature(platformSig.signer, hashMatter(params), platformSig.signature);

        uint256 balanceBefore = IERC20(params.token).balanceOf(address(this));
        IUSDCAuth(params.token)
            .receiveWithAuthorization(
                params.payor,
                address(this),
                params.grossAmount,
                auth.validAfter,
                auth.validBefore,
                auth.nonce,
                auth.v,
                auth.r,
                auth.s
            );
        _requireExactFunding(params.token, balanceBefore, params.grossAmount);

        _recordPaidMatter(params);
    }

    /// @notice Recipient confirms the Matter terms and immediately releases escrowed funds.
    /// @dev The full Matter params are calldata-bound to the wallet transaction and must match stored data.
    function confirmAndRelease(MatterParams calldata params) external nonReentrant whenNotPaused {
        Matter storage matter = _existingMatter(params.matterId);
        _requireRecipientActionable(params, matter);
        if (msg.sender != matter.recipient) revert Unauthorized();

        matter.status = MatterStatus.RecipientConfirmed;
        matter.confirmedAt = uint64(block.timestamp);

        emit MatterRecipientConfirmed(params.matterId, matter.recipient, matter.settlementDigest, matter.confirmedAt);

        _release(params.matterId, matter);
    }

    /// @notice Recipient rejects the Matter terms and refunds all escrowed funds to the Payor.
    /// @dev Rejection affects escrowed funds, so only the Recipient wallet may call this function.
    function rejectAndRefund(MatterParams calldata params) external nonReentrant whenNotPaused {
        Matter storage matter = _existingMatter(params.matterId);
        _requireRecipientActionable(params, matter);
        if (msg.sender != matter.recipient) revert Unauthorized();

        matter.status = MatterStatus.RecipientRejected;
        matter.rejectedAt = uint64(block.timestamp);

        emit MatterRecipientRejected(params.matterId, matter.recipient, matter.settlementDigest, matter.rejectedAt);

        _refund(params.matterId, matter, _REFUND_REASON_RECIPIENT_REJECTED);
    }

    /// @notice Refunds a Paid Matter after the Recipient confirmation deadline has passed.
    /// @dev Callable only by the Payor or a platform operator; the refund recipient is always the Payor.
    function refundAfterConfirmationDeadline(bytes32 matterId) external nonReentrant whenNotPaused {
        Matter storage matter = _existingMatter(matterId);
        if (matter.status == MatterStatus.Paused) revert MatterPausedError(matterId);
        if (matter.status != MatterStatus.Paid) revert InvalidStatus(matterId, matter.status);
        if (block.timestamp <= matter.confirmationDeadline) revert ConfirmationDeadlineNotReached();
        if (msg.sender != matter.payor && !_isPlatformOperator(msg.sender)) revert Unauthorized();

        _refund(matterId, matter, _REFUND_REASON_CONFIRMATION_EXPIRED);
    }

    /// @notice Pauses a paid Matter without changing its escrowed balance.
    /// @dev `reasonHash` should commit to off-chain compliance or security context without exposing PII.
    function pauseMatter(bytes32 matterId, bytes32 reasonHash) external onlyPauser {
        Matter storage matter = _existingMatter(matterId);
        if (matter.status != MatterStatus.Paid) revert InvalidStatus(matterId, matter.status);

        matter.status = MatterStatus.Paused;

        emit MatterPaused(matterId, reasonHash, msg.sender);
    }

    /// @notice Restores a paused Matter to Paid status.
    function unpauseMatter(bytes32 matterId) external onlyPauser {
        Matter storage matter = _existingMatter(matterId);
        if (matter.status != MatterStatus.Paused) revert InvalidStatus(matterId, matter.status);

        matter.status = MatterStatus.Paid;

        emit MatterUnpaused(matterId, msg.sender);
    }

    /// @notice Pauses all funding, confirmation, rejection, and refund operations.
    function pause() external onlyPauser {
        _pause();
    }

    /// @notice Unpauses global escrow operations.
    function unpause() external onlyPauser {
        _unpause();
    }

    /// @notice Adds a new active platform signer.
    /// @dev Kept for the existing API; `setPlatformSigner` should be used when deactivating signers.
    function updatePlatformSigner(address newSigner) external onlyOwner {
        _setPlatformSigner(newSigner, true);
    }

    /// @notice Enables or disables a platform signer for future Matter approvals.
    function setPlatformSigner(address signer, bool active) external onlyOwner {
        _setPlatformSigner(signer, active);
    }

    /// @notice Enables or disables a pauser account.
    function setPauser(address pauser, bool active) external onlyOwner {
        _setPauser(pauser, active);
    }

    /// @notice Transfers tokens not accounted for by active escrow balances.
    /// @dev This cannot withdraw funds committed to Paid or Paused Matters.
    function sweepExcessToken(address token, address to, uint256 amount) external nonReentrant onlyOwner {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 accounted = accountedBalance[token];
        if (balance <= accounted) revert InvalidAmount();

        uint256 excess = balance - accounted;
        if (amount > excess) revert InvalidAmount();

        IERC20(token).safeTransfer(to, amount);

        emit ExcessTokenSwept(token, to, amount);
    }

    /// @notice Returns the EIP-712 digest the platform signer must sign for Matter payment.
    function hashMatter(MatterParams calldata params) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SOLIS_MATTER_TYPEHASH,
                    params.matterId,
                    params.settlementDigest,
                    params.payor,
                    params.recipient,
                    params.mediator,
                    params.platformFeeRecipient,
                    params.token,
                    params.grossAmount,
                    params.recipientAmount,
                    params.platformFeeAmount,
                    params.mediatorFeeAmount,
                    params.paymentDeadline,
                    params.confirmationDeadline,
                    params.registryVersion
                )
            )
        );
    }

    /// @notice Returns the stored Matter data for `matterId`.
    function getMatter(bytes32 matterId) external view returns (Matter memory) {
        return _matters[matterId];
    }

    /// @notice Returns the Matter status, or None for an unknown Matter.
    function getMatterStatus(bytes32 matterId) external view returns (MatterStatus) {
        return _matters[matterId].status;
    }

    /// @notice Returns the off-chain settlement digest committed by a paid Matter.
    function getSettlementDigest(bytes32 matterId) external view returns (bytes32) {
        return _existingMatter(matterId).settlementDigest;
    }

    /// @notice Returns payment and recipient confirmation deadlines for a Matter.
    function getDeadlines(bytes32 matterId)
        external
        view
        returns (uint64 paymentDeadline, uint64 confirmationDeadline)
    {
        Matter storage matter = _existingMatter(matterId);
        paymentDeadline = matter.paymentDeadline;
        confirmationDeadline = matter.confirmationDeadline;
    }

    /// @notice Returns whether Recipient can currently confirm or reject a Matter.
    function isRecipientActionable(bytes32 matterId) external view returns (bool) {
        Matter storage matter = _matters[matterId];
        return matter.settlementDigest != bytes32(0) && matter.status == MatterStatus.Paid
            && block.timestamp <= matter.confirmationDeadline;
    }

    /// @notice Returns the recipient, platform, mediator, and gross payout amounts.
    function getPayoutBreakdown(bytes32 matterId)
        external
        view
        returns (uint256 recipientAmount, uint256 platformFeeAmount, uint256 mediatorFeeAmount, uint256 grossAmount)
    {
        Matter storage matter = _existingMatter(matterId);
        recipientAmount = matter.recipientAmount;
        platformFeeAmount = matter.platformFeeAmount;
        mediatorFeeAmount = matter.mediatorFeeAmount;
        grossAmount = _grossAmount(matter);
    }

    /// @notice Returns every signer ever added through signer management.
    /// @dev Check `platformSigners[signer]` to know whether a returned signer is currently active.
    function getPlatformSigners() external view returns (address[] memory) {
        return _platformSignerList;
    }

    function _validateNewMatterParams(MatterParams calldata params) private view {
        if (_matters[params.matterId].settlementDigest != bytes32(0)) {
            revert MatterAlreadyExists(params.matterId);
        }
        _validateMatterParamsShape(params);
        if (block.timestamp > params.paymentDeadline) revert PaymentDeadlineExpired();
    }

    function _validateMatterParamsShape(MatterParams calldata params) private view {
        if (params.matterId == bytes32(0) || params.settlementDigest == bytes32(0)) {
            revert InvalidAddress();
        }
        if (params.token != settlementToken) revert InvalidToken(params.token);
        if (params.registryVersion != registryVersion) revert InvalidVersion();
        if (params.paymentDeadline == 0 || params.confirmationDeadline <= params.paymentDeadline) {
            revert InvalidDeadline();
        }

        _validateAddresses(params);
        _validateAmounts(params);
    }

    function _validateAddresses(MatterParams calldata params) private pure {
        if (
            params.payor == address(0) || params.recipient == address(0) || params.mediator == address(0)
                || params.platformFeeRecipient == address(0) || params.token == address(0)
        ) {
            revert InvalidAddress();
        }

        if (
            params.payor == params.recipient || params.payor == params.mediator
                || params.payor == params.platformFeeRecipient || params.recipient == params.mediator
                || params.recipient == params.platformFeeRecipient || params.mediator == params.platformFeeRecipient
        ) {
            revert InvalidAddress();
        }
    }

    function _validateAmounts(MatterParams calldata params) private pure {
        uint256 expectedGross = params.recipientAmount + params.platformFeeAmount + params.mediatorFeeAmount;

        if (params.grossAmount == 0 || params.recipientAmount == 0 || params.grossAmount != expectedGross) {
            revert InvalidAmount();
        }
    }

    function _recordPaidMatter(MatterParams calldata params) private {
        Matter storage matter = _matters[params.matterId];
        matter.settlementDigest = params.settlementDigest;
        matter.payor = params.payor;
        matter.recipient = params.recipient;
        matter.mediator = params.mediator;
        matter.platformFeeRecipient = params.platformFeeRecipient;
        matter.token = params.token;
        matter.recipientAmount = params.recipientAmount;
        matter.platformFeeAmount = params.platformFeeAmount;
        matter.mediatorFeeAmount = params.mediatorFeeAmount;
        matter.status = MatterStatus.Paid;
        matter.paymentDeadline = params.paymentDeadline;
        matter.confirmationDeadline = params.confirmationDeadline;
        matter.submittedAt = uint64(block.timestamp);

        // This balance is decremented before external transfers on release/refund.
        accountedBalance[params.token] += params.grossAmount;

        emit MatterPaid(
            params.matterId,
            params.settlementDigest,
            params.payor,
            params.recipient,
            params.mediator,
            params.token,
            params.grossAmount,
            params.recipientAmount,
            params.platformFeeAmount,
            params.mediatorFeeAmount,
            params.platformFeeRecipient,
            params.paymentDeadline,
            params.confirmationDeadline,
            params.registryVersion
        );
    }

    function _requireRecipientActionable(MatterParams calldata params, Matter storage matter) private view {
        if (matter.status == MatterStatus.Paused) revert MatterPausedError(params.matterId);
        if (matter.status != MatterStatus.Paid) revert InvalidStatus(params.matterId, matter.status);
        if (block.timestamp > matter.confirmationDeadline) revert ConfirmationDeadlineExpired();
        _requireMatterSnapshot(params, matter);
    }

    function _requireMatterSnapshot(MatterParams calldata params, Matter storage matter) private view {
        if (
            matter.settlementDigest != params.settlementDigest || matter.payor != params.payor
                || matter.recipient != params.recipient || matter.mediator != params.mediator
                || matter.platformFeeRecipient != params.platformFeeRecipient || matter.token != params.token
                || _grossAmount(matter) != params.grossAmount || matter.recipientAmount != params.recipientAmount
                || matter.platformFeeAmount != params.platformFeeAmount
                || matter.mediatorFeeAmount != params.mediatorFeeAmount
                || matter.paymentDeadline != params.paymentDeadline
                || matter.confirmationDeadline != params.confirmationDeadline
                || params.registryVersion != registryVersion
        ) {
            revert MatterParameterMismatch(params.matterId);
        }
    }

    function _release(bytes32 matterId, Matter storage matter) private {
        uint256 grossAmount = _grossAmount(matter);
        // Effects are committed before token transfers to prevent duplicate release through reentrancy.
        matter.status = MatterStatus.Released;
        matter.releasedAt = uint64(block.timestamp);
        accountedBalance[matter.token] -= grossAmount;

        if (matter.platformFeeAmount != 0) {
            IERC20(matter.token).safeTransfer(matter.platformFeeRecipient, matter.platformFeeAmount);
        }
        if (matter.mediatorFeeAmount != 0) {
            IERC20(matter.token).safeTransfer(matter.mediator, matter.mediatorFeeAmount);
        }
        IERC20(matter.token).safeTransfer(matter.recipient, matter.recipientAmount);

        emit MatterReleased(
            matterId,
            matter.recipient,
            matter.recipientAmount,
            matter.platformFeeRecipient,
            matter.platformFeeAmount,
            matter.mediator,
            matter.mediatorFeeAmount,
            matter.releasedAt
        );
    }

    function _refund(bytes32 matterId, Matter storage matter, bytes32 reason) private {
        uint256 refundAmount = _grossAmount(matter);
        // Effects are committed before token transfer so refund cannot be duplicated by reentrancy.
        matter.status = MatterStatus.Refunded;
        matter.refundedAt = uint64(block.timestamp);
        accountedBalance[matter.token] -= refundAmount;

        IERC20(matter.token).safeTransfer(matter.payor, refundAmount);

        emit MatterRefunded(matterId, matter.payor, refundAmount, matter.refundedAt, reason);
    }

    function _requireValidPlatformSignature(address signer, bytes32 digest, bytes calldata signature) private view {
        if (!platformSigners[signer]) revert InvalidPlatformSignature();
        if (!SignatureChecker.isValidSignatureNowCalldata(signer, digest, signature)) {
            revert InvalidPlatformSignature();
        }
    }

    function _requireExactFunding(address token, uint256 balanceBefore, uint256 expectedAmount) private view {
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        uint256 actualAmount = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (actualAmount != expectedAmount) revert InvalidFundingAmount(token, expectedAmount, actualAmount);
    }

    function _setPlatformSigner(address signer, bool active) private {
        if (signer == address(0)) revert InvalidAddress();

        if (!_knownPlatformSigner[signer]) {
            _knownPlatformSigner[signer] = true;
            _platformSignerList.push(signer);
        }

        platformSigners[signer] = active;

        emit PlatformSignerUpdated(signer, active);
    }

    function _setPauser(address pauser, bool active) private {
        if (pauser == address(0)) revert InvalidAddress();

        pausers[pauser] = active;

        emit PauserUpdated(pauser, active);
    }

    function _existingMatter(bytes32 matterId) private view returns (Matter storage matter) {
        matter = _matters[matterId];
        if (matter.settlementDigest == bytes32(0)) revert MatterNotFound(matterId);
    }

    function _grossAmount(Matter storage matter) private view returns (uint256) {
        return matter.recipientAmount + matter.platformFeeAmount + matter.mediatorFeeAmount;
    }

    function _isPlatformOperator(address account) private view returns (bool) {
        return account == owner() || pausers[account];
    }
}
