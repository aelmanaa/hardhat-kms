import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configVariable, type HardhatUserConfig } from "hardhat/config";
import type { HardhatConfig } from "hardhat/types/config";

import { resolveKmsConfig, resolveKmsUserConfig } from "../../../src/internal/config/resolve.ts";
import { assertError, validate } from "../../helpers/config-validation.ts";
import { fakeResolver } from "../../helpers/config-variables.ts";

const SIMPLE = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
const HASH = `0x${"Ab".repeat(32)}`;
const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

/** Every place a key can be written, for each provider family the core validates. */
const KEY_FORMS: readonly [string, Record<string, unknown>][] = [
  ["aws", { provider: "aws", keyId: "alias/a" }],
  [
    "gcp",
    {
      provider: "gcp",
      keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
    },
  ],
  [
    "azure",
    {
      provider: "azure",
      keyId: "https://v.vault.azure.net/keys/k/0123456789abcdef0123456789abcdef",
    },
  ],
  [
    "turnkey",
    {
      provider: "turnkey",
      organizationId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      apiPrivateKey: configVariable("TURNKEY_API_PRIVATE_KEY"),
    },
  ],
  ["third-party", { provider: "myvault", name: "x" }],
];

const inKeys = (key: unknown) => ({ kms: { keys: { a: key } } });
const inline = (key: unknown) => ({ networks: { sepolia: { kmsAccounts: [key] } } });

describe("allowedDelegates: validation", () => {
  it("accepts entries for all chains and for listed chains, with a label and a code hash", () => {
    const allowedDelegates = [
      { address: SIMPLE, chains: "all", label: "Simple7702Account" },
      { address: SIMPLE.toLowerCase(), chains: [1, 11155111], codeHash: HASH },
      { address: `0x${SIMPLE.slice(2).toUpperCase()}`, chains: [Number.MAX_SAFE_INTEGER] },
    ];
    for (const [name, key] of KEY_FORMS) {
      assert.deepEqual(validate(inKeys({ ...key, allowedDelegates })), [], name);
      assert.deepEqual(validate(inline({ ...key, allowedDelegates })), [], name);
    }
  });

  it("accepts an empty list, which allows only the zero address", () => {
    assert.deepEqual(validate(inKeys({ ...KEY_FORMS[0]?.[1], allowedDelegates: [] })), []);
  });

  it("refuses a list in another form", () => {
    for (const allowedDelegates of [SIMPLE, {}, null, true]) {
      assertError(
        inKeys({ provider: "aws", keyId: "alias/a", allowedDelegates }),
        "kms.keys.a.allowedDelegates",
        "Expected a list of delegates",
        1,
      );
    }
  });

  it("refuses a bad address: not an address, or a wrong EIP-55 checksum", () => {
    const wrongChecksum = "0x4cD241E8d1510e30b2076397afc7508Ae59C66c9";
    for (const [name, key] of KEY_FORMS) {
      for (const address of [wrongChecksum, "0x12", "4Cd241E8d1510e30b2076397afc7508Ae59C66c9"]) {
        assertError(
          inKeys({ ...key, allowedDelegates: [{ address, chains: "all" }] }),
          "kms.keys.a.allowedDelegates.0.address",
          "valid EIP-55 checksum",
          1,
        );
      }
      assertError(
        inline({ ...key, allowedDelegates: [{ address: wrongChecksum, chains: "all" }] }),
        "networks.sepolia.kmsAccounts.0.allowedDelegates.0.address",
        "valid EIP-55 checksum",
        1,
      );
      assert.ok(name !== "");
    }
  });

  it("refuses missing, empty or malformed chains", () => {
    const at = "kms.keys.a.allowedDelegates.0.chains";
    for (const chains of [[], "All", "", 1, {}, null]) {
      assertError(
        inKeys({
          provider: "aws",
          keyId: "alias/a",
          allowedDelegates: [{ address: SIMPLE, chains }],
        }),
        at,
        'Expected "all" or a non-empty list of chain ids',
        1,
      );
    }
    const errors = validate(
      inKeys({ provider: "aws", keyId: "alias/a", allowedDelegates: [{ address: SIMPLE }] }),
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.path, at);
  });

  it("refuses a chain id that is not a positive safe integer, with a plain message", () => {
    for (const chain of [-1, 1.5, "1", "0x1", 1n, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      const errors = validate(
        inKeys({
          provider: "aws",
          keyId: "alias/a",
          allowedDelegates: [{ address: SIMPLE, chains: [1, chain] }],
        }),
      );
      assert.deepEqual(
        errors,
        [
          {
            path: "kms.keys.a.allowedDelegates.0.chains.1",
            message: "Expected a positive integer chain id, as a number",
          },
        ],
        String(chain),
      );
    }
  });

  it("refuses chain 0 with a hint to use all", () => {
    assert.deepEqual(
      validate(
        inKeys({
          provider: "aws",
          keyId: "alias/a",
          allowedDelegates: [{ address: SIMPLE, chains: [0] }],
        }),
      ),
      [
        {
          path: "kms.keys.a.allowedDelegates.0.chains.0",
          message:
            'Chain 0 cannot be listed. A chain-0 authorization is valid on every chain: allow it with chains: "all"',
        },
      ],
    );
  });

  it("refuses a malformed code hash, and the hash of empty code", () => {
    for (const codeHash of [
      "",
      "0x",
      HASH.slice(0, -2),
      `${HASH}00`,
      HASH.slice(2),
      `0x${"g".repeat(64)}`,
    ]) {
      assertError(
        inKeys({
          provider: "aws",
          keyId: "alias/a",
          allowedDelegates: [{ address: SIMPLE, chains: "all", codeHash }],
        }),
        "kms.keys.a.allowedDelegates.0.codeHash",
        "Expected a 0x-prefixed 32-byte keccak256 hash",
      );
    }
    for (const codeHash of [EMPTY_CODE_HASH, EMPTY_CODE_HASH.toUpperCase().replace("0X", "0x")]) {
      assertError(
        inKeys({
          provider: "aws",
          keyId: "alias/a",
          allowedDelegates: [{ address: SIMPLE, chains: "all", codeHash }],
        }),
        "kms.keys.a.allowedDelegates.0.codeHash",
        "the hash of empty code",
        1,
      );
    }
  });

  it("refuses a label that is empty, too long, padded or holds control characters", () => {
    for (const label of [
      "",
      "x".repeat(65),
      " x",
      "x ",
      "a\u001b[2Jb",
      "a\nb",
      "a\u202eb",
      "a\u2028b",
      "a\u2029b",
      "a\ud800b",
      "a\ue000b",
      "a\u0085b",
      1,
    ]) {
      const errors = validate(
        inKeys({
          provider: "aws",
          keyId: "alias/a",
          allowedDelegates: [{ address: SIMPLE, chains: "all", label }],
        }),
      );
      assert.equal(errors.length, 1, JSON.stringify(label));
      assert.equal(errors[0]?.path, "kms.keys.a.allowedDelegates.0.label");
    }
    assert.deepEqual(
      validate(
        inKeys({
          provider: "aws",
          keyId: "alias/a",
          allowedDelegates: [{ address: SIMPLE, chains: "all", label: "x".repeat(64) }],
        }),
      ),
      [],
    );
  });

  it("refuses unknown fields in an entry, such as a misspelled chains", () => {
    assertError(
      inKeys({
        provider: "aws",
        keyId: "alias/a",
        allowedDelegates: [{ address: SIMPLE, chains: "all", chain: 1 }],
      }),
      "kms.keys.a.allowedDelegates.0",
      "Unrecognized key(s) in object: 'chain'",
      1,
    );
  });
});

describe("allowedDelegates: resolution", () => {
  const resolver = fakeResolver({});

  it("checksums addresses, lowercases code hashes and freezes the list", () => {
    const config: HardhatUserConfig = {
      kms: {
        keys: {
          a: {
            provider: "aws",
            keyId: "alias/a",
            allowedDelegates: [
              { address: SIMPLE.toLowerCase(), chains: [1, 5], label: "simple", codeHash: HASH },
              { address: SIMPLE, chains: "all" },
            ],
          },
          b: { provider: "aws", keyId: "alias/b" },
          c: { provider: "aws", keyId: "alias/c", allowedDelegates: [] },
        },
      },
    };
    const keys = resolveKmsConfig(config, resolver).keys;
    const list = keys.a?.allowedDelegates;
    assert.deepEqual(list, [
      { address: SIMPLE, chains: [1, 5], label: "simple", codeHash: HASH.toLowerCase() },
      { address: SIMPLE, chains: "all" },
    ]);
    assert.ok(list !== undefined && Object.isFrozen(list));
    assert.ok(list.every((entry) => Object.isFrozen(entry)));
    assert.ok(Array.isArray(list[0]?.chains) && Object.isFrozen(list[0].chains));
    assert.equal(keys.b !== undefined && "allowedDelegates" in keys.b, false);
    // Code that runs after the config loads cannot change a key, or the keys, in place.
    const a = keys.a;
    assert.ok(a !== undefined && Object.isFrozen(a) && Object.isFrozen(keys));
    assert.equal(Reflect.set(a, "allowedDelegates", undefined), false);
    assert.equal(Reflect.set(keys, "a", keys.b), false);
    assert.deepEqual(keys.c?.allowedDelegates, []);
  });

  it("keeps the list of an inline key and a third-party key", () => {
    const allowedDelegates = [{ address: SIMPLE.toLowerCase(), chains: "all" as const }];
    const user: HardhatUserConfig = {
      kms: { keys: { vault: { provider: "myvault", name: "v", allowedDelegates } } },
      networks: {
        sepolia: {
          type: "http",
          url: "http://localhost:8545",
          kmsAccounts: [{ provider: "aws", keyId: "alias/a", allowedDelegates }],
        },
      },
    };
    const base: unknown = { networks: { sepolia: { type: "http" } } };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only `networks` is read
    const resolved = resolveKmsUserConfig(user, base as HardhatConfig, resolver);
    assert.deepEqual(resolved.kms.keys.vault?.allowedDelegates, [
      { address: SIMPLE, chains: "all" },
    ]);
    const network = resolved.networks.sepolia;
    assert.ok(network !== undefined && "kmsAccounts" in network);
    assert.deepEqual(network.kmsAccounts[0]?.allowedDelegates, [
      { address: SIMPLE, chains: "all" },
    ]);
    assert.ok(Object.isFrozen(network.kmsAccounts));
    assert.ok(Object.isFrozen(network.kmsAccounts[0]));
  });
});
