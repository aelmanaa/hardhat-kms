// The anvil process must not outlive the test process. Uses a stand-in for anvil, so it runs
// offline and without Foundry, in `pnpm test`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, "helpers", "anvil.ts");
const fakeAnvil = path.join(here, "fixtures", "fake-anvil.mjs");

/** Whether a process id is alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return check();
}

/**
 * Starts a parent process that starts the fake anvil through the helper and prints its pid, then
 * runs `then` in the parent.
 */
async function startParent(
  then: string,
): Promise<{ parent: number; anvil: number; exited: Promise<number | null> }> {
  const script = [
    `import { startAnvilFork } from ${JSON.stringify(helper)};`,
    `const fork = await startAnvilFork({ binary: ${JSON.stringify(fakeAnvil)}, forkUrl: "http://127.0.0.1:1", hardfork: "prague" });`,
    "console.log(fork.pid);",
    then,
  ].join("\n");
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => {
    parent.once("exit", (code) => {
      resolve(code);
    });
  });
  const line = await new Promise<string>((resolve, reject) => {
    let output = "";
    parent.stdout.setEncoding("utf8");
    parent.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("\n")) {
        resolve(output.trim());
      }
    });
    parent.once("exit", (code) => {
      reject(new Error(`the parent exited with ${code} before printing anvil's pid`));
    });
  });
  const anvil = Number(line);
  assert.ok(Number.isInteger(anvil) && anvil > 0, `not a pid: ${line}`);
  assert.ok(parent.pid !== undefined);
  return { parent: parent.pid, anvil, exited };
}

describe("live test anvil process", { skip: process.platform === "win32" }, () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it(`ends anvil when the test process gets ${signal}`, async () => {
      const { parent, anvil } = await startParent("setInterval(() => {}, 1000);");
      assert.ok(alive(anvil), "anvil is not running");
      process.kill(parent, signal);
      assert.ok(await waitUntil(() => !alive(parent), 5000), "the parent did not exit");
      assert.ok(await waitUntil(() => !alive(anvil), 5000), "anvil outlived the parent");
    });
  }

  it("ends anvil when the test process exits without closing it", async () => {
    const { parent, anvil } = await startParent("setTimeout(() => process.exit(0), 100);");
    assert.ok(await waitUntil(() => !alive(parent), 5000), "the parent did not exit");
    assert.ok(await waitUntil(() => !alive(anvil), 5000), "anvil outlived the parent");
  });

  it("closes anvil and removes the handlers", async () => {
    const { anvil, exited } = await startParent(
      [
        "const before = process.listenerCount('SIGTERM');",
        "await fork.close();",
        "process.exit(process.listenerCount('SIGTERM') === before - 1 ? 0 : 3);",
      ].join("\n"),
    );
    assert.equal(await exited, 0, "close left a signal handler behind");
    assert.ok(!alive(anvil), "anvil still runs after close");
  });
});
