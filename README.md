# Solis Smart Contracts

This repository contains the Hardhat 3 implementation of the Solis v1.3 on-chain escrow contracts.

The system uses two production contracts:

- `SolisRegistry`: non-proxy version discovery for escrow deployments.
- `SolisEscrow`: multi-matter escrow execution where the Payor funds on-chain, the Recipient confirms or rejects on-chain, and confirmed funds are released immediately.

The contracts intentionally do not store legal text, names, emails, identity data, attachments, salts, or raw settlement packages. The on-chain commitment is `settlementDigest`, generated and stored by the platform off-chain.

## Install

```shell
npm install
```

## Build

```shell
npm run build
```

The Solidity profile uses compiler `0.8.35`, optimizer, `viaIR`, and the `osaka` EVM target.

## Solidity Formatting

Install Foundry before formatting Solidity code:

```shell
curl -L https://foundry.paradigm.xyz | bash
foundryup
forge --version
```

Format Solidity files with Forge:

```shell
forge fmt contracts
```

Format TypeScript files with Prettier:

```shell
npm run format:ts
```

Check formatting without modifying files:

```shell
npm run format:sol:check
npm run format:ts:check
```

## Test

```shell
npm test
```

Run the full local verification suite:

```shell
npm run verify
```

The TypeScript tests cover:

- Registry registration, metadata consistency, deprecation, reactivation, and latest escrow discovery.
- PlatformSigner EIP-712 approval over `matterId`, `settlementDigest`, addresses, amounts, token, deadlines, and registry version.
- Payor-only funding through `payAndSubmitMatter` using USDC `receiveWithAuthorization`.
- Exact `grossAmount` balance-increase checks, including short-transfer token rejection.
- Recipient confirmation with immediate fund release.
- Recipient rejection and full Payor refund.
- Confirmation deadline refunds by Payor or platform operator.
- Global pause and Matter pause behavior.
- Accounted balance protection for `sweepExcessToken`.
- PlatformSigner rotation and EIP-1271 smart contract platform signer validation.

## Deployment

The Ignition module is `ignition/modules/SolisCore.ts`.

```shell
npx hardhat ignition deploy ignition/modules/SolisCore.ts
```

Default parameters:

- `owner`: deployer account.
- `platformSigner`: deployer account.
- `pauser`: deployer account.
- `settlementToken`: Ethereum mainnet USDC (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`).
- `registryVersion`: `1`.
- `semver`: `1.3.0`.

Override parameters with an Ignition deployment parameters file for non-local deployments.

## Admin Tasks

Transfer the `SolisRegistry` owner:

```shell
npx hardhat solis transfer-registry-owner <newOwner> --network sepolia
```

Enable or disable a `SolisEscrow` platform signer:

```shell
npx hardhat solis set-platform-signer <signer> --active true --network sepolia
npx hardhat solis set-platform-signer <signer> --active false --network sepolia
```

Tasks read contract addresses from the Ignition deployment for the selected network. Pass
`--deployment-id <id>` when you need to target a non-default deployment.

## EIP-712 Domain

`SolisEscrow` signs with:

```text
name: SolisEscrow
version: 1
chainId: block.chainid
verifyingContract: address(this)
```

This binds PlatformSigner approvals to a specific chain and escrow version contract. `registryVersion` is also included in the typed data.

## Escrow Flow

Wallet and frontend teams should use [docs/integration.md](docs/integration.md) for typed data, transaction, event indexing, and diagram examples.

The platform creates the off-chain Matter, locks the agreement document, computes `settlementDigest`, and signs `MatterParams` with an active PlatformSigner.

Payor funding:

```text
payAndSubmitMatter(params, platformSig, auth)
```

The Payor must be `msg.sender`, the payment deadline must still be valid, and the supplied USDC authorization must move exactly `grossAmount` into escrow.

Recipient confirmation:

```text
confirmAndRelease(params)
```

The Recipient must be `msg.sender`, the params must match the stored Matter snapshot, and the confirmation deadline must still be valid. Confirmation immediately splits funds to the Recipient, platform fee recipient, and Mediator.

Recipient rejection:

```text
rejectAndRefund(params)
```

The Recipient must be `msg.sender`. Rejection refunds the full gross amount to the Payor.

Confirmation timeout:

```text
refundAfterConfirmationDeadline(matterId)
```

After `confirmationDeadline`, the Payor or a platform operator can trigger a full refund to the Payor. The caller cannot choose another refund recipient.
