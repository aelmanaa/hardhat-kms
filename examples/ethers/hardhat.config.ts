import hardhatKmsAws from "@hardhat-kms/aws";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatTypechain from "@nomicfoundation/hardhat-typechain";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatEthers, hardhatTypechain],
  solidity: "0.8.24",
  kms: {
    keys: {
      // Add `address: "0x…"` once you know the key's address: the plugin then refuses a different
      // key behind the same id, and lists the account without a KMS call. Signing still reads the
      // public key once per run, to check it against the pin.
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
