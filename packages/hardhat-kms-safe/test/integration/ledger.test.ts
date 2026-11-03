// `kms safe propose --from` a Ledger address with the real @nomicfoundation/hardhat-ledger, on an
// http network whose `accounts` is "remote", so the node's own accounts are listed too.
//
// No Ledger device is used. hardhat-ledger shows "Connecting to Ledger..." through Hardhat's
// `userInterruptions` hook right before it opens the device, after it checked that it controls the
// address. The test throws from that message, which ends the request with hardhat-ledger's
// connection error. It proves that the signing request went to hardhat-ledger in this process and
// not to the node. The signature itself, and the request's shape, are tested with a stand-in for
// the device in propose-task.test.ts.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import hardhatLedger from "@nomicfoundation/hardhat-ledger";
import hardhatKms from "hardhat-kms";
import { getAddress } from "viem";

import { NO_TERMINAL } from "../../../hardhat-kms/test/helpers/terminal.ts";
import hardhatKmsSafe from "../../src/index.ts";
import { proposeTask, type ProposeArguments } from "../../src/internal/tasks/propose.ts";
import {
  CHAIN_ID,
  createProject,
  fenceNetwork,
  startNode,
  type Node,
  type Project,
} from "../helpers/harness.ts";
import { createSafe, deploySingleton } from "../helpers/safe-chain.ts";

/** An address the Ledger plugin is told it owns. No device holds it, and none is needed. */
const LEDGER_ACCOUNT = getAddress("0x000000000000000000000000000000000000bEEF");
const LEDGER_PLUGIN = "hardhat-ledger";
const LEDGER_CONNECTING = "Connecting to Ledger...";
const STOP = "stopped before opening a Ledger device";

const defaults: ProposeArguments = {
  safe: "",
  to: "",
  value: 0n,
  data: undefined,
  function: undefined,
  args: undefined,
  key: undefined,
  from: undefined,
  nonce: undefined,
  delegatecall: false,
  yes: true,
};

describe("kms safe propose --from a hardhat-ledger account", { timeout: 120_000 }, () => {
  let restoreFetch: () => void;
  let node: Node;
  let project: Project;
  const ledgerMessages: string[] = [];

  before(async () => {
    restoreFetch = fenceNetwork();
    node = await startNode();
    project = await createProject(node, undefined, {
      plugins: [hardhatLedger, hardhatKms, hardhatKmsSafe],
      networks: {
        default: {
          type: "http",
          url: node.url,
          chainId: CHAIN_ID,
          ledgerAccounts: [LEDGER_ACCOUNT],
        },
      },
    });
    project.hre.hooks.registerHandlers("userInterruptions", {
      displayMessage: async (context, interruptor, message, next) => {
        if (interruptor !== LEDGER_PLUGIN) {
          await next(context, interruptor, message);
          return;
        }
        ledgerMessages.push(message);
        if (message === LEDGER_CONNECTING) {
          throw new Error(STOP);
        }
      },
    });
  });

  after(async () => {
    await project?.close();
    await node?.close();
    restoreFetch?.();
  });

  it("sends the SafeTx to hardhat-ledger, which opens the device, and posts nothing", async () => {
    const singleton = await deploySingleton(node.chain, "1.5.0");
    const safe = await createSafe(node.chain, singleton, [LEDGER_ACCOUNT, node.chain.deployer], 2n);
    const posted = project.service.proposals.length;
    await assert.rejects(
      proposeTask(
        { ...defaults, safe, to: node.chain.deployer, from: LEDGER_ACCOUNT },
        project.hre,
        NO_TERMINAL,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(STOP));
        return true;
      },
    );
    assert.ok(ledgerMessages.includes(LEDGER_CONNECTING), "the Ledger plugin tried to connect");
    assert.deepEqual(
      project.signing.map((request) => [request.method, getAddress(request.address)]),
      [["eth_signTypedData_v4", LEDGER_ACCOUNT]],
    );
    assert.equal(project.service.proposals.length, posted);
    assert.equal(project.signCalls(), 0);
  });

  it("still refuses the node's own account next to the Ledger, before anything signs", async () => {
    const singleton = await deploySingleton(node.chain, "1.4.1");
    const safe = await createSafe(node.chain, singleton, [node.chain.deployer], 1n);
    const requests = project.signing.length;
    const messages = ledgerMessages.length;
    await assert.rejects(
      proposeTask(
        { ...defaults, safe, to: safe, from: node.chain.deployer },
        project.hre,
        NO_TERMINAL,
      ),
      /the network default has accounts: "remote", so 0x[0-9a-fA-F]{40} is one of the node's own accounts/,
    );
    assert.equal(project.signing.length, requests);
    assert.equal(ledgerMessages.length, messages);
  });
});
