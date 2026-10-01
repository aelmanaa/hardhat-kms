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
/** How long anvil gets to exit after SIGTERM, and then after SIGKILL. */
const STOP_TIMEOUT_MS = 5000;
/** Signals that end the test process; each one also ends anvil. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

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
  /** Anvil's process id. */
  pid: number | undefined;
  /** Stops anvil. */
  close: () => Promise<void>;
}

const running = (child: ChildProcess): boolean =>
  child.pid !== undefined && child.exitCode === null && child.signalCode === null;

/**
 * Ends anvil when the test process ends, so it does not outlive the run holding transactions
 * signed on the fork: on a normal exit and on SIGINT, SIGTERM or SIGHUP. Nothing can catch SIGKILL
 * of the test process; anvil then keeps running until it is killed by hand.
 *
 * @returns A function that removes the handlers.
 */
function endWithProcess(child: ChildProcess): () => void {
  const kill = (): void => {
    if (running(child)) {
      child.kill("SIGKILL");
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    kill();
    remove();
    // Raise the signal again, so the process ends as it would have without this handler.
    process.kill(process.pid, signal);
  };
  const remove = (): void => {
    process.off("exit", kill);
    for (const signal of SIGNALS) {
      process.off(signal, onSignal);
    }
  };
  process.once("exit", kill);
  for (const signal of SIGNALS) {
    process.once(signal, onSignal);
  }
  return remove;
}

/** Sends SIGTERM, then SIGKILL if anvil is still running after the timeout. */
async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (!running(child)) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
  });
  const within = async (ms: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, ms);
    });
    const done = await Promise.race([exited.then(() => true), timeout]);
    clearTimeout(timer);
    return done;
  };
  if (!running(child)) {
    return;
  }
  child.kill("SIGTERM");
  if (await within(STOP_TIMEOUT_MS)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await within(STOP_TIMEOUT_MS))) {
    throw new Error(`anvil (pid ${child.pid}) did not exit after SIGKILL`);
  }
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
  const release = endWithProcess(child);
  const close = async (): Promise<void> => {
    try {
      await stop(child);
    } finally {
      release();
    }
  };
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
      await close();
      const reason =
        spawnError?.message ?? (exited ? "anvil exited" : "anvil did not answer in time");
      throw new Error(`${reason}: ${stderr.join(" | ") || "no output"}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  return { url, pid: child.pid, close };
}
