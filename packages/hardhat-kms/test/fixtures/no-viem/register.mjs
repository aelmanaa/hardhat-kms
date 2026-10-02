// Loaded with --import: registers hooks.mjs before the script runs.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
