# Labelled fences in a code group

The site shows these as tabs. The check reads each tab as its own snippet: the first loads, the
second fails the typecheck.

::: code-group

```ts [Valid]
import { defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
});
```

```ts [Type error]
import { defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: { defaults: { timeoutMs: "30s" } },
});
```

```sh [npm]
npm install --save-dev hardhat-kms @hardhat-kms/aws
```

:::
