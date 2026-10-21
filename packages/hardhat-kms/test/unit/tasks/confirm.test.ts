import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import { isatty } from "node:tty";

import {
  confirm,
  isYes,
  processTerminal,
  type Terminal,
} from "../../../src/internal/tasks/confirm.ts";

/** A terminal over in-memory streams, and what it printed. */
function fakeTerminal(): { terminal: Terminal; input: PassThrough; printed: () => string } {
  const input = new PassThrough();
  let printed = "";
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      printed += chunk.toString();
      done();
    },
  });
  return { terminal: { interactive: true, input, output }, input, printed: () => printed };
}

describe("isYes", () => {
  it("accepts only y and yes, in any case and with spaces around", () => {
    for (const answer of ["y", "yes", "Y", "YES", "Yes", " y ", "\tyes"]) {
      assert.equal(isYes(answer), true, answer);
    }
    for (const answer of ["", " ", "n", "no", "ye", "yess", "y es", "sure", "1", "true", "oui"]) {
      assert.equal(isYes(answer), false, answer);
    }
  });
});

describe("confirm", () => {
  it("writes the lines and the prompt, then agrees on y", async () => {
    const { terminal, input, printed } = fakeTerminal();
    const answer = confirm(terminal, ["first", "second"]);
    input.write("y\n");
    assert.equal(await answer, true);
    assert.equal(printed(), "first\nsecond\nSign? [y/N] ");
  });

  it("agrees on yes typed with a carriage return, as a Windows terminal sends it", async () => {
    const { terminal, input } = fakeTerminal();
    const answer = confirm(terminal, []);
    input.write("YES\r\n");
    assert.equal(await answer, true);
  });

  it("declines n, an empty line and any other answer", async () => {
    for (const line of ["n\n", "\n", "no\n", "maybe\n"]) {
      const { terminal, input } = fakeTerminal();
      const answer = confirm(terminal, ["q"], "? ");
      input.write(line);
      assert.equal(await answer, false, JSON.stringify(line));
    }
  });

  it("reads only the first line", async () => {
    const { terminal, input } = fakeTerminal();
    const answer = confirm(terminal, []);
    input.write("n\ny\n");
    assert.equal(await answer, false);
  });

  it("declines when the input closes before a line, and ends the prompt's line", async () => {
    const { terminal, input, printed } = fakeTerminal();
    const answer = confirm(terminal, [], "Sign? ");
    input.end();
    assert.equal(await answer, false);
    assert.equal(printed(), "Sign? \n");
  });

  it("declines input that had already ended before the question", async () => {
    const { terminal, input, printed } = fakeTerminal();
    input.end();
    input.resume();
    await new Promise((resolve) => input.once("end", resolve));
    assert.equal(await confirm(terminal, []), false);
    assert.equal(printed(), "Sign? [y/N] \n");
  });

  it("declines input that was destroyed", async () => {
    const { terminal, input } = fakeTerminal();
    input.destroy();
    assert.equal(await confirm(terminal, []), false);
  });

  it("declines when the input fails", async () => {
    const { terminal, input } = fakeTerminal();
    const answer = confirm(terminal, []);
    input.destroy(new Error("read failed"));
    assert.equal(await answer, false);
  });

  it("takes a last line without a newline when the input ends", async () => {
    const { terminal, input } = fakeTerminal();
    const answer = confirm(terminal, []);
    input.end("y");
    assert.equal(await answer, true);
  });
});

describe("confirm on a real standard input", () => {
  const module = new URL("../../../src/internal/tasks/confirm.ts", import.meta.url).href;
  const script = `
    import { confirm } from ${JSON.stringify(module)};
    const agreed = await confirm({ interactive: true, input: process.stdin, output: process.stderr }, ["q"]);
    process.stdout.write(String(agreed));
  `;
  const run = (stdin: "ignore" | "pipe", input?: string) =>
    // Node 24.0 warns on stderr that type stripping is experimental; stderr must hold only the
    // question.
    spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
      {
        stdio: [stdin, "pipe", "pipe"],
        ...(input === undefined ? {} : { input }),
        encoding: "utf8",
        timeout: 20_000,
      },
    );

  it("declines, and exits, when standard input is closed or empty", () => {
    for (const result of [run("ignore"), run("pipe", "")]) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "false");
      assert.equal(result.stderr, "q\nSign? [y/N] \n");
    }
  });

  it("agrees on a piped yes", () => {
    const result = run("pipe", "yes\n");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "true");
  });
});

describe("processTerminal", () => {
  it("is interactive only when standard input and standard error are terminals", () => {
    const terminal = processTerminal();
    assert.equal(terminal.interactive, isatty(0) && isatty(2));
    assert.equal(terminal.output, process.stderr);
    assert.equal(terminal.input, process.stdin);
  });
});
