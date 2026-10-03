# Debug output

Audience: users who want to see what the plugin does, for example when a key is slow or fails.

Set `DEBUG` to turn on the plugin's debug output. It goes to standard error:

```sh
DEBUG=hardhat:kms:* npx hardhat run scripts/deploy.ts --network sepolia
```

`DEBUG=hardhat:*` also turns on Hardhat's own debug output. `DEBUG` takes a comma-separated list, so `DEBUG=hardhat:kms:config,hardhat:kms:signer` shows just those two namespaces. Set `DEBUG_COLORS=no` for plain text.

## Namespaces

| Namespace               | What it logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hardhat:kms:config`    | The display ids of the resolved keys, and of the keys each network uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `hardhat:kms:providers` | Each key whose adapter is being created, and `<display id>: no plugin claimed the key` when no provider plugin handles it, for example because `@hardhat-kms/aws` is not in `plugins`. Also `<display id>: creating the adapter failed (<error class>)`.                                                                                                                                                                                                                                                                                                                                          |
| `hardhat:kms:signer`    | Each call to a key's adapter with its operation, request id, duration and, on failure, error class name. Also the derived address, retries, and the number of signers closed when the last connection has been idle for 5 s.                                                                                                                                                                                                                                                                                                                                                                      |
| `hardhat:kms:rpc`       | Each connection to a network with KMS keys, with the network name and the number of keys; the display ids of the keys once their addresses are resolved; an `eth_accounts` or `eth_requestAccounts` call that failed downstream, with the error's class name, after which only the KMS addresses are listed; a nonce given to a library account's send, which then holds the lock, or reserved for one with its own transport; a library account's `reset` that could not read the pending count, with the error's class name; and a raw transaction passed on without the lock, with the reason. |
| `hardhat:kms:account`   | Each library account made with `connection.kms.getAccount`, with its address and network, and each transaction or authorization it signs, with its type and chain.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hardhat:kms:history`   | Each `kms history` read, with the key's display id; a read that failed, with the error's class name; a reader that did not return in time; and a key whose provider has no history reader.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `hardhat:kms:azure`     | The name of `AZURE_USERNAME` or `AZURE_PASSWORD` when the Azure credential chain ignores it, never its value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`hardhat:kms:providers` and `hardhat:kms:signer` print nothing until a connection first uses a key, to look up its address or to sign.

## What the output contains

The output is meant to be pasted into an issue. It contains display ids (`aws:<AWS_KMS_KEY_ID>`), addresses, provider ids, operation names, request ids, timings and error class names. Key and network names from your config are printed as written, with control characters escaped.

It never contains:

- the values of configuration variables, such as key ids or RPC URLs read from your environment;
- credentials, tokens or anything else in a third-party provider's key config;
- a provider's error messages, which can carry request details. Only the error class name is shown, such as `TypeError`.

A test runs the plugin with `DEBUG=hardhat:kms:*` and secrets planted in configuration variables and in a provider's error message, and fails if any secret appears in the output.
