// Builds the docs site and checks its output directory:
// - every page under docs/ (contributor pages aside) is built, under a clean URL;
// - each page's head has one canonical URL without `.html`, a title ending in "| hardhat-kms", one
//   meta description (equal to the frontmatter description when the page sets one), the Open Graph
//   tags, the Twitter card and a link to each favicon;
// - every link and asset on the site starts with the base path and resolves to a built file, and
//   every #anchor to an element of that page;
// - sitemap.xml lists every page, llms.txt and llms-full.txt exist, there is no robots.txt (crawlers
//   read it only at a host's root, #582),
//   and every link in them and in the pages' Markdown copies is absolute and resolves to a built
//   file;
// - the landing page carries one JSON-LD SoftwareSourceCode block with the core's version;
// - the social preview the pages name is built, and is a 1280x640 PNG under 1 MB;
// - the PNG favicon is built, and is a 32x32 PNG;
// - docs/public/og-image.svg names only the vendored font families, and docs/public/og-image.png
//   has the same bytes as a fresh render of it (scripts/og-image.ts).
// With DOCS_SITE_CHANNEL=next it builds and checks the tree of unreleased main, served under next/
// (decision 0024): sitemap.xml and the llms files must be absent instead, and every
// page carries `noindex` and the unreleased banner. On the root tree, only the landing page may
// link into next/, which the root's build does not contain.
// scripts/site-output.ts holds the checks and test/scripts/site-output.test.ts their tests.
//
// Usage: [DOCS_SITE_CHANNEL=next] node scripts/check-site.ts [--no-build]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXCLUDED_FOLDERS,
  FAVICON,
  FAVICON_PNG,
  HOSTNAME,
  OG_IMAGE,
  OG_IMAGE_MAX_BYTES,
  ROOT_HOSTNAME,
  SITE_BASE,
  SITE_CHANNEL,
  SITE_NAME,
  UNRELEASED_BANNER,
  pageUrl,
  sitePage,
} from "../tools/docs-site/.vitepress/site.ts";
import {
  OG_FONT_FAMILIES,
  OG_FONT_FILES,
  OG_IMAGE_PNG,
  OG_IMAGE_SVG,
  renderOgImage,
} from "./og-image.ts";
import {
  anchors,
  frontmatterDescription,
  headProblems,
  iconProblems,
  isNextPath,
  jsonLdProblems,
  markdownLinkProblems,
  nextLinkProblem,
  ogImageProblems,
  outputCandidates,
  pngProblems,
  siteLinks,
  sitemapUrls,
  svgFontProblems,
  unreleasedPageProblems,
} from "./site-output.ts";
import type { SiteFacts } from "./site-output.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docs = path.join(root, "docs");
const output = path.join(root, "tools/docs-site/.vitepress/dist");
const site: SiteFacts = {
  hostname: HOSTNAME,
  base: SITE_BASE,
  titleSuffix: ` | ${SITE_NAME}`,
  image: OG_IMAGE,
};

/** Every file under a directory, relative to it, with forward slashes. */
function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((entry) => statSync(path.join(directory, entry)).isFile())
    .map((entry) => entry.split(path.sep).join("/"));
}

if (!process.argv.includes("--no-build")) {
  const started = performance.now();
  execFileSync("pnpm", ["run", "docs:site"], { cwd: root, stdio: "inherit" });
  process.stdout.write(`site built in ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
}

const unreleased = SITE_CHANNEL === "next";
const problems: string[] = [];
const sources = files(docs).filter(
  (file) => file.endsWith(".md") && !EXCLUDED_FOLDERS.includes(file.split("/")[0] ?? ""),
);
const sitemap = existsSync(path.join(output, "sitemap.xml"))
  ? sitemapUrls(readFileSync(path.join(output, "sitemap.xml"), "utf8"))
  : new Set<string>();
if (unreleased) {
  // Only the root is for search engines and agents.
  for (const name of ["sitemap.xml", "llms.txt", "llms-full.txt"]) {
    if (existsSync(path.join(output, name))) {
      problems.push(`${name} is in the next tree, which must not have one`);
    }
  }
} else if (sitemap.size === 0) {
  problems.push("sitemap.xml is missing or empty");
}

for (const source of sources) {
  const page = sitePage(source);
  const built = path.join(output, page.replace(/\.md$/, ".html"));
  const url = pageUrl(page);
  if (!existsSync(built)) {
    problems.push(`docs/${source}: not built (expected ${path.relative(root, built)})`);
    continue;
  }
  const description = frontmatterDescription(readFileSync(path.join(docs, source), "utf8"));
  problems.push(
    ...headProblems(`docs/${source}`, readFileSync(built, "utf8"), url, description, site),
  );
  problems.push(
    ...iconProblems(`docs/${source}`, readFileSync(built, "utf8"), [
      { href: FAVICON, type: "image/svg+xml" },
      { href: FAVICON_PNG.url, type: "image/png" },
    ]),
  );
  if (url.endsWith(".html")) {
    problems.push(`docs/${source}: the canonical URL ends in .html`);
  }
  if (!unreleased && sitemap.size > 0 && !sitemap.has(url)) {
    problems.push(`sitemap.xml does not list ${url}`);
  }
}

const anchorCache = new Map<string, Set<string>>();
const outputFiles = existsSync(output) ? files(output) : [];
for (const file of outputFiles.filter((entry) => entry.endsWith(".html"))) {
  const html = readFileSync(path.join(output, file), "utf8");
  if (unreleased) {
    // VitePress renders the 404 page in the browser: its HTML has the head only.
    const banner =
      file === "404.html" ? undefined : { text: UNRELEASED_BANNER, link: ROOT_HOSTNAME };
    problems.push(...unreleasedPageProblems(file, html, banner));
  }
  const { links, problems: linkProblems } = siteLinks(file, html, site);
  problems.push(...linkProblems);
  for (const link of links) {
    // The root's build has no next/: pages.yml adds main's tree there after this check.
    if (!unreleased && isNextPath(link.path)) {
      const problem = nextLinkProblem(file, link.path);
      if (problem !== undefined) {
        problems.push(problem);
      }
      continue;
    }
    const target = outputCandidates(link.path).find((candidate) =>
      existsSync(path.join(output, candidate)),
    );
    if (target === undefined) {
      problems.push(`${file}: the link ${SITE_BASE}${link.path} resolves to no built file`);
      continue;
    }
    if (link.anchor === undefined || !target.endsWith(".html")) {
      continue;
    }
    let ids = anchorCache.get(target);
    if (ids === undefined) {
      ids = anchors(readFileSync(path.join(output, target), "utf8"));
      anchorCache.set(target, ids);
    }
    if (!ids.has(decodeURIComponent(link.anchor))) {
      problems.push(
        `${file}: the link ${SITE_BASE}${link.path}#${link.anchor} names no anchor there`,
      );
    }
  }
}

// Crawlers read robots.txt only at a host's root, so one under the base path would do nothing (#582).
if (existsSync(path.join(output, "robots.txt"))) {
  problems.push("robots.txt is built, but crawlers read it only at a host's root");
}
if (!unreleased) {
  for (const name of ["llms.txt", "llms-full.txt"]) {
    const file = path.join(output, name);
    if (!existsSync(file) || statSync(file).size === 0) {
      problems.push(`${name} is missing or empty`);
    }
  }
}
// Every URL in llms.txt, llms-full.txt and the pages' Markdown copies resolves on the site.
const built = (sitePath: string): boolean =>
  outputCandidates(sitePath).some((candidate) => existsSync(path.join(output, candidate)));
for (const file of outputFiles.filter(
  (entry) => entry.endsWith(".md") || entry === "llms.txt" || entry === "llms-full.txt",
)) {
  problems.push(
    ...markdownLinkProblems(file, readFileSync(path.join(output, file), "utf8"), site, built),
  );
}
const manifest: unknown = JSON.parse(
  readFileSync(path.join(root, "packages/hardhat-kms/package.json"), "utf8"),
);
const version = String(Reflect.get(Object(manifest), "version"));
const landing = path.join(output, "index.html");
problems.push(
  ...(existsSync(landing)
    ? jsonLdProblems(readFileSync(landing, "utf8"), version, site)
    : ["index.html is missing"]),
);

// The social preview every page names (headProblems checks the URL) is built, with the size and
// format the Open Graph tags announce.
const ogImage = path.join(output, OG_IMAGE.url.slice(HOSTNAME.length));
problems.push(
  ...(existsSync(ogImage)
    ? pngProblems(path.relative(output, ogImage), readFileSync(ogImage), {
        width: OG_IMAGE.width,
        height: OG_IMAGE.height,
        maxBytes: OG_IMAGE_MAX_BYTES,
      })
    : [`${OG_IMAGE.url} is not in the build; add the image as docs/public/og-image.png`]),
);

// The PNG favicon the pages name (siteLinks checks that it resolves) has the size its link
// announces. The SVG favicon has no size to check.
const faviconPng = path.join(output, FAVICON_PNG.url.slice(SITE_BASE.length));
problems.push(
  ...(existsSync(faviconPng)
    ? pngProblems(path.relative(output, faviconPng), readFileSync(faviconPng), {
        width: FAVICON_PNG.size,
        height: FAVICON_PNG.size,
        maxBytes: 64 * 1024,
      })
    : [`${FAVICON_PNG.url} is not in the build; add the image as docs/public/favicon-32.png`]),
);

// The committed PNG is what scripts/render-og-image.ts draws from the SVG with the vendored fonts.
const ogSvg = readFileSync(OG_IMAGE_SVG, "utf8");
problems.push(
  ...svgFontProblems(path.relative(root, OG_IMAGE_SVG), ogSvg, OG_FONT_FAMILIES),
  ...ogImageProblems(
    path.relative(root, OG_IMAGE_PNG),
    readFileSync(OG_IMAGE_PNG),
    renderOgImage(ogSvg, OG_FONT_FILES),
  ),
);

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  unreleased
    ? `site check passed for next/ (${SITE_BASE}): ${sources.length} pages built with one canonical URL under next/, a title, a description, Open Graph tags, the favicon links, noindex and the unreleased banner; ${outputFiles.filter((entry) => entry.endsWith(".html")).length} HTML files whose links and anchors resolve; no sitemap.xml, robots.txt or llms files; the landing page's JSON-LD, the social preview and the PNG favicon are in place\n`
    : `site check passed: ${sources.length} pages built with one canonical URL, a title, a description, Open Graph tags and the favicon links; ${outputFiles.filter((entry) => entry.endsWith(".html")).length} HTML files whose links and anchors resolve; every URL in llms.txt, llms-full.txt and the Markdown copies resolves; sitemap.xml, robots.txt, llms.txt, llms-full.txt, the landing page's JSON-LD, the 1280x640 social preview and the 32x32 PNG favicon are in place, and the preview matches a render of its SVG\n`,
);
