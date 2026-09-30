// Type-check a fresh consumer project against the packed plugin with a given TypeScript version.
// Proves the published .d.ts files work for users who are not on TypeScript 7.
//
// Usage: node scripts/consumer-typecheck.ts <typescript-version>
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const typescriptVersion = process.argv[2];
if (typescriptVersion === undefined) {
  process.stderr.write("usage: node scripts/consumer-typecheck.ts <typescript-version>\n");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// npm.cmd needs a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";
const run = (args: string[], cwd: string): void => {
  execFileSync(npm, args, { cwd, stdio: "inherit", shell });
};

run(["run", "build"], root);
const packOutput = execFileSync(
  npm,
  ["pack", "--json", "--ignore-scripts", "--pack-destination", tmpdir()],
  {
    cwd: root,
  },
);
/**
 * Extracts the tarball filename from `npm pack --json` output.
 *
 * @param output - The raw JSON printed by `npm pack --json`.
 * @returns The tarball filename.
 */
function tarballFilename(output: string): string {
  const parsed: unknown = JSON.parse(output);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  if (
    typeof first === "object" &&
    first !== null &&
    "filename" in first &&
    typeof first.filename === "string"
  ) {
    return first.filename;
  }
  throw new Error("npm pack did not report a tarball filename");
}
const filename = tarballFilename(packOutput.toString());
const tarball = path.join(tmpdir(), filename);

const consumer = mkdtempSync(path.join(tmpdir(), "hardhat-kms-consumer-"));
try {
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
  );
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          types: ["node"],
          skipLibCheck: false,
        },
        include: ["hardhat.config.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(consumer, "hardhat.config.ts"),
    [
      'import { defineConfig } from "hardhat/config";',
      'import hardhatKms from "hardhat-kms";',
      "",
      "export default defineConfig({ plugins: [hardhatKms] });",
      "",
    ].join("\n"),
  );

  const hardhatVersion: unknown = JSON.parse(
    execFileSync(npm, ["pkg", "get", "devDependencies.hardhat"], { cwd: root }).toString(),
  );
  run(
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      tarball,
      `hardhat@${String(hardhatVersion)}`,
      `typescript@${typescriptVersion}`,
      "@types/node@22",
    ],
    consumer,
  );
  execFileSync(
    path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"),
    ["-p", "."],
    {
      cwd: consumer,
      stdio: "inherit",
    },
  );
  process.stdout.write(`consumer typecheck passed with TypeScript ${typescriptVersion}\n`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
