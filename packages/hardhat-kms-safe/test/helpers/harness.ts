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
import type { ConfigurationVariableHooks, NetworkHooks } from "hardhat/types/hooks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { JsonRpcServer } from "hardhat/types/network";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { fakeAdapter, type FakeAdapter } from "../../../hardhat-kms/test/helpers/fake-adapter.ts";
import hardhatKmsSafe, { type KmsSafeUserConfig } from "../../src/index.ts";
import { fakeLedger, type FakeLedger } from "./fake-ledger.ts";
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

/** A key in the `local` and `mixed` networks' `accounts`: a fixed test value, never a real key. */
export const LOCAL_SECRET: Hex = `0x${"11".repeat(32)}`;

/** The `local` network's account. */
export const LOCAL_ADDRESS: Address = privateKeyToAccount(LOCAL_SECRET).address;

/**
 * The configuration variable of the `keystore` network's account. The test serves it from a
 * `fetchValue` hook, as hardhat-keystore does, and never from the environment.
 */
export const KEYSTORE_VARIABLE = "HHKMS_TEST_SAFE_PROPOSER_KEY";

/** The key the fake keystore holds: a fixed test value, never a real key. */
export const KEYSTORE_SECRET: Hex = `0x${"22".repeat(32)}`;

/** The `keystore` network's account. */
export const KEYSTORE_ADDRESS: Address = privateKeyToAccount(KEYSTORE_SECRET).address;

/** The JSON-RPC methods that ask a connection to sign. */
const SIGNING_METHODS = new Set([
  "eth_sign",
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
]);

/** A signing request a task sent on a connection. */
export interface SigningRequest {
  network: string;
  method: string;
  address: string;
}

/** The requests the fence refused, in order, with their Authorization header. */
export const REFUSED: { url: string; authorization: string | null }[] = [];

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
      REFUSED.push({
        url: url.href,
        authorization: new Headers(init?.headers).get("authorization"),
      });
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
 * in place of AWS KMS, and keeps each adapter so that tests can count its sign requests. It also
 * serves {@link KEYSTORE_VARIABLE} as hardhat-keystore would, and records every signing request
 * sent on a connection, before any plugin answers it.
 *
 * @param hre - The runtime.
 * @param adapters - Where to keep the adapters.
 * @param signing - Where to record signing requests.
 */
export function registerFakeKms(
  hre: HardhatRuntimeEnvironment,
  adapters: FakeAdapter[],
  signing: SigningRequest[] = [],
): void {
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
  const keystore: Partial<ConfigurationVariableHooks> = {
    fetchValue: async (context, variable, next) =>
      variable.name === KEYSTORE_VARIABLE ? KEYSTORE_SECRET : await next(context, variable),
  };
  hre.hooks.registerHandlers("configurationVariables", keystore);
  const network: Partial<NetworkHooks> = {
    onRequest: async (context, connection, request, next) => {
      if (SIGNING_METHODS.has(request.method)) {
        const params: unknown = request.params;
        const first: unknown = Array.isArray(params) ? params[0] : undefined;
        const second: unknown = Array.isArray(params) ? params[1] : undefined;
        // personal_sign puts the address second; eth_sendTransaction puts it in `from`.
        const address =
          request.method === "personal_sign"
            ? second
            : typeof first === "object" && first !== null
              ? Reflect.get(first, "from")
              : first;
        signing.push({
          network: connection.networkName,
          method: request.method,
          address: typeof address === "string" ? address : "",
        });
      }
      return await next(context, connection, request);
    },
  };
  hre.hooks.registerHandlers("network", network);
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
  /** Every signing request sent on a connection of the project, KMS or not. */
  signing: SigningRequest[];
  /** The fake Ledger on the `ledger` network. */
  ledger: FakeLedger;
  service: FakeService;
  /** Sign requests made to every adapter so far. */
  signCalls(): number;
  close(): Promise<void>;
}

/**
 * Creates the project. Its `default` network is the node over http with the `owner` key; `two`
 * has two KMS keys and `none` has none. `local` has the key {@link LOCAL_SECRET} in its `accounts`,
 * `keystore` a key read through a configuration variable, `mixed` both a local key and `owner`,
 * and `ledger` a fake Ledger; `none` and `ledger` keep Hardhat's default `accounts: "remote"`.
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
  // A self-hosted service: the plugin sends it no API key, so the fake requires none.
  const service = await startFakeService(node.chain.publicClient);
  const ledger = fakeLedger(["ledger"]);
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms, hardhatKmsSafe, ledger.plugin],
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
      local: { type: "http", url: node.url, chainId: CHAIN_ID, accounts: [LOCAL_SECRET] },
      keystore: {
        type: "http",
        url: node.url,
        chainId: CHAIN_ID,
        accounts: [configVariable(KEYSTORE_VARIABLE)],
      },
      mixed: {
        type: "http",
        url: node.url,
        chainId: CHAIN_ID,
        accounts: [LOCAL_SECRET],
        kmsAccounts: ["owner"],
      },
      ledger: { type: "http", url: node.url, chainId: CHAIN_ID, kmsAccounts: ["other"] },
      wrongChain: { type: "http", url: node.url, chainId: 1, kmsAccounts: ["owner"] },
    },
    ...extra,
  });
  const adapters: FakeAdapter[] = [];
  const signing: SigningRequest[] = [];
  registerFakeKms(hre, adapters, signing);
  const owner = getAddress(await kmsKeyAddress(hre, "owner"));
  const other = getAddress(await kmsKeyAddress(hre, "other"));
  return {
    hre,
    owner,
    other,
    adapters,
    signing,
    ledger,
    service,
    signCalls: () => adapters.reduce((total, adapter) => total + adapter.calls.signDigest, 0),
    close: async () => {
      await service.close();
    },
  };
}
