# Set up an AWS KMS key

Audience: users who sign with a key in AWS KMS.

Status: the AWS adapter is implemented (M3). Signing from scripts and tasks needs the network hook (M4), so these steps prepare a key that the plugin checks and can sign with once M4 lands.

## 1. Create a secp256k1 signing key

Ethereum uses the secp256k1 curve, which AWS KMS calls `ECC_SECG_P256K1`:

```sh
aws kms create-key \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --description "hardhat-kms deployer"

aws kms create-alias --alias-name alias/deployer --target-key-id <KeyId from the output above>
```

The plugin refuses keys with another spec or usage. Keep deletion protection in mind: a KMS key cannot be recovered after its deletion waiting period, and funds held by its address are lost with it.

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

Use the key ARN as the resource, not the alias. Credentials come from the AWS SDK's default chain: environment variables, `~/.aws` profiles and SSO, or the role of the machine or CI job.

## 3. Install the SDK and configure the key

```sh
npm install @aws-sdk/client-kms@"^3.0.0"
```

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKms from "hardhat-kms";

export default defineConfig({
  plugins: [hardhatKms],
  kms: {
    keys: {
      deployer: {
        provider: "aws",
        keyId: "alias/deployer",
        // Optional, recommended: the plugin refuses to sign if the key derives to another address.
        address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      },
    },
  },
  networks: {
    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },
  },
});
```

`keyId` accepts a key id, a key ARN, an alias name or an alias ARN; the [configuration reference](../reference/configuration.md) lists every option. The region comes from a key ARN if you give one, then the key's `region`, then `kms.defaults.aws.region`, then the SDK's own chain (`AWS_REGION`, the profile). Without a config entry, `--kms aws` reads `AWS_KMS_KEY_ID` instead; see [Migrate from Foundry](migrate-from-foundry.md).

## How the plugin uses the key

- It calls `GetPublicKey` once, checks the key spec, usage and algorithm, and takes the key ARN from the response.
- It signs with that ARN, never with the alias you configured. An alias that is later pointed at another key cannot change which key signs, and an `address` pin catches it on the next run.
- It sends `Sign` with `MessageType: DIGEST` and `ECDSA_SHA_256`, and checks that the response is for the same key and algorithm.
- Every signature is then parsed, normalized to low-S and verified against the public key before it is used; see the [signing pipeline](../../contributor/signing-pipeline.md).

## Errors

| Error                                                       | Cause and fix                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@aws-sdk/client-kms is not installed in this project`      | Run the install command it prints, in the Hardhat project.                                       |
| `the key spec is …, not ECC_SECG_P256K1 (secp256k1)`        | The key is not a secp256k1 key. Create one as in step 1; a key's spec cannot be changed.         |
| `the key usage is …, not SIGN_VERIFY`                       | The key is for encryption. Create a signing key as in step 1.                                    |
| `the key derives to 0x…, but the configured address is 0x…` | The alias points at another key, or the pin is wrong. Check the alias, then update `address`.    |
| `the provider call failed (AccessDeniedException)`          | The identity lacks `kms:GetPublicKey` or `kms:Sign` on this key, or the conditions do not match. |
| `the provider call failed (NotFoundException)`              | The key id or alias does not exist in this account and region. Check `keyId` and the region.     |
| `no answer within … ms`                                     | KMS did not answer in time. Check the network and region, or raise `timeoutMs`.                  |

Provider errors show only the error's class name, never its message, since SDK messages can carry request details. Run with `DEBUG=hardhat:kms:*` to see each call; see [Debug output](debug-output.md).
