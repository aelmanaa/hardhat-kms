---
title: Verify a release
description: Check that the hardhat-kms packages you installed were built from a signed tag of this repository, with npm audit signatures, provenance and the tarball files.
---

# Verify a release

Audience: users who installed `hardhat-kms` and a provider package from npm and want to confirm, before they sign with a production key, that the packages are the ones this repository's release run built. Assumes a shell with npm 11, `jq`, `curl` and `git`; the tag check also needs `gpg`.

Every release is built and published by a GitHub Actions run of this repository, from a signed `v<version>` tag, with npm provenance. The checks below confirm that the packages you installed are the ones that run built. Run them from one working directory, and replace `<version>` with the installed version, such as `1.0.0`.

## 1. Check the registry signatures and attestations

In your project:

```sh
npm audit signatures
```

```text
audited 412 packages in 3s

412 packages have verified registry signatures

97 packages have verified attestations
(use --json --include-attestations to view attestation details)
```

The counts depend on your project. When a signature or an attestation does not verify, the command names the package and exits with a non-zero code. To list the hardhat-kms packages among the verified attestations:

```sh
npm audit signatures --json --include-attestations | jq -r '.verified[] | select(.name == "hardhat-kms" or (.name | startswith("@hardhat-kms/"))) | "\(.name)@\(.version)"'
```

It prints one line per hardhat-kms package you installed, such as `hardhat-kms@1.0.0` and `@hardhat-kms/aws@1.0.0`, and four lines if you installed all three providers. A hardhat-kms package missing from the list has no provenance attestation. Treat that as a failure.

## 2. Read the provenance

Step 1 checked the signature on the provenance statement; this step reads what the statement says. `npm view hardhat-kms@<version> dist.attestations` prints the attestation entry:

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

The Provenance section of the package page on npmjs.com shows the same statement, with links to the build summary, the source commit and the build file. Find the commit the tag points at in a clone:

```sh
git clone https://github.com/aelmanaa/hardhat-kms.git
git -C hardhat-kms rev-parse 'v<version>^{commit}'
```

The check passes when `repository` is `https://github.com/aelmanaa/hardhat-kms`, `ref` is `refs/tags/v<version>`, `path` is `.github/workflows/release.yml`, and `commit` is the commit `git rev-parse` printed. Any other value is a failure: go to [If a check fails](#if-a-check-fails). A prerelease of a future major, such as `2.0.0-next.0` on the `next` dist-tag, comes from `.github/workflows/release-next.yml` instead.

## 3. Check the tag's signature

This step is optional. First confirm that the maintainer key in the clone is the one GitHub serves for that account. `<login>` is the key's file name in `.github/release-keys/`, without `.asc`. Both commands must print the same fingerprint:

```sh
gpg --show-keys hardhat-kms/.github/release-keys/<login>.asc
curl -fsSL https://github.com/<login>.gpg | gpg --show-keys
```

Then import the key into your keyring and verify the tag:

```sh
gpg --import hardhat-kms/.github/release-keys/<login>.asc
git -C hardhat-kms verify-tag v<version>
```

```text
gpg: Signature made <date>
gpg:                using EDDSA key <fingerprint>
gpg: Good signature from "<name> <email>" [unknown]
gpg: WARNING: This key is not certified with a trusted signature!
gpg:          There is no indication that the signature belongs to the owner.
Primary key fingerprint: <fingerprint>
```

The warning only means you have not certified the key in your own keyring. A `BAD signature`, a missing signature, or a fingerprint other than the one you confirmed is a failure.

## 4. Compare the tarball with the repository

`npm pack hardhat-kms@<version>` downloads `hardhat-kms-<version>.tgz`. This command lists the tarball's files next to the files git tracks under `packages/hardhat-kms` at the tag, filtered by the `files` field of this version's `package.json` (the `grep -E` pattern copies it), and prints nothing when they match:

```bash
diff <(tar -tzf hardhat-kms-<version>.tgz | sed 's|^package/||' | grep -v '^dist/' | sort) <(git -C hardhat-kms ls-tree -r --name-only v<version> -- packages/hardhat-kms | sed 's|^packages/hardhat-kms/||' | grep -E '^(src/|README\.md$|LICENSE$|CHANGELOG\.md$|THIRD_PARTY_NOTICES\.md$|package\.json$)' | grep -v '\.test\.' | sort)
```

`dist/` is build output and is not in git, so the command leaves it out. This one prints nothing when every file under `dist/` is the `.js`, `.d.ts` or source map of a file in `src/`, and every file in `src/` has one:

```bash
diff <(tar -tzf hardhat-kms-<version>.tgz | sed -n 's|^package/dist/||p' | sed -E 's/\.(js|d\.ts)(\.map)?$//' | sort -u) <(tar -tzf hardhat-kms-<version>.tgz | sed -n 's|^package/\(src/.*\)\.ts$|\1|p' | sort)
```

## If a check fails

Do not use that version. Keep or pin the last version that passed, and report the failure privately as [SECURITY.md](../../../SECURITY.md) says, through a [security advisory report](https://github.com/aelmanaa/hardhat-kms/security/advisories/new).

## What provenance proves

The tarball npm serves was built by the named GitHub Actions run of this repository, from the named commit and tag, and has not changed since that run signed it.

It does not prove that the code at that commit is correct or safe to run, that a rebuild gives the same bytes, or that the dependencies your lockfile resolves are the ones the run used. `npm audit signatures` checks each dependency's registry signature, and its attestation when it has one.

[Release channels and versioning](../explanation/versioning.md) explains which version the `latest` and `beta` tags point at.
