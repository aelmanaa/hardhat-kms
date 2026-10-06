// Registry mode of the package checks, end to end, against a local registry: the promotion
// workflow's rehearsal until a version exists on npm. The test builds and packs the four
// packages, starts verdaccio on a free port, publishes the tarballs to it under `beta` with a
// throwaway user, and runs each script with `--from-registry <version> --registry <url>`:
// scripts/check-packages.ts, scripts/consumer-typecheck.ts, scripts/test-peer-installs.ts (npm
// only), scripts/check-registry-release.ts and the examples test in registry mode. Needs Docker
// for the examples, and the network for the dependencies the registry proxies from npm.
//
// `pnpm run test:registry-mode`. Not in `pnpm test`: the installs take minutes.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { pack } from "../../scripts/pack.ts";
import { PACKAGES } from "../../scripts/registry.ts";
import { readJson } from "../../scripts/temporary-install.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";
/** The package directories, in the order of PACKAGES. */
const DIRECTORIES = ["hardhat-kms", "hardhat-kms-aws", "hardhat-kms-gcp", "hardhat-kms-azure"].map(
  (name) => path.join(root, "packages", name),
);
/** The version of the workspace packages, which the tarballs and the registry get. */
const version = String(readJson(path.join(DIRECTORIES[0] ?? "", "package.json")).version);
/** The TypeScript the consumer typecheck runs with: the workspace's. */
const typescriptVersion = String(
  readJson(path.join(root, "node_modules", "typescript", "package.json")).version,
);
/** One script run must finish within this; the examples run, with its three installs, gets more. */
const STEP_MS = 900_000;
const EXAMPLES_MS = 2_400_000;

interface Completed {
  status: number;
  output: string;
}

/** Runs a command with the test's environment, and returns how it ended and what it printed. */
async function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Completed> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell,
    });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? STEP_MS);
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: status ?? (signal === null ? 1 : 128), output: text });
    });
  });
}

/** Runs one of the scripts in scripts/ with node. */
const script = async (name: string, args: string[]): Promise<Completed> =>
  await exec(process.execPath, [path.join(root, "scripts", name), ...args]);

/** A TCP port nothing listens on right now. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** The lines of a script's output that report a check or a failure. */
const reported = (output: string): string[] =>
  output.split("\n").filter((line) => /^(ok|skip|FAIL) /.test(line));

describe("registry mode against a local registry", { timeout: 3_600_000 }, () => {
  // The scripts and the test remove directories under the temp directory, so the whole run uses
  // one of its own (the sandbox rule of docs/contributor/testing.md).
  const variables = ["TMPDIR", "TEMP", "TMP"];
  const saved = new Map(variables.map((name) => [name, process.env[name]]));
  let sandbox = "";
  let registry = "";
  let verdaccio: ChildProcess | undefined;

  before(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), "hardhat-kms-test-"));
    for (const name of variables) {
      process.env[name] = sandbox;
    }
    assert.equal(path.resolve(tmpdir()), path.resolve(sandbox));

    execFileSync(pnpm, ["run", "build"], { cwd: root, shell, stdio: "inherit" });
    const tarballs = DIRECTORIES.map((directory) => pack(directory, sandbox));

    // verdaccio: the four packages are published here; everything else is proxied from npm.
    const home = path.join(sandbox, "verdaccio");
    mkdirSync(path.join(home, "storage"), { recursive: true });
    writeFileSync(
      path.join(home, "config.yaml"),
      [
        "storage: ./storage",
        "auth:",
        "  htpasswd:",
        "    file: ./htpasswd",
        "uplinks:",
        "  npmjs:",
        "    url: https://registry.npmjs.org/",
        // After max_fails slow answers from npm, verdaccio would answer 404 for every proxied
        // package until fail_timeout passes, and the installs here ask for hundreds of them.
        "    timeout: 120s",
        "    max_fails: 1000",
        "    fail_timeout: 1s",
        "packages:",
        "  'hardhat-kms':",
        "    access: $all",
        "    publish: $authenticated",
        "  '@hardhat-kms/*':",
        "    access: $all",
        "    publish: $authenticated",
        "  '**':",
        "    access: $all",
        "    proxy: npmjs",
        "log: { type: stdout, format: pretty, level: warn }",
        "",
      ].join("\n"),
    );
    const port = await freePort();
    registry = `http://127.0.0.1:${port}`;
    verdaccio = spawn(
      process.execPath,
      [
        path.join(root, "node_modules", "verdaccio", "bin", "verdaccio"),
        "--config",
        path.join(home, "config.yaml"),
        "--listen",
        `127.0.0.1:${port}`,
      ],
      { cwd: home, stdio: "ignore" },
    );
    const deadline = Date.now() + 60_000;
    for (;;) {
      const up = await fetch(`${registry}/-/ping`).then(
        (response) => response.ok,
        () => false,
      );
      if (up) {
        break;
      }
      assert.ok(verdaccio.exitCode === null && Date.now() < deadline, "verdaccio did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // A throwaway user: its token lives in an npmrc under the sandbox for the publishes only.
    const created = await fetch(`${registry}/-/user/org.couchdb.user:publisher`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "publisher", password: "throwaway-password" }),
    });
    const body = await created.text();
    assert.equal(created.status, 201, body);
    const token: unknown = Reflect.get(Object(JSON.parse(body)), "token");
    assert.ok(typeof token === "string" && token !== "");
    const npmrc = path.join(home, "npmrc");
    writeFileSync(npmrc, `//127.0.0.1:${port}/:_authToken=${token}\n`);
    for (const tarball of tarballs) {
      // The packages ask for provenance, which only a CI publish to npm can give.
      const published = await exec(
        npm,
        [
          "publish",
          tarball,
          "--registry",
          registry,
          "--tag",
          "beta",
          "--access",
          "public",
          "--provenance=false",
        ],
        { env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc } },
      );
      assert.equal(published.status, 0, published.output);
    }
  });

  after(() => {
    verdaccio?.kill();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("publishes the four packages under beta", async () => {
    for (const name of PACKAGES) {
      const response = await fetch(`${registry}/${name.replace("/", "%2f")}`);
      assert.equal(response.ok, true, name);
      const tags: unknown = Reflect.get(Object(await response.json()), "dist-tags");
      assert.deepEqual(tags, { latest: version, beta: version }, name);
    }
  });

  it("check-packages: publint and attw pass on the registry tarballs", async () => {
    const run = await script("check-packages.ts", [
      "--from-registry",
      version,
      "--registry",
      registry,
    ]);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, new RegExp(`checked 4 packages at ${version} from the registry`));
    for (const name of PACKAGES) {
      assert.match(run.output, new RegExp(`== ${name}@${version}\n`));
    }
  });

  it("check-packages: a version the registry does not have fails with npm's reason", async () => {
    const missing = `${version}-missing`;
    const run = await script("check-packages.ts", [
      "--from-registry",
      missing,
      "--registry",
      registry,
    ]);
    assert.notEqual(run.status, 0);
    assert.match(
      run.output,
      new RegExp(`npm pack hardhat-kms@${missing} failed:\nnpm error code ETARGET`),
    );
  });

  it("consumer-typecheck: the consumer installs the version from the registry", async () => {
    const run = await script("consumer-typecheck.ts", [
      "--from-registry",
      version,
      "--registry",
      registry,
      typescriptVersion,
    ]);
    assert.equal(run.status, 0, run.output);
    assert.match(
      run.output,
      new RegExp(
        `consumer typecheck passed with TypeScript ${typescriptVersion} and hardhat-kms ${version} from the registry`,
      ),
    );
  });

  it("test-peer-installs: npm measures as expected and skips provider-mismatch", async () => {
    const run = await script("test-peer-installs.ts", [
      "--from-registry",
      version,
      "--registry",
      registry,
      "npm",
    ]);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, new RegExp(`hardhat-kms ${version} \\(from the registry\\)`));
    assert.match(run.output, /\| npm \| control \| 0 \| \S+ \| reached KMS \| yes \|/);
    assert.match(
      run.output,
      /\| npm \| provider-mismatch \| - \| - \| not run \| skipped in registry mode \|/,
    );
    assert.match(run.output, /provider-mismatch: skipped in registry mode/);
    assert.doesNotMatch(run.output, /\| NO \|/);
  });

  it("check-registry-release: the dist-tag guards pass, then the tag check names the missing tag", async () => {
    const run = await script("check-registry-release.ts", [version, "--registry", registry]);
    assert.equal(run.status, 1);
    assert.deepEqual(reported(run.output), [
      `ok   ${version} is a stable version`,
      `ok   ${version} is published for ${PACKAGES.join(", ")}`,
      `ok   beta is ${version} for the four packages`,
      `ok   latest is ${version}, not above ${version}`,
      `FAIL tag v${version} is not in this checkout; run git fetch origin tag v${version}`,
    ]);
  });

  it("check-registry-release: refuses a prerelease and a version the registry does not have", async () => {
    const prerelease = await script("check-registry-release.ts", [
      `${version}-rc.1`,
      "--registry",
      registry,
    ]);
    assert.equal(prerelease.status, 1);
    assert.deepEqual(reported(prerelease.output), [
      `FAIL ${version}-rc.1 is a prerelease; only a stable major.minor.patch version goes to latest`,
    ]);
    const missing = await script("check-registry-release.ts", ["99.0.0", "--registry", registry]);
    assert.equal(missing.status, 1);
    assert.deepEqual(reported(missing.output), [
      "ok   99.0.0 is a stable version",
      `FAIL 99.0.0 is not published for ${PACKAGES.join(", ")}`,
    ]);
  });

  it("examples: the copies install from the registry with npm and deploy on LocalStack", async () => {
    // `node --test` sets NODE_TEST_CONTEXT for the files it runs; the nested runner must not
    // inherit it, or it reports to a parent that is not there and runs nothing.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const run = await exec(pnpm, ["--filter", "@hardhat-kms/aws", "run", "test:examples"], {
      env: {
        ...env,
        HARDHAT_KMS_EXAMPLES_VERSION: version,
        HARDHAT_KMS_EXAMPLES_REGISTRY: registry,
      },
      timeoutMs: EXAMPLES_MS,
    });
    assert.equal(run.status, 0, run.output);
    for (const example of ["ethers", "ignition", "viem"]) {
      assert.match(
        run.output,
        new RegExp(`${example}: a copy installs ${version} with npm from the registry`),
      );
    }
    assert.match(run.output, /\bfail 0\n/);
  });
});
