import type { TransactionDelegates } from "../../src/internal/rpc/transactions.ts";

/** The delegate check of a key without `allowedDelegates`: every delegate passes, no node. */
export const NO_ALLOWLIST: TransactionDelegates = {
  key: { name: "test" },
  node: undefined,
  note: () => undefined,
};
