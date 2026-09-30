# hardhat-kms-aws

> In development. Not published to npm yet.

The AWS KMS provider for [hardhat-kms](https://github.com/aelmanaa/hardhat-kms): Hardhat 3 signs transactions, messages and typed data with secp256k1 keys held in AWS KMS. The private key never leaves KMS.

It depends on `@aws-sdk/client-kms`, so there is no SDK to install separately.

## Install

```sh
npm install --save-dev hardhat-kms hardhat-kms-aws
```

## Usage

Add `hardhat-kms-aws` to `plugins`. It loads `hardhat-kms` itself.

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "hardhat-kms-aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: ["deployer"],
    },
  },
});
```

Credentials come from the AWS SDK's default chain: environment variables, `~/.aws` profiles and SSO, or the role of the machine or CI job. A key's `profile` option picks a named profile. The key must be an asymmetric `ECC_SECG_P256K1` key with key usage `SIGN_VERIFY`.

## Docs

- [AWS KMS setup](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/aws-kms-setup.md): create a key, grant access, configure Hardhat
- [Configuration reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/configuration.md)
- All docs: [docs/README.md](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md)
