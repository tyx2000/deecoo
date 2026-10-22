import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runTask } from "../src/agent/taskRunner.js";
import { createModelClient } from "../src/llm/clientFactory.js";
import { schemaFingerprint } from "../src/llm/prepareRequest.js";
import { createSessionStore } from "../src/session/store.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const extension = (name, mutates, render) => ({ schema: { type: "function", function: { name, description: "Local fixture", parameters: { type: "object", properties: {} } } },
  mutates, workerModes: ["research"], execute: async () => ({ ok: true, data: 1 }), toModelContent: render, presentationMeta: () => ({ title: "Local metadata" }) });
const reply = (message) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", ...message }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));

test("DSH-REF-003 run metadata, actual requests and resume share policy-filtered schema identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "deecoo-request-route-")); const originalFetch = globalThis.fetch;
  try {
    const cwd = join(root, "workspace"); await mkdir(cwd); await writeFile(join(cwd, "value.js"), "export const value = 1;\n");
    const config = { provider: "openai", model: "local-route-test", baseUrl: "https://example.test/v1", apiKey: "synthetic-secret", retryAttempts: 1,
      timeoutMs: 1000, quiet: true, stream: false, maxTokens: 400, modelMetadata: { contextWindow: 65536, maxOutputTokens: 128 },
      taskMode: "analysis", maxSteps: 6, sandboxPolicy: { mode: "off" } };
    const store = await createSessionStore(cwd, { rootDir: join(root, "state"), privacyMode: "ephemeral" });
    const session = await store.createSession({ model: config.model });
    const makeTools = (render = () => "initial rendering", hiddenWriter = false) => {
      const tools = createToolRuntime({ cwd, permissionMode: "workspace-write" });
      tools.registerTool(extension("fixture_read", false, render));
      if (hiddenWriter) tools.registerTool(extension("fixture_write", true, () => "hidden writer"));
      return tools;
    };
    let calls = 0; const wireRequests = []; const initialEvents = [];
    globalThis.fetch = async (_url, options) => {
      wireRequests.push(JSON.parse(options.body));
      if (++calls === 1) return reply({ tool_calls: [{ id: "read-value", function: { name: "read_file", arguments: JSON.stringify({ path: "value.js" }) } }] });
      throw Object.assign(new Error("Synthetic interruption"), { name: "AbortError" });
    };
    const input = { cwd, task: "Analyze value.js.", sessionStore: store, session };
    const initial = await runTask({ ...input, client: createModelClient(config), tools: makeTools(), config: { ...config, onEvent: (event) => initialEvents.push(event) } });
    assert.equal(initial.status, "interrupted");
    const checkpoint = await store.loadCheckpoint(session.id); const expected = checkpoint.metadata.routeIdentity;
    assert.deepEqual(initialEvents.find((event) => event.type === "run-start").routeIdentity, expected);
    for (const event of initialEvents.filter((event) => event.type === "request-prepared")) assert.deepEqual(event.routeIdentity, expected);
    for (const request of wireRequests) {
      assert.equal(schemaFingerprint(request.tools), expected.toolsSchemaFingerprint);
      assert.equal(request.max_completion_tokens, 128);
      assert.equal(request.tools.some((schema) => schema.function.name === "write_file"), false);
    }

    const resumedEvents = []; let resumedCalls = 0;
    globalThis.fetch = async (_url, options) => { resumedCalls++; const request = JSON.parse(options.body);
      assert.equal(schemaFingerprint(request.tools), expected.toolsSchemaFingerprint);
      return reply({ content: "Analyzed value.js; value is 1." }); };
    const fresh = makeTools(() => "different local render function", true);
    const resumed = await runTask({ ...input, client: createModelClient(config), tools: fresh, resumeCheckpoint: checkpoint,
      config: { ...config, onEvent: (event) => resumedEvents.push(event) } });
    assert.equal(resumed.status, "completed", JSON.stringify(resumed.error)); assert.equal(resumedCalls, 1);
    assert.equal(fresh.schemas.some((schema) => schema.function.name === "fixture_write"), false);
    assert.deepEqual(resumed.routeIdentity, expected);
    assert.deepEqual(resumedEvents.find((event) => event.type === "run-start").routeIdentity, expected);
    assert.deepEqual(resumedEvents.find((event) => event.type === "request-prepared").routeIdentity, expected);

    const visible = makeTools(); visible.registerTool(extension("fixture_extra_read", false, () => "visible reader"));
    const refused = await runTask({ ...input, client: createModelClient(config), tools: visible, resumeCheckpoint: checkpoint, config });
    assert.equal(refused.stoppedReason, "CHECKPOINT_ROUTE_IDENTITY_CHANGED"); assert.equal(resumedCalls, 1);
    const changedMode = await runTask({ ...input, client: createModelClient(config), tools: makeTools(), resumeCheckpoint: checkpoint,
      config: { ...config, taskMode: "edit" } });
    assert.equal(changedMode.status, "failed"); assert.match(changedMode.error.message, /changed mayWrite/); assert.equal(resumedCalls, 1);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
