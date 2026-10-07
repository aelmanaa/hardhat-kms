// The docs site: VitePress over docs/, published to GitHub Pages at the hostname of decision 0017.
// docs/contributor/documentation.md, "The docs site", describes what this file sets and why.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";
import type { DefaultTheme, HeadConfig, UserConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

import {
  EXCLUDED_FOLDERS,
  GITHUB_REPOSITORY,
  HOSTNAME,
  ORIGIN,
  SITE_BASE,
  SITE_DESCRIPTION,
  SITE_NAME,
  githubSlug,
  markdownCopyUrl,
  pageUrl,
  rewriteMarkdownLinks,
  robotsTxt,
  sitePage,
} from "./site.ts";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, "../../..");
const docsDirectory = path.join(repositoryRoot, "docs");

const EXCLUDED = EXCLUDED_FOLDERS.map((folder) => `${folder}/**`);

/**
 * The social preview, served from docs/public/og-image.png. The image is not in the repository
 * yet, so the URL 404s until it is added; scripts/check-site.ts warns about that.
 */
const OG_IMAGE = `${HOSTNAME}og-image.png`;

const coreManifest: unknown = JSON.parse(
  readFileSync(path.join(repositoryRoot, "packages/hardhat-kms/package.json"), "utf8"),
);
const coreVersion = String(Reflect.get(Object(coreManifest), "version"));
const coreEngines: unknown = Reflect.get(Object(coreManifest), "engines");
const coreNodeRange = String(Reflect.get(Object(coreEngines), "node")).replace(/\.0$/, "");

/**
 * The install guide for the time before the first npm release. The release deletes it, and the
 * llms.txt preamble switches from it to the npm commands then.
 */
const PRE_RELEASE_GUIDE = "user/guides/install-before-release.md";

/** Generated pages: edits go to their generator's sources, so the page has no edit link. */
function isGenerated(source: string): boolean {
  return source === "user/reference/errors.md" || source.startsWith("user/reference/api/");
}

/** Escapes text for an HTML attribute or element body. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The first `# ` heading of a Markdown file, for the sidebar. */
function pageTitle(file: string): string {
  const match = /^# (.+)$/m.exec(readFileSync(path.join(docsDirectory, file), "utf8"));
  return match?.[1]?.replaceAll("`", "") ?? file;
}

/** The pages docs/README.md links, in its order, as paths relative to docs/. */
function indexOrder(): string[] {
  const text = readFileSync(path.join(docsDirectory, "README.md"), "utf8");
  return [...text.matchAll(/\]\(([^)#\s]+\.md)\)/g)]
    .map((match) => path.posix.normalize(match[1] ?? ""))
    .filter((target) => !target.startsWith("../"));
}

/** A site link for a page relative to docs/. */
function siteLink(file: string): string {
  return `/${sitePage(file)
    .replace(/(^|\/)index\.md$/, "$1")
    .replace(/\.md$/, "")}`;
}

function section(text: string, folder: string, order: string[]): DefaultTheme.SidebarItem {
  const items = order
    .filter((file) => file.startsWith(`user/${folder}/`))
    .map((file): DefaultTheme.SidebarItem => {
      const item: DefaultTheme.SidebarItem = { text: pageTitle(file), link: siteLink(file) };
      if (file === "user/reference/api/README.md") {
        item.items = readdirSync(path.join(docsDirectory, "user/reference/api"), {
          recursive: true,
          encoding: "utf8",
        })
          .filter((entry) => entry.endsWith(".md") && entry !== "README.md")
          .toSorted()
          .map((entry) => {
            const page = `user/reference/api/${entry}`;
            return { text: pageTitle(page), link: siteLink(page) };
          });
      }
      return item;
    });
  return { text, items };
}

/**
 * The sidebar with each nested group lifted to the level of its parent, for vitepress-plugin-llms.
 * Version 1.14.0 drops the site base from the links of a nested group, so llms.txt would list the
 * API pages without `/hardhat-kms/`.
 */
function flatSidebar(items: DefaultTheme.SidebarItem[]): DefaultTheme.SidebarItem[] {
  return items.map((group) => {
    if (group.items === undefined) {
      return group;
    }
    return {
      ...group,
      items: group.items.flatMap(({ items: children, ...item }) => [item, ...(children ?? [])]),
    };
  });
}

function sidebar(): DefaultTheme.SidebarItem[] {
  const order = indexOrder();
  return [
    section("Tutorials", "tutorials", order),
    section("How-to guides", "guides", order),
    section("Reference", "reference", order),
    section("Explanation", "explanation", order),
    { text: "Live proof", link: "/live-proof" },
  ];
}

/**
 * Points a relative link that leaves the site (a contributor page, CONTRIBUTING.md, an example
 * project) at the file on GitHub, so the Markdown stays readable on GitHub and on the site.
 */
function outsideLink(href: string, sourceFile: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:|^[#/]/i.test(href)) {
    return undefined;
  }
  const [target = "", anchor] = href.split("#");
  const absolute = path.resolve(path.dirname(sourceFile), decodeURIComponent(target));
  const inDocs = path.relative(docsDirectory, absolute);
  const leavesSite =
    inDocs.startsWith("..") ||
    path.isAbsolute(inDocs) ||
    EXCLUDED_FOLDERS.some((folder) => inDocs.split(path.sep)[0] === folder);
  if (!leavesSite) {
    return undefined;
  }
  const fromRoot = path.relative(repositoryRoot, absolute).split(path.sep).join("/");
  const isFolder = existsSync(absolute) && statSync(absolute).isDirectory();
  const url = `https://github.com/${GITHUB_REPOSITORY}/${isFolder ? "tree" : "blob"}/main/${fromRoot}`;
  return anchor === undefined ? url : `${url}#${anchor}`;
}

/**
 * Points a relative link to a folder's README.md at the page it becomes, the folder's index (see
 * `sitePage`), so VitePress serves it at the folder's URL.
 */
function indexLink(href: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:|^[#/]/i.test(href)) {
    return undefined;
  }
  const replaced = href.replace(/(^|\/)README\.md(?=#|$)/, "$1index.md");
  return replaced === href ? undefined : replaced;
}

/**
 * Rewrites a relative link in a Markdown copy of a page, which the site serves at another path
 * than its source (a folder's README.md becomes `<folder>.md`): a link that leaves the site goes to
 * GitHub, and a link to a page goes to the absolute URL of its Markdown copy.
 */
function markdownCopyLink(href: string, sourceFile: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:|^[#/]/i.test(href)) {
    return undefined;
  }
  const outside = outsideLink(href, sourceFile);
  if (outside !== undefined) {
    return outside;
  }
  const [target = "", anchor] = href.split("#");
  const absolute = path.resolve(path.dirname(sourceFile), decodeURIComponent(target));
  const inDocs = path.relative(docsDirectory, absolute).split(path.sep).join("/");
  const url = inDocs.endsWith(".md") ? markdownCopyUrl(inDocs) : `${HOSTNAME}${inDocs}`;
  return anchor === undefined ? url : `${url}#${anchor}`;
}

/** The source file, relative to docs/, of a Markdown copy's path in the output directory. */
function copySource(copy: string): string | undefined {
  return [copy, copy.replace(/\.md$/, "/README.md")].find((candidate) =>
    existsSync(path.join(docsDirectory, candidate)),
  );
}

/**
 * Rewrites the relative links of the Markdown copies and of llms-full.txt, which
 * vitepress-plugin-llms copies from the sources as they are, so each one resolves on the site.
 */
async function rewriteLlmsLinks(outDir: string): Promise<void> {
  const copies = readdirSync(outDir, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => entry.endsWith(".md"));
  for (const copy of copies) {
    const source = copySource(copy);
    if (source === undefined) {
      continue;
    }
    const file = path.join(outDir, copy);
    const text = await readFile(file, "utf8");
    const sourceFile = path.join(docsDirectory, source);
    await writeFile(
      file,
      rewriteMarkdownLinks(text, (href) => markdownCopyLink(href, sourceFile)),
    );
  }
  // llms-full.txt joins the copies, each after a `---` block with its `url:`, which the plugin
  // folds onto the next line (`url: >-`) when it is long.
  const full = path.join(outDir, "llms-full.txt");
  if (!existsSync(full)) {
    return;
  }
  const parts = (await readFile(full, "utf8")).split(/(^---\nurl: (?:>-\n +)?\S+\n---$)/m);
  let sourceFile: string | undefined;
  const rewritten = parts.map((part) => {
    const url = /^---\nurl: (?:>-\n +)?(\S+)\n---$/.exec(part)?.[1];
    if (url !== undefined) {
      const source = url.startsWith(HOSTNAME) ? copySource(url.slice(HOSTNAME.length)) : undefined;
      sourceFile = source === undefined ? undefined : path.join(docsDirectory, source);
      return part;
    }
    const from = sourceFile;
    return from === undefined
      ? part
      : rewriteMarkdownLinks(part, (href) => markdownCopyLink(href, from));
  });
  await writeFile(full, rewritten.join(""));
}

/** Start-here text for agents at the top of llms.txt. */
function agentPreamble(): string {
  const skill = existsSync(path.join(repositoryRoot, "skills/hardhat-kms/SKILL.md"))
    ? "\n\nTo give a coding agent the plugin's skill: `npx skills add aelmanaa/hardhat-kms`."
    : "";
  const configure = `add the plugin and the key to \`hardhat.config.ts\` ([configuration reference](${markdownCopyUrl("user/reference/configuration.md")})) and list the key's address with \`npx hardhat kms accounts\``;
  const credentials =
    "Credentials come from each cloud SDK's default chain, never from the Hardhat config.";
  if (existsSync(path.join(docsDirectory, PRE_RELEASE_GUIDE))) {
    return `## Start here for agents

hardhat-kms is not on npm yet. Until the first release, build and install the packages from GitHub as [Install before the first npm release](${markdownCopyUrl(PRE_RELEASE_GUIDE)}) describes. Then ${configure}. ${credentials}${skill}`;
  }
  return `## Start here for agents

Install the core and the provider package for the cloud that holds the key, ${configure}:

\`\`\`sh
npm install --save-dev hardhat-kms @hardhat-kms/aws     # AWS KMS
npm install --save-dev hardhat-kms @hardhat-kms/gcp     # Google Cloud KMS
npm install --save-dev hardhat-kms @hardhat-kms/azure   # Azure Key Vault
npx hardhat kms accounts
\`\`\`

These packages are newer than most training data: check npm for the current version (\`npm view hardhat-kms version\`) instead of guessing one. ${credentials}${skill}`;
}

const config: UserConfig<DefaultTheme.Config> = defineConfig({
  title: SITE_NAME,
  titleTemplate: `:title | ${SITE_NAME}`,
  description: SITE_DESCRIPTION,
  lang: "en-US",
  base: SITE_BASE,
  srcDir: docsDirectory,
  srcExclude: EXCLUDED,
  rewrites: sitePage,
  // Space between the landing page's feature cards and the docs index below them.
  head: [["style", {}, ".VPHome .vp-doc { margin-top: 48px; }"]],
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: HOSTNAME },
  markdown: {
    anchor: { slugify: githubSlug },
    config(md) {
      const linkOpen = md.renderer.rules.link_open;
      md.renderer.rules.link_open = (tokens, index, options, env: { path: string }, self) => {
        const token = tokens[index];
        const href = token?.attrGet("href");
        const replacement =
          href == null ? undefined : (outsideLink(href, env.path) ?? indexLink(href));
        if (token !== undefined && replacement !== undefined) {
          token.attrSet("href", replacement);
        }
        return linkOpen === undefined
          ? self.renderToken(tokens, index, options)
          : linkOpen(tokens, index, options, env, self);
      };
      const fence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token !== undefined && token.info.trim() === "mermaid") {
          return `<pre class="mermaid" v-pre>${escapeHtml(token.content)}</pre>\n`;
        }
        return fence === undefined
          ? self.renderToken(tokens, index, options)
          : fence(tokens, index, options, env, self);
      };
    },
  },
  transformPageData(pageData) {
    if (isGenerated(pageData.filePath)) {
      pageData.frontmatter = { ...pageData.frontmatter, editLink: false };
    }
    if (pageData.relativePath === "index.md" || pageData.filePath === "README.md") {
      pageData.title = "Sign Hardhat 3 transactions with a cloud KMS key";
      pageData.frontmatter = {
        ...pageData.frontmatter,
        layout: "home",
        hero: {
          name: SITE_NAME,
          text: "Sign with a cloud key",
          tagline:
            "A Hardhat 3 plugin that signs transactions, messages and typed data with keys in AWS KMS, Google Cloud KMS or Azure Key Vault. The private key never leaves the KMS.",
          actions: [
            {
              theme: "brand",
              text: "First deploy with AWS KMS",
              link: "/user/tutorials/first-deploy-aws",
            },
            { theme: "alt", text: "Google Cloud KMS", link: "/user/tutorials/first-deploy-gcp" },
            { theme: "alt", text: "Azure Key Vault", link: "/user/tutorials/first-deploy-azure" },
          ],
        },
        features: [
          {
            title: "Works with viem, ethers and Ignition",
            details:
              "The plugin answers at the JSON-RPC layer, so your scripts and deployments use KMS accounts unchanged.",
            link: "/user/explanation/how-it-works",
          },
          {
            title: "Every signature is checked",
            details:
              "Each signature is recovered locally and must match the configured address before it is used.",
            link: "/user/explanation/security-model",
          },
          {
            title: "Tested live on Sepolia",
            details:
              "Every transaction type and signing method was sent on Sepolia, with block ranges and on-chain ecrecover checks.",
            link: "/live-proof",
          },
        ],
      };
    }
  },
  transformHead({ page, pageData, title, description }) {
    if (pageData.isNotFound === true) {
      return [];
    }
    const url = pageUrl(page);
    const head: HeadConfig[] = [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: SITE_NAME }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:image", content: OG_IMAGE }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ];
    if (page === "index.md") {
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "SoftwareSourceCode",
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        codeRepository: `https://github.com/${GITHUB_REPOSITORY}`,
        programmingLanguage: "TypeScript",
        runtimePlatform: `Node.js ${coreNodeRange}`,
        license: "https://opensource.org/licenses/MIT",
        author: { "@type": "Person", name: "Amine El Manaa", url: "https://github.com/aelmanaa" },
        version: coreVersion,
        url: HOSTNAME,
      };
      head.push(["script", { type: "application/ld+json" }, JSON.stringify(jsonLd)]);
    }
    return head;
  },
  async buildEnd(siteConfig) {
    await writeFile(path.join(siteConfig.outDir, "robots.txt"), robotsTxt());
    await rewriteLlmsLinks(siteConfig.outDir);
  },
  themeConfig: {
    nav: [
      {
        text: "Tutorials",
        items: [
          { text: "AWS KMS", link: "/user/tutorials/first-deploy-aws" },
          { text: "Google Cloud KMS", link: "/user/tutorials/first-deploy-gcp" },
          { text: "Azure Key Vault", link: "/user/tutorials/first-deploy-azure" },
        ],
      },
      { text: "Configuration", link: "/user/reference/configuration" },
      { text: "Errors", link: "/user/reference/errors" },
    ],
    sidebar: sidebar(),
    search: { provider: "local" },
    notFound: {
      quote: "This page does not exist. Search the docs or start from the home page.",
      linkText: "Docs home",
    },
    outline: { level: [2, 3] },
    editLink: {
      pattern: `https://github.com/${GITHUB_REPOSITORY}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    socialLinks: [{ icon: "github", link: `https://github.com/${GITHUB_REPOSITORY}` }],
    footer: {
      message:
        "MIT licensed. A community plugin, not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.",
    },
  },
  vite: {
    plugins: [
      {
        // The pages live in docs/, outside this package, where `vue` does not resolve. Resolve the
        // imports VitePress adds to each page from this package instead.
        name: "hardhat-kms:resolve-vue-from-site",
        enforce: "pre",
        async resolveId(source, importer, options) {
          if (importer === undefined || !/^vue(\/|$)/.test(source)) {
            return null;
          }
          if (!importer.startsWith(docsDirectory)) {
            return null;
          }
          return await this.resolve(source, path.join(configDirectory, "config.ts"), {
            ...options,
            skipSelf: true,
          });
        },
      },
      llmstxt({
        // The plugin adds the base path to this.
        domain: ORIGIN,
        title: SITE_NAME,
        description: SITE_DESCRIPTION,
        details: agentPreamble(),
        ignoreFiles: EXCLUDED,
        injectLLMHint: false,
        sidebar: flatSidebar(sidebar()),
      }),
    ],
  },
});

export default config;
