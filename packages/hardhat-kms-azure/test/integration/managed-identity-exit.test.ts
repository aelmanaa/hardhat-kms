import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/** Variables that would give the chain another way to a token, or change the endpoint. */
const AZURE_VARIABLES = /^(AZURE_|MSI_|IDENTITY_|IMDS_|AZD_)/;

describe("the managed identity on an endpoint that never answers", () => {
  it("gives up within its time limit, and the process exits on its own", async () => {
    // Accepts connections and never answers, like an unreachable metadata endpoint that a proxy
    // or firewall holds open.
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !AZURE_VARIABLES.test(name)),
    );
    try {
      const fixture = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../fixtures/managed-identity-hang.ts",
      );
      const child = spawn(process.execPath, [fixture], {
        env: {
          ...env,
          // Only node's own directory: no az or azd to answer instead.
          PATH: path.dirname(process.execPath),
          AZURE_POD_IDENTITY_AUTHORITY_HOST: `http://127.0.0.1:${address.port}`,
          NODE_V8_COVERAGE: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const started = Date.now();
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, 60_000);
        child.on("exit", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      const elapsed = Date.now() - started;

      assert.equal(code, 0, `the process did not exit by itself:\n${output}`);
      assert.match(output, /^AggregateAuthenticationError after \d+ ms$/m, output);
      assert.ok(connections > 0, "the managed identity never called the endpoint");
      // The token has 10 s; the open request ends within its 3 s timeout, so the chain gives up
      // early and nothing is left to keep the process alive.
      assert.ok(elapsed < 25_000, `the process took ${elapsed} ms to exit:\n${output}`);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
