# @hardhat-kms/aws

The AWS KMS provider for [hardhat-kms](https://github.com/aelmanaa/hardhat-kms): Hardhat 3 signs transactions, messages and typed data with secp256k1 keys held in AWS KMS. The private key never leaves KMS. The package depends on `@aws-sdk/client-kms`, so there is no SDK to install separately.

Works with AWS KMS. Not affiliated with or endorsed by Amazon Web Services.

0.9.0 is the release candidate for 1.0.0; install it to test. Until 1.0.0 is published, use it with test keys on testnets.

## Key type

An asymmetric `ECC_SECG_P256K1` key with key usage `SIGN_VERIFY`.

## Install

In a Hardhat 3 project (`npx hardhat --init` creates one):

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws
```

`@hardhat-kms/aws` needs `hardhat-kms` at the same version. The packages run on Node.js 22.13.0 or later ([Support](https://aelmanaa.github.io/hardhat-kms/user/reference/support)).

## Configure

Add `@hardhat-kms/aws` to `plugins`. It loads `hardhat-kms` itself.

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
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

`keyId` accepts a key id, a key ARN, an alias name or an alias ARN. The key's region comes from the ARN, the key's `region`, `AWS_REGION` or your AWS profile. The [configuration reference](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration) lists every option.

## Check the key

1. Run `npx hardhat kms accounts`. It reads the key's public key and prints its address, and below the table the `address` pin to add.
2. Add the pin to the key's entry, for example `deployer: { provider: "aws", keyId: "alias/deployer", address: "0x…" }`. The pin is optional. Without it, the plugin still checks every signature against the address it derives from the key's public key. With it, the plugin also refuses to sign when the key id comes to name a different key, such as after an alias moves.
3. Run `npx hardhat kms accounts --check-sign`. `ok` in the `SIGN` column proves that your credentials may sign with the key, not only read it. The key signs a random message, not a transaction, so this needs no network and no funds.

## Credentials and permissions

The plugin passes no credentials, so the AWS SDK finds them itself: access keys in the environment, a profile in `~/.aws` (with SSO or a role to assume), a web identity token, or the role of the container or instance. A key's `profile` option names the profile to use. No credentials go in the Hardhat config. The credentials need `kms:GetPublicKey` to read the address and `kms:Sign` to sign.

- [Set up an AWS KMS key](https://aelmanaa.github.io/hardhat-kms/user/guides/aws-kms-setup): create the key, grant access, configure Hardhat.
- [Permissions](https://aelmanaa.github.io/hardhat-kms/user/guides/aws-kms-setup#2-allow-signing-and-nothing-else) and [credential sources](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration#aws) in detail.
- [Errors](https://aelmanaa.github.io/hardhat-kms/user/guides/aws-kms-setup#errors): what each failure means and how to fix it.
- [All docs](https://aelmanaa.github.io/hardhat-kms/).
