// Checks every publishable package in packages/ the way npm users will get it: publint on the
// package contents, and arethetypeswrong on the packed tarball (ESM only). Run after a build.
// It also fails when a package takes TypeScript from the typescript6 catalog.
//
// Usage: node scripts/check-packages.ts
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pack, withPackDirectory } from "./pack.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = process.platform === "win32";
const bin = (name: string): string =>
  path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

const packages = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, "packages", entry.name))
  .filter((directory) => {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    return !(
      typeof manifest === "object" &&
      manifest !== null &&
      "private" in manifest &&
      manifest.private === true
    );
  });

// TypeScript 6 is for tools/api-docs only (decision 0012). A package under packages/ that takes it
// from the typescript6 catalog would build or typecheck on the wrong compiler.
const onTypescript6 = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.posix.join("packages", entry.name, "package.json"))
  .filter((file) => readFileSync(path.join(root, file), "utf8").includes('"catalog:typescript6"'));
if (onTypescript6.length > 0) {
  throw new Error(
    `${onTypescript6.join(", ")}: the typescript6 catalog is for tools/api-docs only; use catalog: (TypeScript 7)`,
  );
}

withPackDirectory((destination) => {
  for (const directory of packages) {
    process.stdout.write(`\n== ${path.relative(root, directory)}\n`);
    execFileSync(bin("publint"), ["--strict"], { cwd: directory, stdio: "inherit", shell });
    // Check the tarball pnpm publishes (workspace: and catalog: ranges replaced), not an npm pack.
    execFileSync(bin("attw"), [pack(directory, destination), "--profile", "esm-only"], {
      cwd: directory,
      stdio: "inherit",
      shell,
    });
  }
});
