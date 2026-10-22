import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/agent/taskRunner.js";
import { createSubagentRuntime } from "../src/agent/subagents/runtime.js";
import { buildContextBudget, estimateTokens, measureContextMessages } from "../src/context/builder.js";
import { CONTENT_TRUST_INSTRUCTION } from "../src/harness/contentTrust.js";
import { FALLBACK_CONTEXT_WINDOW } from "../src/llm/capabilities.js";
import { prepareModelRequest } from "../src/llm/prepareRequest.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { createSessionStore } from "../src/session/store.js";

const model = "unknown-context-model";
const maxTokens = 128;
const answer = (text = "BUDGET_OK") => ({ choices: [{ message: { role: "assistant", content: text } }], usage: { total_tokens: 1 } });
const clientFor = (complete) => ({
  prepareRequest(request, options) { return prepareModelRequest(this, request, { provider: "custom", model, maxTokens }, options); },
  chatCompletion: complete,
});
const measuredInput = (request) => measureContextMessages(request.messages) + estimateTokens(request.tools ?? []);
async function fixture(action) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-initial-context-"));
  try { await action(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("CONTEXT-CLI-001 first request reserves real system/task/tool overhead and keeps project rules at the 32K fallback", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, "README.md"), "资料".repeat(4000));
  await writeFile(join(cwd, ".deecoo.md"), "CONTEXT_RULE_SENTINEL: Never edit generated files.\n");
  const task = "不调用工具，仅回复 BUDGET_OK";
  const tools = createToolRuntime({ cwd, permissionMode: "read-only", prompter: async () => false });
  let calls = 0, inputTokens;
  const result = await runTask({ cwd, task, tools,
    config: { model, maxTokens, quiet: true, stream: false, taskMode: "read-only", maxSteps: 1 },
    client: clientFor(async (request) => {
      calls++;
      inputTokens = measuredInput(request);
      assert.ok(inputTokens <= buildContextBudget({ contextWindow: FALLBACK_CONTEXT_WINDOW, outputReserve: maxTokens }).inputTokens);
      assert.ok(request.messages.some((message) => message.role === "user" && message.content === task));
      assert.ok(request.messages.some((message) => message.role === "system" && message.content.includes("CONTEXT_RULE_SENTINEL")));
      assert.ok(request.messages[0].content.includes(CONTENT_TRUST_INSTRUCTION));
      assert.deepEqual(request.tools, tools.schemas);
      assert.ok(request.tools.length > 0);
      return answer();
    }),
  });
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.equal(calls, 1);
  assert.equal(result.effectiveConfig.contextWindow, FALLBACK_CONTEXT_WINDOW);
  assert.equal(result.effectiveConfig.contextWindowSource, "conservative-fallback");
  assert.ok(result.contextMetrics.droppedItems >= 1, "optional README/snapshot context must yield to required request overhead");
  assert.equal(result.contextMetrics.estimatedInputTokens, inputTokens);
  assert.ok(result.contextMetrics.reservedInputTokens > 0);
  assert.equal(result.contextMetrics.estimatedContextTokens + result.contextMetrics.reservedInputTokens, inputTokens);
  assert.equal(result.contextState.compactions.length, 0, "selection happens before transcript capture, without inventing a compaction");
}));

test("CONTEXT-CLI-001 oversized mandatory project instructions fail before dispatch instead of being silently omitted", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, ".deecoo.md"), "必须保留".repeat(1800));
  let calls = 0;
  const result = await runTask({ cwd, task: "Analyze the project", tools: createToolRuntime({ cwd, permissionMode: "read-only" }),
    config: { model, maxTokens, contextWindow: 24576, quiet: true, stream: false, taskMode: "analysis" },
    client: clientFor(async () => { calls++; return answer(); }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "CONTEXT_BUDGET_EXCEEDED");
  assert.equal(calls, 0);
}));

test("CONTEXT-CLI-001 active skill instructions are required request overhead, never optional retrieval", async () => fixture(async (cwd) => {
  let calls = 0;
  const result = await runTask({ cwd, task: "Analyze the project", tools: createToolRuntime({ cwd, permissionMode: "read-only" }),
    activeSkills: [{ name: "large-instructions", sourceLabel: "fixture", relativePath: "SKILL.md", summary: "mandatory", content: "SKILL_RULE ".repeat(4000) }],
    config: { model, maxTokens, quiet: true, stream: false, taskMode: "analysis" },
    client: clientFor(async () => { calls++; return answer(); }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "CONTEXT_BUDGET_EXCEEDED");
  assert.equal(calls, 0);
}));

test("CONTEXT-CLI-001 worker first turn budgets its actual prompt/tools and continues only the selected context", async () => fixture(async (cwd) => {
  let calls = 0;
  const tools = createToolRuntime({ cwd, permissionMode: "read-only", prompter: async () => false });
  const runtime = createSubagentRuntime({ cwd, workerTools: tools,
    config: { model, maxTokens, stream: false, maxSteps: 1 },
    contextMessages: [{ role: "system", content: "WORKER_RULE_SENTINEL: inspect only." },
      { role: "user", content: "OPTIONAL_RETRIEVAL_SENTINEL ".repeat(2000) }],
    client: clientFor(async (request) => {
      calls++;
      assert.ok(measuredInput(request) <= buildContextBudget({ contextWindow: FALLBACK_CONTEXT_WINDOW, outputReserve: maxTokens }).inputTokens);
      assert.ok(request.messages.some((message) => message.role === "system" && message.content.includes("WORKER_RULE_SENTINEL")));
      assert.equal(JSON.stringify(request.messages).includes("OPTIONAL_RETRIEVAL_SENTINEL"), false);
      return answer("Worker inspection completed.");
    }),
  });
  const first = await runtime.start({ prompt: "Inspect the fixture", mode: "research" });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await runtime.send({ to: first.task_id, message: "Summarize the prior inspection" });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(calls, 2);
  const history = runtime.contextHistory();
  assert.equal(history.length, 2);
  assert.ok(history[0].contextState.transcript.every((record) => !JSON.stringify(record).includes("OPTIONAL_RETRIEVAL_SENTINEL")));
}));

for (const growth of ["disk-rules", "active-skills"]) {
  test(`CONTEXT-CLI-001 checkpoint resume budgets saved messages when unused fresh ${growth} grow`, async () => fixture(async (cwd) => {
    await writeFile(join(cwd, ".deecoo.md"), "ORIGINAL_RULE_SENTINEL: inspect only.\n");
    await writeFile(join(cwd, "sample.txt"), "Original fixture data.\n");
    const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), privacyMode: "ephemeral" });
    const session = await store.createSession({ model });
    const tools = createToolRuntime({ cwd, permissionMode: "read-only", prompter: async () => false });
    const config = { model, maxTokens, quiet: true, stream: false, taskMode: "analysis", maxSteps: 1 };
    let calls = 0;
    const initial = await runTask({ cwd, task: "Analyze the project", tools, sessionStore: store, session, config,
      client: clientFor(async () => {
        calls++;
        return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "inspect", type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "sample.txt" }) } }] } }], usage: { total_tokens: 1 } };
      }),
    });
    assert.equal(initial.stoppedReason, "step_budget_exceeded");
    const saved = await store.loadCheckpoint(session.id);
    assert.ok(saved?.contextState);
    const oldTranscript = structuredClone(saved.contextState.transcript);
    const activeSkills = growth === "active-skills" ? [{ name: "later-rules", sourceLabel: "fixture", relativePath: "SKILL.md",
      summary: "unused new context", content: "NEW_SKILL_RULE ".repeat(4000) }] : [];
    if (growth === "disk-rules") await writeFile(join(cwd, ".deecoo.md"), "新增规则".repeat(1800));
    const resumed = await runTask({ cwd, task: "Analyze the project", tools, sessionStore: store, session,
      config: { ...config, maxSteps: 3 }, activeSkills, resumeCheckpoint: saved,
      client: clientFor(async (request) => {
        calls++;
        assert.ok(measuredInput(request) <= buildContextBudget({ contextWindow: FALLBACK_CONTEXT_WINDOW, outputReserve: maxTokens }).inputTokens);
        assert.deepEqual(request.messages.slice(0, saved.messages.length), saved.messages);
        assert.equal(JSON.stringify(request.messages).includes("NEW_SKILL_RULE"), false);
        assert.equal(JSON.stringify(request.messages).includes("新增规则"), false);
        return answer("Analysis completed from the inspected fixture.");
      }),
    });
    assert.equal(resumed.status, "completed", JSON.stringify(resumed.error));
    assert.equal(calls, 2);
    assert.equal(resumed.contextMetrics.contextSource, "checkpoint");
    assert.equal(resumed.contextState.contextId, saved.contextState.contextId);
    assert.equal(resumed.contextState.protectedPrefixCount, saved.contextState.protectedPrefixCount);
    assert.deepEqual(resumed.contextState.transcript.slice(0, oldTranscript.length), oldTranscript);
  }));
}
