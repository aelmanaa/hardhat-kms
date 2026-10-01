// The completeness check of the transaction matrix (`matrix.ts`), the per-run check, the balance
// floor and the live proof's renderer. Runs in `pnpm test`, with no keys and no network.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseProof, type Proof, proofProblems, renderProof, table } from "./helpers/proof.ts";
import {
  ALL_CELLS,
  balanceFloor,
  type Case,
  CASES,
  casesFor,
  DECISIONS,
  matrixProblems,
  missingCells,
  REASONS,
  type RunRecord,
  TX_TYPES,
} from "./matrix.ts";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROOF_FILE = path.join(repository, "test/live/proof.json");
const PROOF_PAGE = path.join(repository, "docs/live-proof.md");

/** A record for each transaction a mode's cases send, as a passing run would make. */
function passingRecords(mode: "fork" | "sepolia", start = 1): RunRecord[] {
  return casesFor(mode).map((item, index) => ({
    case: item.id,
    label: item.title,
    type: item.type,
    hash: item.type === null ? null : `0x${(start + index).toString(16).padStart(64, "0")}`,
    block: String(100 + index),
    status: item.expect.status,
    from: item.expect.from,
  }));
}

function syntheticProof(): Proof {
  return {
    chainId: 11_155_111,
    commit: "abc1234",
    subject: "test: a synthetic run",
    firstBlockTime: "2026-10-02T10:00:00.000Z",
    lastBlockTime: "2026-10-02T10:05:00.000Z",
    providers: (["aws", "gcp", "azure"] as const).map((provider, index) => ({
      provider,
      account: `0x${String(index + 1).repeat(40)}`,
      liveCheck: `0x${String(index + 4).repeat(40)}`,
      spent: "0.0012",
      records: passingRecords("sepolia", 1000 * (index + 1)).map((record) =>
        record.hash === null
          ? record
          : { ...record, gasUsed: "21000", effectiveGasPrice: "1500000000" },
      ),
    })),
  };
}

/** A Sepolia run's records with the type 2 revert's record changed. */
const patchRevert = (patch: Partial<RunRecord>): RunRecord[] =>
  passingRecords("sepolia").map((record) =>
    record.case === "revert-eip1559" ? { ...record, ...patch } : record,
  );

/** The gas budget of every case a mode runs. */
const gasOf = (mode: "fork" | "sepolia"): bigint =>
  casesFor(mode).reduce((sum, item) => sum + item.gas, 0n);

const without = <T>(items: readonly T[], drop: (item: T) => boolean): T[] =>
  items.filter((item) => !drop(item));

describe("the transaction matrix", () => {
  it("decides every cell exactly once, consistently with the cases", () => {
    assert.deepEqual(matrixProblems(), []);
  });

  it("covers every action and type, plus the signatures", () => {
    assert.equal(ALL_CELLS.length, 11 * TX_TYPES.length + 3);
    assert.equal(DECISIONS.length, ALL_CELLS.length);
  });

  it("names unit tests that exist", () => {
    const refs = DECISIONS.flatMap(({ cell, decision }) => {
      const unit =
        decision.kind === "unit" || decision.kind === "refused"
          ? decision.unit
          : decision.kind === "fork"
            ? decision.also
            : undefined;
      return unit === undefined ? [] : [{ cell, unit }];
    });
    assert.ok(refs.length > 0);
    for (const { cell, unit } of refs) {
      const file = path.join(repository, unit.file);
      assert.ok(existsSync(file), `${cell}: ${unit.file} does not exist`);
      assert.ok(
        readFileSync(file, "utf8").includes(unit.test),
        `${cell}: ${unit.file} has no test "${unit.test}"`,
      );
    }
  });

  it("gives every reason some text", () => {
    for (const [id, text] of Object.entries(REASONS)) {
      assert.ok(text.trim().length > 20, `reason ${id} is empty`);
    }
  });

  describe("fails on", () => {
    it("a missing cell", () => {
      const decisions = without(DECISIONS, (entry) => entry.cell === "revert/eip1559");
      assert.ok(matrixProblems(decisions).includes("revert/eip1559 has no decision"));
    });

    it("a cell decided twice", () => {
      const twice = DECISIONS.find((entry) => entry.cell === "deploy/eip4844");
      assert.ok(twice !== undefined);
      assert.ok(matrixProblems([...DECISIONS, twice]).includes("deploy/eip4844 has 2 decisions"));
    });

    it("a cell that is not in the matrix", () => {
      const extra = { cell: "deploy/eip9999", decision: { kind: "n/a", reason: "b" } } as const;
      assert.ok(
        matrixProblems([...DECISIONS, extra]).includes(
          "deploy/eip9999 is not a cell of the matrix",
        ),
      );
    });

    it("an n/a, refused or fork decision without a reason", () => {
      const problems = matrixProblems(DECISIONS, CASES, { ...REASONS, f: " " });
      assert.ok(problems.includes("set-delegation/legacy is n/a without a reason"));
      const withoutF = Object.fromEntries(Object.entries(REASONS).filter(([id]) => id !== "f"));
      assert.ok(
        matrixProblems(DECISIONS, CASES, withoutF).includes(
          "sponsor-other/legacy is n/a without a reason",
        ),
      );
    });

    it("a decision that names a case which does not cover the cell", () => {
      const decisions = DECISIONS.map((entry) =>
        entry.cell === "call/eip1559"
          ? { cell: entry.cell, decision: { kind: "live", case: "call-legacy" } as const }
          : entry,
      );
      const problems = matrixProblems(decisions);
      assert.ok(problems.includes("call/eip1559 names case call-legacy, which does not cover it"));
      assert.ok(
        problems.includes("case call-eip1559 covers call/eip1559, whose decision does not name it"),
      );
    });

    it("a live decision for a fork case", () => {
      const decisions = DECISIONS.map((entry) =>
        entry.cell === "revert/legacy"
          ? { cell: entry.cell, decision: { kind: "live", case: "revert-legacy" } as const }
          : entry,
      );
      assert.ok(
        matrixProblems(decisions).includes(
          "revert/legacy is live, but case revert-legacy runs in fork",
        ),
      );
    });

    it("a case of another type than its cells", () => {
      const cases = CASES.map((item): Case =>
        item.id === "call-legacy" ? { ...item, type: "eip1559" } : item,
      );
      assert.ok(
        matrixProblems(DECISIONS, cases).includes(
          "case call-legacy sends eip1559, not call/legacy",
        ),
      );
    });

    it("a case missing from the table", () => {
      const cases = without(CASES, (item) => item.id === "sponsor-other");
      assert.ok(
        matrixProblems(DECISIONS, cases).includes(
          "case sponsor-other has no entry in the case table",
        ),
      );
    });
  });
});

describe("the per-run check", () => {
  it("passes a run with a record for every case", () => {
    assert.deepEqual(missingCells("fork", passingRecords("fork")), []);
    assert.deepEqual(missingCells("sepolia", passingRecords("sepolia")), []);
  });

  it("does not ask a Sepolia run for the fork cases", () => {
    assert.ok(casesFor("sepolia").every((item) => item.mode === "live"));
    assert.ok(casesFor("fork").some((item) => item.mode === "fork"));
  });

  it("names a cell whose case left no record", () => {
    const records = without(passingRecords("fork"), (record) => record.case === "replace-eip7702");
    assert.deepEqual(missingCells("fork", records), [
      "replacement/eip7702: no success record from replace-eip7702",
    ]);
  });

  it("refuses a record with the wrong status, sender or type", () => {
    for (const patch of [
      { status: "success" as const },
      { from: "other" as const },
      { type: "legacy" as const },
    ]) {
      assert.deepEqual(missingCells("sepolia", patchRevert(patch)), [
        "revert/eip1559: no reverted record from revert-eip1559",
      ]);
    }
  });
});

describe("the balance floor", () => {
  it("is the gas of every case the mode runs at the given price", () => {
    assert.equal(balanceFloor("sepolia", 3n), gasOf("sepolia") * 3n + 10n);
    assert.ok(balanceFloor("fork", 3n) > balanceFloor("sepolia", 3n));
    // At the 20 gwei cap a Sepolia run needs more than the old fixed floor of 0.01 ETH.
    assert.ok(balanceFloor("sepolia", 20_000_000_000n) > 10_000_000_000_000_000n);
  });
});

describe("the live proof", () => {
  it("aligns tables as the formatter does", () => {
    assert.equal(
      table(["A", "Long"], [["xyz", "1"]]),
      "| A   | Long |\n| --- | ---- |\n| xyz | 1    |",
    );
  });

  it("renders a complete run with a transaction for every live cell", () => {
    const proof = syntheticProof();
    assert.deepEqual(proofProblems(proof), []);
    const page = renderProof(proof);
    for (const provider of proof.providers) {
      for (const record of provider.records) {
        if (record.hash !== null && casesFor("sepolia").some((item) => item.id === record.case)) {
          assert.ok(page.includes(`/tx/${record.hash})`), `${record.case} has no link`);
        }
      }
    }
    assert.ok(page.includes("## Google Cloud KMS"));
    assert.ok(page.endsWith("\n"));
    assert.deepEqual(parseProof(JSON.stringify(proof)), proof);
  });

  it("refuses a run with a live cell without a hash", () => {
    const proof = syntheticProof();
    const [first] = proof.providers;
    assert.ok(first !== undefined);
    first.records = without(first.records, (record) => record.case === "deploy-minimal-eip2930");
    assert.deepEqual(proofProblems(proof), [
      "aws: deploy/eip2930: no success record from deploy-minimal-eip2930",
    ]);
    first.records = first.records.map((record) =>
      record.case === "call-legacy" ? { ...record, hash: "0x12" } : record,
    );
    assert.ok(proofProblems(proof).includes("aws: call-legacy has no valid hash"));
  });

  const committed = existsSync(PROOF_FILE);
  const pending = committed
    ? false
    : "no Sepolia run with the matrix yet: run HARDHAT_KMS_LIVE_NETWORK=sepolia pnpm run test:live, then pnpm run docs:live-proof";

  it("test/live/proof.json has a transaction for every live cell", { skip: pending }, () => {
    assert.deepEqual(proofProblems(parseProof(readFileSync(PROOF_FILE, "utf8"))), []);
  });

  it("docs/live-proof.md is rendered from test/live/proof.json", { skip: pending }, () => {
    assert.equal(
      readFileSync(PROOF_PAGE, "utf8"),
      renderProof(parseProof(readFileSync(PROOF_FILE, "utf8"))),
      "docs/live-proof.md is out of date: run pnpm run docs:live-proof",
    );
  });
});
