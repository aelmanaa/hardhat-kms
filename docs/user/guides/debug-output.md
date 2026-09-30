# Debug output

Audience: users who want to see what the plugin does, for example when a key is slow or fails.

Status: M2 adds the three namespaces below. Only `hardhat:kms:config` logs during a Hardhat run today, because nothing creates adapters or signs until the network hook (M4) arrives. The provider adapters (M3, M6) and the network hook add their own lines.

Set `DEBUG` to turn on the plugin's debug output. It goes to standard error:

```sh
DEBUG=hardhat:kms:* npx hardhat run scripts/deploy.ts --network sepolia
```

`DEBUG=hardhat:*` also turns on Hardhat's own debug output. `DEBUG` takes a comma-separated list, so `DEBUG=hardhat:kms:config,hardhat:kms:signer` shows just those two namespaces. Set `DEBUG_COLORS=no` for plain text.

## Namespaces

| Namespace               | What it logs                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hardhat:kms:config`    | The display ids of the resolved keys, and of the keys each network uses.                                                                                                              |
| `hardhat:kms:providers` | Each key whose adapter is being created, and `<display id>: no plugin claimed the key` when no provider plugin handles it, for example because `hardhat-kms-aws` is not in `plugins`. |
| `hardhat:kms:signer`    | Each call to a key's adapter with its operation, request id, duration and, on failure, error class name. Also the derived address and retries.                                        |

## What the output contains

The output is meant to be pasted into an issue. It contains display ids (`aws:<AWS_KMS_KEY_ID>`), addresses, provider ids, operation names, request ids, timings and error class names. Key and network names from your config are printed as written, with control characters escaped.

It never contains:

- the values of configuration variables, such as key ids or RPC URLs read from your environment;
- credentials, tokens or anything else in a third-party provider's key config;
- a provider's error messages, which can carry request details. Only the error class name is shown, such as `TypeError`.

A test runs the plugin with `DEBUG=hardhat:kms:*` and secrets planted in configuration variables and in a provider's error message, and fails if any secret appears in the output.
