# 0024: The docs site root follows npm `latest`, and main's docs are under `next/`

Status: Accepted (2026-10-28), amended 2026-10-29 by [#603](https://github.com/aelmanaa/hardhat-kms/issues/603): docs fixes on `release/X.Y`

Issue: [#581](https://github.com/aelmanaa/hardhat-kms/issues/581)

## Context

`pages.yml` deployed the site from `main` on every push, so a merged feature reached the site before it reached npm `latest`. From 2026-10-21 to the 1.3.0 promotion on 2026-10-27, the site documented `allowRawDigests`, `allowedDelegates` and `kms sign-auth --yes` while `latest` was 1.2.0. A 1.2.0 user who followed it got a config validation error, Hardhat's `Invalid option "--yes"` (HHE504), and a security page that described a terminal prompt 1.2.0 does not show. Turnkey's pages went live a day before the release that shipped it. No page said which version added an option.

GitHub Pages deploys one artifact as the whole site, so two trees have to be built into one artifact by one run. The version on npm `latest` is the source of truth for what users install: it can be moved by `promote.yml` or, when the registry refuses the move over OIDC, by hand ("Bad `latest`" in [Releasing](../releasing.md)).

Other projects take one of three routes. The Foundry book regenerates its reference from nightly. viem's docs live in the main repository, and changesets publishes on every push to main, which keeps the gap short. Hardhat keeps its docs in a separate repository that merges on its own schedule. Node.js (`added: REPLACEME`) and CPython (`versionadded:: next`) mark new APIs with a placeholder that the release replaces.

## Decision

The site root, `https://aelmanaa.github.io/hardhat-kms/`, documents the version on npm `latest` of `hardhat-kms`. `pages.yml` reads it from the registry (`scripts/site-release-tag.ts`), refuses anything that is not `X.Y.Z` and a version with no `vX.Y.Z` tag, and builds the root from a checkout of that tag with the tag's own site code and checks.

The root builds from the tip of `release/X.Y` instead when that branch exists, the tag is its ancestor, and the two differ only under `docs/` (`siteRootRef` in the same script). A docs fix backported there then reaches readers without a release. Any other difference, such as a hotfix's code or version that npm `latest` does not have yet, keeps the root on the tag, and the run's notice says why. [Releasing](../releasing.md#5-hotfix-on-an-older-line) says when to backport a docs fix.

Main's docs are built into `next/` (`DOCS_SITE_CHANNEL=next`, base `/hardhat-kms/next/`). Every page there carries a banner that says the docs describe unreleased main and links to the root, and `<meta name="robots" content="noindex">`. `next/` has no sitemap, `robots.txt` or llms files, and its canonical URLs point at `next/`. Only the docs index, the landing page, links from the root into `next/`.

`pages.yml` runs on a push to `main`, on manual dispatch, daily, and on `workflow_run` of Promote, so the root follows `latest` as soon as a promotion ends. The `workflow_run` job reads the registry and checks out a tag; it uses nothing from the run that triggered it.

## Consequences

- A user who follows the root gets the options and commands of the version they install. A feature merged after a release appears only under `next/` until the next promotion.
- A docs fix merged after a release reaches the root with the next release. A fix that cannot wait is backported to `release/X.Y`, and reaches the root on the next daily run or on a dispatch of `pages.yml` from `main`. A push to `release/X.Y` does not start `pages.yml`: it would run the branch's copy, and the `github-pages` environment deploys only from `main`.
- A hand-moved `latest` is picked up on the next run of `pages.yml`; after moving `latest` by hand, dispatch it.
- A value on `latest` that is not `X.Y.Z`, or has no tag, fails the run before anything deploys, and the last good site stays live.
- The root is built with the site code of the tag. A change to the site itself (layout, checks, the docs index's link to `next/`) reaches the root with the release after it merges.
- Each run builds the site twice, which roughly doubles its time.
- Revisit if past versions need their own trees, which this decision leaves out. The two follow-ups of #581 are done: "Added in X.Y.Z" notes ([#602](https://github.com/aelmanaa/hardhat-kms/issues/602)) and docs fixes on `release/X.Y` ([#603](https://github.com/aelmanaa/hardhat-kms/issues/603)).
