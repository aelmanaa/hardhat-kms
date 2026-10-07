// Writes docs/public/og-image.png from docs/public/og-image.svg with the vendored fonts
// (scripts/og-image.ts). Run it after every edit of the SVG; `pnpm run docs:site:check` fails
// while the PNG is out of date.
//
// Usage: pnpm run docs:og
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { OG_FONT_FILES, OG_IMAGE_PNG, OG_IMAGE_SVG, renderOgImage } from "./og-image.ts";

const png = renderOgImage(readFileSync(OG_IMAGE_SVG, "utf8"), OG_FONT_FILES);
writeFileSync(OG_IMAGE_PNG, png);
process.stdout.write(`wrote ${path.basename(OG_IMAGE_PNG)}: ${png.length} bytes\n`);
