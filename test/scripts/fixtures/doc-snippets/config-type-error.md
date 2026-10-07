# A config that fails the typecheck

It also has an invalid address pin, which loading it would report; it is not loaded, so the type error is
the only problem.

```ts
import { defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    defaults: { timeoutMs: "30s" },
    keys: { deployer: { provider: "aws", keyId: "alias/deployer", address: "0x…" } },
  },
});
```
