// Checks every publishable package in packages/ the way npm users will get it: publint on the
// package contents, and arethetypeswrong on the packed tarball (ESM only). Run after a build.
//
// Usage: node scripts/check-packages.ts
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

for (const directory of packages) {
  process.stdout.write(`\n== ${path.relative(root, directory)}\n`);
  execFileSync(bin("publint"), ["--strict"], { cwd: directory, stdio: "inherit", shell });
  execFileSync(bin("attw"), ["--pack", ".", "--profile", "esm-only"], {
    cwd: directory,
    stdio: "inherit",
    shell,
  });
}
