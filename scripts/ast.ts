// Reads values the scripts and their tests parse but do not type: a JSON report, or the ESTree
// program `oxc-parser` returns. Every node is `unknown`, so each read checks what it gets.

/**
 * Reads a field of a parsed value.
 *
 * @param value - A node, a JSON object, or anything else.
 * @param name - The field's name.
 * @returns The field, or `undefined` when `value` is not an object.
 */
export function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * Calls `visit` on every node of an AST, parents first. A node is an object with a string `type`;
 * arrays and other objects are walked through without a visit.
 *
 * @param node - The subtree to walk.
 * @param visit - Called with each node.
 */
export function walk(node: unknown, visit: (node: object) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  if (typeof field(node, "type") === "string") {
    visit(node);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "parent" && typeof child === "object" && child !== null) {
      walk(child, visit);
    }
  }
}

/**
 * The name a constructor or function is called by: the last segment of `a.b.C` or `this.#c`.
 *
 * @param callee - The `callee` of a call or `new` expression.
 * @returns The name, or `undefined` for a computed member or any other expression.
 */
export function calleeName(callee: unknown): string | undefined {
  const type = field(callee, "type");
  if (type === "Identifier") {
    const name = field(callee, "name");
    return typeof name === "string" ? name : undefined;
  }
  if (type === "MemberExpression" && field(callee, "computed") !== true) {
    const property = field(callee, "property");
    const name = field(property, "name");
    if (typeof name !== "string") {
      return undefined;
    }
    return field(property, "type") === "PrivateIdentifier" ? `#${name}` : name;
  }
  return undefined;
}
