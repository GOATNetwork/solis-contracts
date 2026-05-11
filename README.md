# Solis Smart Contracts

This repository contains the Hardhat 3 implementation of the Solis on-chain settlement contracts.

The system uses two production contracts:

- `SolisRegistry`: non-proxy version discovery for escrow deployments.
- `SolisEscrow`: multi-matter escrow execution with EIP-712 approvals, USDC authorization funding, allowance fallback funding, release, joint cancellation refund, pause controls, and accounted-balance-safe sweeping.

The contracts intentionally do not store legal text, names, emails, identity data, or settlement package contents. The on-chain commitment is `settlementDigest`, which must be generated from the off-chain settlement package.

## Install

```shell
npm install
```

## Build

```shell
npm run build
```

The Solidity profile enables optimizer and `viaIR` because the Solis EIP-712 matter struct is intentionally wide and should not be reshaped only to avoid stack-depth limits.

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
- EIP-712 matter signatures for payor, recipient, mediator, and hinted active platform signer.
- `submitMatterWithUSDCAuth` using a mock USDC `receiveWithAuthorization`.
- `submitMatterWithAllowance` fallback funding.
- Exact `grossAmount` balance-increase checks for both funding paths.
- Immediate auto-release and timed release.
- Global pause freezing submission, release, and refund.
- Matter pause and joint cancellation refund when global pause is off.
- Accounted balance protection for `sweepExcessToken`.
- Platform signer rotation and EIP-1271 smart contract platform signer validation.

## Deployment

The Ignition module is `ignition/modules/SolisCore.ts`.

```shell
npx hardhat ignition deploy ignition/modules/SolisCore.ts
```

Default parameters:

- `owner`: deployer account.
- `platformSigner`: account index 1.
- `pauser`: account index 2.
- `allowedToken`: Ethereum mainnet USDC (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`).
- `registryVersion`: `1`.
- `semver`: `1.0.0`.

Override parameters with an Ignition deployment parameters file for non-local deployments.

## EIP-712 Domain

`SolisEscrow` signs with:

```text
name: SolisEscrow
version: 1
chainId: block.chainid
verifyingContract: address(this)
```

This binds signatures to a specific chain and escrow version contract. `registryVersion` is also included in the typed data.

Submission and cancellation bundles include `platformSigner`, an explicit active signer hint used to verify the platform signature without iterating over historical signer records.

## Funding Paths

Primary path:

```text
submitMatterWithUSDCAuth(params, sigs, auth, autoRelease)
```

Fallback path:

```text
submitMatterWithAllowance(params, sigs, autoRelease)
```

Both paths validate the same Solis matter signatures and only accept tokens enabled in `allowedTokens`.
Both paths also require the escrow token balance to increase by exactly `grossAmount` before any Matter is recorded, rejecting short-transfer or fee-on-transfer funding behavior.
