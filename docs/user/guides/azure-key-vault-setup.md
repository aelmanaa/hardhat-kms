# Set up an Azure Key Vault key

Audience: users who sign with a key in Azure Key Vault or Azure Managed HSM, and who have the `az` CLI.

Status: the Azure adapter is implemented, in the `hardhat-kms-azure` package ([#30](https://github.com/aelmanaa/hardhat-kms/issues/30)). A connection lists the key's account and signs transactions, messages and typed data with it. The unit and integration tests run against a fake Key Vault; the first run against a real vault is pending.

## 1. Create a secp256k1 signing key

Ethereum signs with secp256k1, the curve Key Vault calls `P-256K`, so the key must be an elliptic-curve key on it. Allow it to sign:

```sh
az keyvault key create \
  --vault-name my-vault \
  --name deployer \
  --kty EC \
  --curve P-256K \
  --ops sign verify
```

`--kty EC` keeps the private key in software in a Standard vault. `--kty EC-HSM` keeps it in an HSM and needs a Premium vault. In a Managed HSM, pass `--hsm-name my-hsm` instead of `--vault-name`; its keys are always `EC-HSM`. The plugin accepts both, and refuses any other key type or curve.

Print the key's versioned id, which the config uses:

```sh
az keyvault key show --vault-name my-vault --name deployer --query key.kid --output tsv
# https://my-vault.vault.azure.net/keys/deployer/0123456789abcdef0123456789abcdef
```

Deleting the key loses its address for good, along with any funds it holds, once the vault's soft-delete retention period ends or the key is purged; [Prevent and recover from losing a key](key-loss.md) covers recovering a key, purge protection and retiring a key.

## 2. Allow get and sign, and nothing else

The identity that runs Hardhat needs two permissions on the key: `get`, to read the public key, and `sign`. How you grant them depends on the vault's permission model.

### Vaults that use Azure RBAC

New vaults use Azure role-based access control. The built-in role with the fewest permissions that still covers both is **Key Vault Crypto User** (`12338af0-0e69-4776-bea7-57ae8d297424`). Assign it on the key alone, not on the vault, so the identity can use no other key:

```sh
az role assignment create \
  --role "Key Vault Crypto User" \
  --assignee <user, group, service principal or managed identity id> \
  --scope "$(az keyvault show --name my-vault --query id --output tsv)/keys/deployer"
```

Key Vault Crypto User also allows encrypt, decrypt, wrap, unwrap, verify, backup and attribute updates ([Azure built-in roles](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/security#key-vault-crypto-user)). For a role with only what the plugin uses, create a custom role with the two data actions and assign it the same way:

```json
{
  "Name": "Key Vault Ethereum Signer",
  "Description": "Read a key's public part and sign digests with it.",
  "Actions": [],
  "DataActions": [
    "Microsoft.KeyVault/vaults/keys/read",
    "Microsoft.KeyVault/vaults/keys/sign/action"
  ],
  "AssignableScopes": ["/subscriptions/<subscription id>"]
}
```

```sh
az role definition create --role-definition @key-vault-ethereum-signer.json
```

Creating the key in step 1 needs a broader role, such as Key Vault Crypto Officer, which the identity that only signs should not have.

### Vaults that use access policies

Older vaults grant access with access policies, which apply to every key in the vault. Grant only the two key permissions:

```sh
az keyvault set-policy --name my-vault --object-id <principal object id> --key-permissions get sign
```

`az keyvault show --name my-vault --query properties.enableRbacAuthorization` prints `true` for an RBAC vault and `false` (or nothing) for an access-policy vault.

### Managed HSM

A Managed HSM has its own local RBAC. Its smallest built-in role that can read and sign is **Managed HSM Crypto User**, which also allows creating and deleting keys ([Managed HSM built-in roles](https://learn.microsoft.com/azure/key-vault/managed-hsm/built-in-roles)). Assign it on the key:

```sh
az keyvault role assignment create \
  --hsm-name my-hsm \
  --role "Managed HSM Crypto User" \
  --assignee <principal id> \
  --scope /keys/deployer
```

## 3. Sign in

hardhat-kms tries these credential sources in order and uses the first that returns a token:

1. A service principal from the environment: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` (or `AZURE_CLIENT_CERTIFICATE_PATH`).
2. Workload identity, when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE` are set, as on AKS or in GitHub Actions with OIDC federation.
3. The Azure CLI (`az login`), then the Azure Developer CLI (`azd auth login`).
4. A managed identity, user-assigned when `AZURE_CLIENT_ID` is set. It gets 10 seconds for a token and 3 seconds for each request. In Azure Cloud Shell and Service Fabric, where a user-assigned identity cannot be chosen, it is left out when `AZURE_CLIENT_ID` is set.

This is the order of Foundry's Azure Key Vault signer. The developer tools come before the managed identity, so a local `az login` works without waiting for the managed identity endpoint, which outside Azure may never answer. A source that is not configured is skipped; a source that is configured but fails, such as a service principal with a wrong secret, stops the search with its error.

On a laptop, `az login` is enough. In CI, use workload identity rather than a client secret.

## 4. Install the plugin and configure the key

```sh
npm install --save-dev hardhat-kms hardhat-kms-azure
```

`hardhat-kms-azure` brings the Azure SDK (`@azure/keyvault-keys` and `@azure/identity`) with it, so there is nothing else to install. Add it to `plugins`; it loads `hardhat-kms` itself:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "hardhat-kms-azure";

export default defineConfig({
  plugins: [hardhatKmsAzure],
  kms: {
    keys: {
      deployer: {
        provider: "azure",
        keyId: "https://my-vault.vault.azure.net/keys/deployer/0123456789abcdef0123456789abcdef",
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

`keyId` can also leave out the version, or the key can be given as `vaultUrl`, `keyName` and an optional `keyVersion`; the [configuration reference](../reference/configuration.md#key-forms-per-provider) lists the forms and the accepted hosts. Prefer the versioned id: without a version, the plugin uses the version that is current when it first reads the key, so rotating the key changes the address on the next run.

To use a key without a config entry, set `AZURE_KEY_VAULT_KEY_ID` (or `AZURE_KEY_VAULT_KEY_IDS` for several) and pass `--kms azure`; see [Migrate from Foundry](migrate-from-foundry.md).

## 5. Check that the key signs

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

Run it with `npx hardhat run scripts/check-kms.ts`. Each run reads the key once, then signs once. An `address` pin does not save the read for Azure keys: the plugin reads the key to pin its version.

## How the plugin uses the key

- It reads the key once and checks that it is an `EC` or `EC-HSM` key on `P-256K`, that it is enabled and within its activation and expiry dates, and that its permitted operations include `sign`.
- It pins the version from that read. An unversioned key id is resolved to the current version once, and every signature in the run uses that version.
- It signs the 32-byte digest with `ES256K` against the versioned key id. Key Vault signs the digest as given and returns 64 bytes, `r || s`.
- It checks that the `kid` of each sign response names the pinned version, and refuses the signature otherwise.
- It normalizes each signature to low-S, recovers the parity and verifies it against the public key before using it; see the [signing pipeline](../../contributor/signing-pipeline.md).

## Errors

Each message starts with the provider, the operation and the key, for example `azure, sign, key azure:https://my-vault.vault.azure.net/keys/deployer: Key Vault answered 403 Forbidden: …`. The table lists the part after the colon.

| Error                                                                     | Cause and fix                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Azure Key Vault keys need the hardhat-kms-azure plugin`                  | Run `npm install --save-dev hardhat-kms-azure` in the Hardhat project, and add `hardhatKmsAzure` to `plugins` in the config.                                                                                                                                                                       |
| `hardhat-kms-azure … needs hardhat-kms …, but hardhat-kms … is installed` | The two packages are released together and must be the same version. Run the install command the error prints.                                                                                                                                                                                     |
| `no Azure credential returned a token (AggregateAuthenticationError)`     | No credential source in [step 3](#3-sign-in) is configured. Run `az login`, or set the variables of a service principal or workload identity.                                                                                                                                                      |
| `a configured Azure credential could not sign in (AuthenticationError)`   | A source in [step 3](#3-sign-in) is configured but its sign-in failed, for example a wrong or expired `AZURE_CLIENT_SECRET`, or a wrong `AZURE_TENANT_ID`. Fix its settings, or unset the variables of a source you do not mean to use; the chain does not fall through to `az login` after this.  |
| `Key Vault answered 401 …: the credential was not accepted`               | The token is for another tenant, or has expired. Run `az login` again, or check `AZURE_TENANT_ID`.                                                                                                                                                                                                 |
| `Key Vault answered 403 …: the identity may not use this key`             | The identity lacks `get` or `sign` on the key ([step 2](#2-allow-get-and-sign-and-nothing-else)), the role assignment has not taken effect yet (it can take a few minutes), the key is disabled, or the vault firewall blocks the network.                                                         |
| `Key Vault answered 404 …: the key or key version does not exist`         | The vault has no key with this name or version. Check `keyId`; a deleted key must be recovered first.                                                                                                                                                                                              |
| `Key Vault could not be reached`                                          | The request did not get an answer: check the vault URL, DNS, the network and any proxy.                                                                                                                                                                                                            |
| `the key type is …, not EC or EC-HSM` or `the key curve is …, not P-256K` | The key is not a secp256k1 key. A key's type and curve cannot be changed, so create a new key as in step 1.                                                                                                                                                                                        |
| `the key version is disabled`                                             | Enable it with `az keyvault key set-attributes --vault-name my-vault --name deployer --version <version> --enabled true`.                                                                                                                                                                          |
| `the key version is not valid before …` or `the key version expired at …` | The key's activation or expiry date excludes now. The plugin checks the dates when it reads the key and again before each signature, so a key that expires during a run fails here too. Change it with `az keyvault key set-attributes` and `--not-before` or `--expires`, or use another version. |
| `the key's permitted operations do not include sign`                      | The key was created without `sign` in `--ops`. Add it with `az keyvault key set-attributes --ops sign verify`.                                                                                                                                                                                     |
| `the response is for another key version`                                 | Key Vault returned a version other than the one configured. Check that `keyId` names the version you mean.                                                                                                                                                                                         |
| `the signature is from another key version than the pinned one`           | The sign response's `kid` names another version. The plugin refuses such a signature; report it if it happens against Key Vault itself.                                                                                                                                                            |
| `the key derives to 0x…, but the configured address is 0x…`               | The key id names another key or version than the one the pin was taken from. Check the key id, then update `address`.                                                                                                                                                                              |
| `no answer within … ms`                                                   | Key Vault did not answer in time. Check the network, or raise `timeoutMs`.                                                                                                                                                                                                                         |

Errors show the HTTP status and Key Vault's error code, never the service's message, which names the vault, the key and the caller. Run with `DEBUG=hardhat:kms:*` to see each call; see [Debug output](debug-output.md).
