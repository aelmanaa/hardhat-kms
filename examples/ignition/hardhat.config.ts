import hardhatKmsAws from "@hardhat-kms/aws";
import hardhatIgnitionViem from "@nomicfoundation/hardhat-ignition-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatIgnitionViem],
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
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
    // For keys passed with --kms: a simulated network that lists no KMS keys of its own.
    rehearsalCli: { type: "edr-simulated" },
  },
});
