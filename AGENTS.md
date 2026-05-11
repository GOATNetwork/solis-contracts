# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Project Intent

Solis is a Hardhat 3 Solidity project for a non-proxy escrow system. The on-chain system should stay small, auditable, and aligned with `docs/design.md`.

Core contracts:

- `SolisRegistry`: version discovery only. It must not custody funds or proxy calls.
- `SolisEscrow`: multi-matter escrow execution. It validates off-chain EIP-712 signatures, receives token funding, releases funds, or refunds by agreement.

## Language and Documentation

- Write code comments, NatSpec, README updates, and agent-facing documentation in English.
- Do not add Chinese comments or Chinese documentation.
- Prefer NatSpec for public/external Solidity APIs that affect funds, signatures, roles, or state transitions.
- Keep comments focused on intent, security boundaries, invariants, and non-obvious behavior. Do not restate simple assignments or obvious Solidity syntax.

## Solidity Guidelines

- Use Solidity `0.8.28` and the existing Hardhat profiles.
- Keep contracts non-upgradeable. Do not introduce OpenZeppelin Upgradeable contracts, proxies, or delegatecall-based upgrade paths.
- Prefer OpenZeppelin standard contracts and libraries for ownership, pausing, reentrancy protection, ERC-20 handling, EIP-712, ECDSA, and EIP-1271 validation.
- Format Solidity files with Foundry's `forge fmt`. Install Foundry first if `forge` is unavailable.
- Preserve checks-effects-interactions in any function that transfers tokens.
- Do not add owner, operator, or pauser functions that can arbitrarily release, redirect, or refund user escrow funds.
- Protect all token sweep logic with `accountedBalance` so funded or paused Matter balances cannot be withdrawn.
- Do not write legal text, names, emails, identity data, attachments, salts, or raw settlement packages on-chain.

## Testing and Verification

Run these commands before handing off contract changes:

```shell
npm run verify
```

Tests should cover signature binding, amount accounting, state transitions, role authorization, funding paths, and token transfer edge cases for any behavior they change.

## Dependencies

- Keep `@openzeppelin/contracts` as the standard Solidity dependency for security primitives.
- Avoid adding new dependencies unless they clearly reduce security or maintenance risk.

## Git Hygiene

- Do not revert user changes or unrelated generated files.
- Keep edits scoped to the requested contract, test, deployment, or documentation surface.
