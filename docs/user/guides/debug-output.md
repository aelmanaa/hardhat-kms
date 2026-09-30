# Debug output

Audience: users who want to see what the plugin does, for example when a key is slow or fails.

Status: config, provider and signer logging is implemented (M2). The provider adapters (M3, M6) and the network hook (M4) add their own lines as they arrive.

Set `DEBUG` to turn on the plugin's debug output, which goes to standard error:

```sh
DEBUG=hardhat:kms:* npx hardhat run scripts/deploy.ts --network sepolia
```

To see Hardhat's own debug output too, use `DEBUG=hardhat:*`.

## Namespaces

| Namespace                   | What it logs                                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| `hardhat:kms:config`        | The resolved keys and the keys each network uses, by display id.              |
| `hardhat:kms:providers`     | Which handler or built-in provider builds each key's adapter.                 |
| `hardhat:kms:providers:sdk` | Which SDK package and version is loaded, and from where.                      |
| `hardhat:kms:signer`        | Each KMS call with its request id and duration, the derived address, retries. |

## What it never logs

The output is safe to paste into an issue. It contains display ids (`aws:<AWS_KMS_KEY_ID>`), addresses, provider ids, timings and error class names. It never contains:

- the values of configuration variables, such as key ids or RPC URLs read from your environment;
- credentials, tokens or anything else in a third-party provider's key config;
- a provider's error messages, which can carry request details. Only the error class name is shown, such as `TypeError`.

A test runs the plugin with planted secrets and `DEBUG=hardhat:kms:*`, and fails if any of them appears in the output.
