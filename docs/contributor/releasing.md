# Releasing

Audience: A maintainer cutting a release, or reading what happened to one. Assumes the setup in [CONTRIBUTING.md](../../CONTRIBUTING.md) and a hardware key that signs git tags.

Status: the trust root (`.github/release-keys/`), `scripts/verify-release-tag.ts`, the `Changeset` check on pull requests, the 0.8.0 base version, the registry mode of the package checks (`--from-registry`, `scripts/check-registry-release.ts`, rehearsed against a local verdaccio by `registry-mode.yml`) exist. The three workflows this page names, `release-pr.yml`, `release.yml` and `promote.yml`, and the two GitHub environments are the design of [#47](https://github.com/aelmanaa/hardhat-kms/issues/47); until they merge, no release can be cut, and the steps below describe the design they implement. Nothing has been published yet. [Decision 0016](decisions/0016-release-process.md) records why the process has this shape.

The model in one sentence: every version is a stable semver string, built from a maintainer-signed `vX.Y.Z` tag, staged to npm under the `beta` dist-tag, approved on npmjs.com, verified from the registry, and promoted to `latest` by moving the dist-tag on that exact version. Nothing is rebuilt between `beta` and `latest`: same tarballs, same provenance. The four packages (`hardhat-kms`, `@hardhat-kms/aws`, `@hardhat-kms/gcp`, `@hardhat-kms/azure`) are one changesets `fixed` group and always carry the same version.

## 1. Who can release

A release starts from a `vX.Y.Z` tag signed by a key in `.github/release-keys/`. That directory is the trust root: one armored OpenPGP public key per maintainer, named `<github-login>.asc`. Anyone whose key is there can cut a release; nobody else can, whatever their repository permissions, because the release workflow verifies the tag signature against those files before it builds anything.

Adding a maintainer is a reviewed pull request that commits their public key and nothing else, with the fingerprint in the pull request body; the reviewer checks it against the key GitHub serves for that account. Removing one is the reverse. The steps are in the [release keys README](../../.github/release-keys/README.md).

Signing setup, once per maintainer:

```sh
git config --global tag.gpgsign true
gpg --armor --export <fingerprint> | gh gpg-key add -
```

The key's user id must carry the same email as `user.email`, and that address must be verified on the GitHub account. Otherwise the signature is valid, the workflow accepts it, and GitHub still renders the tag as Unverified.

Merging the Version Packages pull request publishes nothing. Only the signed tag does, so a maintainer without a key can merge it and leave the tag to one who has.

## 2. Preflight

Before merging the Version Packages pull request:

- `main` is green, and the commit the tag will point at has a passing `ci.yml` run and a passing `ci-all-os.yml` run. Not every commit on `main` gets the macOS and Windows run; the release workflow dispatches one when the nightly skipped the commit, so this is a check, not a task.
- The deprecation audit, on the release commit, one issue per finding. The automated checks do not cover: deprecated paths inside SDK defaults (credential chains, retries, endpoints); vendor notices from AWS, Google Cloud, Azure and Node.js (replaced endpoints, legacy models, changed recommendations); packages deprecated on npm since the lockfile was last resolved (`npm view <pkg>@<version> deprecated`); the `aws`, `gcloud` and `az` flags the docs use, against each CLI's `--help`; the Node.js lines in the [Support page](../user/reference/support.md), against the Node.js release schedule.
- For a minor or a major: someone who did not write the changes follows every tutorial and guide from scratch and files one issue per gap. A fork rehearsal is enough before 1.0; a live run from then on.
- The live suite at the release commit, in the mode the live rule of [Verify and promote](#4-verify-and-promote) requires: on Sepolia (`HARDHAT_KMS_LIVE_NETWORK=sepolia pnpm run test:live`) with `test/live/proof.json` committed through a pull request so that [docs/live-proof.md](../live-proof.md) is current, or in fork mode (`pnpm run test:live`).
- The Version Packages pull request itself is the release review: the version in its title, the four changelog entries, the lockfile and the examples' dependency ranges. Never edit its branch by hand; the action resets it on every push to `main`. An intro paragraph for a release is a headline changeset on `hardhat-kms`, merged like any other.

Why the manifests read `0.8.0` before the first release: `changeset version` applies plain semver to the current version, and the highest bump in the fixed group wins, so a `minor` on 0.8.0 computes 0.9.0, the first published version. 0.8.0 is never published: no `v0.8.0` tag is pushed, and `scripts/verify-release-tag.ts` refuses a tag whose version differs from the manifests ([#284](https://github.com/aelmanaa/hardhat-kms/issues/284)).

## 3. Cut a release

1. On the Version Packages pull request, click "Approve workflows to run". The pull request comes from `release-pr.yml` with the default `GITHUB_TOKEN`, so its checks wait for that click.
2. Read it: the version in the title, the four changelog entries, the lockfile and the examples' dependency ranges.
3. Squash-merge it.
4. Copy the merge commit SHA from the merged pull request.
5. Tag the merge commit on your machine. Always pass the SHA: a bare `git tag -s` tags whatever is checked out.

   ```sh
   git fetch origin main
   git tag -s v1.2.0 -m v1.2.0 <merge-sha>
   git verify-tag v1.2.0
   node scripts/verify-release-tag.ts v1.2.0
   ```

   `git verify-tag` checks the signature against your keyring and prints `Good signature from <your user id>`. The script checks what the workflow checks: the signature against `.github/release-keys/` in a throwaway `GNUPGHOME`, the tag name against the four manifests at that commit, no `-` in the version, and the commit reachable from `origin/main`. It prints one line:

   ```text
   v1.2.0 passes: signed by <name> <email> (<fingerprint>), version 1.2.0 in 4 manifests, commit <merge-sha> on origin/main
   ```

   On a failure the line starts with `v1.2.0 fails:` and names the check. Do not push a tag that fails; delete it with `git tag -d v1.2.0` and fix the cause.

6. Push the tag: `git push origin v1.2.0`. The push starts `release.yml` (tag pattern `v[0-9]*.[0-9]*.[0-9]*`).
7. Wait for `verify-tag`, `gate-ci` and `pack` to go green.
8. Read the publish plan and the four tarball file lists in the step summary. From the second release on, the summary also diffs each file list against the tarball on `latest`. Stop if a file list holds a surprise: nothing has reached npm yet, and [Run failed before `publish`](#run-failed-before-publish) applies.
9. Approve the `npm-publish` environment. The `publish` job stages the four packages with `npm stage publish --tag beta`, over OIDC, with provenance. Whether the `beta` dist-tag came from that flag or was set by `promote.yml` afterwards gets recorded here after the 0.9.0 publish.
10. On npmjs.com, inspect the four staged packages and approve them with WebAuthn. Only now do the packages exist on the registry; `beta` points at the version, and `release.yml` creates the GitHub Release `vX.Y.Z` as a draft with the prerelease flag.

Three actions by a maintainer per release (sign, approve the environment, approve the stage) and none by anyone else. Pushing a tag that is already on the remote, unchanged, starts nothing.

First publish of a new package. A trusted-publisher configuration lives in a package's settings on npmjs.com, so it cannot exist before the package does. The first publish of a new package (the four in 0.9.0, or any package added later) therefore uses a token, once. In time order:

1. Minutes before the tag is pushed, create a granular access token on the publishing account: read and write, stage only, limited to the `hardhat-kms` organisation scope and, if the form accepts a package that does not exist yet, `hardhat-kms`; expiry one day; two-factor bypass on, because the run is unattended.
2. Store it as the secret `NPM_FIRST_PUBLISH_TOKEN` on the `npm-publish` environment. The `publish` job writes it to the job's `.npmrc` when the secret is set and publishes over OIDC otherwise; `id-token: write` stays on the job in both cases, because provenance needs it even with a token, and `--provenance` is passed.
3. Cut the release as above. Staging a package that does not exist first publishes a public placeholder version `0.0.0-stage`. If the registry refuses `hardhat-kms` as too similar to an existing name, it does so here: stop, do not approve the three scoped packages, and use the fallback name `@hardhat-kms/core` through a rename pull request and a new tag.
4. After the approval on npmjs.com, run `npm view <pkg> versions` for the four packages. If `0.0.0-stage` is still listed, deprecate it: `npm deprecate <pkg>@0.0.0-stage "placeholder; use 0.9.0"`. What the registry did with the placeholder for 0.9.0 is recorded here after that publish.
5. Within 48 hours of the approval, in one sitting: revoke the token and delete the environment secret.
6. In the same sitting, create two trusted-publisher configurations per package: one for `release.yml` on the `npm-publish` environment (stage only, the default for configurations created since 2026-09-03) and one for `promote.yml` on the `npm-latest` environment (allow dist-tag, no publish).
7. Set each package to "Require two-factor authentication and disallow tokens".
8. Push the next tag inside 48 hours of step 6: a configuration that has not completed a publish within 48 hours expires. If that is not possible, delete the configurations and create them again on the day of that tag.

The token step in `release.yml` is removed in the pull request that closes the 0.9.0 publish. From then on no workflow reads a secret, and the first publish of each package is the only one that ever held a token.

## 4. Verify and promote

`promote.yml` is a `workflow_dispatch` with three inputs: `version` (exact, no `v`), `target` (`verify` or `latest`) and `live-run` (`sepolia:<proof commit>`, `fork` or `none`). It runs on Linux and holds no secret; only its last step has `id-token: write`.

1. Run it with `target: verify`. It runs `scripts/check-registry-release.ts <version>` first (`beta` equals the version, the four packages have it, it is not below `latest`, it has no `-`, `npm audit signatures` reports four attestations, `gitHead` equals the tag commit), then the package checks, the consumer typecheck and the peer-install matrix with `--from-registry`, and the examples from the registry against LocalStack. These are the scripts `pnpm run test:registry-mode` rehearses against a local verdaccio, described in [Testing](testing.md#testing-strategy), and the only part of the promotion a maintainer can run today. Green publishes the draft GitHub Release with the prerelease flag on: the beta is now announced.
2. Choose `live-run` by the live rule. `target: latest` requires `live-run: sepolia:<proof commit>` for a minor, a major, or a patch whose changelog entry touches signing or sending; `fork` or `none` is accepted only for other patches, and the workflow refuses `none` on a minor or a major. Which patches touch signing or sending is the maintainer's call, recorded in the input. Until the live suite runs in Actions, both modes are run by the maintainer on their machine at the tag commit.
3. Wait 24 hours if pnpm testers are expected: pnpm 11 and 12 hold back versions younger than that unless the project lists the packages in `minimumReleaseAgeExclude`.
4. Run it with `target: latest`. It repeats the checks on the same version, then, after approval of the `npm-latest` environment, runs `npm dist-tag add <pkg>@<version> latest` for the four packages and `gh release edit v<version> --draft=false --prerelease=false --latest`. If the registry refuses the dist-tag move over OIDC, run the four `npm dist-tag add` commands from your machine with 2FA and re-run the workflow, which finds `latest` already moved and only edits the release.

Either target posts one comment on the merged Version Packages pull request with the step summary and the run link, and the `live-run` value is in it. That comment is the record of the release.

The first version of a package lands on `latest` whatever is asked, because the registry has nothing else to point at. For 0.9.0, `target: latest` is therefore not run; the release is published with `gh release edit v0.9.0 --draft=false --prerelease=false --latest` after `verify` is green. The [acceptance test](https://github.com/aelmanaa/hardhat-kms/issues/294) then runs against 0.9.0 from the registry, and only a version that passes it gets the 1.0.0 tag.

## 5. Hotfix on an older line

1. Branch `v1.x` from the last tag of that line.
2. Cherry-pick the fix with its changeset onto the branch.
3. Run `pnpm run version-packages` on the branch and commit the result.
4. Follow [Cut a release](#3-cut-a-release) from the branch, with the tag signed at the branch commit.

One gap to close before the first hotfix line: `scripts/verify-release-tag.ts` accepts only a commit reachable from `origin/main` (its `--main` option names the ref), so the release workflow has to pass the release branch for a tag on it. The promote workflow refuses to move `latest` backwards, so once a newer major exists the GitHub Release is created with `--latest=false` and the dist-tag the version is moved to is `previous`, never `latest`.

## 6. Bad release runbook

Versions on npm are immutable. Every entry below ends in a new version number, never in a rerun that republishes the same one.

### Bad beta, not promoted

Ship the fix as the next version through the full flow; the `beta` dist-tag moves forward. Deprecate the bad version on all four packages, `npm deprecate <pkg>@<bad> "<reason>; use <next>"`, and add the note to its GitHub Release. No unpublish.

### Bad `latest`

1. Ship a clean patch through the full flow and promote it.
2. Deprecate the bad version on all four packages with the message above.
3. Open a GitHub security advisory if keys, signatures or secrets were affected. The advisory names the affected range, and so does the patch's changeset.
4. Never move `latest` backwards: the promote workflow refuses it, and lockfiles already hold the bad version, so a backwards tag fixes nobody.
5. Unpublish only within 72 hours of the publish and only if nothing depends on the version; otherwise deprecate.

### Staged but wrong

Reject the stage on npmjs.com. Whether the registry frees the version number after a rejected stage is not documented, so treat the number as used and ship the next patch.

### Partial approval

Some of the four packages were approved and some were not. Either approve the rest, or deprecate the approved ones and ship the next patch. The group never stays mixed: the providers pin the core to the exact version, so a user who installs a mixed group fails the peer-dependency check, at install or at first use depending on the package manager.

### Run failed before `publish`

Nothing reached npm, so the tag can move. Fix through a pull request, merge, delete the remote tag (the `v*` tag ruleset lets only the repository owner delete one), re-sign at the new commit, verify, push:

```sh
git push origin :refs/tags/v1.2.0
git tag -d v1.2.0
git fetch origin main
git tag -s v1.2.0 -m v1.2.0 <fixed-sha>
git verify-tag v1.2.0
git push origin v1.2.0
```

Re-create the tag with `-s`, as above. `git tag -f` with `--no-sign`, or with `-a` or `-m` on a machine where `tag.gpgsign` is unset, replaces the signed tag with an unsigned annotated one, which the script refuses with `tag v1.2.0 is annotated but has no OpenPGP signature; re-create it with git tag -s`. Once anything reached npm, the tag is frozen and the fix is a new version.

### Run failed after `publish`

The packages are staged or published; the GitHub Release step failed. Do not re-run the whole workflow. Check the registry state with `npm view <pkg> dist-tags` and `npm view <pkg> versions`, then re-run only the `github-release` job, which calls `gh release view` first so it never creates a duplicate.

### Wrong tag pushed

Delete it as in [Run failed before `publish`](#run-failed-before-publish), re-sign the right commit, push.

### Trusted-publisher configuration expired

A configuration that completed no publish within 48 hours of its creation has expired, and the `publish` job cannot exchange its OIDC token for a publish. Delete the expired configurations on npmjs.com and create them again on the day of the tag.

Moving a tag is only safe while the release is still failing. Once a version is on npm, the tag is what provenance and downstream pins point at, and it never moves.

## 7. A future major

A major is prepared on a `next` branch in changesets pre mode (`changeset pre enter next`, `baseBranch: next` in that branch's config) and published from `v2.0.0-next.*` tags by a `release-next.yml` with the inverse rule of `release.yml`: the version must contain `-next.`, and the dist-tag is `next`. Promotion is `changeset pre exit`, a merge to `main`, and the normal flow from section 3. Pre mode is never entered on `main`: it blocks `latest` until exit, and a prerelease string promoted by `dist-tag add` is invisible to `^1.0.0` ranges. The detail gets its own issue when the first major is planned.

## 8. Rules for coding agents

Also in [AGENTS.md](../../AGENTS.md):

- Never tag, publish, approve an environment or a stage, or move a dist-tag. Those are maintainer actions on a hardware key or a WebAuthn device.
- Versions change only through `pnpm run version-packages`, on the Version Packages pull request. Never edit a manifest's `version` by hand.
- Every user-facing change carries a changeset written as a release note, to the rules in [CONTRIBUTING.md](../../CONTRIBUTING.md#changesets).
