import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatUserConfig } from "hardhat/types/config";

import hardhatKmsSafe from "../../src/index.ts";
import { validateKmsSafe } from "../../src/internal/hook-handlers/config.ts";

/** A config whose `kmsSafe` is any value, as a JavaScript config can hold. */
function withSection(section: unknown): HardhatUserConfig {
  const config: HardhatUserConfig = { plugins: [hardhatKmsSafe] };
  Reflect.set(config, "kmsSafe", section);
  return config;
}

const messages = (section: unknown): string[] =>
  validateKmsSafe(section).map((error) => `${error.path.join(".")}: ${error.message}`);

describe("kmsSafe config", () => {
  it("accepts no section, an empty one and a full one, and resolves the defaults", async () => {
    assert.deepEqual(validateKmsSafe(undefined), []);
    assert.deepEqual(validateKmsSafe({}), []);
    const hre = await createHardhatRuntimeEnvironment({ plugins: [hardhatKmsSafe] });
    assert.deepEqual(hre.config.kmsSafe, { apiKey: undefined, services: {}, timeoutMs: 30_000 });
    process.env.HHKMS_TEST_SAFE_CONFIG_KEY = "value-not-a-secret";
    const full = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKmsSafe],
      kmsSafe: {
        apiKey: configVariable("HHKMS_TEST_SAFE_CONFIG_KEY"),
        services: { "11155111": "https://safe.example.com", "31337": "http://127.0.0.1:8000" },
        timeoutMs: 5000,
      },
    });
    assert.equal(await full.config.kmsSafe.apiKey?.get(), "value-not-a-secret");
    assert.deepEqual(full.config.kmsSafe.services, {
      "11155111": "https://safe.example.com",
      "31337": "http://127.0.0.1:8000",
    });
    assert.equal(full.config.kmsSafe.timeoutMs, 5000);
  });

  it("refuses an API key written in the config", async () => {
    await assert.rejects(
      createHardhatRuntimeEnvironment(withSection({ apiKey: "sk-literal-not-a-secret" })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /kmsSafe\.apiKey/);
        assert.match(error.message, /must be a configuration variable/);
        assert.doesNotMatch(error.message, /sk-literal/);
        return true;
      },
    );
  });

  it("names each problem", () => {
    assert.match(messages("x").join(), /^kmsSafe: must be an object/);
    assert.match(messages([]).join(), /^kmsSafe: must be an object/);
    assert.match(
      messages({ apiKey: { _type: "ConfigurationVariable" } }).join(),
      /apiKey: must be a configuration variable/,
    );
    assert.match(messages({ services: [] }).join(), /kmsSafe.services: must be an object/);
    assert.match(
      messages({ services: { sepolia: "https://a.test" } }).join(),
      /services.sepolia: must be a chain id/,
    );
    assert.match(
      messages({ services: { "0": "https://a.test" } }).join(),
      /services.0: must be a chain id/,
    );
    assert.match(
      messages({ services: { "1": "http://a.test" } }).join(),
      /services.1: must be an https URL/,
    );
    assert.match(messages({ services: { "1": 7 } }).join(), /services.1: must be an https URL/);
    for (const timeoutMs of [999, 300_001, 1.5, "1000"]) {
      assert.match(messages({ timeoutMs }).join(), /timeoutMs: must be a whole number/);
    }
    assert.match(messages({ apikey: 1 }).join(), /kmsSafe.apikey: must be an object with only/);
  });
});
