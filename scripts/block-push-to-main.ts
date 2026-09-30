// Git pre-push guard: every change to `main` must go through a pull request.
// Git passes "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin.
// GitHub cannot enforce this on a free private repo, so it is enforced locally
// until the ruleset in .github/ruleset-protect-main.json is applied.
import { readFileSync } from "node:fs";

const updates = readFileSync(0, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "");
const protectedRefs = new Set(["refs/heads/main"]);
const blocked = updates
  .map((line) => line.split(" ")[2])
  .filter((ref) => protectedRefs.has(ref ?? ""));

if (blocked.length > 0) {
  process.stderr.write(
    "Direct pushes to main are not allowed: push a branch and open a pull request.\n",
  );
  process.exit(1);
}
