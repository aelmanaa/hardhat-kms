// Records every module specifier Node resolves, one per line, in the file named by IMPORT_LOG.
// Loaded with `node --import`, before the code under test.
import { register } from "node:module";

register("./import-recorder-hooks.mjs", import.meta.url, { data: { log: process.env.IMPORT_LOG } });
