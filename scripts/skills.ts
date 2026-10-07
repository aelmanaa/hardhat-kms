// Two rules of `scripts/check-docs.ts` for the agent skills under skills/:
// - each `SKILL.md` has the Agent Skills frontmatter: a `name` equal to its directory's name, in
//   lowercase letters, digits and single hyphens, and a `description` of at most
//   SKILL_DESCRIPTION_MAX characters (skillProblems);
// - a link into this repository's `main` branch on GitHub points at a file that exists, since an
//   installed skill is copied away from the repository and cannot use relative links
//   (repositoryLinkProblems).
// `skills-ref validate skills/<name>` checks the format in full; these rules keep CI from
// regressing between runs of it.
// Kept apart from check-docs.ts, which runs on import, so `test/scripts/skills.test.ts` can call
// them.
import path from "node:path";

import { parse } from "yaml";

/** The longest skill description the Agent Skills format allows, in characters. */
export const SKILL_DESCRIPTION_MAX = 1024;

/** The longest skill name the Agent Skills format allows, in characters. */
export const SKILL_NAME_MAX = 64;

/** The prefix of a link to a file on this repository's `main` branch. */
export const REPOSITORY_BLOB = "https://github.com/aelmanaa/hardhat-kms/blob/main/";

/** A link to a file on `main`, capturing its path without an anchor or query. */
const REPOSITORY_LINK = /https:\/\/github\.com\/aelmanaa\/hardhat-kms\/blob\/main\/([^)\s#?>"]+)/g;

function property(data: unknown, name: string): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, name) : undefined;
}

/**
 * The frontmatter problems of one skill, each as `file:line: message`.
 *
 * @param file - The skill's `SKILL.md`, from the repository root, such as `skills/x/SKILL.md`.
 * @param text - Its content.
 */
export function skillProblems(file: string, text: string): string[] {
  const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (block === null) {
    return [
      `${file}:1: no frontmatter; a skill starts with a --- block that holds name and description`,
    ];
  }
  let data: unknown;
  try {
    data = parse(block[1] ?? "");
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return [`${file}:1: frontmatter is not valid YAML (${reason})`];
  }
  const problems: string[] = [];
  const directory = path.posix.basename(path.posix.dirname(file));
  const name = property(data, "name");
  if (typeof name !== "string" || name === "") {
    problems.push(
      `${file}:1: frontmatter has no name; set it to the directory's name, ${directory}`,
    );
  } else if (name !== directory) {
    problems.push(`${file}:1: name "${name}" differs from the directory's name, ${directory}`);
  } else if (name.length > SKILL_NAME_MAX || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    problems.push(
      `${file}:1: name "${name}" must be lowercase letters, digits and single hyphens, at most ${String(SKILL_NAME_MAX)} characters`,
    );
  }
  const description = property(data, "description");
  if (typeof description !== "string" || description.trim() === "") {
    problems.push(
      `${file}:1: frontmatter has no description; say what the skill does and when to use it`,
    );
  } else if (description.length > SKILL_DESCRIPTION_MAX) {
    problems.push(
      `${file}:1: description is ${String(description.length)} characters; keep it to ${String(SKILL_DESCRIPTION_MAX)}`,
    );
  }
  return problems;
}

/**
 * The links to this repository's `main` branch whose file does not exist, each as
 * `file:line: message`.
 *
 * @param file - The page, from the repository root, as reported.
 * @param text - Its content.
 * @param exists - Whether a path from the repository root exists.
 */
export function repositoryLinkProblems(
  file: string,
  text: string,
  exists: (target: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(REPOSITORY_LINK)) {
    const target = decodeURIComponent(match[1] ?? "");
    if (!exists(target)) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(
        `${file}:${String(line)}: links to ${target}, which does not exist on this branch`,
      );
    }
  }
  return problems;
}
