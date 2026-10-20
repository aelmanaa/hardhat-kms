// The question a task asks a person before it signs something the plugin cannot check, such as a
// raw digest. Hardhat's `hre.interruptions.requestInput` is not used: it writes the question to
// standard output, which holds a task's result, any plugin can answer it through the
// `userInterruptions` hook, and its readline question never settles when standard input closes.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isatty } from "node:tty";

/** Where a task asks a person a question. */
export interface Terminal {
  /**
   * Whether a person can answer: standard input and standard error are both terminals. Without
   * one, a task never asks and decides from its options alone.
   */
  readonly interactive: boolean;
  /** Where the answer is read from: standard input. */
  readonly input: Readable;
  /** Where the question is written: standard error, since standard output holds the result. */
  readonly output: Writable;
}

/**
 * The process's terminal. Standard input is opened only when a question reads it.
 *
 * @returns The terminal of this process.
 */
export function processTerminal(): Terminal {
  return {
    interactive: isatty(0) && isatty(2),
    get input(): Readable {
      return process.stdin;
    },
    output: process.stderr,
  };
}

/**
 * Whether an answer agrees: `y` or `yes`, in any case, with surrounding spaces ignored. Anything
 * else, including an empty line, declines.
 *
 * @param answer - The line the person typed, without its newline.
 * @returns Whether the answer is yes.
 */
export function isYes(answer: string): boolean {
  const word = answer.trim().toLowerCase();
  return word === "y" || word === "yes";
}

/**
 * Writes `lines` and the prompt to the terminal's output and reads one line of answer. The default
 * is no: only {@link isYes} answers agree. Input that is closed, or closes or fails before a line
 * arrives, declines, so the question always settles.
 *
 * @param terminal - Where to ask; it must be interactive.
 * @param lines - What to show before the prompt, one entry per line.
 * @param prompt - The prompt, on the line the answer is typed on.
 * @returns Whether the person agreed.
 */
export async function confirm(
  terminal: Terminal,
  lines: readonly string[],
  prompt = "Sign? [y/N] ",
): Promise<boolean> {
  const { input, output } = terminal;
  output.write(`${lines.map((line) => `${line}\n`).join("")}${prompt}`);
  // readline waits for an `end` that a stream which already ended never emits again.
  if (input.readableEnded || input.destroyed) {
    output.write("\n");
    return false;
  }
  const reader = createInterface({ input, terminal: false, crlfDelay: Infinity });
  try {
    const answer = await new Promise<string | undefined>((resolve) => {
      reader.once("line", resolve);
      reader.once("close", () => {
        resolve(undefined);
      });
      // readline passes an error of its input on to the interface.
      reader.once("error", () => {
        resolve(undefined);
      });
    });
    if (answer === undefined) {
      // Keep the next line of output off the prompt's line.
      output.write("\n");
      return false;
    }
    return isYes(answer);
  } finally {
    reader.close();
  }
}
