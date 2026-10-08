// Where the live suite takes hardhat-kms and the three provider plugins from.
//
// Source mode, the default, imports the providers from the checkout's `src`.
// HARDHAT_KMS_LIVE_SOURCE=registry:<version> installs `hardhat-kms`, `@hardhat-kms/aws`,
// `@hardhat-kms/gcp` and `@hardhat-kms/azure` at that exact version into a scratch copy of
// `fixture-project` under the system temp directory, and imports them by package name from there.
// A resolve hook sends each import of the four packages made outside the scratch project to its
// `node_modules`, and each import of their peer dependencies (`hardhat`, `viem`) made inside it to
// the workspace's copies, as a project that installs Hardhat once would load them. The hook records
// every module it resolves under the checkout's `packages/`; a registry run must load none.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { HardhatPlugin } from "hardhat/types/plugins";

import { exactVersion, PACKAGES } from "../../../scripts/registry.ts";
import { readJson, resolvedVersion, stringRecord } from "../../../scripts/temporary-install.ts";
import { type LiveSource, liveSource } from "./mode.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(here, "../../..");
/** The project the suite builds `LiveCheck.sol` in, in source mode, and copies in registry mode. */
const FIXTURE = path.resolve(here, "../fixture-project");
/** The prefix of each scratch project; {@link removeScratchProject} removes nothing else. */
const PREFIX = "hardhat-kms-live-registry-";
const PUBLISHED: ReadonlySet<string> = new Set(PACKAGES);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";

/** The scratch projects this process created, by real path. */
const created = new Set<string>();

/** The three provider plugins and where they came from. */
export interface LivePackages {
  source: LiveSource;
  aws: HardhatPlugin;
  gcp: HardhatPlugin;
  azure: HardhatPlugin;
  /** The Hardhat project root: `fixture-project`, or its scratch copy in registry mode. */
  root: string;
  /** In registry mode, the version each of the four packages resolves to in the scratch project. */
  versions: Record<string, string>;
  /** In registry mode, every module URL resolved under the checkout's `packages/` so far. */
  workspaceModules: () => string[];
}

/**
 * The name of the package a bare specifier imports, such as `@hardhat-kms/aws` for
 * `@hardhat-kms/aws/package.json`.
 *
 * @param specifier - What an `import` names.
 * @returns The package name, or undefined for a relative, absolute, `node:` or URL specifier.
 */
export function packageName(specifier: string): string | undefined {
  if (
    specifier === "" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.includes(":")
  ) {
    return undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Removes a scratch project that {@link installRegistryProject} created in this process. The
 * removal is recursive, so it refuses any other path: one this process did not create, one outside
 * the system temp directory, or one without the prefix.
 *
 * @param directory - The scratch project.
 */
export function removeScratchProject(directory: string): void {
  const resolved = path.resolve(directory);
  if (
    !created.has(resolved) ||
    path.dirname(resolved) !== realpathSync(tmpdir()) ||
    !path.basename(resolved).startsWith(PREFIX)
  ) {
    throw new Error(`refusing to remove ${directory}: this process did not create it`);
  }
  created.delete(resolved);
  rmSync(resolved, { recursive: true, force: true });
}

/**
 * Checks that a scratch project resolves each of the four packages at `version`, and that each
 * provider resolves the core at `version` too.
 *
 * @param directory - The scratch project.
 * @param version - The version that was asked for.
 * @returns The version of each package.
 */
function checkVersions(directory: string, version: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const name of PACKAGES) {
    const installed = resolvedVersion(directory, name);
    const core = resolvedVersion(
      path.join(directory, "node_modules", ...name.split("/")),
      PACKAGES[0] ?? "",
    );
    if (installed !== version || core !== version) {
      throw new Error(
        `${name} resolves to ${installed} with hardhat-kms ${core}; ${version} was asked for`,
      );
    }
    versions[name] = installed;
  }
  return versions;
}

/**
 * Copies `fixture-project` to a new scratch directory under the system temp directory and installs
 * the four packages there at `version`, with `npm install --ignore-scripts`. Peer dependencies are
 * not installed (`--legacy-peer-deps`): the workspace's Hardhat and viem stand in for them, as one
 * copy each. npm reads the registry and the rest of its settings from its usual config, so
 * `npm_config_registry` and `npm_config_offline` apply.
 *
 * @param version - An exact version.
 * @returns The scratch project's real path and the version of each package. On a failure the
 *   directory is removed before the error is thrown.
 */
export function installRegistryProject(version: string): {
  directory: string;
  versions: Record<string, string>;
} {
  exactVersion(version);
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), PREFIX)));
  created.add(directory);
  try {
    cpSync(path.join(FIXTURE, "contracts"), path.join(directory, "contracts"), {
      recursive: true,
    });
    const manifest = {
      ...readJson(path.join(FIXTURE, "package.json")),
      dependencies: Object.fromEntries(PACKAGES.map((name) => [name, version])),
    };
    writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync(
      npm,
      ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"],
      { cwd: directory, stdio: ["ignore", "ignore", "pipe"], shell },
    );
    return { directory, versions: checkVersions(directory, version) };
  } catch (error) {
    removeScratchProject(directory);
    throw error;
  }
}

/**
 * The peer dependencies of the four installed packages, other than the four themselves.
 *
 * @param directory - The scratch project.
 * @returns Their names.
 */
function peersOf(directory: string): Set<string> {
  const peers = new Set<string>();
  for (const name of PACKAGES) {
    const manifest = readJson(
      path.join(directory, "node_modules", ...name.split("/"), "package.json"),
    );
    for (const peer of Object.keys(stringRecord(manifest.peerDependencies))) {
      if (!PUBLISHED.has(peer)) {
        peers.add(peer);
      }
    }
  }
  return peers;
}

/** Where the hook resolves to, once registered. A process registers one hook. */
let redirected: { directory: string; workspaceModules: string[] } | undefined;

/**
 * Registers the resolve hook that loads the four packages from the scratch project and their peer
 * dependencies from the workspace, and records each module resolved under `packages/`.
 *
 * @param directory - The scratch project.
 * @returns The list the hook appends workspace modules to.
 */
export function redirectPackages(directory: string): string[] {
  if (redirected !== undefined) {
    if (redirected.directory !== directory) {
      throw new Error("the packages are already redirected to another scratch project");
    }
    return redirected.workspaceModules;
  }
  const workspaceModules: string[] = [];
  redirected = { directory, workspaceModules };
  const peers = peersOf(directory);
  const scratch = pathToFileURL(`${directory}${path.sep}`).href;
  const scratchParent = pathToFileURL(path.join(directory, "package.json")).href;
  const workspaceParent = pathToFileURL(path.join(REPOSITORY, "package.json")).href;
  const workspacePackages = pathToFileURL(`${path.join(REPOSITORY, "packages")}${path.sep}`).href;
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const name = packageName(specifier);
      const fromScratch = context.parentURL?.startsWith(scratch) === true;
      let parentURL = context.parentURL;
      if (name !== undefined && PUBLISHED.has(name) && !fromScratch) {
        parentURL = scratchParent;
      } else if (name !== undefined && peers.has(name) && fromScratch) {
        parentURL = workspaceParent;
      }
      const result = nextResolve(specifier, { ...context, parentURL });
      if (result.url.startsWith(workspacePackages)) {
        workspaceModules.push(result.url);
      }
      return result;
    },
  });
  return workspaceModules;
}

/**
 * Loads the three provider plugins from the source the environment selects. In registry mode it
 * installs the scratch project first, which takes a network install (or an offline one from npm's
 * cache), and removes it when the process exits.
 *
 * @param env - The environment, normally `process.env`.
 * @returns The plugins, the project root and, in registry mode, the installed versions.
 */
export async function livePackages(
  env: Readonly<Record<string, string | undefined>>,
): Promise<LivePackages> {
  const source = liveSource(env);
  if (source.kind === "source") {
    const [aws, gcp, azure] = await Promise.all([
      import("../../../packages/hardhat-kms-aws/src/index.ts"),
      import("../../../packages/hardhat-kms-gcp/src/index.ts"),
      import("../../../packages/hardhat-kms-azure/src/index.ts"),
    ]);
    return {
      source,
      aws: aws.default,
      gcp: gcp.default,
      azure: azure.default,
      root: FIXTURE,
      versions: {},
      workspaceModules: () => [],
    };
  }
  const { directory, versions } = installRegistryProject(source.version);
  process.once("exit", () => {
    removeScratchProject(directory);
  });
  const workspaceModules = redirectPackages(directory);
  const [aws, gcp, azure] = await Promise.all([
    import("@hardhat-kms/aws"),
    import("@hardhat-kms/gcp"),
    import("@hardhat-kms/azure"),
  ]);
  return {
    source,
    aws: aws.default,
    gcp: gcp.default,
    azure: azure.default,
    root: directory,
    versions,
    workspaceModules: () => [...workspaceModules],
  };
}

/**
 * Adds the test that ends a registry run: the four packages resolved to the version asked for, and
 * no module under the checkout's `packages/` was loaded, the plugins' lazily loaded hook handlers
 * included. Call it last in a live file's `describe`, after the provider tests.
 *
 * @param packages - What {@link livePackages} returned.
 * @param configured - How many providers the run has a key for; with none, the check is skipped.
 */
export function registryCheck(packages: LivePackages, configured: number): void {
  const { source } = packages;
  const skip =
    source.kind !== "registry"
      ? "runs only in registry mode"
      : configured === 0
        ? "no provider is configured"
        : false;
  it("registry: ran the published packages and nothing from packages/", { skip }, (t) => {
    assert.ok(source.kind === "registry");
    assert.deepEqual(
      packages.versions,
      Object.fromEntries(PACKAGES.map((name) => [name, source.version])),
    );
    assert.deepEqual(packages.workspaceModules(), [], "modules loaded from packages/");
    t.diagnostic(`hardhat-kms and the three providers at ${source.version}, from the registry`);
  });
}
