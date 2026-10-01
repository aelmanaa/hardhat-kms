// The live proof: what a Sepolia run of the live suite writes to `test/live/proof.json`, and the
// renderer that turns it into `docs/live-proof.md`. Fork runs write nothing, since their hashes
// exist on no public chain.
import {
  ACTIONS,
  ALL_CELLS,
  CASES,
  type CellKey,
  type Decision,
  decisionOf,
  EXCLUDED,
  missingCells,
  REASONS,
  type RunRecord,
  SIGNATURES,
  TX_TYPES,
  TYPE_TITLES,
} from "../matrix.ts";

/** One mined transaction or check, with what it cost. */
export interface ProofRecord extends RunRecord {
  /** Gas used, in decimal; absent for a check. */
  gasUsed?: string;
  /** Effective gas price in wei, in decimal; absent for a check. */
  effectiveGasPrice?: string;
}

/** One provider's part of a run. */
export interface ProviderProof {
  provider: "aws" | "gcp" | "azure";
  account: string;
  liveCheck: string;
  /** What the account spent, in ETH. */
  spent: string;
  records: ProofRecord[];
}

/** A Sepolia run, as `test/live/proof.json` holds it. */
export interface Proof {
  chainId: number;
  /** The short hash and subject of the commit the run tested. */
  commit: string;
  subject: string;
  /** ISO timestamps of the first and last block with one of the run's transactions. */
  firstBlockTime: string;
  lastBlockTime: string;
  providers: ProviderProof[];
}

const PROVIDER_TITLES: Record<ProviderProof["provider"], string> = {
  aws: "AWS KMS",
  gcp: "Google Cloud KMS",
  azure: "Azure Key Vault",
};
const EXPLORER = "https://sepolia.etherscan.io";
const HASH = /^0x[0-9a-f]{64}$/;

/**
 * The problems that make a proof unfit to render: a live cell without a transaction (or check) for
 * a provider listed as run, or a hash that is not one.
 *
 * @returns One message per problem; empty when every live cell has its proof.
 */
export function proofProblems(proof: Proof): string[] {
  const problems: string[] = [];
  if (proof.providers.length === 0) {
    problems.push("the proof lists no provider");
  }
  for (const provider of proof.providers) {
    for (const missing of missingCells("sepolia", provider.records)) {
      problems.push(`${provider.provider}: ${missing}`);
    }
    for (const record of provider.records) {
      if (record.hash !== null && !HASH.test(record.hash)) {
        problems.push(`${provider.provider}: ${record.case} has no valid hash`);
      }
    }
  }
  return problems;
}

/** A Markdown table with its columns padded, as the formatter writes them. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${widths.map((width, column) => (cells[column] ?? "").padEnd(width)).join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

function reasonMark(decision: Decision): string {
  return "reason" in decision ? ` (${decision.reason})` : "";
}

/** A cell of the summary matrix. */
function summaryCell(cell: CellKey): string {
  const decision = decisionOf(cell);
  if (decision.kind === "live") {
    return "Live";
  }
  if (decision.kind === "fork") {
    return `Fork${reasonMark(decision)}${decision.also === undefined ? "" : ", unit"}`;
  }
  if (decision.kind === "unit") {
    return "Unit";
  }
  return `${decision.kind === "refused" ? "Refused" : "N/A"}${reasonMark(decision)}`;
}

const txLink = (hash: string): string => `[\`${hash.slice(0, 10)}\`](${EXPLORER}/tx/${hash})`;
const addressLink = (address: string): string => `[\`${address}\`](${EXPLORER}/address/${address})`;

/** A cell of one provider's matrix: the transaction that proves a live cell. */
function providerCell(cell: CellKey, records: readonly ProofRecord[]): string {
  const decision = decisionOf(cell);
  if (decision.kind !== "live") {
    return decision.kind === "fork" ? "fork only" : summaryCell(cell);
  }
  const record = records.find((item) => item.case === decision.case);
  if (record === undefined) {
    return "missing";
  }
  return record.hash === null ? `\`eth_call\` at block ${record.block}` : txLink(record.hash);
}

function typeOf(record: ProofRecord): string {
  const index = TX_TYPES.findIndex((type) => type === record.type);
  return index === -1 ? "none" : `${index}`;
}

function gwei(wei: bigint): string {
  const whole = wei / 1_000_000_000n;
  const fraction = ((wei % 1_000_000_000n) * 100n) / 1_000_000_000n;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

/** The lowest and highest effective gas price paid, per group of types. */
function gasPrices(proof: Proof): string {
  const groups: [string, (record: ProofRecord) => boolean][] = [
    ["types 0 and 1", (record) => record.type === "legacy" || record.type === "eip2930"],
    ["types 2 and 4", (record) => record.type === "eip1559" || record.type === "eip7702"],
  ];
  const parts = groups.flatMap(([title, matches]) => {
    const prices = proof.providers
      .flatMap((provider) => provider.records)
      .filter((record) => record.from === "kms" && matches(record))
      .flatMap((record) =>
        record.effectiveGasPrice === undefined ? [] : [BigInt(record.effectiveGasPrice)],
      );
    if (prices.length === 0) {
      return [];
    }
    const low = prices.reduce((a, b) => (a < b ? a : b));
    const high = prices.reduce((a, b) => (a > b ? a : b));
    return [`${gwei(low)} to ${gwei(high)} gwei for ${title}`];
  });
  return parts.join("; ");
}

function totalEth(proof: Proof): string {
  // Spent amounts are decimal ETH strings with up to 18 decimals; add them in wei.
  const wei = proof.providers.reduce((sum, provider) => {
    const [whole = "0", fraction = ""] = provider.spent.split(".");
    return sum + BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0").slice(0, 18));
  }, 0n);
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? `${wei / 10n ** 18n}` : `${wei / 10n ** 18n}.${fraction}`;
}

const time = (iso: string): string => iso.slice(11, 19);

/** One line per unit test the matrix names, with the cells it covers. */
function unitTests(): string[] {
  const cells = new Map<string, string[]>();
  for (const cell of ALL_CELLS) {
    const decision = decisionOf(cell);
    const unit =
      decision.kind === "unit" || decision.kind === "refused"
        ? decision.unit
        : decision.kind === "fork"
          ? decision.also
          : undefined;
    if (unit !== undefined) {
      const key = `\`${unit.file}\`, "${unit.test}"`;
      cells.set(key, [...(cells.get(key) ?? []), `\`${cell}\``]);
    }
  }
  return [...cells].map(([test, covered]) => `- ${test}: ${covered.join(", ")}`);
}

/**
 * Renders `docs/live-proof.md` from a run.
 *
 * @param proof - The run.
 * @returns The page, ending with a newline.
 */
export function renderProof(proof: Proof): string {
  const blocks = proof.providers
    .flatMap((provider) => provider.records)
    .filter((record) => record.hash !== null)
    .map((record) => BigInt(record.block));
  const firstBlock = blocks.reduce((a, b) => (a < b ? a : b), blocks[0] ?? 0n);
  const lastBlock = blocks.reduce((a, b) => (a > b ? a : b), 0n);
  const providerNames = proof.providers.map((provider) => PROVIDER_TITLES[provider.provider]);
  const providerList =
    providerNames.length > 1
      ? `${providerNames.slice(0, -1).join(", ")} and ${providerNames.at(-1) ?? ""}`
      : (providerNames[0] ?? "");
  const typeHeader = ["Action", ...TX_TYPES.map((type) => TYPE_TITLES[type])];
  const out: string[] = [];
  const push = (...lines: string[]): void => {
    out.push(...lines);
  };

  push(
    "# Live proof",
    "",
    "Audience: contributors and reviewers who want on-chain evidence that the plugin signs with real KMS keys.",
    "",
    "Status: M9. The latest run of the live suite on Sepolia ([#44](https://github.com/aelmanaa/hardhat-kms/issues/44)), " +
      "with the transaction matrix of [#144](https://github.com/aelmanaa/hardhat-kms/issues/144). " +
      "`pnpm run docs:live-proof` renders this page from `test/live/proof.json`, which the run wrote; do not edit it by hand.",
    "",
    "## Run",
    "",
    table(
      ["Field", "Value"],
      [
        [
          "Date",
          `${proof.firstBlockTime.slice(0, 10)}, blocks mined from ${time(proof.firstBlockTime)} to ${time(proof.lastBlockTime)} UTC`,
        ],
        ["Commit", `\`${proof.commit}\` (\`${proof.subject}\`)`],
        ["Chain id", `${proof.chainId} (Sepolia)`],
        ["Blocks", `${firstBlock} to ${lastBlock}`],
        ["Command", "`HARDHAT_KMS_LIVE_NETWORK=sepolia pnpm run test:live`"],
        ["Providers", `${providerList}, in parallel`],
        ["Gas prices", gasPrices(proof) || "none recorded"],
      ],
    ),
    "",
    "Every transaction below was signed by the provider's KMS key through the plugin, except where " +
      "a case says another key signed. The suite waited for each receipt and checked its status, " +
      "its sender and its type against the case table in `test/live/matrix.ts`. A run that misses " +
      "a receipt for any live cell fails, and writes no proof.",
    "",
    "The `personal_sign` and `eth_signTypedData_v4` signatures are checked with `eth_call`: " +
      "`LiveCheck` rebuilds the EIP-191 and EIP-712 digests on chain and recovers the KMS account " +
      "with `ecrecover`. These checks send no transaction, so they have no hash.",
    "",
    "Each account ends the run with no code. Its EIP-7702 delegation is cleared by the last case, " +
      "and the throwaway key whose authorization the account sent is cleared by a second " +
      "transaction in the same case. Slot 0 of each account's storage keeps the count that the " +
      "delegated `add` wrote; clearing a delegation does not reset storage.",
    "",
    "## Coverage matrix",
    "",
    "One decision per action and type. Live cells run on Sepolia and on the fork, fork cells only " +
      "on the fork, unit cells only in the unit or integration tests, and refused cells are " +
      "refused by the plugin before any request. Each live and fork cell runs once per provider.",
    "",
    table(
      typeHeader,
      ACTIONS.map((action) => [
        action.title,
        ...TX_TYPES.map((type) => summaryCell(`${action.id}/${type}`)),
      ]),
    ),
    "",
    table(
      ["Signature", "Decision"],
      SIGNATURES.map((signature) => [signature.title, summaryCell(`signature/${signature.id}`)]),
    ),
    "",
    "Reasons:",
    "",
    ...Object.entries(REASONS).map(([id, reason]) => `- (${id}) ${reason}`),
    "",
    "Unit tests:",
    "",
    ...unitTests(),
    "",
    "Not in the matrix:",
    "",
    ...EXCLUDED.map((item) => `- ${item.action}: ${item.reason}`),
    "",
    "Cases:",
    "",
    table(
      ["Case", "Mode", "What it sends"],
      CASES.map((item) => [`\`${item.id}\``, item.mode, item.title]),
    ),
  );

  for (const provider of proof.providers) {
    push(
      "",
      `## ${PROVIDER_TITLES[provider.provider]}`,
      "",
      `- Account: ${addressLink(provider.account)}`,
      `- \`LiveCheck\`: ${addressLink(provider.liveCheck)}`,
      `- Spent: ${provider.spent} ETH`,
      "",
      table(
        typeHeader,
        ACTIONS.map((action) => [
          action.title,
          ...TX_TYPES.map((type) => providerCell(`${action.id}/${type}`, provider.records)),
        ]),
      ),
      "",
      table(
        ["Signature", "Proof"],
        SIGNATURES.map((signature) => [
          signature.title,
          providerCell(`signature/${signature.id}`, provider.records),
        ]),
      ),
      "",
      table(
        ["Case", "Step", "Type", "Status", "Block", "Transaction"],
        provider.records
          .filter((record) => record.hash !== null)
          .map((record) => [
            `\`${record.case}\``,
            record.label,
            typeOf(record),
            record.status === "success" ? "1" : "0",
            record.block,
            record.hash === null ? "" : txLink(record.hash),
          ]),
      ),
    );
  }
  push("", `The providers together spent ${totalEth(proof)} ETH.`, "");
  return out.join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new Error(`${where} is not a string`);
  }
  return value;
}

function optionalText(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : text(value, where);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  const found = options.find((option) => option === value);
  if (found === undefined) {
    throw new Error(`${where} is not one of ${options.join(", ")}`);
  }
  return found;
}

function parseRecord(value: unknown, where: string): ProofRecord {
  if (!isRecord(value)) {
    throw new Error(`${where} is not an object`);
  }
  const record: ProofRecord = {
    case: text(value.case, `${where}.case`),
    label: text(value.label, `${where}.label`),
    type: value.type === null ? null : oneOf(value.type, TX_TYPES, `${where}.type`),
    hash: value.hash === null ? null : text(value.hash, `${where}.hash`),
    block: text(value.block, `${where}.block`),
    status: oneOf(value.status, ["success", "reverted"], `${where}.status`),
    from: oneOf(value.from, ["kms", "other"], `${where}.from`),
  };
  const gasUsed = optionalText(value.gasUsed, `${where}.gasUsed`);
  const effectiveGasPrice = optionalText(value.effectiveGasPrice, `${where}.effectiveGasPrice`);
  return {
    ...record,
    ...(gasUsed === undefined ? {} : { gasUsed }),
    ...(effectiveGasPrice === undefined ? {} : { effectiveGasPrice }),
  };
}

/**
 * Reads `test/live/proof.json`, checking every field's shape.
 *
 * @param source - The file's text.
 * @returns The proof.
 * @throws If the text is not a proof.
 */
export function parseProof(source: string): Proof {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    throw new Error("the proof is not an object with a providers list");
  }
  if (typeof value.chainId !== "number") {
    throw new Error("chainId is not a number");
  }
  return {
    chainId: value.chainId,
    commit: text(value.commit, "commit"),
    subject: text(value.subject, "subject"),
    firstBlockTime: text(value.firstBlockTime, "firstBlockTime"),
    lastBlockTime: text(value.lastBlockTime, "lastBlockTime"),
    providers: value.providers.map((item: unknown, index): ProviderProof => {
      const where = `providers[${index}]`;
      if (!isRecord(item) || !Array.isArray(item.records)) {
        throw new Error(`${where} is not an object with a records list`);
      }
      return {
        provider: oneOf(item.provider, ["aws", "gcp", "azure"], `${where}.provider`),
        account: text(item.account, `${where}.account`),
        liveCheck: text(item.liveCheck, `${where}.liveCheck`),
        spent: text(item.spent, `${where}.spent`),
        records: item.records.map((record: unknown, at) =>
          parseRecord(record, `${where}.records[${at}]`),
        ),
      };
    }),
  };
}
