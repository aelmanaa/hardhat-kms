// The hosted service's chains, the canonical Safe code, and the task run through Hardhat's task
// runner. A node with Sepolia's chain id stands in for Sepolia; the network fence refuses
// api.safe.global, so no request leaves 127.0.0.1.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { configVariable } from "hardhat/config";
import { keccak256 } from "viem";

import { NO_TERMINAL } from "../../../hardhat-kms/test/helpers/terminal.ts";
import { proposeTask, type ProposeArguments } from "../../src/internal/tasks/propose.ts";
import {
  API_KEY_VARIABLE,
  FAKE_API_KEY,
  createProject,
  fenceNetwork,
  REFUSED,
  startNode,
  type Node,
  type Project,
} from "../helpers/harness.ts";
import { bytecodeOf, createSafe, deploySingleton, SAFE_VERSIONS } from "../helpers/safe-chain.ts";

const SEPOLIA = 11155111;

let node: Node;
let restoreFetch: () => void;

const args = (safe: string): ProposeArguments => ({
  safe,
  to: safe,
  value: 0n,
  data: undefined,
  function: undefined,
  args: undefined,
  key: undefined,
  nonce: undefined,
  delegatecall: false,
  yes: true,
});

/** A project on the Sepolia stand-in, with or without an API key. */
async function project(sepolia: Node, withKey: boolean): Promise<Project> {
  return await createProject(
    sepolia,
    () => (withKey ? { apiKey: configVariable(API_KEY_VARIABLE) } : {}),
    {
      networks: {
        default: { type: "http", url: sepolia.url, chainId: SEPOLIA, kmsAccounts: ["owner"] },
      },
    },
  );
}

describe("Safe's hosted service, and the canonical Safe code", { timeout: 120_000 }, () => {
  before(async () => {
    restoreFetch = fenceNetwork();
    node = await startNode(SEPOLIA);
  });

  after(async () => {
    await node?.close();
    restoreFetch?.();
  });

  it("deploys Safes whose runtime code hash is the canonical one", async () => {
    for (const version of SAFE_VERSIONS) {
      const { singleton } = await deploySingleton(node.chain, version);
      const code = await node.chain.publicClient.getCode({ address: singleton });
      assert.ok(code !== undefined);
      assert.equal(keccak256(code), bytecodeOf(version).codeHash, version);
    }
  });

  it("needs an API key for Safe's hosted service, before anything is signed", async () => {
    const p = await project(node, false);
    try {
      const singleton = await deploySingleton(node.chain, "1.4.1");
      const safe = await createSafe(node.chain, singleton, [p.owner], 1n);
      await assert.rejects(
        proposeTask(args(safe), p.hre, NO_TERMINAL),
        /Safe's Transaction Service needs an API key\. Set kmsSafe\.apiKey/,
      );
      assert.equal(p.signCalls(), 0);
    } finally {
      await p.close();
    }
  });

  it("sends to api.safe.global/tx-service/sep, which the fence refuses here", async () => {
    const p = await project(node, true);
    try {
      const singleton = await deploySingleton(node.chain, "1.5.0");
      const safe = await createSafe(node.chain, singleton, [p.owner], 1n);
      await assert.rejects(
        proposeTask(args(safe), p.hre, NO_TERMINAL),
        /did not answer the list of queued transactions\. Nothing was signed/,
      );
      assert.equal(p.signCalls(), 0);
      assert.deepEqual(REFUSED.at(-1), {
        url: `https://api.safe.global/tx-service/sep/api/v2/safes/${safe}/multisig-transactions/?executed=false&nonce__gte=0&ordering=-nonce&limit=1`,
        authorization: `Bearer ${FAKE_API_KEY}`,
      });
    } finally {
      await p.close();
    }
  });

  it("refuses a chain Safe's service does not serve, such as Avalanche Fuji", async () => {
    const fuji = await startNode(43113);
    try {
      const p = await createProject(fuji, () => ({ apiKey: configVariable(API_KEY_VARIABLE) }), {
        networks: {
          default: { type: "http", url: fuji.url, chainId: 43113, kmsAccounts: ["owner"] },
        },
      });
      try {
        await assert.rejects(
          proposeTask(args(fuji.chain.deployer), p.hre, NO_TERMINAL),
          /Safe's Transaction Service does not serve chain 43113\. Set kmsSafe\.services .* or execute the transaction from the Safe directly/,
        );
        assert.equal(p.signCalls(), 0);
      } finally {
        await p.close();
      }
    } finally {
      await fuji.close();
    }
  });
});

describe("kms safe propose through Hardhat's task runner", { timeout: 120_000 }, () => {
  it("parses the arguments and proposes", async () => {
    const restore = fenceNetwork();
    const local = await startNode();
    const p = await createProject(local);
    try {
      const singleton = await deploySingleton(local.chain, "1.4.1");
      const safe = await createSafe(local.chain, singleton, [p.owner, local.chain.deployer], 2n);
      const result: unknown = await p.hre.tasks
        .getTask(["kms", "safe", "propose"])
        .run({ safe, to: local.chain.deployer, value: 3n, nonce: "0" });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(Reflect.get(result, "safe"), safe);
      assert.equal(p.service.proposals.length, 1);
      assert.equal(p.service.proposals[0]?.nonce, 0n);
    } finally {
      await p.close();
      await local.close();
      restore();
    }
  });
});
