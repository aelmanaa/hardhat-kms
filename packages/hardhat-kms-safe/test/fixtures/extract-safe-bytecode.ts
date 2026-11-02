// Spike helper (#653): copies the creation bytecode of the Safe singletons and proxy factories
// from the npm packages Safe publishes into `safe-bytecode.json`, and checks each singleton's
// runtime code against the canonical `codeHash` of @safe-global/safe-deployments, so the local
// anvil Safe runs the same code as the deployed ones.
//
//   node extract-safe-bytecode.ts <dir with the unpacked tarballs> <out file>
//
// The tarballs, unpacked with `tar xzf <tgz> -C <name>`:
//   gnosis-1.3.0                         @gnosis.pm/safe-contracts@1.3.0
//   safe-global-safe-contracts-1.4.1-2   @safe-global/safe-contracts@1.4.1-2
//   safe-global-safe-smart-account-1.5.0 @safe-global/safe-smart-account@1.5.0
//   safe-global-safe-deployments-1.37.66 @safe-global/safe-deployments@1.37.66
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { keccak256, type Hex } from "viem";

const dir = process.argv[2] ?? "";
const out = process.argv[3] ?? "";
if (dir === "" || out === "") {
  throw new Error("usage: extract-safe-bytecode.ts <dir> <out>");
}

interface Artifact {
  bytecode: Hex;
  deployedBytecode: Hex;
}

function artifact(file: string): Artifact {
  const parsed: unknown = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("bytecode" in parsed) ||
    !("deployedBytecode" in parsed) ||
    typeof parsed.bytecode !== "string" ||
    typeof parsed.deployedBytecode !== "string" ||
    !parsed.bytecode.startsWith("0x") ||
    !parsed.deployedBytecode.startsWith("0x")
  ) {
    throw new Error(`${file}: no bytecode`);
  }
  return {
    bytecode: `0x${parsed.bytecode.slice(2)}`,
    deployedBytecode: `0x${parsed.deployedBytecode.slice(2)}`,
  };
}

function canonicalCodeHash(version: string): string {
  const file = path.join(
    dir,
    "safe-global-safe-deployments-1.37.66/package/dist/assets",
    `v${version}`,
    version === "1.3.0" ? "gnosis_safe.json" : "safe.json",
  );
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const hash: unknown =
    typeof parsed === "object" && parsed !== null && "deployments" in parsed
      ? Reflect.get(Reflect.get(Object(parsed.deployments), "canonical") ?? {}, "codeHash")
      : undefined;
  if (typeof hash !== "string") {
    throw new Error(`${file}: no canonical codeHash`);
  }
  return hash;
}

const sources = {
  "1.3.0": {
    pkg: "@gnosis.pm/safe-contracts@1.3.0",
    safe: "gnosis-1.3.0/package/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json",
    factory:
      "gnosis-1.3.0/package/build/artifacts/contracts/proxies/GnosisSafeProxyFactory.sol/GnosisSafeProxyFactory.json",
  },
  "1.4.1": {
    pkg: "@safe-global/safe-contracts@1.4.1-2",
    safe: "safe-global-safe-contracts-1.4.1-2/package/build/artifacts/contracts/Safe.sol/Safe.json",
    factory:
      "safe-global-safe-contracts-1.4.1-2/package/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json",
  },
  "1.5.0": {
    pkg: "@safe-global/safe-smart-account@1.5.0",
    safe: "safe-global-safe-smart-account-1.5.0/package/build/artifacts/contracts/Safe.sol/Safe.json",
    factory:
      "safe-global-safe-smart-account-1.5.0/package/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json",
  },
} as const;

const result: Record<string, { source: string; codeHash: string; safe: Hex; factory: Hex }> = {};
for (const [version, source] of Object.entries(sources)) {
  const safe = artifact(source.safe);
  const codeHash = keccak256(safe.deployedBytecode);
  const canonical = canonicalCodeHash(version);
  process.stdout.write(
    `${version}: runtime code hash ${codeHash}, canonical ${canonical}, ${codeHash === canonical ? "match" : "DIFFERENT"}\n`,
  );
  result[version] = {
    source: source.pkg,
    codeHash,
    safe: safe.bytecode,
    factory: artifact(source.factory).bytecode,
  };
}
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
