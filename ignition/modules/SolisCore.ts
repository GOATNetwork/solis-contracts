import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

export default buildModule("SolisCoreModule", (m) => {
  const owner = m.getParameter("owner", m.getAccount(0));
  const platformSigner = m.getParameter("platformSigner", m.getAccount(1));
  const pauser = m.getParameter("pauser", m.getAccount(2));
  const allowedToken = m.getParameter("allowedToken", MAINNET_USDC);
  const registryVersion = m.getParameter("registryVersion", 1n);
  const semver = m.getParameter("semver", "1.0.0");

  const registry = m.contract("SolisRegistry", [owner]);
  const escrow = m.contract("SolisEscrow", [
    owner,
    platformSigner,
    pauser,
    allowedToken,
    registry,
    registryVersion,
  ]);

  m.call(registry, "registerVersion", [registryVersion, escrow, semver]);

  return { registry, escrow };
});
