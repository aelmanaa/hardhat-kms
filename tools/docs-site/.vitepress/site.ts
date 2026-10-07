// Constants and helpers the site config and scripts/check-site.ts share.

/** The site's name, used in every title. */
export const SITE_NAME = "hardhat-kms";

/** The GitHub repository, as owner/name. */
export const GITHUB_REPOSITORY = "aelmanaa/hardhat-kms";

/** The path the site is served under on GitHub Pages (decision 0017). */
export const SITE_BASE = "/hardhat-kms/";

/** The scheme and host the site is served from (decision 0017). */
export const ORIGIN = "https://aelmanaa.github.io";

/** The site's address, with the base path and a trailing slash. */
export const HOSTNAME: string = `${ORIGIN}${SITE_BASE}`;

/** The description of a page that has none of its own. */
export const SITE_DESCRIPTION =
  "Sign Hardhat 3 transactions, messages and typed data with keys in AWS KMS, Google Cloud KMS or Azure Key Vault.";

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
  alt: "hardhat-kms, a plugin for Hardhat 3: the private key never leaves the KMS. A digest goes in and a signature comes out. Works with AWS KMS, Google Cloud KMS and Azure Key Vault.",
};

/** The largest social preview `docs:site:check` accepts, in bytes. */
export const OG_IMAGE_MAX_BYTES: number = 1024 * 1024;

/** The favicon, `docs/public/favicon.svg`, as the site serves it. */
export const FAVICON: string = `${SITE_BASE}favicon.svg`;

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

/** Crawlers that fetch a page to answer a search or a user's question, which the site allows. */
const ALLOWED_CRAWLERS: readonly string[] = [
  "Googlebot",
  "Bingbot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
];

/** The site's robots.txt. */
export function robotsTxt(): string {
  const allowed = ALLOWED_CRAWLERS.map((agent) => `User-agent: ${agent}\nAllow: /\n`).join("\n");
  return `# Search engines and answer engines may read every page.
${allowed}
# Crawlers that collect training data (GPTBot, ClaudeBot, CCBot, Google-Extended) fall under the
# default group below, which allows them. To refuse one, add a group for it with "Disallow: /".
User-agent: *
Allow: /

Sitemap: ${HOSTNAME}sitemap.xml
`;
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
