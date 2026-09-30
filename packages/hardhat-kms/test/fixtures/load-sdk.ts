// Loads a provider SDK on purpose, so the SDK-loading test can check that its recorder notices.
// HHKMS_FIXTURE_PROJECT names a project with a fake @aws-sdk/client-kms; HHKMS_FIXTURE_MODE picks
// how it is loaded.
import { createRequire } from "node:module";
import path from "node:path";

import { loadSdk } from "../../src/internal/providers/sdk.ts";

const { HHKMS_FIXTURE_PROJECT: project = "", HHKMS_FIXTURE_MODE: mode } = process.env;

if (mode === "require") {
  createRequire(path.join(project, "package.json"))("@aws-sdk/client-kms");
} else {
  await loadSdk({ packageName: "@aws-sdk/client-kms", range: "^3.0.0" }, project, "aws");
}
