# Release channels and versioning

Audience: users choosing which version of hardhat-kms and a provider package to install, and plugin authors who build on its exported types. Explains what a version number promises, what the `latest` and `beta` tags mean, which Hardhat, Node.js and viem versions a release supports, and how long an old major gets security fixes.

The four packages, `hardhat-kms`, `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure`, are released together at one version. A provider package pins the core to that exact version, so a project always has all of its hardhat-kms packages at one version. The first published version is 0.9.0, the candidate for 1.0.0; until 1.0.0 is out, use it with test keys on testnets.

## Semver and the public API

Versions follow [semantic versioning](https://semver.org). The public API, which only a major release may break, is:

- The config keys described in the [configuration reference](../reference/configuration.md).
- The task names and their flags in the [tasks reference](../reference/tasks.md).
- The error codes in the [errors reference](../reference/errors.md).
- The account that `connection.kms.getAccount` returns, described in [Library accounts](../reference/library-accounts.md).
- The provider interface for plugin authors, as the [API reference](../reference/api/README.md) documents it.

Anything the API reference marks `Experimental`, such as the `hardhat-kms/provider-utils` module, is outside the public API and may change in a minor.

A major release removes or renames any of these, or drops a Hardhat major. A minor adds to the API, raises a floor as the rules below allow, or deprecates something. A patch fixes a bug without changing the API.

## Channels

Two npm dist-tags, `latest` and `beta`, point only at stable version strings: no `-beta.1` or `-rc.1` ever sits on either tag.

`latest` is the version the maintainers promoted after installing it from the registry into a fresh project and running the release checks against it. `npm install` without a tag gives you this one.

`beta` is the newest published version, which may not have been promoted yet. When nothing is waiting for promotion, `beta` and `latest` point at the same version.

A version on `beta` was built from a signed tag on `main`, passed the full test suite on Linux, macOS and Windows, and carries a provenance attestation. It was not yet installed and tested from the registry, and it may be deprecated instead of promoted if that test finds a problem. Use test keys and testnets with a beta.

Promotion moves the `latest` tag onto the version already on `beta`. Nothing is rebuilt: the tarball and its attestation are the same on both tags.

## Install a channel

The default install takes `latest`:

```sh
npm install --save-dev hardhat-kms @hardhat-kms/aws
```

To test a version before it is promoted, install both packages from `beta`. `@hardhat-kms/gcp` and `@hardhat-kms/azure` install the same way.

```sh
npm install --save-dev hardhat-kms@beta @hardhat-kms/aws@beta
```

pnpm 11 and 12 hold back a version published less than 24 hours ago (the `minimumReleaseAge` setting). With pnpm's defaults the hold is not strict: when no older version matches, as with `hardhat-kms@beta`, pnpm installs the young one anyway. A project that sets `minimumReleaseAge` itself is strict and refuses it. In that project, exempt the packages in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - hardhat-kms
  - "@hardhat-kms/*"
```

## Support

### Node.js

The Node.js policy is in the [Support reference](../reference/support.md): which lines are supported, which versions CI runs, and when a line is dropped.

### Hardhat

Each package declares a caret range on Hardhat 3, `^3.<floor>.0`. Within a plugin major:

- The floor is raised only in a minor, and the changelog entry names the new floor.
- A new Hardhat minor needs no release of these packages: the caret range already allows it.

A new Hardhat major means a new plugin major. Releases of the old line stay on npm and install by exact version; the new major's changelog entry names the last version that supports the old Hardhat major.

CI runs the full test suite on the Hardhat version in the lockfile. A weekly job runs the transaction-filling and network-hook tests on two versions: the floor of the range, and the newest Hardhat 3 release that is at least a day old. A younger release waits for the next weekly run.

### Compatibility table

One row per plugin major, with the ranges the package manifests declare at that major's current release.

| Plugin   | Hardhat   | Node.js     | viem (optional peer of `hardhat-kms`) |
| -------- | --------- | ----------- | ------------------------------------- |
| 0.9, 1.x | `^3.18.0` | `>=22.13.0` | `^2.55.13`                            |

viem is needed only by `connection.kms.getAccount`; the plugin signs through Hardhat's network connection without it. [Library accounts](../reference/library-accounts.md#package-managers-and-the-peer-ranges) shows what each package manager does when a project asks for a viem outside the range.

### Previous major

After a new major is promoted to `latest`, the previous major gets security fixes for 12 months from that promotion, as patch releases of its last minor. A security fix closes a vulnerability reported under [SECURITY.md](../../../SECURITY.md) or an advisory in a dependency these packages ship. Such a patch may raise `engines.node` when the fix needs a newer Node.js, and its changelog entry says so. The previous major gets no new features and no Hardhat floor change. After 12 months it gets nothing, and only the current major is supported.

## Deprecation

A removal is announced before it happens. A minor marks the config key, flag, task or export as deprecated and names the replacement in its changelog entry; the next major removes it, again with a changelog entry. Nothing is removed without a deprecation in an earlier minor.

A published version that must not be used, such as a beta that failed the registry test, is deprecated on npm. `npm install` prints the deprecation message, which names the version to use instead.

## Verify what you installed

Every version is published with a provenance attestation that links it to the GitHub Actions run and the commit it was built from. In a project, `npm audit signatures` reports the four packages with verified attestations. Do not use a version that fails that check; report it as described in [SECURITY.md](../../../SECURITY.md). The README's [Verify a release](../../../README.md#verify-a-release) section has the same check.
