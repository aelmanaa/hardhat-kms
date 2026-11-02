// A Hardhat project with @hardhat-kms/safe, a KMS key served by a counting fake adapter, an
// in-process Hardhat node on 127.0.0.1 and a fake Transaction Service. Nothing leaves 127.0.0.1:
// fenceNetwork() refuses every other host for the global fetch.
import assert from "node:assert/strict";

import hardhatKms from "hardhat-kms";
import { kmsKeyAddress } from "hardhat-kms/provider-utils";
import type { KmsHooks } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatUserConfig } from "hardhat/types/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { JsonRpcServer } from "hardhat/types/network";
import { createPublicClient, createWalletClient, getAddress, http, type Address } from "viem";

import { fakeAdapter, type FakeAdapter } from "../../../hardhat-kms/test/helpers/fake-adapter.ts";
import hardhatKmsSafe, { type KmsSafeUserConfig } from "../../src/index.ts";
import { startFakeService, type FakeService } from "./fake-tx-service.ts";
import type { Chain } from "./safe-chain.ts";

/** The chain id of the in-process node. */
export const CHAIN_ID = 31337;

/** The environment variable the test config reads the API key from. */
export const API_KEY_VARIABLE = "HHKMS_TEST_SAFE_API_KEY";

/** The fake service's API key: not a secret. */
export const FAKE_API_KEY = "test-api-key-not-a-secret";

/** The KMS key's secret: a fixed test value, never a real key. */
export const OWNER_SECRET: Uint8Array = new Uint8Array(32).fill(7);

/** A second KMS key's secret, for networks with two KMS accounts. */
export const OTHER_SECRET: Uint8Array = new Uint8Array(32).fill(9);

/** The URLs the fence refused, in order. */
export const REFUSED: string[] = [];

/**
 * Replaces the global fetch with one that refuses every host but 127.0.0.1 and localhost.
 *
 * @returns A function that restores the previous fetch.
 */
export function fenceNetwork(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      REFUSED.push(url.href);
      throw new Error(`network fence: refused ${url.hostname}`);
    }
    return await realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** A running node. */
export interface Node {
  url: string;
  chain: Chain;
  close(): Promise<void>;
}

/**
 * Starts Hardhat's own node, in this process, on a free port of 127.0.0.1.
 *
 * @returns The node and clients for it.
 */
export async function startNode(chainId: number = CHAIN_ID): Promise<Node> {
  const hre = await createHardhatRuntimeEnvironment({
    networks: { node: { type: "edr-simulated", chainId } },
  });
  const server: JsonRpcServer = await hre.network.createServer("node", "127.0.0.1", 0);
  const { port } = await server.listen();
  const url = `http://127.0.0.1:${port}`;
  const chain = {
    id: chainId,
    name: "test",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  };
  const publicClient = createPublicClient({ chain, transport: http(url), pollingInterval: 10 });
  const accounts = await createWalletClient({ chain, transport: http(url) }).getAddresses();
  const [deployer, ...others] = accounts.map((account) => getAddress(account));
  assert.ok(deployer !== undefined);
  const wallet = createWalletClient({
    chain,
    transport: http(url),
    account: deployer,
    pollingInterval: 10,
  });
  return {
    url,
    chain: { publicClient, wallet, deployer, others },
    close: async () => {
      await server.close();
    },
  };
}

/**
 * Serves the project's `owner` and `other` keys with fake adapters that sign with fixed test keys,
 * in place of AWS KMS, and keeps each adapter so that tests can count its sign requests.
 *
 * @param hre - The runtime.
 * @param adapters - Where to keep the adapters.
 */
export function registerFakeKms(hre: HardhatRuntimeEnvironment, adapters: FakeAdapter[]): void {
  const handlers: Partial<KmsHooks> = {
    createKeyAdapter: async (_context, key) => {
      const adapter = fakeAdapter({
        secretKey: key.name === "other" ? OTHER_SECRET : OWNER_SECRET,
      });
      adapters.push(adapter);
      return await Promise.resolve(adapter);
    },
  };
  hre.hooks.registerHandlers("kms", handlers);
}

/** A project, its KMS key and the fake service. */
export interface Project {
  hre: HardhatRuntimeEnvironment;
  /** The KMS key's address. */
  owner: Address;
  /** The second KMS key's address, on the `two` network. */
  other: Address;
  /** Counts the adapters' KMS calls; `signDigest` is the only signing method. */
  adapters: FakeAdapter[];
  service: FakeService;
  /** Sign requests made to every adapter so far. */
  signCalls(): number;
  close(): Promise<void>;
}

/**
 * Creates the project. Its `default` network is the node over http with the `owner` key; `two`
 * has two KMS keys and `none` has none.
 *
 * @param node - The node.
 * @param kmsSafe - `kmsSafe` of the config; the fake service on chain 31337 by default.
 * @param extra - More config.
 * @returns The project.
 */
export async function createProject(
  node: Node,
  kmsSafe?: (service: FakeService) => KmsSafeUserConfig,
  extra: Partial<HardhatUserConfig> = {},
): Promise<Project> {
  process.env[API_KEY_VARIABLE] = FAKE_API_KEY;
  const service = await startFakeService(node.chain.publicClient, FAKE_API_KEY);
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms, hardhatKmsSafe],
    kms: {
      keys: {
        owner: { provider: "aws", keyId: "alias/safe-owner", region: "eu-west-1" },
        other: { provider: "aws", keyId: "alias/safe-other", region: "eu-west-1" },
      },
    },
    kmsSafe:
      kmsSafe === undefined
        ? {
            apiKey: configVariable(API_KEY_VARIABLE),
            services: { [String(CHAIN_ID)]: service.url },
          }
        : kmsSafe(service),
    networks: {
      default: { type: "http", url: node.url, chainId: CHAIN_ID, kmsAccounts: ["owner"] },
      two: { type: "http", url: node.url, chainId: CHAIN_ID, kmsAccounts: ["owner", "other"] },
      none: { type: "http", url: node.url, chainId: CHAIN_ID },
      wrongChain: { type: "http", url: node.url, chainId: 1, kmsAccounts: ["owner"] },
    },
    ...extra,
  });
  const adapters: FakeAdapter[] = [];
  registerFakeKms(hre, adapters);
  const owner = getAddress(await kmsKeyAddress(hre, "owner"));
  const other = getAddress(await kmsKeyAddress(hre, "other"));
  return {
    hre,
    owner,
    other,
    adapters,
    service,
    signCalls: () => adapters.reduce((total, adapter) => total + adapter.calls.signDigest, 0),
    close: async () => {
      await service.close();
    },
  };
}
