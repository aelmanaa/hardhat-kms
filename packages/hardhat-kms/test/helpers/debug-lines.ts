/**
 * The time since the previous line that the debug logger adds at the end of each line, such as
 * ` +12ms`. It is negative when the clock steps back, as in ` +-13ms`.
 */
const TIMING_SUFFIX = / \+-?\d+ms$/;

/**
 * Reads debug lines from what a test captured on standard error.
 *
 * @param written - The captured output.
 * @param namespace - The full namespace, such as `hardhat:kms:signer`.
 * @returns The message of each line under `namespace`, without the namespace and without the
 * timing suffix.
 */
export function debugLines(written: string, namespace: string): string[] {
  const prefix = `${namespace} `;
  return written.split("\n").flatMap((line) => {
    const start = line.indexOf(prefix);
    return start === -1 ? [] : [line.slice(start + prefix.length).replace(TIMING_SUFFIX, "")];
  });
}
