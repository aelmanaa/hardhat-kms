# @hardhat-kms/gcp

The Google Cloud KMS provider for [hardhat-kms](https://github.com/aelmanaa/hardhat-kms): Hardhat 3 signs transactions, messages and typed data with secp256k1 keys held in Google Cloud KMS. The private key never leaves Cloud KMS. Every request and response is checked with CRC32C. The package depends on `@google-cloud/kms`, so there is no SDK to install separately.

Works with Google Cloud KMS. Not affiliated with or endorsed by Google.

0.9.0 is the release candidate for 1.0.0; install it to test. Until 1.0.0 is published, use it with test keys on testnets.

## Key type

A key version with the algorithm `EC_SIGN_SECP256K1_SHA256`, at protection level HSM.

## Install

In a Hardhat 3 project (`npx hardhat --init` creates one):

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/gcp
```

`@hardhat-kms/gcp` needs `hardhat-kms` at the same version. The packages run on Node.js 22.13.0 or later ([Support](https://aelmanaa.github.io/hardhat-kms/user/reference/support)).

## Configure

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
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

`keyVersionName` names one key version, so the key behind it never changes. The [configuration reference](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration) lists every option.

## Check the key

1. Run `npx hardhat kms accounts`. It reads the key's public key and prints its address, and below the table the `address` pin to add.
2. Add the pin to the key's entry, for example `deployer: { provider: "gcp", keyVersionName: "projects/…/cryptoKeyVersions/1", address: "0x…" }`. The pin is optional. Without it, the plugin still checks every signature against the address it derives from the key's public key. With it, the plugin also refuses to sign when `keyVersionName` is edited to name another key.
3. Run `npx hardhat kms accounts --check-sign`. `ok` in the `SIGN` column proves that your credentials may sign with the key, not only read it. The key signs a random message, not a transaction, so this needs no network and no funds.

## Credentials and permissions

The plugin passes no credentials, so the Google Cloud client finds them through Application Default Credentials: the file named by `GOOGLE_APPLICATION_CREDENTIALS`, the file `gcloud auth application-default login` writes, or the service account of the machine. Prefer your own sign-in, impersonation or workload identity federation to a service account key file, which Google does not recommend. No credentials go in the Hardhat config. The identity needs `cloudkms.cryptoKeyVersions.viewPublicKey` to read the address and `cloudkms.cryptoKeyVersions.useToSign` to sign.

- [Set up a Google Cloud KMS key](https://aelmanaa.github.io/hardhat-kms/user/guides/gcp-kms-setup): create the key, grant access, configure Hardhat.
- [Permissions](https://aelmanaa.github.io/hardhat-kms/user/guides/gcp-kms-setup#2-allow-signing-and-nothing-else) and [credential sources](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration#google-cloud) in detail.
- [Errors](https://aelmanaa.github.io/hardhat-kms/user/guides/gcp-kms-setup#errors): what each failure means and how to fix it.
- [All docs](https://aelmanaa.github.io/hardhat-kms/).
