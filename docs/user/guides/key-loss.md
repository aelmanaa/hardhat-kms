# Prevent and recover from losing a key

Audience: users who sign with a key in AWS KMS, Google Cloud KMS or Azure Key Vault and hold funds or contract roles at its address. Assumes a key set up as in one of the setup guides ([AWS](aws-kms-setup.md), [Google Cloud](gcp-kms-setup.md), [Azure](azure-key-vault-setup.md)).

Status: the provider facts below were checked against each provider's documentation on 2026-10-01, and every undo path in [Undo a deletion](#undo-a-deletion) ran that day on a throwaway key ([#71](https://github.com/aelmanaa/hardhat-kms/issues/71)). Provider behaviour can change; each fact links to the page it comes from.

The private key of a KMS key never leaves the KMS, so neither you nor the plugin holds a copy. If the key is deleted, or nobody can use it any more, the address keeps its balance and its contract roles, but nothing can sign for it again. The plugin cannot recover anything.

This guide covers:

- [Undo a deletion](#undo-a-deletion) while the provider still allows it.
- [Guard against deletion](#guard-against-deletion) before it happens.
- [Avoid lockout](#avoid-lockout), where the key exists but nobody can reach it.
- [Back up a key](#back-up-a-key), and what a backup costs you.
- [Retire a key](#retire-a-key) without losing what its address holds.

## Undo a deletion

Each provider waits before it deletes a key. During that period the key cannot sign, and the deletion can be undone:

| Provider         | Waiting period                                                                                                                 | Signs during it | Undo                                                       | State after the undo |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------- | -------------------- |
| AWS KMS          | 7 to 30 days, 30 by default, chosen when you schedule the deletion                                                             | No              | `aws kms cancel-key-deletion`, then `aws kms enable-key`   | Disabled             |
| Google Cloud KMS | 24 hours to 120 days, 30 by default, fixed when the key is created                                                             | No              | `gcloud kms keys versions restore`, then `versions enable` | Disabled             |
| Azure Key Vault  | 7 to 90 days, 90 by default, fixed when the vault is created (soft delete); a purge deletes the key permanently before it ends | No              | `az keyvault key recover`                                  | As before the delete |

Once the waiting period ends, the key is gone for good. On Azure, the waiting period exists only in a vault with soft delete; see [Azure Key Vault](#azure-key-vault). A recovered key is the same key, with the same address, so its `address` pin still matches.

### AWS KMS

[`ScheduleKeyDeletion`](https://docs.aws.amazon.com/kms/latest/APIReference/API_ScheduleKeyDeletion.html) puts the key in the `PendingDeletion` state for a waiting period of 7 to 30 days, 30 by default. A key pending deletion "cannot be used in any cryptographic operations", and the actual deletion can come up to 24 hours later than scheduled ([About the waiting period](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html#deleting-keys-how-it-works)). When the period ends, AWS KMS deletes the key, its aliases and its metadata, and you cannot cancel any more.

Find the date the key will be deleted:

```sh
aws kms describe-key --key-id alias/deployer --query 'KeyMetadata.[KeyState,DeletionDate]' --output text
```

Cancel the deletion, then enable the key. [`CancelKeyDeletion`](https://docs.aws.amazon.com/kms/latest/APIReference/API_CancelKeyDeletion.html) leaves the key `Disabled`, so it still cannot sign until you enable it:

```sh
aws kms cancel-key-deletion --key-id <key id or ARN>
aws kms enable-key --key-id <key id or ARN>
```

`cancel-key-deletion` takes a key id or ARN, not an alias. While the key is pending deletion, Hardhat shows `the provider call failed (KMSInvalidStateException)`; between the cancel and the enable, it shows `the provider call failed (DisabledException)`.

Checked on 2026-10-01 on a throwaway `ECC_SECG_P256K1` key: signing failed with `KMSInvalidStateException` while the key was pending deletion, the key was `Disabled` after the cancel, signing failed with `DisabledException` until `enable-key`, and worked after it. A 6-day window was refused with `PendingWindowInDays must be between 7 and 30`.

### Google Cloud KMS

Cloud KMS destroys key versions, not keys. `gcloud kms keys versions destroy` puts the version in the `DESTROY_SCHEDULED` state, where "it can't be used for cryptographic operations, and requests to use the key fail" ([Key version states](https://docs.cloud.google.com/kms/docs/key-states#scheduled_for_destruction)). The state lasts for the key's scheduled-destruction duration: at least 24 hours (0 for import-only keys) and at most 120 days ([Variable duration](https://docs.cloud.google.com/kms/docs/key-states#variable_duration_of_the_scheduled_for_destruction_state)), 30 days if not set. The duration is immutable: you set it with `--destroy-scheduled-duration` when you create the key, and it cannot change afterwards ([`destroyScheduledDuration`](https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys)). After it, the version is `DESTROYED`. For a key generated in Cloud KMS, `DESTROYED` is permanent; only imported key material can be imported again ([Destroy and restore key versions](https://docs.cloud.google.com/kms/docs/destroy-restore)).

In the commands below, `<version>` is the version your config uses, its `keyVersion`, or the last part of its `keyVersionName`. See the time the version will be destroyed:

```sh
gcloud kms keys versions describe <version> --key deployer --keyring deployer-ring --location europe-west1 \
  --format='value(state,destroyTime)'
```

Restore the version, then enable it. A restored version is `DISABLED`, and "You must enable the key before it can be used" ([Destroy and restore key versions](https://docs.cloud.google.com/kms/docs/destroy-restore)):

```sh
gcloud kms keys versions restore <version> --key deployer --keyring deployer-ring --location europe-west1
gcloud kms keys versions enable <version> --key deployer --keyring deployer-ring --location europe-west1
```

In both the `DESTROY_SCHEDULED` and the `DISABLED` state, Hardhat shows `the key version cannot be used (FAILED_PRECONDITION)`.

Checked on 2026-10-01 on a throwaway HSM `EC_SIGN_SECP256K1_SHA256` key created with `--destroy-scheduled-duration 24h`: signing failed with `FAILED_PRECONDITION` and `current state is: DESTROY_SCHEDULED`, the restored version was `DISABLED` and still refused to sign, and after `enable` it signed again.

### Azure Key Vault

Soft delete is on by default for new vaults and cannot be turned off. A deleted key stays recoverable for the vault's retention period, 7 to 90 days, 90 by default, and the period can only be set when the vault is created ([Soft-delete behavior](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview#soft-delete-behavior)). While it is deleted, the key "can only be listed, recovered, or forcefully/permanently deleted" ([Key vault object recovery](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview#key-vault-object-recovery)). A purge deletes it permanently, at once, unless the vault has purge protection. In a vault without soft delete, deleting a key deletes it permanently ([Azure Key Vault soft-delete](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview)); `az keyvault show --name my-vault --query properties.enableSoftDelete` prints `true` when the vault has it.

List the deleted keys, then recover the key ([Azure Key Vault recovery overview](https://learn.microsoft.com/en-us/azure/key-vault/general/key-vault-recovery)):

```sh
az keyvault key list-deleted --vault-name my-vault --query '[].[name,scheduledPurgeDate]' --output tsv
az keyvault key recover --vault-name my-vault --name deployer
```

Recovering and purging need more than the signing role: the built-in role Microsoft names for both on keys is **Key Vault Crypto Officer**. While the key is deleted, Hardhat shows `Key Vault answered 404 …: the key or key version does not exist`.

A deleted vault is recovered the same way, with `az keyvault list-deleted --resource-type vault` and `az keyvault recover --name my-vault`. Listing deleted vaults needs `Microsoft.KeyVault/locations/deletedVaults/read` at the subscription level, and recovering one needs the **Key Vault Contributor** role ([Azure Key Vault recovery overview](https://learn.microsoft.com/en-us/azure/key-vault/general/key-vault-recovery)). Its role assignments do not come back; see [Avoid lockout](#azure-key-vault-2). For a Managed HSM, see Microsoft's [Managed HSM recovery overview](https://learn.microsoft.com/en-us/azure/key-vault/managed-hsm/recovery).

Checked on 2026-10-01 on a throwaway `P-256K` key in a new vault with purge protection off: after the delete, the key was listed by `list-deleted`, and reading or signing with it failed with `KeyNotFound`. After `recover` it was enabled and signed. Deleting it again and purging it removed it from `list-deleted`.

## Guard against deletion

On every provider, disable a key you no longer use instead of deleting it. A disabled key cannot sign, and enabling it takes one command. Funds sent to the address later stay recoverable while the key exists; once it is deleted, anything sent there is lost.

Disable the version your config uses. Cloud KMS and Key Vault enable and disable each key version separately, and Key Vault's `set-attributes` changes the latest version when you leave out `--version`; `<version>` is the last part of the versioned key id in your config. After a rotation, the latest version is not the one a versioned key id in your config pins, so that version would keep signing:

| Provider         | Disable                                                                                                     | Docs                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| AWS KMS          | `aws kms disable-key --key-id <key id or ARN>`                                                              | [Enable and disable keys](https://docs.aws.amazon.com/kms/latest/developerguide/enabling-keys.html)                         |
| Google Cloud KMS | `gcloud kms keys versions disable <version> --key deployer --keyring deployer-ring --location europe-west1` | [Enable and disable key versions](https://docs.cloud.google.com/kms/docs/enable-disable)                                    |
| Azure Key Vault  | `az keyvault key set-attributes --vault-name my-vault --name deployer --version <version> --enabled false`  | [`az keyvault key set-attributes`](https://learn.microsoft.com/en-us/cli/azure/keyvault/key#az-keyvault-key-set-attributes) |

The identity that signs never needs to delete. The policies in each setup guide grant it only reading the public key and signing; the guardrails below are for the people and pipelines that administer keys.

### AWS KMS

Keep `kms:ScheduleKeyDeletion` to the key administrators who need it. Identities with `"Action": "*"` or `"Action": "kms:*"` in an IAM policy can already schedule and cancel deletion ([Control access to key deletion](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys-adding-permission.html)). That holds when the key policy lets IAM policies grant access, which the default policy's account-principal statement does; without that statement, IAM policies that allow access to the key have no effect ([Default key policy](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html#key-policy-default-allow-root-enable-iam)).

The condition key [`kms:ScheduleKeyDeletionPendingWindowInDays`](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html#conditions-kms-schedule-key-deletion-pending-window-in-days) limits the waiting period a caller may choose. This key policy statement refuses any window shorter than 30 days, so every deletion gets the longest period to notice it. `put-key-policy` sets the whole policy document, so add the statement to the current policy rather than applying it alone ([Change a key policy](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-modifying.html#key-policy-modifying-how-to-api)):

```json
{
  "Sid": "Require the longest deletion window",
  "Effect": "Deny",
  "Principal": "*",
  "Action": "kms:ScheduleKeyDeletion",
  "Resource": "*",
  "Condition": {
    "NumericLessThan": { "kms:ScheduleKeyDeletionPendingWindowInDays": "30" }
  }
}
```

```sh
aws kms get-key-policy --key-id <key id or ARN> --policy-name default --query Policy --output text > key-policy.json
# Add the statement above to the "Statement" array in key-policy.json, then:
aws kms put-key-policy --key-id <key id or ARN> --policy-name default --policy file://key-policy.json
```

To hear about a deletion while it can still be cancelled, alert on the `ScheduleKeyDeletion` event that AWS CloudTrail records when someone schedules it ([ScheduleKeyDeletion in CloudTrail](https://docs.aws.amazon.com/kms/latest/developerguide/ct-schedule-key-deletion.html)). AWS also documents a [CloudWatch alarm](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys-creating-cloudwatch-alarm.html) that fires when something tries to use a key pending deletion; it does not fire on the scheduling itself, so a key nobody uses during the waiting period never trips it.

### Google Cloud KMS

Choose the scheduled-destruction duration when you create the key, since it cannot change later. The setup guide's command keeps the 30-day default; add `--destroy-scheduled-duration 120d` for the longest period.

Grant `cloudkms.cryptoKeyVersions.destroy` only to the identities that need it. It is in the Cloud KMS Admin role (`roles/cloudkms.admin`), together with `cloudkms.cryptoKeyVersions.restore` ([Destroy and restore key versions](https://docs.cloud.google.com/kms/docs/destroy-restore)). The basic Owner role (`roles/owner`) holds both as well, so check the project's Owners too; `gcloud iam roles describe roles/owner` lists its permissions.

To hear about a destruction while it can still be undone, alert on the `DestroyCryptoKeyVersion` entry in Cloud Audit Logs. It is an Admin Activity audit log, which is always written ([Cloud KMS audit logging](https://docs.cloud.google.com/kms/docs/audit-logging#DestroyCryptoKeyVersion)).

In a project that belongs to an organization, two organization policy constraints add a floor ([Control key destruction](https://docs.cloud.google.com/kms/docs/control-key-destruction)):

- `constraints/cloudkms.minimumDestroyScheduledDuration` sets the shortest scheduled-destruction duration a new key may have: `7d`, `15d`, `30d`, `60d`, `90d` or `120d`.
- `constraints/cloudkms.disableBeforeDestroy` requires a version to be disabled before it can be scheduled for destruction. Google recommends that no user then holds both `cloudkms.cryptoKeyVersions.update` and `cloudkms.cryptoKeyVersions.destroy`, which takes custom roles.

### Azure Key Vault

Turn on purge protection. With it, a deleted vault or key "can't be purged until the retention period passes", and it stays recoverable until then ([Purge protection](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview#purge-protection)):

```sh
az keyvault update --name my-vault --enable-purge-protection true
```

The choice is final: "When purge protection is enabled, it cannot be disabled or overridden by anyone including Microsoft" ([Azure Key Vault recovery overview](https://learn.microsoft.com/en-us/azure/key-vault/general/key-vault-recovery)). The vault's name also stays taken until the retention period ends. For a test vault you will delete soon, leave it off.

Grant the purge permission narrowly. On keys, Key Vault Crypto Officer and Key Vault Administrator include it. On vaults, the subscription owner or the **Key Vault Purge Operator** role can purge ([Permitted purge](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview#permitted-purge)). Microsoft's two pages differ on that role: the soft-delete page also gives it as an example for purging keys, while the [built-in roles table](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide#azure-built-in-roles-for-key-vault-data-plane-operations) describes it as permanent deletion of soft-deleted vaults only. Check what the role allows in your tenant before you rely on either.

To hear about a deletion, turn on Key Vault logging and alert on the `KeyDelete` and `KeyPurge` operations ([Azure Key Vault logging](https://learn.microsoft.com/en-us/azure/key-vault/general/logging)).

## Avoid lockout

A key can also be lost while it still exists, when nobody left has the right to use or manage it.

### AWS KMS

A key policy does not give the account or its administrators any access unless it says so. The default policy's first statement gives the account principal (`arn:aws:iam::<account id>:root`) full access and lets IAM policies grant access to the key. Without it, a key whose policy names one user becomes unmanageable when that user is deleted, and you must contact AWS Support to regain access ([Default key policy](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html#key-policy-default-allow-root-enable-iam)). Keep that statement when you write your own key policy.

Closing the AWS account makes its KMS keys inaccessible ([Delete an AWS KMS key](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html)).

### Google Cloud KMS

Shutting down a project makes it unusable at once. It stays in the `DELETE_REQUESTED` state for 30 days, during which its owners can restore it; after that, the project and all its resources are deleted and cannot be recovered ([Shut down and restore projects](https://docs.cloud.google.com/resource-manager/docs/delete-restore-projects)). Keep the signing keys in a project that only their administrators can shut down, and make sure more than one person can restore it. A lien on the project blocks its deletion until someone with `resourcemanager.projects.updateLiens` removes the lien ([Protect projects with liens](https://docs.cloud.google.com/resource-manager/docs/project-liens)).

### Azure Key Vault

Know who can grant access to the keys, since the same people can remove it:

- In a vault that uses Azure RBAC, that is anyone with `Microsoft.Authorization/roleAssignments/write` on it, such as **Owner**, **User Access Administrator** or **Key Vault Data Access Administrator** ([Azure RBAC for Key Vault](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)).
- In a vault that uses access policies, anyone with `Contributor` on the vault can also give themselves access to the keys through an access policy ([Managing administrative access](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide#managing-administrative-access-to-key-vault)).

Soft-deleting a vault deletes its Azure RBAC role assignments, and recovering the vault does not restore them: "They must be recreated" ([Azure Key Vault soft-delete](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview)). Keep a record of each vault's role assignments, so you can grant them again after a recovery:

```sh
az role assignment list --scope "$(az keyvault show --name my-vault --query id --output tsv)" --include-inherited \
  --query '[].[roleDefinitionName,principalName,scope]' --output tsv
```

## Back up a key

Only Azure Key Vault backs up a key that the provider generated. `az keyvault key backup` writes an encrypted blob that restores only into a vault in the same Azure subscription and geography ([Back up a key](https://learn.microsoft.com/en-us/azure/key-vault/general/backup#design-considerations)):

```sh
az keyvault key backup --vault-name my-vault --name deployer --file deployer.keybackup
az keyvault key restore --vault-name my-other-vault --file deployer.keybackup
```

A backup is also a second copy of the key to protect. A restored copy "is fully independent of the original": disabling, deleting or purging the original has no effect on it, and nothing can revoke a backup blob once it exists ([Security considerations](https://learn.microsoft.com/en-us/azure/key-vault/general/backup#security-considerations)). Anyone who can restore the blob can sign for the address. Store it where you would store a private key, and limit who has the backup and restore permissions.

AWS KMS and Cloud KMS have no backup operation for a key they generated. In AWS KMS, the private key of an asymmetric key "is created in AWS KMS and never leaves AWS KMS unencrypted" ([Asymmetric keys in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/symmetric-asymmetric.html)). For both, the waiting period in [Undo a deletion](#undo-a-deletion) is the protection.

AWS KMS also accepts key material that you generate and import, and you then "remain responsible for the key material" ([Importing key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html)). If such a key is deleted, the original material creates a new KMS key with the same cryptographic properties, under a new key id ([Deleting KMS keys with imported key material](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html#import-delete-key)). The same private key gives the same public key, and so the same Ethereum address; this follows from the key itself, AWS does not state it. Imported key material also expires by default: `import-key-material` uses `KEY_MATERIAL_EXPIRES` unless you pass `--expiration-model KEY_MATERIAL_DOES_NOT_EXPIRE`, and expired material leaves the key in `PendingImport`, unable to sign until you import the same material again ([Setting an expiration time](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-import-key-material.html#importing-keys-expiration)). The trade-off is that a copy of the private key exists outside the HSM, and whoever holds that copy can sign for the address without KMS, its access policies or its logs. This guide does not recommend it.

## Retire a key

Before you disable or delete a key that has signed for real, empty its address and move its roles, in this order:

1. Check that every key the project uses still works. `kms accounts` asks the KMS for each key's address and checks it against the key's pin; a key you cannot reach shows `FAILED`, and the command exits with code 1 ([`kms accounts`](../reference/tasks.md#kms-accounts)):

   ```sh
   npx hardhat --network <name> kms accounts
   ```

2. Move the funds from the old address to the new one, on every chain the address has used.
3. Transfer contract ownership and every role the old address holds, such as admin roles, minter roles or upgrade rights. A role left on the old address cannot be used or given away once the key is gone.
4. Point the config at the new key and update its `address` pin ([Configuration](../reference/configuration.md)). [Rotate a key and pin its address](key-rotation.md#move-to-a-new-key) covers the move in full. Run `kms accounts` again: the new key should show `matches`.
5. Disable the old key, or on Cloud KMS and Key Vault the version your config used, as in [Guard against deletion](#guard-against-deletion), and leave it disabled while you confirm nothing still needs it.
6. Delete the old key only once its address holds nothing on any chain and no contract gives it a role.
