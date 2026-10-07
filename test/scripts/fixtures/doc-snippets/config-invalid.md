# Configs that typecheck and fail Hardhat's validation

An address pin that is not an address, as an earlier configuration reference had:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer", address: "0x1234…" },
    },
  },
  networks: {
    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },
  },
});
```

A network that names a key `kms.keys` does not declare:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer" },
    },
  },
  networks: {
    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deploer"] },
  },
});
```

A skipped fragment is not loaded:

<!-- docs-check: skip -->

```ts
import { defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: { keys: { deployer: { provider: "aws", keyId: "alias/deployer", address: "0x…" } } },
});
```
