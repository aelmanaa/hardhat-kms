# @hardhat-kms/gcp

Works with Google Cloud KMS. Not affiliated with or endorsed by Google.

> In development. Not published to npm yet.

The Google Cloud KMS provider for [hardhat-kms](https://github.com/aelmanaa/hardhat-kms): Hardhat 3 signs transactions, messages and typed data with secp256k1 keys held in Google Cloud KMS. The private key never leaves Cloud KMS.

It depends on `@google-cloud/kms`, so there is no SDK to install separately.

## Install

```sh
npm install --save-dev hardhat-kms @hardhat-kms/gcp
```

Node.js support: see [Support](https://github.com/aelmanaa/hardhat-kms#support).

## Usage

Add `@hardhat-kms/gcp` to `plugins`. It loads `hardhat-kms` itself.

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsGcp from "@hardhat-kms/gcp";

export default defineConfig({
  plugins: [hardhatKmsGcp],
  kms: {
    keys: {
      deployer: {
        provider: "gcp",
        keyVersionName:
          "projects/my-project/locations/europe-west1/keyRings/deployer-ring/cryptoKeys/deployer/cryptoKeyVersions/1",
      },
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

Credentials come from Application Default Credentials: `gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS`, or the service account of the machine or CI job. Prefer your own `gcloud auth application-default login`, impersonation or workload identity federation to a service account key file, which Google does not recommend ([How Application Default Credentials works](https://docs.cloud.google.com/docs/authentication/application-default-credentials)). The key version must use the algorithm `EC_SIGN_SECP256K1_SHA256`, at protection level HSM. Every request and response is checked with CRC32C.

## Docs

- [Google Cloud KMS setup](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/gcp-kms-setup.md): create a key, grant access, configure Hardhat
- [Configuration reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/configuration.md)
- All docs: [docs/README.md](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md)
