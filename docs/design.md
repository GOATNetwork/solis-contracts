# Solis Solidity Smart Contract Product Design

## 1. Document Purpose

This document defines the Solidity smart contract design for Solis MVP v1.3. It is intended for contract engineering, backend integration, frontend integration, and security review.

Solis v1.3 uses a small, non-proxy escrow system:

```text
SolisRegistry
  -> version discovery only

SolisEscrow V1.3
  -> one escrow contract holds many Matters
  -> Payor funds a platform-approved Matter on-chain
  -> Recipient confirms or rejects on-chain
  -> confirmed funds are released immediately
```

Legal text, names, emails, attachments, identity data, salts, and raw settlement packages are never written on-chain.

## 2. Core Design Decision

The v1.3 MVP does not use relayer-funded Matter submission, timed payout rules, or joint cancellation signatures.

The platform creates an off-chain Matter record, generates the agreement document, computes `settlementDigest`, and signs the Matter parameters with an active PlatformSigner. The Payor then connects a wallet and submits the escrow funding transaction directly with a USDC `receiveWithAuthorization` payload. After funding, the Recipient connects a wallet and either confirms or rejects. Confirmation immediately releases funds. Rejection refunds the Payor.

Core principles:

1. `SolisRegistry` never custodies funds, validates Matter parameters, or proxies calls.
2. `SolisEscrow` accepts exactly one settlement token per deployment.
3. The Payor's wallet transaction is the Payor authorization for payment.
4. The Recipient's wallet transaction is the Recipient authorization for confirmation or rejection.
5. The PlatformSigner signature approves Matter parameters but cannot move funds by itself.
6. Owner, pauser, and platform operator functions cannot arbitrarily release, redirect, or partially refund user escrow funds.
7. `accountedBalance` protects Paid and Paused Matter funds from token sweeping.

## 3. On-Chain and Off-Chain Boundaries

### 3.1 Off-Chain Platform State

These states are platform states and are not stored on-chain:

```text
Created
PayorRejected
PaymentExpired
Completed
```

`PaymentExpired` means the Payor did not fund before `paymentDeadline`. Because funds were never escrowed, no on-chain refund is needed.

### 3.2 On-Chain Escrow State

```solidity
enum MatterStatus {
    None,
    Paid,
    RecipientConfirmed,
    Released,
    RecipientRejected,
    Refunded,
    Paused
}
```

Primary transitions:

```text
None -> Paid -> RecipientConfirmed -> Released
None -> Paid -> RecipientRejected -> Refunded
None -> Paid -> Refunded
Paid -> Paused -> Paid
```

`RecipientConfirmed` and `RecipientRejected` are transient in the confirmation or rejection transaction. Final stored states are `Released` or `Refunded`.

### 3.3 Settlement Commitment

`settlementDigest` commits to the full off-chain settlement package and execution terms.

```solidity
bytes32 settlementDigest;
```

The settlement package should cover at least:

1. Matter ID.
2. Payor, Recipient, Mediator, and platform fee recipient addresses.
3. Settlement token.
4. Gross amount, Recipient amount, platform fee, and mediator fee.
5. Payment and confirmation deadlines.
6. Chain ID and escrow contract address.

The contract stores only the settlement digest, addresses, amounts, token, deadlines, state, and timestamps.

## 4. Contract Responsibilities

### 4.1 SolisRegistry

`SolisRegistry` is only responsible for version registration and address discovery:

1. Register escrow versions.
2. Mark versions active or deprecated.
3. Maintain latest version routing.
4. Preserve historical version addresses.

It must not custody funds, proxy calls, release funds, refund funds, or validate Matter data.

### 4.2 SolisEscrow

`SolisEscrow` is responsible for:

1. Verifying PlatformSigner approval for new Matter payment.
2. Receiving Payor funds through USDC `receiveWithAuthorization`.
3. Recording Matter state as `Paid`.
4. Binding Recipient confirmation or rejection transactions to the full Matter parameter set.
5. Immediately splitting funds on confirmation.
6. Refunding all escrowed funds on Recipient rejection.
7. Refunding all escrowed funds after `confirmationDeadline` when called by the Payor or a platform operator.
8. Pausing and unpausing global operations or individual Paid Matters.
9. Emitting indexable events for platform synchronization.

Out of scope:

1. Generating agreement text.
2. Storing agreement bodies, names, emails, identity documents, or attachments.
3. Judging legal disputes.
4. Scheduled automatic execution.
5. Cross-chain settlement.
6. Upgradeable proxy behavior.

## 5. Data Model

### 5.1 MatterParams

`MatterParams` is the full wallet-visible execution parameter set:

```solidity
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
```

Validation rules:

1. Hashes and participant addresses must be non-zero.
2. `token` must equal the escrow deployment's immutable settlement token.
3. `registryVersion` must equal the escrow deployment's immutable registry version.
4. `paymentDeadline` must not be expired when Payor submits payment.
5. `confirmationDeadline` must be later than `paymentDeadline`.
6. `grossAmount` must equal `recipientAmount + platformFeeAmount + mediatorFeeAmount`.
7. `recipientAmount` and `grossAmount` must be non-zero.

### 5.2 Matter Storage

Storage is minimal and execution-focused:

```solidity
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
```

`grossAmount` is derived from stored amounts.

## 6. EIP-712 Platform Approval

Each `SolisEscrow` version is its own EIP-712 verifying contract:

```text
name: SolisEscrow
version: 1
chainId: block.chainid
verifyingContract: address(this)
```

The PlatformSigner signs:

```solidity
SolisMatter(
    bytes32 matterId,
    bytes32 settlementDigest,
    address payor,
    address recipient,
    address mediator,
    address platformFeeRecipient,
    address token,
    uint256 grossAmount,
    uint256 recipientAmount,
    uint256 platformFeeAmount,
    uint256 mediatorFeeAmount,
    uint64 paymentDeadline,
    uint64 confirmationDeadline,
    uint256 registryVersion
)
```

The contract supports EOA and EIP-1271 smart contract platform signers. Signature bundles include the intended `signer` address so verification does not require iterating over historical signers.

PlatformSigner approval confirms that Solis recognizes the Matter ID, settlement digest, addresses, amount split, token, deadlines, chain, and escrow contract. It is not a Payor authorization and cannot transfer funds without the Payor transaction and USDC authorization.

## 7. Function Design

### 7.1 payAndSubmitMatter

```solidity
function payAndSubmitMatter(
    MatterParams calldata params,
    PlatformSignature calldata platformSig,
    USDCAuthorization calldata auth
) external nonReentrant whenNotPaused;
```

Responsibilities:

1. Require `msg.sender == params.payor`.
2. Validate Matter shape, token, deadlines, version, addresses, and amounts.
3. Verify the active PlatformSigner signature over `params`.
4. Call USDC `receiveWithAuthorization` for `grossAmount`.
5. Verify the escrow token balance increased by exactly `grossAmount`.
6. Store the Matter in `Paid` status.
7. Increase `accountedBalance`.
8. Emit `MatterPaid`.

### 7.2 confirmAndRelease

```solidity
function confirmAndRelease(MatterParams calldata params) external nonReentrant whenNotPaused;
```

Responsibilities:

1. Require the Matter to be `Paid`.
2. Require calldata params to match the stored Matter snapshot.
3. Require `msg.sender == recipient`.
4. Require `block.timestamp <= confirmationDeadline`.
5. Emit Recipient confirmation.
6. Set final status to `Released`.
7. Decrease `accountedBalance`.
8. Transfer platform fee, mediator fee, and Recipient amount.

### 7.3 rejectAndRefund

```solidity
function rejectAndRefund(MatterParams calldata params) external nonReentrant whenNotPaused;
```

Responsibilities:

1. Require the Matter to be `Paid`.
2. Require calldata params to match the stored Matter snapshot.
3. Require `msg.sender == recipient`.
4. Require `block.timestamp <= confirmationDeadline`.
5. Emit Recipient rejection.
6. Set final status to `Refunded`.
7. Decrease `accountedBalance`.
8. Refund full gross amount to Payor.

### 7.4 refundAfterConfirmationDeadline

```solidity
function refundAfterConfirmationDeadline(bytes32 matterId) external nonReentrant whenNotPaused;
```

Responsibilities:

1. Require the Matter to be `Paid`.
2. Require `block.timestamp > confirmationDeadline`.
3. Allow only the Payor, owner, or active pauser to call.
4. Refund full gross amount to Payor.

This function does not allow the caller to choose a refund destination.

## 8. Pause and Sweep Rules

The global pause is a full freeze for new funding, Recipient confirmation, Recipient rejection, and timeout refunds.

Matter pause applies only to `Paid` Matters and preserves the escrowed balance:

```text
Paid -> Paused -> Paid
```

Paused Matter funds remain counted in `accountedBalance`.

`sweepExcessToken` may transfer only token balances above `accountedBalance[token]`. It cannot withdraw funds committed to Paid or Paused Matters.

## 9. Events

The escrow emits:

```solidity
event MatterPaid(...);
event MatterRecipientConfirmed(...);
event MatterReleased(...);
event MatterRecipientRejected(...);
event MatterRefunded(...);
event MatterPaused(...);
event MatterUnpaused(...);
event PlatformSignerUpdated(...);
event PauserUpdated(...);
event ExcessTokenSwept(...);
```

The platform should index these events and store transaction hashes alongside the off-chain Matter record.

## 10. Frontend and Backend Integration

Recommended flow:

1. Mediator creates a Matter draft on the platform.
2. Platform generates the final agreement document or PDF.
3. Platform computes `settlementDigest`.
4. Platform signs `MatterParams` with an active PlatformSigner.
5. Platform sends Payor notification.
6. Payor reviews the official platform page and submits `payAndSubmitMatter`.
7. Platform indexes `MatterPaid` and notifies Recipient.
8. Recipient reviews the official platform page and calls either `confirmAndRelease` or `rejectAndRefund`.
9. Platform indexes release or refund events and marks the off-chain Matter complete.

If Recipient takes no action before `confirmationDeadline`, Payor or a platform operator calls `refundAfterConfirmationDeadline`.

## 11. Notification Security

Email is only a notification channel. It is not a trust source and must not be treated as a signature or payment instruction.

The official platform page should show:

1. Matter ID.
2. Agreement document.
3. Settlement digest.
4. Payor, Recipient, Mediator, and platform fee addresses.
5. Token and amount split.
6. Payment and confirmation deadlines.
7. Escrow contract address and chain ID.

Wallet confirmation should bind users to the official contract and the Matter parameters they reviewed.

The platform should use a fixed official sending domain and configure SPF, DKIM, and DMARC. Users should be able to navigate directly to the official platform and find pending Matters without trusting links in email.

## 12. MVP Limits

Solis v1.3 supports:

1. One Payor.
2. One Recipient.
3. One Mediator wallet.
4. One payment per Matter.
5. One immediate release per Matter.
6. Ethereum mainnet USDC as the intended production settlement token.

Future versions may add multiple payors, multiple recipients, staged payments, staged releases, dispute modules, relayer support, cross-chain settlement, or additional token support through separately deployed escrow versions.
