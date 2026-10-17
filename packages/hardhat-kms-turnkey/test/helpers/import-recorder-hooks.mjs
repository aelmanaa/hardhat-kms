import { appendFileSync } from "node:fs";

let log;

export function initialize(data) {
  log = data.log;
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  appendFileSync(log, `${result.url}\n`);
  return result;
}
