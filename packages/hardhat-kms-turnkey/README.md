# @hardhat-kms/turnkey

The Turnkey provider for [hardhat-kms](https://github.com/aelmanaa/hardhat-kms): Hardhat 3 signs transactions, messages and typed data with an Ethereum wallet account held in [Turnkey](https://www.turnkey.com). The private key never leaves Turnkey. The plugin calls Turnkey's API with an API key and has no runtime dependencies.

Not affiliated with or endorsed by Turnkey.

## Install

In a Hardhat 3 project (`npx hardhat --init` creates one):

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/turnkey
```

`@hardhat-kms/turnkey` needs `hardhat-kms` at the same version. The packages run on Node.js 22.13.0 or later ([Supported Node.js versions](https://aelmanaa.github.io/hardhat-kms/user/reference/support)).

## Configure

Add `@hardhat-kms/turnkey` to `plugins`. It loads `hardhat-kms` itself.

```ts
import hardhatKmsTurnkey from "@hardhat-kms/turnkey";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsTurnkey],
  kms: {
    keys: {
      deployer: {
        provider: "turnkey",
        organizationId: configVariable("TURNKEY_ORGANIZATION_ID"),
        address: "0x1111111111111111111111111111111111111111", // the wallet account
        apiPrivateKey: configVariable("TURNKEY_API_PRIVATE_KEY"),
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

- `organizationId`: the organization or sub-organization that holds the wallet account, a UUID.
- `address`: the wallet account's address. Required: the plugin signs with it and checks every signature against it.
- `apiPrivateKey`: the private key of a P-256 Turnkey API key, as a configuration variable only. Set it in the environment or in `hardhat-keystore`.
- `apiPublicKey`: optional. The plugin derives it from the private key; when you set it, the plugin checks that the two match before it sends anything.

## What Turnkey receives

Each signature is one `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2` activity, with `signWith` set to the address. The key's Turnkey policies must allow all three forms:

| Request                                                                    | `encoding`                     | `hashFunction`            | `payload`                       |
| -------------------------------------------------------------------------- | ------------------------------ | ------------------------- | ------------------------------- |
| Transactions, EIP-7702 authorizations, `kms sign-tx`, `kms sign --no-hash` | `PAYLOAD_ENCODING_HEXADECIMAL` | `HASH_FUNCTION_NO_OP`     | the 32-byte digest              |
| `personal_sign`, `eth_sign`, `kms sign`                                    | `PAYLOAD_ENCODING_HEXADECIMAL` | `HASH_FUNCTION_KECCAK256` | the EIP-191 message with prefix |
| `eth_signTypedData_v4`, `kms sign --data`                                  | `PAYLOAD_ENCODING_EIP712`      | `HASH_FUNCTION_NO_OP`     | the typed data as JSON          |

A key whose policy needs approval from other users or another authenticator fails at once, and the error names the pending activity so that you can reject it in the Turnkey dashboard. The plugin does not wait for approvals.

- [Configuration reference](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration).
- [All docs](https://aelmanaa.github.io/hardhat-kms/).
