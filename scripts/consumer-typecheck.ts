// Type-check a fresh consumer project against the packed packages with a given TypeScript version.
// Proves the published .d.ts files work for users who are not on TypeScript 7.
//
// Usage: node scripts/consumer-typecheck.ts <typescript-version>
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// Package directories, which keep their names; the provider packages are named @hardhat-kms/<id>.
const packages = [
  "packages/hardhat-kms",
  "packages/hardhat-kms-aws",
  "packages/hardhat-kms-azure",
  "packages/hardhat-kms-gcp",
].map((directory) => path.join(root, directory));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";
const run = (command: string, args: string[], cwd: string): void => {
  execFileSync(command, args, { cwd, stdio: "inherit", shell });
};

run(pnpm, ["run", "build"], root);
// pnpm pack replaces workspace: ranges with real versions, as publishing does.
const pack = (directory: string): string =>
  execFileSync(pnpm, ["pack", "--json", "--pack-destination", tmpdir()], {
    cwd: directory,
    shell,
  }).toString();
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
const tarballs = packages.map((directory) => tarballPath(pack(directory)));

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
      'import type { ExternalKmsKeyConfig, KmsHooks, KmsKeyAdapter, KmsKeyCommonUserConfig, SignContext } from "hardhat-kms/types";',
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
      "// The core passes only signal, displayMessage and requestId.",
      "export function requestIdOf(context: SignContext): string {",
      "  // @ts-expect-error -- SignContext has no idempotencyKey.",
      "  void context.idempotencyKey;",
      "  // @ts-expect-error -- SignContext has no chainId.",
      "  void context.chainId;",
      "  return context.requestId;",
      "}",
      "export const context: SignContext = {",
      "  signal: new AbortController().signal,",
      "  displayMessage: async () => {},",
      '  requestId: "r",',
      "  // @ts-expect-error -- SignContext has no chainId.",
      "  chainId: 1n,",
      "};",
      "",
    ].join("\n"),
  );
  // A user of the AWS package, who imports nothing from hardhat-kms: the `kms` config types must
  // come with @hardhat-kms/aws.
  writeFileSync(
    path.join(consumer, "tsconfig.aws.json"),
    JSON.stringify({ extends: "./tsconfig.json", include: ["aws-only.config.ts"] }, null, 2),
  );
  writeFileSync(
    path.join(consumer, "aws-only.config.ts"),
    [
      'import { configVariable, defineConfig } from "hardhat/config";',
      'import hardhatKmsAws from "@hardhat-kms/aws";',
      "",
      "export default defineConfig({",
      "  plugins: [hardhatKmsAws],",
      "  kms: {",
      "    keys: {",
      '      deployer: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" },',
      "      // @ts-expect-error -- `keyID` is not a field; the user meant `keyId`.",
      '      typo: { provider: "aws", keyID: "alias/x" },',
      "    },",
      "  },",
      "  networks: {",
      '    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  // A user of the Azure package, who imports nothing from hardhat-kms.
  writeFileSync(
    path.join(consumer, "tsconfig.azure.json"),
    JSON.stringify({ extends: "./tsconfig.json", include: ["azure-only.config.ts"] }, null, 2),
  );
  writeFileSync(
    path.join(consumer, "azure-only.config.ts"),
    [
      'import { configVariable, defineConfig } from "hardhat/config";',
      'import hardhatKmsAzure from "@hardhat-kms/azure";',
      "",
      "export default defineConfig({",
      "  plugins: [hardhatKmsAzure],",
      "  kms: {",
      "    keys: {",
      '      deployer: { provider: "azure", keyId: configVariable("AZURE_KEY_VAULT_KEY_ID") },',
      '      ops: { provider: "azure", vaultUrl: "https://ops.vault.azure.net", keyName: "ops", keyVersion: "0123abcd" },',
      "      // @ts-expect-error -- `keyUrl` is not a field; the user meant `keyId`.",
      '      typo: { provider: "azure", keyUrl: "https://ops.vault.azure.net/keys/ops" },',
      "    },",
      "  },",
      "  networks: {",
      '    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  // A user of the Google Cloud package, who imports nothing from hardhat-kms.
  writeFileSync(
    path.join(consumer, "tsconfig.gcp.json"),
    JSON.stringify({ extends: "./tsconfig.json", include: ["gcp-only.config.ts"] }, null, 2),
  );
  writeFileSync(
    path.join(consumer, "gcp-only.config.ts"),
    [
      'import { configVariable, defineConfig } from "hardhat/config";',
      'import hardhatKmsGcp from "@hardhat-kms/gcp";',
      "",
      "export default defineConfig({",
      "  plugins: [hardhatKmsGcp],",
      "  kms: {",
      "    keys: {",
      '      deployer: { provider: "gcp", keyVersionName: configVariable("GCP_KEY_VERSION_NAME") },',
      '      parts: { provider: "gcp", projectId: "p", location: "europe-west1", keyRing: "r", keyName: "k", keyVersion: 1 },',
      "      // @ts-expect-error -- `keyVersion` is required: the plugin never picks a version.",
      '      unversioned: { provider: "gcp", projectId: "p", location: "europe-west1", keyRing: "r", keyName: "k" },',
      "    },",
      "  },",
      "  networks: {",
      '    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumer, "hardhat.config.ts"),
    [
      'import { configVariable, defineConfig } from "hardhat/config";',
      'import hardhatKms from "hardhat-kms";',
      'import type { HardhatPlugin } from "hardhat/types/plugins";',
      'import type { ExternalKmsKeyConfig, KmsHooks, KmsKeyAdapter, KmsKeyCommonUserConfig, KmsKeyConfig, KmsUserConfig } from "hardhat-kms/types";',
      'import type { NetworkConnection } from "hardhat/types/network";',
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
      "// `approvalTimeoutMs` is not a field: `timeoutMs` bounds every KMS call.",
      "export const approvalKey: KmsUserConfig = {",
      "  // @ts-expect-error -- not a key field.",
      '  keys: { approval: { provider: "aws", keyId: "alias/x", approvalTimeoutMs: 600_000 } },',
      "};",
      "export const approvalDefaults: KmsUserConfig = {",
      "  // @ts-expect-error -- not a kms.defaults field either.",
      "  defaults: { timeoutMs: 30_000, approvalTimeoutMs: 600_000 },",
      "};",
      "",
      "// A third-party plugin adds the provider through the kms hook.",
      "declare const vaultAdapter: KmsKeyAdapter;",
      "export const myVaultPlugin: HardhatPlugin = {",
      '  id: "@acme/hardhat-myvault",',
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
      "// The library account is typed without viem, which this project does not install.",
      "export async function libraryAccount(connection: NetworkConnection): Promise<string> {",
      '  const account = await connection.kms.getAccount("0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826");',
      "  // @ts-expect-error -- without rawSign the account has no `sign`.",
      "  void account.sign;",
      "  const raw = await connection.kms.getAccount(account.address, { rawSign: true });",
      '  await raw.sign({ hash: `0x${"00".repeat(32)}` });',
      "  const signed = await account.signAuthorization({ contractAddress: account.address, chainId: 1, nonce: 0 });",
      "  const yParity: number = signed.yParity;",
      "  void yParity;",
      "  // @ts-expect-error -- a signed authorization has no `v`; read `yParity`.",
      "  void signed.v;",
      '  return await account.signMessage({ message: "hello" });',
      "}",
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
      ...tarballs,
      `hardhat@${hardhatVersion}`,
      `typescript@${typescriptVersion}`,
      "@types/node@22",
    ],
    consumer,
  );
  // viem is an optional peer dependency: npm does not install it, and nothing above may need it.
  if (existsSync(path.join(consumer, "node_modules", "viem"))) {
    throw new Error(
      "viem is installed in the consumer project; this check needs a project without it",
    );
  }
  const tsc = path.join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  for (const project of [
    "tsconfig.json",
    "tsconfig.plugin.json",
    "tsconfig.aws.json",
    "tsconfig.azure.json",
    "tsconfig.gcp.json",
  ]) {
    execFileSync(tsc, ["-p", project], { cwd: consumer, stdio: "inherit", shell });
  }
  // At run time, in the same project without viem: Hardhat loads the plugin, and getAccount fails
  // with a message that names the package.
  writeFileSync(
    path.join(consumer, "runtime.config.ts"),
    [
      'import hardhatKms from "hardhat-kms";',
      "",
      "export default {",
      "  plugins: [hardhatKms],",
      "  networks: {",
      '    local: { type: "edr-simulated", kmsAccounts: [{ provider: "aws", keyId: "alias/none", region: "us-east-1", address: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" }] },',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumer, "get-account.ts"),
    [
      'import { network } from "hardhat";',
      "",
      'const connection = await network.create("local");',
      "try {",
      '  await connection.kms.getAccount("0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826");',
      '  console.log("getAccount returned an account");',
      "} catch (error) {",
      "  console.log(`getAccount: ${error instanceof Error ? error.message : String(error)}`);",
      "}",
      "await connection.close();",
      "",
    ].join("\n"),
  );
  const hardhatCli = path.join(consumer, "node_modules", "hardhat", "dist", "src", "cli.js");
  const runtime = execFileSync(
    process.execPath,
    [hardhatCli, "--config", "runtime.config.ts", "run", "--no-compile", "get-account.ts"],
    { cwd: consumer, encoding: "utf8" },
  );
  if (!runtime.includes("connection.kms.getAccount needs the viem package")) {
    throw new Error(`getAccount without viem did not name the package:\n${runtime}`);
  }
  process.stdout.write(`consumer typecheck passed with TypeScript ${typescriptVersion}\n`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
  for (const tarball of tarballs) {
    rmSync(tarball, { force: true });
  }
}
