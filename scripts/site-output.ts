// Checks on the built docs site, as text in and problems out, so the tests can feed them fixtures.
// scripts/check-site.ts builds the site and runs them on the output directory.

/** What the checks need to know about the site. */
export interface SiteFacts {
  /** The site's address with its base path and a trailing slash. */
  hostname: string;
  /** The base path, such as `/hardhat-kms/`. */
  base: string;
  /** The suffix every title ends with, such as ` | hardhat-kms`. */
  titleSuffix: string;
}

/** Decodes the entities VitePress writes in attribute values. */
export function decodeEntities(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The `<head>` of an HTML page, or the empty string. */
function headOf(html: string): string {
  const end = html.indexOf("</head>");
  return end === -1 ? "" : html.slice(0, end);
}

/** Every start tag with this name, as a map of its attributes. */
export function tags(html: string, name: string): Map<string, string>[] {
  const found: Map<string, string>[] = [];
  for (const match of html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[1] ?? "").matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      attributes.set((attribute[1] ?? "").toLowerCase(), decodeEntities(attribute[2] ?? ""));
    }
    found.push(attributes);
  }
  return found;
}

/** The `content` of each `<meta>` in the head whose `name` or `property` is `key`. */
function metaContents(head: string, key: string): string[] {
  return tags(head, "meta")
    .filter((meta) => meta.get("name") === key || meta.get("property") === key)
    .map((meta) => meta.get("content") ?? "");
}

/**
 * The `description` of a Markdown page's YAML frontmatter, or undefined when it has none. Plain
 * and quoted one-line values are read; any other form throws, so a value the check cannot read
 * fails instead of passing unchecked.
 */
export function frontmatterDescription(markdown: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown)?.[1];
  const line = block?.split(/\r?\n/).find((entry) => entry.startsWith("description:"));
  if (line === undefined) {
    return undefined;
  }
  const value = line.slice("description:".length).trim();
  if (/^".*"$/.test(value)) {
    return String(JSON.parse(value));
  }
  if (/^'.*'$/.test(value)) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === "" || /^[>|&*!]/.test(value)) {
    throw new Error(`cannot read the frontmatter description "${value}": write it on one line`);
  }
  return value;
}

/**
 * Checks one page's head: one canonical, equal to `url`; a title ending in the site suffix; one
 * meta description, equal to `description` when the page's frontmatter sets one; the Open Graph
 * tags, with `og:url` equal to the canonical; and the Twitter card.
 */
export function headProblems(
  file: string,
  html: string,
  url: string,
  description: string | undefined,
  site: SiteFacts,
): string[] {
  const head = headOf(html);
  const problems: string[] = [];
  const canonicals = tags(head, "link").filter((link) => link.get("rel") === "canonical");
  if (canonicals.length !== 1) {
    problems.push(`${file}: ${canonicals.length} canonical links, expected 1`);
  } else if (canonicals[0]?.get("href") !== url) {
    problems.push(`${file}: canonical is ${canonicals[0]?.get("href")}, expected ${url}`);
  }
  const title = decodeEntities(/<title>([^<]*)<\/title>/.exec(head)?.[1] ?? "");
  if (!title.endsWith(site.titleSuffix) || title === site.titleSuffix.trim()) {
    problems.push(`${file}: the title "${title}" does not end in "${site.titleSuffix}"`);
  }
  const descriptions = metaContents(head, "description");
  if (descriptions.length !== 1 || descriptions[0] === "") {
    problems.push(
      `${file}: ${descriptions.length} meta descriptions, expected 1 that is not empty`,
    );
  } else if (description !== undefined && descriptions[0] !== description) {
    problems.push(`${file}: the meta description differs from the frontmatter description`);
  }
  for (const key of ["og:url", "og:title", "og:description", "og:image", "twitter:card"]) {
    const values = metaContents(head, key);
    if (values.length !== 1 || values[0] === "") {
      problems.push(`${file}: ${values.length} ${key} tags, expected 1 that is not empty`);
    }
  }
  const ogUrl = metaContents(head, "og:url")[0];
  if (ogUrl !== undefined && ogUrl !== url) {
    problems.push(`${file}: og:url is ${ogUrl}, expected ${url}`);
  }
  return problems;
}

/** The `id` of every element in a page, the anchors a link can point at. */
export function anchors(html: string): Set<string> {
  return new Set(
    [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => decodeEntities(match[1] ?? "")),
  );
}

/**
 * The site links of a page: `href` and `src` values that stay on the site, absolute, root-relative,
 * relative (`./setup#step-2`) or a bare `#anchor`, resolved against the page's own clean URL and
 * returned without the base path as `{ path, anchor }`. A root-relative link without the base path
 * is a problem, since it works in a local preview served from the root and 404s on GitHub Pages.
 * `file` is the page's path in the output directory, such as `user/guides/key-loss.html`.
 */
export function siteLinks(
  file: string,
  html: string,
  site: SiteFacts,
): { links: { path: string; anchor: string | undefined }[]; problems: string[] } {
  const links: { path: string; anchor: string | undefined }[] = [];
  const problems: string[] = [];
  const pageUrl = new URL(
    file.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, ""),
    site.hostname,
  );
  // Inline scripts and code hold text that looks like links; only markup counts.
  const markup = html
    .replaceAll(/<script\b[\s\S]*?<\/script>/gi, "")
    .replaceAll(/<pre\b[\s\S]*?<\/pre>/gi, "");
  for (const match of markup.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const target = decodeEntities(match[1] ?? "");
    if (target === "" || target.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(target)) {
      if (!target.startsWith(site.hostname)) {
        continue;
      }
    } else if (target.startsWith("/") && !target.startsWith(site.base)) {
      problems.push(`${file}: the link ${target} does not start with ${site.base}`);
      continue;
    }
    const resolved = new URL(target, pageUrl).href;
    if (!resolved.startsWith(site.hostname)) {
      problems.push(`${file}: the link ${target} leaves the site's base path`);
      continue;
    }
    const [path = "", anchor] = resolved.slice(site.hostname.length).split("#");
    links.push({
      path: decodeURIComponent(path.split("?")[0] ?? ""),
      anchor: anchor === undefined || anchor === "" ? undefined : anchor,
    });
  }
  return { links, problems };
}

/**
 * The output file a site path is served from with `cleanUrls`: `x` from `x.html`, `x/` from
 * `x/index.html`, an asset as itself. Returns the candidates in the order GitHub Pages tries them.
 */
export function outputCandidates(path: string): string[] {
  if (path === "" || path.endsWith("/")) {
    return [`${path}index.html`];
  }
  if (/\.[a-z\d]+$/i.test(path)) {
    return [path];
  }
  return [`${path}.html`, `${path}/index.html`];
}

/** The `<loc>` URLs of a sitemap. */
export function sitemapUrls(xml: string): Set<string> {
  return new Set(
    [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => decodeEntities(match[1] ?? "")),
  );
}

/** Checks robots.txt names the sitemap. */
export function robotsProblems(text: string, site: SiteFacts): string[] {
  const sitemap = `Sitemap: ${site.hostname}sitemap.xml`;
  return text.split("\n").some((line) => line.trim() === sitemap)
    ? []
    : [`robots.txt: no "${sitemap}" line`];
}

/** The JSON-LD fields the landing page must set. */
const JSON_LD_FIELDS = [
  "name",
  "codeRepository",
  "programmingLanguage",
  "runtimePlatform",
  "license",
  "author",
  "version",
  "url",
];

/**
 * Checks the landing page's JSON-LD: one block, valid JSON, a schema.org `SoftwareSourceCode`
 * with every field above, the given version and the site's URL.
 */
export function jsonLdProblems(html: string, version: string, site: SiteFacts): string[] {
  const blocks = [
    ...headOf(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
  ];
  if (blocks.length !== 1) {
    return [`index.html: ${blocks.length} JSON-LD blocks, expected 1`];
  }
  let data: unknown;
  try {
    data = JSON.parse(blocks[0]?.[1] ?? "");
  } catch (error) {
    return [`index.html: the JSON-LD is not JSON (${error instanceof Error ? error.message : ""})`];
  }
  const get = (key: string): unknown =>
    typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
  const problems: string[] = [];
  if (get("@context") !== "https://schema.org" || get("@type") !== "SoftwareSourceCode") {
    problems.push("index.html: the JSON-LD is not a https://schema.org SoftwareSourceCode");
  }
  for (const key of JSON_LD_FIELDS) {
    const value = get(key);
    if (value === undefined || value === null || value === "") {
      problems.push(`index.html: the JSON-LD has no ${key}`);
    }
  }
  if (get("version") !== version) {
    problems.push(
      `index.html: the JSON-LD version is ${String(get("version"))}, expected ${version}`,
    );
  }
  if (get("url") !== site.hostname) {
    problems.push(
      `index.html: the JSON-LD url is ${String(get("url"))}, expected ${site.hostname}`,
    );
  }
  return problems;
}
