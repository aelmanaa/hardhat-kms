import { execFileSync } from "node:child_process";

/**
 * LocalStack 4.14.0, pinned by the digest of its multi-platform image so that a retagged image
 * cannot change the tests. Update both together.
 */
const LOCALSTACK_IMAGE =
  "localstack/localstack:4.14.0@sha256:3ebc37595918b8accb852f8048fef2aff047d465167edd655528065b07bc364a";

/** Marks the containers these tests start, so a run can remove those an interrupted run left. */
const LABEL = "hardhat-kms-test=localstack";

/** A running LocalStack container. */
export interface LocalStack {
  /** The KMS endpoint, on a random host port. */
  endpoint: string;
  stop(): void;
}

const docker = (args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Starts LocalStack with only KMS, bound to a random port on 127.0.0.1, and waits until KMS is
 * available. `stop()` removes the container, as does SIGINT or SIGTERM sent to this process. When
 * `node --test` is interrupted, the runner ends the test process before it can clean up; the
 * next run then removes the container left behind.
 *
 * @returns The running container.
 */
export async function startLocalStack(): Promise<LocalStack> {
  try {
    docker(["version", "--format", "{{.Server.Version}}"]);
  } catch {
    throw new Error("The LocalStack tests need a running Docker daemon.");
  }
  const leftovers = docker(["ps", "--all", "--quiet", "--filter", `label=${LABEL}`]);
  if (leftovers !== "") {
    docker(["rm", "--force", ...leftovers.split("\n")]);
  }
  // No --rm: a container that exits during startup must stay for its logs.
  const id = docker([
    "run",
    "--detach",
    "--label",
    LABEL,
    "--publish",
    "127.0.0.1::4566",
    "--env",
    "SERVICES=kms",
    LOCALSTACK_IMAGE,
  ]);
  const onSignal = (signal: NodeJS.Signals): void => {
    stop();
    process.kill(process.pid, signal);
  };
  const stop = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    docker(["rm", "--force", id]);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const port = docker(["port", id, "4566/tcp"]).split("\n")[0]?.split(":").at(-1) ?? "";
    if (!/^\d+$/.test(port)) {
      throw new Error(`Docker did not report a host port for LocalStack (got "${port}").`);
    }
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (await kmsAvailable(endpoint)) {
        return { endpoint, stop };
      }
      if (docker(["inspect", "--format", "{{.State.Running}}", id]) !== "true") {
        throw new Error(`LocalStack exited during startup:\n${docker(["logs", id])}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`LocalStack did not start in time:\n${docker(["logs", id])}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    stop();
    throw error;
  }
}

async function kmsAvailable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/_localstack/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const health: unknown = await response.json();
    const services: unknown =
      typeof health === "object" && health !== null ? Reflect.get(health, "services") : undefined;
    return (
      typeof services === "object" &&
      services !== null &&
      ["available", "running"].includes(String(Reflect.get(services, "kms")))
    );
  } catch {
    return false;
  }
}
