// Records the URL of every module Node loads, one per line, in the file named by IMPORT_LOG.
// Loaded with `node --import`, before the code under test.
import { appendFileSync } from "node:fs";
import module from "node:module";
import { pathToFileURL } from "node:url";

const log = process.env.IMPORT_LOG;
const record = (url) => appendFileSync(log, `${url}\n`);

// IMPORT_RECORDER_ASYNC forces the fallback, so tests cover it on newer Node versions too.
if (typeof module.registerHooks === "function" && process.env.IMPORT_RECORDER_ASYNC !== "1") {
  // Synchronous hooks (Node >= 22.15) also see require() and require.resolve().
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      record(result.url);
      return result;
    },
  });
} else {
  module.register("./import-recorder-hooks.mjs", import.meta.url, { data: { log } });
}

// Asynchronous hooks do not see require(), so also list every CommonJS module loaded.
process.on("exit", () => {
  for (const file of Object.keys(module.createRequire(import.meta.url).cache)) {
    record(pathToFileURL(file).href);
  }
});
