# Rotate a key and pin its address

Audience: users who sign with a key in AWS KMS, Google Cloud KMS or Azure Key Vault and want to rotate it, or want a rotation to fail loudly rather than change their address. Assumes a key set up as in one of the setup guides ([AWS](aws-kms-setup.md), [Google Cloud](gcp-kms-setup.md), [Azure](azure-key-vault-setup.md)).

The provider facts below were checked against each provider's documentation on 2026-10-02. The AWS alias case and the Azure version case in [What a pin does](#what-a-pin-does) ran that day on throwaway keys. Provider behaviour can change; each fact links to the page it comes from.

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

While a signer is open, the built-in providers keep signing with the key they first resolved: AWS signs with the key ARN, and Azure with the version it read first. A signer closes 5 seconds after its last connection closes, and the next use, or the next run, resolves the alias or the current version again ([Security model](../explanation/security-model.md#what-the-plugin-protects-against)). Only the `address` pin carries across runs.

### AWS KMS

AWS KMS rotates key material only for symmetric encryption keys. Automatic rotation is "supported only on symmetric encryption KMS keys", and on-demand rotation also only on symmetric encryption keys; asymmetric keys are rotated manually ([How key rotation works](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html#rotate-keys-how-it-works)). For an `ECC_SECG_P256K1` key, both calls fail:

```text
$ aws kms enable-key-rotation --key-id <key-id>
aws: [ERROR]: An error occurred (UnsupportedOperationException) when calling the EnableKeyRotation operation: …
$ aws kms rotate-key-on-demand --key-id <key-id>
aws: [ERROR]: An error occurred (UnsupportedOperationException) when calling the RotateKeyOnDemand operation: …
```

Manual rotation means a new KMS key. AWS suggests referring to keys by alias and moving the alias to the new key with `UpdateAlias`, so applications do not change ([Rotate keys manually](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys-manually.html)):

```sh
aws kms update-alias --alias-name alias/deployer --target-key-id <new key id>
```

For a signing key, that is the case to guard against. A config that names `alias/deployer` signs as the new key's address on the next run, with nothing in between to tell you. A config that names a key id or key ARN never follows an alias.

### Google Cloud KMS

"Cloud KMS does not support automatic rotation for asymmetric keys". For a signing key, you create a new key version, distribute its public key, then "specify the new key version" in signing calls ([Considerations for asymmetric keys](https://docs.cloud.google.com/kms/docs/key-rotation#asymmetric)).

The plugin always signs with the version in the config, `keyVersionName` or `keyVersion`, and it never picks a version for you ([Set up a Google Cloud KMS key](gcp-kms-setup.md)). An asymmetric key has no primary version: Cloud KMS gives `primary` only to `ENCRYPT_DECRYPT` keys ([`CryptoKey.primary`](https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys#CryptoKey.FIELDS.primary)). A new version changes nothing until you change the config, and changing it changes the address.

### Azure Key Vault

Key Vault can rotate a key on a schedule. A key rotation policy makes Key Vault "automatically create a new key version at a chosen frequency", and `az keyvault key rotate` creates one on demand. Microsoft's guidance assumes encryption keys: "Target services should use versionless key URI to automatically refresh to the latest version of the key" ([Configure cryptographic key auto-rotation](https://learn.microsoft.com/en-us/azure/key-vault/keys/how-to-configure-key-rotation#key-rotation-policy)). Managing the policy and rotating on demand need the **Key Vault Crypto Officer** role, not the signing role ([Permissions required](https://learn.microsoft.com/en-us/azure/key-vault/keys/how-to-configure-key-rotation#permissions-required)).

For a signing key, the versionless URI is the risk. The plugin accepts a key id without a version, `https://my-vault.vault.azure.net/keys/deployer`, and resolves it to the current version when it first reads the key ([Key forms per provider](../reference/configuration.md#key-forms-per-provider)). After a rotation, the next run signs as the new version's address.

Use a versioned key id, an `address` pin, or both, and do not give a signing key a rotation policy with a `Rotate` action. To check, run this as an identity that can read the rotation policy: the **Key Vault Crypto Officer** role, or the `Get Rotation Policy` key permission in a vault that uses access policies ([Permissions required](https://learn.microsoft.com/en-us/azure/key-vault/keys/how-to-configure-key-rotation#permissions-required)):

```sh
az keyvault key rotation-policy show --vault-name my-vault --name deployer \
  --query "lifetimeActions[?action=='Rotate'] | length(@)" --output tsv
```

It prints `0` when no rotation is scheduled. On 2026-10-02, a key created with `az keyvault key create` had a policy with only a `Notify` action. If your organization assigns the Azure Policy that requires keys to have a rotation policy, it reports signing keys as non-compliant; exempt them rather than adding a rotation ([Configure key rotation policy governance](https://learn.microsoft.com/en-us/azure/key-vault/keys/how-to-configure-key-rotation#configure-key-rotation-policy-governance)).

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
import hardhatKmsAws from "@hardhat-kms/aws";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: {
        provider: "aws",
        keyId: "alias/hardhat-kms-rotation-demo",
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
Error in community plugin hardhat-kms: aws, check address, key aws:alias/hardhat-kms-rotation-demo: the key derives to 0xddA8d8e1b90f18E39985E8d4Fb67F75C20b3A34C, but the configured address is 0x94640fE13D4C4e16CbeD96Ec794788893A4d64cD, so nothing was signed. The key id may now name the wrong key or a substituted one, or the pin may be wrong. Do not change the pin to match until you know why the key changed; see "When the pin fails" in the key rotation guide, which also covers a deliberate move to a new key.
```

`kms accounts` shows the key as `FAILED`, prints the same error under it, and exits with code 1:

```text
NAME      PROVIDER  SOURCE    ADDRESS  PIN  KEY ID
deployer  aws       kms.keys  FAILED   -    aws:alias/hardhat-kms-rotation-demo
  error: aws, check address, key aws:alias/hardhat-kms-rotation-demo: the key derives to 0xddA8d8e1b90f18E39985E8d4Fb67F75C20b3A34C, but the configured address is 0x94640fE13D4C4e16CbeD96Ec794788893A4d64cD, so nothing was signed. The key id may now name the wrong key or a substituted one, or the pin may be wrong. Do not change the pin to match until you know why the key changed; see "When the pin fails" in the key rotation guide, which also covers a deliberate move to a new key.
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
Error in community plugin hardhat-kms: azure, check address, key azure:<AZURE_KEY_ID>: the key derives to 0x59Cb7e031E40fBF39f687c8ed628a512b27B58CC, but the configured address is 0x85cF964F950127F59021A03fac285235B49E324e, so nothing was signed. The key id may now name the wrong key or a substituted one, or the pin may be wrong. Do not change the pin to match until you know why the key changed; see "When the pin fails" in the key rotation guide, which also covers a deliberate move to a new key.
```

The id of the first version, with the same pin, still shows `matches` after the rotation: a versioned id never follows a rotation.

### When the pin fails

The error means the key behind the id is not the key that holds your funds and roles. Do not update the pin to the new address to make it pass. First find out why the key changed:

- If someone moved the alias or rotated the key by mistake, point the config back at the old key: the old key id or ARN on AWS, the old version's id on Azure. On AWS, `update-alias` can move the alias back. On Azure, the old version keeps working as long as it is enabled.
- If the change was on purpose, point the old entry back at the old key, then follow [Move to a new key](#move-to-a-new-key), which gives the new key its own entry and pin.

## Move to a new key

A new key starts with an empty address, and the old key must keep signing until everything has moved. Move in this order:

1. **Take an inventory** of what the old address holds or controls, on every chain it has used:
   - funds and tokens, including tokens still due to it, such as vesting or airdrops;
   - contract ownership, roles and proxy admin rights, and which ones transfer in two steps;
   - multisig seats, timelock proposer and executor sets, allowlists, and oracle, relayer or bridge configs that name it;
   - token allowances it granted;
   - ENS names and reverse records;
   - an EIP-7702 delegation on the account;
   - pending transactions and unfinished Hardhat Ignition deployments.
2. **Freeze the old entry.** Make sure the old key's entry names exactly one key, with its pin. On AWS, use the key id or key ARN instead of an alias, or leave the alias alone. On Azure, change an unversioned id to the current versioned id before you create a new version: an unversioned entry follows the new version, which fails with a pin and signs as the new address without one.
3. **Create the new key** as in the setup guide, add it under a new name, and pin it with the address `kms accounts` prints. On AWS, give it a new alias or use its key id. On Google Cloud, this guide prefers a new key: IAM roles granted on a key cover all its versions, so a new version can be used by everyone who could sign with the old one. A new version of the old key, made with `gcloud kms keys versions create --key deployer --keyring deployer-ring --location europe-west1`, also works: put its `keyVersionName` in the new entry, and disable or destroy the old version on its own later. On Azure, use a new key name. Role assignments on `/keys/<name>` and a backup of the key cover every version, so whoever could sign with or back up the old version can do the same with a new one; after a suspected compromise, Microsoft advises "a new key (not a new version of the compromised key)" ([Security considerations](https://learn.microsoft.com/azure/key-vault/general/backup#security-considerations)). A new version of the old key, under its versioned id, also works, but then the old version can only be disabled: deleting a key deletes all its versions, the new one included ([`az keyvault key delete`](https://learn.microsoft.com/cli/azure/keyvault/key#az-keyvault-key-delete)). Run `kms accounts`: both keys should show `matches`.
4. **Finish what is in flight** from the old key: let pending transactions confirm and complete Ignition deployments.
5. **Fund the new address** on every chain it will use.
6. **Transfer control**, signing each transfer with the old key:
   - Two-step transfers, such as [`Ownable2Step`](https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable2Step) and [`AccessControlDefaultAdminRules`](https://docs.openzeppelin.com/contracts/5.x/api/access#AccessControlDefaultAdminRules) with its delay, proxy admins and timelocks, finish only when the new key accepts. Keep the old key enabled until every transfer is accepted.
   - Multisig seats, timelock roles, allowlists and service configs change through their own admins.
   - Roles that cannot move, such as an address hard-coded or set as immutable in a contract, stay with the old address. Keep the old key for them.
   - Update ENS records to the new address.
7. **Clean up the old address** while its key can still sign:
   - Revoke the token allowances it granted.
   - Clear an EIP-7702 delegation: sign an authorization to the zero address with `kms sign-auth --self-broadcast`, and send it in a transaction from the old key to itself ([`kms sign-auth`](../reference/tasks.md#send-the-authorization)).
   - Move the remaining funds and tokens to the new address, and sweep tokens that arrive later.
8. **Switch the config**: point the networks' `kmsAccounts` and scripts at the new key. A contract deployed with `CREATE` gets an address from the sender and its nonce, so future deployments from the new key land at other addresses than they would have from the old one.
9. **Retire the old key** as in [Retire a key](key-loss.md#retire-a-key): disable it, or the old version on Azure, and delete it only when its address holds nothing and no contract gives it a role. On Azure, never delete the key while any of its versions holds funds or roles: if the new key is a new version of the old one, deleting the key deletes the new version too ([`az keyvault key delete`](https://learn.microsoft.com/cli/azure/keyvault/key#az-keyvault-key-delete)).

Once nothing uses the old entry, you can point an AWS alias at the new key, and set that entry's pin to the new address.
