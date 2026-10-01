# Rotate a key and pin its address

Audience: users who sign with a key in AWS KMS, Google Cloud KMS or Azure Key Vault and want to rotate it, or want a rotation to fail loudly rather than change their address. Assumes a key set up as in one of the setup guides ([AWS](aws-kms-setup.md), [Google Cloud](gcp-kms-setup.md), [Azure](azure-key-vault-setup.md)).

Status: the provider facts below were checked against each provider's documentation on 2026-10-02. The AWS alias case and the Azure version case in [What a pin does](#what-a-pin-does) ran that day on throwaway keys ([#70](https://github.com/aelmanaa/hardhat-kms/issues/70)). Provider behaviour can change; each fact links to the page it comes from.

An Ethereum address is derived from the public key. New key material is a new public key, and so a new address. Rotating a signing key does not move anything: the funds, the nonce history and every contract role stay with the old address, and only the old key can sign for it.

This guide covers:

- [What rotation does on each provider](#what-rotation-does-on-each-provider), and which key ids follow a rotation.
- [What a pin does](#what-a-pin-does) when the key behind an id changes.
- [Move to a new key](#move-to-a-new-key) on purpose.

## What rotation does on each provider

| Provider         | Rotation of a secp256k1 signing key                               | Key ids that follow it                                                      | Without a pin, after a rotation       |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| AWS KMS          | None. You create a new key and can repoint an alias to it.        | An alias name or alias ARN                                                  | The next run signs as the new address |
| Google Cloud KMS | None automatic. You create a new key version.                     | None: the config names a version                                            | Nothing changes until you edit it     |
| Azure Key Vault  | A rotation policy or `az keyvault key rotate` adds a new version. | An id without a version (`/keys/<name>`), or `keyName` without `keyVersion` | The next run signs as the new address |

Within one run, the built-in providers keep signing with the key they first resolved: AWS signs with the key ARN, and Azure with the version it read first. A signer closes 5 seconds after its last connection closes, and the next use, or the next run, resolves the alias or the current version again ([Security model](../explanation/security-model.md#what-the-plugin-protects-against)). Only the `address` pin carries across runs.

### AWS KMS

AWS KMS rotates key material only for symmetric encryption keys. Automatic rotation is "supported only on symmetric encryption KMS keys", and on-demand rotation also only on symmetric encryption keys; asymmetric keys are rotated manually ([How key rotation works](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html#rotate-keys-how-it-works)). For an `ECC_SECG_P256K1` key, both calls fail:

```text
$ aws kms enable-key-rotation --key-id <key-id>
aws: [ERROR]: An error occurred (UnsupportedOperationException) when calling the EnableKeyRotation operation:
$ aws kms rotate-key-on-demand --key-id <key-id>
aws: [ERROR]: An error occurred (UnsupportedOperationException) when calling the RotateKeyOnDemand operation:
```

Manual rotation means a new KMS key. AWS suggests referring to keys by alias and moving the alias to the new key with `UpdateAlias`, so applications do not change ([Rotate keys manually](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys-manually.html)):

```sh
aws kms update-alias --alias-name alias/deployer --target-key-id <new key id>
```

For a signing key, that is the case to guard against. A config that names `alias/deployer` signs as the new key's address on the next run, with nothing in between to tell you. A config that names a key id or key ARN never follows an alias.

### Google Cloud KMS

"Cloud KMS does not support automatic rotation for asymmetric keys". For a signing key, you create a new key version, distribute its public key, then "specify the new key version" in signing calls ([Considerations for asymmetric keys](https://docs.cloud.google.com/kms/docs/key-rotation#asymmetric)).

The plugin always signs with the version in the config, `keyVersionName` or `keyVersion`, and never with the primary version ([Set up a Google Cloud KMS key](gcp-kms-setup.md)). A new version changes nothing until you change the config, and changing it changes the address.

### Azure Key Vault

Key Vault can rotate a key on a schedule. A key rotation policy makes Key Vault "automatically create a new key version at a chosen frequency", and `az keyvault key rotate` creates one on demand. Microsoft's guidance assumes encryption keys: "Target services should use versionless key URI to automatically refresh to the latest version of the key" ([Configure cryptographic key auto-rotation](https://learn.microsoft.com/en-us/azure/key-vault/keys/how-to-configure-key-rotation#key-rotation-policy)). Managing the policy and rotating on demand need the **Key Vault Crypto Officer** role, not the signing role ([Permissions required](https://learn.microsoft.com/en-us/azure/key-vault/keys/how-to-configure-key-rotation#permissions-required)).

For a signing key, the versionless URI is the risk. The plugin accepts a key id without a version, `https://my-vault.vault.azure.net/keys/deployer`, and resolves it to the current version when it first reads the key ([Key forms per provider](../reference/configuration.md#key-forms-per-provider)). After a rotation, the next run signs as the new version's address.

Use a versioned key id, an `address` pin, or both, and do not set a rotation policy on a signing key. To check that a key has no rotation action, run:

```sh
az keyvault key rotation-policy show --vault-name my-vault --name deployer \
  --query "lifetimeActions[?action=='Rotate'] | length(@)" --output tsv
```

It prints `0` when no rotation is scheduled. On 2026-10-02, a key created with `az keyvault key create` had a policy with only a `Notify` action.

## What a pin does

`address` on a key pins its address. Before the first signature in every run, the plugin derives the address from the key's public key and compares it with the pin. If they differ, it refuses to sign and names both addresses ([`kms address`](../reference/tasks.md#kms-address)).

Get the pin from `kms accounts`. It asks the KMS for each key's address, shows the state of each pin in the `PIN` column, and prints a line to paste for each key that has none ([`kms accounts`](../reference/tasks.md#kms-accounts)):

```text
$ npx hardhat kms accounts
NAME      PROVIDER  SOURCE    ADDRESS                                     PIN   KEY ID
deployer  aws       kms.keys  0x94640fE13D4C4e16CbeD96Ec794788893A4d64cD  none  aws:alias/hardhat-kms-rotation-demo

Address pins to add to each key's config:
  kms.keys.deployer: address: "0x94640fE13D4C4e16CbeD96Ec794788893A4d64cD",
```

Add the line to the key's entry:

```ts
import hardhatKmsAws from "hardhat-kms-aws";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: {
        provider: "aws",
        keyId: "alias/deployer",
        address: "0x94640fE13D4C4e16CbeD96Ec794788893A4d64cD",
      },
    },
  },
});
```

`kms accounts` then shows `matches` in the `PIN` column.

### AWS: an alias moved to another key

Run on 2026-10-02 with two throwaway `ECC_SECG_P256K1` keys and an alias pointing at the first. Without a pin, `kms address` follows the alias:

```text
$ npx hardhat kms address deployer
0x94640fE13D4C4e16CbeD96Ec794788893A4d64cD
$ aws kms update-alias --alias-name alias/hardhat-kms-rotation-demo --target-key-id <second key id>
$ npx hardhat kms address deployer
0xddA8d8e1b90f18E39985E8d4Fb67F75C20b3A34C
```

With the pin set to the first address, the same command fails, and so does any signature:

```text
$ npx hardhat kms address deployer
Error in community plugin hardhat-kms: aws, check address, key aws:alias/hardhat-kms-rotation-demo: the key derives to 0xddA8d8e1b90f18E39985E8d4Fb67F75C20b3A34C, but the configured address is 0x94640fE13D4C4e16CbeD96Ec794788893A4d64cD. If the key was rotated or an alias now points to another key, update the configuration.
```

`kms accounts` shows the key as `FAILED`, prints the same error under it, and exits with code 1:

```text
NAME      PROVIDER  SOURCE    ADDRESS  PIN  KEY ID
deployer  aws       kms.keys  FAILED   -    aws:alias/hardhat-kms-rotation-demo
  error: aws, check address, key aws:alias/hardhat-kms-rotation-demo: the key derives to 0xddA8d8e1b90f18E39985E8d4Fb67F75C20b3A34C, but the configured address is 0x94640fE13D4C4e16CbeD96Ec794788893A4d64cD. If the key was rotated or an alias now points to another key, update the configuration.
```

### Azure: a key rotated under an unversioned id

Run on 2026-10-02 with a throwaway `P-256K` key, configured by an id without a version. `<AZURE_KEY_ID>` is how the plugin shows a key id read from a configuration variable. Without a pin, the address changes after the rotation:

```text
$ npx hardhat kms address deployer
0x85cF964F950127F59021A03fac285235B49E324e
$ az keyvault key rotate --vault-name my-vault --name hardhat-kms-rotation-demo
$ npx hardhat kms address deployer
0x59Cb7e031E40fBF39f687c8ed628a512b27B58CC
```

With the pin set to the first address, the command fails with both addresses:

```text
$ npx hardhat kms address deployer
Error in community plugin hardhat-kms: azure, check address, key azure:<AZURE_KEY_ID>: the key derives to 0x59Cb7e031E40fBF39f687c8ed628a512b27B58CC, but the configured address is 0x85cF964F950127F59021A03fac285235B49E324e. If the key was rotated or an alias now points to another key, update the configuration.
```

The id of the first version, with the same pin, still shows `matches` after the rotation: a versioned id never follows a rotation.

### When the pin fails

The error means the key behind the id is not the key that holds your funds and roles. Do not update the pin to the new address to make it pass. First find out why the key changed:

- If someone moved the alias or rotated the key by mistake, point the config back at the old key: the old key id or ARN on AWS, the old version's id on Azure. On AWS, `update-alias` can move the alias back. On Azure, the old version keeps working as long as it is enabled.
- If the change was on purpose, follow [Move to a new key](#move-to-a-new-key) and change the pin as its last config step.

## Move to a new key

A new key starts with an empty address. Move to it in this order:

1. Create the new key as in the setup guide, add it to the config under a new name, and pin it with the address `kms accounts` prints. On Azure, a new version of the same key also works; use its versioned id.
2. Fund the new address on every chain it will use.
3. Transfer contract ownership and every role the old address holds, such as admin, minter or upgrade roles. Send each transfer from the old key, which still signs under its own pinned entry.
4. Move the remaining funds from the old address to the new one.
5. Point the networks' `kmsAccounts` and scripts at the new key, and remove the old entry. Run `kms accounts` again: every key should show `matches`.
6. Disable the old key, or the old version on Azure, and leave it disabled while you confirm nothing still needs it ([Retire a key](key-loss.md#retire-a-key)). Delete it only when its address holds nothing on any chain and no contract gives it a role.

On AWS, give the new key its own alias or use its key id, rather than moving the old alias. A moved alias makes a pinned entry fail and an unpinned one switch addresses at once, while step 3 still needs the old key. Once the old entry is gone, you can move the alias to the new key and set the pin to the new address.
