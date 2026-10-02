# Set up an AWS KMS key

Audience: users who sign with a key in AWS KMS.

Status: the AWS adapter is implemented (M3), in the `hardhat-kms-aws` package. With the network hook (M4), a connection lists the key's account and signs messages and typed data with it. M5 adds signing and sending transactions ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)).

## 1. Create a secp256k1 signing key

Ethereum uses the secp256k1 curve, which AWS KMS calls `ECC_SECG_P256K1`:

```sh
aws kms create-key \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --description "hardhat-kms deployer"

aws kms create-alias --alias-name alias/deployer --target-key-id <KeyId from the output above>
```

The plugin refuses keys with another spec or usage.

Deleting the key loses its address for good, along with any funds it holds, once a waiting period of 7 to 30 days ends; [Prevent and recover from losing a key](key-loss.md) covers cancelling a deletion, guarding against it and retiring a key.

## 2. Allow signing, and nothing else

The identity that runs Hardhat needs two permissions on this key. The conditions limit `kms:Sign` to what the plugin sends, a 32-byte digest signed with ECDSA over SHA-256:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "kms:GetPublicKey",
      "Resource": "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab"
    },
    {
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
      "Condition": {
        "StringEquals": {
          "kms:SigningAlgorithm": "ECDSA_SHA_256",
          "kms:MessageType": "DIGEST"
        }
      }
    }
  ]
}
```

Use the key ARN as the resource: an IAM policy cannot name a KMS key by its alias. This IAM policy takes effect only if the key policy lets IAM policies grant access. The default key policy of a key made with `create-key` does; if you set your own key policy, grant these permissions there instead.

This policy has not yet been checked against real AWS KMS: the first live test ran with an administrator identity. That check is tracked in [#43](https://github.com/aelmanaa/hardhat-kms/issues/43).

Credentials come from the AWS SDK's default chain: environment variables, `~/.aws` profiles and SSO, or the role of the machine or CI job. A key's `profile` option picks a named profile.

## 3. Install the plugin and configure the key

```sh
npm install --save-dev hardhat-kms hardhat-kms-aws
```

`hardhat-kms-aws` brings the AWS SDK (`@aws-sdk/client-kms`) with it, so there is nothing else to install. Add it to `plugins`; it loads `hardhat-kms` itself:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "hardhat-kms-aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: {
        provider: "aws",
        keyId: "alias/deployer",
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

`keyId` accepts a key id, a key ARN, an alias name or an alias ARN; the [configuration reference](../reference/configuration.md) lists every option. The region comes from the ARN if `keyId` is one, then the key's `region`, then `kms.defaults.aws.region`, then the SDK's own chain (`AWS_REGION`, then the profile's region).

To use a key without a config entry, set `AWS_KMS_KEY_ID` and pass `--kms aws`; see [Migrate from Foundry](migrate-from-foundry.md). Such keys are added to the network selected with `--network`, or to `default` without one.

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

Run it with `npx hardhat run scripts/check-kms.ts`. The KMS address comes last in `eth_accounts`, after any accounts of the node. The first run calls `GetPublicKey` unless the key has an `address` pin, then `Sign` once.

## How the plugin uses the key

- It calls `GetPublicKey` once, checks the key spec, usage and algorithm, and takes the key ARN from the response.
- It signs with that ARN, never with the alias you configured. Repointing the alias cannot change which key signs during a run, and an `address` pin catches the change on the next run.
- It sends `Sign` with `MessageType: DIGEST` and `ECDSA_SHA_256`, and checks that the response names the same key and algorithm.
- It parses every signature, normalizes it to low-S and verifies it against the public key before using it; see the [signing pipeline](../../contributor/signing-pipeline.md).
- It adds `hardhat-kms/<version>` to the end of the user agent of every request, so the `userAgent` field of a CloudTrail event ends in `hardhat-kms/1.0.0` (with your installed version). The client reports this tag and anyone can send the same string, so it marks the plugin's calls but proves nothing.

## Errors

Each message starts with the provider, the operation and the key, for example `aws, sign, key aws:alias/deployer: the provider call failed (AccessDeniedException)`. The table lists the part after the colon.

| Error                                                                   | Cause and fix                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS KMS keys need the hardhat-kms-aws plugin`                          | Run `npm install --save-dev hardhat-kms-aws` in the Hardhat project, and add `hardhatKmsAws` to `plugins` in the config.                          |
| `hardhat-kms-aws … needs hardhat-kms …, but hardhat-kms … is installed` | The two packages are released together and must be the same version. Run the install command the error prints.                                    |
| `the key spec is …, not ECC_SECG_P256K1 (secp256k1)`                    | The key is not a secp256k1 key. A key's spec cannot be changed, so create a new key as in step 1.                                                 |
| `the key derives to 0x…, but the configured address is 0x…`             | The alias points at another key, or the pin is wrong. Check the alias, then update `address`.                                                     |
| `the provider call failed (AccessDeniedException)`                      | The identity lacks `kms:GetPublicKey` or `kms:Sign` on this key, the `Sign` conditions do not match, or the key policy does not allow IAM access. |
| `the provider call failed (NotFoundException)`                          | The key id or alias does not exist in this account and region. Check `keyId` and the region.                                                      |
| `the provider call failed (DisabledException)`                          | The key is disabled. Enable it with `aws kms enable-key`.                                                                                         |
| `the provider call failed (KMSInvalidStateException)`                   | The key's state does not allow the call, usually because it is pending deletion. Run `aws kms cancel-key-deletion`, then `aws kms enable-key`.    |
| `no AWS region is configured`                                           | Set `region` on the key or `kms.defaults.aws.region`, set `AWS_REGION`, give the profile a region, or use a key ARN.                              |
| `no answer within … ms`                                                 | KMS did not answer in time. Check the network and region, or raise `timeoutMs`.                                                                   |

Provider errors show only the error's class name, never its message, since SDK messages can carry request details. Run with `DEBUG=hardhat:kms:*` to see each call; see [Debug output](debug-output.md). The table lists the most common errors; the [errors reference](../reference/errors.md#hardhat-kms-aws) lists every one, with its id, cause and fix, and the [core plugin's errors](../reference/errors.md#hardhat-kms) too.
