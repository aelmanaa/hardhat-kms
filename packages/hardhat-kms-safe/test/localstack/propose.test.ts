// End to end on this machine: a secp256k1 key in LocalStack's AWS KMS, used through
// @hardhat-kms/aws and the real KMS API, owns Safes 1.3.0, 1.4.1 and 1.5.0 (canonical bytecode) on
// Hardhat's own node. `kms safe propose` signs each SafeTx through hardhat-kms's
// eth_signTypedData_v4, checks it with the Safe's checkNSignatures and posts it to the fake
// Transaction Service, which applies the real one's checks. Then the Safe executes it: 1-of-1 with
// the KMS signature alone, 2-of-3 with a second owner's.
//
// Needs Docker: `pnpm run test:localstack`. The network fence refuses every host but 127.0.0.1.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { CreateKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import hardhatKmsAws from "@hardhat-kms/aws";
import { kmsKeyAddress } from "hardhat-kms/provider-utils";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { concatHex, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { isolateAwsEnvironment } from "../../../hardhat-kms-aws/test/helpers/aws-env.ts";
import {
  startLocalStack,
  type LocalStack,
} from "../../../hardhat-kms-aws/test/helpers/localstack.ts";
import { NO_TERMINAL } from "../../../hardhat-kms/test/helpers/terminal.ts";
import hardhatKmsSafe from "../../src/index.ts";
import type { SafeProposal } from "../../src/internal/propose.ts";
import { safeTxTypedData } from "../../src/internal/safe-tx.ts";
import { proposeTask, type ProposeArguments } from "../../src/internal/tasks/propose.ts";
import { startFakeService, type FakeService } from "../helpers/fake-tx-service.ts";
import {
  API_KEY_VARIABLE,
  CHAIN_ID,
  FAKE_API_KEY,
  fenceNetwork,
  startNode,
  type Node,
} from "../helpers/harness.ts";
import { createSafe, deploySingleton, execute, SAFE_VERSIONS } from "../helpers/safe-chain.ts";

/** Hardhat's second default account (public test data): a second owner. */
const SECOND_OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

let localstack: LocalStack | undefined;
let restoreEnvironment: (() => void) | undefined;
let restoreFetch: (() => void) | undefined;
let node: Node | undefined;
let service: FakeService | undefined;
let hre: HardhatRuntimeEnvironment;
let owner: Address;

async function propose(args: Partial<ProposeArguments>): Promise<SafeProposal> {
  return await proposeTask(
    {
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
      ...args,
    },
    hre,
    NO_TERMINAL,
  );
}

describe("kms safe propose with a LocalStack AWS KMS key", { timeout: 300_000 }, () => {
  before(async () => {
    restoreEnvironment = isolateAwsEnvironment();
    restoreFetch = fenceNetwork();
    process.env[API_KEY_VARIABLE] = FAKE_API_KEY;
    localstack = await startLocalStack();
    const kms = new KMSClient({ region: "eu-west-1", endpoint: localstack.endpoint });
    const created = await kms.send(
      new CreateKeyCommand({ KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY" }),
    );
    kms.destroy();
    const keyId = created.KeyMetadata?.KeyId;
    assert.ok(keyId !== undefined);
    node = await startNode();
    service = await startFakeService(node.chain.publicClient, FAKE_API_KEY);
    hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKmsAws, hardhatKmsSafe],
      kms: {
        keys: {
          owner: { provider: "aws", keyId, region: "eu-west-1", endpoint: localstack.endpoint },
        },
      },
      kmsSafe: {
        apiKey: configVariable(API_KEY_VARIABLE),
        services: { [String(CHAIN_ID)]: service.url },
      },
      networks: {
        default: { type: "http", url: node.url, chainId: CHAIN_ID, kmsAccounts: ["owner"] },
      },
    });
    owner = getAddress(await kmsKeyAddress(hre, "owner"));
  });

  after(async () => {
    await service?.close();
    await node?.close();
    localstack?.stop();
    restoreFetch?.();
    restoreEnvironment?.();
  });

  for (const version of SAFE_VERSIONS) {
    it(`Safe ${version}: 1-of-1, the KMS signature alone executes`, async () => {
      assert.ok(node !== undefined && service !== undefined);
      const singleton = await deploySingleton(node.chain, version);
      const safe = await createSafe(node.chain, singleton, [owner], 1n);
      const recipient = SECOND_OWNER.address;
      const balance = await node.chain.publicClient.getBalance({ address: recipient });
      const proposal = await propose({ safe, to: recipient, value: 1000n });
      assert.equal(proposal.version, version);
      const stored = service.proposals.find((p) => p.safeTxHash === proposal.safeTxHash);
      assert.equal(stored?.confirmations[0]?.owner, owner);
      assert.ok(service.requests.every((r) => r.authorized));
      assert.equal(await execute(node.chain, proposal, proposal.signature), true);
      assert.equal(
        await node.chain.publicClient.getBalance({ address: recipient }),
        balance + 1000n,
      );
    });

    it(`Safe ${version}: 2-of-3, a second owner confirms, both execute`, async () => {
      assert.ok(node !== undefined);
      const chain = node.chain;
      const singleton = await deploySingleton(chain, version);
      const safe = await createSafe(
        chain,
        singleton,
        [owner, SECOND_OWNER.address, chain.deployer],
        2n,
      );
      const first = await propose({ safe, to: SECOND_OWNER.address, value: 1n });
      const second = await propose({
        safe,
        to: SECOND_OWNER.address,
        value: 2n,
        data: "0xdeadbeef",
      });
      assert.equal(first.transaction.nonce, 0n);
      assert.equal(second.transaction.nonce, 1n);
      const packed = async (p: SafeProposal): Promise<Hex> => {
        const typed = safeTxTypedData(p.chainId, p.safe, p.transaction);
        const other = await SECOND_OWNER.signTypedData({
          domain: { chainId: Number(p.chainId), verifyingContract: p.safe },
          types: { SafeTx: typed.types.SafeTx },
          primaryType: "SafeTx",
          message: p.transaction,
        });
        const signatures: [Address, Hex][] = [
          [p.sender, p.signature],
          [SECOND_OWNER.address, other],
        ];
        signatures.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
        return concatHex(signatures.map(([, signature]) => signature));
      };
      assert.equal(await execute(chain, first, await packed(first)), true);
      assert.equal(await execute(chain, second, await packed(second)), true);
    });
  }

  it("refuses a Safe the key does not own", async () => {
    assert.ok(node !== undefined);
    const singleton = await deploySingleton(node.chain, "1.4.1");
    const safe = await createSafe(node.chain, singleton, [SECOND_OWNER.address], 1n);
    await assert.rejects(propose({ safe, to: safe }), /is not an owner of the Safe/);
  });
});
