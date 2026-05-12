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
  paymentDeadline: bigint;
  confirmationDeadline: bigint;
  registryVersion: bigint;
};

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

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
    { name: "paymentDeadline", type: "uint64" },
    { name: "confirmationDeadline", type: "uint64" },
    { name: "registryVersion", type: "uint256" },
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

describe("Solis MVP v1.3", async function () {
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

    await registry.write.registerVersion([1n, escrow.address, "1.3.0"]);
    await token.write.mint([payor.account.address, 100_000_000n]);

    const payorToken = await viem.getContractAt("MockUSDC", token.address, {
      client: { wallet: payor },
    });
    const payorEscrow = await viem.getContractAt(
      "SolisEscrow",
      escrow.address,
      {
        client: { wallet: payor },
      },
    );
    const recipientEscrow = await viem.getContractAt(
      "SolisEscrow",
      escrow.address,
      {
        client: { wallet: recipient },
      },
    );
    const pauserEscrow = await viem.getContractAt(
      "SolisEscrow",
      escrow.address,
      {
        client: { wallet: pauser },
      },
    );
    const otherEscrow = await viem.getContractAt(
      "SolisEscrow",
      escrow.address,
      {
        client: { wallet: other },
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
      payorEscrow,
      recipientEscrow,
      pauserEscrow,
      otherEscrow,
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
    const paymentDeadline = overrides.paymentDeadline ?? now + 3_600n;
    const confirmationDeadline =
      overrides.confirmationDeadline ?? paymentDeadline + 3_600n;

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
      paymentDeadline,
      confirmationDeadline,
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
      signer: platformSignerAddress,
      signature: await platformSigner.signTypedData(typedData),
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

  async function fundMatter(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    params: MatterParams,
    platformSig?: Awaited<ReturnType<typeof signMatter>>,
  ) {
    const sig = platformSig ?? (await signMatter(fixture, params));
    const auth = await signUSDCAuth(fixture, params, `fund:${params.matterId}`);
    await fixture.payorEscrow.write.payAndSubmitMatter([params, sig, auth]);
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
        "1.3.0",
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
        "1.3.0",
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
        "1.0.0",
      ]),
    );
  });

  it("allows only the Payor to fund a platform-approved Matter", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const params = await makeParams(fixture, "payor-paid");
    const platformSig = await signMatter(fixture, params);
    const auth = await signUSDCAuth(fixture, params, "non-payor");

    await assert.rejects(
      fixture.otherEscrow.write.payAndSubmitMatter([params, platformSig, auth]),
    );

    await fundMatter(fixture, params, platformSig);

    const matter = await fixture.escrow.read.getMatter([params.matterId]);
    assert.equal(Number(matter.status), 1);
    assert.equal(
      await fixture.escrow.read.getSettlementDigest([params.matterId]),
      params.settlementDigest,
    );
    assert.deepEqual(
      await fixture.escrow.read.getDeadlines([params.matterId]),
      [params.paymentDeadline, params.confirmationDeadline],
    );
    assert.equal(
      await fixture.token.read.balanceOf([fixture.escrow.address]),
      params.grossAmount,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      params.grossAmount,
    );
    assert.equal(
      await fixture.escrow.read.isRecipientActionable([params.matterId]),
      true,
    );
  });

  it("rejects invalid payment submissions before moving funds", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);

    const duplicateParams = await makeParams(fixture, "duplicate");
    const duplicateSig = await signMatter(fixture, duplicateParams);
    const duplicateAuth = await signUSDCAuth(
      fixture,
      duplicateParams,
      "duplicate",
    );
    await fixture.payorEscrow.write.payAndSubmitMatter([
      duplicateParams,
      duplicateSig,
      duplicateAuth,
    ]);
    await assert.rejects(
      fixture.payorEscrow.write.payAndSubmitMatter([
        duplicateParams,
        duplicateSig,
        duplicateAuth,
      ]),
    );

    const expiredNow = BigInt(await networkHelpers.time.latest());
    const expiredParams = await makeParams(fixture, "expired-payment", {
      paymentDeadline: expiredNow + 10n,
      confirmationDeadline: expiredNow + 20n,
    });
    const expiredSig = await signMatter(fixture, expiredParams);
    const expiredAuth = await signUSDCAuth(fixture, expiredParams, "expired");
    await networkHelpers.time.increaseTo(expiredNow + 11n);
    await assert.rejects(
      fixture.payorEscrow.write.payAndSubmitMatter([
        expiredParams,
        expiredSig,
        expiredAuth,
      ]),
    );

    const inactiveSignerParams = await makeParams(
      fixture,
      "inactive-platform-signer",
    );
    const inactiveSignerSig = await signMatter(fixture, inactiveSignerParams);
    const inactiveSignerAuth = await signUSDCAuth(
      fixture,
      inactiveSignerParams,
      "inactive-signer",
    );
    await assert.rejects(
      fixture.payorEscrow.write.payAndSubmitMatter([
        inactiveSignerParams,
        {
          signer: fixture.other.account.address,
          signature: inactiveSignerSig.signature,
        },
        inactiveSignerAuth,
      ]),
    );

    const wrongToken = await viem.deployContract("MockUSDC");
    const wrongTokenParams = await makeParams(fixture, "wrong-token", {
      token: wrongToken.address,
    });
    const wrongTokenSig = await signMatter(fixture, wrongTokenParams);
    const wrongTokenAuth = await signUSDCAuth(
      fixture,
      wrongTokenParams,
      "wrong-token",
    );
    await assert.rejects(
      fixture.payorEscrow.write.payAndSubmitMatter([
        wrongTokenParams,
        wrongTokenSig,
        wrongTokenAuth,
      ]),
    );

    const badHashParams = await makeParams(fixture, "bad-hash", {
      settlementDigest: ZERO_BYTES32,
    });
    const badHashSig = await signMatter(fixture, badHashParams);
    const badHashAuth = await signUSDCAuth(fixture, badHashParams, "bad-hash");
    await assert.rejects(
      fixture.payorEscrow.write.payAndSubmitMatter([
        badHashParams,
        badHashSig,
        badHashAuth,
      ]),
    );

    const badAmountParams = await makeParams(fixture, "bad-amount", {
      grossAmount: 1_000_001n,
    });
    const badAmountSig = await signMatter(fixture, badAmountParams);
    const badAmountAuth = await signUSDCAuth(
      fixture,
      badAmountParams,
      "bad-amount",
    );
    await assert.rejects(
      fixture.payorEscrow.write.payAndSubmitMatter([
        badAmountParams,
        badAmountSig,
        badAmountAuth,
      ]),
    );
  });

  it("rejects token funding that transfers less than grossAmount", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const shortToken = await viem.deployContract("MockShortTransferUSDC", [1n]);
    await shortToken.write.mint([fixture.payor.account.address, 100_000_000n]);
    const shortEscrow = await viem.deployContract("SolisEscrow", [
      fixture.owner.account.address,
      fixture.platformSigner.account.address,
      fixture.pauser.account.address,
      shortToken.address,
      fixture.registry.address,
      2n,
    ]);
    const shortPayorToken = await viem.getContractAt(
      "MockShortTransferUSDC",
      shortToken.address,
      {
        client: { wallet: fixture.payor },
      },
    );
    const shortPayorEscrow = await viem.getContractAt(
      "SolisEscrow",
      shortEscrow.address,
      {
        client: { wallet: fixture.payor },
      },
    );
    const shortFixture = {
      ...fixture,
      token: shortToken,
      escrow: shortEscrow,
      payorToken: shortPayorToken,
      payorEscrow: shortPayorEscrow,
    } as unknown as Awaited<ReturnType<typeof deployFixture>>;

    const params = await makeParams(shortFixture, "short-transfer", {
      registryVersion: 2n,
    });
    const platformSig = await signMatter(shortFixture, params);
    const auth = await signUSDCAuth(shortFixture, params, "short-transfer");

    await assert.rejects(
      shortPayorEscrow.write.payAndSubmitMatter([params, platformSig, auth]),
    );
    assert.equal(
      Number(await shortEscrow.read.getMatterStatus([params.matterId])),
      0,
    );
    assert.equal(
      await shortEscrow.read.accountedBalance([shortToken.address]),
      0n,
    );
  });

  it("immediately releases funds after Recipient confirmation", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const params = await makeParams(fixture, "confirm-release");

    await fundMatter(fixture, params);
    await fixture.recipientEscrow.write.confirmAndRelease([params]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      3,
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

    const matter = await fixture.escrow.read.getMatter([params.matterId]);
    assert.notEqual(matter.confirmedAt, 0);
    assert.notEqual(matter.releasedAt, 0);
  });

  it("refunds the Payor when Recipient rejects", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const params = await makeParams(fixture, "recipient-reject");

    await fundMatter(fixture, params);
    await fixture.recipientEscrow.write.rejectAndRefund([params]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      5,
    );
    assert.equal(
      await fixture.token.read.balanceOf([fixture.payor.account.address]),
      100_000_000n,
    );
    assert.equal(
      await fixture.escrow.read.accountedBalance([fixture.token.address]),
      0n,
    );

    const matter = await fixture.escrow.read.getMatter([params.matterId]);
    assert.notEqual(matter.rejectedAt, 0);
    assert.notEqual(matter.refundedAt, 0);
  });

  it("allows Payor or platform operator timeout refunds only after confirmation deadline", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const now = BigInt(await networkHelpers.time.latest());
    const platformRefundParams = await makeParams(fixture, "platform-timeout", {
      paymentDeadline: now + 100n,
      confirmationDeadline: now + 200n,
    });

    await fundMatter(fixture, platformRefundParams);
    await assert.rejects(
      fixture.pauserEscrow.write.refundAfterConfirmationDeadline([
        platformRefundParams.matterId,
      ]),
    );

    await networkHelpers.time.increaseTo(
      platformRefundParams.confirmationDeadline + 1n,
    );
    await assert.rejects(
      fixture.otherEscrow.write.refundAfterConfirmationDeadline([
        platformRefundParams.matterId,
      ]),
    );
    await fixture.pauserEscrow.write.refundAfterConfirmationDeadline([
      platformRefundParams.matterId,
    ]);
    assert.equal(
      Number(
        await fixture.escrow.read.getMatterStatus([
          platformRefundParams.matterId,
        ]),
      ),
      5,
    );

    const payorRefundParams = await makeParams(fixture, "payor-timeout");
    await fundMatter(fixture, payorRefundParams);
    await networkHelpers.time.increaseTo(
      payorRefundParams.confirmationDeadline + 1n,
    );
    await fixture.payorEscrow.write.refundAfterConfirmationDeadline([
      payorRefundParams.matterId,
    ]);
    assert.equal(
      Number(
        await fixture.escrow.read.getMatterStatus([payorRefundParams.matterId]),
      ),
      5,
    );
  });

  it("treats global pause as a full freeze for funding and fund movement", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const params = await makeParams(fixture, "global-pause");
    const platformSig = await signMatter(fixture, params);
    const auth = await signUSDCAuth(fixture, params, "global-pause");

    await fixture.pauserEscrow.write.pause();
    await assert.rejects(
      fixture.payorEscrow.write.payAndSubmitMatter([params, platformSig, auth]),
    );

    await fixture.pauserEscrow.write.unpause();
    await fixture.payorEscrow.write.payAndSubmitMatter([
      params,
      platformSig,
      auth,
    ]);

    await fixture.pauserEscrow.write.pause();
    await assert.rejects(
      fixture.recipientEscrow.write.confirmAndRelease([params]),
    );
    await assert.rejects(
      fixture.recipientEscrow.write.rejectAndRefund([params]),
    );
    await networkHelpers.time.increaseTo(params.confirmationDeadline + 1n);
    await assert.rejects(
      fixture.payorEscrow.write.refundAfterConfirmationDeadline([
        params.matterId,
      ]),
    );
  });

  it("blocks Recipient actions and timeout refunds while a Matter is paused", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const params = await makeParams(fixture, "matter-pause");

    await fundMatter(fixture, params);
    await fixture.pauserEscrow.write.pauseMatter([
      params.matterId,
      digest("compliance-review"),
    ]);

    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      6,
    );
    assert.equal(
      await fixture.escrow.read.isRecipientActionable([params.matterId]),
      false,
    );
    await assert.rejects(
      fixture.recipientEscrow.write.confirmAndRelease([params]),
    );
    await assert.rejects(
      fixture.recipientEscrow.write.rejectAndRefund([params]),
    );
    await networkHelpers.time.increaseTo(params.confirmationDeadline + 1n);
    await assert.rejects(
      fixture.payorEscrow.write.refundAfterConfirmationDeadline([
        params.matterId,
      ]),
    );

    await fixture.pauserEscrow.write.unpauseMatter([params.matterId]);
    await fixture.payorEscrow.write.refundAfterConfirmationDeadline([
      params.matterId,
    ]);
    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      5,
    );
  });

  it("does not sweep accounted escrow funds but can sweep excess tokens", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const params = await makeParams(fixture, "sweep");

    await fundMatter(fixture, params);
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
      "inactive-platform-signer-rotation",
    );
    const inactiveSig = await signMatter(fixture, inactiveParams);
    const inactiveAuth = await signUSDCAuth(
      fixture,
      inactiveParams,
      "inactive-rotation",
    );

    await fixture.escrow.write.setPlatformSigner([
      fixture.platformSigner.account.address,
      false,
    ]);
    await assert.rejects(
      fixture.payorEscrow.write.payAndSubmitMatter([
        inactiveParams,
        inactiveSig,
        inactiveAuth,
      ]),
    );

    await fixture.escrow.write.setPlatformSigner([
      fixture.other.account.address,
      true,
    ]);
    const rotatedParams = await makeParams(fixture, "rotated-platform-signer");
    const rotatedSig = await signMatter(fixture, rotatedParams, fixture.other);

    await fundMatter(fixture, rotatedParams, rotatedSig);
    assert.equal(
      Number(
        await fixture.escrow.read.getMatterStatus([rotatedParams.matterId]),
      ),
      1,
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
    const platformSig = await signMatter(
      fixture,
      params,
      fixture.platformSigner,
      smartPlatformSigner.address,
    );

    await fundMatter(fixture, params, platformSig);
    assert.equal(
      Number(await fixture.escrow.read.getMatterStatus([params.matterId])),
      1,
    );
  });
});
