# 0016: Release from a signed tag, stage to `beta`, promote by dist-tag

Status: Accepted (2026-10-06)

Issue: [#47](https://github.com/aelmanaa/hardhat-kms/issues/47), [#285](https://github.com/aelmanaa/hardhat-kms/issues/285)

## Context

The packages sign transactions with production keys, so a malicious or broken version does more damage than a broken build tool: it can sign the wrong thing with a real key. A release must be something only a maintainer can start, that CI alone can never finish, that a user can verify from the registry, and that never puts a prerelease or an untested version on `latest`.

The project has one maintainer, who signs git tags with a hardware key. CI minutes are free on a public repository and paid on a private one, and macOS and Windows runs are the expensive part. The four packages are one changesets `fixed` group at one version, and the providers pin the core to the exact version, so a release is always four packages or none.

npm's trusted publishing (OIDC) removes long-lived tokens, and its staged publishing (npm 11.15.0; trusted-publisher configurations created since 2026-09-03 allow a staged publish by default and a direct publish only when opted in) holds a publish in a queue until an account approves it with two-factor authentication. A trusted-publisher configuration lives in the package's settings and cannot be created before the package exists. Changesets pre mode, the usual way to publish betas, blocks `latest` on the branch it runs on and produces version strings such as `1.2.0-beta.3` that `^1.0.0` ranges never match.

## Decision

Six choices, applied in sections 1 to 4 of [Releasing](../releasing.md):

1. Betas are stable version strings published under the `beta` dist-tag and promoted to `latest` by moving the dist-tag on that exact version. Nothing is rebuilt between the two. Pre mode is reserved for a future major on a `next` branch.
2. The trigger is one maintainer-signed `vX.Y.Z` tag at the merge commit of the Version Packages pull request, created on the maintainer's machine and verified in CI against the public keys committed in `.github/release-keys/`. CI creates no tags.
3. Publishing is staged: the workflow stages the four tarballs and a maintainer inspects and approves them on npmjs.com. A compromised run or GitHub account can place a version in the queue and nothing more.
4. The maintainer is the required reviewer on both GitHub environments, `npm-publish` and `npm-latest`. The environment approval binds the OIDC token to a run the maintainer saw, and each trusted-publisher configuration pins that environment.
5. The first published version is 0.9.0, the acceptance run of the whole pipeline. A 0.9.x that passes the acceptance test from the registry becomes 1.0.0 with only the version numbers and the changelog changed. 1.0.0 is not published first because a failure would burn the 1.0.0 number, and a prerelease is not published first because the registry puts the first version of a package on `latest` whatever is asked.
6. The live suite runs on Sepolia before every minor and major and before any patch that touches signing or sending; other patches run it in fork mode or not at all. The promote workflow refuses to move `latest` on a minor or major without a Sepolia proof.

## Consequences

Every beta costs a maintainer three actions (sign the tag, approve the environment, approve the stage) and every promotion one. No prerelease string ever appears on the stable line, so `npm update` finds every promoted version. No workflow holds a secret, with one exception: the first publish of a package is token-based, because the trusted publisher cannot be configured before the package exists; everything after it is token-less. The tarball publish is done by the workflow, not by `changeset publish`, so that the file lists can be reviewed before the stage.

Harder: a second maintainer must own a hardware key and have an npm account that can approve stages. The four packages are published together or not at all, so a provider-only fix still bumps the core. Versions are immutable on npm, so every failed release ends in a new version number, and a rejected stage is treated the same way: the registry does not document whether a rejection frees the number, so the next release takes the next patch.

What would make us revisit it: a second maintainer, which changes who approves what; npm changing the stage or trusted-publishing defaults; a first-publish token that cannot be scoped tightly enough; or the pipeline's cost on a private repository, should the repository become private again.

## Evidence

The `gate-ci` job of `release.yml` keeps an untested version off npm: since [#332](https://github.com/aelmanaa/hardhat-kms/issues/332) it publishes only when the tagged commit has passing runs of four workflows, `ci.yml`, `ci-all-os.yml`, `hardhat-versions.yml` and `sdk-floors.yml`, and dispatches each of the last three on the tag when the commit has none. Pull-request runs never count. See [Releasing](../releasing.md), step 7 of section 3.

0.9.0 was staged on 2026-10-08 with a one-day token, as the Consequences section expects; the token was then revoked and the token step removed from `release.yml` ([#47](https://github.com/aelmanaa/hardhat-kms/issues/47)), so from 0.9.1 on no workflow reads a secret. What the first publish taught is in [Releasing](../releasing.md#first-publish-090-2026-10-08).

Choice 5's "only the version numbers and the changelog changed" was clarified by the maintainer before 0.9.0: between the passing 0.9.x and 1.0.0, nothing changes in `src/`, `dist/` or the manifests except `version`; READMEs and changelogs may change, so the README status lines can follow each 0.9.x.
