import hardhatKmsAws from "@hardhat-kms/aws";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatViem],
  solidity: "0.8.24",
  kms: {
    keys: {
      // Add `address: "0x…"` once you know the key's address: the plugin then refuses a different
      // key behind the same id, and lists the account without a KMS call. Signing still reads the
      // public key once per run, to check it against the pin.
      deployer: {
        provider: "aws",
        keyId: configVariable("AWS_KMS_KEY_ID"),
        // Optional: on a laptop, set AWS_KMS_PROFILE to sign through a profile, such as an SSO
        // one. Left unset, the value is empty, so there is no profile and the AWS SDK uses its
        // default chain, environment keys included, as a CI job needs.
        profile: configVariable("AWS_KMS_PROFILE", { default: "" }),
        // Optional: the key's region. An ARN in AWS_KMS_KEY_ID names its own. Left unset, the AWS
        // SDK's region applies: AWS_REGION, then the profile's region.
        region: configVariable("AWS_KMS_REGION", { default: "" }),
      },
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
