---
title: Set up a Turnkey wallet account
description: "Turnkey setup for Ethereum signing: a test organization, a non-root API user, a least-privilege policy, an API key in a variable, quotas and approvals."
---

# Set up a Turnkey wallet account

This guide creates an Ethereum wallet account in a Turnkey organization, a non-root API user that may sign with that one account and may not change its own credentials, and the API key that user signs with. It then adds the account to a Hardhat project and checks that it signs.

You need a Turnkey dashboard account and the [Turnkey CLI](https://docs.turnkey.com/sdks/cli) (`turnkey`).

With `@hardhat-kms/turnkey`, a connection lists the account and signs transactions, messages and typed data with it, through Turnkey's API. The plugin has no runtime dependencies: it signs each request to Turnkey with the API key itself.

> [!NOTE]
> Audience: users who keep a deployer or operator key in Turnkey, including users who sign with it from Foundry's `cast --turnkey`.
>
> The policies in [step 4](#4-allow-signing-with-one-account-and-deny-credential-changes) follow Turnkey's policy documentation, read on 2026-10-18. The plugin's tests replace Turnkey with a local stub, and no test has run these policies against Turnkey yet. Until one does, [step 7](#7-check-that-the-key-signs) is how you check them.

## 1. Create a test organization

"Many of our customers prefer to maintain separate Development and Production organizations", says Turnkey's [Production checklist](https://docs.turnkey.com/get-started/production-checklist). Start with a test organization: sign up at [app.turnkey.com](https://app.turnkey.com/dashboard/v2/auth/initial), confirm your email and add an authenticator. The organization's id is in the user menu at the top right of the dashboard ([Turnkey CLI](https://docs.turnkey.com/sdks/cli#find-your-organization-id)). It is a UUID:

```sh
export ORGANIZATION_ID="<organization id>"
```

The user that creates the organization is its root quorum, alone, with a threshold of 1 ([Root quorum](https://docs.turnkey.com/features/users/root-quorum#defaults)). That user sets up everything below. It must not be the user that signs; [step 3](#3-create-a-non-root-api-user) says why.

To run the setup commands with the Turnkey CLI, give the root user an API key: `turnkey generate api-key --organization "$ORGANIZATION_ID" --key-name admin`, then add the printed public key to your user under "My Profile", "New API key" ([Turnkey CLI](https://docs.turnkey.com/sdks/cli#add-an-api-key)). Keep this key on your own machine. It is a root key: it bypasses every policy. Later steps need a root key again, to create policies, rotate the API user's key and reject a pending activity, so either keep it offline between uses, or delete it after the setup and add a new one when you need it. The dashboard can do the same steps.

## 2. Create a wallet with one Ethereum account

```sh
turnkey wallets create --name hardhat --key-name admin
turnkey wallets accounts create --wallet hardhat --address-format ADDRESS_FORMAT_ETHEREUM --key-name admin
turnkey wallets accounts list --wallet hardhat --key-name admin
```

The last command lists the account's address, such as `0x08cb1216C95149DF66978b574E484869512CE2bF` ([Turnkey CLI](https://docs.turnkey.com/sdks/cli#create-an-ethereum-account)). The policy in step 4 and the config in step 6 both use it. Copy it as Turnkey prints it. Turnkey's docs do not say whether the policy's address comparison ignores case, so do not change its case in the policy.

The account's private key is held by Turnkey, and Turnkey can export a wallet or wallet account (`EXPORT_WALLET`, `EXPORT_WALLET_ACCOUNT`). A root user can export it, and so can any user a policy allows to ([Activity types by resource and action](https://docs.turnkey.com/features/policies/language#activity-types-by-resource-and-action), [Policies overview](https://docs.turnkey.com/features/policies/overview#policy-evaluation)). The policies in step 4 allow no export. Deleting the wallet loses the address for good, with any funds and roles it holds.

## 3. Create a non-root API user

A key that signs from Hardhat, on a laptop or in CI, should belong to a user outside the root quorum, with a policy that allows only what the plugin sends.

### A root user's key bypasses every policy

"The root quorum is a group of users who can execute any action and bypass the policy engine", and "it is impossible to limit root quorum actions with any policies" ([Root quorum](https://docs.turnkey.com/features/users/root-quorum#technical-overview)). With the default quorum of one user and a threshold of 1, that user's API key can do anything in the organization: sign with any account, export wallets, change policies, add users. "A non-root user's key can only perform actions a policy explicitly allows" ([Credentials](https://docs.turnkey.com/features/users/credentials#lost-or-compromised-api-keys)). The plugin cannot tell whether a key belongs to a root user: it signs with any key Turnkey accepts. Never put a root user's API key in a Hardhat project or a CI secret.

### Generate the API key and create the user

Generate a P-256 API key pair for the new user on the machine that will use it. Turnkey stores only the public key ([Credentials](https://docs.turnkey.com/features/users/credentials#api-keys-and-wallet-keys)):

```sh
turnkey generate api-key --organization "$ORGANIZATION_ID" --key-name hardhat-deployer
```

It prints the `publicKey`, 66 hex characters, and the path of the private key file. In the dashboard, open the Team page, click "New User", then "Service User", and enter a name and an API key name. Under "Advanced Settings", paste the public key. A service user is an API-only user, for which "an email is not required" ([Policy quickstart](https://docs.turnkey.com/features/policies/quickstart#create-your-new-users)). The new user is not in the root quorum. Note its user id, a UUID: the policy names it.

The private key file holds the key's 64 hex characters, followed by a colon and the curve name, such as `:p256` (`tkhq/go-sdk` `crypto/store.go` at `0a956dd`). The plugin takes the 64 hex characters alone ([step 5](#5-store-the-api-private-key)).

## 4. Allow signing with one account, and deny credential changes

Non-root users are denied what no policy allows ("implicit deny"), and a policy with `EFFECT_DENY` wins over every policy that allows ([Policies overview](https://docs.turnkey.com/features/policies/overview#policy-evaluation)). The same page lists exceptions to implicit deny. Two matter here:

- "All users have implicit permission to change their own credentials, unless a policy explicitly allows or denies those actions." Without a policy, whoever holds the API user's key can add another API key to that user, one that never expires, and keep signing after you rotate and delete the key you know. The Credentials page says that "a non-root user's key can only perform actions a policy explicitly allows" ([Credentials](https://docs.turnkey.com/features/users/credentials#lost-or-compromised-api-keys)); this guide follows the overview's narrower statement and denies credential changes explicitly.
- "All users have implicit permission to approve an activity if they were included in consensus." The API user is in the consensus of the policies below only for its own requests.

The first two policies below allow the API user to sign with one wallet account, in the forms the plugin uses. The third denies it every credential change.

### What the plugin sends

Each signature is one activity, with the account's checksummed address as `signWith`. Transactions are `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` activities, with the unsigned transaction as `unsignedTransaction` and `TRANSACTION_TYPE_ETHEREUM` ([Sign transaction](https://docs.turnkey.com/api-reference/activities/sign-transaction)): Turnkey parses it, and policies can read its fields as `eth.tx.*` ([Ethereum support](https://docs.turnkey.com/features/networks/ethereum), [Policy language](https://docs.turnkey.com/features/policies/language)). Everything else is an `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2` activity, whose `encoding` and `hash_function` policies can read ([Activity parameters](https://docs.turnkey.com/features/policies/language#activity-parameters)):

| Request                                                                                                                 | Activity (`activity.kind`) | `encoding`                     | `hash_function`           | What Turnkey receives                |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------ | ------------------------- | ------------------------------------ |
| Transactions of types 0, 1, 2 and 4: `eth_sendTransaction`, `eth_signTransaction`, viem and ethers sends, `kms sign-tx` | `SIGN_TRANSACTION`         | none                           | none                      | the unsigned transaction             |
| The same transactions, for a key with `transactionSigning: "digest"`                                                    | `SIGN_RAW_PAYLOAD`         | `PAYLOAD_ENCODING_HEXADECIMAL` | `HASH_FUNCTION_NO_OP`     | the 32-byte digest                   |
| EIP-7702 authorizations, `kms sign-auth`, `kms sign --no-hash`                                                          | `SIGN_RAW_PAYLOAD`         | `PAYLOAD_ENCODING_HEXADECIMAL` | `HASH_FUNCTION_NO_OP`     | the 32-byte digest                   |
| Messages: `personal_sign`, `eth_sign`, `kms sign`, `kms accounts --check-sign`                                          | `SIGN_RAW_PAYLOAD`         | `PAYLOAD_ENCODING_HEXADECIMAL` | `HASH_FUNCTION_KECCAK256` | the EIP-191 message, with its prefix |
| Typed data: `eth_signTypedData_v4`, `kms sign --data`, a library account's `signTypedData`                              | `SIGN_RAW_PAYLOAD`         | `PAYLOAD_ENCODING_EIP712`      | `HASH_FUNCTION_NO_OP`     | the typed data as JSON               |

Turnkey answers a transaction with the whole signed transaction. The plugin decodes it, refuses it unless its type and every field equal the transaction it sent (`turnkey.sign.transaction-mismatch`), and keeps only the signature. It then checks the signature against its own transaction and sends that transaction, never Turnkey's bytes.

If your policies allow only `SIGN_RAW_PAYLOAD`, as a policy written for Foundry may, add the second policy below: without it, Turnkey refuses every transaction with a 403. Or sign transactions as a digest, as below.

### Transactions as a digest, as Foundry signs them

`cast --turnkey` always signs a transaction as its 32-byte hash, through `sign_raw_payload` with `HASH_FUNCTION_NO_OP`. When one key and its policy serve both Foundry and Hardhat, and you do not want to allow `SIGN_TRANSACTION`, set `transactionSigning: "digest"` on the key:

```ts
import hardhatKmsTurnkey from "@hardhat-kms/turnkey";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsTurnkey],
  kms: {
    keys: {
      deployer: {
        provider: "turnkey",
        organizationId: configVariable("TURNKEY_ORGANIZATION_ID"),
        address: "0x08cb1216C95149DF66978b574E484869512CE2bF",
        apiPrivateKey: configVariable("TURNKEY_API_PRIVATE_KEY"),
        // Sign transactions as a NO_OP digest, as Foundry does.
        transactionSigning: "digest",
      },
    },
  },
});
```

The key's transactions then go through `sign_raw_payload` with `PAYLOAD_ENCODING_HEXADECIMAL` and `HASH_FUNCTION_NO_OP`, like an EIP-7702 authorization, and match the first policy's `NO_OP` clause. Turnkey sees only the hash, so `eth.tx.*` policies do not apply to them. Turnkey cannot tell such a transaction from an EIP-7702 authorization or a `kms sign --no-hash` digest, since all three are `HEXADECIMAL` with `NO_OP`: a policy cannot allow one and deny the others, and a `NO_OP` grant lets the key sign any 32-byte digest, an authorization included. The default, `"transaction"`, is what lets a policy limit the recipient, the chain or the value; keep it unless the policy is shared with Foundry. Messages and typed data are sent the same way in both modes. See [`transactionSigning`](../reference/configuration.md).

### The policies

Create all three in the dashboard, as a root user: open "Policies", click "Add new policy", and enter each one ([Policy quickstart](https://docs.turnkey.com/features/policies/quickstart#create-policies-for-your-new-users)). Replace `<API_USER_ID>` with the user id from step 3 and `<WALLET_ACCOUNT_ADDRESS>` with the address from step 2, wherever they appear.

The first policy allows the raw-payload signatures, in the three forms of the table and no other:

```json
{
  "policyName": "hardhat-kms: sign raw payloads with one wallet account",
  "notes": "Messages: HEXADECIMAL with KECCAK256. Typed data: EIP712 with NO_OP. Digests: HEXADECIMAL with NO_OP.",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(user, user.id == '<API_USER_ID>')",
  "condition": "activity.kind == 'SIGN_RAW_PAYLOAD' && wallet_account.address == '<WALLET_ACCOUNT_ADDRESS>' && ((activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL' && activity.params.hash_function == 'HASH_FUNCTION_KECCAK256') || (activity.params.encoding == 'PAYLOAD_ENCODING_EIP712' && activity.params.hash_function == 'HASH_FUNCTION_NO_OP') || (activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL' && activity.params.hash_function == 'HASH_FUNCTION_NO_OP'))"
}
```

The second allows Turnkey's transaction-signing activity with the same account:

```json
{
  "policyName": "hardhat-kms: sign transactions with one wallet account",
  "notes": "Transactions, which the plugin signs through sign_transaction.",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(user, user.id == '<API_USER_ID>')",
  "condition": "activity.kind == 'SIGN_TRANSACTION' && wallet_account.address == '<WALLET_ACCOUNT_ADDRESS>'"
}
```

To limit what the key may send, add `eth.tx.*` clauses to this policy's condition. Turnkey's `eth.tx` has, among others, `to` (a string), `chain_id` and `value` (integers) ([Policy language](https://docs.turnkey.com/features/policies/language)). For example, to allow transactions only to one contract on Sepolia, with no value, the condition becomes:

```text
activity.kind == 'SIGN_TRANSACTION' && wallet_account.address == '<WALLET_ACCOUNT_ADDRESS>' && eth.tx.chain_id == 11155111 && eth.tx.to == '<CONTRACT_ADDRESS>' && eth.tx.value == 0
```

Such a policy also denies deployments, whose transaction has no `to`. No test has run an `eth.tx` condition against Turnkey yet; check yours with a transaction it should allow and one it should deny.

The third denies the API user any change to credentials: creating or deleting API keys, authenticators and OAuth providers, its own included:

```json
{
  "policyName": "hardhat-kms: the API user may not change credentials",
  "notes": "Rotate this user's API keys with a root user's key.",
  "effect": "EFFECT_DENY",
  "consensus": "approvers.any(user, user.id == '<API_USER_ID>')",
  "condition": "activity.resource == 'CREDENTIAL'"
}
```

Where each part comes from in Turnkey's documentation:

- The fields: `policyName`, `notes` (required, and may be empty), `effect`, `consensus` and `condition` ([Policies overview](https://docs.turnkey.com/features/policies/overview#policy-structure)).
- `approvers.any(user, user.id == '<USER_ID>')` limits a policy to one user, as in Turnkey's [signing examples](https://docs.turnkey.com/features/policies/examples/signing-control). The API user's own request counts as its approval, so it needs no second approver ([Activities](https://docs.turnkey.com/api-reference/activities/overview)).
- `wallet_account.address == '<WALLET_ACCOUNT_ADDRESS>'` limits a policy to one account: "Allow a specific user to sign transactions with a specific wallet account address" in the [signing examples](https://docs.turnkey.com/features/policies/examples/signing-control).
- `activity.kind == 'SIGN_RAW_PAYLOAD'` matches `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD` and `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2`, and `activity.kind == 'SIGN_TRANSACTION'` matches `ACTIVITY_TYPE_SIGN_TRANSACTION` and `ACTIVITY_TYPE_SIGN_TRANSACTION_V2`. Turnkey recommends `activity.kind` over `activity.type`, because a policy on one type stops matching when Turnkey adds a new version of the activity ([Activity kinds](https://docs.turnkey.com/features/policies/language#activity-kinds), [Choosing between type, kind, and resource + action](https://docs.turnkey.com/features/policies/language#choosing-between-type-kind-and-resource--action)). `SIGN_RAW_PAYLOADS`, the batch activity, is a separate kind, so neither policy allows it. "Allow a specific user to sign transactions across all versions" in the [access control examples](https://docs.turnkey.com/features/policies/examples) uses `activity.kind == 'SIGN_TRANSACTION'`.
- `activity.params.encoding` and `activity.params.hash_function` are the raw-payload parameters Turnkey exposes to policies, for both versions of the activity ([Activity parameters](https://docs.turnkey.com/features/policies/language#activity-parameters)). Turnkey's own "Deny NO_OP hash signing" example combines them with the activity in one condition ([Examples](https://docs.turnkey.com/features/policies/language#examples)).
- `activity.resource == 'CREDENTIAL'` matches every activity Turnkey files under the `CREDENTIAL` resource: `ACTIVITY_TYPE_CREATE_API_KEYS_V2`, `ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2`, `ACTIVITY_TYPE_DELETE_API_KEYS`, `ACTIVITY_TYPE_DELETE_AUTHENTICATORS`, `ACTIVITY_TYPE_CREATE_OAUTH_PROVIDERS_V2` and `ACTIVITY_TYPE_DELETE_OAUTH_PROVIDERS` ([Activity resources and actions](https://docs.turnkey.com/features/policies/language#activity-resources-and-actions), [Activity types by resource and action](https://docs.turnkey.com/features/policies/language#activity-types-by-resource-and-action)). An `EFFECT_DENY` policy with a `consensus` on users is the form of "Deny all delete actions for users with a specific tag" in the [access control examples](https://docs.turnkey.com/features/policies/examples). The deny applies when the API user approves the activity, which it does by submitting it; a root user's request is not denied, since the root quorum bypasses policies.
- `&&`, `||` and string comparison with `==` are in the [operator table](https://docs.turnkey.com/features/policies/language), strings take single quotes only ([Primitive types](https://docs.turnkey.com/features/policies/language#primitive)), and Turnkey's examples group clauses in parentheses ([Access control examples](https://docs.turnkey.com/features/policies/examples)).

The two activities are in separate policies because Turnkey's policy engine "does not short circuit": a clause that fails to evaluate makes the whole policy's outcome an error, and Turnkey advises splitting such policies ([Policy evaluation](https://docs.turnkey.com/features/policies/language#policy-evaluation)). A transaction-signing activity has no `encoding` or `hash_function` parameter, and reading a parameter an activity does not expose "produces a `MissingField` evaluation error" ([Activity parameters](https://docs.turnkey.com/features/policies/language#activity-parameters)), so one policy for both activities would fail to evaluate for one of them.

An organization on the Free, Pay-as-you-go or Pro plan has 5 policies ([Resource limits](https://docs.turnkey.com/reference/resource-limits)). These use three of them. Like the two allow policies, the deny policy has not been run against Turnkey yet.

### Policies written for Foundry

`cast --turnkey` sends every request, messages and typed data included, as a 32-byte digest with `HASH_FUNCTION_NO_OP`. A policy written for Foundry may therefore allow only `NO_OP`, for example with `activity.params.hash_function == 'HASH_FUNCTION_NO_OP'`. Under hardhat-kms, such a policy:

- denies transactions, which are sent as `SIGN_TRANSACTION`, unless another policy allows that activity or the key sets `transactionSigning: "digest"`;
- allows EIP-7702 authorizations and raw digests, which are sent the same way;
- denies messages, which are sent with `HASH_FUNCTION_KECCAK256`;
- allows typed data, which is sent with `HASH_FUNCTION_NO_OP`, unless the policy also requires `PAYLOAD_ENCODING_HEXADECIMAL`. Then it denies typed data too, which is sent with `PAYLOAD_ENCODING_EIP712`.

A denied request fails with `turnkey.service.forbidden`, and the message names what the request sent. For a message:

```text
turnkey, sign message, key turnkey:<TURNKEY_ORGANIZATION_ID>/0x…: Turnkey answered 403 REQUEST_NOT_AUTHORIZED: no policy lets the API key's user sign this request with this address (a message, sent with HASH_FUNCTION_KECCAK256 and PAYLOAD_ENCODING_HEXADECIMAL: a policy that allows only HASH_FUNCTION_NO_OP denies it). Add a policy that allows it, as the Turnkey setup guide shows
```

For typed data, the parenthesis reads `(typed data, sent with PAYLOAD_ENCODING_EIP712 and HASH_FUNCTION_NO_OP: a policy that allows only PAYLOAD_ENCODING_HEXADECIMAL denies it)`. For a transaction, it reads `(a transaction, sent as ACTIVITY_TYPE_SIGN_TRANSACTION_V2: a policy that allows only SIGN_RAW_PAYLOAD denies it; to sign the transaction's hash instead, as Foundry does, set the key's transactionSigning to "digest")`: add the second policy, or set [`transactionSigning: "digest"`](#transactions-as-a-digest-as-foundry-signs-them). For a digest, which is how EIP-7702 authorizations, `kms sign --no-hash` and the transactions of a key with `transactionSigning: "digest"` are sent, it reads `(a digest, sent with HASH_FUNCTION_NO_OP and PAYLOAD_ENCODING_HEXADECIMAL: a policy that allows only SIGN_TRANSACTION, or only HASH_FUNCTION_KECCAK256, denies it)`. To sign all of them from hardhat-kms, add the `KECCAK256` clause and the `EIP712` clause of the first policy above to your policy's condition, and add the second policy. Foundry keeps working: its requests still match the `NO_OP` clause.

The reverse holds too. Turnkey's language page shows a policy that denies `HASH_FUNCTION_NO_OP` except with `PAYLOAD_ENCODING_EIP712` ([Examples](https://docs.turnkey.com/features/policies/language#examples)). It blocks every request from Foundry, and under hardhat-kms it blocks EIP-7702 authorizations and raw digests, while transactions, messages and typed data still sign, unless the key sets `transactionSigning: "digest"`, whose transactions are `NO_OP` digests too.

## 5. Store the API private key

The key's `apiPrivateKey` takes only `configVariable(NAME)`, with no `default` and no `format`. A literal string, a `default` or a `format` would put the key in the config file, which is committed, so the config fails validation with `core.config.secret-variable`:

```text
Config error in config.kms.keys.deployer.apiPrivateKey: Expected `configVariable(NAME)` without a `default` or a `format`. A secret cannot be written in the config
```

Hardhat reads the variable from the environment, or from `hardhat-keystore` when the config loads the keystore plugin. The value is the 64 hex characters of the private key, without the `:p256` suffix of the CLI's file.

On a laptop, keep it in the keystore, which encrypts it with a password. Add `import hardhatKeystore from "@nomicfoundation/hardhat-keystore";` to the config and `hardhatKeystore` to `plugins`, or load a Hardhat toolbox, which includes it. Then:

```sh
npx hardhat keystore set TURNKEY_API_PRIVATE_KEY
```

In CI, store it as a secret and expose it to the job as `TURNKEY_API_PRIVATE_KEY`. In GitHub Actions:

```yaml
env:
  TURNKEY_API_PRIVATE_KEY: ${{ secrets.TURNKEY_API_PRIVATE_KEY }}
  TURNKEY_ORGANIZATION_ID: ${{ vars.TURNKEY_ORGANIZATION_ID }}
```

The plugin signs only with an API key held in a variable, so the CI job holds that key. Turnkey's expiring keys come from interactive logins ("issued automatically when a user authenticates via email, SMS, OAuth, or wallet auth", [Credentials](https://docs.turnkey.com/features/users/credentials#types)), which the plugin does not support. Give the key an expiry and rotate it, as below.

The plugin reads the variable on the first signature, never when the config loads. It never prints, logs or puts the key in an error, even with `--show-ids`, and errors show the organization id as `<TURNKEY_ORGANIZATION_ID>` when it comes from a variable ([configuration reference](../reference/configuration.md#key-forms-per-provider)).

### Give the key an expiry, and rotate it

Turnkey's API takes an expiry for each API key, `expirationSeconds` on `create_api_keys` ([Create API keys](https://docs.turnkey.com/api-reference/activities/create-api-keys)); Turnkey's docs do not say whether the dashboard's form sets one. Rotation follows Turnkey's steps: create a new key for the user, update the integration and check it, then delete the old key ([Rotate API keys](https://docs.turnkey.com/features/users/credentials#rotate-api-keys)). The deny policy of step 4 stops the API user from adding or deleting its own keys, so run these steps with a root user's key, here `admin`, or as a user that a policy allows to manage this user's keys. To give the user a key that expires in 90 days, generate a new key pair as in step 3, then add its public key:

```sh
turnkey request --path /public/v1/submit/create_api_keys --body '{
  "type": "ACTIVITY_TYPE_CREATE_API_KEYS_V2",
  "timestampMs": "'"$(date +%s)"'000",
  "organizationId": "'"$ORGANIZATION_ID"'",
  "parameters": {
    "userId": "<API_USER_ID>",
    "apiKeys": [
      {
        "apiKeyName": "hardhat-deployer-2027-01",
        "publicKey": "<new public key>",
        "curveType": "API_KEY_CURVE_P256",
        "expirationSeconds": "7776000"
      }
    ]
  }
}' --key-name admin
```

Set `TURNKEY_API_PRIVATE_KEY` to the new private key, check it with [step 7](#7-check-that-the-key-signs), then delete the old key with `delete_api_keys` (`ACTIVITY_TYPE_DELETE_API_KEYS`, with the `userId` and the old key's id in `apiKeyIds`; [Delete API keys](https://docs.turnkey.com/api-reference/activities/delete-api-keys)). A user holds at most 10 long-lived and 10 expiring API keys. Creating an expiring key past the limit makes Turnkey delete one of the user's keys, an expired one first, else the oldest ([Resource limits](https://docs.turnkey.com/reference/resource-limits)). Turnkey's docs do not say whether a key created with `expirationSeconds` counts as "expiring" for that rule. An expired key fails with `turnkey.service.unauthenticated`.

If you suspect the API key leaked, list the user's API keys with `get_api_keys`, which takes `organizationId` and `userId` ([Get API keys](https://docs.turnkey.com/api-reference/queries/get-api-keys)), and delete every key you did not create, as well as the leaked one, with `delete_api_keys`. Run both with a root user's key:

```sh
turnkey request --path /public/v1/query/get_api_keys --body '{
  "organizationId": "'"$ORGANIZATION_ID"'",
  "userId": "<API_USER_ID>"
}' --key-name admin
```

## 6. Install the plugin and configure the key

::: code-group

```sh [npm]
npm install --save-dev hardhat-kms @hardhat-kms/turnkey
```

```sh [pnpm]
pnpm add --save-dev hardhat-kms @hardhat-kms/turnkey
```

```sh [Yarn]
yarn add --dev hardhat-kms @hardhat-kms/turnkey
```

:::

pnpm 11 and later need an `allowBuilds` entry, and Yarn 4 needs `nodeLinker: node-modules`: [Install hardhat-kms](install-before-release.md) gives the settings for each package manager.

Add `@hardhat-kms/turnkey` to `plugins`; it loads `hardhat-kms` itself. The variable names are Foundry's, so a project that signs with `cast --turnkey` keeps its environment:

```ts
import hardhatKmsTurnkey from "@hardhat-kms/turnkey";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsTurnkey],
  kms: {
    keys: {
      deployer: {
        provider: "turnkey",
        organizationId: configVariable("TURNKEY_ORGANIZATION_ID"),
        // The wallet account's address, from step 2. Written here, not read from a variable.
        address: "0x08cb1216C95149DF66978b574E484869512CE2bF",
        apiPrivateKey: configVariable("TURNKEY_API_PRIVATE_KEY"),
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

The fields:

- `organizationId`: the organization or sub-organization that holds the account, a UUID, literal or a configuration variable. Copy it from the dashboard. A literal that is not a UUID fails when the config loads, with `core.config.turnkey-organization-id`; a variable whose value is not a UUID fails when the key is first used, with `core.config.invalid-value` and the reason `expected a Turnkey organization id, a UUID`.
- `address`: required. The plugin signs with it as `signWith`, and it is the key's pin: the plugin checks every signature against it. A key without it fails with `core.config.turnkey-address-required`. Foundry reads `TURNKEY_ADDRESS` from the environment; here the address is written in the config, so changing the environment cannot change which account signs.
- `apiPrivateKey`: the API private key, as `configVariable(NAME)` only ([step 5](#5-store-the-api-private-key)).
- `apiPublicKey`: optional, literal or a configuration variable. The plugin derives the public key from the private key, as Foundry does. When you set it, the plugin checks that the two match before it sends any request, and fails with `turnkey.credential.public-key-mismatch` if they do not.
- `transactionSigning`: optional, `"transaction"` (the default) or `"digest"`. It decides whether a transaction reaches Turnkey as a `sign_transaction` activity or as a `NO_OP` digest ([Transactions as a digest](#transactions-as-a-digest-as-foundry-signs-them)).
- `timeoutMs`: optional, as for every key. It bounds the whole signature, including the wait for an activity Turnkey has not finished.

Any other field is an error at the key's path, such as `Config error in config.kms.keys.deployer: Unrecognized key(s) in object: 'baseUrl'`, as for the other providers. There is no `baseUrl`: the plugin always calls `https://api.turnkey.com`. The [configuration reference](../reference/configuration.md#key-forms-per-provider) lists the fields.

`--kms` does not read Turnkey keys: `--kms turnkey` fails with `core.kms-option.unknown-provider`. A Turnkey key needs a config entry such as the one above.

`configVariable("SEPOLIA_RPC_URL")` reads the RPC URL when a network needs it, from the environment or from the keystore, as `TURNKEY_API_PRIVATE_KEY` does.

## 7. Check that the key signs

Each successful signature counts toward the organization's monthly quota, 25 on the Free plan ([Rate limits and quota](#rate-limits-and-the-monthly-signature-quota)). Check with one.

`npx hardhat kms accounts` lists the key without calling Turnkey, and shows `not checked` in its `PIN` column: the plugin cannot read a Turnkey account's public key, so the address it shows is the pin. `npx hardhat kms address deployer` prints the pin and a note on standard error that it is not checked yet. Neither spends a signature. `npx hardhat kms public-key deployer` fails, since the provider returns no public key ([`kms address`](../reference/tasks.md#kms-address)).

For the same reason, `connection.kms.getAccount` fails with `core.signer.address-only` for a Turnkey key until that key has signed once in the run: the library account needs the public key, and the plugin learns it from the first signature. Sign once first, for example with `personal_sign` or a transaction, then call `getAccount`. To sign an EIP-7702 authorization without a library account, use [`kms sign-auth`](../reference/tasks.md#kms-sign-auth) ([Library accounts](../reference/library-accounts.md)).

To check the key, the policy and the pin together, sign once:

```sh
npx hardhat kms accounts --check-sign
```

The key signs a random EIP-191 message, sent with `HASH_FUNCTION_KECCAK256`, so this one signature checks the first policy's message clause. Success shows `matches` in the `PIN` column and `ok` in the `SIGN` column: Turnkey accepted the API key, a policy allowed the request, and the signature recovers to the pinned address. It spends one signature of the quota for each Turnkey row it lists: keys that name the same organization and address are listed, and checked, once when they also use the same API keys and the same `transactionSigning`. Keys with another API key or mode get rows of their own, and each is checked ([`kms accounts`](../reference/tasks.md#kms-accounts)).

To check the typed-data and digest clauses as well, sign one of each, for example `npx hardhat kms sign --data --from-file --network sepolia deployer permit.json` and `npx hardhat kms sign --no-hash deployer <digest>` ([`kms sign`](../reference/tasks.md#kms-sign)). To check the second policy, sign a transaction without sending it, for example `npx hardhat --network sepolia kms sign-tx deployer tx.json` ([`kms sign-tx`](../reference/tasks.md#kms-sign-tx)). That is three more signatures.

## How the plugin uses the key

- It reads the API private key on the first signature, derives the API public key, and signs each request's exact body with it (Turnkey's `X-Stamp`). It sends nothing to Turnkey before that first signature.
- It sends `sign_transaction` for a transaction (unless the key sets `transactionSigning: "digest"`) and `sign_raw_payload` for everything else to `https://api.turnkey.com`, with `signWith` set to the checksummed `address`, and a new `timestampMs` for each signature.
- For a transaction, it decodes the signed transaction Turnkey returns, refuses it unless its type and every field equal the transaction it sent, and keeps only the signature.
- It checks that the answer's activity names the organization, the activity type and, for a poll, the activity id it asked about, and refuses the answer otherwise.
- When Turnkey answers that the activity is still running, it asks again with `get_activity` after 500 ms, then waits twice as long each time up to 2 s, until the activity ends or `timeoutMs` runs out. It prints `waiting for Turnkey to finish the activity` once, after the first poll. A poll is a query, not a new signature.
- When there is no answer, a server error or a rate limit (`RATE_LIMIT_EXCEEDED`, or a 429 without a code), it sends the same body again, up to 4 attempts in all, waiting 250 ms, then twice as long each time, with jitter. Turnkey answers the same body with the same activity ([Activities](https://docs.turnkey.com/api-reference/activities/overview)), so a retry makes no second signature. It does not retry a used-up quota, or a 400, 401, 403 or 404.
- It does not follow redirects: the stamp covers the body, which must reach Turnkey and nothing else.
- It normalizes each signature to low-S, recovers the parity and checks the signature against the `address` pin before using it; see the [security model](../explanation/security-model.md#every-signature-is-verified). The first signature is what confirms that the API key signs with the configured account.

## When Turnkey does not answer in time

`timeoutMs` bounds each signature, including the polls of an activity Turnkey has not finished. When it runs out, or a library account's `signal` aborts, the plugin stops waiting. Turnkey does not: an activity it accepted can still complete, and a completed `sign_transaction` activity holds the signed transaction, which every user of the organization can read and broadcast ([What Turnkey records](#what-turnkey-records)). The same holds when the plugin gives up on a transaction for another reason after the request reached Turnkey: the activity needs approval, a status query fails, an answer cannot be read, or Turnkey's signed transaction is not the one the plugin sent.

For a transaction the plugin therefore keeps its nonce held instead of signing it again, and says so:

```text
turnkey, sign transaction, key turnkey:<TURNKEY_ORGANIZATION_ID>/0x…: no answer within 30000 ms. The request reached the provider, and Turnkey may still sign this transaction (activity 00000000-0000-0000-0000-000000000000); anyone who can read it there can then broadcast it with nonce 7. Reject the activity in the Turnkey dashboard while it is pending; then, or if it completed, send a replacement transaction with nonce 7, before any other transaction from this account. Until a transaction with nonce 7 reaches the node through this network connection, or the connection closes, the connection's sends from this account skip nonce 7, so they wait behind a gap that the replacement fills
```

The message starts with the cause: `no answer within … ms`, `cancelled by the caller's abort signal`, or the Turnkey error, such as `Turnkey holds activity … until it gets more approvals`. It shows the activity id only when it is a UUID. If the request timed out before Turnkey answered at all, the message says the id is not known: look for the account's newest `sign_transaction` activity instead.

What the plugin does until you settle it:

- The script's later sends from the account through the same network connection skip the nonce. Each takes a later nonce, which leaves a gap: a live network keeps those transactions queued until a transaction with the held nonce is mined, and Hardhat's simulated network refuses them with "nonce too high".
- The hold ends when a transaction with that nonce reaches the node through the connection, for example the replacement below, or when the connection closes. It does not end when you reject the activity, which the plugin cannot see.
- Another network connection, and the next run of the script, do not see the hold and can sign the nonce again. Settle the activity first.

To settle it, open the activity in the Turnkey dashboard, or read it with `get_activity` ([Reject the pending activity](#reject-the-pending-activity)):

1. If it is still pending and `canReject` is true, reject it. Nothing was signed, and the nonce is free again for the next run. In the same run, the connection still skips the nonce, so fill it with step 2.
2. If it completed, its signed transaction exists. Either broadcast that transaction, or send a replacement with the same nonce from the plugin, which makes Turnkey's transaction invalid once it is mined. Set the nonce explicitly, for example with viem: `wallet.sendTransaction({ to, value: 0n, nonce: 7 })`.

A transaction that Turnkey signed holds its nonce in the same way until it reaches the node: Turnkey keeps a copy. When the node refuses it for certain, for example for insufficient funds, the copy becomes valid once the cause goes away, so the send fails with `core.tx.refused-provider-copy`, which names the nonce, the kind of refusal (`insufficient funds`, `fee too low` or `refused`) and the node's code, and the nonce stays held. Fix the cause, then send a replacement with that nonce, or broadcast Turnkey's signed transaction. A refusal at a nonce the node has already mined past is passed on as the node gave it, since that nonce is used on chain, and an answer that the node already knows the transaction counts as sent. An `eth_signTransaction` holds its nonce until its raw transaction, or another with that nonce, is sent through the connection.

A held nonce that nothing fills stalls the account. If you sign with `eth_signTransaction` and never broadcast through the connection, or leave a failed send unsettled, each later send takes a nonce past the held ones, and the node keeps it queued: `wait()` for its receipt never ends, and Hardhat's simulated network refuses it with "nonce too high". The plugin warns when a send is about to go past held nonces: `the send from 0x… takes nonce 2, above nonce 0, 1, which this connection holds …`. Signatures alone do not warn. Broadcast the signed transactions through the same connection, or send replacements at the held nonces with an explicit `nonce`. If you know the held transactions will never be sent, for example because you rejected their activities, open a new network connection: holds do not carry over. `kms sign-tx` holds nothing: it ends after it prints the transaction, and its error names the nonce.

A transaction that failed before its request left, for example on a missing configuration variable, holds no nonce. Neither does one that Turnkey refused for certain: a 4xx answer to the request, such as a 403 from a policy, unless an earlier attempt of the same request lost its answer or got a server error, and an activity that ended `FAILED` or `REJECTED`. A key with [`transactionSigning: "digest"`](#transactions-as-a-digest-as-foundry-signs-them) holds none either: its activity holds only a hash, which nobody can broadcast.

## Rate limits and the monthly signature quota

- **Quota.** Turnkey includes 25 signatures a month; more needs a payment method and a plan ([Production checklist](https://docs.turnkey.com/get-started/production-checklist)). An organization over its quota gets a 429 with `SIGNING_QUOTA_EXCEEDED` ([API errors](https://docs.turnkey.com/api-reference/overview/errors)), which the plugin reports as `turnkey.service.quota` and does not retry. A deploy script that sends ten transactions spends ten signatures, and `kms accounts --check-sign` one per Turnkey key. Turnkey's docs do not say whether a denied or failed sign activity counts.
- **Fresh attempts.** If a signature fails the plugin's checks, the plugin asks once more, which is a new activity and a second signature ([How many sign requests one call can send](../explanation/security-model.md#how-many-sign-requests-one-call-can-send)).
- **Rate limits.** The Free and Pay-as-you-go plans allow 1 request a second, Pro 3 and Enterprise 60, with a 10 a second limit for each sub-organization. The limits are per-minute buckets that refill continuously, they are shared by every API key of the organization, and status polling counts too. Turnkey sends no `Retry-After` header ([Rate limits](https://docs.turnkey.com/reference/rate-limits)). The plugin's retries absorb short bursts; a script that signs many requests in parallel can still fail with `turnkey.service.throttled`. Sign in sequence on the Free plan.

## When a policy needs approval

A policy can make an activity wait for more approvals: its `consensus`, such as `approvers.count() >= 2`, then puts the activity in `ACTIVITY_STATUS_CONSENSUS_NEEDED`. Turnkey's MFA policies can put it in `ACTIVITY_STATUS_AUTHENTICATORS_NEEDED` ([Activities](https://docs.turnkey.com/api-reference/activities/overview)). An approval takes a person minutes or hours, while a script that sends a transaction waits for the signature, with a nonce the plugin has already filled. The plugin therefore does not wait. It fails at once with `turnkey.activity.approval-needed`, and the message names the activity:

```text
turnkey, sign digest, key turnkey:<TURNKEY_ORGANIZATION_ID>/0x…: Turnkey holds activity 00000000-0000-0000-0000-000000000000 until it gets more approvals (ACTIVITY_STATUS_CONSENSUS_NEEDED). The plugin does not wait for approvals, and the activity stays pending in Turnkey. Reject it in the Turnkey dashboard, so that nobody approves it later
```

The activity stays in Turnkey. "Activities do not expire": the request counts as the first approval and starts a 24-hour window, after which existing approvals expire and must be submitted again ([Activities](https://docs.turnkey.com/api-reference/activities/overview)). If an approver approves it, the signature exists for a request the plugin gave up on. Reject the activity. For a transaction, the plugin wraps the error in `core.signer.transaction-outstanding` and keeps the nonce held, as [When Turnkey does not answer in time](#when-turnkey-does-not-answer-in-time) describes: reject the activity, then send a replacement with that nonce.

### Reject the pending activity

Turnkey rejects an activity by its fingerprint, not its id ([Reject activity](https://docs.turnkey.com/api-reference/activities/reject-activity)). With the activity id from the error, read the activity with `get_activity`, which takes `organizationId` and `activityId` ([Get activity](https://docs.turnkey.com/api-reference/queries/get-activity)):

```sh
turnkey request --path /public/v1/query/get_activity --body '{
  "organizationId": "'"$ORGANIZATION_ID"'",
  "activityId": "<activity id from the error>"
}' --key-name admin
```

Check that the activity's `status` is still `ACTIVITY_STATUS_CONSENSUS_NEEDED` or `ACTIVITY_STATUS_AUTHENTICATORS_NEEDED`, and note its `fingerprint`. Its `canReject` field says whether the activity can be rejected. Then reject it:

```sh
turnkey request --path /public/v1/submit/reject_activity --body '{
  "type": "ACTIVITY_TYPE_REJECT_ACTIVITY",
  "timestampMs": "'"$(date +%s)"'000",
  "organizationId": "'"$ORGANIZATION_ID"'",
  "parameters": { "fingerprint": "<fingerprint>" }
}' --key-name admin
```

Run both with a root user's key or as a user who takes part in the policy's consensus, such as an approver, or do the same in the dashboard. Whether the API user that made the request may reject its own activity is not documented. The activity then ends as `ACTIVITY_STATUS_REJECTED`.

To sign from Hardhat with this account, give the API user a policy that allows the plugin's requests without approval, as in [step 4](#4-allow-signing-with-one-account-and-deny-credential-changes).

## What Turnkey records

Turnkey keeps every activity, with its parameters and result, and "all users have implicit GET (read) permissions in their own Organization and any associated Sub-Organizations" ([Policies overview](https://docs.turnkey.com/features/policies/overview#policy-evaluation)). Every user of the organization can therefore read what each request sent:

- A message's activity holds the EIP-191 message itself, hex-encoded, since the plugin sends the message and Turnkey hashes it. Foundry sends only the hash.
- A typed-data activity holds the typed data as JSON, which policies can also read as `eth.eip_712` ([Policy language](https://docs.turnkey.com/features/policies/language#eip-712)).
- A transaction's activity holds the unsigned transaction and, once it completes, the signed transaction. Turnkey parses it, so policies can read its fields as `eth.tx.*`. Anyone who can read the activity can broadcast that signed transaction, including one from an activity the plugin gave up on after a timeout or an abort: the plugin keeps that nonce held and names the activity ([When Turnkey does not answer in time](#when-turnkey-does-not-answer-in-time)).
- For a key with `transactionSigning: "digest"`, a transaction's activity holds only the transaction's 32-byte digest, which nobody can broadcast, and `eth.tx.*` does not apply.
- An EIP-7702 authorization's activity holds only its 32-byte digest.

Do not sign a message you would not show every user of the organization.

`kms history` does not read Turnkey's activity log yet. For a Turnkey key it fails with `core.history.unsupported`. Read the activities in the dashboard, or with Turnkey's `list_activities` query.

## Errors

Each message starts with the provider, the operation and the key, for example `turnkey, sign message, key turnkey:<TURNKEY_ORGANIZATION_ID>/0x…: Turnkey answered 401 …`. The table lists the part after the colon. Messages show the HTTP status and Turnkey's `turnkeyErrorCode`, never Turnkey's message, which can name organizations.

| Error                                                                         | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Turnkey keys need the @hardhat-kms/turnkey plugin`                           | Run `npm install --save-dev @hardhat-kms/turnkey` in the Hardhat project, and add `hardhatKmsTurnkey` to `plugins` in the config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Expected configVariable(NAME) without a default or a format`                 | `apiPrivateKey` is a literal string, or a variable with a `default` or a `format` (`core.config.secret-variable`). Write `configVariable("TURNKEY_API_PRIVATE_KEY")` and set the variable, as in [step 5](#5-store-the-api-private-key).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `the API private key is not a P-256 private key`                              | The variable does not hold 64 hex characters. A common mistake is the public key, 66 characters, or the CLI's file with its `:p256` suffix. Set it to the private key's 64 hex characters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Turnkey answered 401 …: it did not accept the API key`                       | The API key is not registered to a user of this organization or its parent, or has expired. Check `organizationId` and the key's expiry, or rotate it ([step 5](#give-the-key-an-expiry-and-rotate-it)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Turnkey answered …: it refused the request's time`                           | `turnkey.service.timestamp`. Turnkey accepts a request whose `timestampMs` is at most 1 hour old and at most 5 minutes ahead of its clock ([Signed-request validity](https://docs.turnkey.com/api-reference/activities/overview#signed-request-validity)). Sync this computer's clock, for example with NTP, and run again.                                                                                                                                                                                                                                                                                                                                                                                 |
| `Turnkey answered 403 …: no policy lets the API key's user sign this request` | `turnkey.service.forbidden`. No policy allows this request, or a policy denies it. For a transaction, unless the key sets `transactionSigning: "digest"`, the message names `ACTIVITY_TYPE_SIGN_TRANSACTION_V2`: add the second policy of [step 4](#the-policies), or set the key's [`transactionSigning: "digest"`](#transactions-as-a-digest-as-foundry-signs-them). For a message, typed data or a digest, it names the hash function and encoding; see [Policies written for Foundry](#policies-written-for-foundry). A digest is an EIP-7702 authorization, `kms sign --no-hash`, or a transaction of a key with `transactionSigning: "digest"`. Turnkey also answers 403 when API access is disabled. |
| `Turnkey signed a transaction whose … differs`                                | `turnkey.sign.transaction-mismatch`. Turnkey's signed transaction is not the one the plugin sent. The plugin uses none of it and sends nothing, and keeps the nonce held: that transaction may carry it ([When Turnkey does not answer in time](#when-turnkey-does-not-answer-in-time)). Check the network and any proxy.                                                                                                                                                                                                                                                                                                                                                                                   |
| `Turnkey answered 404 …: the organization was not found`                      | Copy `organizationId` from the dashboard. For a wallet in a sub-organization, use the sub-organization's id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Turnkey answered 400 …: it refused the request`                              | Usually `address` is not a wallet account of the organization. Check both against the dashboard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `the organization has used up its monthly signing quota`                      | `turnkey.service.quota`. Wait for the next month, or move the organization to a plan with more signatures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Turnkey answered 429 … times: too many requests`                             | `turnkey.service.throttled`. Sign fewer requests in parallel, or move to a plan with a higher rate limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Turnkey holds activity … until it gets …`                                    | `turnkey.activity.approval-needed`. A policy needs approval or another authenticator. [Reject the pending activity](#reject-the-pending-activity), then fix the policy. For a transaction it comes inside `core.signer.transaction-outstanding`, which keeps the nonce held: after rejecting, send a replacement with that nonce.                                                                                                                                                                                                                                                                                                                                                                           |
| `Turnkey's signing activity was rejected` or `… failed`                       | The activity ended as `ACTIVITY_STATUS_REJECTED` or `ACTIVITY_STATUS_FAILED`. The message shows Turnkey's failure code. Check the activity in the dashboard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Turnkey answered …, a redirect` or `Turnkey could not be reached`            | A proxy or the network is in the way. Check that `api.turnkey.com` can be reached, DNS and any `HTTPS_PROXY`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `the signature does not recover to the configured address`                    | Turnkey signed with another account than `address`, and the plugin refused the signature. Check `address` against the account in the dashboard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `no answer within … ms`                                                       | Turnkey did not finish in time. Check the network, or raise `timeoutMs`. For a transaction, the message goes on with `after the request reached the provider` and names the held nonce and the activity (`core.signer.transaction-outstanding`): Turnkey can still complete it and hold a signed transaction anyone in the organization can broadcast. Reject the activity while it is pending, or send a replacement with that nonce, before any other transaction; see [When Turnkey does not answer in time](#when-turnkey-does-not-answer-in-time).                                                                                                                                                     |

Run with `DEBUG=hardhat:kms:*` to see each request's status, timing and Turnkey error code, never its body or stamp; see [Debug output](debug-output.md). The [errors reference](../reference/errors.md#hardhat-kmsturnkey) lists every Turnkey error with its id, cause and fix, and the [core plugin's errors](../reference/errors.md#hardhat-kms) too.
