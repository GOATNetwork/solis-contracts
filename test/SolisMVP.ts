import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  type Address,
  type Hex,
  getAddress,
  keccak256,
  parseSignature,
  toHex,
  zeroAddress,
} from "viem";

type SigningWallet = {
  account: { address: Address };
  signTypedData: (args: any) => Promise<Hex>;
};

type MatterParams = {
  matterId: Hex;
  settlementDigest: Hex;
  payor: Address;
  recipient: Address;
  mediator: Address;
  platformFeeRecipient: Address;
  token: Address;
  grossAmount: bigint;
  recipientAmount: bigint;
  platformFeeAmount: bigint;
  mediatorFeeAmount: bigint;
  payoutRule: number;
  releaseTime: bigint;
  submitDeadline: bigint;
  registryVersion: bigint;
};

const SOLIS_MATTER_TYPES = {
  SolisMatter: [
    { name: "matterId", type: "bytes32" },
    { name: "settlementDigest", type: "bytes32" },
    { name: "payor", type: "address" },
    { name: "recipient", type: "address" },
    { name: "mediator", type: "address" },
    { name: "platformFeeRecipient", type: "address" },
    { name: "token", type: "address" },
    { name: "grossAmount", type: "uint256" },
    { name: "recipientAmount", type: "uint256" },
    { name: "platformFeeAmount", type: "uint256" },
    { name: "mediatorFeeAmount", type: "uint256" },
    { name: "payoutRule", type: "uint8" },
    { name: "releaseTime", type: "uint64" },
    { name: "submitDeadline", type: "uint64" },
    { name: "registryVersion", type: "uint256" },
  ],
} as const;

const SOLIS_CANCELLATION_TYPES = {
  SolisCancellation: [
    { name: "matterId", type: "bytes32" },
    { name: "settlementDigest", type: "bytes32" },
    { name: "payor", type: "address" },
    { name: "recipient", type: "address" },
    { name: "mediator", type: "address" },
    { name: "platformFeeRecipient", type: "address" },
    { name: "token", type: "address" },
    { name: "refundAmount", type: "uint256" },
    { name: "submittedAt", type: "uint64" },
  ],
} as const;

const USDC_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

describe("Solis MVP", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  function digest(label: string): Hex {
    return keccak256(toHex(label));
  }

  async function deployFixture() {
    const [
      owner,
      payor,
      recipient,
      mediator,
      platformFeeRecipient,
      platformSigner,
      pauser,
      relayer,
      other,
    ] = await viem.getWalletClients();

    const token = await viem.deployContract("MockUSDC");
    const registry = await viem.deployContract("SolisRegistry", [
      owner.account.address,
    ]);
    const escrow = await viem.deployContract("SolisEscrow", [
      owner.account.address,
      platformSigner.account.address,
      pauser.account.address,
      token.address,
      registry.address,
      1n,
    ]);

    await registry.write.registerVersion([1n, escrow.address, "1.0.0"]);
    await token.write.mint([payor.account.address, 100_000_000n]);

    const payorToken = await viem.getContractAt("MockUSDC", token.address, {
      client: { wallet: payor },
    });
    const relayerEscrow = await viem.getContractAt(
      "SolisEscrow",
      escrow.address,
      {
        client: { wallet: relayer },
      },
    );

    return {
      owner,
      payor,
      recipient,
      mediator,
      platformFeeRecipient,
      platformSigner,
      pauser,
      relayer,
      other,
      token,
      payorToken,
      registry,
      escrow,
      relayerEscrow,
    };
  }

  async function makeParams(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    label: string,
    overrides: Partial<MatterParams> = {},
  ): Promise<MatterParams> {
    const now = BigInt(await networkHelpers.time.latest());
    const recipientAmount = overrides.recipientAmount ?? 1_000_000n;
    const platformFeeAmount = overrides.platformFeeAmount ?? 30_000n;
    const mediatorFeeAmount = overrides.mediatorFeeAmount ?? 20_000n;

    return {
      matterId: digest(`matter:${label}`),
      settlementDigest: digest(`settlement:${label}`),
      payor: fixture.payor.account.address,
      recipient: fixture.recipient.account.address,
      mediator: fixture.mediator.account.address,
      platformFeeRecipient: fixture.platformFeeRecipient.account.address,
      token: fixture.token.address,
      grossAmount: recipientAmount + platformFeeAmount + mediatorFeeAmount,
      recipientAmount,
      platformFeeAmount,
      mediatorFeeAmount,
      payoutRule: 0,
      releaseTime: 0n,
      submitDeadline: now + 3_600n,
      registryVersion: 1n,
      ...overrides,
    };
  }

  function solisDomain(escrowAddress: Address) {
    return {
      name: "SolisEscrow",
      version: "1",
      chainId,
      verifyingContract: escrowAddress,
    };
  }

  async function signMatter(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    params: MatterParams,
    platformSigner: SigningWallet = fixture.platformSigner,
    platformSignerAddress: Address = platformSigner.account.address,
  ) {
    const typedData: any = {
      domain: solisDomain(fixture.escrow.address),
      types: SOLIS_MATTER_TYPES,
      primaryType: "SolisMatter",
      message: params,
    };

    return {
      payorSignature: await fixture.payor.signTypedData(typedData),
      recipientSignature: await fixture.recipient.signTypedData(typedData),
      mediatorSignature: await fixture.mediator.signTypedData(typedData),
      platformSigner: platformSignerAddress,
      platformSignature: await platformSigner.signTypedData(typedData),
    };
  }

  async function signCancellation(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    matterId: Hex,
    platformSigner: SigningWallet = fixture.platformSigner,
    platformSignerAddress: Address = platformSigner.account.address,
  ) {
    const matter = await fixture.escrow.read.getMatter([matterId]);
    const refundAmount =
      matter.recipientAmount +
      matter.platformFeeAmount +
      matter.mediatorFeeAmount;
    const message = {
      matterId,
      settlementDigest: matter.settlementDigest,
      payor: matter.payor,
      recipient: matter.recipient,
      mediator: matter.mediator,
      platformFeeRecipient: matter.platformFeeRecipient,
      token: matter.token,
      refundAmount,
      submittedAt: matter.submittedAt,
    };
    const typedData: any = {
      domain: solisDomain(fixture.escrow.address),
      types: SOLIS_CANCELLATION_TYPES,
      primaryType: "SolisCancellation",
      message,
    };

    return {
      payorSignature: await fixture.payor.signTypedData(typedData),
      recipientSignature: await fixture.recipient.signTypedData(typedData),
      platformSigner: platformSignerAddress,
      platformSignature: await platformSigner.signTypedData(typedData),
      mediatorSignature: "0x" as Hex,
    };
  }

  async function signUSDCAuth(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    params: MatterParams,
    label: string,
  ) {
    const validAfter = 0n;
    const validBefore = BigInt(await networkHelpers.time.latest()) + 3_600n;
    const nonce = digest(`usdc-auth:${label}`);
    const signature = await fixture.payor.signTypedData({
      domain: {
        name: "MockUSDC",
        version: "1",
        chainId,
        verifyingContract: params.token,
      },
      types: USDC_AUTH_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: params.payor,
        to: fixture.escrow.address,
        value: params.grossAmount,
        validAfter,
        validBefore,
        nonce,
      },
    });
    const parsed = parseSignature(signature);

    return {
      validAfter,
      validBefore,
      nonce,
      v: Number(parsed.v ?? BigInt(27 + parsed.yParity)),
      r: parsed.r,
      s: parsed.s,
    };
  }

  it("registers escrow versions and routes latest escrow discovery", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);

    assert.equal(await fixture.registry.read.latestVersion(), 1n);
    assert.equal(
      getAddress(await fixture.registry.read.getLatestEscrow()),
      getAddress(fixture.escrow.address),
    );
    assert.equal(
      getAddress(await fixture.registry.read.getEscrow([1n])),
      getAddress(fixture.escrow.address),
    );
    assert.equal(
      await fixture.registry.read.isRegisteredEscrow([fixture.escrow.address]),
      true,
    );

    await fixture.registry.write.deprecateVersion([1n]);
    assert.equal(await fixture.registry.read.latestVersion(), 0n);
    assert.equal(
      getAddress(await fixture.registry.read.getLatestEscrow()),
      zeroAddress,
    );

    await fixture.registry.write.reactivateVersion([1n]);
    await fixture.registry.write.setLatestVersion([1n]);
    assert.equal(
      getAddress(await fixture.registry.read.getLatestEscrow()),
      getAddress(fixture.escrow.address),
    );
  });

  it("rejects registry entries whose escrow metadata does not match", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);

    const wrongVersionEscrow = await viem.deployContract("SolisEscrow", [
      fixture.owner.account.address,
      fixture.platformSigner.account.address,
      fixture.pauser.account.address,
      fixture.token.address,
      fixture.registry.address,
      2n,
    ]);
    await assert.rejects(
      fixture.registry.write.registerVersion([
        3n,
        wrongVersionEscrow.address,
        "1.0.0",
      ]),
    );

    const otherRegistry = await viem.deployContract("SolisRegistry", [
      fixture.owner.account.address,
    ]);
    const wrongRegistryEscrow = await viem.deployContract("SolisEscrow", [
      fixture.owner.account.address,
      fixture.platformSigner.account.address,
      fixture.pauser.account.address,
      fixture.token.address,
      otherRegistry.address,
      4n,
    ]);
    await assert.rejects(
      fixture.registry.write.registerVersion([
        4n,
        wrongRegistryEscrow.address,
        "1.0.0",
      ]),
    );

    const semverMismatchEscrow = await viem.deployContract("SolisEscrow", [
      fixture.owner.account.address,
      fixture.platformSigner.account.address,
      fixture.pauser.account.address,
      fixture.token.address,
      fixture.registry.address,
      5n,
    ]);
    await assert.rejects(
      fixture.registry.write.registerVersion([
        5n,
        semverMismatchEscrow.address,
        "1.0.1",
      ]),
    );
  });

  it("submits and auto-releases an immediate matter through allowance funding", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const params = await makeParams(fixture, "allowance-immediate");
    const sigs = await signMatter(fixture, params);

    await fixture.payorToken.write.approve([
      fixture.escrow.address,
      params.grossAmount,
    ]);
    await fixture.relayerEscrow.write.submitMatterWithAllowance([
      params,
      sigs,
      true,
    ]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      2,
    );
    assert.equal(
      await fixture.token.read.balanceOf([fixture.recipient.account.address]),
      params.recipientAmount,
    );
    assert.equal(
      await fixture.token.read.balanceOf([
        fixture.platformFeeRecipient.account.address,
      ]),
      params.platformFeeAmount,
    );
    assert.equal(
      await fixture.token.read.balanceOf([fixture.mediator.account.address]),
      params.mediatorFeeAmount,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      0n,
    );

    await assert.rejects(
      fixture.relayerEscrow.write.submitMatterWithAllowance([
        params,
        sigs,
        false,
      ]),
    );
  });

  it("supports USDC receiveWithAuthorization funding", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const params = await makeParams(fixture, "usdc-auth-immediate");
    const sigs = await signMatter(fixture, params);
    const auth = await signUSDCAuth(fixture, params, "usdc-auth-immediate");

    await fixture.relayerEscrow.write.submitMatterWithUSDCAuth([
      params,
      sigs,
      auth,
      true,
    ]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      2,
    );
    assert.equal(
      await fixture.token.read.balanceOf([fixture.recipient.account.address]),
      params.recipientAmount,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      0n,
    );
  });

  it("rejects token funding that transfers less than grossAmount", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const shortToken = await viem.deployContract("MockShortTransferUSDC", [1n]);
    await shortToken.write.mint([fixture.payor.account.address, 100_000_000n]);
    await fixture.escrow.write.setAllowedToken([shortToken.address, true]);

    const payorShortToken = await viem.getContractAt(
      "MockShortTransferUSDC",
      shortToken.address,
      {
        client: { wallet: fixture.payor },
      },
    );

    const allowanceParams = await makeParams(fixture, "short-allowance", {
      token: shortToken.address,
    });
    const allowanceSigs = await signMatter(fixture, allowanceParams);

    await payorShortToken.write.approve([
      fixture.escrow.address,
      allowanceParams.grossAmount,
    ]);
    await assert.rejects(
      fixture.relayerEscrow.write.submitMatterWithAllowance([
        allowanceParams,
        allowanceSigs,
        false,
      ]),
    );
    assert.equal(
      Number(
        await fixture.escrow.read.getMatterStatus([allowanceParams.matterId]),
      ),
      0,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([shortToken.address]),
      0n,
    );

    const authParams = await makeParams(fixture, "short-usdc-auth", {
      token: shortToken.address,
    });
    const authSigs = await signMatter(fixture, authParams);
    const auth = await signUSDCAuth(fixture, authParams, "short-usdc-auth");

    await assert.rejects(
      fixture.relayerEscrow.write.submitMatterWithUSDCAuth([
        authParams,
        authSigs,
        auth,
        false,
      ]),
    );
    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([authParams.matterId])),
      0,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([shortToken.address]),
      0n,
    );
  });

  it("keeps timed matter funds accounted until release time", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const now = BigInt(await networkHelpers.time.latest());
    const params = await makeParams(fixture, "timed-release", {
      payoutRule: 1,
      submitDeadline: now + 1_000n,
      releaseTime: now + 2_000n,
    });
    const sigs = await signMatter(fixture, params);

    await fixture.payorToken.write.approve([
      fixture.escrow.address,
      params.grossAmount,
    ]);
    await fixture.relayerEscrow.write.submitMatterWithAllowance([
      params,
      sigs,
      true,
    ]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      1,
    );
    assert.equal(
      await fixture.escrow.read.isReleasable([params.matterId]),
      false,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      params.grossAmount,
    );

    await assert.rejects(
      fixture.relayerEscrow.write.release([params.matterId]),
    );

    await networkHelpers.time.increaseTo(params.releaseTime);
    await fixture.relayerEscrow.write.release([params.matterId]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      2,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      0n,
    );
  });

  it("treats global pause as a full freeze for submit, release, and refund", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const now = BigInt(await networkHelpers.time.latest());
    const params = await makeParams(fixture, "global-pause", {
      payoutRule: 1,
      submitDeadline: now + 1_000n,
      releaseTime: now + 2_000n,
    });
    const sigs = await signMatter(fixture, params);

    await fixture.payorToken.write.approve([
      fixture.escrow.address,
      params.grossAmount,
    ]);
    await fixture.escrow.write.pause({ account: fixture.pauser.account });
    await assert.rejects(
      fixture.relayerEscrow.write.submitMatterWithAllowance([
        params,
        sigs,
        false,
      ]),
    );

    await fixture.escrow.write.unpause({ account: fixture.pauser.account });
    await fixture.relayerEscrow.write.submitMatterWithAllowance([
      params,
      sigs,
      false,
    ]);

    await fixture.escrow.write.pause({ account: fixture.pauser.account });
    await networkHelpers.time.increaseTo(params.releaseTime);
    await assert.rejects(
      fixture.relayerEscrow.write.release([params.matterId]),
    );

    const cancellationSigs = await signCancellation(fixture, params.matterId);
    await assert.rejects(
      fixture.relayerEscrow.write.cancelAndRefundByAgreement([
        params.matterId,
        cancellationSigs,
      ]),
    );

    await fixture.escrow.write.unpause({ account: fixture.pauser.account });
    await fixture.relayerEscrow.write.cancelAndRefundByAgreement([
      params.matterId,
      cancellationSigs,
    ]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      4,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      0n,
    );
  });

  it("pauses a matter and refunds only with joint cancellation signatures", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const now = BigInt(await networkHelpers.time.latest());
    const params = await makeParams(fixture, "paused-refund", {
      payoutRule: 1,
      submitDeadline: now + 1_000n,
      releaseTime: now + 2_000n,
    });
    const sigs = await signMatter(fixture, params);

    await fixture.payorToken.write.approve([
      fixture.escrow.address,
      params.grossAmount,
    ]);
    await fixture.relayerEscrow.write.submitMatterWithAllowance([
      params,
      sigs,
      false,
    ]);
    await fixture.escrow.write.pauseMatter(
      [params.matterId, digest("compliance-review")],
      {
        account: fixture.pauser.account,
      },
    );

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      5,
    );
    assert.equal(
      await fixture.escrow.read.isReleasable([params.matterId]),
      false,
    );
    await assert.rejects(
      fixture.relayerEscrow.write.release([params.matterId]),
    );

    const payorBalanceBefore = await fixture.token.read.balanceOf([
      fixture.payor.account.address,
    ]);
    const cancellationSigs = await signCancellation(fixture, params.matterId);
    await fixture.relayerEscrow.write.cancelAndRefundByAgreement([
      params.matterId,
      cancellationSigs,
    ]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      4,
    );
    assert.equal(
      await fixture.token.read.balanceOf([fixture.payor.account.address]),
      payorBalanceBefore + params.grossAmount,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      0n,
    );
  });

  it("does not sweep accounted escrow funds but can sweep excess tokens", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const now = BigInt(await networkHelpers.time.latest());
    const params = await makeParams(fixture, "sweep", {
      payoutRule: 1,
      submitDeadline: now + 1_000n,
      releaseTime: now + 2_000n,
    });
    const sigs = await signMatter(fixture, params);

    await fixture.payorToken.write.approve([
      fixture.escrow.address,
      params.grossAmount,
    ]);
    await fixture.relayerEscrow.write.submitMatterWithAllowance([
      params,
      sigs,
      false,
    ]);

    await assert.rejects(
      fixture.escrow.write.sweepExcessToken([
        fixture.token.address,
        fixture.other.account.address,
        1n,
      ]),
    );

    await fixture.token.write.mint([fixture.escrow.address, 123n]);
    await fixture.escrow.write.sweepExcessToken([
      fixture.token.address,
      fixture.other.account.address,
      123n,
    ]);

    assert.equal(
      await fixture.token.read.balanceOf([fixture.other.account.address]),
      123n,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      params.grossAmount,
    );
  });

  it("requires the hinted platform signer to be active", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const inactiveParams = await makeParams(
      fixture,
      "inactive-platform-signer",
    );
    const inactiveSigs = await signMatter(fixture, inactiveParams);

    await fixture.escrow.write.setPlatformSigner([
      fixture.platformSigner.account.address,
      false,
    ]);
    await fixture.payorToken.write.approve([
      fixture.escrow.address,
      inactiveParams.grossAmount,
    ]);
    await assert.rejects(
      fixture.relayerEscrow.write.submitMatterWithAllowance([
        inactiveParams,
        inactiveSigs,
        true,
      ]),
    );

    await fixture.escrow.write.setPlatformSigner([
      fixture.other.account.address,
      true,
    ]);
    const rotatedParams = await makeParams(fixture, "rotated-platform-signer");
    const rotatedSigs = await signMatter(fixture, rotatedParams, fixture.other);

    await fixture.payorToken.write.approve([
      fixture.escrow.address,
      rotatedParams.grossAmount,
    ]);
    await fixture.relayerEscrow.write.submitMatterWithAllowance([
      rotatedParams,
      rotatedSigs,
      true,
    ]);

    assert.equal(
      Number(
        await fixture.escrow.read.getMatterStatus([rotatedParams.matterId]),
      ),
      2,
    );
  });

  it("accepts an EIP-1271 smart contract platform signer", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const smartPlatformSigner = await viem.deployContract("MockERC1271Wallet", [
      fixture.platformSigner.account.address,
    ]);
    await fixture.escrow.write.setPlatformSigner([
      fixture.platformSigner.account.address,
      false,
    ]);
    await fixture.escrow.write.setPlatformSigner([
      smartPlatformSigner.address,
      true,
    ]);

    const params = await makeParams(fixture, "erc1271-platform");
    const sigs = await signMatter(
      fixture,
      params,
      fixture.platformSigner,
      smartPlatformSigner.address,
    );

    await fixture.payorToken.write.approve([
      fixture.escrow.address,
      params.grossAmount,
    ]);
    await fixture.relayerEscrow.write.submitMatterWithAllowance([
      params,
      sigs,
      true,
    ]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      2,
    );
  });
});
