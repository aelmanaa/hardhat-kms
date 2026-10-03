# Install before the first npm release

<!--
Pre-release only. The release PR (#47) deletes this page, its lines in docs/README.md and AGENTS.md,
and the sentences that link here from README.md, the three tutorials, the three setup guides and
the configuration reference (search for install-before-release.md).
-->

Audience: people who try hardhat-kms before its first npm release. The repository is private until it goes public ([#48](https://github.com/aelmanaa/hardhat-kms/issues/48)), so this path needs read access to it.

Status: `hardhat-kms` and the `@hardhat-kms/*` packages are not on npm yet, and `npm install hardhat-kms` fails with `E404`. Until the first release ([#47](https://github.com/aelmanaa/hardhat-kms/issues/47)), build the packages from a clone, pack them and install the packed files. This page goes away with that release.

You need:

- Node.js 22.18 or later to build. The repository's scripts and hooks are TypeScript files that run with plain `node`, which works without a flag from [Node.js 22.18.0](https://nodejs.org/en/blog/release/v22.18.0). On an older Node.js, `pnpm install` stops with `ERR_PNPM_BAD_RUNTIME_VERSION`. With nvm, `nvm use` in the clone picks the version in `.nvmrc`.
- pnpm 12, for the build only. The repository pins pnpm 12.8.1 in `packageManager`. Run `corepack enable`, which comes with Node.js 22 and 24, or `npm install -g pnpm@12.8.1`.

Your Hardhat project does not need either: the installed packages run on Node.js 22.13 or later, with npm or pnpm.

## 1. Build the packages

```sh
git clone https://github.com/aelmanaa/hardhat-kms.git
cd hardhat-kms
pnpm install
pnpm build
```

## 2. Pack the core and your provider

Run `pnpm pack` in `packages/hardhat-kms` and in the provider's package: `packages/hardhat-kms-aws`, `packages/hardhat-kms-gcp` or `packages/hardhat-kms-azure`. For AWS KMS:

```sh
(cd packages/hardhat-kms && pnpm pack)
(cd packages/hardhat-kms-aws && pnpm pack)
```

Each command writes a `.tgz` file into its package directory: `packages/hardhat-kms/hardhat-kms-0.0.0.tgz` and `packages/hardhat-kms-aws/hardhat-kms-aws-0.0.0.tgz`. The `0.0.0` comes from each `package.json`. The provider's file name has no `@` or `/`, although the package inside is `@hardhat-kms/aws`.

## 3. Install the packed files in your project

Copy the two files into your Hardhat project, then install them by path. The install records the path in `package.json`, so a copy inside the project keeps working after the clone moves or is deleted:

```sh
mkdir -p vendor
cp <clone>/packages/hardhat-kms/hardhat-kms-0.0.0.tgz <clone>/packages/hardhat-kms-aws/hardhat-kms-aws-0.0.0.tgz vendor/
npm install --save-dev ./vendor/hardhat-kms-0.0.0.tgz ./vendor/hardhat-kms-aws-0.0.0.tgz
```

In a pnpm project:

```sh
pnpm add -D ./vendor/hardhat-kms-0.0.0.tgz ./vendor/hardhat-kms-aws-0.0.0.tgz
```

If pnpm stops with `Ignored build scripts: esbuild`, add `allowBuilds:` with `esbuild: false` to `pnpm-workspace.yaml` and install again. Step 4 of [First deploy on Sepolia with AWS KMS](../tutorials/first-deploy-aws.md#4-add-the-plugin-and-the-key-to-the-project) explains why that script is not needed.

`npx hardhat kms --help` then lists the plugin's tasks. Go back to the page you came from and continue after its install command.
