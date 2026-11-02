---
title: Debug output
description: Turn on hardhat-kms debug output with DEBUG=hardhat:kms:*, what each namespace logs, and what to check before you share it in an issue.
---

# Debug output

Set `DEBUG` to turn on the plugin's debug output. It goes to standard error:

```sh
DEBUG=hardhat:kms:* npx hardhat run scripts/deploy.ts --network sepolia
```

`DEBUG=hardhat:*` also turns on Hardhat's own debug output. `DEBUG` takes a comma-separated list, so `DEBUG=hardhat:kms:config,hardhat:kms:signer` shows just those two namespaces. Set `DEBUG_COLORS=no` for plain text.

> [!NOTE]
> Audience: users who want to see what the plugin does, for example when a key is slow or fails.

## Namespaces

| Namespace               | What it logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hardhat:kms:config`    | The display ids of the resolved keys, and of the keys each network uses.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `hardhat:kms:providers` | Each key whose adapter is being created, and `<display id>: no plugin claimed the key` when no provider plugin handles it, for example because `@hardhat-kms/aws` is not in `plugins`. Also `<display id>: creating the adapter failed (<error class>)`.                                                                                                                                                                                                                                          |
| `hardhat:kms:signer`    | Each call to a key's adapter with its operation, request id, duration and, on failure, error class name. Also the derived address, retries, and the number of signers closed when the last connection has been idle for 5 s.                                                                                                                                                                                                                                                                      |
| `hardhat:kms:rpc`       | Each connection to a network with KMS keys, with the network name and the number of keys; the display ids of the keys once their addresses are resolved; an `eth_accounts` or `eth_requestAccounts` call that failed downstream, with the error's class name, after which only the KMS addresses are listed; a nonce given to a library account's send, which then holds the lock, or reserved for one with its own transport; and a raw transaction passed on without the lock, with the reason. |
| `hardhat:kms:account`   | Each library account made with `connection.kms.getAccount`, with its address and network, and each transaction or authorization it signs, with its type and chain.                                                                                                                                                                                                                                                                                                                                |
| `hardhat:kms:history`   | Each `kms history` read, with the key's display id; a read that failed, with the error's class name; a reader that did not return in time; and a key whose provider has no history reader.                                                                                                                                                                                                                                                                                                        |
| `hardhat:kms:azure`     | The name of `AZURE_USERNAME` or `AZURE_PASSWORD` when the Azure credential chain ignores it, never its value.                                                                                                                                                                                                                                                                                                                                                                                     |

`hardhat:kms:providers` and `hardhat:kms:signer` print nothing until a connection first uses a key, to look up its address or to sign.

## What the output contains

Review the output before you share it, for example in an issue. It contains display ids (`aws:<AWS_KMS_KEY_ID>`), addresses, provider ids, operation names, request ids, timings and error class names. Key and network names from your config are printed as written, with control characters escaped. So is a key identifier written literally in the config, such as a key ARN, which holds your AWS account id ([Resolved config](../reference/configuration.md#resolved-config)). Configuration-variable values are hidden.

It never contains:

- the values of configuration variables, such as key ids or RPC URLs read from your environment;
- credentials, tokens or anything else in a third-party provider's key config;
- a provider's error messages, which can carry request details. Only the error class name is shown, such as `TypeError`.

A test runs the plugin with `DEBUG=hardhat:kms:*` and secrets planted in configuration variables and in a provider's error message, and fails if any secret appears in the output.

## Google Cloud's own logs

`GOOGLE_SDK_NODE_LOGGING` is not the plugin's debug output, and you do not need it to see what the plugin does. It turns on the logs of Google's client libraries, which print to standard error in full:

- `@google-cloud/kms` logs under `kms` every `getPublicKey` and `asymmetricSign` request and response, with the full key version name and the digest.
- `google-auth-library` logs under `auth` the URL of every request it sends, which for Cloud KMS holds the key version name, and the body of every response, including the access token of each token refresh or token exchange and the log entries `kms history` reads.

Its value is a comma-separated list of these namespaces: `kms`, `auth`, `*` or `all` for every one. The libraries ignore case, and a value that names neither, such as `true`, turns on nothing. When the value turns on `kms` or `auth`, the plugin prints this once, the first time a Google Cloud key is used or `kms history` reads one, and does not change the variable:

```text
hardhat-kms: GOOGLE_SDK_NODE_LOGGING is set, so Google's client libraries print every request and response on standard error: …
```

Unset it outside a local debugging session, and never set it in CI, whose logs others can read. An access token in a log lets anyone who reads it call Google Cloud as your identity until the token expires, about an hour later. The warning's entry is `gcp.debug.sdk-logging` in the [errors reference](../reference/errors.md).
