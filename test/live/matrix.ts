// The live suite's coverage matrix: every pair of action and transaction type, plus the signatures
// that are not transactions, with one decision each. The suite runs the cases listed here, and
// `matrix.test.ts` (in `pnpm test`, no keys needed) fails when a cell has no decision, more than
// one, or one that does not match the case it names. Every decision applies to each configured
// provider: a cell that one provider cannot run would need its own decision and reason.
//
// Decisions:
// - `live`: a case runs it on Sepolia and in fork mode.
// - `fork`: a case runs it only in fork mode, for the reason given.
// - `unit`: only a unit or integration test covers it; the file and test title are checked.
// - `refused`: the plugin refuses it before any request; a unit test checks the refusal.
// - `n/a`: the protocol does not allow it, for the reason given.

/** The transaction types, by viem's names for them, in type-number order. */
export const TX_TYPES = ["legacy", "eip2930", "eip1559", "eip4844", "eip7702"] as const;
export type TxType = (typeof TX_TYPES)[number];

/** How each type is written in tables. */
export const TYPE_TITLES: Record<TxType, string> = {
  legacy: "Type 0 (legacy)",
  eip2930: "Type 1 (EIP-2930)",
  eip1559: "Type 2 (EIP-1559)",
  eip4844: "Type 3 (EIP-4844)",
  eip7702: "Type 4 (EIP-7702)",
};

/** The actions a transaction can take: the rows of the matrix. */
export const ACTIONS = [
  { id: "eth-to-eoa", title: "ETH to another EOA" },
  { id: "eth-to-self", title: "ETH to self" },
  { id: "deploy", title: "Contract deploy" },
  { id: "call", title: "Contract call" },
  { id: "payable-call", title: "Payable contract call" },
  { id: "revert", title: "Reverting transaction, mined with status 0" },
  { id: "replacement", title: "Replacement (same nonce, higher fee)" },
  { id: "set-delegation", title: "EIP-7702 set delegation" },
  { id: "clear-delegation", title: "EIP-7702 clear delegation" },
  { id: "sponsor-other", title: "Sponsored: we send another key's authorization" },
  { id: "sponsored-by-other", title: "Sponsored: another account sends our authorization" },
] as const;
export type ActionId = (typeof ACTIONS)[number]["id"];

/** Signatures that are not transactions: one column each. */
export const SIGNATURES = [
  { id: "personal_sign", title: "`personal_sign`" },
  { id: "eth_signTypedData_v4", title: "`eth_signTypedData_v4`" },
  { id: "eth_sign", title: "`eth_sign`" },
] as const;
export type SignatureId = (typeof SIGNATURES)[number]["id"];

/** A cell: an action and a type, or a signature method. */
export type CellKey = `${ActionId}/${TxType}` | `signature/${SignatureId}`;

/** Every cell the matrix must decide, in table order. */
export const ALL_CELLS: readonly CellKey[] = [
  ...ACTIONS.flatMap((action) => TX_TYPES.map((type): CellKey => `${action.id}/${type}`)),
  ...SIGNATURES.map((signature): CellKey => `signature/${signature.id}`),
];

/**
 * Why a cell is not live. The letters are the footnotes of the rendered matrix. Each one that
 * rests on the protocol quotes the EIP.
 */
export type ReasonId = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "r";
export const REASONS: Record<ReasonId, string> = {
  a:
    "A self-send of type 0 or 1 takes the same fill and signing path as a send to another EOA of " +
    "the same type, which runs live. Self-sends of types 2 and 4 run live.",
  b:
    'EIP-4844: "`to` … MUST NOT be `nil` … blob transactions cannot have the form of a create ' +
    'transaction." The plugin refuses blob transactions anyway.',
  c:
    "EIP-7702 gives `destination` the semantics of EIP-4844: " +
    '"this implies a null destination is not valid."',
  d:
    "The revert path does not depend on the type: the receipt has status 0, and the next " +
    "transaction whose nonce the plugin fills carries the account's count after the revert, which " +
    "the type 2 case proves on Sepolia. The type 4 case also checks that the " +
    "delegation stays applied, since EIP-7702 does not roll back processed authorizations when " +
    "execution fails.",
  e:
    "A replacement needs a transaction that stays pending. On Sepolia that means pricing one below " +
    "the base fee through a load-balanced public RPC, where a backend may refuse it or mine it, and " +
    "a stuck nonce blocks the account. In fork mode the case turns automine off with " +
    "`evm_setAutomine`, sends, sends the replacement with double the fees, mines, and checks that " +
    "only the replacement was mined.",
  f:
    "EIP-7702: only a set-code transaction (type 4) carries an `authorization_list`, and the list " +
    "must not be empty. The plugin picks type 4 exactly when `authorizationList` is present and " +
    "refuses a `gasPrice` next to it.",
  g:
    "The other account signs the outer transaction; the plugin signs only the authorization, which " +
    "only type 4 carries (EIP-7702).",
  h:
    "On Sepolia the KMS account would first have to fund a second key, and ETH would stay there. " +
    "In fork mode `anvil_setBalance` funds a throwaway local sender for free. The KMS key signs the " +
    "authorization with its current nonce, not nonce + 1, since another account sends it.",
  r: "EIP-4844 blob transactions: the plugin refuses them before any request.",
};

/**
 * The decisions each reason may justify: a reason why the protocol forbids a cell cannot make it
 * fork-only, and a reason why a cell cannot run on Sepolia cannot make it not applicable.
 */
export const REASON_KINDS: Record<ReasonId, readonly Decision["kind"][]> = {
  a: ["fork"],
  b: ["n/a"],
  c: ["n/a"],
  d: ["fork"],
  e: ["fork"],
  f: ["n/a"],
  g: ["n/a"],
  h: ["fork"],
  r: ["refused"],
};

/** A unit or integration test, by its file (relative to the repository root) and title. */
export interface UnitRef {
  file: string;
  /** The test's literal title, as `it("…")` or `test("…")` gives it. */
  test: string;
}

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Finds a test by its literal title in a test file's source.
 *
 * @returns `found`, `missing` when no `it(` or `test(` call has the title (a title in a comment,
 *   or in `it.skip(` or `it.todo(`, does not count), or `skipped` when the call passes a `skip` or
 *   `todo` option.
 */
export function unitTestState(source: string, title: string): "found" | "missing" | "skipped" {
  const call = new RegExp(
    String.raw`(?<![.\w])(?:it|test)\(\s*(["'\x60])${escapeRegExp(title)}\1\s*(,\s*\{[^{}]*\})?`,
  );
  // Block comments and whole-line comments hold no test.
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
  const match = call.exec(code);
  if (match === null) {
    return "missing";
  }
  return /\b(?:skip|todo)\s*:/.test(match[2] ?? "") ? "skipped" : "found";
}

export type Decision =
  | { kind: "live"; case: CaseId }
  | { kind: "fork"; case: CaseId; reason: ReasonId; also?: UnitRef }
  | { kind: "unit"; unit: UnitRef }
  | { kind: "refused"; reason: ReasonId; unit: UnitRef }
  | { kind: "n/a"; reason: ReasonId };

const BLOB_REFUSAL: UnitRef = {
  file: "packages/hardhat-kms/test/unit/rpc/transaction-filler.test.ts",
  test: "refuses blob transactions before any request",
};
const refused: Decision = { kind: "refused", reason: "r", unit: BLOB_REFUSAL };
const notApplicable = (reason: ReasonId): Decision => ({ kind: "n/a", reason });
const live = (id: CaseId): Decision => ({ kind: "live", case: id });
const fork = (id: CaseId, reason: ReasonId, also?: UnitRef): Decision =>
  also === undefined
    ? { kind: "fork", case: id, reason }
    : { kind: "fork", case: id, reason, also };

/** One decision per cell. */
export const DECISIONS: readonly { cell: CellKey; decision: Decision }[] = [
  { cell: "eth-to-eoa/legacy", decision: live("eth-to-eoa-legacy") },
  { cell: "eth-to-eoa/eip2930", decision: live("eth-to-eoa-eip2930") },
  { cell: "eth-to-eoa/eip1559", decision: live("eth-to-eoa-eip1559") },
  { cell: "eth-to-eoa/eip4844", decision: refused },
  { cell: "eth-to-eoa/eip7702", decision: live("sponsor-other") },

  { cell: "eth-to-self/legacy", decision: fork("self-send-legacy", "a") },
  { cell: "eth-to-self/eip2930", decision: fork("self-send-eip2930", "a") },
  { cell: "eth-to-self/eip1559", decision: live("self-send-eip1559") },
  { cell: "eth-to-self/eip4844", decision: refused },
  { cell: "eth-to-self/eip7702", decision: live("clear-delegation") },

  { cell: "deploy/legacy", decision: live("deploy-minimal-legacy") },
  { cell: "deploy/eip2930", decision: live("deploy-minimal-eip2930") },
  { cell: "deploy/eip1559", decision: live("deploy-live-check") },
  { cell: "deploy/eip4844", decision: notApplicable("b") },
  { cell: "deploy/eip7702", decision: notApplicable("c") },

  { cell: "call/legacy", decision: live("call-legacy") },
  { cell: "call/eip2930", decision: live("call-eip2930") },
  { cell: "call/eip1559", decision: live("call-eip1559") },
  { cell: "call/eip4844", decision: refused },
  { cell: "call/eip7702", decision: live("delegate-and-call") },

  { cell: "payable-call/legacy", decision: live("call-legacy") },
  { cell: "payable-call/eip2930", decision: live("call-eip2930") },
  { cell: "payable-call/eip1559", decision: live("call-eip1559") },
  { cell: "payable-call/eip4844", decision: refused },
  { cell: "payable-call/eip7702", decision: live("delegate-and-call") },

  { cell: "revert/legacy", decision: fork("revert-legacy", "d") },
  { cell: "revert/eip2930", decision: fork("revert-eip2930", "d") },
  { cell: "revert/eip1559", decision: live("revert-eip1559") },
  { cell: "revert/eip4844", decision: refused },
  { cell: "revert/eip7702", decision: fork("revert-eip7702", "d") },

  { cell: "replacement/legacy", decision: fork("replace-legacy", "e") },
  { cell: "replacement/eip2930", decision: fork("replace-eip2930", "e") },
  {
    cell: "replacement/eip1559",
    decision: fork("replace-eip1559", "e", {
      file: "packages/hardhat-kms/test/integration/send-lock.test.ts",
      test: "keeps an explicit nonce and sends same-nonce replacements with higher fees",
    }),
  },
  { cell: "replacement/eip4844", decision: refused },
  { cell: "replacement/eip7702", decision: fork("replace-eip7702", "e") },

  { cell: "set-delegation/legacy", decision: notApplicable("f") },
  { cell: "set-delegation/eip2930", decision: notApplicable("f") },
  { cell: "set-delegation/eip1559", decision: notApplicable("f") },
  { cell: "set-delegation/eip4844", decision: notApplicable("f") },
  { cell: "set-delegation/eip7702", decision: live("delegate-and-call") },

  { cell: "clear-delegation/legacy", decision: notApplicable("f") },
  { cell: "clear-delegation/eip2930", decision: notApplicable("f") },
  { cell: "clear-delegation/eip1559", decision: notApplicable("f") },
  { cell: "clear-delegation/eip4844", decision: notApplicable("f") },
  { cell: "clear-delegation/eip7702", decision: live("clear-delegation") },

  { cell: "sponsor-other/legacy", decision: notApplicable("f") },
  { cell: "sponsor-other/eip2930", decision: notApplicable("f") },
  { cell: "sponsor-other/eip1559", decision: notApplicable("f") },
  { cell: "sponsor-other/eip4844", decision: notApplicable("f") },
  { cell: "sponsor-other/eip7702", decision: live("sponsor-other") },

  { cell: "sponsored-by-other/legacy", decision: notApplicable("g") },
  { cell: "sponsored-by-other/eip2930", decision: notApplicable("g") },
  { cell: "sponsored-by-other/eip1559", decision: notApplicable("g") },
  { cell: "sponsored-by-other/eip4844", decision: notApplicable("g") },
  { cell: "sponsored-by-other/eip7702", decision: fork("sponsored-by-other", "h") },

  { cell: "signature/personal_sign", decision: live("signatures") },
  { cell: "signature/eth_signTypedData_v4", decision: live("signatures") },
  { cell: "signature/eth_sign", decision: live("signatures") },
];

/** What a case's transactions must show in their receipts. */
interface Expect {
  /** `reverted` for a transaction mined with status 0. */
  status: "success" | "reverted";
  /** `kms` for the provider's account, `other` for a local account the case creates. */
  from: "kms" | "other";
}

/**
 * A case: one or more transactions, or on-chain checks, that cover the cells listed. Cases run in
 * this order for each provider, except a `cleanup` case, which runs last, also after a failure.
 */
export interface Case {
  id: CaseId;
  /** `live` runs on Sepolia and the fork; `fork` only on the fork. */
  mode: "live" | "fork";
  /** The type of every transaction it sends, or null for checks that send none. */
  type: TxType | null;
  covers: readonly CellKey[];
  expect: Expect;
  /** A gas limit above what all of its transactions use together, for the balance floor. */
  gas: bigint;
  /** What it does, for the docs. */
  title: string;
  cleanup?: true;
}

const OK: Expect = { status: "success", from: "kms" };

export const CASE_IDS = [
  "deploy-live-check",
  "eth-to-eoa-legacy",
  "eth-to-eoa-eip2930",
  "eth-to-eoa-eip1559",
  "self-send-legacy",
  "self-send-eip2930",
  "self-send-eip1559",
  "deploy-minimal-legacy",
  "deploy-minimal-eip2930",
  "revert-eip1559",
  "revert-legacy",
  "revert-eip2930",
  "call-legacy",
  "call-eip2930",
  "call-eip1559",
  "replace-legacy",
  "replace-eip2930",
  "replace-eip1559",
  "delegate-and-call",
  "signatures",
  "sponsor-other",
  "sponsored-by-other",
  "revert-eip7702",
  "replace-eip7702",
  "clear-delegation",
] as const;
export type CaseId = (typeof CASE_IDS)[number];

export const CASES: readonly Case[] = [
  {
    id: "deploy-live-check",
    mode: "live",
    type: "eip1559",
    covers: ["deploy/eip1559"],
    expect: OK,
    gas: 750_000n,
    title: "deploy `LiveCheck`",
  },
  {
    id: "eth-to-eoa-legacy",
    mode: "live",
    type: "legacy",
    covers: ["eth-to-eoa/legacy"],
    expect: OK,
    gas: 21_000n,
    title: "1 wei to a fresh address",
  },
  {
    id: "eth-to-eoa-eip2930",
    mode: "live",
    type: "eip2930",
    covers: ["eth-to-eoa/eip2930"],
    expect: OK,
    gas: 25_000n,
    title: "1 wei to a fresh address, with an access list",
  },
  {
    id: "eth-to-eoa-eip1559",
    mode: "live",
    type: "eip1559",
    covers: ["eth-to-eoa/eip1559"],
    expect: OK,
    gas: 21_000n,
    title: "1 wei to a fresh address",
  },
  {
    id: "self-send-legacy",
    mode: "fork",
    type: "legacy",
    covers: ["eth-to-self/legacy"],
    expect: OK,
    gas: 21_000n,
    title: "1 wei to itself",
  },
  {
    id: "self-send-eip2930",
    mode: "fork",
    type: "eip2930",
    covers: ["eth-to-self/eip2930"],
    expect: OK,
    gas: 25_000n,
    title: "1 wei to itself, with an access list",
  },
  {
    id: "self-send-eip1559",
    mode: "live",
    type: "eip1559",
    covers: ["eth-to-self/eip1559"],
    expect: OK,
    gas: 21_000n,
    title: "1 wei to itself",
  },
  {
    id: "deploy-minimal-legacy",
    mode: "live",
    type: "legacy",
    covers: ["deploy/legacy"],
    expect: OK,
    gas: 60_000n,
    title: "deploy a 3-byte contract",
  },
  {
    id: "deploy-minimal-eip2930",
    mode: "live",
    type: "eip2930",
    covers: ["deploy/eip2930"],
    expect: OK,
    gas: 60_000n,
    title: "deploy a 3-byte contract, with an access list",
  },
  {
    id: "revert-eip1559",
    mode: "live",
    type: "eip1559",
    covers: ["revert/eip1559"],
    expect: { status: "reverted", from: "kms" },
    gas: 50_000n,
    title: "an unknown selector to `LiveCheck`, with a gas limit of 50,000",
  },
  {
    id: "revert-legacy",
    mode: "fork",
    type: "legacy",
    covers: ["revert/legacy"],
    expect: { status: "reverted", from: "kms" },
    gas: 50_000n,
    title: "an unknown selector to `LiveCheck`, with a gas limit of 50,000",
  },
  {
    id: "revert-eip2930",
    mode: "fork",
    type: "eip2930",
    covers: ["revert/eip2930"],
    expect: { status: "reverted", from: "kms" },
    gas: 50_000n,
    title: "an unknown selector to `LiveCheck`, with an access list and a gas limit of 50,000",
  },
  {
    id: "call-legacy",
    mode: "live",
    type: "legacy",
    covers: ["call/legacy", "payable-call/legacy"],
    expect: OK,
    gas: 70_000n,
    title: "`add(1)` with 1 wei",
  },
  {
    id: "call-eip2930",
    mode: "live",
    type: "eip2930",
    covers: ["call/eip2930", "payable-call/eip2930"],
    expect: OK,
    gas: 50_000n,
    title: "`add(1)` with 1 wei, with an access list",
  },
  {
    id: "call-eip1559",
    mode: "live",
    type: "eip1559",
    covers: ["call/eip1559", "payable-call/eip1559"],
    expect: OK,
    gas: 50_000n,
    title: "`add(1)` with 1 wei",
  },
  {
    id: "replace-legacy",
    mode: "fork",
    type: "legacy",
    covers: ["replacement/legacy"],
    expect: OK,
    gas: 21_000n,
    title: "replace a pending 1 wei self-send",
  },
  {
    id: "replace-eip2930",
    mode: "fork",
    type: "eip2930",
    covers: ["replacement/eip2930"],
    expect: OK,
    gas: 30_000n,
    title: "replace a pending 1 wei self-send, with an access list",
  },
  {
    id: "replace-eip1559",
    mode: "fork",
    type: "eip1559",
    covers: ["replacement/eip1559"],
    expect: OK,
    gas: 21_000n,
    title: "replace a pending 1 wei self-send",
  },
  {
    id: "delegate-and-call",
    mode: "live",
    type: "eip7702",
    covers: ["set-delegation/eip7702", "call/eip7702", "payable-call/eip7702"],
    expect: OK,
    gas: 120_000n,
    title: "delegate to `LiveCheck` and call `add(1)` on itself with 1 wei",
  },
  {
    id: "signatures",
    mode: "live",
    type: null,
    covers: ["signature/personal_sign", "signature/eth_sign", "signature/eth_signTypedData_v4"],
    expect: OK,
    gas: 0n,
    title:
      "`LiveCheck` recovers a `personal_sign`, an `eth_sign` and an `eth_signTypedData_v4` signature",
  },
  {
    id: "sponsor-other",
    mode: "live",
    type: "eip7702",
    covers: ["sponsor-other/eip7702", "eth-to-eoa/eip7702"],
    expect: OK,
    gas: 100_000n,
    title:
      "1 wei to the fresh address, carrying a throwaway key's authorization to `LiveCheck`; " +
      "a second transaction clears that delegation",
  },
  {
    id: "sponsored-by-other",
    mode: "fork",
    type: "eip7702",
    covers: ["sponsored-by-other/eip7702"],
    expect: { status: "success", from: "other" },
    gas: 0n,
    title: "a funded local account sends our authorization, delegating to the 3-byte contract",
  },
  {
    id: "revert-eip7702",
    mode: "fork",
    type: "eip7702",
    covers: ["revert/eip7702"],
    expect: { status: "reverted", from: "kms" },
    gas: 100_000n,
    title:
      "delegate back to `LiveCheck` and send an unknown selector to itself, with a gas limit of 100,000",
  },
  {
    id: "replace-eip7702",
    mode: "fork",
    type: "eip7702",
    covers: ["replacement/eip7702"],
    expect: OK,
    gas: 80_000n,
    title: "replace a pending self-send that carries an authorization",
  },
  {
    id: "clear-delegation",
    mode: "live",
    type: "eip7702",
    covers: ["clear-delegation/eip7702", "eth-to-self/eip7702"],
    expect: OK,
    gas: 60_000n,
    title: "authorize the zero address and send 1 wei to itself",
    cleanup: true,
  },
];

/** Actions with no row, and why. */
export const EXCLUDED: readonly { action: string; reason: string }[] = [
  {
    action: "CREATE2 factory deploy",
    reason:
      "The plugin sees a call to the factory, which is the contract call row. It never builds the " +
      "CREATE2 address itself.",
  },
];

/** The decision for a cell; throws if it has none. */
export function decisionOf(cell: CellKey): Decision {
  const found = DECISIONS.find((entry) => entry.cell === cell);
  if (found === undefined) {
    throw new Error(`no decision for ${cell}`);
  }
  return found.decision;
}

/** The type of a transaction cell, or null for a signature. */
export function typeOfCell(cell: CellKey): TxType | null {
  const [, type] = cell.split("/");
  return TX_TYPES.find((item) => item === type) ?? null;
}

/**
 * Checks the matrix data: every cell decided exactly once, decisions and cases agreeing, and
 * reasons present. File references are checked by the caller, which can read files.
 *
 * @returns One message per problem; empty when the matrix is complete.
 */
export function matrixProblems(
  decisions: readonly { cell: string; decision: Decision }[] = DECISIONS,
  cases: readonly Case[] = CASES,
  reasons: Readonly<Record<string, string>> = REASONS,
  reasonKinds: Readonly<Record<string, readonly Decision["kind"][]>> = REASON_KINDS,
): string[] {
  const problems: string[] = [];
  const known = new Set<string>(ALL_CELLS);
  for (const cell of ALL_CELLS) {
    const count = decisions.filter((entry) => entry.cell === cell).length;
    if (count === 0) {
      problems.push(`${cell} has no decision`);
    } else if (count > 1) {
      problems.push(`${cell} has ${count} decisions`);
    }
  }
  for (const { cell } of decisions) {
    if (!known.has(cell)) {
      problems.push(`${cell} is not a cell of the matrix`);
    }
  }
  const byId = new Map<string, Case>();
  for (const item of cases) {
    if (byId.has(item.id)) {
      problems.push(`case ${item.id} is listed twice`);
    }
    byId.set(item.id, item);
  }
  for (const id of CASE_IDS) {
    if (!byId.has(id)) {
      problems.push(`case ${id} has no entry in the case table`);
    }
  }
  for (const { cell, decision } of decisions) {
    if (decision.kind === "n/a" || decision.kind === "refused" || decision.kind === "fork") {
      const text = Object.hasOwn(reasons, decision.reason) ? reasons[decision.reason] : undefined;
      if (text === undefined || text.trim() === "") {
        problems.push(`${cell} is ${decision.kind} without a reason`);
      } else if (!(reasonKinds[decision.reason] ?? []).includes(decision.kind)) {
        problems.push(
          `${cell} is ${decision.kind}, which reason (${decision.reason}) does not allow`,
        );
      }
    }
    if (decision.kind === "live" || decision.kind === "fork") {
      const named = byId.get(decision.case);
      if (named === undefined) {
        problems.push(`${cell} names case ${decision.case}, which does not exist`);
      } else {
        if (!named.covers.some((item) => item === cell)) {
          problems.push(`${cell} names case ${named.id}, which does not cover it`);
        }
        if (named.mode !== decision.kind) {
          problems.push(`${cell} is ${decision.kind}, but case ${named.id} runs in ${named.mode}`);
        }
      }
    }
  }
  for (const item of cases) {
    if (item.covers.length === 0) {
      problems.push(`case ${item.id} covers no cell`);
    }
    for (const cell of item.covers) {
      const decision = decisions.find((entry) => entry.cell === cell)?.decision;
      if (decision === undefined || !("case" in decision) || decision.case !== item.id) {
        problems.push(`case ${item.id} covers ${cell}, whose decision does not name it`);
      }
      if (typeOfCell(cell) !== item.type) {
        problems.push(`case ${item.id} sends ${item.type ?? "no transaction"}, not ${cell}`);
      }
    }
  }
  return problems;
}

/** Whether a mode runs a case: Sepolia runs the live cases, the fork every case. */
const runsIn = (mode: "fork" | "sepolia", item: Case): boolean =>
  mode === "fork" || item.mode === "live";

/** The cases a mode runs, in run order. */
export function casesFor(mode: "fork" | "sepolia"): Case[] {
  return CASES.filter((item) => runsIn(mode, item));
}

/**
 * The least an account must hold before a run: the gas budget of every case the mode runs, at
 * `gasPrice` per unit, plus the wei the cases send away (1 wei each to a fresh address and to
 * `LiveCheck`, rounded up to 10).
 *
 * @param mode - The mode the run uses.
 * @param gasPrice - The highest price per gas the run expects to pay, in wei.
 * @returns The floor, in wei.
 */
export function balanceFloor(
  mode: "fork" | "sepolia",
  gasPrice: bigint,
  cases: readonly Case[] = CASES,
): bigint {
  const gas = cases.filter((item) => runsIn(mode, item)).reduce((sum, item) => sum + item.gas, 0n);
  return gas * gasPrice + 10n;
}

/** One mined transaction or on-chain check of a run, as the suite records it. */
export interface RunRecord {
  case: string;
  /** What the step did. */
  label: string;
  /** The transaction's type, or null for a check that sent none. */
  type: TxType | null;
  /** The transaction hash, or null for a check. */
  hash: string | null;
  block: string;
  status: "success" | "reverted";
  /** `kms` when sent by the provider's account. */
  from: "kms" | "other";
}

/**
 * The per-run check: every cell the mode runs must have a record from its case with the case's
 * type, status and sender.
 *
 * @returns The cells without one, with what was missing.
 */
export function missingCells(
  mode: "fork" | "sepolia",
  records: readonly RunRecord[],
  decisions: readonly { cell: CellKey; decision: Decision }[] = DECISIONS,
  cases: readonly Case[] = CASES,
): string[] {
  const missing: string[] = [];
  for (const { cell, decision } of decisions) {
    if (decision.kind !== "live" && !(decision.kind === "fork" && mode === "fork")) {
      continue;
    }
    const item = cases.find((entry) => entry.id === decision.case);
    const check = cell.startsWith("signature/") ? `${cell.slice("signature/".length)} ` : "";
    const match = records.find(
      (record) =>
        record.case === decision.case &&
        record.label.startsWith(check) &&
        record.type === item?.type &&
        record.status === item.expect.status &&
        record.from === item.expect.from &&
        (record.type === null) === (record.hash === null),
    );
    if (match === undefined) {
      missing.push(`${cell}: no ${item?.expect.status ?? "matching"} record from ${decision.case}`);
    }
  }
  return missing;
}
