// Module hooks that make `viem` unresolvable, as in a project that does not install it, and log
// each attempt to resolve it to the file in HARDHAT_KMS_NO_VIEM_LOG. The hook is synchronous, so
// it works with module.registerHooks and with module.register.
import { appendFileSync } from "node:fs";

export function resolve(specifier, context, nextResolve) {
  if (specifier === "viem" || specifier.startsWith("viem/")) {
    const log = process.env.HARDHAT_KMS_NO_VIEM_LOG;
    if (log !== undefined && log !== "") {
      appendFileSync(log, `resolve ${specifier}\n`);
    }
    const error = new Error(`Cannot find package '${specifier}'`);
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return nextResolve(specifier, context);
}
