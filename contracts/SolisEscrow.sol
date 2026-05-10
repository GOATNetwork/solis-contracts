// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

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
/// @notice Holds and releases settlement funds after all required off-chain parties sign the same Matter.
/// @dev This contract is intentionally non-upgradeable. New versions should be deployed separately and
/// discovered through SolisRegistry.
contract SolisEscrow is ISolisEscrow, Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    string public constant ESCROW_VERSION = "1.0.0";

    /// @dev Must match the off-chain SolisMatter typed data exactly.
    bytes32 public constant SOLIS_MATTER_TYPEHASH = keccak256(
        "SolisMatter(bytes32 matterId,bytes32 settlementDigest,address payor,address recipient,address mediator,address platformFeeRecipient,address token,uint256 grossAmount,uint256 recipientAmount,uint256 platformFeeAmount,uint256 mediatorFeeAmount,uint8 payoutRule,uint64 releaseTime,uint64 submitDeadline,uint256 registryVersion)"
    );

    /// @dev Cancellation signatures are bound to the funded Matter snapshot to prevent parameter substitution.
    bytes32 public constant SOLIS_CANCELLATION_TYPEHASH = keccak256(
        "SolisCancellation(bytes32 matterId,bytes32 settlementDigest,address payor,address recipient,address mediator,address platformFeeRecipient,address token,uint256 refundAmount,uint64 submittedAt)"
    );

    /// @notice Registry version this escrow accepts in signed Matter payloads.
    uint256 public immutable registryVersion;

    /// @notice Registry used by clients for version discovery. It does not control escrowed funds.
    address public registry;

    mapping(bytes32 => Matter) private _matters;
    /// @notice Tokens allowed for new Matter funding.
    mapping(address => bool) public allowedTokens;
    /// @notice Per-token total currently committed to unreleased or unrefunded Matters.
    mapping(address => uint256) public accountedBalance;
    /// @notice Active platform signers accepted for Matter and cancellation approvals.
    mapping(address => bool) public platformSigners;
    /// @notice Accounts allowed to pause/unpause Matters and the global contract.
    mapping(address => bool) public pausers;

    /// @dev Active signers are tracked in a list so platform signatures can be checked without caller hints.
    address[] private _platformSignerList;
    mapping(address => bool) private _knownPlatformSigner;

    event MatterSubmittedAndFunded(
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
        PayoutRule payoutRule,
        uint64 releaseTime,
        uint256 registryVersion
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
    event MatterCancelledAndRefunded(
        bytes32 indexed matterId,
        address indexed payor,
        uint256 refundAmount,
        uint64 refundedAt,
        bytes32 cancellationDigest
    );
    event MatterPaused(bytes32 indexed matterId, bytes32 indexed reasonHash, address indexed operator);
    event MatterUnpaused(bytes32 indexed matterId, address indexed operator);
    event PlatformSignerUpdated(address indexed signer, bool active);
    event PauserUpdated(address indexed pauser, bool active);
    event AllowedTokenUpdated(address indexed token, bool allowed);
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ExcessTokenSwept(address indexed token, address indexed to, uint256 amount);

    error MatterAlreadyExists(bytes32 matterId);
    error MatterNotFound(bytes32 matterId);
    error InvalidStatus(bytes32 matterId, MatterStatus status);
    error InvalidAddress();
    error InvalidToken(address token);
    error InvalidAmount();
    error InvalidPayoutRule();
    error SubmitDeadlineExpired();
    error ReleaseTimeNotReached();
    error InvalidSignature(address expectedSigner);
    error InvalidPlatformSignature();
    error Unauthorized();
    error MatterPausedError(bytes32 matterId);
    error InvalidVersion();

    modifier onlyPauser() {
        if (msg.sender != owner() && !pausers[msg.sender]) revert Unauthorized();
        _;
    }

    /// @notice Deploys a single-version escrow instance.
    /// @param initialOwner Owner for configuration operations. Use a multisig in production.
    /// @param initialPlatformSigner First signer authorized to approve platform Matter data.
    /// @param initialPauser First operator authorized to pause Matters or the whole contract.
    /// @param initialToken First allowed settlement token.
    /// @param initialRegistry Registry used for discovery. Zero is allowed for staged deployments.
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
        if (initialRegistry != address(0) && initialRegistry.code.length == 0) {
            revert InvalidAddress();
        }

        registry = initialRegistry;
        registryVersion = initialRegistryVersion;

        _setPlatformSigner(initialPlatformSigner, true);
        _setPauser(initialPauser, true);
        _setAllowedToken(initialToken, true);
    }

    /// @notice Funds a signed Matter by redeeming a USDC-style receiveWithAuthorization payload.
    /// @dev Anyone may submit if they have all signatures. This keeps relayers and parties interchangeable.
    /// @param params Signed Matter parameters.
    /// @param sigs Payor, recipient, mediator, and platform signatures over `params`.
    /// @param auth USDC authorization signed by the payor for `grossAmount`.
    /// @param autoRelease If true, immediately releases an Immediate Matter after funding.
    function submitMatterWithUSDCAuth(
        MatterParams calldata params,
        SignatureBundle calldata sigs,
        USDCAuthorization calldata auth,
        bool autoRelease
    ) external nonReentrant whenNotPaused {
        _validateAndAuthorizeMatter(params, sigs);

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

        _recordFundedMatter(params);
        _autoReleaseIfRequested(params.matterId, params.payoutRule, autoRelease);
    }

    /// @notice Funds a signed Matter by using the payor's ERC-20 allowance.
    /// @dev This fallback is useful for local tests and non-USDC integrations that do not support authorization.
    function submitMatterWithAllowance(MatterParams calldata params, SignatureBundle calldata sigs, bool autoRelease)
        external
        nonReentrant
        whenNotPaused
    {
        _validateAndAuthorizeMatter(params, sigs);

        IERC20(params.token).safeTransferFrom(params.payor, address(this), params.grossAmount);

        _recordFundedMatter(params);
        _autoReleaseIfRequested(params.matterId, params.payoutRule, autoRelease);
    }

    /// @notice Releases a funded Matter according to its payout rule.
    /// @dev Callable by anyone. Timed Matters require `block.timestamp >= releaseTime`.
    function release(bytes32 matterId) external nonReentrant whenNotPaused {
        Matter storage matter = _existingMatter(matterId);
        _release(matterId, matter);
    }

    /// @notice Cancels a funded or paused Matter and refunds the payor after joint authorization.
    /// @dev Requires payor, recipient, and platform signatures. Mediator signature is optional in V1.
    function cancelAndRefundByAgreement(bytes32 matterId, CancellationSignatures calldata sigs)
        external
        nonReentrant
        whenNotPaused
    {
        Matter storage matter = _existingMatter(matterId);
        if (matter.status != MatterStatus.Funded && matter.status != MatterStatus.Paused) {
            revert InvalidStatus(matterId, matter.status);
        }

        bytes32 digest = hashCancellation(matterId);
        _requireValidSignature(matter.payor, digest, sigs.payorSignature);
        _requireValidSignature(matter.recipient, digest, sigs.recipientSignature);
        _requireValidPlatformSignature(digest, sigs.platformSignature);

        if (sigs.mediatorSignature.length != 0) {
            _requireValidSignature(matter.mediator, digest, sigs.mediatorSignature);
        }

        uint256 refundAmount = _grossAmount(matter);
        // Record the terminal state before transferring funds out.
        matter.status = MatterStatus.Cancelled;
        accountedBalance[matter.token] -= refundAmount;
        matter.status = MatterStatus.Refunded;

        IERC20(matter.token).safeTransfer(matter.payor, refundAmount);

        emit MatterCancelledAndRefunded(matterId, matter.payor, refundAmount, uint64(block.timestamp), digest);
    }

    /// @notice Pauses a funded Matter without changing its escrowed balance.
    /// @dev `reasonHash` should commit to off-chain compliance or security context without exposing PII.
    function pauseMatter(bytes32 matterId, bytes32 reasonHash) external onlyPauser {
        Matter storage matter = _existingMatter(matterId);
        if (matter.status != MatterStatus.Funded) revert InvalidStatus(matterId, matter.status);

        matter.status = MatterStatus.Paused;

        emit MatterPaused(matterId, reasonHash, msg.sender);
    }

    /// @notice Restores a paused Matter to Funded status.
    function unpauseMatter(bytes32 matterId) external onlyPauser {
        Matter storage matter = _existingMatter(matterId);
        if (matter.status != MatterStatus.Paused) revert InvalidStatus(matterId, matter.status);

        matter.status = MatterStatus.Funded;

        emit MatterUnpaused(matterId, msg.sender);
    }

    /// @notice Pauses new submissions and releases globally.
    function pause() external onlyPauser {
        _pause();
    }

    /// @notice Unpauses global submission and release operations.
    function unpause() external onlyPauser {
        _unpause();
    }

    /// @notice Adds a new active platform signer.
    /// @dev Kept for the design document API; `setPlatformSigner` should be used when deactivating signers.
    function updatePlatformSigner(address newSigner) external onlyOwner {
        _setPlatformSigner(newSigner, true);
    }

    /// @notice Enables or disables a platform signer for future Matter and cancellation signatures.
    function setPlatformSigner(address signer, bool active) external onlyOwner {
        _setPlatformSigner(signer, active);
    }

    /// @notice Enables or disables a pauser account.
    function setPauser(address pauser, bool active) external onlyOwner {
        _setPauser(pauser, active);
    }

    /// @notice Enables or disables a token for new Matter funding.
    /// @dev Disabling a token does not affect already funded Matters that use that token.
    function setAllowedToken(address token, bool allowed) external onlyOwner {
        _setAllowedToken(token, allowed);
    }

    /// @notice Updates the discovery registry address used by clients.
    /// @dev The registry has no authority over Matter state or funds.
    function setRegistry(address newRegistry) external onlyOwner {
        if (newRegistry != address(0) && newRegistry.code.length == 0) revert InvalidAddress();

        address oldRegistry = registry;
        registry = newRegistry;

        emit RegistryUpdated(oldRegistry, newRegistry);
    }

    /// @notice Transfers tokens not accounted for by active escrow balances.
    /// @dev This cannot withdraw funds committed to Funded or Paused Matters.
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

    /// @notice Returns the EIP-712 digest that parties must sign for Matter submission.
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
                    uint8(params.payoutRule),
                    params.releaseTime,
                    params.submitDeadline,
                    params.registryVersion
                )
            )
        );
    }

    /// @notice Returns the EIP-712 digest required to cancel and refund a funded Matter.
    function hashCancellation(bytes32 matterId) public view returns (bytes32) {
        Matter storage matter = _existingMatter(matterId);

        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SOLIS_CANCELLATION_TYPEHASH,
                    matterId,
                    matter.settlementDigest,
                    matter.payor,
                    matter.recipient,
                    matter.mediator,
                    matter.platformFeeRecipient,
                    matter.token,
                    _grossAmount(matter),
                    matter.submittedAt
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

    /// @notice Returns the off-chain settlement digest committed by a funded Matter.
    function getSettlementDigest(bytes32 matterId) external view returns (bytes32) {
        return _existingMatter(matterId).settlementDigest;
    }

    /// @notice Returns whether `release` would be allowed by Matter state and timing.
    function isReleasable(bytes32 matterId) external view returns (bool) {
        Matter storage matter = _matters[matterId];
        if (matter.settlementDigest == bytes32(0) || matter.status != MatterStatus.Funded) {
            return false;
        }

        return matter.payoutRule == PayoutRule.Immediate || block.timestamp >= matter.releaseTime;
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

    function _validateAndAuthorizeMatter(MatterParams calldata params, SignatureBundle calldata sigs) private view {
        _validateMatterParams(params);

        // All parties sign the same digest so no role can approve a different economic view.
        bytes32 digest = hashMatter(params);
        _requireValidSignature(params.payor, digest, sigs.payorSignature);
        _requireValidSignature(params.recipient, digest, sigs.recipientSignature);
        _requireValidSignature(params.mediator, digest, sigs.mediatorSignature);
        _requireValidPlatformSignature(digest, sigs.platformSignature);
    }

    function _validateMatterParams(MatterParams calldata params) private view {
        if (_matters[params.matterId].settlementDigest != bytes32(0)) {
            revert MatterAlreadyExists(params.matterId);
        }
        if (params.matterId == bytes32(0) || params.settlementDigest == bytes32(0)) {
            revert InvalidAddress();
        }
        if (!allowedTokens[params.token]) revert InvalidToken(params.token);
        if (params.registryVersion != registryVersion) revert InvalidVersion();
        if (block.timestamp > params.submitDeadline) revert SubmitDeadlineExpired();

        _validateAddresses(params);
        _validateAmounts(params);
        _validatePayoutRule(params);
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

    function _validatePayoutRule(MatterParams calldata params) private view {
        if (params.payoutRule == PayoutRule.Immediate) {
            if (params.releaseTime != 0) revert InvalidPayoutRule();
            return;
        }

        if (params.payoutRule == PayoutRule.Timed) {
            if (params.releaseTime <= block.timestamp || params.releaseTime < params.submitDeadline) {
                revert InvalidPayoutRule();
            }
            return;
        }

        revert InvalidPayoutRule();
    }

    function _recordFundedMatter(MatterParams calldata params) private {
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
        matter.payoutRule = params.payoutRule;
        matter.status = MatterStatus.Funded;
        matter.releaseTime = params.releaseTime;
        matter.submittedAt = uint64(block.timestamp);

        // This balance is decremented before external transfers on release/refund.
        accountedBalance[params.token] += params.grossAmount;

        emit MatterSubmittedAndFunded(
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
            params.payoutRule,
            params.releaseTime,
            params.registryVersion
        );
    }

    function _autoReleaseIfRequested(bytes32 matterId, PayoutRule payoutRule, bool autoRelease) private {
        if (autoRelease && payoutRule == PayoutRule.Immediate) {
            Matter storage matter = _matters[matterId];
            _release(matterId, matter);
        }
    }

    function _release(bytes32 matterId, Matter storage matter) private {
        if (matter.status == MatterStatus.Paused) revert MatterPausedError(matterId);
        if (matter.status != MatterStatus.Funded) revert InvalidStatus(matterId, matter.status);
        if (matter.payoutRule == PayoutRule.Timed && block.timestamp < matter.releaseTime) {
            revert ReleaseTimeNotReached();
        }

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

    function _requireValidSignature(address signer, bytes32 digest, bytes calldata signature) private view {
        if (!SignatureChecker.isValidSignatureNowCalldata(signer, digest, signature)) {
            revert InvalidSignature(signer);
        }
    }

    function _requireValidPlatformSignature(bytes32 digest, bytes calldata signature) private view {
        // Signer rotation is handled by accepting any active signer in the append-only signer list.
        for (uint256 i = 0; i < _platformSignerList.length; ++i) {
            address signer = _platformSignerList[i];
            if (platformSigners[signer] && SignatureChecker.isValidSignatureNowCalldata(signer, digest, signature)) {
                return;
            }
        }

        revert InvalidPlatformSignature();
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

    function _setAllowedToken(address token, bool allowed) private {
        if (token == address(0)) revert InvalidAddress();

        allowedTokens[token] = allowed;

        emit AllowedTokenUpdated(token, allowed);
    }

    function _existingMatter(bytes32 matterId) private view returns (Matter storage matter) {
        matter = _matters[matterId];
        if (matter.settlementDigest == bytes32(0)) revert MatterNotFound(matterId);
    }

    function _grossAmount(Matter storage matter) private view returns (uint256) {
        return matter.recipientAmount + matter.platformFeeAmount + matter.mediatorFeeAmount;
    }
}
