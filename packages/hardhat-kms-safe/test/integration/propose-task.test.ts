// `kms safe propose` on Hardhat's own node in this process, with Safes 1.3.0, 1.4.1 and 1.5.0 from
// their canonical bytecode, a fake KMS adapter that counts its sign requests, and a fake
// Transaction Service with the real one's checks. Every refusal before signing must leave the
// adapter's sign count unchanged.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { concatHex, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { NO_TERMINAL, answering } from "../../../hardhat-kms/test/helpers/terminal.ts";
import { proposeSafeTransaction, type SafeProposal } from "../../src/internal/propose.ts";
import { safeTxTypedData } from "../../src/internal/safe-tx.ts";
import { proposeTask, type ProposeArguments } from "../../src/internal/tasks/propose.ts";
import { TransactionServiceClient } from "../../src/internal/tx-service.ts";
import {
  CHAIN_ID,
  createProject,
  fenceNetwork,
  registerFakeKms,
  startNode,
  type Node,
  type Project,
} from "../helpers/harness.ts";
import {
  createSafe,
  deploySingleton,
  execute,
  SAFE_VERSIONS,
  type SafeSingleton,
  type SafeVersion,
} from "../helpers/safe-chain.ts";

/** Hardhat's second default account (public test data): an owner the test signs for. */
const SECOND_OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

let node: Node;
let project: Project;
let restoreFetch: () => void;
const singletons = new Map<SafeVersion, SafeSingleton>();

const defaults: ProposeArguments = {
  safe: "",
  to: "",
  value: 0n,
  data: undefined,
  function: undefined,
  args: undefined,
  key: undefined,
  nonce: undefined,
  delegatecall: false,
  yes: true,
};

/** Runs the task's action on the selected network with a terminal. */
async function propose(
  args: Partial<ProposeArguments>,
  terminal = NO_TERMINAL,
  hre: HardhatRuntimeEnvironment = project.hre,
): Promise<SafeProposal> {
  return await proposeTask({ ...defaults, ...args }, hre, terminal);
}

/** Expects a refusal by catalogue text, with no sign request to the KMS. */
async function refuses(run: () => Promise<unknown>, message: RegExp): Promise<void> {
  const count = project.signCalls();
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    return true;
  });
  assert.equal(project.signCalls(), count, "the KMS was asked to sign");
}

async function safeOf(
  version: SafeVersion,
  owners: Address[],
  threshold: bigint,
): Promise<Address> {
  const singleton = singletons.get(version);
  assert.ok(singleton !== undefined);
  return await createSafe(node.chain, singleton, owners, threshold);
}

/** The second owner's signature over a proposal's SafeTx. */
async function secondOwnerSignature(proposal: SafeProposal): Promise<Hex> {
  const typed = safeTxTypedData(proposal.chainId, proposal.safe, proposal.transaction);
  return await SECOND_OWNER.signTypedData({
    domain: { chainId: Number(proposal.chainId), verifyingContract: proposal.safe },
    types: { SafeTx: typed.types.SafeTx },
    primaryType: "SafeTx",
    message: proposal.transaction,
  });
}

/** Two owners' signatures, sorted by owner as the Safe requires. */
async function packed(proposal: SafeProposal): Promise<Hex> {
  const signatures: [Address, Hex][] = [
    [proposal.sender, proposal.signature],
    [SECOND_OWNER.address, await secondOwnerSignature(proposal)],
  ];
  signatures.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
  return concatHex(signatures.map(([, signature]) => signature));
}

/** A copy of the project's runtime whose selected network is `name`. */
async function withNetwork(name: string): Promise<HardhatRuntimeEnvironment> {
  const hre = await createHardhatRuntimeEnvironment(project.hre.userConfig, { network: name });
  registerFakeKms(hre, project.adapters);
  return hre;
}

async function deployRuntime(runtime: string): Promise<Address> {
  const length = (runtime.length - 2) / 2;
  const init = `0x61${length.toString(16).padStart(4, "0")}600e60003961${length.toString(16).padStart(4, "0")}6000f3${runtime.slice(2)}`;
  const hash = await node.chain.wallet.sendTransaction({
    account: node.chain.deployer,
    chain: node.chain.wallet.chain,
    data: `0x${init.slice(2)}`,
  });
  const receipt = await node.chain.publicClient.waitForTransactionReceipt({ hash });
  assert.ok(receipt.contractAddress !== null && receipt.contractAddress !== undefined);
  return getAddress(receipt.contractAddress);
}

describe("kms safe propose", { timeout: 120_000 }, () => {
  before(async () => {
    restoreFetch = fenceNetwork();
    node = await startNode();
    for (const version of SAFE_VERSIONS) {
      singletons.set(version, await deploySingleton(node.chain, version));
    }
    project = await createProject(node);
  });

  after(async () => {
    await project?.close();
    await node?.close();
    restoreFetch?.();
  });

  beforeEach(() => {
    project.service.canned.length = 0;
  });

  for (const version of SAFE_VERSIONS) {
    it(`Safe ${version}: a 1-of-1 proposal posts and executes with the KMS signature alone`, async () => {
      const safe = await safeOf(version, [project.owner], 1n);
      const recipient = node.chain.others[3] ?? node.chain.deployer;
      const balance = await node.chain.publicClient.getBalance({ address: recipient });
      const signs = project.signCalls();
      const proposal = await propose({ safe, to: recipient, value: 1000n });
      assert.equal(project.signCalls(), signs + 1);
      assert.equal(proposal.version, version);
      assert.equal(proposal.threshold, 1n);
      assert.equal(proposal.chainId, BigInt(CHAIN_ID));
      const stored = project.service.proposals.find((p) => p.safeTxHash === proposal.safeTxHash);
      assert.ok(stored);
      assert.equal(stored.proposer, project.owner);
      assert.equal(stored.confirmations[0]?.owner, project.owner);
      assert.equal(await execute(node.chain, proposal, proposal.signature), true);
      assert.equal(
        await node.chain.publicClient.getBalance({ address: recipient }),
        balance + 1000n,
      );
    });

    it(`Safe ${version}: 2-of-3 proposals take the next nonces and execute with a second owner`, async () => {
      const safe = await safeOf(
        version,
        [project.owner, SECOND_OWNER.address, node.chain.deployer],
        2n,
      );
      const first = await propose({ safe, to: SECOND_OWNER.address, value: 1n });
      const second = await propose({
        safe,
        to: SECOND_OWNER.address,
        value: 2n,
        data: "0xDEADBEEF",
      });
      assert.equal(first.transaction.nonce, 0n);
      assert.equal(second.transaction.nonce, 1n);
      assert.equal(second.transaction.data, "0xdeadbeef");
      assert.equal(second.threshold, 2n);
      assert.equal(await execute(node.chain, first, await packed(first)), true);
      assert.equal(await execute(node.chain, second, await packed(second)), true);
      // Both ran: the next proposal takes nonce 2 from the chain, as nothing is queued above it.
      const third = await propose({ safe, to: SECOND_OWNER.address });
      assert.equal(third.transaction.nonce, 2n);
    });
  }

  it("sends a self-hosted service no API key, and the body api-kit sends", async () => {
    const safe = await safeOf("1.4.1", [project.owner, SECOND_OWNER.address], 2n);
    const count = project.service.requests.length;
    const proposal = await propose({ safe, to: SECOND_OWNER.address, value: 5n });
    const requests = project.service.requests.slice(count);
    assert.deepEqual(
      requests.map((r) => r.method),
      ["GET", "POST"],
    );
    assert.ok(requests.every((r) => !r.hasAuthorization));
    assert.equal(
      requests[0]?.path,
      `/api/v2/safes/${safe}/multisig-transactions/?executed=false&nonce__gte=0&ordering=-nonce&limit=1`,
    );
    const body: unknown = JSON.parse(requests[1]?.body ?? "");
    assert.deepEqual(body, {
      to: SECOND_OWNER.address,
      value: "5",
      data: "0x",
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: 0,
      contractTransactionHash: proposal.safeTxHash,
      sender: project.owner,
      signature: proposal.signature,
      origin: "hardhat-kms",
    });
  });

  it("encodes --function with --args", async () => {
    const safe = await safeOf("1.5.0", [project.owner, SECOND_OWNER.address], 2n);
    const proposal = await propose({
      safe,
      to: safe,
      function: "addOwnerWithThreshold(address,uint256)",
      args: JSON.stringify([node.chain.deployer, "2"]),
    });
    assert.equal(
      proposal.transaction.data,
      encodeFunctionData({
        abi: parseAbi(["function addOwnerWithThreshold(address owner, uint256 _threshold)"]),
        args: [node.chain.deployer, 2n],
      }),
    );
  });

  it("takes an explicit nonce at or above the Safe's, to replace a queued transaction", async () => {
    const safe = await safeOf("1.4.1", [project.owner, SECOND_OWNER.address], 2n);
    await propose({ safe, to: SECOND_OWNER.address, value: 1n });
    const replacement = await propose({ safe, to: SECOND_OWNER.address, value: 9n, nonce: "0" });
    assert.equal(replacement.transaction.nonce, 0n);
    const later = await propose({ safe, to: SECOND_OWNER.address, nonce: "7" });
    assert.equal(later.transaction.nonce, 7n);
  });

  it("proposes a delegatecall only when asked", async () => {
    const safe = await safeOf("1.5.0", [project.owner, SECOND_OWNER.address], 2n);
    const connection = await project.hre.network.create();
    try {
      await refuses(
        async () =>
          await proposeSafeTransaction({
            provider: connection.provider,
            sender: project.owner,
            safe,
            call: { to: SECOND_OWNER.address, operation: 1 },
            service: new TransactionServiceClient({ url: project.service.url }),
          }),
        /operation 1 is a delegatecall: the Safe would run the code at 0x/,
      );
    } finally {
      await connection.close();
    }
    const proposal = await propose({ safe, to: SECOND_OWNER.address, delegatecall: true });
    assert.equal(proposal.transaction.operation, 1);
  });

  describe("refuses before the KMS signs", () => {
    it("an address with no code", async () => {
      await refuses(
        async () => await propose({ safe: node.chain.others[5] ?? "", to: SECOND_OWNER.address }),
        /there is no contract at 0x[0-9a-fA-F]{40} on chain 31337/,
      );
    });

    it("a contract whose VERSION is not supported", async () => {
      // Answers every call with the ABI encoding of the string "1.2.0".
      const runtime =
        "0x6060600c60003960606000f3" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000005" +
        "312e322e30000000000000000000000000000000000000000000000000000000";
      const address = await deployRuntime(runtime);
      await refuses(
        async () => await propose({ safe: address, to: SECOND_OWNER.address }),
        /is version "1\.2\.0"; the plugin proposes for Safe 1\.3\.0, 1\.4\.1 and 1\.5\.0 only/,
      );
    });

    it("a contract that is not a Safe", async () => {
      // PUSH0 PUSH0 RETURN: every call returns nothing.
      const address = await deployRuntime("0x5f5ff3");
      await refuses(
        async () => await propose({ safe: address, to: SECOND_OWNER.address }),
        /did not answer VERSION\(\) as a Safe does/,
      );
    });

    it("a Safe the key does not own", async () => {
      const safe = await safeOf("1.4.1", [SECOND_OWNER.address], 1n);
      await refuses(
        async () => await propose({ safe, to: SECOND_OWNER.address }),
        /is not an owner of the Safe .* Its owners are 0x/,
      );
    });

    it("a nonce below the Safe's", async () => {
      const safe = await safeOf("1.3.0", [project.owner], 1n);
      const done = await propose({ safe, to: SECOND_OWNER.address });
      assert.equal(await execute(node.chain, done, done.signature), true);
      await refuses(
        async () => await propose({ safe, to: SECOND_OWNER.address, nonce: "0" }),
        /the nonce 0 is below the Safe's nonce 1/,
      );
    });

    it("bad inputs", async () => {
      const safe = await safeOf("1.4.1", [project.owner], 1n);
      await refuses(
        async () => await propose({ safe: "0x1234", to: safe }),
        /safe is not an address/,
      );
      await refuses(async () => await propose({ safe, to: "nope" }), /to is not an address/);
      await refuses(
        async () => await propose({ safe, to: safe, data: "0x123" }),
        /not 0x-prefixed/,
      );
      await refuses(
        async () => await propose({ safe, to: safe, nonce: "-1" }),
        /--nonce is not a whole number/,
      );
      await refuses(
        async () => await propose({ safe, to: safe, nonce: String(2n ** 53n) }),
        /above 2\^53 - 1/,
      );
      await refuses(
        async () => await propose({ safe, to: safe, data: "0x", function: "f()" }),
        /either --data or --function/,
      );
      await refuses(
        async () => await propose({ safe, to: safe, args: "[]" }),
        /--args needs --function/,
      );
      await refuses(
        async () => await propose({ safe, to: safe, value: -1n }),
        /value must be a bigint from 0 to 2\^256 - 1/,
      );
    });

    it("a network without a KMS account, or with several and no --key", async () => {
      const safe = await safeOf("1.4.1", [project.owner], 1n);
      await refuses(
        async () => await propose({ safe, to: safe }, NO_TERMINAL, await withNetwork("none")),
        /the network none has no KMS account/,
      );
      await refuses(
        async () => await propose({ safe, to: safe }, NO_TERMINAL, await withNetwork("two")),
        /the network two has 2 KMS accounts\. Pass --key .*: owner, other/,
      );
    });

    it("a key that is not a KMS account of the network", async () => {
      const safe = await safeOf("1.4.1", [project.owner], 1n);
      await refuses(
        async () => await propose({ safe, to: safe, key: "other" }),
        /\(key other\) is not a KMS account of the network default/,
      );
    });

    it("a node on another chain than the network's chainId", async () => {
      const safe = await safeOf("1.4.1", [project.owner], 1n);
      await refuses(
        async () => await propose({ safe, to: safe }, NO_TERMINAL, await withNetwork("wrongChain")),
        /the node answers chain 31337, but the network is configured for chain 1\. Nothing was signed/,
      );
    });

    it("a 401 from the service on the queued list", async () => {
      const safe = await safeOf("1.4.1", [project.owner], 1n);
      project.service.canned.push({ status: 401, body: '{"detail":"Invalid API key."}' });
      await refuses(
        async () => await propose({ safe, to: safe }),
        /answered 401 to the list of queued transactions: it did not accept the API key\. Nothing was signed/,
      );
    });

    it("a redirect, which it never follows", async () => {
      const safe = await safeOf("1.4.1", [project.owner], 1n);
      project.service.canned.push({
        status: 302,
        headers: { Location: "https://example.com/elsewhere" },
      });
      await refuses(
        async () => await propose({ safe, to: safe }),
        /answered 302 to the list of queued transactions, which the plugin does not expect/,
      );
    });
  });

  it("proposes to a self-hosted service with the API key variable unset", async () => {
    const other = await createProject(node, (service) => ({
      apiKey: configVariable("HHKMS_TEST_SAFE_UNSET_KEY"),
      services: { [String(CHAIN_ID)]: service.url },
    }));
    try {
      Reflect.deleteProperty(process.env, "HHKMS_TEST_SAFE_UNSET_KEY");
      const safe = await safeOf("1.4.1", [other.owner, SECOND_OWNER.address], 2n);
      const proposal = await proposeTask(
        { ...defaults, safe, to: SECOND_OWNER.address },
        other.hre,
        NO_TERMINAL,
      );
      assert.equal(proposal.safe, safe);
      assert.ok(other.service.requests.every((r) => !r.hasAuthorization));
    } finally {
      await other.close();
    }
  });

  describe("threshold 1", () => {
    it("asks at a terminal and proposes on yes", async () => {
      const safe = await safeOf("1.5.0", [project.owner], 1n);
      const { terminal, asked } = answering("y\n");
      const proposal = await propose(
        {
          safe,
          to: SECOND_OWNER.address,
          yes: false,
          function: "approve(address,uint256)",
          args: `["${SECOND_OWNER.address}", "123456789012345678901"]`,
        },
        terminal,
      );
      assert.match(
        asked(),
        new RegExp(
          `Function:   approve\\(address,uint256\\) with ${SECOND_OWNER.address}, 123456789012345678901`,
        ),
      );
      assert.equal(proposal.threshold, 1n);
      assert.match(asked(), /Threshold:  1 of 1/);
      assert.match(asked(), /this signature alone lets anyone execute the transaction/);
      assert.match(asked(), new RegExp(`SafeTx:     ${proposal.safeTxHash}`));
    });

    it("refuses on any other answer, or closed input, without signing", async () => {
      const safe = await safeOf("1.5.0", [project.owner], 1n);
      for (const answer of ["n\n", "\n", undefined]) {
        const { terminal } = answering(answer);
        await refuses(
          async () => await propose({ safe, to: SECOND_OWNER.address, yes: false }, terminal),
          /not proposed: the answer was not yes\. Nothing was signed/,
        );
      }
      assert.equal(project.service.proposals.filter((p) => p.safe === safe).length, 0);
    });

    it("refuses without a terminal unless --yes", async () => {
      const safe = await safeOf("1.3.0", [project.owner], 1n);
      await refuses(
        async () => await propose({ safe, to: SECOND_OWNER.address, yes: false }),
        /has threshold 1, so this signature alone executes the transaction\. No terminal/,
      );
      const proposal = await propose({ safe, to: SECOND_OWNER.address, yes: true });
      assert.equal(proposal.threshold, 1n);
    });

    it("does not ask for a Safe whose threshold is above 1", async () => {
      const safe = await safeOf("1.5.0", [project.owner, SECOND_OWNER.address], 2n);
      const proposal = await propose({ safe, to: SECOND_OWNER.address, yes: false });
      assert.equal(proposal.threshold, 2n);
    });
  });

  describe("after the key signed", () => {
    it("a 500 on the proposal says to check the Safe app", async () => {
      const safe = await safeOf("1.4.1", [project.owner, SECOND_OWNER.address], 2n);
      // The list answers normally; the proposal gets a 500.
      const signs = project.signCalls();
      project.service.canned.push({ status: 200, body: '{"count":0,"results":[]}' });
      project.service.canned.push({ status: 500, body: "<html>secret</html>" });
      await assert.rejects(
        async () => await propose({ safe, to: SECOND_OWNER.address }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /answered 500 to the proposal\. It may be down/);
          assert.match(error.message, /check the Safe app before you propose it again/);
          assert.doesNotMatch(error.message, /secret/);
          return true;
        },
      );
      assert.equal(project.signCalls(), signs + 1);
    });

    it("a 422 shows the service's reasons and nothing else", async () => {
      const safe = await safeOf("1.4.1", [project.owner, SECOND_OWNER.address], 2n);
      project.service.canned.push({ status: 200, body: '{"count":0,"results":[]}' });
      project.service.canned.push({
        status: 422,
        body: JSON.stringify({ nonFieldErrors: ["Nonce already executed"], detail: "hidden" }),
      });
      await assert.rejects(
        async () => await propose({ safe, to: SECOND_OWNER.address }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /refused the proposal with 422: Nonce already executed/);
          assert.match(error.message, /the service did not store it/);
          assert.doesNotMatch(error.message, /hidden/);
          return true;
        },
      );
    });
  });

  it("shows nothing of an error body beyond the allow-listed reasons", async () => {
    const safe = await safeOf("1.4.1", [project.owner], 1n);
    for (const status of [400, 401, 403, 404, 422, 429, 500, 503]) {
      project.service.canned.push({
        status,
        body: JSON.stringify({ detail: "detail-from-service", data: "data-from-service" }),
      });
      await assert.rejects(
        async () => await propose({ safe, to: safe }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /from-service/);
          return true;
        },
      );
    }
    // The key never reaches a self-hosted service, so it cannot echo it; the client also redacts
    // an echoed key (test/unit/tx-service.test.ts).
    assert.ok(project.service.requests.every((r) => !r.hasAuthorization));
  });
});
