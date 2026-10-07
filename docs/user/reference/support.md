# Support

Audience: Users choosing a Node.js version for a project that uses the published packages, deciding when to upgrade it, or looking for where to ask a question.

The published packages run on Node.js 22.13.0 or later, the minimum Hardhat 3 enforces ([Node.js support](https://hardhat.org/docs/reference/nodejs-support)). Each package declares it in `engines.node`. The supported lines are the ones Hardhat tests that have not reached end of life in the [Node.js release schedule](https://github.com/nodejs/Release#release-schedule): today Node.js 22, 24 and 26. CI runs the test suite on the lowest version of each line (22.13.0, 24.0.0 and 26.0.0) on Linux and on 22.13.0 on macOS and Windows, the same Node.js versions Hardhat tests. A line that has reached end of life, or is not in that list, is unsupported.

Once a line reaches end of life, a minor release may drop it, never earlier. A pinned issue announces the drop when the line reaches end of life, and the changeset names the dropped line and the last version that ran on it. There is no maintenance branch: fixes are not backported to that version. The reason is that these packages sign with production keys, and an end-of-life line [receives no security fixes from the Node.js project](https://nodejs.org/en/about/eol), including to the TLS stack the cloud SDKs use to reach the KMS. Node.js 22 reaches end of life on 2027-04-30; the schedule can move that date.

The minimum can rise without a release of these packages. Hardhat checks its own minimum at startup and has raised it in a patch release before: 3.4.3 moved it from 22.10.0 to 22.13.0. The cloud SDKs the provider packages depend on can drop an end-of-life line inside the version ranges these packages declare. When either happens, the next minor release raises `engines.node` to match and the changeset says so.

On an older Node.js, `npm install` prints an `EBADENGINE` warning (an error with `engine-strict`); `pnpm install` installs without a message unless `engineStrict` is set, then it fails with `ERR_PNPM_UNSUPPORTED_ENGINE`. In both cases `npx hardhat` exits with an error naming the minimum version before any task runs.

The Hardhat and viem ranges, the release channels and how long a previous major gets security fixes are in [Release channels and versioning](../explanation/versioning.md).

## Questions

Start with the [docs index](../../README.md): it lists every tutorial, guide and reference page, and the [errors reference](errors.md) explains each error message. If the docs do not answer the question, open an issue with the Question form, which adds the `question` label. Once GitHub Discussions are enabled for the repository, questions move there and this section links them. Report a vulnerability privately as [SECURITY.md](../../../SECURITY.md) says, never in an issue.
