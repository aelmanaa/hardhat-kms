# Adoption metrics

Audience: A maintainer recording, once a month, how people find and install the plugin. Assumes push access to the repository for the traffic numbers, and the maintainer's Google and Microsoft accounts for the search dashboards.

Status: the checks below are in place. The docs site is a verified URL-prefix property in Google Search Console and Bing Webmaster Tools since 2026-10-07. The first monthly entry is due one month after 1.0.0.

Each source moves on its own clock: npm counts downloads per day, GitHub keeps traffic for 14 days, and search engines index pages over weeks. Read each one the same way every month and write the result in [Monthly entries](#monthly-entries), so a drop or a new channel shows up against the month before. Anything not green on a security page, and any target page that is not indexed, becomes an issue.

There are no targets, no dashboards and no analytics on the docs site. This page only records what public and account-bound sources already report.

## Monthly checklist

Run these in the first week of the month and write one entry.

1. [Downloads](#downloads): last month for the core and each provider.
2. [npm listing](#npm-listing): position for "hardhat kms", keywords, description, the TypeScript and provenance badges.
3. [Package health](#package-health): Socket and Snyk.
4. [GitHub](#github): stars, forks, referrers, popular paths, dependents.
5. [Docs site search](#docs-site-search): indexed pages against the sitemap, impressions, clicks, queries.
6. Quarterly, in January, April, July and October: [answer engines](#answer-engines) and the [agent listings](#agent-listings).

## Downloads

The npm downloads API counts registry downloads per package. It does not tell installs from CI runs or mirrors, so read the trend, not the number. The provider packages show the split between clouds.

```sh
curl -s https://api.npmjs.org/downloads/point/last-month/hardhat-kms
curl -s https://api.npmjs.org/downloads/point/last-month/@hardhat-kms/aws
curl -s https://api.npmjs.org/downloads/point/last-month/@hardhat-kms/gcp
curl -s https://api.npmjs.org/downloads/point/last-month/@hardhat-kms/azure
```

Each answer is `{"downloads":N,"start":"YYYY-MM-DD","end":"YYYY-MM-DD","package":"..."}`. For a calendar month, put the dates in the path, for example `point/2026-11-01:2026-11-30/hardhat-kms`. Swap `point` for `range` to get one count per day. The bulk form (`hardhat-kms,@hardhat-kms/aws`) does not accept scoped packages, so query each one on its own.

The API lags a few days. On 2026-10-08 its `last-month` window ended on 2026-10-04, before 0.9.0 was published on 2026-10-07, and all four queries returned `{"error":"package ... not found"}`.

## npm listing

```sh
npm search "hardhat kms" --searchlimit=20 --parseable | cut -f1 | grep -n -x -e hardhat-kms -e '@hardhat-kms/.*'
npm view hardhat-kms keywords description
```

The first command prints the position of each of the four packages in the first 20 results, or nothing if none is listed. The same results are at <https://www.npmjs.com/search?q=hardhat%20kms>, in a browser. The npm website refuses requests without one. On 2026-10-08 the search did not list any of the packages yet.

On the package page, <https://www.npmjs.com/package/hardhat-kms>, in a browser, check that the TypeScript badge sits next to the name and that the Provenance section links the release workflow run. The provenance attestation is also in the registry:

```sh
npm view hardhat-kms dist.attestations.provenance.predicateType
```

It prints `https://slsa.dev/provenance/v1` for a release published from CI.

## Package health

Open these in a browser. Socket refuses requests without one.

- Socket: <https://socket.dev/npm/package/hardhat-kms>, and the same path for `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure`. Read the supply chain, vulnerability, quality, maintenance and license scores and every alert.
- Snyk: <https://security.snyk.io/package/npm/hardhat-kms>. Read the known vulnerabilities for the latest version and the package health score. On 2026-10-08 it showed 0 vulnerabilities for 0.9.0 and no health score yet.

Open an issue for every alert, vulnerability or score that is not green, with a link to the page.

## GitHub

The traffic endpoints need push access to the repository and cover only the last 14 days. After each release, run them once a week for four weeks so no week is lost.

```sh
gh api repos/aelmanaa/hardhat-kms --jq '{stars: .stargazers_count, forks: .forks_count, watchers: .subscribers_count}'
gh api repos/aelmanaa/hardhat-kms/traffic/views --jq '{count, uniques}'
gh api repos/aelmanaa/hardhat-kms/traffic/clones --jq '{count, uniques}'
gh api repos/aelmanaa/hardhat-kms/traffic/popular/referrers --jq '.[] | "\(.referrer) \(.count) \(.uniques)"'
gh api repos/aelmanaa/hardhat-kms/traffic/popular/paths --jq '.[] | "\(.path) \(.count) \(.uniques)"'
```

On 2026-10-08 the repository had 0 stars, 0 forks and 0 watchers.

The same numbers are under Insights, Traffic at <https://github.com/aelmanaa/hardhat-kms/graphs/traffic>. Clones include every CI checkout, so they say little about users. Referrers are the useful line: they name the sites that sent people to the repository.

Dependents:

- GitHub: <https://github.com/aelmanaa/hardhat-kms/network/dependents>, the public repositories whose lockfile names a package from this repository.
- npm: the Dependents tab of <https://www.npmjs.com/package/hardhat-kms?activeTab=dependents>, in a browser, packages published with `hardhat-kms` as a dependency.

## Docs site search

The docs site, <https://aelmanaa.github.io/hardhat-kms/>, publishes its pages in <https://aelmanaa.github.io/hardhat-kms/sitemap.xml>. Count the pages it lists:

```sh
curl -s https://aelmanaa.github.io/hardhat-kms/sitemap.xml | grep -o '<loc>' | wc -l
```

On 2026-10-08 it listed 40 pages.

In Google Search Console, in the property for the docs URL, read for the last 28 days:

- Pages (Indexing): indexed and not indexed, against the sitemap count. Note each reason Google gives for a page that is not indexed, such as "Duplicate without user-selected canonical" or "Crawled - currently not indexed".
- Sitemaps: the last read date and the number of discovered pages.
- Performance (Search results): total clicks, total impressions, and the top queries and pages.

In Bing Webmaster Tools, in the same site, read the indexed pages under Site Explorer or URL Inspection, and clicks, impressions and top queries under Search Performance.

Then search each target phrase below in a private window, in Google and Bing, and note the position of the first result on the docs site, the repository or the npm page, or "none" if it is not in the first page:

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

## Agent listings

Context7 indexes the user docs. This prints the index state, its last update and its snippet count:

```sh
curl -s "https://context7.com/api/v1/search?query=hardhat-kms" | jq '.results[] | select(.id == "/aelmanaa/hardhat-kms") | {state, lastUpdateDate, totalSnippets, trustScore}'
```

On 2026-10-08 it returned `"state": "finalized"`, last updated 2026-10-07, with 1431 snippets.

Once skills.sh lists the skill, its page, <https://skills.sh/aelmanaa/hardhat-kms/hardhat-kms>, shows how many times `npx skills add aelmanaa/hardhat-kms` installed it. On 2026-10-08 the page said the skill was not available and a search on skills.sh found nothing, so the skill is not listed yet.

## Monthly entries

One row per month, newest at the bottom. Write the month the numbers cover, not the day they were read, and "n/a" for a source with no data yet.

| Month | Downloads (core, aws, gcp, azure) | Stars | Top referrers | npm position | Indexed / sitemap (Google, Bing) | Impressions, clicks (Google) | Notes |
| ----- | --------------------------------- | ----- | ------------- | ------------ | -------------------------------- | ---------------------------- | ----- |
|       |                                   |       |               |              |                                  |                              |       |
