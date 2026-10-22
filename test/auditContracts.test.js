import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSecretRegistry } from "../src/config/secrets.js";
import { redact, saveRunAudit } from "../src/observability/audit.js";

test("SCOR-001 audit removes bare secrets in nested strings without retaining captured values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-audit-contract-"));
  try {
    const secret = "sk-syntheticAuditSecret12345";
    const file = await saveRunAudit({ projectDir: directory }, { id: "test-session" }, {
      task: "inspect " + secret,
      nested: [{ content: "credential " + secret + " ordinary text" }],
      env: { OPENAI_API_KEY: secret },
    });
    const content = await readFile(file.path, "utf8");
    assert.ok(!content.includes(secret));
    assert.match(content, /ordinary text/);
    assert.match(content, /REDACTED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SCOR-001 concrete secret registry redacts nonstandard values before audit truncation", () => {
  const secret = "synthetic-opaque-credential";
  const secretRegistry = createSecretRegistry({ CUSTOM_API_KEY: secret });
  const content = "x".repeat(39995) + secret;
  const result = redact({ message: content, nested: [secret] }, { secretRegistry });
  assert.ok(!result.message.includes(secret.slice(0, 10)));
  assert.ok(!result.nested[0].includes(secret));
});

test("SCOR-008 audit preserves token counters and limits while hiding credentials", () => {
  const input = {
    usage: { promptTokens: 1, completion_tokens: 2, totalTokens: 3 },
    tokenBudget: 100,
    worker_token_budget: 20,
    max_tokens: 4096,
    access_token: "synthetic-access-token",
    refreshToken: "synthetic-refresh-token",
    apiKey: "synthetic-key",
    password: "synthetic-password",
  };
  const result = redact(input);
  assert.deepEqual(result.usage, input.usage);
  assert.equal(result.tokenBudget, 100);
  assert.equal(result.worker_token_budget, 20);
  assert.equal(result.max_tokens, 4096);
  for (const key of ["access_token", "refreshToken", "apiKey", "password"]) {
    assert.equal(result[key], "[REDACTED]");
  }
});
