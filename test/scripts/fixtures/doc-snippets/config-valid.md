# A config that loads

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    defaults: { aws: { region: configVariable("AWS_REGION") } },
    keys: {
      deployer: {
        provider: "aws",
        keyId: "alias/deployer",
        address: "0x1111111111111111111111111111111111111111",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```
