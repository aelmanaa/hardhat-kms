[![npm version](https://img.shields.io/npm/v/hardhat-kms)](https://www.npmjs.com/package/hardhat-kms)
[![CI](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aelmanaa/hardhat-kms/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/aelmanaa/hardhat-kms)](https://github.com/aelmanaa/hardhat-kms/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/hardhat-kms)](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/support.md)

# hardhat-kms

Sign Hardhat 3 transactions, messages and typed data with keys held in **AWS KMS**, **Google Cloud KMS** or **Azure Key Vault**. The private key never leaves the KMS.

Hardhat 3 only. A community plugin, built in a personal capacity; not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.

- viem, ethers, Ignition and plain scripts use KMS accounts unchanged: the plugin works at the JSON-RPC layer.
- Every signature is recovered locally and must match the configured address before it is used. See the [security model](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/security-model.md).
- Three clouds, one config: `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure`. Credentials come from each cloud SDK's default chain, never from the Hardhat config.
- A `--kms` option that reads Foundry's key variables, and eight [`kms` tasks](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/tasks.md), from `accounts` to `history`, which reads your cloud audit log.
- Legacy, EIP-2930, EIP-1559 and EIP-7702 transactions, EIP-191 and EIP-712 signing, all run on Sepolia in a [live proof](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/live-proof.md) with block ranges and on-chain `ecrecover` checks.
- Releases are published from GitHub Actions with npm provenance; `npm audit signatures` checks them. Report vulnerabilities as [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md) says.

## Install

Each cloud has its own package. Install it together with the core, `hardhat-kms`, which it needs as a peer dependency at the same version.

```sh
npm install --save-dev hardhat-kms @hardhat-kms/aws   # or @hardhat-kms/gcp, or @hardhat-kms/azure
```

The other peer dependencies, which you install yourself:

- `hardhat` ^3.18.0.
- `viem` ^2.55.13, if you call `connection.kms.getAccount`. ethers and Ignition projects need no other peer.

npm and pnpm install missing peers; yarn does not. These packages are newer than most AI training data: check npm for the current version.

## Configure

Keys are declared once under `kms.keys` and attached to networks by name:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer" },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: ["deployer"],
    },
  },
});
```

`@hardhat-kms/aws` loads the `hardhat-kms` plugin itself, so `plugins` lists only the provider. Run `npx hardhat kms accounts` to see the key's address, then pin it in the key's config with `address`.

Next: a first deploy with [AWS KMS](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-aws.md), [Google Cloud KMS](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-gcp.md) or [Azure Key Vault](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-azure.md). Then the [security model](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/security-model.md), the [comparison with Foundry](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/foundry-comparison.md), the [configuration reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/configuration.md), runnable [examples](https://github.com/aelmanaa/hardhat-kms/blob/main/examples/README.md) for viem, ethers and Ignition, and [all docs](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md).

## Official packages

The official packages are `hardhat-kms` and the packages under the `@hardhat-kms` npm scope. A package with any other name, such as `hardhat-kms-aws`, does not come from this project.

## Verify a release

Every release is built and published by a GitHub Actions run of this repository, from a signed `v<version>` tag, with npm provenance. The checks below confirm that the packages you installed are the ones that run built. They are written for npm 11, use `jq`, and run from one working directory. Replace `<version>` with the installed version, such as `1.0.0`.

1. Check the registry signatures and attestations in your project:

   ```sh
   npm audit signatures
   ```

   ```text
   audited 412 packages in 3s

   412 packages have verified registry signatures

   97 packages have verified attestations
   ```

   The counts depend on your project. When a signature or an attestation does not verify, the command names the package and exits with a non-zero code. To list the hardhat-kms packages among the verified attestations:

   ```sh
   npm audit signatures --json --include-attestations | jq -r '.verified[] | select(.name == "hardhat-kms" or (.name | startswith("@hardhat-kms/"))) | "\(.name)@\(.version)"'
   ```

   It prints one line per hardhat-kms package you installed, such as `hardhat-kms@1.0.0` and `@hardhat-kms/aws@1.0.0`, and four lines if you installed all three providers. A hardhat-kms package missing from the list has no provenance attestation. Treat that as a failure.

2. Read the provenance. `npm view hardhat-kms@<version> dist.attestations` prints the attestation entry:

   ```text
   {
     url: 'https://registry.npmjs.org/-/npm/v1/attestations/hardhat-kms@<version>',
     provenance: { predicateType: 'https://slsa.dev/provenance/v1' }
   }
   ```

   The provenance statement names the workflow, the commit and the run:

   ```sh
   curl -s "$(npm view hardhat-kms@<version> dist.attestations.url)" | jq -r '.attestations[] | select(.predicateType == "https://slsa.dev/provenance/v1") | .bundle.dsseEnvelope.payload' | base64 --decode | jq '{workflow: .predicate.buildDefinition.externalParameters.workflow, commit: .predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit, run: .predicate.runDetails.metadata.invocationId}'
   ```

   ```json
   {
     "workflow": {
       "ref": "refs/tags/v<version>",
       "repository": "https://github.com/aelmanaa/hardhat-kms",
       "path": ".github/workflows/release.yml"
     },
     "commit": "<commit>",
     "run": "https://github.com/aelmanaa/hardhat-kms/actions/runs/<run-id>/attempts/1"
   }
   ```

   The Provenance section of the package page on npmjs.com shows the same statement, with links to the build summary, the source commit and the build file. The commit must be the one the tag points at in a clone:

   ```sh
   git clone https://github.com/aelmanaa/hardhat-kms.git
   git -C hardhat-kms rev-parse 'v<version>^{commit}'
   ```

   To check the tag's signature as well, import the maintainer keys with `gpg --import hardhat-kms/.github/release-keys/*.asc`, then run `git -C hardhat-kms verify-tag v<version>`.

3. Compare the tarball's files with the repository at the tag. `npm pack hardhat-kms@<version>` downloads `hardhat-kms-<version>.tgz`. This command lists the tarball's files next to the files git tracks under `packages/hardhat-kms` at the tag, filtered by the `files` field of its `package.json`, and prints nothing when they match:

   ```bash
   diff <(tar -tzf hardhat-kms-<version>.tgz | sed 's|^package/||' | grep -v '^dist/' | sort) <(git -C hardhat-kms ls-tree -r --name-only v<version> -- packages/hardhat-kms | sed 's|^packages/hardhat-kms/||' | grep -E '^(src/|README\.md$|LICENSE$|CHANGELOG\.md$|THIRD_PARTY_NOTICES\.md$|package\.json$)' | grep -v '\.test\.' | sort)
   ```

   `dist/` is build output and is not in git, so the command leaves it out. This one prints nothing when every compiled file in `dist/src/` has a source file in `src/`, and the reverse:

   ```bash
   diff <(tar -tzf hardhat-kms-<version>.tgz | sed -n 's|^package/dist/src/\(.*\)\.js$|\1|p' | sort) <(tar -tzf hardhat-kms-<version>.tgz | sed -n 's|^package/src/\(.*\)\.ts$|\1|p' | sort)
   ```

4. If any step fails, do not use that version. Keep or pin the last version that passed, and report the failure privately as [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md) says, through a [security advisory report](https://github.com/aelmanaa/hardhat-kms/security/advisories/new).

What provenance proves: the tarball npm serves was built by the named GitHub Actions run of this repository, from the named commit and tag, and has not changed since that run signed it. What it does not prove: that the code at that commit is correct or safe to run, that a rebuild gives the same bytes, or that the dependencies your lockfile resolves are the ones the run used. `npm audit signatures` checks each dependency's registry signature, and its attestation when it has one.

## Tasks and the `--kms` option

The `kms` tasks run as `npx hardhat kms <task>`. A task takes a key by the name it has in `kms.keys` and prints its result alone on standard output, so a script can capture it. The [tasks reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/tasks.md) has every option.

| Task             | What it does                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `kms accounts`   | Lists each configured key with its provider, key id and address, and prints `address` pins. |
| `kms address`    | Prints a key's address.                                                                     |
| `kms public-key` | Prints a key's uncompressed public key.                                                     |
| `kms sign`       | Signs an EIP-191 message, EIP-712 typed data or, with `--no-hash`, a raw 32-byte digest.    |
| `kms sign-auth`  | Signs an EIP-7702 authorization, as the JSON tuple `authorizationList` takes.               |
| `kms sign-tx`    | Fills a transaction on the network's node and signs it, without sending it.                 |
| `kms verify`     | Checks a signature against an address or a key, locally.                                    |
| `kms history`    | Lists a key's sign events from CloudTrail, Cloud Audit Logs or the Key Vault audit log.     |

`--kms aws`, `--kms gcp` and `--kms azure` read keys from Foundry's environment variables, such as `AWS_KMS_KEY_ID`, without a config entry, so a Foundry project keeps its variables. [Migrate from Foundry](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/migrate-from-foundry.md) shows the mapping.

## How the plugin changes Hardhat

- A `kms` section in the config (`kms.keys`, `kms.defaults`, `kms.audit`) and a `kmsAccounts` list on each network, validated when the config loads.
- A network hook that handles `eth_accounts`, `eth_requestAccounts`, `eth_sendTransaction`, `eth_signTransaction`, `personal_sign`, `eth_sign` and `eth_signTypedData_v4` for KMS accounts and passes every other request through.
- The `kms` task namespace, listed by `npx hardhat kms`.
- The `--kms` global option.

[How hardhat-kms works](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/how-it-works.md) follows one transaction through the hook, the KMS and the node.

## Library accounts

`connection.kms.getAccount` returns a viem account for a KMS key, for viem's `signAuthorization`, smart-account owners and scripts. It needs viem 2.55.13 or later. An older viem is refused before any KMS call; the [library accounts reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md) explains the floor and what each package manager installs.

## Support

Which Node.js versions the published packages run on, when a line is dropped and what an older Node.js does: [Support](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/support.md).

## Docs

- All docs, for users and contributors: [docs/README.md](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md)
- For coding agents: [AGENTS.md](https://github.com/aelmanaa/hardhat-kms/blob/main/AGENTS.md)
- Contributing: [CONTRIBUTING.md](https://github.com/aelmanaa/hardhat-kms/blob/main/CONTRIBUTING.md)
- Security reports: [SECURITY.md](https://github.com/aelmanaa/hardhat-kms/blob/main/SECURITY.md)

## License

MIT
