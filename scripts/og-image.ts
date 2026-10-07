// Renders the social preview, docs/public/og-image.svg, to a PNG with the fonts under
// tools/docs-site/fonts and no system font, so every machine draws the same card.
// scripts/render-og-image.ts (`pnpm run docs:og`) writes docs/public/og-image.png, and
// scripts/check-site.ts renders the SVG again and compares the result with that file.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fonts = path.join(root, "tools/docs-site/fonts");

/** The social preview's source, which the card is edited in. */
export const OG_IMAGE_SVG: string = path.join(root, "docs/public/og-image.svg");

/** The PNG rendered from {@link OG_IMAGE_SVG}, which the site serves. */
export const OG_IMAGE_PNG: string = path.join(root, "docs/public/og-image.png");

/** The only font families the card may name, each with a licence file next to its fonts. */
export const OG_FONT_FAMILIES: readonly string[] = ["Inter", "JetBrains Mono"];

/** The static font files the renderer loads: one file per weight the card uses. */
export const OG_FONT_FILES: readonly string[] = [
  "inter/Inter-Regular.ttf",
  "inter/Inter-SemiBold.ttf",
  "inter/Inter-Bold.ttf",
  "jetbrains-mono/JetBrainsMono-SemiBold.ttf",
].map((file) => path.join(fonts, file));

/**
 * Renders an SVG to PNG bytes at the SVG's own size, with the given font files and no system font.
 * A family the files do not hold falls back to Inter, so a missing font changes the pixels and the
 * site check reports it instead of picking up whatever the machine has.
 *
 * @param svg - The SVG source.
 * @param fontFiles - The font files to load.
 * @returns The PNG file's bytes.
 */
export function renderOgImage(svg: string, fontFiles: readonly string[]): Uint8Array {
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: [...fontFiles],
      defaultFontFamily: "Inter",
    },
  });
  return new Uint8Array(resvg.render().asPng());
}
