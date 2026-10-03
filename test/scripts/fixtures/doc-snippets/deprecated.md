# Deprecated calls in snippets

A snippet that calls an API marked `@deprecated` fails, with the Markdown line of the call.

```ts
import hre from "hardhat";

const connection = await hre.network.connect();
console.log(connection.networkName);
```

The same call after the skip marker is not checked.

<!-- docs-check: skip -->

```ts
import hre from "hardhat";

await hre.network.connect();
```

The current API passes.

```ts
import hre from "hardhat";

const connection = await hre.network.create();
console.log(connection.networkName);
```
