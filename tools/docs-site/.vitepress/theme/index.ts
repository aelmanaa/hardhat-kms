// The default theme, with Mermaid diagrams drawn in the browser. The site config renders each
// ```mermaid block as <pre class="mermaid">; Mermaid replaces it with an SVG after each page load,
// and again in the other colour scheme when the reader switches it.
import { onContentUpdated, useData } from "vitepress";
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { defineComponent, h, watch } from "vue";

async function drawDiagrams(dark: boolean): Promise<void> {
  const blocks = [...document.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (blocks.length === 0) {
    return;
  }
  for (const block of blocks) {
    // Keep the source, so the diagram can be drawn again in the other scheme.
    block.dataset["source"] ??= block.textContent ?? "";
    block.removeAttribute("data-processed");
    block.textContent = block.dataset["source"];
  }
  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
    });
    await mermaid.run({ nodes: blocks });
  } catch {
    // A diagram that fails to draw, or a page left mid-draw, shows its source instead.
    for (const block of blocks) {
      block.textContent = block.dataset["source"] ?? "";
    }
  }
}

// Draws run one at a time: a page load and a scheme switch, or two quick switches, would
// otherwise draw the same blocks at once. A request that a newer one replaced while it waited
// is skipped.
let queue: Promise<void> = Promise.resolve();
let latest = 0;

function scheduleDraw(dark: boolean): void {
  latest += 1;
  const request = latest;
  queue = queue.then(async () => {
    if (request === latest) {
      await drawDiagrams(dark);
    }
    return undefined;
  });
}

const Layout = defineComponent({
  setup() {
    const { isDark } = useData();
    onContentUpdated(() => {
      scheduleDraw(isDark.value);
    });
    watch(isDark, (dark) => {
      scheduleDraw(dark);
    });
    return () => h(DefaultTheme.Layout);
  },
});

const theme: Theme = { extends: DefaultTheme, Layout };

export default theme;
