---
title: Install hardhat-kms
description: Install hardhat-kms and a provider package with npm, pnpm or Yarn, register the plugin in hardhat.config.ts and check that Hardhat lists its tasks.
---

# Install hardhat-kms

Audience: people adding hardhat-kms to a Hardhat 3 project.

hardhat-kms is two packages: the core, `hardhat-kms`, and the provider package for the cloud that holds your key. Install both at the same version:

| Cloud                          | Provider package     | Plugin export     |
| ------------------------------ | -------------------- | ----------------- |
| AWS KMS                        | `@hardhat-kms/aws`   | `hardhatKmsAws`   |
| Google Cloud KMS               | `@hardhat-kms/gcp`   | `hardhatKmsGcp`   |
| Azure Key Vault or Managed HSM | `@hardhat-kms/azure` | `hardhatKmsAzure` |

The packages support Hardhat ^3.18.0 and the Node.js versions in [Support](../reference/support.md). If you have no Hardhat 3 project yet, `npx hardhat --init` creates one.

## 1. Install the packages

The commands below install the AWS provider. For another cloud, replace `@hardhat-kms/aws` with the package from the table.

::: code-group

```sh [npm]
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws
```

```sh [pnpm]
pnpm add --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws
```

```sh [Yarn]
yarn add --dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws
```

:::

The command names `hardhat` because the plugin packages list it as a peer dependency, and Yarn does not install peers. It also raises an older Hardhat 3 to 3.18. `connection.kms.getAccount` needs `viem` ^2.55.13 as well; ethers and Ignition projects can skip it ([Library accounts](../reference/library-accounts.md#package-managers-and-the-peer-ranges)).

### npm

npm needs no settings. npm 11 warns that `esbuild`, and `protobufjs` with Google Cloud, have install scripts "not yet covered by allowScripts". npm 12 blocks those scripts and lists the packages: `esbuild`, `protobufjs` with Google Cloud, and `fsevents` on macOS. The plugin needs none of them, so leave them blocked.

### pnpm

pnpm 11 and later stop with `ERR_PNPM_IGNORED_BUILDS` because two dependencies have install scripts: `esbuild`, which Hardhat depends on, and `protobufjs`, which the Google Cloud SDK depends on. The packages are installed, but the command exits with an error. Neither script is needed: esbuild's script checks its platform binary, and protobufjs's script prints a warning. Add this to `pnpm-workspace.yaml`, next to `package.json`, then run `pnpm install`:

```yaml
allowBuilds:
  esbuild: false
  protobufjs: false # Google Cloud only
```

pnpm 10 prints the same list as a warning and installs; it needs no change.

pnpm 11 and later also write the new packages into `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` when they were published less than a day ago. Those lines only let that version past pnpm's release-age check; you can keep or delete them.

### Yarn

Yarn 1 needs no settings.

Yarn 4 needs `nodeLinker: node-modules` in `.yarnrc.yml`, next to `package.json`, before the install. Hardhat does not run under Plug'n'Play, Yarn 4's default linker: under it, `yarn hardhat` stops with `HHE22` ("Trying to use a non-local installation of Hardhat").

```yaml
nodeLinker: node-modules
```

From Yarn 4.15, Yarn skips versions published less than a day ago (`npmMinimalAgeGate`, 1440 minutes by default). On the day of a release, the install then fails with `YN0016` ("The version for tag "latest" is quarantined"). Add this line to `.yarnrc.yml` too, and delete it after a day. Yarn 4.10 to 4.14 accept it but do not need it; Yarn 4.9 and earlier refuse it as an unknown setting.

```yaml
npmPreapprovedPackages: ["hardhat-kms", "@hardhat-kms/*"]
```

Yarn 4.14 and later run no install scripts by default and print `YN0004` for `esbuild` and `protobufjs`; the plugin needs neither.

`@hardhat-kms/gcp`: Yarn 1 and pnpm 10 can install the deprecated `google-gax` 6.11.0; [Set up a Google Cloud KMS key](gcp-kms-setup.md#3-install-the-plugin-and-configure-the-key) says how to check and how to override it.

## 2. Register the plugin

Add the provider package to `plugins` in `hardhat.config.ts`. It loads `hardhat-kms` itself:

::: code-group

```ts [AWS KMS]
import { defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
});
```

```ts [Google Cloud KMS]
import { defineConfig } from "hardhat/config";
import hardhatKmsGcp from "@hardhat-kms/gcp";

export default defineConfig({
  plugins: [hardhatKmsGcp],
});
```

```ts [Azure Key Vault]
import { defineConfig } from "hardhat/config";
import hardhatKmsAzure from "@hardhat-kms/azure";

export default defineConfig({
  plugins: [hardhatKmsAzure],
});
```

:::

In a project from `npx hardhat --init`, add the import and append the plugin to the existing `plugins` list.

## 3. Check the install

::: code-group

```sh [npm]
npx hardhat kms --help
```

```sh [pnpm]
pnpm hardhat kms --help
```

```sh [Yarn]
yarn hardhat kms --help
```

:::

Hardhat lists the plugin's tasks: `kms accounts`, `kms address`, `kms history`, `kms public-key`, `kms sign`, `kms sign-auth`, `kms sign-tx` and `kms verify`. If it answers `Error HHE404: Task "kms" not found`, the packages are installed but the plugin is not in `plugins`: go back to step 2.

Next, create a key and add it to the config: [Set up an AWS KMS key](aws-kms-setup.md), [Set up a Google Cloud KMS key](gcp-kms-setup.md) or [Set up an Azure Key Vault key](azure-key-vault-setup.md). The [Configuration](../reference/configuration.md) reference lists every option.

## Install a build from the repository

To try a commit that is not on npm, such as a fix on `main`, build the packages from a clone, pack them and install the packed files. For anything else, install from npm.

Building needs:

- Git, to clone the repository.
- Node.js 22.18 or later. The repository's scripts are TypeScript files that run with plain `node`.
- pnpm 12, which the repository pins in `packageManager`. Run `corepack enable`, or `npm install -g pnpm@12.8.1`.

Your Hardhat project needs none of them: it uses the packed files with npm, pnpm or Yarn on the Node.js versions in [Support](../reference/support.md).

```sh
git clone https://github.com/aelmanaa/hardhat-kms.git
cd hardhat-kms
pnpm install
pnpm build
(cd packages/hardhat-kms && pnpm pack)
(cd packages/hardhat-kms-aws && pnpm pack)
```

For another cloud, pack `packages/hardhat-kms-gcp` or `packages/hardhat-kms-azure` instead of `packages/hardhat-kms-aws`. Each `pnpm pack` writes a `.tgz` file into its package directory, named after the package and the version in its `package.json`: `hardhat-kms-<version>.tgz` and `hardhat-kms-aws-<version>.tgz`. The provider's file name has no `@` or `/`.

Copy the two files into your Hardhat project and install them by path. `<clone>` is the path to your clone, and `<version>` the version in the file names. The install records the path in `package.json`, so a copy inside the project keeps working after the clone moves:

::: code-group

```sh [npm]
mkdir -p vendor
cp <clone>/packages/hardhat-kms/hardhat-kms-<version>.tgz <clone>/packages/hardhat-kms-aws/hardhat-kms-aws-<version>.tgz vendor/
npm install --save-dev ./vendor/hardhat-kms-<version>.tgz ./vendor/hardhat-kms-aws-<version>.tgz
```

```sh [pnpm]
mkdir -p vendor
cp <clone>/packages/hardhat-kms/hardhat-kms-<version>.tgz <clone>/packages/hardhat-kms-aws/hardhat-kms-aws-<version>.tgz vendor/
pnpm add --save-dev ./vendor/hardhat-kms-<version>.tgz ./vendor/hardhat-kms-aws-<version>.tgz
```

```sh [Yarn]
mkdir -p vendor
cp <clone>/packages/hardhat-kms/hardhat-kms-<version>.tgz <clone>/packages/hardhat-kms-aws/hardhat-kms-aws-<version>.tgz vendor/
yarn add --dev ./vendor/hardhat-kms-<version>.tgz ./vendor/hardhat-kms-aws-<version>.tgz
```

:::

The [pnpm](#pnpm) and [Yarn](#yarn) notes above apply here too. Then continue at [step 2](#2-register-the-plugin).
