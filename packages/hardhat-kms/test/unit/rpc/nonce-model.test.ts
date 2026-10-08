// A model-based test of the nonce subsystem (#445): fast-check runs random sequences of plugin
// sends, library sends (through the connection and with their own transport), resets, node
// answers, KMS delays, the library hold's time limit and connection close, over one account and
// two connections to one chain, and checks after every step that no send signs a nonce that
// another live send still owns.
//
// Every property runs a fixed seed by default, so a run, and a mutation run under Stryker, is
// reproducible. The nightly CI run sets NONCE_MODEL_SEED=random and NONCE_MODEL_RUNS=2000.
// Replay a failure with the seed, path and replayPath that fast-check prints:
//   NONCE_MODEL_SEED=<seed> NONCE_MODEL_PATH=<path> NONCE_MODEL_REPLAY_PATH=<replayPath> \
//   NONCE_MODEL_UNGUARD=1 node --test test/unit/rpc/nonce-model.test.ts
// (NONCE_MODEL_UNGUARD=1 runs the properties that UNTIL_434 skips, too.)
//
// The orderings that fail on main today (#434) are classified into their own `-434` kinds only
// when they match the known shape, and those kinds are skipped behind UNTIL_434. Every other
// violation of the same invariant keeps its plain kind, which the unguarded property checks.
// The shrunk counterexamples are fixed regression cases below.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import * as fc from "fast-check";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcResponse } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";

import {
  LIBRARY_HOLD_MS,
  libraryHoldOf,
  sendLocksInUse,
} from "../../../src/internal/rpc/send-guard.ts";
import {
  COW,
  gate,
  hashOf,
  nonceOf,
  resultOf,
  type SendHarness,
  settle,
  setUp,
  TO,
} from "../../helpers/send-harness.ts";

// An empty value, as CI sets outside its nightly run, means the default.
const env = (name: string): string | undefined => process.env[name] || undefined;
const RUNS = Number(env("NONCE_MODEL_RUNS") ?? "200");
/** A fixed seed unless NONCE_MODEL_SEED says otherwise; `random` lets fast-check pick one. */
const SEED_SETTING = env("NONCE_MODEL_SEED") ?? "445";
const SEED = SEED_SETTING === "random" ? undefined : Number(SEED_SETTING);
const PATH = env("NONCE_MODEL_PATH");
const REPLAY_PATH = env("NONCE_MODEL_REPLAY_PATH");
const UNGUARD = env("NONCE_MODEL_UNGUARD") === "1";
/** Each property's limit: about 15 ms a sequence locally, with room for slow CI runners. */
const PROPERTY_TIMEOUT_MS = Math.max(120_000, RUNS * 100);

/** The kinds of violation the model reports. Kinds ending in `-434` are guarded (see UNTIL_434). */
type Kind =
  /** A send signed a nonce the node already has from another send. */
  | "delivered"
  /** A send signed the nonce of a transaction whose broadcast got no answer. */
  | "uncertain"
  /** A send signed the nonce of a library send that holds the account's lock. */
  | "hold"
  /** A send on a connection signed a nonce that connection reserved for a live library send. */
  | "reservation"
  /** A hold outlived its time limit, or a lock or hold outlived the connections. */
  | "limit"
  /**
   * #434, item 2: a plugin send that skipped an own-transport reservation released it, or
   * #434, item 3: a reset that names no nonce released another unsigned reservation, and a send
   * then signed that reservation's nonce.
   */
  | "reservation-434"
  /**
   * #434, item 2 on edr-simulated (no high-water mark): a send signed a nonce its own connection
   * sent past the gap an own-transport or expired reservation left.
   */
  | "gap-434"
  /**
   * #434 (added to its scope by this suite): an own-transport send's reset, whose reservation the
   * node already has (below its pending count) or that was already released, ended another send's
   * hold, and a send then signed the held nonce.
   */
  | "reset-hold-434"
  /**
   * #434, item 1: a plugin send in flight when its connection closed reached the node, or a
   * library send through the connection waiting for the lock got a hold after the close.
   */
  | "close-434";

type Mode = "accept" | "refuse" | "no-answer";
type ConnectionIndex = 0 | 1;

interface PluginSend {
  kind: "plugin";
  id: number;
  connection: ConnectionIndex;
}

type LibraryState =
  | "consuming"
  | "consume-failed"
  | "consumed"
  | "signing"
  | "sign-failed"
  | "signed"
  | "broadcasting"
  | "delivered"
  | "refused"
  | "reset";

interface LibrarySend {
  kind: "library";
  id: number;
  connection: ConnectionIndex;
  transport: "through" | "own";
  state: LibraryState;
  nonce?: bigint;
  raw?: string;
  /** The hold's time limit made its nonce a reservation (through the connection only). */
  expired: boolean;
  /** The connection its raw transaction went through (through the connection only). */
  via?: ConnectionIndex;
  /**
   * While it held the lock, an own-transport send on its connection was reset with its
   * reservation below the node's pending count or already released (the reset-hold-434 shape).
   */
  holdLostToReset: boolean;
  /** A plugin send on its connection skipped this own-transport reservation (#434, item 2). */
  upToReleased: boolean;
  /** Another send's reset came while this reservation was unsigned (#434, item 3). */
  ambiguousReset: boolean;
  /** Its connection closed, which ended its hold or reservation. */
  orphaned: boolean;
  consume: () => Promise<number>;
  sign: (nonce: bigint) => Promise<string>;
  reset: () => void;
}

type Send = PluginSend | LibrarySend;

/** A transaction the node has. */
interface Delivered {
  /** The send that broadcast it. */
  id: number;
  /** Its broadcast got no answer. */
  uncertain: boolean;
  /** The connections whose send state recorded it: none for a library send's own transport. */
  recordedOn: ReadonlySet<ConnectionIndex>;
  /** It went out past a live reservation of a lower nonce on a connection that recorded it. */
  pastReservation: boolean;
}

/** The model, and the real system it drives. */
interface World {
  harness: SendHarness;
  connections: NetworkConnection<string>[];
  closed: [boolean, boolean];
  chainId: number;
  sends: Send[];
  /** The nonces the node has, by the send that broadcast them. */
  delivered: Map<bigint, Delivered>;
  type: "http" | "edr-simulated";
  mode: Mode;
  kms: { paused: boolean; gate: { promise: Promise<void>; open: () => void } };
  /** Every request the model started, so a run ends only when they all settled. */
  inFlight: Promise<unknown>[];
  /** How many of them settled. */
  settled: number;
  /** The send locks in use before the sequence. */
  locksBefore: number;
  violations: { kind: Kind; message: string }[];
  /** The kinds of violation this test fails on. */
  kinds: ReadonlySet<Kind>;
  /** Ticks the global setTimeout mock. */
  tick: (ms: number) => void;
}

const LIVE: ReadonlySet<LibraryState> = new Set(["consumed", "signing", "signed", "broadcasting"]);

/** The node's pending count: its first nonce with no transaction. */
function pendingOf(world: World): bigint {
  let pending = 0n;
  while (world.delivered.has(pending)) {
    pending++;
  }
  return pending;
}

/** The send lock's key of the model's account on the world's chain. */
const lockKey = (world: World): string => `${world.chainId}:${COW.toLowerCase()}`;

const valueOf = (raw: string): number => Number(Transaction.fromHex(raw, false).raw.value);

/**
 * Records a violation when `claimer` signs `nonce` while another send owns it. A send owns its
 * nonce: once the node has it; while a library send through the connection holds the lock for it;
 * and, on its own connection only, while a library send's reservation lasts (own transport, or a
 * hold past its time limit). Reservations are per connection by design
 * (docs/user/reference/library-accounts.md, "Some cases stay outside this").
 */
function checkClaim(world: World, claimer: Send, nonce: bigint, step: string): void {
  const had = world.delivered.get(nonce);
  if (had !== undefined && had.id !== claimer.id) {
    const what = `${step}: send ${claimer.id} on connection ${claimer.connection} signed nonce ${nonce}, which the node has from send ${had.id}${had.uncertain ? " (no answer)" : ""}`;
    if (nonce < pendingOf(world)) {
      // The node's pending count includes it.
      world.violations.push({ kind: had.uncertain ? "uncertain" : "delivered", message: what });
    } else if (had.recordedOn.has(claimer.connection)) {
      // Past a nonce gap, only the connection's own record (the high-water mark, kept on http
      // networks, or the uncertain record and its lookup) tells it the node has the nonce.
      world.violations.push({
        kind:
          world.type === "edr-simulated" && had.pastReservation
            ? "gap-434"
            : had.uncertain
              ? "uncertain"
              : "delivered",
        message: what,
      });
    }
    // Otherwise another connection, or a library send's own transport, sent it past a gap: each
    // connection remembers only its own nonces (docs/user/guides/uncertain-sends.md).
  }
  for (const other of world.sends) {
    if (
      other.kind !== "library" ||
      other.id === claimer.id ||
      other.nonce !== nonce ||
      !LIVE.has(other.state) ||
      other.orphaned
    ) {
      continue;
    }
    const sameConnection = other.connection === claimer.connection;
    if (other.transport === "through" && !other.expired) {
      world.violations.push({
        kind: other.holdLostToReset ? "reset-hold-434" : "hold",
        message: `${step}: send ${claimer.id} signed nonce ${nonce}, held by library send ${other.id}`,
      });
    } else if (sameConnection) {
      world.violations.push({
        kind: other.upToReleased || other.ambiguousReset ? "reservation-434" : "reservation",
        message: `${step}: send ${claimer.id} on connection ${claimer.connection} signed nonce ${nonce}, reserved for library send ${other.id} (${other.transport}${other.expired ? ", past the hold limit" : ""})`,
      });
    }
  }
}

/** What the fake node does with a raw transaction from the hook. */
function onRaw(world: World) {
  return async (raw: string): Promise<JsonRpcResponse> => {
    await Promise.resolve();
    const id = valueOf(raw);
    const nonce = nonceOf(raw);
    const send = world.sends[id];
    assert.ok(send !== undefined, `unknown transaction value ${id}`);
    if (send.kind === "plugin") {
      if (world.closed[send.connection]) {
        world.violations.push({
          kind: "close-434",
          message: `plugin send ${id} reached the node with nonce ${nonce} after connection ${send.connection} closed`,
        });
      } else {
        checkClaim(world, send, nonce, `plugin send ${id} broadcast`);
      }
    }
    if (world.mode === "refuse") {
      if (send.kind === "library") {
        send.state = "refused";
      }
      return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "insufficient funds" } };
    }
    deliver(world, send, nonce);
    if (world.mode === "no-answer") {
      throw new Error("socket hang up");
    }
    if (send.kind === "plugin") {
      // On main, an accepted plugin send releases the reservations up to its nonce.
      for (const reserved of reservationsOn(world, send.connection)) {
        if (
          reserved.transport === "own" &&
          reserved.nonce !== undefined &&
          reserved.nonce < nonce
        ) {
          reserved.upToReleased = true;
        }
      }
    }
    return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
  };
}

/** Records that the node has the send's transaction; with no answer, the send is uncertain. */
function deliver(world: World, send: Send, nonce: bigint): void {
  if (!world.delivered.has(nonce)) {
    const recordedOn = new Set<ConnectionIndex>();
    if (send.kind === "plugin") {
      recordedOn.add(send.connection);
    } else if (send.via !== undefined) {
      recordedOn.add(send.via).add(send.connection);
    }
    const pastReservation = [...recordedOn].some((connection) =>
      reservationsOn(world, connection).some(
        (reserved) => reserved.nonce !== undefined && reserved.nonce < nonce,
      ),
    );
    world.delivered.set(nonce, {
      id: send.id,
      uncertain: world.mode === "no-answer",
      recordedOn,
      pastReservation,
    });
  }
  if (send.kind === "library") {
    send.state = "delivered";
  }
  world.harness.node.pending = pendingOf(world);
}

/** Starts a request without waiting for it, and lets it run as far as it can. */
async function start(world: World, request: Promise<unknown>): Promise<void> {
  world.inFlight.push(
    request
      .catch(() => undefined)
      .finally(() => {
        world.settled++;
      }),
  );
  await settle();
}

const library = (world: World): LibrarySend[] =>
  world.sends.filter((send): send is LibrarySend => send.kind === "library");

/**
 * The live library sends whose nonce is a reservation on a connection: own transport, or a hold
 * past its time limit; not yet in the node.
 */
function reservationsOn(world: World, connection: ConnectionIndex): LibrarySend[] {
  return library(world).filter(
    (send) =>
      send.connection === connection &&
      !send.orphaned &&
      LIVE.has(send.state) &&
      send.nonce !== undefined &&
      !world.delivered.has(send.nonce) &&
      (send.transport === "own" || send.expired),
  );
}

/** A step of a sequence. */
type Step = fc.AsyncCommand<object, World>;

/** The violations of the test's kinds so far. */
const failures = (world: World): string[] =>
  world.violations
    .filter((violation) => world.kinds.has(violation.kind))
    .map((violation) => `${violation.kind}: ${violation.message}`);

/** Checks the invariants after the step. */
function checked(step: Step): Step {
  return {
    check: (model) => step.check(model),
    run: async (model, world) => {
      await step.run(model, world);
      assert.deepEqual(failures(world), [], `after ${step.toString()}`);
    },
    toString: () => step.toString(),
  };
}

const isOpen = (world: World, connection: ConnectionIndex): boolean => !world.closed[connection];

function pluginSend(connection: ConnectionIndex): Step {
  return {
    check: () => true,
    run: async (_model, world) => {
      if (!isOpen(world, connection)) {
        return;
      }
      const send: PluginSend = { kind: "plugin", id: world.sends.length, connection };
      world.sends.push(send);
      const target = world.connections[connection];
      assert.ok(target !== undefined);
      await start(
        world,
        world.harness.send(target, { from: COW, to: TO, value: `0x${send.id.toString(16)}` }),
      );
    },
    toString: () => `pluginSend(${connection})`,
  };
}

function libraryConsume(connection: ConnectionIndex, transport: "through" | "own"): Step {
  return {
    check: () => true,
    run: async (_model, world) => {
      if (!isOpen(world, connection)) {
        return;
      }
      const target = world.connections[connection];
      assert.ok(target !== undefined);
      const account = await target.kms.getAccount(COW);
      const parameters = {
        address: account.address,
        chainId: world.chainId,
        client: transport === "own" ? { transport: { type: "http" } } : {},
      };
      const id = world.sends.length;
      const send: LibrarySend = {
        kind: "library",
        id,
        connection,
        transport,
        state: "consuming",
        expired: false,
        holdLostToReset: false,
        upToReleased: false,
        ambiguousReset: false,
        orphaned: false,
        consume: async () => await account.nonceManager.consume(parameters),
        sign: async (nonce) =>
          await account.signTransaction({
            type: "eip1559",
            chainId: world.chainId,
            nonce: Number(nonce),
            gas: 21_000n,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
            to: TO,
            value: BigInt(id),
          }),
        reset: () => {
          account.nonceManager.reset(parameters);
        },
      };
      world.sends.push(send);
      await start(
        world,
        (async () => {
          try {
            send.nonce = BigInt(await send.consume());
          } catch (error) {
            send.state = "consume-failed";
            throw error;
          }
          send.state = "consumed";
          send.orphaned = world.closed[connection];
          if (send.orphaned && transport === "through") {
            // Its hold keeps the account's lock on every connection until the 60 s limit.
            world.violations.push({
              kind: "close-434",
              message: `library send ${id} got nonce ${send.nonce} and holds the lock after connection ${connection} closed`,
            });
          }
          checkClaim(world, send, send.nonce, `library send ${id} consume`);
        })(),
      );
    },
    toString: () => `libraryConsume(${connection}, ${transport})`,
  };
}

function librarySign(index: number): Step {
  return {
    check: () => true,
    run: async (_model, world) => {
      const send = library(world)[index];
      if (send?.state !== "consumed" || send.nonce === undefined) {
        return;
      }
      send.state = "signing";
      await start(
        world,
        (async (nonce: bigint) => {
          try {
            send.raw = await send.sign(nonce);
          } catch (error) {
            send.state = "sign-failed";
            throw error;
          }
          send.state = "signed";
        })(send.nonce),
      );
    },
    toString: () => `librarySign(${index})`,
  };
}

function libraryBroadcast(index: number, through: ConnectionIndex): Step {
  return {
    check: () => true,
    run: async (_model, world) => {
      const send = library(world)[index];
      if (send?.state !== "signed" || send.raw === undefined || send.orphaned) {
        return;
      }
      const raw = send.raw;
      if (send.transport === "own") {
        // Its own transport: the node gets it, the plugin never sees it.
        world.harness.node.raw.push(raw);
        if (world.mode === "refuse") {
          send.state = "refused";
        } else {
          deliver(world, send, nonceOf(raw));
        }
        return;
      }
      if (!isOpen(world, through)) {
        return;
      }
      const target = world.connections[through];
      assert.ok(target !== undefined);
      send.state = "broadcasting";
      send.via = through;
      await start(
        world,
        (async () => {
          const { response } = await world.harness.call(target, "eth_sendRawTransaction", [raw]);
          if ("error" in response && send.state === "broadcasting") {
            send.state = "refused";
          }
        })(),
      );
    },
    toString: () => `libraryBroadcast(${index}, ${through})`,
  };
}

/**
 * Marks the sends that a reset of `reset` can wrong on main today, in the two shapes #434 fixes:
 * - an own-transport send whose reservation the node already has, or that is already released,
 *   so the reset finds no reservation to end and ends the hold of the send that holds the lock;
 * - an unsigned reservation of another send, which a reset that names no nonce may release.
 */
function markKnownResetShapes(world: World, reset: LibrarySend): void {
  const reservations = reservationsOn(world, reset.connection);
  const nonce = reset.nonce;
  if (
    reset.transport === "own" &&
    nonce !== undefined &&
    (nonce < pendingOf(world) || reset.upToReleased || reset.ambiguousReset)
  ) {
    for (const held of library(world)) {
      if (
        held.transport === "through" &&
        held.connection === reset.connection &&
        LIVE.has(held.state) &&
        !held.expired
      ) {
        held.holdLostToReset = true;
      }
    }
  }
  if (reservations.includes(reset)) {
    for (const other of reservations) {
      if (other !== reset && (other.state === "consumed" || other.state === "signing")) {
        other.ambiguousReset = true;
      }
    }
  }
}

function libraryReset(index: number): Step {
  return {
    check: () => true,
    run: async (_model, world) => {
      const send = library(world)[index];
      // viem resets after a failure: before signing, at the broadcast, or after a timeout.
      const after = new Set<LibraryState>(["consumed", "sign-failed", "signed", "refused"]);
      const uncertain =
        send?.state === "delivered" &&
        send.nonce !== undefined &&
        world.delivered.get(send.nonce)?.uncertain === true;
      if (send === undefined || (!after.has(send.state) && !uncertain)) {
        return;
      }
      markKnownResetShapes(world, send);
      if (send.state !== "delivered") {
        send.state = "reset";
      }
      send.reset();
      await settle();
    },
    toString: () => `libraryReset(${index})`,
  };
}

function nodeMode(mode: Mode): Step {
  return {
    check: () => true,
    run: async (_model, world) => {
      world.mode = mode;
      await Promise.resolve();
    },
    toString: () => `nodeMode(${mode})`,
  };
}

function kms(paused: boolean): Step {
  return {
    check: () => true,
    run: async (_model, world) => {
      if (paused === world.kms.paused) {
        return;
      }
      world.kms.paused = paused;
      if (paused) {
        world.kms.gate = gate();
      } else {
        world.kms.gate.open();
      }
      await settle();
    },
    toString: () => (paused ? "kmsPause" : "kmsResume"),
  };
}

const holdLimit: Step = {
  check: () => true,
  run: async (_model, world) => {
    for (const send of library(world)) {
      if (send.transport === "through" && LIVE.has(send.state) && send.state !== "broadcasting") {
        send.expired = true;
      }
    }
    const before = libraryHoldOf(lockKey(world));
    world.tick(LIBRARY_HOLD_MS);
    await settle();
    // Invariant 5: no hold outlives its limit. The same object means the same send's hold.
    const after = libraryHoldOf(lockKey(world));
    if (before !== undefined && after === before) {
      world.violations.push({
        kind: "limit",
        message: `the hold of nonce ${before.nonce} outlived its ${LIBRARY_HOLD_MS / 1000} s limit`,
      });
    }
  },
  toString: () => "holdLimit",
};

function close(connection: ConnectionIndex): Step {
  return {
    check: () => true,
    run: async (_model, world) => {
      if (!isOpen(world, connection)) {
        return;
      }
      world.closed[connection] = true;
      for (const send of library(world)) {
        if (send.connection === connection) {
          send.orphaned = true;
        }
      }
      const target = world.connections[connection];
      assert.ok(target !== undefined);
      await world.harness.close(target);
      await settle();
    },
    toString: () => `close(${connection})`,
  };
}

const connectionArb = fc.constantFrom<ConnectionIndex>(0, 1);
const indexArb = fc.nat({ max: 2 });
const transportArb = fc.constantFrom<"through" | "own">("through", "own");

/** Each kind of step, and how often it is drawn relative to the others. */
const stepArbs: [fc.Arbitrary<Step>, number][] = [
  [connectionArb.map(pluginSend), 2],
  [fc.tuple(connectionArb, transportArb).map(([c, transport]) => libraryConsume(c, transport)), 3],
  [indexArb.map(librarySign), 1],
  [fc.tuple(indexArb, connectionArb).map(([index, c]) => libraryBroadcast(index, c)), 1],
  [indexArb.map(libraryReset), 2],
  // No answer twice as often: it is the path of the uncertain record and its lookup.
  [fc.constantFrom<Mode>("accept", "refuse", "no-answer", "no-answer").map(nodeMode), 2],
  [fc.boolean().map(kms), 1],
  [fc.constant(holdLimit), 1],
  [connectionArb.map(close), 1],
];

const steps = fc.commands(
  stepArbs.flatMap(([arb, weight]) => Array.from({ length: weight }, () => arb.map(checked))),
  { maxCommands: 10, ...(REPLAY_PATH === undefined ? {} : { replayPath: REPLAY_PATH }) },
);

/** A chain id per sequence: the send locks and holds are process-global, keyed by chain. */
let nextChainId = 50_000;

async function newWorld(
  t: TestContext,
  type: "http" | "edr-simulated",
  kinds: ReadonlySet<Kind>,
): Promise<World> {
  const chainId = nextChainId++;
  const harness = await setUp(type, chainId);
  const connections: NetworkConnection<string>[] = [];
  for (let i = 0; i < 2; i++) {
    const connection = await harness.open();
    // The fake node refuses eth_accounts, so the list is the KMS addresses only.
    resultOf((await harness.call(connection, "eth_accounts", [])).response);
    connections.push(connection);
  }
  const world: World = {
    harness,
    connections,
    closed: [false, false],
    chainId,
    sends: [],
    delivered: new Map(),
    type,
    mode: "accept",
    kms: { paused: false, gate: gate() },
    inFlight: [],
    settled: 0,
    locksBefore: sendLocksInUse(),
    violations: [],
    kinds,
    tick: (ms) => t.mock.timers.tick(ms),
  };
  harness.node.onRaw = onRaw(world);
  harness.node.lookUp = (hash) =>
    harness.node.raw.some(
      (raw) => hashOf(raw) === hash && world.delivered.get(nonceOf(raw))?.id === valueOf(raw),
    )
      ? { hash }
      : null;
  harness.state.beforeSign = async () => {
    if (world.kms.paused) {
      await world.kms.gate.promise;
    }
  };
  return world;
}

/**
 * Lets every request the sequence started settle: resumes the KMS, closes both connections, and
 * passes every time limit (the hold's, through the global setTimeout mock, and the lock's 120 s
 * stall, through the harness's timers). Invariant 5: after that, nothing waits, no hold is left
 * and no send lock is left in use.
 */
async function tearDown(world: World): Promise<void> {
  world.kms.paused = false;
  world.kms.gate.open();
  await settle();
  for (const index of [0, 1] as const) {
    await close(index).run({}, world);
  }
  // One round per waiting send at most: each can take a hold after the close, which lasts until
  // its limit. A sequence has at most 10 steps.
  for (
    let round = 0;
    round < 12 &&
    (world.settled < world.inFlight.length || libraryHoldOf(lockKey(world)) !== undefined);
    round++
  ) {
    world.tick(LIBRARY_HOLD_MS);
    world.harness.timers.fire();
    await settle();
  }
  const stuck = world.inFlight.length - world.settled;
  if (stuck > 0) {
    world.violations.push({
      kind: "limit",
      message: `${stuck} request(s) still waiting after both connections closed and every limit passed`,
    });
    return;
  }
  if (libraryHoldOf(lockKey(world)) !== undefined) {
    world.violations.push({ kind: "limit", message: "a hold outlived both connections" });
  }
  if (sendLocksInUse() > world.locksBefore) {
    world.violations.push({ kind: "limit", message: "a send lock outlived both connections" });
  }
}

/** Runs one sequence on a fresh world, and fails on a violation of one of `kinds`. */
async function runSequence(
  t: TestContext,
  type: "http" | "edr-simulated",
  sequence: Iterable<Step>,
  kinds: ReadonlySet<Kind>,
): Promise<void> {
  const world = await newWorld(t, type, kinds);
  try {
    await fc.asyncModelRun(() => ({ model: {}, real: world }), sequence);
  } finally {
    await tearDown(world);
  }
  assert.deepEqual(failures(world), [], "after the connections closed");
}

/** The global mocks every sequence needs. */
function mockGlobals(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
  // The library hold's time limit runs on the global setTimeout, which this mock drives.
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

/**
 * Sequences every run tries before the random ones: the orderings where a reset, a hold limit or
 * a lost answer meets a reservation or a hold, which random sequences of 10 steps reach rarely.
 */
const EXAMPLES: ["http" | "edr-simulated", Step[]][] = [
  // An own-transport send's reset while another send holds the lock: the hold stays.
  [
    "http",
    [libraryConsume(0, "own"), libraryConsume(0, "through"), libraryReset(0), pluginSend(0)],
  ],
  // The held send's own reset while an own-transport reservation lasts: the reservation's nonce
  // is still not signed by the plugin.
  [
    "http",
    [libraryConsume(0, "own"), libraryConsume(0, "through"), libraryReset(1), pluginSend(0)],
  ],
  // A hold past its limit becomes a reservation, which plugin sends keep skipping.
  ["edr-simulated", [libraryConsume(0, "through"), holdLimit, pluginSend(0), pluginSend(0)]],
  ["http", [libraryConsume(0, "through"), holdLimit, pluginSend(0), pluginSend(0)]],
  // A plugin send with no answer past a gap: the next send looks it up first.
  [
    "http",
    [libraryConsume(0, "through"), holdLimit, nodeMode("no-answer"), pluginSend(0), pluginSend(0)],
  ],
];

/**
 * Runs random sequences on both network types and fails on the first violation of one of `kinds`.
 */
async function check(t: TestContext, kinds: ReadonlySet<Kind>): Promise<void> {
  mockGlobals(t);
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<"http" | "edr-simulated">("http", "edr-simulated"),
      steps,
      async (type, sequence) => {
        await runSequence(t, type, sequence, kinds);
      },
    ),
    {
      numRuns: RUNS,
      endOnFailure: false,
      examples: EXAMPLES.map(([type, sequence]): ["http" | "edr-simulated", Step[]] => [
        type,
        sequence.map(checked),
      ]),
      ...(SEED === undefined ? {} : { seed: SEED }),
      ...(PATH === undefined ? {} : { path: PATH }),
    },
  );
}

/**
 * The guard on the invariants that fail on main today. #434's PR fixes each of these orderings
 * and removes this guard (and the `skip` options that use it).
 */
const UNTIL_434: string | false = UNGUARD
  ? false
  : "fails until #434 (https://github.com/aelmanaa/hardhat-kms/issues/434) lands; its PR removes this guard";

/** The shrunk counterexamples of the guarded kinds, as fixed regression cases. */
const KNOWN_434: {
  name: string;
  kind: Kind;
  type: "http" | "edr-simulated";
  steps: Step[];
}[] = [
  {
    name: "a send waiting for the lock when its connection closes does not broadcast",
    kind: "close-434",
    type: "http",
    steps: [libraryConsume(0, "through"), pluginSend(0), close(0)],
  },
  {
    name: "a send waiting for its KMS signature when its connection closes does not broadcast",
    kind: "close-434",
    type: "http",
    steps: [kms(true), pluginSend(0), close(0)],
  },
  {
    name: "a library send waiting for the lock when its connection closes takes no hold",
    kind: "close-434",
    type: "http",
    steps: [libraryConsume(0, "through"), libraryConsume(0, "through"), close(0)],
  },
  {
    name: "the older own-transport send's reset keeps the newer send's reservation",
    kind: "reservation-434",
    type: "http",
    steps: [libraryConsume(0, "own"), libraryConsume(0, "own"), libraryReset(0), pluginSend(0)],
  },
  {
    name: "a plugin send that skipped a reservation keeps it on edr-simulated",
    kind: "reservation-434",
    type: "edr-simulated",
    steps: [libraryConsume(0, "own"), pluginSend(0), pluginSend(0)],
  },
  {
    name: "a send past a reservation's gap on edr-simulated is not signed again on its connection",
    kind: "gap-434",
    type: "edr-simulated",
    steps: [
      libraryConsume(1, "own"),
      libraryConsume(0, "through"),
      pluginSend(1),
      nodeMode("no-answer"),
      libraryConsume(1, "through"),
      libraryReset(1),
    ],
  },
  {
    name: "an own-transport send's reset after the node took its nonce keeps another send's hold",
    kind: "reset-hold-434",
    type: "http",
    steps: [
      libraryConsume(0, "own"),
      libraryConsume(0, "through"),
      nodeMode("no-answer"),
      librarySign(0),
      libraryBroadcast(0, 0),
      libraryReset(0),
      nodeMode("accept"),
      pluginSend(0),
    ],
  },
  {
    name: "the same with the own-transport send's nonce taken on another connection",
    kind: "reset-hold-434",
    type: "http",
    steps: [
      libraryConsume(1, "own"),
      pluginSend(0),
      libraryConsume(1, "through"),
      libraryConsume(0, "through"),
      libraryReset(0),
    ],
  },
];

describe("the nonce subsystem, over random orderings of sends, resets, holds and close (#445)", () => {
  it(
    "never signs a nonce another live send owns, and no lock or hold outlives its limit",
    { timeout: PROPERTY_TIMEOUT_MS },
    async (t) => {
      await check(t, new Set<Kind>(["delivered", "uncertain", "hold", "reservation", "limit"]));
    },
  );

  it(
    "keeps a reservation through a plugin send that skips it and through another send's reset (#434)",
    { timeout: PROPERTY_TIMEOUT_MS, skip: UNTIL_434 },
    async (t) => {
      await check(t, new Set<Kind>(["reservation-434", "gap-434"]));
    },
  );

  it(
    "keeps a library send's hold through an own-transport send's reset (#434)",
    { timeout: PROPERTY_TIMEOUT_MS, skip: UNTIL_434 },
    async (t) => {
      await check(t, new Set<Kind>(["reset-hold-434"]));
    },
  );

  it(
    "sends nothing to the node from a connection after it closed (#434)",
    { timeout: PROPERTY_TIMEOUT_MS, skip: UNTIL_434 },
    async (t) => {
      await check(t, new Set<Kind>(["close-434"]));
    },
  );
});

describe("the model's shrunk counterexamples (#445)", () => {
  for (const known of KNOWN_434) {
    it(`${known.kind}: ${known.name}`, { skip: UNTIL_434 }, async (t) => {
      mockGlobals(t);
      await runSequence(t, known.type, known.steps.map(checked), new Set([known.kind]));
    });
  }

  it(
    "each still fails on main, only in its own guarded kind (remove with the guard in #434)",
    { skip: UNGUARD },
    async (t) => {
      // Keeps the cases honest while they are skipped: each reproduces its bug today, and in no
      // unguarded kind, so the guard hides nothing else.
      mockGlobals(t);
      const unguarded = new Set<Kind>(["delivered", "uncertain", "hold", "reservation", "limit"]);
      for (const known of KNOWN_434) {
        await assert.rejects(
          runSequence(t, known.type, known.steps.map(checked), new Set([known.kind])),
          new RegExp(`${known.kind}: `),
          known.name,
        );
        await runSequence(t, known.type, known.steps.map(checked), unguarded);
      }
    },
  );
});
