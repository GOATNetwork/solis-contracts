// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface ISolisEscrow {
    enum PayoutRule {
        Immediate,
        Timed
    }

    enum MatterStatus {
        None,
        Funded,
        Released,
        Cancelled,
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
        PayoutRule payoutRule;
        uint64 releaseTime;
        uint64 submitDeadline;
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
        PayoutRule payoutRule;
        MatterStatus status;
        uint64 releaseTime;
        uint64 submittedAt;
        uint64 releasedAt;
    }

    struct SignatureBundle {
        bytes payorSignature;
        bytes recipientSignature;
        bytes mediatorSignature;
        bytes platformSignature;
    }

    struct USDCAuthorization {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct CancellationSignatures {
        bytes payorSignature;
        bytes recipientSignature;
        bytes platformSignature;
        bytes mediatorSignature;
    }

    function submitMatterWithUSDCAuth(
        MatterParams calldata params,
        SignatureBundle calldata sigs,
        USDCAuthorization calldata auth,
        bool autoRelease
    ) external;

    function submitMatterWithAllowance(MatterParams calldata params, SignatureBundle calldata sigs, bool autoRelease)
        external;

    function release(bytes32 matterId) external;

    function cancelAndRefundByAgreement(bytes32 matterId, CancellationSignatures calldata sigs) external;

    function getMatter(bytes32 matterId) external view returns (Matter memory);
    function getMatterStatus(bytes32 matterId) external view returns (MatterStatus);
    function getSettlementDigest(bytes32 matterId) external view returns (bytes32);
    function isReleasable(bytes32 matterId) external view returns (bool);

    function getPayoutBreakdown(bytes32 matterId)
        external
        view
        returns (uint256 recipientAmount, uint256 platformFeeAmount, uint256 mediatorFeeAmount, uint256 grossAmount);
}
