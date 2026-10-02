// Compile-fail fixture for TemplateParams, run by test/unit/error-types.test.ts. Every line that
// ends with `// compile error` must fail to typecheck; every other line must pass.
import { catalogError, catalogMessage, internalError } from "../../src/internal/errors.ts";

const two = {
  id: "core.test.two",
  kind: "error",
  group: "Tests",
  template: "from {address} to {other}, a list of {name, type}",
  cause: "c",
  fix: "f",
} as const;
const none = { ...two, id: "core.test.none", template: "no values {name, type}" } as const;
const other = { ...two, id: "core.test.other", template: "chain {chainId}" } as const;
const reason = { ...two, id: "core.test.reason", kind: "reason" } as const;
const wide: {
  id: string;
  kind: "error";
  group: string;
  template: string;
  cause: string;
  fix: string;
} = two;
const either = Math.random() > 0.5 ? two : other;

export const errors: unknown[] = [
  catalogError(two, { address: "a", other: 1n }),
  catalogError(two, { address: "a" }), // compile error
  catalogError(two, { address: "a", other: 1, extra: 2 }), // compile error
  catalogError(none, {}),
  catalogError(none, { extra: 1 }), // compile error
  catalogError(reason, { address: "a", other: 1 }), // compile error
  catalogMessage(reason, { address: "a", other: 1 }),
  internalError(two, { address: "a", other: 1 }), // compile error
  catalogError(either, { address: "a", other: 1, chainId: 1 }),
  catalogError(either, { address: "a", other: 1 }), // compile error
  catalogError(either, { chainId: 1 }), // compile error
  catalogError(wide, {}), // compile error
  catalogError(two, { address: true, other: 1 }), // compile error
];
