// Reads the codes of an Azure error answer without its messages, which name the vault, the key,
// the workspace or the caller. Shared by the Key Vault adapter and the Log Analytics reader.

/** A code from an answer, shown only when it has this shape. */
export const SAFE_CODE: RegExp = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Reads a property of a value that may not be an object. */
export function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * The codes of an error and its inner errors, outermost first, up to the first one that is not
 * safe, and at most five.
 *
 * @param error - The error object, such as the `error` of a JSON error answer.
 * @param innerKey - The property that holds the inner error: `innererror` in Azure's JSON answers,
 * `innerError` once @azure/keyvault-keys has deserialised one.
 * @returns The safe codes.
 */
export function errorCodes(error: unknown, innerKey: "innererror" | "innerError"): string[] {
  const codes: string[] = [];
  for (let inner = error; inner !== undefined && codes.length < 5;) {
    const code = field(inner, "code");
    if (typeof code !== "string" || !SAFE_CODE.test(code)) {
      break;
    }
    codes.push(code);
    inner = field(inner, innerKey);
  }
  return codes;
}
