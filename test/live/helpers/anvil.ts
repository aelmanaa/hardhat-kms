// Starts the anvil node the live suite runs on in fork mode: a fork of Sepolia on 127.0.0.1, with
// the Prague rules so EIP-7702 works. Anvil comes with Foundry; it is looked up on PATH and then in
// ~/.foundry/bin.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

/** How long anvil may take to fetch the fork's head block and answer. */
const START_TIMEOUT_MS = 60_000;
/** Lines of anvil's standard error kept for a start failure. */
const STDERR_LINES = 20;

/**
 * The anvil binary: the first `anvil` on PATH, else Foundry's default install.
 *
 * @param env - The environment, normally `process.env`.
 * @returns Its path, or undefined if there is none.
 */
export function findAnvil(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const directories = (env.PATH ?? "").split(path.delimiter).filter((item) => item !== "");
  directories.push(path.join(env.HOME ?? homedir(), ".foundry", "bin"));
  const name = process.platform === "win32" ? "anvil.exe" : "anvil";
  return directories
    .map((directory) => path.join(directory, name))
    .find((file) => existsSync(file));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("no free TCP port");
  }
  return address.port;
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** A running anvil fork. */
export interface AnvilFork {
  /** Its JSON-RPC URL. */
  url: string;
  /** Stops anvil. */
  close: () => Promise<void>;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Starts anvil forking `forkUrl` and waits until it answers.
 *
 * @param options.binary - The anvil binary.
 * @param options.forkUrl - The RPC anvil reads the chain from; the suite passes its recording proxy.
 * @param options.hardfork - The rules anvil applies to new blocks.
 * @returns The running fork.
 * @throws If anvil exits or does not answer within a minute; the message carries the end of its
 *   standard error, which the caller redacts.
 */
export async function startAnvilFork(options: {
  binary: string;
  forkUrl: string;
  hardfork: string;
}): Promise<AnvilFork> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // No disk cache: every state read goes through the proxy, and nothing lands in ~/.foundry.
  const child = spawn(
    options.binary,
    [
      "--fork-url",
      options.forkUrl,
      "--hardfork",
      options.hardfork,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-storage-caching",
    ],
    // Standard output logs every transaction; nothing reads it.
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr.push(...chunk.split("\n").filter((line) => line.trim() !== ""));
    stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await answers(url))) {
    const exited = child.exitCode !== null || child.signalCode !== null || spawnError !== undefined;
    if (exited || Date.now() > deadline) {
      await stop(child);
      const reason =
        spawnError?.message ?? (exited ? "anvil exited" : "anvil did not answer in time");
      throw new Error(`${reason}: ${stderr.join(" | ") || "no output"}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  return { url, close: async () => await stop(child) };
}
