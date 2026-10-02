# Set up a Google Cloud KMS key

Audience: users who sign with a key in Google Cloud KMS.

Status: the Google Cloud adapter is implemented (M6, [#29](https://github.com/aelmanaa/hardhat-kms/issues/29)), in the `hardhat-kms-gcp` package. A connection lists the key's account, signs messages and typed data with it, and signs and sends transactions.

## 1. Create a secp256k1 signing key

Ethereum uses the secp256k1 curve, which Cloud KMS calls `EC_SIGN_SECP256K1_SHA256`. Create a key ring, then an asymmetric signing key in it, at protection level HSM:

```sh
gcloud kms keyrings create deployer-ring --location europe-west1

gcloud kms keys create deployer \
  --keyring deployer-ring \
  --location europe-west1 \
  --purpose asymmetric-signing \
  --default-algorithm ec-sign-secp256k1-sha256 \
  --protection-level hsm
```

The key gets version `1`. The plugin always signs with the version you configure; it never picks a version for you. An asymmetric key has no primary version: Cloud KMS gives `primary` only to `ENCRYPT_DECRYPT` keys ([`CryptoKey.primary`](https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys#CryptoKey.FIELDS.primary)).

Use `--protection-level hsm`. Creating this key at protection level `software` failed on 2026-10-01 with `ALGORITHM_NOT_SUPPORTED_FOR_PROTECTION_LEVEL`. An HSM key version costs more per month than a software one, and HSM operations are billed separately; see [Cloud KMS pricing](https://cloud.google.com/kms/pricing).

The plugin refuses key versions with any other algorithm.

Destroying the key version loses its address for good, along with any funds it holds, once the key's scheduled-destruction duration ends (30 days by default, fixed when the key is created); [Prevent and recover from losing a key](key-loss.md) covers restoring a version, guarding against destruction and retiring a key.

## 2. Allow signing, and nothing else

The identity that runs Hardhat needs two permissions on this key:

- `cloudkms.cryptoKeyVersions.viewPublicKey`, to read the public key and the version's algorithm.
- `cloudkms.cryptoKeyVersions.useToSign`, to sign.

The predefined roles `roles/cloudkms.publicKeyViewer` and `roles/cloudkms.signer` each hold one of them. Grant both on the key, not on the project, so the identity can use no other key:

```sh
for role in roles/cloudkms.publicKeyViewer roles/cloudkms.signer; do
  gcloud kms keys add-iam-policy-binding deployer \
    --keyring deployer-ring \
    --location europe-west1 \
    --member user:you@example.com \
    --role "$role"
done
```

Use `serviceAccount:<email>` as the member for a service account. `roles/cloudkms.signerVerifier` also holds both permissions in one role, plus `useToVerify`, which the plugin does not use. The permissions in each role are listed in [Cloud KMS permissions and roles](https://cloud.google.com/kms/docs/reference/permissions-and-roles).

This setup has not yet been checked against real Cloud KMS with a least-privilege identity; the live test ([Testing](../../contributor/testing.md)) runs with the developer's own identity.

Credentials come from Application Default Credentials: `gcloud auth application-default login` on a workstation, the `GOOGLE_APPLICATION_CREDENTIALS` file, or the service account of the machine or CI job.

## 3. Install the plugin and configure the key

```sh
npm install --save-dev hardhat-kms hardhat-kms-gcp
```

`hardhat-kms-gcp` brings the Google Cloud SDK (`@google-cloud/kms`, and `google-gax` 6.5.0 or later to run it on) with it, so there is nothing else to install. Add it to `plugins`; it loads `hardhat-kms` itself:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsGcp from "hardhat-kms-gcp";

export default defineConfig({
  plugins: [hardhatKmsGcp],
  kms: {
    keys: {
      deployer: {
        provider: "gcp",
        keyVersionName:
          "projects/my-project/locations/europe-west1/keyRings/deployer-ring/cryptoKeys/deployer/cryptoKeyVersions/1",
        // Optional, recommended: the address that `npx hardhat kms accounts` prints for this key.
        // The plugin refuses to sign if the key derives to another address.
        address: "0x…",
      },
    },
  },
  networks: {
    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },
  },
});
```

Instead of `keyVersionName`, a key can list its parts: `projectId`, `location`, `keyRing`, `keyName` and `keyVersion`. The version is always required. The [configuration reference](../reference/configuration.md#key-forms-per-provider) lists every option.

To use a key without a config entry, set `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME` and `GCP_KEY_VERSION` and pass `--kms gcp`; see [Migrate from Foundry](migrate-from-foundry.md). Such a key is added to the network selected with `--network`, or to `default` without one.

## 4. Check that the key signs

Save this script as `scripts/check-kms.ts`. It lists the accounts on `sepolia`, then signs the message `hello` with the last one, which is the KMS account:

```ts
import { network } from "hardhat";

const { provider } = await network.create("sepolia");
const accounts = await provider.request({ method: "eth_accounts" });
const address: unknown = Array.isArray(accounts) ? accounts.at(-1) : undefined;
if (typeof address !== "string") {
  throw new Error("no accounts");
}
const signature = await provider.request({
  method: "personal_sign",
  params: ["0x68656c6c6f", address],
});
console.log(address, signature);
```

Run it with `npx hardhat run scripts/check-kms.ts`. The KMS address comes last in `eth_accounts`, after any accounts of the node. The first run calls `GetPublicKey` unless the key has an `address` pin, then `AsymmetricSign` once.

## How the plugin uses the key

- It calls `GetPublicKey` once, checks that the response names the configured version and that its algorithm is `EC_SIGN_SECP256K1_SHA256`, and reads the PEM public key.
- It signs with `AsymmetricSign` on that version, sending the 32-byte digest as `digest.sha256`, and checks that the response names the same version.
- It checks every request and response with CRC32C. It sends `digestCrc32c` with the digest, requires `verifiedDigestCrc32c` to be true in the response, and checks `signatureCrc32c` against the signature and `pemCrc32c` against the public key. A missing checksum counts as a mismatch, and so does a digest that Cloud KMS refuses because its checksum does not match (INVALID_ARGUMENT).
- After a checksum mismatch, or when Cloud KMS is unavailable or cannot be reached, it repeats the call, at most three more times, then fails. Before repeating an unavailable call it waits 100 ms, then 200 ms, then 400 ms. The SDK's own retries are off, so this is the only retry loop, and it starts no new attempt once the call has timed out.
- It uses the SDK's REST transport, so no gRPC connection keeps `hardhat run` from exiting. Each request's deadline is the key's `timeoutMs`; google-gax enforces it over REST from 6.5.0, the version `hardhat-kms-gcp` requires and hands to the client. The SDK cannot cancel a request already sent, so after a timeout the request in flight runs until that deadline, and nothing more is sent.
- It parses every DER signature, normalizes it to low-S and verifies it against the public key before using it; see the [signing pipeline](../../contributor/signing-pipeline.md).

## Errors

Each message starts with the provider, the operation and the key, for example `gcp, sign, key gcp:projects/…/cryptoKeyVersions/1: permission denied (PERMISSION_DENIED)`. The table lists the part after the colon.

| Error                                                                                | Cause and fix                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Google Cloud KMS keys need the hardhat-kms-gcp plugin`                              | Run `npm install --save-dev hardhat-kms-gcp` in the Hardhat project, and add `hardhatKmsGcp` to `plugins` in the config.                                                                     |
| `hardhat-kms-gcp … needs hardhat-kms …, but hardhat-kms … is installed`              | The two packages are released together and must be the same version. Run the install command the error prints.                                                                               |
| `the key version's algorithm is …, not EC_SIGN_SECP256K1_SHA256 (secp256k1)`         | The key is not a secp256k1 key. A key's algorithm cannot be changed, so create a new key as in step 1.                                                                                       |
| `the key derives to 0x…, but the configured address is 0x…`                          | The configuration names another key or version, or the pin is wrong. Check `keyVersionName`, then update `address`.                                                                          |
| `the response is for another key version than the one requested`                     | Cloud KMS answered for another key version. The plugin does not retry this. Run again; if it repeats, report it.                                                                             |
| `… does not match its checksum (…Crc32c), after 4 attempts`                          | Data was corrupted between this machine and Cloud KMS four times in a row. Check proxies or other software that rewrites HTTPS traffic.                                                      |
| `… did not confirm the digest's checksum (verifiedDigestCrc32c), after 4 attempts`   | The checksum sent with the digest did not reach Cloud KMS. As for the line above.                                                                                                            |
| `… refused the digest's checksum (digestCrc32c, INVALID_ARGUMENT), after 4 attempts` | The digest was corrupted on its way to Cloud KMS. As for the line above.                                                                                                                     |
| `could not reach Google Cloud KMS (ECONNREFUSED), after 4 attempts`                  | The request never reached Cloud KMS. The code says why: `ENOTFOUND` or `EAI_AGAIN` for DNS, `ECONNREFUSED` or `ECONNRESET` for the connection. Check the network, DNS and any `HTTPS_PROXY`. |
| `Google Cloud KMS is unavailable (UNAVAILABLE), after 4 attempts`                    | Cloud KMS answered that it is unavailable. Try again later.                                                                                                                                  |
| `no Google Cloud credentials found`                                                  | Run `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a credentials file.                                                                                  |
| `the Google Cloud credentials were refused (UNAUTHENTICATED)`                        | The credentials expired or were revoked. Run `gcloud auth application-default login` again.                                                                                                  |
| `permission denied (PERMISSION_DENIED)`                                              | The identity lacks `viewPublicKey` or `useToSign` on this key; grant the roles in step 2.                                                                                                    |
| `the key version was not found (NOT_FOUND)`                                          | The project, location, key ring, key or version does not exist. Check `keyVersionName` or its parts.                                                                                         |
| `the key version cannot be used (FAILED_PRECONDITION)`                               | The version is disabled, scheduled for destruction or destroyed. Enable it with `gcloud kms keys versions enable`, or restore it first with `gcloud kms keys versions restore`.              |
| `Google Cloud KMS is throttling requests (RESOURCE_EXHAUSTED)`                       | The project hit its Cloud KMS quota. Try again later, or ask for a higher quota.                                                                                                             |
| `no answer within … ms`                                                              | Cloud KMS did not answer in time. Check the network, or raise `timeoutMs`. `did not answer in time (DEADLINE_EXCEEDED)` means the same, reported by the SDK.                                 |

Other Cloud KMS errors show as `the Google Cloud KMS call failed (<STATUS>)`, with the gRPC status name. The plugin never shows the server's message, since it names the project and the key. Run with `DEBUG=hardhat:kms:*` to see each call; see [Debug output](debug-output.md). Errors of the core plugin, such as configuration, address and signature errors, are listed with their causes and fixes in the [errors reference](../reference/errors.md).
