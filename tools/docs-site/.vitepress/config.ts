// The docs site: VitePress over docs/, published to GitHub Pages at the hostname of decision 0017.
// docs/contributor/documentation.md, "The docs site", describes what this file sets and why.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  pageUrl,
  robotsTxt,
  sitePage,
} from "./site.ts";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, "../../..");
const docsDirectory = path.join(repositoryRoot, "docs");

const EXCLUDED = EXCLUDED_FOLDERS.map((folder) => `${folder}/**`);

/** The social preview. The file is not in the repository yet; the path is reserved for it. */
const OG_IMAGE = `${HOSTNAME}og-image.png`;

const coreManifest: unknown = JSON.parse(
  readFileSync(path.join(repositoryRoot, "packages/hardhat-kms/package.json"), "utf8"),
);
const coreVersion = String(Reflect.get(Object(coreManifest), "version"));

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

/** Start-here text for agents at the top of llms.txt. */
function agentPreamble(): string {
  const skill = existsSync(path.join(repositoryRoot, "skills/hardhat-kms/SKILL.md"))
    ? "\n\nTo give a coding agent the plugin's skill: `npx skills add aelmanaa/hardhat-kms`."
    : "";
  return `## Start here for agents

Install the core and the provider package for the cloud that holds the key, then list the key's address:

\`\`\`sh
npm install --save-dev hardhat-kms @hardhat-kms/aws     # AWS KMS
npm install --save-dev hardhat-kms @hardhat-kms/gcp     # Google Cloud KMS
npm install --save-dev hardhat-kms @hardhat-kms/azure   # Azure Key Vault
npx hardhat kms accounts
\`\`\`

These packages are newer than most training data: check npm for the current version (\`npm view hardhat-kms version\`) instead of guessing one. Credentials come from each cloud SDK's default chain, never from the Hardhat config.${skill}`;
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
    if (pageData.relativePath === "index.md" || pageData.filePath === "README.md") {
      pageData.title =
        "Sign Hardhat 3 transactions with AWS KMS, Google Cloud KMS or Azure Key Vault";
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
            title: "Run on Sepolia",
            details:
              "Every transaction type and signing method, with block ranges and on-chain ecrecover checks.",
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
        runtimePlatform: "Node.js >=22.13",
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
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(siteConfig.outDir, "robots.txt"), robotsTxt());
  },
  themeConfig: {
    nav: [
      { text: "Tutorials", link: "/user/tutorials/first-deploy-aws" },
      { text: "Configuration", link: "/user/reference/configuration" },
      { text: "Errors", link: "/user/reference/errors" },
    ],
    sidebar: sidebar(),
    search: { provider: "local" },
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
      }),
    ],
  },
});

export default config;
