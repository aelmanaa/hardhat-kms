// Type-check a fresh consumer project against the packed plugin with a given TypeScript version.
// Proves the published .d.ts files work for users who are not on TypeScript 7.
//
// Usage: node scripts/consumer-typecheck.ts <typescript-version>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const typescriptVersion = process.argv[2];
if (typescriptVersion === undefined) {
  process.stderr.write("usage: node scripts/consumer-typecheck.ts <typescript-version>\n");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginPackage = path.join(root, "packages", "hardhat-kms");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";
const run = (command: string, args: string[], cwd: string): void => {
  execFileSync(command, args, { cwd, stdio: "inherit", shell });
};

run(pnpm, ["run", "build"], root);
// pnpm pack replaces workspace: ranges with real versions, as publishing does.
const packOutput = execFileSync(pnpm, ["pack", "--json", "--pack-destination", tmpdir()], {
  cwd: pluginPackage,
  shell,
});
/**
 * Extracts the tarball path from `pnpm pack --json` output.
 *
 * @param output - The raw JSON printed by `pnpm pack --json`.
 * @returns The tarball path.
 */
function tarballPath(output: string): string {
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "filename" in parsed &&
    typeof parsed.filename === "string"
  ) {
    return parsed.filename;
  }
  throw new Error("pnpm pack did not report a tarball filename");
}
const tarball = tarballPath(packOutput.toString());

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
  // A provider package, compiled on its own: it imports only hardhat-kms/types, so the hook types
  // must come from that entry point. (Real plugins also declare `dependencies`, which would load
  // the main entry point and hide a missing type extension, so this one does not.)
  writeFileSync(
    path.join(consumer, "tsconfig.plugin.json"),
    JSON.stringify({ extends: "./tsconfig.json", include: ["provider-plugin.ts"] }, null, 2),
  );
  writeFileSync(
    path.join(consumer, "provider-plugin.ts"),
    [
      'import type { HardhatPlugin } from "hardhat/types/plugins";',
      'import type { ExternalKmsKeyConfig, KmsHooks, KmsKeyAdapter, KmsKeyCommonUserConfig } from "hardhat-kms/types";',
      "",
      'declare module "hardhat-kms/types" {',
      "  interface KmsProviderUserConfigs {",
      '    othervault: { provider: "othervault"; vaultPath: string } & KmsKeyCommonUserConfig;',
      "  }",
      "  interface KmsProviderConfigs {",
      '    othervault: ExternalKmsKeyConfig<"othervault">;',
      "  }",
      "}",
      "",
      'declare function createOtherVaultAdapter(key: ExternalKmsKeyConfig<"othervault">): Promise<KmsKeyAdapter>;',
      "",
      "const plugin: HardhatPlugin = {",
      '  id: "hardhat-kms-othervault",',
      "  hookHandlers: {",
      "    kms: async () => ({",
      "      default: async (): Promise<Partial<KmsHooks>> => ({",
      "        createKeyAdapter: async (context, key, next) => {",
      "          // @ts-expect-error -- hook handlers get the runtime without tasks.",
      "          void context.tasks;",
      "          // @ts-expect-error -- provider-specific fields exist only after narrowing.",
      "          void key.vaultPath;",
      '          if (key.provider === "othervault") {',
      "            // @ts-expect-error -- userConfig values are unknown until the provider validates them.",
      "            const vaultPath: string = key.userConfig.vaultPath;",
      "            void vaultPath;",
      "            return await createOtherVaultAdapter(key);",
      "          }",
      "          // @ts-expect-error -- next returns an adapter, not a string.",
      "          const wrong: string = await next(context, key);",
      "          void wrong;",
      "          return await next(context, key);",
      "        },",
      "      }),",
      "    }),",
      "  },",
      "};",
      "",
      "export default plugin;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumer, "hardhat.config.ts"),
    [
      'import { configVariable, defineConfig } from "hardhat/config";',
      'import hardhatKms from "hardhat-kms";',
      'import type { HardhatPlugin } from "hardhat/types/plugins";',
      'import type { ExternalKmsKeyConfig, KmsHooks, KmsKeyAdapter, KmsKeyCommonUserConfig, KmsKeyConfig } from "hardhat-kms/types";',
      "",
      "// A third-party provider adds its key type.",
      'declare module "hardhat-kms/types" {',
      "  interface KmsProviderUserConfigs {",
      '    myvault: { provider: "myvault"; keyPath: string } & KmsKeyCommonUserConfig;',
      "  }",
      "  interface KmsProviderConfigs {",
      '    myvault: ExternalKmsKeyConfig<"myvault">;',
      "  }",
      "}",
      "",
      "export default defineConfig({",
      "  plugins: [hardhatKms],",
      "  kms: {",
      '    defaults: { aws: { region: "eu-west-1" }, timeoutMs: 30_000 },',
      "    keys: {",
      '      deployer: { provider: "aws", keyId: configVariable("AWS_KMS_KEY_ID"), address: "0x0000000000000000000000000000000000000001" },',
      '      ops: { provider: "azure", keyId: "https://ops.vault.azure.net/keys/ops" },',
      '      treasury: { provider: "gcp", projectId: "p", location: "l", keyRing: "r", keyName: "k", keyVersion: 1 },',
      '      external: { provider: "myvault", keyPath: "a/b" },',
      "      // @ts-expect-error -- `keyID` is not a field; the user meant `keyId`.",
      '      typo: { provider: "aws", keyID: "alias/x" },',
      "    },",
      "  },",
      "  networks: {",
      '    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer", { provider: "aws", keyId: "alias/ops" }] },',
      "  },",
      "});",
      "",
      "// A third-party plugin adds the provider through the kms hook.",
      "declare const vaultAdapter: KmsKeyAdapter;",
      "export const myVaultPlugin: HardhatPlugin = {",
      '  id: "hardhat-kms-myvault",',
      "  hookHandlers: {",
      "    kms: async () => ({",
      "      default: async (): Promise<Partial<KmsHooks>> => ({",
      "        createKeyAdapter: async (context, key, next) =>",
      '          key.provider === "myvault" ? vaultAdapter : await next(context, key),',
      "      }),",
      "    }),",
      "  },",
      "};",
      "",
      "// Resolved configs are typed too.",
      "export function names(accounts: KmsKeyConfig[]): string[] {",
      "  return accounts.map((account) => account.displayId);",
      "}",
      "",
    ].join("\n"),
  );

  // The Hardhat version the plugin is developed against (the workspace catalog pins it).
  const hardhatManifest: unknown = JSON.parse(
    readFileSync(path.join(pluginPackage, "node_modules", "hardhat", "package.json"), "utf8"),
  );
  const hardhatVersion =
    typeof hardhatManifest === "object" && hardhatManifest !== null && "version" in hardhatManifest
      ? String(hardhatManifest.version)
      : "latest";
  run(
    npm,
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      tarball,
      `hardhat@${hardhatVersion}`,
      `typescript@${typescriptVersion}`,
      "@types/node@22",
    ],
    consumer,
  );
  const tsc = path.join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  for (const project of ["tsconfig.json", "tsconfig.plugin.json"]) {
    execFileSync(tsc, ["-p", project], { cwd: consumer, stdio: "inherit", shell });
  }
  process.stdout.write(`consumer typecheck passed with TypeScript ${typescriptVersion}\n`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
