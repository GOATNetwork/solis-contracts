import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.35",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "osaka",
          viaIR: true,
        },
      },
      production: {
        version: "0.8.35",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
          evmVersion: "osaka",
          metadata: {
            bytecodeHash: "none",
            useLiteralContent: true,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
});
