// Installs the packed hardhat-kms and @hardhat-kms/aws into scratch projects with npm, pnpm, Yarn
// classic and Yarn Berry, in the cases that put a peer dependency out of range, and checks what
// each package manager and the plugin do. Two run-time checks exist because some package managers
// install out-of-range peers: `core.account.viem-too-old` in getAccount and
// `core.provider.version-mismatch` in the provider packages. This script measures which ones do,
// so the docs can say so, and fails when a package manager's behaviour changes.
//
// The cases:
//   - control: viem in range and both packages at the same version. getAccount gets past both
//     checks and reaches the KMS endpoint.
//   - viem-pinned: viem 2.55.11, below the peer floor 2.55.13, as an exact version.
//   - viem-range: viem ~2.54.0, a range entirely below the floor.
//   - provider-mismatch: hardhat-kms one patch release ahead of the provider package, which asks
//     for the exact core version.
// For each it records the install's exit code, the viem that hardhat-kms resolves and what
// getAccount reports, then compares them with EXPECTED. A pnpm project also gets a run without
// `allowBuilds`, to check that pnpm stops on the dependencies' install scripts (esbuild from
// Hardhat, protobufjs from @hardhat-kms/gcp).
//
// No cloud calls: the AWS key's endpoint is a local HTTP server that answers every request with
// an error, and the environment holds fake AWS credentials only. The installs reach the npm
// registry. Yarn runs through corepack, which ships with Node 24 but not with Node 25 and later.
//
// Usage: node scripts/test-peer-installs.ts [--summary <file>] [package manager...]
//   With names from MANAGERS, such as "yarn berry", measures only those. --summary appends the
//   result table to a file, such as $GITHUB_STEP_SUMMARY. Linux and macOS only: it runs `env` and
//   `tar`.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { output, readJson, resolvedVersion, root, run } from "./temporary-install.ts";

/** The package managers measured, with the exact versions, so a result names what produced it. */
const YARN_CLASSIC = "1.22.22";
const YARN_BERRY = "4.18.1";
const MANAGERS = ["npm", "npm --legacy-peer-deps", "pnpm", "yarn classic", "yarn berry"] as const;
type Manager = (typeof MANAGERS)[number];

const CASES = ["control", "viem-pinned", "viem-range", "provider-mismatch"] as const;
type Case = (typeof CASES)[number];

/** What getAccount reported in the scratch project. */
type Outcome =
  /** Both checks passed and getAccount asked the (local) KMS endpoint for the public key. */
  | "reached KMS"
  | "core.account.viem-too-old"
  | "core.provider.version-mismatch"
  /** The install failed, so nothing ran. */
  | "not run"
  /** Anything else, with the message in the report. */
  | "other";

interface Result {
  exitCode: number;
  /** The viem that hardhat-kms resolves, or "-" when the install failed. */
  viem: string;
  outcome: Outcome;
}

/**
 * What a case should give: whether the install succeeds, the viem that hardhat-kms resolves (`-`
 * when the install fails, `workspace` for the version this repository resolves, `2.54.x` for any
 * 2.54 release) and what getAccount reports.
 */
interface Expected {
  installs: boolean;
  viem: string;
  outcome: Outcome;
}

/** Only npm refuses the out-of-range installs; every other package manager warns and goes on. */
const WARNS_ONLY: Record<Case, Expected> = {
  control: { installs: true, viem: "workspace", outcome: "reached KMS" },
  "viem-pinned": { installs: true, viem: "2.55.11", outcome: "core.account.viem-too-old" },
  "viem-range": { installs: true, viem: "2.54.x", outcome: "core.account.viem-too-old" },
  "provider-mismatch": {
    installs: true,
    viem: "workspace",
    outcome: "core.provider.version-mismatch",
  },
};

/** The measured behaviour. A difference fails the script; update the docs with this table. */
const EXPECTED: Record<Manager, Partial<Record<Case, Expected>>> = {
  npm: {
    control: WARNS_ONLY.control,
    "viem-pinned": { installs: false, viem: "-", outcome: "not run" },
    "viem-range": { installs: false, viem: "-", outcome: "not run" },
    "provider-mismatch": { installs: false, viem: "-", outcome: "not run" },
  },
  "npm --legacy-peer-deps": {
    "viem-pinned": WARNS_ONLY["viem-pinned"],
    "viem-range": WARNS_ONLY["viem-range"],
    "provider-mismatch": WARNS_ONLY["provider-mismatch"],
  },
  pnpm: WARNS_ONLY,
  "yarn classic": WARNS_ONLY,
  "yarn berry": WARNS_ONLY,
};

/** Whether a measured result is the expected one. */
function asExpected(
  expected: Expected | undefined,
  result: Result,
  workspaceViem: string,
): boolean {
  if (expected === undefined) {
    return false;
  }
  const viem =
    expected.viem === "workspace"
      ? result.viem === workspaceViem
      : expected.viem.endsWith(".x")
        ? result.viem.startsWith(expected.viem.slice(0, -1))
        : result.viem === expected.viem;
  return (
    expected.installs === (result.exitCode === 0) && viem && expected.outcome === result.outcome
  );
}

/** viem below the floor, as an exact version and as a range. */
const VIEM_PINNED = "2.55.11";
const VIEM_RANGE = "~2.54.0";
/** An arbitrary address for the key's pin; the local endpoint never returns its public key. */
const ADDRESS = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
/** Installs and Hardhat runs that take longer than this fail. */
const TIMEOUT_MS = 300_000;

const pnpm = "pnpm";
const npm = "npm";
const pluginDirectory = path.join(root, "packages", "hardhat-kms");

/** AWS settings that could point the SDK at real credentials or another endpoint. */
const AWS_UNSET = [
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SESSION_TOKEN",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_KMS",
  "AWS_DEFAULT_REGION",
];

/**
 * Wraps a command in `env`, which runs it with the caller's environment minus the AWS settings
 * above, with fake AWS credentials, no instance metadata and no prompts. The script does not read
 * the environment itself.
 */
function isolated(command: string, args: string[]): [string, string[]] {
  const settings = {
    AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE",
    AWS_SECRET_ACCESS_KEY: "fake",
    AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: path.join(tmpdir(), "hardhat-kms-no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(tmpdir(), "hardhat-kms-no-aws-credentials"),
    COPYFILE_DISABLE: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_STRICT: "0",
    // Berry makes installs immutable under CI=true, which a new project without a lockfile fails.
    YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  return [
    "env",
    [
      ...AWS_UNSET.flatMap((name) => ["-u", name]),
      ...Object.entries(settings).map(([name, value]) => `${name}=${value}`),
      command,
      ...args,
    ],
  ];
}

interface Completed {
  status: number;
  output: string;
}

/** Runs a command without blocking the event loop, so the local KMS endpoint can answer. */
async function exec(command: string, args: string[], cwd: string): Promise<Completed> {
  return await new Promise((resolve, reject) => {
    const child = spawn(...isolated(command, args), { cwd });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: status ?? (signal === null ? 1 : 128), output: text });
    });
  });
}

/** Packs a package as pnpm publishes it (workspace: and catalog: ranges replaced). */
function pack(directory: string, destination: string): string {
  const parsed: unknown = JSON.parse(
    output(["--dir", directory, "pack", "--json", "--pack-destination", destination]),
  );
  const filename: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "filename") : undefined;
  if (typeof filename !== "string") {
    throw new Error(`pnpm pack did not report a tarball for ${directory}`);
  }
  return filename;
}

/** The next patch release of a `major.minor.patch` version. */
function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new Error(`hardhat-kms has version ${version}; the script needs major.minor.patch`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** Repacks a tarball with another version in its package.json. */
function repack(tarball: string, version: string, work: string): string {
  const extracted = path.join(work, "repack");
  mkdirSync(extracted, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
  const manifestFile = path.join(extracted, "package", "package.json");
  writeFileSync(
    manifestFile,
    `${JSON.stringify({ ...readJson(manifestFile), version }, null, 2)}\n`,
  );
  const repacked = path.join(work, `hardhat-kms-${version}.tgz`);
  // isolated() sets COPYFILE_DISABLE, which keeps macOS tar from adding ._ files; Yarn classic
  // hangs on a tarball that has them.
  execFileSync(...isolated("tar", ["-czf", repacked, "-C", extracted, "package"]));
  return repacked;
}

/** A regular expression for the messages an error template produces. */
function templatePattern(template: string): RegExp {
  const parts = template
    .split(/\{[a-z]+\}/i)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join(".+?"));
}

/** The templates of the two run-time checks, read from the core's error catalogue. */
async function checkPatterns(): Promise<{ viemTooOld: RegExp; versionMismatch: RegExp }> {
  const file = path.join(pluginDirectory, "src", "internal", "error-catalog.ts");
  const module: unknown = await import(pathToFileURL(file).href);
  const errors: unknown =
    typeof module === "object" && module !== null ? Reflect.get(module, "ERRORS") : undefined;
  const template = (key: string, id: string): string => {
    const entry: unknown =
      typeof errors === "object" && errors !== null ? Reflect.get(errors, key) : undefined;
    const entryId: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "id") : undefined;
    const text: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "template") : undefined;
    if (entryId !== id || typeof text !== "string") {
      throw new Error(`the core's error catalogue has no ${key} entry with id ${id}`);
    }
    return text;
  };
  return {
    viemTooOld: templatePattern(template("accountViemTooOld", "core.account.viem-too-old")),
    versionMismatch: templatePattern(template("versionMismatch", "core.provider.version-mismatch")),
  };
}

/** A local stand-in for the KMS endpoint: it counts requests and answers each with an error. */
async function startKmsEndpoint(): Promise<{
  url: string;
  requests: () => number;
  close: () => void;
}> {
  let count = 0;
  const server = createServer((request, response) => {
    count += 1;
    request.resume();
    response.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
    response.end(JSON.stringify({ __type: "NotFoundException", message: "local test endpoint" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the local KMS endpoint has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    close: () => server.close(),
  };
}

/** The scratch project's Hardhat config and the script that calls getAccount. */
function writeProjectFiles(directory: string, endpoint: string): void {
  writeFileSync(
    path.join(directory, "hardhat.config.ts"),
    [
      'import hardhatKmsAws from "@hardhat-kms/aws";',
      "",
      "export default {",
      "  plugins: [hardhatKmsAws],",
      "  networks: {",
      `    local: { type: "edr-simulated", kmsAccounts: [{ provider: "aws", keyId: "alias/peer-install-test", region: "us-east-1", endpoint: "${endpoint}", address: "${ADDRESS}" }] },`,
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(directory, "get-account.ts"),
    [
      'import { network } from "hardhat";',
      "",
      'const connection = await network.create("local");',
      "try {",
      `  await connection.kms.getAccount("${ADDRESS}");`,
      '  console.log("RESULT getAccount returned an account");',
      "} catch (error) {",
      "  console.log(`RESULT ${error instanceof Error ? error.message : String(error)}`);",
      "} finally {",
      "  await connection.close();",
      "}",
      "",
    ].join("\n"),
  );
}

/** The command that installs a project's dependencies, for each package manager. */
const INSTALL: Record<Manager, [string, string[]]> = {
  npm: [npm, ["install", "--ignore-scripts"]],
  "npm --legacy-peer-deps": [npm, ["install", "--ignore-scripts", "--legacy-peer-deps"]],
  // allowBuilds in the project's pnpm-workspace.yaml settles the install scripts.
  pnpm: [pnpm, ["install"]],
  "yarn classic": [
    "corepack",
    [`yarn@${YARN_CLASSIC}`, "install", "--ignore-scripts", "--non-interactive"],
  ],
  // .yarnrc.yml turns the install scripts off.
  "yarn berry": ["corepack", [`yarn@${YARN_BERRY}`, "install"]],
};

/** Settings files a package manager needs in a new project. */
function writeManagerFiles(directory: string, manager: Manager, allowBuilds: boolean): void {
  if (manager === "pnpm" && allowBuilds) {
    // Neither script is needed: esbuild's checks its platform binary, protobufjs's prints a warning.
    writeFileSync(
      path.join(directory, "pnpm-workspace.yaml"),
      "allowBuilds:\n  esbuild: false\n  protobufjs: false\n",
    );
  }
  if (manager === "yarn berry") {
    writeFileSync(
      path.join(directory, ".yarnrc.yml"),
      "nodeLinker: node-modules\nenableScripts: false\nenableTelemetry: false\nenableHardenedMode: false\n",
    );
    // An empty lockfile makes the directory a project of its own, even inside another one.
    writeFileSync(path.join(directory, "yarn.lock"), "");
  }
}

interface Tarballs {
  core: string;
  coreAhead: string;
  aws: string;
  gcp: string;
}

/** Installs one case with one package manager and runs getAccount if the install succeeded. */
async function measure(
  manager: Manager,
  testCase: Case,
  tarballs: Tarballs,
  versions: { hardhat: string; viem: string },
  work: string,
  kms: Awaited<ReturnType<typeof startKmsEndpoint>>,
  patterns: Awaited<ReturnType<typeof checkPatterns>>,
): Promise<Result & { message: string }> {
  const directory = mkdtempSync(path.join(work, `${testCase}-`));
  const viem =
    testCase === "viem-pinned"
      ? VIEM_PINNED
      : testCase === "viem-range"
        ? VIEM_RANGE
        : versions.viem;
  const core = testCase === "provider-mismatch" ? tarballs.coreAhead : tarballs.core;
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: `peer-install-${testCase}`,
        private: true,
        type: "module",
        devDependencies: {
          "@hardhat-kms/aws": `file:${tarballs.aws}`,
          hardhat: versions.hardhat,
          "hardhat-kms": `file:${core}`,
          viem,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeManagerFiles(directory, manager, true);
  writeProjectFiles(directory, kms.url);
  const [command, args] = INSTALL[manager];
  const install = await exec(command, args, directory);
  if (install.status !== 0) {
    const tail = install.output.trim().split("\n").slice(-15).join("\n");
    rmSync(directory, { recursive: true, force: true });
    return { exitCode: install.status, viem: "-", outcome: "not run", message: tail };
  }
  const plugin = realpathSync(path.join(directory, "node_modules", "hardhat-kms"));
  const resolved = resolvedVersion(plugin, "viem");
  const before = kms.requests();
  const hardhatCli = path.join(directory, "node_modules", "hardhat", "dist", "src", "cli.js");
  const runResult = await exec(
    process.execPath,
    [hardhatCli, "run", "--no-compile", "get-account.ts"],
    directory,
  );
  const message = /^RESULT (.*)$/m.exec(runResult.output)?.[1] ?? runResult.output.trim();
  const outcome: Outcome = patterns.viemTooOld.test(message)
    ? "core.account.viem-too-old"
    : patterns.versionMismatch.test(message)
      ? "core.provider.version-mismatch"
      : kms.requests() > before
        ? "reached KMS"
        : "other";
  rmSync(directory, { recursive: true, force: true });
  return { exitCode: install.status, viem: resolved, outcome, message };
}

/**
 * pnpm without `allowBuilds`: it stops on the install scripts of esbuild (from Hardhat) and of
 * protobufjs (from the Google Cloud SDK), which it does not run unless the project lists them.
 *
 * @returns The packages pnpm names, or an empty list when the install succeeded.
 */
async function pnpmIgnoredBuilds(
  tarballs: Tarballs,
  versions: { hardhat: string; viem: string },
  work: string,
): Promise<{ exitCode: number; packages: string[] }> {
  const directory = mkdtempSync(path.join(work, "pnpm-builds-"));
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "peer-install-builds",
        private: true,
        type: "module",
        devDependencies: {
          "@hardhat-kms/gcp": `file:${tarballs.gcp}`,
          hardhat: versions.hardhat,
          "hardhat-kms": `file:${tarballs.core}`,
          viem: versions.viem,
        },
      },
      null,
      2,
    )}\n`,
  );
  const install = await exec(pnpm, ["install"], directory);
  rmSync(directory, { recursive: true, force: true });
  if (install.status === 0) {
    return { exitCode: 0, packages: [] };
  }
  if (!install.output.includes("ERR_PNPM_IGNORED_BUILDS")) {
    throw new Error(`pnpm install failed for another reason:\n${install.output}`);
  }
  const packages = ["esbuild", "protobufjs"].filter((name) =>
    new RegExp(`\\b${name}@`).test(install.output),
  );
  return { exitCode: install.status, packages };
}

/** The version a tool prints. */
function toolVersion(command: string, args: string[]): string {
  return execFileSync(...isolated(command, args), { encoding: "utf8" }).trim();
}

const argv = process.argv.slice(2);
const summaryAt = argv.indexOf("--summary");
const summaryFile = summaryAt === -1 ? undefined : argv[summaryAt + 1];
const selected = argv.filter(
  (_, index) => summaryAt === -1 || (index !== summaryAt && index !== summaryAt + 1),
);
const unknown = selected.filter((name) => !MANAGERS.some((manager) => manager === name));
if (unknown.length > 0) {
  process.stderr.write(
    `unknown package manager: ${unknown.join(", ")}; use ${MANAGERS.join(", ")}\n`,
  );
  process.exit(1);
}
const managers = MANAGERS.filter((manager) => selected.length === 0 || selected.includes(manager));

run(["run", "build"]);
const work = realpathSync(mkdtempSync(path.join(tmpdir(), "hardhat-kms-peer-installs-")));
const kms = await startKmsEndpoint();
let failed = false;
try {
  const coreVersion = String(readJson(path.join(pluginDirectory, "package.json")).version);
  const core = pack(pluginDirectory, work);
  const tarballs: Tarballs = {
    core,
    coreAhead: repack(core, nextPatch(coreVersion), work),
    aws: pack(path.join(root, "packages", "hardhat-kms-aws"), work),
    gcp: pack(path.join(root, "packages", "hardhat-kms-gcp"), work),
  };
  // The Hardhat and viem the workspace resolves, pinned, so only the case's change differs.
  const versions = {
    hardhat: resolvedVersion(pluginDirectory, "hardhat"),
    viem: resolvedVersion(pluginDirectory, "viem"),
  };
  const patterns = await checkPatterns();
  const tools = [
    `Node ${process.version}`,
    `npm ${toolVersion(npm, ["--version"])}`,
    `pnpm ${toolVersion(pnpm, ["--version"])}`,
    `Yarn classic ${toolVersion("corepack", [`yarn@${YARN_CLASSIC}`, "--version"])}`,
    `Yarn Berry ${toolVersion("corepack", [`yarn@${YARN_BERRY}`, "--version"])} (nodeLinker: node-modules)`,
    `Hardhat ${versions.hardhat}`,
    `hardhat-kms ${coreVersion}`,
  ];
  const rows: string[] = [];
  for (const manager of managers) {
    for (const testCase of CASES) {
      if (!Object.hasOwn(EXPECTED[manager], testCase)) {
        continue;
      }
      const started = Date.now();
      const result = await measure(manager, testCase, tarballs, versions, work, kms, patterns);
      process.stdout.write(
        `== ${manager}, ${testCase}: ${Math.round((Date.now() - started) / 1000)} s\n`,
      );
      const expected = EXPECTED[manager][testCase];
      const matches = asExpected(expected, result, versions.viem);
      if (!matches) {
        failed = true;
        process.stderr.write(
          `${manager}, ${testCase}: expected ${JSON.stringify(expected)}, measured ${JSON.stringify(result, undefined, 2)}\n`,
        );
      }
      rows.push(
        `| ${manager} | ${testCase} | ${result.exitCode} | ${result.viem} | ${result.outcome} | ${matches ? "yes" : "NO"} |`,
      );
    }
  }
  const builds = managers.includes("pnpm")
    ? await pnpmIgnoredBuilds(tarballs, versions, work)
    : undefined;
  if (
    builds !== undefined &&
    (builds.exitCode === 0 || builds.packages.join(",") !== "esbuild,protobufjs")
  ) {
    failed = true;
    process.stderr.write(
      `pnpm without allowBuilds: expected ERR_PNPM_IGNORED_BUILDS for esbuild and protobufjs, measured exit ${builds.exitCode} for [${builds.packages.join(", ")}]\n`,
    );
  }
  const report = [
    "## Peer dependency installs",
    "",
    tools.join(", "),
    "",
    "| Package manager | Case | Install exit code | viem hardhat-kms resolves | getAccount | As expected |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    builds === undefined
      ? "pnpm without `allowBuilds`: not measured."
      : `pnpm without \`allowBuilds\` (core and @hardhat-kms/gcp): exit ${builds.exitCode}, ERR_PNPM_IGNORED_BUILDS for ${builds.packages.join(", ") || "nothing"}.`,
    "",
  ].join("\n");
  process.stdout.write(`\n${report}`);
  if (summaryFile !== undefined) {
    appendFileSync(summaryFile, report);
  }
} finally {
  kms.close();
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  process.stderr.write(
    "\nA package manager behaves differently from EXPECTED in scripts/test-peer-installs.ts. Update the table and the docs that state it: docs/user/reference/library-accounts.md and the causes of core.account.viem-too-old and core.provider.version-mismatch.\n",
  );
  process.exit(1);
}
