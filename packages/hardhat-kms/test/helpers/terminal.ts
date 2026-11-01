// Terminals for the tasks that ask a person before they sign (`kms sign --no-hash`, `kms
// sign-auth`), over in-memory streams.
import { PassThrough, Writable } from "node:stream";

import type { Terminal } from "../../src/internal/tasks/confirm.ts";

/** The prompt both tasks end their question with. */
export const PROMPT = "Sign? [y/N] ";

/** A run without a terminal: the task must neither read nor write it. */
export const NO_TERMINAL: Terminal = {
  interactive: false,
  input: new PassThrough(),
  output: new Writable({
    write() {
      throw new Error("the task wrote to a terminal it must not use");
    },
  }),
};

/**
 * A terminal that answers the task's question with `answer` once the prompt is shown, or closes
 * its input then when `answer` is `undefined`, and records what the task wrote to it. A line
 * written before the question would be discarded as type-ahead.
 *
 * @param answer - The line to type, with its newline, or `undefined` to close the input.
 * @param onPrompt - Called when the prompt is shown, before the answer is typed.
 * @returns The terminal, and what was written to it so far.
 */
export function answering(
  answer: string | undefined,
  onPrompt: () => void = () => undefined,
): { terminal: Terminal; asked: () => string } {
  const input = new PassThrough();
  let asked = "";
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      asked += chunk.toString();
      done();
      if (asked.endsWith(PROMPT)) {
        onPrompt();
        if (answer === undefined) {
          input.end();
        } else {
          input.write(answer);
        }
      }
    },
  });
  return { terminal: { interactive: true, input, output }, asked: () => asked };
}
