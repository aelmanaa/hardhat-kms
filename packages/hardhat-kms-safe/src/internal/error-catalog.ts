import type { ErrorEntry } from "hardhat-kms/provider-utils";

/*
 * Every error @hardhat-kms/safe builds, with its cause and fix. Build errors only from these
 * entries, with catalogError, catalogMessage or internalError from hardhat-kms/provider-utils;
 * `pnpm run docs:check` fails on a throw that bypasses them. `pnpm run docs:errors` writes
 * docs/user/reference/errors.md from this file.
 *
 * No message carries the API key, a request header or the service's body, except the allow-listed
 * reasons of a 422 (`nonFieldErrors` and the names of the fields it refused), cut to printable
 * text. Addresses, hashes and chain ids are public and safe to print.
 */

/** The @hardhat-kms/safe error catalogue. */
export const ERRORS = {
  section: {
    id: "safe.config.section",
    kind: "validation",
    group: "Configuration",
    template:
      "must be an object with only apiKey, services and timeoutMs; services maps chain ids to URLs",
    cause:
      "`kmsSafe` or `kmsSafe.services` is not an object, or `kmsSafe` has a field the plugin does not read, such as a misspelt one.",
    fix: "Check the spelling against the configuration reference.",
  },
  apiKeyLiteral: {
    id: "safe.config.api-key-literal",
    kind: "validation",
    group: "Configuration",
    template:
      'must be a configuration variable, such as configVariable("SAFE_TRANSACTION_SERVICE_API_KEY"), never the key itself',
    cause:
      "`kmsSafe.apiKey` is a string or another value. A key written in the config file is committed with it.",
    fix: 'Write `apiKey: configVariable("SAFE_TRANSACTION_SERVICE_API_KEY")` and set the variable in the environment or with `npx hardhat keystore set SAFE_TRANSACTION_SERVICE_API_KEY`.',
  },
  serviceChainId: {
    id: "safe.config.service-chain-id",
    kind: "validation",
    group: "Configuration",
    template: "must be a chain id in decimal, such as 11155111",
    cause: "A key of `kmsSafe.services` is not a positive decimal number.",
    fix: 'Key each service by its chain id, as `services: { "11155111": "https://…" }`.',
  },
  serviceUrl: {
    id: "safe.config.service-url",
    kind: "validation",
    group: "Configuration",
    template:
      "must be an https URL without a user name, password, query or fragment; http is accepted only for localhost and 127.0.0.1",
    cause:
      "A URL of `kmsSafe.services` is not a URL, uses another scheme, uses http for a remote host, or carries credentials, a query or a fragment. The plugin sends the API key and signed proposals to it.",
    fix: "Set the root of the Transaction Service, such as `https://safe-transaction.example.com`, without `/api`.",
  },
  timeout: {
    id: "safe.config.timeout",
    kind: "validation",
    group: "Configuration",
    template: "must be a whole number of milliseconds from 1000 to 300000",
    cause: "`kmsSafe.timeoutMs` is not an integer between 1000 and 300000.",
    fix: "Remove it to use 30000, or set a number in that range.",
  },
  badAddress: {
    id: "safe.input.address",
    kind: "error",
    group: "Inputs",
    template: "{field} is not an address: expected 0x and 40 hexadecimal characters",
    cause:
      "The Safe or the target is not a 20-byte hexadecimal address. A mixed-case address whose EIP-55 checksum is wrong counts as not an address.",
    fix: "Copy the address again, for example from the Safe app or a block explorer.",
  },
  badData: {
    id: "safe.input.data",
    kind: "error",
    group: "Inputs",
    template: "the call data is not 0x-prefixed hexadecimal bytes",
    cause: "`--data` or `call.data` is not `0x` followed by an even number of hex characters.",
    fix: "Pass the ABI-encoded call, or use `--function` and `--args` to have the task encode it.",
  },
  dataAndFunction: {
    id: "safe.input.data-and-function",
    kind: "error",
    group: "Inputs",
    template: "pass either --data or --function with --args, not both",
    cause: "The task got the call data twice.",
    fix: "Drop one of them.",
  },
  argsWithoutFunction: {
    id: "safe.input.args-without-function",
    kind: "error",
    group: "Inputs",
    template: "--args needs --function",
    cause: "`--args` gives arguments for a function that `--function` does not name.",
    fix: 'Add `--function`, such as `--function "transferOwnership(address)"`.',
  },
  badFunction: {
    id: "safe.input.function",
    kind: "error",
    group: "Inputs",
    template:
      'cannot encode the call: {reason}. --function takes a signature such as "transferOwnership(address)" and --args a JSON array such as \'["0x…"]\'',
    cause:
      "`--function` is not a function signature, `--args` is not a JSON array, or an argument does not fit its parameter's type.",
    fix: "Check the signature against the contract's ABI, and pass one JSON value per parameter. Pass integers as strings or numbers.",
  },
  negative: {
    id: "safe.input.negative",
    kind: "error",
    group: "Inputs",
    template: "{field} cannot be negative",
    cause: "The value or the nonce is below zero.",
    fix: "Pass a value in wei and a nonce of zero or more.",
  },
  badNumber: {
    id: "safe.input.number",
    kind: "error",
    group: "Inputs",
    template: "{field} is not a whole number in decimal",
    cause: "`--nonce` is not made of decimal digits.",
    fix: "Pass the nonce in decimal, such as `--nonce 12`.",
  },
  nonceTooLarge: {
    id: "safe.input.nonce-too-large",
    kind: "error",
    group: "Inputs",
    template: "the nonce {nonce} is above 2^53 - 1, which the Transaction Service cannot store",
    cause:
      "The Transaction Service reads the nonce as a JSON number, as Safe's api-kit sends it, so the plugin refuses a nonce it cannot represent exactly.",
    fix: "Use the Safe's next nonce, or leave out `--nonce`.",
  },
  noKmsAccount: {
    id: "safe.key.none",
    kind: "error",
    group: "Signer",
    template:
      "the network {network} has no KMS account. Add the owner's key to its kmsAccounts, or pass --key",
    cause:
      "The task signs with a KMS account of the network it runs on, and this network's `kmsAccounts` is empty.",
    fix: "Add the key to the network's `kmsAccounts`, or name it with `--key`.",
  },
  severalKmsAccounts: {
    id: "safe.key.several",
    kind: "error",
    group: "Signer",
    template:
      "the network {network} has {count} KMS accounts. Pass --key with the one that owns the Safe: {names}",
    cause: "The task does not guess which of several KMS accounts is the Safe's owner.",
    fix: "Pass `--key <name>`.",
  },
  notOnNetwork: {
    id: "safe.key.not-on-network",
    kind: "error",
    group: "Signer",
    template:
      "{address} (key {key}) is not a KMS account of the network {network}. Add the key to its kmsAccounts",
    cause:
      "The key `--key` names is not among the connection's accounts, so the connection cannot sign with it.",
    fix: "Add the key to the network's `kmsAccounts`, or choose the network the key is configured for.",
  },
  badSender: {
    id: "safe.key.sender",
    kind: "error",
    group: "Signer",
    template: "the sender is not an address: expected 0x and 40 hexadecimal characters",
    cause:
      "`proposeSafeTransaction` got a `sender` that is not a 20-byte hexadecimal address with a valid checksum.",
    fix: "Pass the address of one of the connection's KMS accounts.",
  },
  chainMismatch: {
    id: "safe.check.chain-mismatch",
    kind: "error",
    group: "Checks before signing",
    template:
      "the node answers chain {actual}, but the network is configured for chain {expected}. Nothing was signed",
    cause:
      "The network's `chainId` and the node's `eth_chainId` differ, so the SafeTx would be signed for another chain than the one configured.",
    fix: "Check the network's URL and `chainId`.",
  },
  chainUnreadable: {
    id: "safe.check.chain-id",
    kind: "error",
    group: "Checks before signing",
    template:
      "the node answered eth_chainId with something other than a hex quantity. Nothing was signed",
    cause:
      "The connection's `eth_chainId` did not return a `0x`-prefixed number, so the plugin cannot tell which chain the Safe is on.",
    fix: "Check the network's URL: it must be an Ethereum JSON-RPC endpoint.",
  },
  noCode: {
    id: "safe.check.no-code",
    kind: "error",
    group: "Checks before signing",
    template:
      "there is no contract at {safe} on chain {chainId}. Check the Safe's address and the network. Nothing was signed",
    cause:
      "`eth_getCode` returned no code for the Safe's address on this chain. A Safe deployed on one chain does not exist on another until it is deployed there.",
    fix: "Run the task on the network where the Safe is deployed, with its address from the Safe app.",
  },
  unreadable: {
    id: "safe.check.unreadable",
    kind: "error",
    group: "Checks before signing",
    template:
      "the contract at {safe} did not answer {function} as a Safe does. Is it a Safe? Nothing was signed",
    cause:
      "A read of the Safe (`VERSION`, `getOwners`, `getThreshold`, `nonce` or `getTransactionHash`) reverted or returned data the plugin cannot decode, or the node answered something other than hex.",
    fix: "Check that the address is a Safe proxy, not its singleton, a module or another contract.",
  },
  unsupportedVersion: {
    id: "safe.check.version",
    kind: "error",
    group: "Checks before signing",
    template:
      "the Safe at {safe} is version {version}; the plugin proposes for Safe 1.3.0, 1.4.1 and 1.5.0 only. Nothing was signed",
    cause:
      "The Safe's `VERSION()` is not one the plugin supports. Before 1.3.0 the SafeTx domain has no chain id, so a signature would also be valid for a Safe at the same address on another chain.",
    fix: "Upgrade the Safe from the Safe app, or sign the transaction there.",
  },
  notOwner: {
    id: "safe.check.not-owner",
    kind: "error",
    group: "Checks before signing",
    template:
      "{sender} is not an owner of the Safe {safe} on chain {chainId}. Its owners are {owners}. Nothing was signed",
    cause:
      "The key's address is not in the Safe's `getOwners()` at the latest block, so its signature would not count and the service would refuse the proposal.",
    fix: "Add the key's address as an owner from the Safe app, or use the key of an owner.",
  },
  nonceUsed: {
    id: "safe.check.nonce-used",
    kind: "error",
    group: "Checks before signing",
    template:
      "the nonce {nonce} is below the Safe's nonce {safeNonce}: a transaction with that nonce has already run. Nothing was signed",
    cause:
      "`--nonce` is below the Safe's on-chain `nonce()`. The Safe executes each nonce once, so the transaction could never run. The Transaction Service checks this only against transactions it indexed.",
    fix: "Leave out `--nonce` to take the next one, or pass a nonce of at least the Safe's nonce. To replace a queued transaction, pass its nonce.",
  },
  delegatecall: {
    id: "safe.check.delegatecall",
    kind: "error",
    group: "Checks before signing",
    template:
      "operation 1 is a delegatecall: the Safe would run the code at {to} with its own storage and balance. Pass --delegatecall to propose it. Nothing was signed",
    cause:
      "The call asks for `operation: 1`. A delegatecall lets the target change the Safe's owners, threshold, modules and funds. Safe's own MultiSend batches use it.",
    fix: "Propose a call instead, or pass `--delegatecall` (`allowDelegateCall: true` in the library) when the target is a contract you trust, such as Safe's MultiSendCallOnly.",
  },
  hashMismatch: {
    id: "safe.check.hash-mismatch",
    kind: "error",
    group: "Checks before signing",
    template:
      "the Safe computes the SafeTx hash {contractHash}, but the plugin computed {hash}. Nothing was signed",
    cause:
      "The Safe's own `getTransactionHash` disagrees with the EIP-712 hash the plugin built. The Safe's domain or type is not the one of Safe 1.3.0 to 1.5.0, so its owners would sign something the Safe does not check.",
    fix: "Do not propose to this contract. If it is a Safe the plugin should support, open an issue with its version and chain.",
  },
  declined: {
    id: "safe.task.declined",
    kind: "error",
    group: "Threshold 1",
    template: "not proposed: the answer was not yes. Nothing was signed",
    cause:
      "The Safe's threshold is 1, so the key's signature alone lets anyone execute the transaction once the service publishes it. The task asked at the terminal and got another answer than `y` or `yes`, or its input closed.",
    fix: "Run it again and answer `y`, or pass `--yes` when no person can answer.",
  },
  noTerminal: {
    id: "safe.task.no-terminal",
    kind: "error",
    group: "Threshold 1",
    template:
      "the Safe {safe} has threshold 1, so this signature alone executes the transaction. No terminal can confirm it: pass --yes to propose anyway. Nothing was signed",
    cause:
      "The task asks a person before it signs for a 1-of-N Safe, and standard input or standard error is not a terminal, as in CI.",
    fix: "Run it at a terminal, or pass `--yes` in a job that should propose to a 1-of-N Safe.",
  },
  signatureShape: {
    id: "safe.sign.shape",
    kind: "error",
    group: "Checks after signing",
    template:
      "the connection returned a signature that is not 65 bytes, or whose v is not 27 or 28. Nothing was posted",
    cause:
      "The Safe reads a 65-byte signature with v 27 or 28 as an EIP-712 owner signature. Other v values mean another signature type.",
    fix: "Check that the sender is a KMS account of the connection. If it is, report it.",
  },
  signatureSigner: {
    id: "safe.sign.signer",
    kind: "error",
    group: "Checks after signing",
    template: "the signature recovers to {recovered}, not to {sender}. Nothing was posted",
    cause:
      "The signature does not recover to the key's address over the SafeTx hash. hardhat-kms checks every signature, so this means the connection signed with another account or other data.",
    fix: "Check that the sender is a KMS account of the connection and that no other plugin handles `eth_signTypedData_v4` for it.",
  },
  signatureRefused: {
    id: "safe.sign.refused-by-safe",
    kind: "error",
    group: "Checks after signing",
    template: "the Safe's checkNSignatures refused the signature. Nothing was posted",
    cause:
      "An `eth_call` of the Safe's `checkNSignatures(hash, 0x, signature, 1)` reverted, so the Safe would not count the signature. The owners may have changed between the checks and the signature.",
    fix: "Run the task again. If it repeats, check the Safe's owners in the Safe app.",
  },
  badServiceUrl: {
    id: "safe.service.url",
    kind: "error",
    group: "Transaction Service",
    template:
      "the Transaction Service URL must be an https URL without a user name, password, query or fragment; http is accepted only for localhost and 127.0.0.1",
    cause:
      "`TransactionServiceClient` got a URL that is not https, or that carries credentials, a query or a fragment. The client sends the API key and signed proposals to it.",
    fix: "Pass the root of the Transaction Service, such as `https://api.safe.global/tx-service/sep`, without `/api`.",
  },
  unknownChain: {
    id: "safe.service.unknown-chain",
    kind: "error",
    group: "Transaction Service",
    template:
      "Safe's Transaction Service does not serve chain {chainId}. Set kmsSafe.services with a self-hosted service for it, or execute the transaction from the Safe directly. Nothing was signed",
    cause:
      "The chain is not in the plugin's table of chains that `api.safe.global` serves, taken from Safe's api-kit 5.0.4, and `kmsSafe.services` has no URL for it.",
    fix: 'Add `kmsSafe.services: { "<chainId>": "<root URL>" }` for a service you run, or collect the owners\' signatures and execute the transaction yourself.',
  },
  apiKeyMissing: {
    id: "safe.service.api-key-missing",
    kind: "error",
    group: "Transaction Service",
    template:
      'Safe\'s Transaction Service needs an API key. Set kmsSafe.apiKey to configVariable("SAFE_TRANSACTION_SERVICE_API_KEY"). Nothing was signed',
    cause:
      "`api.safe.global` refuses requests without an API key, and `kmsSafe.apiKey` is not set. A self-hosted service from `kmsSafe.services` needs no key.",
    fix: "Create a key at developer.safe.global, store it with `npx hardhat keystore set SAFE_TRANSACTION_SERVICE_API_KEY` or in the environment, and set `kmsSafe.apiKey`.",
  },
  unauthorized: {
    id: "safe.service.unauthorized",
    kind: "error",
    group: "Transaction Service",
    template:
      "the Transaction Service answered {status} to {request}: it did not accept the API key{signed}",
    cause:
      "The service refused the `Authorization` header: the key is missing, wrong, revoked or not valid for this service.",
    fix: "Check the value of `SAFE_TRANSACTION_SERVICE_API_KEY` at developer.safe.global, and that the key is meant for this service.",
  },
  rejected: {
    id: "safe.service.rejected",
    kind: "error",
    group: "Transaction Service",
    template: "the Transaction Service refused {request} with {status}: {reasons}{signed}",
    cause:
      "The service validated the request and refused it. It recomputes the SafeTx hash, checks that the sender is an owner or delegate, and recovers every signature. The message shows its `nonFieldErrors` and the names of the fields it refused, cut to printable text.",
    fix: "Read the reasons. A proposal with the same SafeTx hash and another signature, or a nonce the service saw executed, is refused.",
  },
  rateLimited: {
    id: "safe.service.rate-limited",
    kind: "error",
    group: "Transaction Service",
    template:
      "the Transaction Service answered 429 to {request}: the API key's rate limit or quota is used up. Try again later{signed}",
    cause:
      "Safe's gateway limits each API key per second and per month. The plugin does not retry.",
    fix: "Wait and run the task again, or ask Safe for a higher limit at developer.safe.global.",
  },
  serverError: {
    id: "safe.service.server-error",
    kind: "error",
    group: "Transaction Service",
    template:
      "the Transaction Service answered {status} to {request}. It may be down or overloaded{signed}",
    cause: "The service or Safe's gateway failed with a 5xx status. The plugin does not retry.",
    fix: "Check the transaction in the Safe app before you run the task again: a proposal can be stored even when the answer is lost.",
  },
  unexpectedStatus: {
    id: "safe.service.unexpected-status",
    kind: "error",
    group: "Transaction Service",
    template:
      "the Transaction Service answered {status} to {request}, which the plugin does not expect{signed}",
    cause:
      "The service answered with a status the plugin does not handle, such as a redirect, which the plugin never follows so that the API key and the signed proposal stay with the configured host, or a 404 for a Safe the service has not indexed.",
    fix: "Check the service URL in `kmsSafe.services`. For a 404, check that the service lists the Safe in the Safe app; a Safe it has not indexed cannot take proposals.",
  },
  unreachable: {
    id: "safe.service.unreachable",
    kind: "error",
    group: "Transaction Service",
    template: "the Transaction Service did not answer {request}{why}{signed}",
    cause:
      "The request failed before an answer arrived: DNS, TLS, a refused connection, or `kmsSafe.timeoutMs` (30 seconds by default) passed.",
    fix: "Check the network and the service URL, then run the task again. After a proposal timed out, check the Safe app first: the service may have stored it.",
  },
  badResponse: {
    id: "safe.service.bad-response",
    kind: "error",
    group: "Transaction Service",
    template: "the Transaction Service answered {request} with a body the plugin cannot read",
    cause:
      "The list of queued transactions is not JSON with a `results` array whose nonces are decimal integers.",
    fix: "Check the service URL in `kmsSafe.services`: it must be the root of a Safe Transaction Service.",
  },
  noPackageVersion: {
    id: "safe.internal.no-package-version",
    kind: "internal",
    group: "Internal",
    template: "{packageName}/package.json has no version",
    cause:
      "The installed @hardhat-kms/safe has no `version` in its package.json, so the install is broken.",
    fix: "Reinstall the dependencies. If it repeats, open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
} as const;

/** Every entry, checked against the entry type. */
export const ENTRIES: readonly ErrorEntry[] = Object.values(ERRORS);
