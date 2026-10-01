import { HardhatPluginError } from "hardhat/plugins";

import { PLUGIN_ID } from "./constants.ts";

/**
 * The only details an error may carry. Everything here is safe to print: no credentials, no
 * tokens, no raw SDK error objects (they can hold request metadata and headers).
 */
export interface ErrorDetails {
  /** Provider id, for example `aws`. */
  provider?: string | undefined;
  /** What was being done, for example `sign` or `get public key`. */
  operation?: string | undefined;
  /** The key's display id (masked when it came from a configuration variable). */
  key?: string | undefined;
}

/**
 * Builds a `HardhatPluginError` from a message and allow-listed details.
 *
 * @param message - What went wrong and, when possible, how to fix it.
 * @param details - Optional context, limited to fields that are safe to print.
 * @returns The error to throw.
 */
export function kmsError(message: string, details: ErrorDetails = {}): HardhatPluginError {
  const context = [
    details.provider,
    details.operation,
    details.key === undefined ? undefined : `key ${details.key}`,
  ].filter((part) => part !== undefined);
  const prefix = context.length > 0 ? `${context.join(", ")}: ` : "";
  return new HardhatPluginError(PLUGIN_ID, `${prefix}${message}`);
}

/**
 * Names an error for messages and logs without its text, which can carry request details. The
 * name is kept only if it looks like a class name.
 *
 * @param error - Anything thrown.
 * @returns A short, safe name.
 */
export function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)) {
    return error.name;
  }
  return error instanceof Error ? "Error" : typeof error;
}

/**
 * What an error catalogue entry describes:
 *
 * - `error`: an error the plugin throws, built with {@link catalogError} (or with
 *   {@link catalogMessage} for an error class of its own).
 * - `reason`: text that another entry's message includes in a placeholder, such as why a public
 *   key was refused. Built with {@link catalogMessage}.
 * - `validation`: a config validation message, which Hardhat shows after the config path.
 *   Built with {@link catalogMessage}.
 * - `internal`: a plain `Error` that only a bug or a broken install can cause, built with
 *   {@link internalError}.
 */
export type ErrorKind = "error" | "reason" | "validation" | "internal";

/** A value a message template placeholder takes. */
export type TemplateValue = string | number | bigint;

/** The characters of a string, as a union. */
type Characters<
  S extends string,
  Found extends string = never,
> = S extends `${infer First}${infer Rest}` ? Characters<Rest, Found | First> : Found;
type Letter = Characters<"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ">;
type NameCharacter = Letter | Characters<"0123456789">;

/** Whether `S` is made only of letters and digits (true for ""). */
type IsNameRest<S extends string> = S extends `${infer First}${infer Rest}`
  ? First extends NameCharacter
    ? IsNameRest<Rest>
    : false
  : true;

/** Whether `S` is a placeholder name: a letter, then letters and digits. */
type IsName<S extends string> = S extends `${infer First}${infer Rest}`
  ? First extends Letter
    ? IsNameRest<Rest>
    : false
  : false;

/**
 * The values a message template needs: one per `{name}` placeholder. Braces around anything other
 * than a name, such as `{name, type}`, are literal text. {@link fillTemplate} reads a template the
 * same way: from each `{` to the next `}`.
 */
export type TemplateParams<Template extends string> =
  Template extends `${string}{${infer Tag}}${infer Rest}`
    ? (IsName<Tag> extends true ? { readonly [Name in Tag]: TemplateValue } : object) &
        TemplateParams<Rest>
    : object;

/**
 * One entry of an error catalogue: a stable id, a message template, and what causes the error and
 * how to fix it. `docs/user/reference/errors.md` is generated from the catalogues.
 */
export interface ErrorEntry<Template extends string = string, Kind extends ErrorKind = ErrorKind> {
  /** Stable id, `<package>.<area>.<name>`, such as `aws.sign.response-key-mismatch`. */
  readonly id: string;
  /** What the entry describes. */
  readonly kind: Kind;
  /** The heading the reference lists the entry under, such as `Signing`. */
  readonly group: string;
  /** The message, with `{name}` placeholders. */
  readonly template: Template;
  /** What causes it, in a sentence or two. */
  readonly cause: string;
  /** What to do about it. */
  readonly fix: string;
}

/**
 * Fills a template's `{name}` placeholders. A `{` that does not start a placeholder, as in
 * `{name, type}`, is kept as written.
 *
 * @param template - The template.
 * @param params - A value for each placeholder.
 * @returns The message.
 */
export function fillTemplate<Template extends string>(
  template: Template,
  params: TemplateParams<Template>,
): string {
  let message = "";
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf("{", index);
    const close = open === -1 ? -1 : template.indexOf("}", open + 1);
    if (close === -1) {
      break;
    }
    const name = template.slice(open + 1, close);
    const value: unknown = /^[A-Za-z][A-Za-z0-9]*$/.test(name)
      ? Reflect.get(params, name)
      : undefined;
    message += template.slice(index, open);
    message +=
      typeof value === "string" || typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : template.slice(open, close + 1);
    index = close + 1;
  }
  return message + template.slice(index);
}

/**
 * Builds the `HardhatPluginError` a catalogue entry describes, with {@link kmsError}'s prefix.
 *
 * @param entry - An `error` entry.
 * @param params - A value for each placeholder of its template.
 * @param details - Optional context, limited to fields that are safe to print.
 * @returns The error to throw.
 */
export function catalogError<Template extends string>(
  entry: ErrorEntry<Template, "error">,
  params: TemplateParams<Template>,
  details?: ErrorDetails,
): HardhatPluginError {
  return kmsError(fillTemplate(entry.template, params), details);
}

/**
 * Builds the text of a `reason` or `validation` entry, or of an `error` entry for an error class
 * of its own, such as one that carries a transaction hash.
 *
 * @param entry - A `reason`, `validation` or `error` entry.
 * @param params - A value for each placeholder of its template.
 * @returns The text.
 */
export function catalogMessage<Template extends string>(
  entry: ErrorEntry<Template, "reason" | "validation" | "error">,
  params: TemplateParams<Template>,
): string {
  return fillTemplate(entry.template, params);
}

/**
 * Builds the plain `Error` an `internal` entry describes: a state that only a bug or a broken
 * install can reach.
 *
 * @param entry - An `internal` entry.
 * @param params - A value for each placeholder of its template.
 * @returns The error to throw.
 */
export function internalError<Template extends string>(
  entry: ErrorEntry<Template, "internal">,
  params: TemplateParams<Template>,
): Error {
  return new Error(fillTemplate(entry.template, params));
}
