# Configs that print while they load

A config that writes to stdout and loads:

```ts
import hardhatKmsAws from "@hardhat-kms/aws";
import { defineConfig } from "hardhat/config";

console.log("[]");

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: { keys: { deployer: { provider: "aws", keyId: "alias/deployer" } } },
});
```

A config that writes to stdout and fails Hardhat's validation:

```ts
import hardhatKmsAws from "@hardhat-kms/aws";
import { defineConfig } from "hardhat/config";

console.log("loading the config");

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: { keys: { deployer: { provider: "aws", keyId: "alias/deployer", address: "0x…" } } },
});
```
