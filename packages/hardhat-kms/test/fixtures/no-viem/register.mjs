// Loaded with --import: installs the hooks of hooks.mjs before the script runs. Node 26 deprecates
// module.register (DEP0205) for module.registerHooks, which Node 22.13 does not have yet.
import nodeModule from "node:module";

import { resolve } from "./hooks.mjs";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register("./hooks.mjs", import.meta.url);
}
