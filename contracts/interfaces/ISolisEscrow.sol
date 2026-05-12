// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.35;

interface ISolisEscrow {
    enum MatterStatus {
        None,
        Paid,
        RecipientConfirmed,
        Released,
        RecipientRejected,
        Refunded,
        Paused
    }

    struct MatterParams {
        bytes32 matterId;
        bytes32 settlementDigest;
        address payor;
        address recipient;
        address mediator;
        address platformFeeRecipient;
        address token;
        uint256 grossAmount;
        uint256 recipientAmount;
        uint256 platformFeeAmount;
        uint256 mediatorFeeAmount;
        uint64 paymentDeadline;
        uint64 confirmationDeadline;
        uint256 registryVersion;
    }

    struct Matter {
        bytes32 settlementDigest;
        address payor;
        address recipient;
        address mediator;
        address platformFeeRecipient;
        address token;
        uint256 recipientAmount;
        uint256 platformFeeAmount;
        uint256 mediatorFeeAmount;
        MatterStatus status;
        uint64 paymentDeadline;
        uint64 confirmationDeadline;
        uint64 submittedAt;
        uint64 confirmedAt;
        uint64 rejectedAt;
        uint64 releasedAt;
        uint64 refundedAt;
    }

    struct PlatformSignature {
        address signer;
        bytes signature;
    }

    struct USDCAuthorization {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function payAndSubmitMatter(
        MatterParams calldata params,
        PlatformSignature calldata platformSig,
        USDCAuthorization calldata auth
    ) external;

    function confirmAndRelease(MatterParams calldata params) external;

    function rejectAndRefund(MatterParams calldata params) external;

    function refundAfterConfirmationDeadline(bytes32 matterId) external;

    function getMatter(bytes32 matterId) external view returns (Matter memory);

    function getMatterStatus(bytes32 matterId) external view returns (MatterStatus);

    function getSettlementDigest(bytes32 matterId) external view returns (bytes32);

    function getDeadlines(bytes32 matterId) external view returns (uint64 paymentDeadline, uint64 confirmationDeadline);

    function isRecipientActionable(bytes32 matterId) external view returns (bool);

    function getPayoutBreakdown(bytes32 matterId)
        external
        view
        returns (uint256 recipientAmount, uint256 platformFeeAmount, uint256 mediatorFeeAmount, uint256 grossAmount);
}
