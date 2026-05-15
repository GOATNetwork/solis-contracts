import { listDeployments, status } from "@nomicfoundation/ignition-core";
import { emptyTask, task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import type { TaskDefinition } from "hardhat/types/tasks";
import path from "node:path";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";

type TransferRegistryOwnerArgs = {
  newOwner: string;
  deploymentId: string;
};

type SetPlatformSignerArgs = {
  signer: string;
  active: boolean;
  deploymentId: string;
};

type PublicClientWithCode = {
  getBytecode: (args: {
    address: Address;
  }) => Promise<`0x${string}` | undefined>;
};

const REGISTRY_FUTURE_ID = "SolisCoreModule#SolisRegistry";
const ESCROW_FUTURE_ID = "SolisCoreModule#SolisEscrow";

function parseNonZeroAddress(value: string, label: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${label} must be a valid address`);
  }

  const address = getAddress(value);
  if (address === zeroAddress) {
    throw new Error(`${label} cannot be the zero address`);
  }

  return address;
}

function optionalDeploymentId(deploymentId: string): string | undefined {
  return deploymentId === "" ? undefined : deploymentId;
}

async function requireContractCode(
  publicClient: PublicClientWithCode,
  address: Address,
  label: string,
) {
  const bytecode = await publicClient.getBytecode({ address });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`${label} must point to a deployed contract`);
  }
}

async function resolveDeploymentId(
  deploymentsDir: string,
  preferredDeploymentId: string,
  requestedDeploymentId?: string,
): Promise<string> {
  const deployments = await listDeployments(deploymentsDir);

  if (deployments.length === 0) {
    throw new Error(
      "No Ignition deployments found. Run an ignition deploy first.",
    );
  }

  if (requestedDeploymentId !== undefined) {
    if (!deployments.includes(requestedDeploymentId)) {
      throw new Error(
        `Ignition deployment '${requestedDeploymentId}' was not found. Available deployments: ${deployments.join(", ")}`,
      );
    }

    return requestedDeploymentId;
  }

  if (deployments.includes(preferredDeploymentId)) {
    return preferredDeploymentId;
  }

  if (deployments.length === 1) {
    return deployments[0];
  }

  throw new Error(
    `Could not infer Ignition deployment. Expected '${preferredDeploymentId}' for this network, but available deployments are: ${deployments.join(", ")}. Pass --deployment-id to choose one.`,
  );
}

async function resolveIgnitionContractAddress({
  ignitionPath,
  chainId,
  deploymentId,
  futureId,
}: {
  ignitionPath: string;
  chainId: number;
  deploymentId?: string;
  futureId: string;
}): Promise<{ address: Address; deploymentId: string }> {
  const deploymentsDir = path.join(ignitionPath, "deployments");
  const resolvedDeploymentId = await resolveDeploymentId(
    deploymentsDir,
    `chain-${chainId}`,
    deploymentId,
  );
  const deploymentDir = path.join(deploymentsDir, resolvedDeploymentId);
  const deploymentStatus = await status(deploymentDir);
  const contract = deploymentStatus.contracts[futureId];

  if (contract === undefined) {
    const availableContracts = Object.keys(deploymentStatus.contracts);
    throw new Error(
      `Contract future '${futureId}' was not found in Ignition deployment '${resolvedDeploymentId}'. Available contracts: ${availableContracts.join(", ")}`,
    );
  }

  return {
    address: parseNonZeroAddress(contract.address, futureId),
    deploymentId: resolvedDeploymentId,
  };
}

const solisTasks: TaskDefinition[] = [
  emptyTask("solis", "Solis operational tasks").build(),

  task(
    ["solis", "transfer-registry-owner"],
    "Transfer ownership of a SolisRegistry",
  )
    .addPositionalArgument({
      name: "newOwner",
      description: "New registry owner address",
    })
    .addOption({
      name: "deploymentId",
      description: "Ignition deployment ID to read contract addresses from",
      type: ArgumentType.STRING,
      defaultValue: "",
    })
    .setInlineAction(
      async (
        { newOwner, deploymentId }: TransferRegistryOwnerArgs,
        hre,
      ): Promise<void> => {
        const newOwnerAddress = parseNonZeroAddress(newOwner, "newOwner");
        const connection = await hre.network.getOrCreate();
        const publicClient = await connection.viem.getPublicClient();
        const [walletClient] = await connection.viem.getWalletClients();

        if (walletClient === undefined) {
          throw new Error("No wallet client is configured for this network");
        }

        const chainId = await publicClient.getChainId();
        const { address: registryAddress, deploymentId: resolvedDeploymentId } =
          await resolveIgnitionContractAddress({
            ignitionPath: hre.config.paths.ignition,
            chainId,
            deploymentId: optionalDeploymentId(deploymentId),
            futureId: REGISTRY_FUTURE_ID,
          });

        await requireContractCode(publicClient, registryAddress, "registry");

        const registryContract = await connection.viem.getContractAt(
          "SolisRegistry",
          registryAddress,
          { client: { public: publicClient, wallet: walletClient } },
        );
        const previousOwner = await registryContract.read.owner();
        const hash = await registryContract.write.transferOwnership([
          newOwnerAddress,
        ]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`Transaction reverted: ${hash}`);
        }

        const finalOwner = await registryContract.read.owner();
        if (getAddress(finalOwner) !== newOwnerAddress) {
          throw new Error(
            `Registry owner did not update to ${newOwnerAddress}`,
          );
        }

        console.log(`Deployment: ${resolvedDeploymentId}`);
        console.log(`Registry: ${registryAddress}`);
        console.log(`Previous owner: ${previousOwner}`);
        console.log(`New owner: ${finalOwner}`);
        console.log(`Transaction: ${hash}`);
      },
    )
    .build(),

  task(
    ["solis", "set-platform-signer"],
    "Enable or disable a SolisEscrow platform signer",
  )
    .addPositionalArgument({
      name: "signer",
      description: "Platform signer address",
    })
    .addOption({
      name: "active",
      description: "Whether the signer should be active",
      type: ArgumentType.BOOLEAN,
      defaultValue: true,
    })
    .addOption({
      name: "deploymentId",
      description: "Ignition deployment ID to read contract addresses from",
      type: ArgumentType.STRING,
      defaultValue: "",
    })
    .setInlineAction(
      async (
        { signer, active, deploymentId }: SetPlatformSignerArgs,
        hre,
      ): Promise<void> => {
        const signerAddress = parseNonZeroAddress(signer, "signer");
        const connection = await hre.network.getOrCreate();
        const publicClient = await connection.viem.getPublicClient();
        const [walletClient] = await connection.viem.getWalletClients();

        if (walletClient === undefined) {
          throw new Error("No wallet client is configured for this network");
        }

        const chainId = await publicClient.getChainId();
        const { address: escrowAddress, deploymentId: resolvedDeploymentId } =
          await resolveIgnitionContractAddress({
            ignitionPath: hre.config.paths.ignition,
            chainId,
            deploymentId: optionalDeploymentId(deploymentId),
            futureId: ESCROW_FUTURE_ID,
          });

        await requireContractCode(publicClient, escrowAddress, "escrow");

        const escrowContract = await connection.viem.getContractAt(
          "SolisEscrow",
          escrowAddress,
          { client: { public: publicClient, wallet: walletClient } },
        );
        const previousActive = await escrowContract.read.platformSigners([
          signerAddress,
        ]);
        const hash = await escrowContract.write.setPlatformSigner([
          signerAddress,
          active,
        ]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`Transaction reverted: ${hash}`);
        }

        const finalActive = await escrowContract.read.platformSigners([
          signerAddress,
        ]);
        if (finalActive !== active) {
          throw new Error(
            `Platform signer active state did not update to ${active}`,
          );
        }

        console.log(`Deployment: ${resolvedDeploymentId}`);
        console.log(`Escrow: ${escrowAddress}`);
        console.log(`Signer: ${signerAddress}`);
        console.log(`Previously active: ${previousActive}`);
        console.log(`Active: ${finalActive}`);
        console.log(`Transaction: ${hash}`);
      },
    )
    .build(),
];

export default solisTasks;
