# 0017: The docs site lives at aelmanaa.github.io/hardhat-kms

Status: Accepted (2026-10-06)

Issue: [#299](https://github.com/aelmanaa/hardhat-kms/issues/299)

## Context

The docs site ([#74](https://github.com/aelmanaa/hardhat-kms/issues/74)) needs a hostname before anything can point at it. Five places embed the URL, and each has its own cost to change:

| Place                                                 | How it changes                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `homepage` in the four `package.json` files           | A release of all four packages, since they version together; npm shows the old value until then                                                                                 |
| The repository's About link                           | A settings edit                                                                                                                                                                 |
| The `website` of the Hardhat community plugins entry  | A second pull request to `NomicFoundation/hardhat-website`, whose review has taken from two days to several months ([#306](https://github.com/aelmanaa/hardhat-kms/issues/306)) |
| `sitemap.hostname` and the per-page `canonical` tags  | A config change, a redeploy, and a new property in Google Search Console and Bing Webmaster Tools                                                                               |
| The URLs in `llms.txt`, `llms-full.txt` and the pages | A redeploy; answer engines that cached the old URLs keep citing them until they crawl again                                                                                     |

Search engines index a page under its canonical URL. Moving a site to a new hostname is a site move: the search-console properties and their history do not carry across, every cached citation keeps the old URL until it is re-crawled, and ranking takes time to settle even with redirects in place.

The choice is between the GitHub Pages project URL, `https://aelmanaa.github.io/hardhat-kms/`, and a custom domain. A custom domain costs a registration, DNS records, a yearly renewal that someone has to remember, and a `CNAME` file; GitHub serves the site on that domain only while the DNS record points at GitHub Pages. The project URL costs nothing and stays up as long as the repository and the user account exist.

A project site is served under the repository name, so VitePress needs `base` set to that path; a custom domain would be served from the root. The two settings cannot both be right, so the hostname decides `base`.

A GitHub organization would change the hostname to `<org>.github.io/hardhat-kms/`. GitHub redirects a transferred repository's Git and web URLs, but [not its Pages site](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository). No organization is planned, so the user path is stable.

## Decision

The docs site's hostname is `https://aelmanaa.github.io/hardhat-kms/`. There is no custom domain, and no organization is planned.

The five places above point at that URL. `homepage` in the four manifests points at it from the first publish, before the site is live; the site goes live with [#74](https://github.com/aelmanaa/hardhat-kms/issues/74). The community plugins `website` uses the README anchor, `https://github.com/aelmanaa/hardhat-kms#readme`, until the site is live, since a listing link must resolve on the day it is reviewed.

The site's `base` is `/hardhat-kms/`, and `sitemap.hostname` is `https://aelmanaa.github.io/hardhat-kms/`.

## Consequences

- The site needs no DNS, no renewal and no CNAME file. The deploy workflow is the standard GitHub Pages one.
- Every absolute URL in the site config, the manifests and the listing uses the path `/hardhat-kms/`; a link that forgets it 404s on the live site but works in a local preview served from the root. The site build check in [#74](https://github.com/aelmanaa/hardhat-kms/issues/74) covers the deployed output, so a missing prefix fails there.
- A custom domain later would cost: a release of the four packages, a settings edit, a second upstream listing pull request, new search-console properties, `base` back to `/`, and a site move that takes time to settle. GitHub redirects the project URL to a custom domain once one is set, so old links keep working; the search-console history does not follow.
- Moving the repository to an organization would cost the same, without the redirect: the old Pages URL would stop serving, so every cached link and citation would break until re-crawled.
- A reason to revisit: the project outgrows one person's account, or a custom domain becomes worth the yearly renewal for reasons beyond search ranking. Either is a new record that supersedes this one.
