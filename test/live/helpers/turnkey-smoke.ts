// The Turnkey smoke test's line in docs/live-proof.md. A passing run of
// `pnpm run test:live:turnkey` (packages/hardhat-kms-turnkey/test/live/turnkey.live.test.ts) writes
// test/live/turnkey-smoke.json; `pnpm run docs:live-proof` reads its date, commit and sign request
// count. Turnkey is not in the transaction matrix or in test/live/proof.json, whose shape and
// checks stay those of the three clouds.

/** Where a passing smoke run writes its record, from the repository root. */
export const TURNKEY_SMOKE_FILE = "test/live/turnkey-smoke.json";

/** The words that open the line, which the page must always carry. */
export const TURNKEY_SMOKE_LINE = "Turnkey: smoke only.";

/** The most sign requests a smoke run may send (SIGNATURE_CAP in the Turnkey package's harness). */
const MAX_SIGNATURES = 11;

/** What the page shows of the last passing smoke run. */
export interface TurnkeySmoke {
  /** The run's date, `YYYY-MM-DD`, in UTC. */
  date: string;
  /** The short hash of the commit the run tested. */
  commit: string;
  /** The sign requests it sent. */
  signatures: number;
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * Reads test/live/turnkey-smoke.json. Only a passing run's record is accepted.
 *
 * @param source - The file's text.
 * @returns The date, commit and sign request count.
 * @throws If the record is not a passing run's, or a field has another form.
 */
export function parseTurnkeySmoke(source: string): TurnkeySmoke {
  const value: unknown = JSON.parse(source);
  const date = field(value, "date");
  const commit = field(value, "commit");
  const signatures = field(value, "signatures");
  if (field(value, "result") !== "passed") {
    throw new Error(`${TURNKEY_SMOKE_FILE} is not the record of a passing run`);
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${TURNKEY_SMOKE_FILE}: date is not YYYY-MM-DD`);
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new Error(`${TURNKEY_SMOKE_FILE}: commit is not a commit hash`);
  }
  if (
    typeof signatures !== "number" ||
    !Number.isInteger(signatures) ||
    signatures < 1 ||
    signatures > MAX_SIGNATURES
  ) {
    throw new Error(`${TURNKEY_SMOKE_FILE}: signatures is not a count from 1 to ${MAX_SIGNATURES}`);
  }
  return { date, commit, signatures };
}

/**
 * The Turnkey section of docs/live-proof.md.
 *
 * @param smoke - The last passing smoke run, or `undefined` before the first.
 * @returns The section's lines, starting with its heading.
 */
export function turnkeySection(smoke: TurnkeySmoke | undefined): string[] {
  return [
    "## Turnkey",
    "",
    `${TURNKEY_SMOKE_LINE} \`@hardhat-kms/turnkey\` is not in the transaction matrix or in ` +
      "`test/live/proof.json`: Turnkey's Free plan includes 25 signatures a month, so a smoke test " +
      `of at most ${MAX_SIGNATURES} sign requests covers it ` +
      "([#513](https://github.com/aelmanaa/hardhat-kms/issues/513)). It signs a message, typed " +
      "data, a digest, an EIP-7702 authorization and transactions of types 0, 2 and 4 for a local " +
      "chain without sending them, and checks that Turnkey refuses an account without a policy, " +
      "holds one under a 2-approver policy and denies the API user a new API key. " +
      `${smoke === undefined ? "No run has passed yet." : `Last passing run: ${smoke.date}, commit \`${smoke.commit}\`, ${smoke.signatures} sign requests.`} ` +
      `\`pnpm run docs:live-proof\` writes this line from \`${TURNKEY_SMOKE_FILE}\`, which a passing run writes.`,
  ];
}
