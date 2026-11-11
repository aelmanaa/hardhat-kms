# Adoption metrics

Audience: A maintainer recording, once a month, how people find and install the plugin. Assumes push access to the repository for the traffic numbers, and the maintainer's Google and Microsoft accounts for the search dashboards.

Status: the checks below are in place. The docs site is a verified URL-prefix property in Google Search Console and Bing Webmaster Tools since 2026-10-07. The first monthly entry is due one month after 1.0.0.

Each source moves on its own clock: npm counts downloads per day, GitHub keeps traffic for 14 days, and search engines index pages over weeks. Read each one the same way every month and write the result in [Monthly entries](#monthly-entries), so a drop or a new channel shows up against the month before. Anything not green on a security page, and any target page that is not indexed, becomes an issue.

There are no targets, no dashboards and no analytics on the docs site. This page only records what public and account-bound sources already report.

## Monthly checklist

In the first week of the month, run the [adoption check](#the-adoption-check) for the month before, then the checks it cannot make, and write one entry:

1. `node scripts/adoption-check.ts --month <YYYY-MM> --traffic-log <file>`: [downloads](#downloads), the [npm search](#npm-listing), [GitHub](#github), [docs site search](#docs-site-search) and Context7. It prints the month's row; add the notes.
2. Fix or open an issue for each line under Problems.
3. In a browser: the [npm package page](#npm-listing) badges, [package health](#package-health) on Socket and Snyk, and the dependents tabs under [GitHub](#github).
4. Quarterly, in January, April, July and October: the target-phrase searches under [docs site search](#docs-site-search), the [answer engines](#answer-engines) and the [agent listings](#agent-listings).

Every week, run the check again with the same `--traffic-log`, so no day of GitHub traffic is lost.

## The adoption check

`scripts/adoption-check.ts` reads npm, GitHub, Google Search Console, Bing Webmaster Tools and Context7 for one month through their APIs, lists what looks wrong, and prints the month's row:

```sh
ADOPTION_GSC_SERVICE_ACCOUNT=<service account email> node scripts/adoption-check.ts --month 2026-10 \
  --traffic-log ~/.local/share/hardhat-kms/adoption-traffic.json
```

It prints, in order:

- The pages in the sitemap today, and how many answer 200.
- npm: each package's downloads in the month, the median day, the busiest day and the days it published a version; each package's position in the registry search for "hardhat kms" and "hardhat safe" today; the version on `latest`.
- GitHub: stars, forks and watchers, the last 14 days' views, clones, referrers and popular paths, and the month's views and clones from the traffic log.
- Google: the month's impressions and clicks, the top queries and pages, when Google last read each submitted sitemap, and the index state of every sitemap URL, read today with the URL Inspection API, with the URLs Google does not know.
- Bing: the month's impressions and clicks, the top queries of recent weeks, the indexed pages on the last day of the month, and the state of each submitted sitemap.
- Context7's index state.
- Problems, such as:
  - a sitemap URL that does not answer 200;
  - a sitemap a console has not read;
  - pages Google crawled but did not index;
  - Bing indexing fewer than half the sitemap;
  - Context7 older than the release on `latest`;
  - a package with no downloads;
  - a gap of more than 14 days in the traffic log.
- The row for [Monthly entries](#monthly-entries), with the Notes cell empty.

Options:

- `--traffic-log <file>` merges GitHub's daily views and clones into a JSON file and keeps a dated copy of the 14-day referrers and paths. Keep the file outside the repository; it holds no secret.
- `--refresh-context7` asks Context7 to index the docs again; see [Agent listings](#agent-listings).
- `--skip-inspection` leaves out the URL inspections, which take most of the minute the check runs.

A source without credentials is skipped, and Problems names what it could not check. The check writes nothing to npm, GitHub or the search consoles. Its setup is under [One-time setup](#one-time-setup).

## Downloads

The npm downloads API counts registry downloads per package. It does not tell installs from CI runs or mirrors, so read the trend, not the number. The provider packages show the split between clouds, and `@hardhat-kms/safe` how many projects propose Safe transactions. `@hardhat-kms/safe` was first published on `latest` with 1.5.0 on 2026-11-05.

The check reads one count per day from `https://api.npmjs.org/downloads/range/<start>:<end>/<package>`, one package at a time: the bulk form does not accept scoped packages. This repository's own workflows install from npm on the days of a release or promotion and on their schedules, so the busiest day is usually a release day. The median day moves less with them and is the better trend.

The API lags a few days. On 2026-10-08 its `last-month` window ended on 2026-10-04, before 0.9.0 was published on 2026-10-07, and all four queries returned `{"error":"package ... not found"}`.

## npm listing

The check reads the position of each package in the first 20 results of the registry search, `https://registry.npmjs.org/-/v1/search`, the one `npm search` uses. The npm website ranks with the same index but blocks scripted requests; to see its results, open <https://www.npmjs.com/search?q=hardhat%20kms> in a browser. On 2026-10-08 the search did not list any of the packages yet; on 2026-11-11 the six packages held the first six places for "hardhat kms", and none was in the first 20 for "hardhat safe".

Keywords and description:

```sh
npm view hardhat-kms keywords description
npm view @hardhat-kms/safe keywords description
```

On the package page, <https://www.npmjs.com/package/hardhat-kms>, in a browser, check that the TypeScript badge sits next to the name and that the Provenance section links the release workflow run. The provenance attestation is also in the registry:

```sh
npm view hardhat-kms dist.attestations.provenance.predicateType
```

It prints `https://slsa.dev/provenance/v1` for a release published from CI.

## Package health

Open these in a browser. Socket blocks scripted requests such as curl.

- Socket: <https://socket.dev/npm/package/hardhat-kms>, and the same path for `@hardhat-kms/aws`, `@hardhat-kms/gcp`, `@hardhat-kms/azure`, `@hardhat-kms/turnkey` and `@hardhat-kms/safe`. Read the supply chain, vulnerability, quality, maintenance and license scores and every alert.
- Snyk: <https://security.snyk.io/package/npm/hardhat-kms>. Read the known vulnerabilities for the latest version and the package health score. On 2026-10-08 it showed 0 vulnerabilities for 0.9.0 and no health score yet.

Open an issue for every alert, vulnerability or score that is not green, with a link to the page.

## GitHub

The check reads the repository and its traffic with `gh api`. The traffic endpoints need push access to the repository and cover only the last 14 days, so the check keeps them in the traffic log: run it every week with the same `--traffic-log`, and Problems names a gap of more than 14 days. October 2026 has no log, so its referrers cover only the 14 days to 2026-11-10.

On 2026-10-08 the repository had 0 stars, 0 forks and 0 watchers. In the 14 days to 2026-11-11 it had 99 views from 82 unique visitors.

The same numbers are under Insights, Traffic at <https://github.com/aelmanaa/hardhat-kms/graphs/traffic>. Clones include every CI checkout, so they say little about users. Referrers are the useful line: they name the sites that sent people to the repository.

Dependents:

- GitHub: <https://github.com/aelmanaa/hardhat-kms/network/dependents>, the public repositories whose lockfile names a package from this repository.
- npm: the Dependents tab of <https://www.npmjs.com/package/hardhat-kms?activeTab=dependents>, in a browser, packages published with `hardhat-kms` as a dependency.

## Docs site search

The docs site, <https://aelmanaa.github.io/hardhat-kms/>, publishes its pages in <https://aelmanaa.github.io/hardhat-kms/sitemap.xml>. The check reads both search consoles through their APIs.

### One-time setup

GitHub: `gh auth login` with an account that has push access to the repository.

Google: a service account with no key, which the maintainer impersonates. In a Google Cloud project of the maintainer's, not the live-test project:

```sh
gcloud services enable searchconsole.googleapis.com iamcredentials.googleapis.com --project <project>
gcloud iam service-accounts create adoption-reader --project <project>
gcloud iam service-accounts add-iam-policy-binding adoption-reader@<project>.iam.gserviceaccount.com \
  --project <project> --member "user:<maintainer's Google account>" --role roles/iam.serviceAccountTokenCreator
```

Then, in Search Console, under Settings, Users and permissions, add the service account to the docs property with the Restricted permission. The check gets a short-lived token with `gcloud auth print-access-token --impersonate-service-account`.

Bing: in Bing Webmaster Tools, under Settings, API access, generate an API key. Keep it in `BING_WEBMASTER_API_KEY`, or on macOS in the login Keychain, where the check reads it without a prompt:

```sh
security add-generic-password -a "$USER" -s bing-webmaster-api -w
```

The command asks for the key, so it stays out of the shell history.

### Pages that are not indexed

On 2026-11-10 Google had indexed only the home page, and the other 43 sitemap URLs were unknown to it: Search Console showed "Couldn't fetch" for the sitemap and had never read it, though the file was valid and every URL answered 200. Google says this status on a valid sitemap comes from host load or low crawl demand, not from the file ([Search Engine Journal, 2026-10-06](https://www.searchenginejournal.com/google-explains-couldnt-fetch-sitemap-errors/)), and other `github.io` project sites report the same. Resubmitting the sitemap does not help. What does: in Search Console, URL Inspection, request indexing for the pages the check lists as unknown to Google, about ten a day, the pages that link to many others first. Bing read the same sitemap the day it was submitted.

Once a quarter, search each target phrase below in a private window, in Google and Bing, and note the position of the first result on the docs site, the repository or the npm page, or "none" if it is not in the first page:

1. hardhat kms
2. hardhat aws kms
3. hardhat google cloud kms
4. hardhat azure key vault
5. hardhat 3 kms signer
6. sign ethereum transactions with aws kms
7. deploy contract with aws kms hardhat
8. hardhat ignition kms
9. viem aws kms signer
10. ethers google cloud kms signer
11. ethereum signer azure key vault
12. hardhat deploy without private key
13. hardhat safe propose transaction
14. hardhat 3 multisig

## Answer engines

Once a quarter, ask the major assistants (ChatGPT, Claude, Gemini, Perplexity, Copilot) these questions in a new chat with no files attached, and note whether the answer names hardhat-kms and which sources it cites:

1. How do I sign Hardhat transactions with a key in AWS KMS?
2. How do I deploy a contract with Hardhat 3 without putting a private key in .env?
3. Is there a Hardhat plugin for Google Cloud KMS?
4. How do I sign Ethereum transactions with Azure Key Vault from Hardhat?
5. How do I use a cloud KMS key with Hardhat Ignition?
6. How do I sign from GitHub Actions with a KMS key and no stored credentials?
7. What are the options for a remote signer in Hardhat 3?
8. How do I sign EIP-712 typed data with a key in AWS KMS?
9. How do I propose a Safe multisig transaction from Hardhat 3?
10. How do I use a KMS key as one owner of a Safe and propose transactions from CI?

## Agent listings

Context7 indexes the user docs. This prints the index state, its last update and its snippet count:

```sh
curl -s "https://context7.com/api/v1/search?query=hardhat-kms" | jq '.results[] | select(.id == "/aelmanaa/hardhat-kms") | {state, lastUpdateDate, totalSnippets, trustScore}'
```

On 2026-10-08 it returned `"state": "finalized"`, last updated 2026-10-07, with 1431 snippets.

Context7 did not pick up later releases on its own. `node scripts/adoption-check.ts --month <month> --refresh-context7` prints the same state and asks Context7 to index the docs again, with an API key from <https://context7.com/dashboard> in `CONTEXT7_API_KEY` or in the macOS login Keychain item `context7-api` (`security add-generic-password -a "$USER" -s context7-api -w`). Refresh after each minor release. The refresh on 2026-11-10 took about ten minutes and raised the count to 2333 snippets.

Once skills.sh lists the skill, its page, <https://skills.sh/aelmanaa/hardhat-kms/hardhat-kms>, shows how many times `npx skills add aelmanaa/hardhat-kms` installed it. On 2026-10-08 the page said the skill was not available and a search on skills.sh found nothing, so the skill is not listed yet.

## Monthly entries

One row per month, newest at the bottom. Write the month the numbers cover, not the day they were read, and "n/a" for a source with no data yet.

| Month   | Downloads (core, aws, gcp, azure, turnkey, safe) | Stars | Top referrers                                                           | npm position                                                                                  | Indexed / sitemap (Google, Bing)                                   | Impressions, clicks (Google)             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------ | ----- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10 | 1879, 1606, 1684, 1707, 299, 0                   | 0     | github.com 6 (4 unique), Google 3 (2 unique), the 14 days to 2026-11-10 | "hardhat kms": all six in the first six, the core third; "hardhat safe": none in the first 20 | Google 1 / 44, Bing 1 / 44: the home page only, read on 2026-11-10 | 12, 2: all on the home page (Bing: 0, 0) | Read on 2026-11-10. Downloads are mostly this repository's own checks: the days of a release or promotion count 200 to 390 for the core (7, 8, 10, 11, 16 and 26 October; 1 and 5 November) and the other days 0 to 72, while October ran 21 Registry mode, 15 Peer installs and 12 Fresh install workflows that install from npm. `@hardhat-kms/safe` was first published on 2026-11-04. Context7 was last updated 2026-10-07, before Turnkey and Safe, with 1431 snippets; refreshed on 2026-11-10 to 2333. Google had never read the sitemap ("Couldn't fetch") and none had been submitted to Bing; it was submitted to Bing on 2026-11-10, and pages are requested for indexing in Google by hand (#690). skills.sh does not list the skill yet. Socket, Snyk and npm dependents are browser-only and not read. |
