// Constants and helpers the site config and scripts/check-site.ts share.

/** The site's name, used in every title. */
export const SITE_NAME = "hardhat-kms";

/** The GitHub repository, as owner/name. */
export const GITHUB_REPOSITORY = "aelmanaa/hardhat-kms";

/**
 * Which tree a build makes (decision 0024): `latest`, the site root, built from the release tag of
 * the version on npm `latest`, or `next`, built from main and served under `next/`.
 */
export type SiteChannel = "latest" | "next";

/**
 * Parses the `DOCS_SITE_CHANNEL` environment variable. Unset or empty is `latest`, so a release
 * tag's own build, which predates the variable, makes the root as before.
 */
export function siteChannel(value: string | undefined): SiteChannel {
  if (value === undefined || value === "" || value === "latest") {
    return "latest";
  }
  if (value === "next") {
    return "next";
  }
  throw new Error(
    `DOCS_SITE_CHANNEL is ${JSON.stringify(value)}; expected "latest", "next" or nothing`,
  );
}

/** The tree this build makes. */
// oxlint-disable-next-line node/no-process-env -- the build input pages.yml and the CI Docs job set
export const SITE_CHANNEL: SiteChannel = siteChannel(process.env["DOCS_SITE_CHANNEL"]);

/** The path the site root is served under on GitHub Pages (decision 0017). */
const ROOT_BASE = "/hardhat-kms/";

/** The path this build is served under: the root, or `next/` below it. */
export const SITE_BASE: string = SITE_CHANNEL === "next" ? `${ROOT_BASE}next/` : ROOT_BASE;

/** The scheme and host the site is served from (decision 0017). */
export const ORIGIN = "https://aelmanaa.github.io";

/** The site root's address, which documents the version on npm `latest`. */
export const ROOT_HOSTNAME: string = `${ORIGIN}${ROOT_BASE}`;

/** This build's address, with the base path and a trailing slash. */
export const HOSTNAME: string = `${ORIGIN}${SITE_BASE}`;

/**
 * The banner on every page of the `next` tree, before the link to the site root. scripts/check-site.ts
 * checks that each page carries it.
 */
export const UNRELEASED_BANNER =
  "Unreleased: these docs describe main. Install docs for the current version are at";

/** The description of a page that has none of its own. */
export const SITE_DESCRIPTION =
  "Sign Hardhat 3 transactions, messages and typed data with keys in AWS KMS, Google Cloud KMS, Azure Key Vault or Turnkey.";

/**
 * The social preview, `docs/public/og-image.png`, served at the site root; `docs/public/og-image.svg`
 * is its source. The same PNG is the repository's social preview on GitHub.
 */
export const OG_IMAGE: {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
} = {
  url: `${HOSTNAME}og-image.png`,
  width: 1280,
  height: 640,
  alt: "hardhat-kms, a plugin for Hardhat 3: sign with managed keys. The private key never leaves the KMS: a digest goes in and a signature comes out. Works with AWS KMS, Google Cloud KMS, Azure Key Vault and Turnkey.",
};

/** The largest social preview `docs:site:check` accepts, in bytes. */
export const OG_IMAGE_MAX_BYTES: number = 1024 * 1024;

/** The favicon, `docs/public/favicon.svg`, as the site serves it. */
export const FAVICON: string = `${SITE_BASE}favicon.svg`;

/**
 * The favicon for browsers without SVG favicons, `docs/public/favicon-32.png`, a 32x32 PNG of
 * `favicon.svg`, as the site serves it.
 */
export const FAVICON_PNG: { readonly url: string; readonly size: number } = {
  url: `${SITE_BASE}favicon-32.png`,
  size: 32,
};

/** Folders under docs/ that stay on GitHub: the site leaves them out and links to them there. */
export const EXCLUDED_FOLDERS: readonly string[] = ["contributor"];

/**
 * The page a source file becomes, both relative to docs/: a folder's README.md is its index, so
 * `user/reference/api/README.md` is served at `user/reference/api/`.
 */
export function sitePage(source: string): string {
  return source.replace(/(^|\/)README\.md$/, "$1index.md");
}

/**
 * The canonical URL of a page, from its path relative to the source directory after rewrites:
 * `user/guides/key-loss.md` is `<hostname>user/guides/key-loss`, `index.md` is the hostname.
 */
export function pageUrl(page: string): string {
  return `${HOSTNAME}${page.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;
}

/**
 * The anchor GitHub gives a heading, so that a `#fragment` written for GitHub works on the site:
 * lower case, punctuation removed, each space a hyphen. `@hardhat-kms/gcp` is `hardhat-kmsgcp`.
 */
export function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replaceAll(" ", "-");
}

/**
 * The URL of the Markdown copy of a page that `vitepress-plugin-llms` writes, from the source path
 * relative to docs/: `user/guides/key-loss.md` is `<hostname>user/guides/key-loss.md`, a folder's
 * README.md is `<hostname><folder>.md`. The landing page has no copy, so its HTML URL is returned.
 */
export function markdownCopyUrl(source: string): string {
  const page = sitePage(source);
  return page === "index.md" ? HOSTNAME : `${HOSTNAME}${page.replace(/\/index\.md$/, ".md")}`;
}

/**
 * Replaces the target of each inline Markdown link `[text](target)` for which `rewrite` returns a
 * value. Fenced code blocks and inline code are left as they are.
 */
export function rewriteMarkdownLinks(
  markdown: string,
  rewrite: (target: string) => string | undefined,
): string {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) {
          fence = marker;
        } else if (marker.startsWith(fence)) {
          fence = undefined;
        }
        return line;
      }
      if (fence !== undefined) {
        return line;
      }
      // Odd segments are inline code.
      return line
        .split(/(`[^`]*`)/)
        .map((segment, index) =>
          index % 2 === 1
            ? segment
            : segment.replaceAll(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
                const replacement = rewrite(target);
                return replacement === undefined ? whole : `](${replacement})`;
              }),
        )
        .join("");
    })
    .join("\n");
}
