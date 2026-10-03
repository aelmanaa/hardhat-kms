// The check behind `scripts/fail-on-deprecation.ts`, which the Node 26 leg of the CI test job
// preloads into every Node process: a DeprecationWarning that ALLOWED_WARNINGS does not list makes
// the process fail. Kept apart from the preload, which installs it on import, so
// `test/scripts/deprecation-hook.test.ts` can test it on a fake process.
//
// Why not `--throw-deprecation`: Node throws from `process.emitWarning` before its `onWarning`
// handler reads `--disable-warning`, so a warning could not be allowed (nodejs/node v24.x at
// e36633a, lib/internal/process/warning.js: the throw at line 172, the `--disable-warning` check at
// line 98). This hook lets the process run on, prints the warning with its stack, and sets the
// exit code.
import process from "node:process";

/** A DeprecationWarning that may be emitted, with why and where to follow it. */
export interface AllowedWarning {
  /** The warning's code, such as `DEP0040`, or its message when it has no code. */
  warning: string;
  reason: string;
  /** The upstream issue or pull request that tracks its removal. */
  link: string;
}

export const ALLOWED_WARNINGS: readonly AllowedWarning[] = [];

/** The code of a warning, or its message when it has none. */
function warningId(warning: Error): string {
  const code = "code" in warning ? warning.code : undefined;
  return typeof code === "string" && code !== "" ? code : warning.message;
}

/**
 * Listens for warnings on `target`. On a DeprecationWarning that `allowed` does not list, it writes
 * the warning to `write` and sets a failing exit code, and keeps it failing if the process later
 * exits with code 0. Returns whether such a warning was seen so far.
 */
export function failOnDeprecation(
  target: NodeJS.EventEmitter & { exitCode?: number | string | null | undefined },
  allowed: readonly AllowedWarning[] = ALLOWED_WARNINGS,
  write: (text: string) => void = (text) => process.stderr.write(text),
): () => boolean {
  let failed = false;
  target.on("warning", (warning: Error) => {
    if (warning.name !== "DeprecationWarning") {
      return;
    }
    const id = warningId(warning);
    if (allowed.some((entry) => entry.warning === id)) {
      return;
    }
    failed = true;
    target.exitCode = 1;
    write(
      `fail-on-deprecation: ${id} is not in ALLOWED_WARNINGS of scripts/deprecation-hook.ts; this process exits with code 1.\n${warning.stack ?? `${warning.name}: ${warning.message}`}\n`,
    );
  });
  target.on("exit", (code: number) => {
    if (failed && code === 0) {
      target.exitCode = 1;
    }
  });
  return () => failed;
}
