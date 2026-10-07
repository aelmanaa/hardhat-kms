// Builds the docs site and checks its output directory:
// - every page under docs/ (contributor pages aside) is built, under a clean URL;
// - each page's head has one canonical URL without `.html`, a title ending in "| hardhat-kms", one
//   meta description (equal to the frontmatter description when the page sets one), the Open Graph
//   tags and the Twitter card;
// - every link and asset on the site starts with the base path and resolves to a built file, and
//   every #anchor to an element of that page;
// - sitemap.xml lists every page, robots.txt names the sitemap, llms.txt and llms-full.txt exist,
//   and every link in them and in the pages' Markdown copies is absolute and resolves to a built
//   file;
// - the landing page carries one JSON-LD SoftwareSourceCode block with the core's version.
// - the social preview the pages name is built, and is a 1280x640 PNG under 1 MB.
// scripts/site-output.ts holds the checks and test/scripts/site-output.test.ts their tests.
//
// Usage: node scripts/check-site.ts [--no-build]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXCLUDED_FOLDERS,
  HOSTNAME,
  OG_IMAGE,
  OG_IMAGE_MAX_BYTES,
  SITE_BASE,
  SITE_NAME,
  pageUrl,
  sitePage,
} from "../tools/docs-site/.vitepress/site.ts";
import {
  anchors,
  frontmatterDescription,
  headProblems,
  jsonLdProblems,
  markdownLinkProblems,
  outputCandidates,
  pngProblems,
  robotsProblems,
  siteLinks,
  sitemapUrls,
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

const problems: string[] = [];
const sources = files(docs).filter(
  (file) => file.endsWith(".md") && !EXCLUDED_FOLDERS.includes(file.split("/")[0] ?? ""),
);
const sitemap = existsSync(path.join(output, "sitemap.xml"))
  ? sitemapUrls(readFileSync(path.join(output, "sitemap.xml"), "utf8"))
  : new Set<string>();
if (sitemap.size === 0) {
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
  if (url.endsWith(".html")) {
    problems.push(`docs/${source}: the canonical URL ends in .html`);
  }
  if (sitemap.size > 0 && !sitemap.has(url)) {
    problems.push(`sitemap.xml does not list ${url}`);
  }
}

const anchorCache = new Map<string, Set<string>>();
const outputFiles = existsSync(output) ? files(output) : [];
for (const file of outputFiles.filter((entry) => entry.endsWith(".html"))) {
  const { links, problems: linkProblems } = siteLinks(
    file,
    readFileSync(path.join(output, file), "utf8"),
    site,
  );
  problems.push(...linkProblems);
  for (const link of links) {
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

const robots = path.join(output, "robots.txt");
problems.push(
  ...(existsSync(robots)
    ? robotsProblems(readFileSync(robots, "utf8"), site)
    : ["robots.txt is missing"]),
);
for (const name of ["llms.txt", "llms-full.txt"]) {
  const file = path.join(output, name);
  if (!existsSync(file) || statSync(file).size === 0) {
    problems.push(`${name} is missing or empty`);
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

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `site check passed: ${sources.length} pages built with one canonical URL, a title, a description and Open Graph tags; ${outputFiles.filter((entry) => entry.endsWith(".html")).length} HTML files whose links and anchors resolve; every URL in llms.txt, llms-full.txt and the Markdown copies resolves; sitemap.xml, robots.txt, llms.txt, llms-full.txt, the landing page's JSON-LD and the 1280x640 social preview are in place\n`,
);
