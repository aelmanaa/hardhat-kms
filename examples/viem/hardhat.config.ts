import hardhatKmsAws from "@hardhat-kms/aws";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatViem],
  solidity: "0.8.24",
  kms: {
    keys: {
      // Add `address: "0x…"` once you know the key's address: it saves a KMS call per run and
      // refuses a different key behind the same id.
      deployer: { provider: "aws", keyId: configVariable("AWS_KMS_KEY_ID") },
    },
    // The balance of each KMS account on edr-simulated networks, so a rehearsal can pay for gas.
    simulatedBalance: 10n ** 18n,
  },
  networks: {
    // A local rehearsal. `accounts: []` leaves the KMS account as the only account.
    rehearsal: { type: "edr-simulated", accounts: [], kmsAccounts: ["deployer"] },
    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },
  },
});
