// The checks `pnpm run docs:site:check` runs on the built docs site (`scripts/site-output.ts`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  frontmatterDescription,
  headProblems,
  iconProblems,
  jsonLdProblems,
  markdownLinkProblems,
  markdownLinkTargets,
  outputCandidates,
  pngProblems,
  robotsProblems,
  siteLinks,
  sitemapUrls,
} from "../../scripts/site-output.ts";
import type { SiteFacts } from "../../scripts/site-output.ts";
import {
  HOSTNAME,
  markdownCopyUrl,
  rewriteMarkdownLinks,
} from "../../tools/docs-site/.vitepress/site.ts";

const SITE: SiteFacts = {
  hostname: "https://example.github.io/site/",
  base: "/site/",
  titleSuffix: " | site",
  image: { url: "https://example.github.io/site/og.png", width: 1280, height: 640, alt: "A & B" },
};
const URL = "https://example.github.io/site/user/page";

function page(head: string): string {
  return `<!DOCTYPE html><html><head>${head}</head><body></body></html>`;
}

const GOOD_HEAD = [
  "<title>A page | site</title>",
  '<meta name="description" content="What the page answers &amp; why.">',
  `<link rel="canonical" href="${URL}">`,
  `<meta property="og:url" content="${URL}">`,
  '<meta property="og:title" content="A page | site">',
  '<meta property="og:description" content="What the page answers &amp; why.">',
  '<meta property="og:image" content="https://example.github.io/site/og.png">',
  '<meta property="og:image:width" content="1280">',
  '<meta property="og:image:height" content="640">',
  '<meta property="og:image:alt" content="A &amp; B">',
  '<meta name="twitter:card" content="summary_large_image">',
  '<meta name="twitter:image" content="https://example.github.io/site/og.png">',
  '<meta name="twitter:image:alt" content="A &amp; B">',
].join("\n");

const IMAGE_KEYS = [
  "og:image",
  "og:image:width",
  "og:image:height",
  "og:image:alt",
  "twitter:image",
  "twitter:image:alt",
];

function check(head: string, description?: string): string[] {
  return headProblems("page.md", page(head), URL, description, SITE);
}

function landing(json: string): string {
  return page(`<script type="application/ld+json">${json}</script>`);
}

describe("headProblems", () => {
  it("passes a complete head, with the frontmatter description", () => {
    assert.deepEqual(check(GOOD_HEAD, "What the page answers & why."), []);
  });

  it("reports a missing, a second and a wrong canonical", () => {
    assert.match(check(GOOD_HEAD.replace(/<link rel="canonical"[^>]*>/, "")).join(), /0 canonical/);
    assert.match(check(`${GOOD_HEAD}<link rel="canonical" href="${URL}">`).join(), /2 canonical/);
    assert.match(
      check(GOOD_HEAD.replace(`href="${URL}"`, `href="${URL}.html"`)).join(),
      /canonical is/,
    );
  });

  it("reports a title without the suffix", () => {
    assert.match(
      check(GOOD_HEAD.replace("A page | site</title>", "A page</title>")).join(),
      /title/,
    );
  });

  it("reports a description that differs from the frontmatter", () => {
    assert.match(check(GOOD_HEAD, "Something else.").join(), /differs from the frontmatter/);
  });

  it("reports each missing Open Graph or Twitter tag, and a wrong og:url", () => {
    for (const key of ["og:url", "og:title", "og:description", "twitter:card", ...IMAGE_KEYS]) {
      const head = GOOD_HEAD.split("\n")
        .filter((line) => !line.includes(`"${key}"`))
        .join("\n");
      assert.match(check(head).join(), new RegExp(`0 ${key} tags`));
    }
    assert.match(
      check(GOOD_HEAD.replace(`content="${URL}"`, 'content="https://x"')).join(),
      /og:url is/,
    );
  });

  it("reports an image tag that names another image, size or alt text", () => {
    const changes: [string, string][] = [
      ['property="og:image" content="https://example.github.io/site/og.png"', "og:image is"],
      ['name="twitter:image" content="https://example.github.io/site/og.png"', "twitter:image is"],
      ['content="1280"', "og:image:width is"],
      ['content="640"', "og:image:height is"],
      ['property="og:image:alt" content="A &amp; B"', "og:image:alt is"],
      ['name="twitter:image:alt" content="A &amp; B"', "twitter:image:alt is"],
    ];
    for (const [attributes, message] of changes) {
      const changed = attributes.replace(/content="[^"]*"/, 'content="other"');
      assert.ok(GOOD_HEAD.includes(attributes), attributes);
      assert.match(check(GOOD_HEAD.replace(attributes, changed)).join(), new RegExp(message));
    }
  });
});

/** A PNG's first 24 bytes: the signature, then an IHDR chunk with this width and height. */
function pngHeader(width: number, height: number, length = 24): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("pngProblems", () => {
  const EXPECTED = { width: 1280, height: 640, maxBytes: 1000 };

  it("passes a PNG of the expected size", () => {
    assert.deepEqual(pngProblems("og.png", pngHeader(1280, 640), EXPECTED), []);
  });

  it("reports a file that is not a PNG, or too short to hold the header", () => {
    const jpeg = new Uint8Array(24);
    jpeg.set([0xff, 0xd8, 0xff]);
    assert.match(pngProblems("og.png", jpeg, EXPECTED).join(), /not a PNG/);
    assert.match(
      pngProblems("og.png", pngHeader(1280, 640).subarray(0, 20), EXPECTED).join(),
      /not a PNG/,
    );
  });

  it("reports a PNG whose first chunk is not IHDR", () => {
    const bytes = pngHeader(1280, 640);
    bytes.set(new TextEncoder().encode("IDAT"), 12);
    assert.match(pngProblems("og.png", bytes, EXPECTED).join(), /IHDR/);
  });

  it("reports another width or height", () => {
    assert.match(pngProblems("og.png", pngHeader(1200, 630), EXPECTED).join(), /1200x630 pixels/);
    assert.match(pngProblems("og.png", pngHeader(1280, 641), EXPECTED).join(), /1280x641 pixels/);
  });

  it("reports a file over the byte limit, and accepts one at it", () => {
    assert.deepEqual(pngProblems("og.png", pngHeader(1280, 640, 1000), EXPECTED), []);
    assert.match(pngProblems("og.png", pngHeader(1280, 640, 1001), EXPECTED).join(), /1001 bytes/);
  });
});

describe("iconProblems", () => {
  const ICONS = [
    { href: "/site/favicon.svg", type: "image/svg+xml" },
    { href: "/site/favicon-32.png", type: "image/png" },
  ];
  const HEAD =
    '<html><head><link rel="icon" type="image/svg+xml" href="/site/favicon.svg">' +
    '<link rel="icon" type="image/png" sizes="32x32" href="/site/favicon-32.png"></head>' +
    '<body><link rel="icon" href="/site/body.svg"></body></html>';

  it("passes a head that links each favicon once with its type", () => {
    assert.deepEqual(iconProblems("p.html", HEAD, ICONS), []);
  });

  it("reports a missing or repeated favicon link", () => {
    const missing = HEAD.replace(/<link rel="icon" type="image\/png"[^>]*>/, "");
    assert.match(
      iconProblems("p.html", missing, ICONS).join(),
      /0 icon links to \/site\/favicon-32\.png/,
    );
    const twice = HEAD.replace(
      "</head>",
      '<link rel="icon" type="image/svg+xml" href="/site/favicon.svg"></head>',
    );
    assert.match(
      iconProblems("p.html", twice, ICONS).join(),
      /2 icon links to \/site\/favicon\.svg/,
    );
  });

  it("reports a favicon link with another type, and ignores links outside the head", () => {
    const wrong = HEAD.replace('type="image/png"', 'type="image/x-icon"');
    assert.match(
      iconProblems("p.html", wrong, ICONS).join(),
      /type image\/x-icon, expected image\/png/,
    );
    assert.match(
      iconProblems("p.html", HEAD, [{ href: "/site/body.svg", type: "image/svg+xml" }]).join(),
      /0 icon links/,
    );
  });
});

describe("frontmatterDescription", () => {
  it("reads plain and quoted values, and none", () => {
    assert.equal(frontmatterDescription("---\ndescription: Plain text\n---\n# T\n"), "Plain text");
    assert.equal(frontmatterDescription('---\ndescription: "Say \\"hi\\""\n---\n'), 'Say "hi"');
    assert.equal(frontmatterDescription("---\ndescription: 'It''s'\n---\n"), "It's");
    assert.equal(frontmatterDescription("# No frontmatter\n"), undefined);
  });

  it("reads a folded value", () => {
    assert.equal(
      frontmatterDescription("---\ndescription: >-\n  folded\n  text\n---\n"),
      "folded text",
    );
  });
});

describe("siteLinks", () => {
  it("keeps links on the site, without the base path, and splits the anchor", () => {
    const html =
      '<a href="/site/user/page#step-2">x</a><a href="https://example.github.io/site/">y</a>' +
      '<a href="https://github.com/x">z</a><img src="/site/assets/a.png">';
    assert.deepEqual(siteLinks("a.html", html, SITE), {
      links: [
        { path: "user/page", anchor: "step-2" },
        { path: "", anchor: undefined },
        { path: "assets/a.png", anchor: undefined },
      ],
      problems: [],
    });
  });

  it("resolves relative links and bare anchors against the page's clean URL", () => {
    const html =
      '<a href="./setup#step-2">a</a><a href="./../reference/tasks">b</a><a href="#top">c</a>';
    assert.deepEqual(siteLinks("user/guides/page.html", html, SITE).links, [
      { path: "user/guides/setup", anchor: "step-2" },
      { path: "user/reference/tasks", anchor: undefined },
      { path: "user/guides/page", anchor: "top" },
    ]);
    assert.deepEqual(
      siteLinks("user/reference/api/index.html", '<a href="./types">t</a>', SITE).links,
      [{ path: "user/reference/api/types", anchor: undefined }],
    );
  });

  it("reports a root link without the base path, which 404s on GitHub Pages", () => {
    assert.deepEqual(siteLinks("a.html", '<a href="/user/page">x</a>', SITE).problems, [
      "a.html: the link /user/page does not start with /site/",
    ]);
  });

  it("ignores links inside scripts and code blocks", () => {
    const html = '<script>const a = \' href="/x"\';</script><pre><code> href="/y"</code></pre>';
    assert.deepEqual(siteLinks("a.html", html, SITE), { links: [], problems: [] });
  });
});

describe("outputCandidates", () => {
  it("maps clean URLs to the files GitHub Pages serves", () => {
    assert.deepEqual(outputCandidates(""), ["index.html"]);
    assert.deepEqual(outputCandidates("user/reference/api/"), ["user/reference/api/index.html"]);
    assert.deepEqual(outputCandidates("user/page"), ["user/page.html", "user/page/index.html"]);
    assert.deepEqual(outputCandidates("assets/app.js"), ["assets/app.js"]);
  });
});

describe("sitemap and robots.txt", () => {
  it("reads the sitemap's URLs", () => {
    const xml = `<urlset><url><loc>${URL}</loc></url><url><loc>${SITE.hostname}</loc></url></urlset>`;
    assert.deepEqual(sitemapUrls(xml), new Set([URL, SITE.hostname]));
  });

  it("needs robots.txt to name the sitemap", () => {
    assert.deepEqual(
      robotsProblems(`User-agent: *\nAllow: /\n\nSitemap: ${SITE.hostname}sitemap.xml\n`, SITE),
      [],
    );
    assert.equal(robotsProblems("User-agent: *\nAllow: /\n", SITE).length, 1);
  });
});

describe("jsonLdProblems", () => {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "site",
    codeRepository: "https://github.com/x/site",
    programmingLanguage: "TypeScript",
    runtimePlatform: "Node.js >=22.13",
    license: "https://opensource.org/licenses/MIT",
    author: { "@type": "Person", name: "A" },
    version: "1.2.3",
    url: SITE.hostname,
  };
  it("passes a complete block", () => {
    assert.deepEqual(jsonLdProblems(landing(JSON.stringify(data)), "1.2.3", SITE), []);
  });

  it("reports no block, invalid JSON, a wrong type, a missing field and a stale version", () => {
    assert.match(jsonLdProblems(page(""), "1.2.3", SITE).join(), /0 JSON-LD blocks/);
    assert.match(jsonLdProblems(landing("{"), "1.2.3", SITE).join(), /not JSON/);
    const wrongType = JSON.stringify({ ...data, "@type": "WebSite" });
    assert.match(jsonLdProblems(landing(wrongType), "1.2.3", SITE).join(), /SoftwareSourceCode/);
    const { license: _license, ...withoutLicense } = data;
    assert.match(
      jsonLdProblems(landing(JSON.stringify(withoutLicense)), "1.2.3", SITE).join(),
      /no license/,
    );
    assert.match(
      jsonLdProblems(landing(JSON.stringify(data)), "2.0.0", SITE).join(),
      /expected 2\.0\.0/,
    );
  });
});

describe("markdownLinkProblems", () => {
  const built = new Set(["user/page.md", "user/reference/api/types.md", "index.html"]);
  const exists = (path: string): boolean => built.has(path) || built.has(`${path}index.html`);
  const checkLinks = (text: string): string[] =>
    markdownLinkProblems("llms.txt", text, SITE, exists);

  it("passes absolute links to built files, anchors, other hosts and code", () => {
    const text = [
      "- [Page](https://example.github.io/site/user/page.md)",
      "- [Types](https://example.github.io/site/user/reference/api/types.md#kmsconfig)",
      "- [Home](https://example.github.io/site/)",
      "[npm](https://www.npmjs.com/package/x) [here](#section)",
      "```md",
      "[not a link](../somewhere.md)",
      "```",
      "`[inline](../code.md)`",
    ].join("\n");
    assert.deepEqual(checkLinks(text), []);
  });

  it("reports a link on the host without the base path, as nested sidebar groups produced", () => {
    assert.deepEqual(
      checkLinks("- [Types](https://example.github.io/user/reference/api/types.md)"),
      [
        "llms.txt: the link https://example.github.io/user/reference/api/types.md does not start with https://example.github.io/site/",
      ],
    );
  });

  it("reports a link to a file that was not built, and a url: line", () => {
    assert.match(
      checkLinks("[x](https://example.github.io/site/user/nope.md)").join(),
      /no built file/,
    );
    assert.match(
      checkLinks("---\nurl: https://example.github.io/site/user/gone.md\n---\n").join(),
      /gone\.md resolves to no built file/,
    );
    assert.match(
      checkLinks("---\nurl: >-\n  https://example.github.io/user/folded.md\n---\n").join(),
      /folded\.md does not start with/,
    );
  });

  it("reports relative links, which break once the copies are joined", () => {
    assert.match(checkLinks("[c](../../contributor/transactions.md)").join(), /is relative/);
    assert.match(checkLinks("[r](/user/page.md)").join(), /is relative/);
  });

  it("reads inline links and url: lines", () => {
    assert.deepEqual(markdownLinkTargets("a [b](c.md) `[d](e.md)`\nurl: https://x/y.md\n"), [
      "c.md",
      "https://x/y.md",
    ]);
  });
});

describe("rewriteMarkdownLinks and markdownCopyUrl", () => {
  it("rewrites links outside code only", () => {
    const text = "[a](x.md) `[b](x.md)`\n```\n[c](x.md)\n```\n[d](y.md#z)";
    assert.equal(
      rewriteMarkdownLinks(text, (target) => (target.startsWith("x") ? "X" : undefined)),
      "[a](X) `[b](x.md)`\n```\n[c](x.md)\n```\n[d](y.md#z)",
    );
  });

  it("names the Markdown copy of a page, of a folder index and of the landing page", () => {
    assert.equal(markdownCopyUrl("user/guides/key-loss.md"), `${HOSTNAME}user/guides/key-loss.md`);
    assert.equal(
      markdownCopyUrl("user/reference/api/README.md"),
      `${HOSTNAME}user/reference/api.md`,
    );
    assert.equal(markdownCopyUrl("README.md"), HOSTNAME);
  });
});
