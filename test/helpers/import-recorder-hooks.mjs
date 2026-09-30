import { appendFileSync } from "node:fs";

let log;

export function initialize(data) {
  log = data.log;
}

export async function resolve(specifier, context, nextResolve) {
  appendFileSync(log, `${specifier}\n`);
  return nextResolve(specifier, context);
}
