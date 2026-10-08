---
title: Supported Node.js versions
description: Which Node.js versions the hardhat-kms packages run on, when a release drops an end-of-life line, where to ask a question and how to report a test run.
---

# Supported Node.js versions

Audience: Users choosing a Node.js version for a project that uses the published packages, deciding when to upgrade it, looking for where to ask a question, or testing a release candidate.

The published packages run on Node.js 22.13.0 or later, the minimum Hardhat 3 enforces ([Node.js support](https://hardhat.org/docs/reference/nodejs-support)). Each package declares it in `engines.node`. The supported lines are the ones Hardhat tests that have not reached end of life in the [Node.js release schedule](https://github.com/nodejs/Release#release-schedule): today Node.js 22, 24 and 26. CI runs the test suite on the lowest version of each line (22.13.0, 24.0.0 and 26.0.0) on Linux and on 22.13.0 on macOS and Windows, the same Node.js versions Hardhat tests. A line that has reached end of life, or is not in that list, is unsupported.

Once a line reaches end of life, a minor release may drop it, never earlier. A pinned issue announces the drop when the line reaches end of life, and the changeset names the dropped line and the last version that ran on it. There is no maintenance branch: fixes are not backported to that version. The reason is that these packages sign with production keys, and an end-of-life line [receives no security fixes from the Node.js project](https://nodejs.org/en/about/eol), including to the TLS stack the cloud SDKs use to reach the KMS. Node.js 22 reaches end of life on 2027-04-30; the schedule can move that date.

The minimum can rise without a release of these packages. Hardhat checks its own minimum at startup and has raised it in a patch release before: 3.4.3 moved it from 22.10.0 to 22.13.0. The cloud SDKs the provider packages depend on can drop an end-of-life line inside the version ranges these packages declare. When either happens, the next minor release raises `engines.node` to match and the changeset says so.

On an older Node.js, `npm install` prints an `EBADENGINE` warning (an error with `engine-strict`); `pnpm install` installs without a message unless `engineStrict` is set, then it fails with `ERR_PNPM_UNSUPPORTED_ENGINE`. In both cases `npx hardhat` exits with an error naming the minimum version before any task runs.

The Hardhat and viem ranges, the release channels and how long a previous major gets security fixes are in [Release channels and versioning](../explanation/versioning.md).

## Questions

Start with the [docs index](../../README.md): it lists every tutorial, guide and reference page, and the [errors reference](errors.md) explains each error message. If the docs do not answer the question, open an issue with the Question form, which adds the `question` label. When the repository enables GitHub Discussions, this section will link them. Report a vulnerability privately as [SECURITY.md](../../../SECURITY.md) says, never in an issue.

## Tester reports

Until 1.0.0 is published, a developer who follows a tutorial for the first time finds what the maintainers cannot: a step the docs assume, a credential setup they never used, a cloud console that changed. To test, install the version on the npm `latest` tag, which the tutorial's install command gets, and follow the tutorial for your cloud from a new project, with a test key on Sepolia:

- AWS KMS: [Deploy a Hardhat contract to Sepolia with AWS KMS](../tutorials/first-deploy-aws.md)
- Google Cloud KMS: [Deploy a Hardhat contract to Sepolia with Google Cloud KMS](../tutorials/first-deploy-gcp.md)
- Azure Key Vault: [Deploy a Hardhat contract to Sepolia with Azure Key Vault](../tutorials/first-deploy-azure.md)

Then open an issue with the [Tester report form](https://github.com/aelmanaa/hardhat-kms/issues/new?template=tester-report.yml), also when every step worked. The form asks for:

- the cloud you tested;
- whether you finished the tutorial;
- the hardhat-kms and provider package versions, and the Hardhat, Node.js and package manager versions. `npm ls hardhat hardhat-kms @hardhat-kms/aws @hardhat-kms/gcp @hardhat-kms/azure` (or `pnpm ls` with the same arguments) and `node --version` print them;
- your operating system;
- the step where you got stuck or that confused you, by its heading in the tutorial;
- the command you ran and the full error text.

Never post credentials: access keys, client secrets, service account key files, API keys, or the contents of a `.env` file or the Hardhat keystore. Remove identifiers too. Task output, errors and debug output can contain them. Replace key ids, key ARNs and key resource names, AWS account ids, Google Cloud project ids, Azure tenant, subscription, client and object ids, vault names, Etherscan API keys, and RPC URLs that contain an API key with a placeholder such as `<KEY_ARN>`. Sepolia addresses and transaction hashes are public; keep them, they help reproduce the problem.

The maintainers reply to each report within a week. A docs problem is fixed on `main`; a problem in the packages is fixed in a new release, which you can test again. If you agree, the 1.0.0 release notes thank you by your GitHub username.
