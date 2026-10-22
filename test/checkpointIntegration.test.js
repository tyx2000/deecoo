import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/agent/taskRunner.js";
import { runSlashCommand } from "../src/commands/dispatcher.js";
import { createSessionStore } from "../src/session/store.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const config = { model: "test", quiet: true, stream: false, maxSteps: 10 };
const answer = (content, tokens = 1) => ({
  choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: tokens },
});
const call = (id, name, args, tokens = 1) => ({
  choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { total_tokens: tokens },
});

async function fixture(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-checkpoint-integration-"));
  const previousHome = process.env.DEECOO_HOME;
  process.env.DEECOO_HOME = join(cwd, "session-home");
  try {
    const sessionStore = await createSessionStore(cwd);
    const session = await sessionStore.createSession({ model: config.model });
    const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
    await fn({ cwd, sessionStore, session, tools });
  } finally {
    if (previousHome === undefined) delete process.env.DEECOO_HOME;
    else process.env.DEECOO_HOME = previousHome;
    await rm(cwd, { recursive: true, force: true });
  }
}

test("HARNESS-009 first-call budget exhaustion persists usage and step for /continue, then completion clears it", async () => fixture(async ({ cwd, sessionStore, session, tools }) => {
  const task = "Analyze this project's source structure.";
  let firstCalls = 0;
  const stopped = await runTask({ cwd, tools, sessionStore, session, task,
    config: { ...config, tokenBudget: 10 },
    client: { async chatCompletion() { firstCalls += 1; return answer("Analysis complete.", 10); } },
  });
  assert.equal(firstCalls, 1);
  assert.equal(stopped.stoppedReason, "token_budget_exceeded");
  const saved = await sessionStore.loadCheckpoint(session.id);
  assert.ok(saved, "a first-call budget stop must be resumable");
  assert.equal(saved.step, stopped.steps);
  assert.equal(saved.usage.totalTokens, 10);
  assert.equal(saved.metadata.task, task);

  const continuation = await runSlashCommand({ command: "/continue", sessionStore, session });
  assert.equal(continuation.kind, "continue-task");
  assert.equal(continuation.checkpoint.step, saved.step);
  assert.deepEqual(continuation.checkpoint.usage, saved.usage);
  let continuedCalls = 0;
  const completed = await runTask({ cwd, tools, sessionStore, session, task: continuation.checkpoint.metadata.task,
    config: { ...config, tokenBudget: 100 }, resumeCheckpoint: continuation.checkpoint,
    client: { async chatCompletion(request) {
      continuedCalls += 1;
      assert.match(request.messages.at(-1).content, /Continue the interrupted task/);
      return answer("Analysis complete: the temporary project contains no source files.", 3);
    } },
  });
  assert.equal(continuedCalls, 1);
  assert.equal(completed.status, "completed");
  assert.equal(completed.steps, saved.step + 1);
  assert.equal(completed.usage.totalTokens, 13);
  assert.equal(await sessionStore.loadCheckpoint(session.id), undefined);
}));

test("HARNESS-009 cancellation after a successful write retains effects and resumes an unknown call without repeating it", async () => fixture(async ({ cwd, sessionStore, session, tools }) => {
  const task = "Create interrupted.txt containing a single synthetic result.";
  const controller = new AbortController();
  const execute = tools.execute.bind(tools);
  let writeExecutions = 0;
  tools.execute = async (name, args, options) => {
    const result = await execute(name, args, options);
    if (name === "write_file" && result.ok) {
      writeExecutions += 1;
      controller.abort(new Error("Synthetic interruption after the committed write."));
    }
    return result;
  };
  const stopped = await runTask({ cwd, tools, sessionStore, session, task, config, signal: controller.signal,
    client: { async chatCompletion() { return call("committed-write", "write_file", { path: "interrupted.txt", content: "synthetic result\n" }); } },
  });
  assert.equal(stopped.status, "interrupted");
  assert.equal(writeExecutions, 1);
  assert.equal(await readFile(join(cwd, "interrupted.txt"), "utf8"), "synthetic result\n");
  const saved = await sessionStore.loadCheckpoint(session.id);
  assert.ok(saved);
  const changes = saved.effects.events.filter((event) => event.type === "file-change");
  assert.equal(changes.length, 1);
  assert.ok(changes[0].paths.includes("interrupted.txt"));
  assert.deepEqual(stopped.effects.events, saved.effects.events);
  assert.ok(saved.agentState.filesEdited.includes("interrupted.txt"));
  assert.equal(saved.messages.some((message) => message.role === "tool" && message.tool_call_id === "committed-write"), false);

  const continuation = await runSlashCommand({ command: "/continue", sessionStore, session });
  const completed = await runTask({ cwd, tools, sessionStore, session, task, config, resumeCheckpoint: continuation.checkpoint,
    client: { async chatCompletion(request) {
      const outcome = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "committed-write");
      assert.ok(outcome, "an unanswered side effect must have an explicit unknown outcome on resume");
      assert.equal(JSON.parse(outcome.content).code, "INTERRUPTED_OUTCOME_UNKNOWN");
      return answer("Implemented interrupted.txt. Tests not run because this fixture has no test command.", 2);
    } },
  });
  assert.equal(completed.status, "completed");
  assert.equal(writeExecutions, 1, "resume must never automatically replay the committed write");
  assert.equal(completed.usage.totalTokens, saved.usage.totalTokens + 2);
  assert.equal(completed.effects.events.filter((event) => event.type === "file-change").length, 1);
  assert.equal(await readFile(join(cwd, "interrupted.txt"), "utf8"), "synthetic result\n");
  assert.equal(await sessionStore.loadCheckpoint(session.id), undefined);
}));

test("quiet task failures stay off stderr when provider failure is followed by audit persistence failure", async (t) => fixture(async ({ cwd, sessionStore, session, tools }) => {
  // A regular file where the audit directory belongs deterministically rejects persistence,
  // even when the test process has permission to write the surrounding temporary workspace.
  await writeFile(join(sessionStore.projectDir, "audit"), "blocked audit directory");
  const stderr = [];
  const mocked = t.mock.method(process.stderr, "write", (chunk, encoding, callback) => {
    stderr.push(String(chunk));
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  });
  let result;
  try {
    result = await runTask({ cwd, tools, sessionStore, session, task: "Analyze project structure.", config,
      client: { async chatCompletion() { throw new Error("Synthetic provider failure."); } },
    });
  } finally {
    mocked.mock.restore();
  }
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /Synthetic provider failure/);
  assert.deepEqual(stderr, []);
  assert.equal(await readFile(join(sessionStore.projectDir, "audit"), "utf8"), "blocked audit directory");
  assert.ok(await sessionStore.loadCheckpoint(session.id), "failed audit persistence must not discard the resumable state");
}));
