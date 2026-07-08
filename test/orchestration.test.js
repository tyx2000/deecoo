import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeTaskCoordination } from "../src/agent/coordination.js";
import { compactToolResult } from "../src/agent/loop.js";
import { runAgent } from "../src/agent/loop.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { createSubagentRuntime } from "../src/agent/subagents/runtime.js";
import { buildContextMessages, contextItem } from "../src/context/builder.js";
import { buildProjectIndex } from "../src/context/projectIndex.js";
import { buildReviewScopeMessages, resolveReviewScope } from "../src/context/reviewScope.js";
import { buildWorkspaceSnapshot, buildWorkspaceSnapshotMessages, ensureProjectDescription } from "../src/context/workspaceSnapshot.js";
import { buildTaskSpec } from "../src/harness/taskSpec.js";
import { advanceWorkflowState, createWorkflowState } from "../src/harness/workflow.js";
import { loadProjectMemory, recordProjectMemory } from "../src/memory/projectMemory.js";
import { redact, saveRunAudit } from "../src/observability/audit.js";
import { classifyShellCommand } from "../src/permissions/shellPolicy.js";
import { saveRunOutputs } from "../src/reporter/outputs.js";
import { aggregateReviewReport, createReviewFinalValidator, validateReviewReportText } from "../src/reporter/reviewReport.js";
import { scorArtifactMetadata, scorReviewToolPolicy } from "../src/skills/scor.js";
import { advanceVerificationState, emptyVerificationState } from "../src/verification/state.js";
import { buildVerificationPlan } from "../src/verification/planner.js";
import { createToolRuntime } from "../src/tools/runtime.js";

test("research worker tools are read-only", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-worker-tools-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    permissionMode: "workspace-write",
  });
  const workerTools = runtime.createWorkerTools({ mode: "research" });

  assert.deepEqual(
    workerTools.schemas.map((schema) => schema.function.name),
    ["list_files", "read_file", "search_text", "git_status", "git_diff"],
  );

  const result = await workerTools.execute("write_file", { path: "blocked.txt", content: "no" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_TOOL_BLOCKED");
});

test("verify workers can run shell but cannot edit files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-worker-tools-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    allowShellWithoutPrompt: true,
    permissionMode: "workspace-write",
  });
  const workerTools = runtime.createWorkerTools({ mode: "verify" });

  assert.equal(workerTools.schemas.some((schema) => schema.function.name === "run_shell"), true);
  assert.equal(workerTools.schemas.some((schema) => schema.function.name === "write_file"), false);

  const result = await workerTools.execute("write_file", { path: "blocked.txt", content: "no" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_TOOL_BLOCKED");
});

test("implement workers can edit files within their delegated scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-worker-tools-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    permissionMode: "workspace-write",
  });
  const workerTools = runtime.createWorkerTools({ mode: "implement" });

  await writeFile(join(workspace, "target.txt"), "old", "utf8");
  const result = await workerTools.execute("edit_file", {
    path: "target.txt",
    search: "old",
    replace: "new",
  });

  assert.equal(result.ok, true);
});

test("coordination assigns explicit worker modes for complex edit tasks", () => {
  const coordination = analyzeTaskCoordination(
    "Inspect the repo, implement the fix, run tests, and explain residual risk in detail.",
  );

  assert.equal(coordination.complex, true);
  assert.equal(coordination.parallel[0]?.mode, "research");
  assert.equal(coordination.serial[0]?.mode, "implement");
  assert.equal(coordination.verification?.mode, "verify");
});

test("simple prompts omit complex coordination protocol", () => {
  const prompt = buildSystemPrompt("/tmp/workspace", "general", [], { complex: false });

  assert.equal(prompt.includes("Complex-task coordination:"), false);
});

test("base prompt states CLI operating procedure", () => {
  const prompt = buildSystemPrompt("/tmp/workspace", "edit", [], { complex: false });

  assert.match(prompt, /Core operating procedure/);
  assert.match(prompt, /You cannot access files directly/);
  assert.match(prompt, /Before editing, inspect the relevant current files/);
  assert.match(prompt, /Never access files outside the workspace/);
  assert.match(prompt, /When done, summarize/);
  assert.match(prompt, /files changed/);
  assert.match(prompt, /tests or checks run/);
});

test("tool observations are compacted before returning to the model", () => {
  const result = compactToolResult("run_shell", {
    ok: true,
    stdout: "x".repeat(13000),
    stderr: "",
    activity: { kind: "command", label: "Ran command", target: "big" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.activity.target, "big");
  assert.equal(result.stdout.length < 12200, true);
  assert.match(result.stdout, /truncated 1000 additional characters/);
});

test("S-COR task policy blocks writes and implement workers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scor-policy-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    permissionMode: "workspace-write",
  });

  runtime.setTaskToolPolicy(scorReviewToolPolicy());

  const writeResult = await runtime.execute("write_file", { path: "blocked.txt", content: "no" });
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.code, "TASK_TOOL_BLOCKED");

  const workerResult = await runtime.execute("agent", {
    description: "implement",
    mode: "implement",
    prompt: "Edit a file.",
  });
  assert.equal(workerResult.ok, false);
  assert.equal(workerResult.code, "TASK_WORKER_MODE_BLOCKED");
});

test("S-COR review scope prefers explicit file mentions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scor-scope-"));
  const scope = await resolveReviewScope({
    cwd: workspace,
    task: "Use s-cor to review @src/tools/runtime.js and @test/runtime.test.js",
  });

  assert.equal(scope.mode, "explicit");
  assert.deepEqual(scope.files, ["src/tools/runtime.js", "test/runtime.test.js"]);
});

test("S-COR review scope context is only added for active review tasks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scor-scope-"));
  const messages = await buildReviewScopeMessages({
    cwd: workspace,
    task: "review @src/tools/runtime.js",
    activeSkills: [{ name: "s-cor" }],
    requestType: "review",
  });
  const skipped = await buildReviewScopeMessages({
    cwd: workspace,
    task: "review @src/tools/runtime.js",
    activeSkills: [],
    requestType: "review",
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /S-COR deterministic review scope/);
  assert.equal(skipped.length, 0);
});

test("S-COR artifact metadata summarizes structured findings", () => {
  const metadata = scorArtifactMetadata(`
    SCOR-001 P1 CONFIRMED
    SCOR-002 P2 PLAUSIBLE
    SCOR-002 P2 PLAUSIBLE
  `);

  assert.equal(metadata.hasStructuredFindings, true);
  assert.equal(metadata.findingCount, 2);
  assert.deepEqual(metadata.findingIds, ["SCOR-001", "SCOR-002"]);
  assert.deepEqual(metadata.severities, ["P1", "P2"]);
  assert.equal(metadata.confidence.confirmed, 1);
  assert.equal(metadata.confidence.plausible, 2);
});

test("review prompt includes structured review schema instructions", () => {
  const prompt = buildSystemPrompt("/tmp/workspace", "review", [], { complex: false });

  assert.match(prompt, /Structured review schema/);
  assert.match(prompt, /schema_version/);
  assert.match(prompt, /post_cor_candidate/);
});

test("review report schema validates strong finding invariants", () => {
  const report = [
    "Findings:",
    "```json",
    JSON.stringify({
      schema_version: 1,
      review: {
        target: "current diff",
        base: "HEAD",
        project_context: "Node CLI",
        mode: "deep",
        lanes: ["code"],
      },
      findings: [
        {
          id: "SCOR-001",
          severity: "P1",
          status: "open",
          confidence: "high",
          confidence_score: 90,
          lane: "code",
          scope: "current-diff",
          file: "src/a.js:1",
          finding: "Bug",
          impact: "Breaks user flow.",
          evidence: "src/a.js:1 calls missing value.",
          reliable_solution: "Guard the missing value.",
          solution_fit: "suited=yes; executable=yes; cost=low; verification=unit test",
          verification_status: "proven-by-code",
          post_cor_candidate: true,
        },
      ],
      open_questions: [],
      test_gaps: [],
      residual_risks: [],
    }),
    "```",
  ].join("\n");

  const validation = validateReviewReportText(report);

  assert.equal(validation.ok, true);
  assert.equal(validation.report.findings[0].id, "SCOR-001");
});

test("review report schema rejects low-confidence main findings", () => {
  const report = [
    "```json",
    JSON.stringify({
      schema_version: 1,
      review: {
        target: "current diff",
        base: "HEAD",
        project_context: "Node CLI",
        mode: "deep",
        lanes: ["code"],
      },
      findings: [
        {
          id: "SCOR-001",
          severity: "P2",
          status: "open",
          confidence: "low",
          confidence_score: 60,
          lane: "code",
          scope: "current-diff",
          file: "src/a.js:1",
          finding: "Maybe bug",
          impact: "Unclear.",
          evidence: "Weak.",
          reliable_solution: "Investigate.",
          solution_fit: "conditional",
          verification_status: "not-run",
          post_cor_candidate: false,
        },
      ],
      open_questions: [],
      test_gaps: [],
      residual_risks: [],
    }),
    "```",
  ].join("\n");

  const validation = validateReviewReportText(report);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /below 80/);
});

test("agent repairs invalid review output before returning", async () => {
  const validReport = [
    "No findings.",
    "```json",
    JSON.stringify({
      schema_version: 1,
      review: {
        target: "current project",
        base: "unknown",
        project_context: "Node CLI",
        mode: "quick",
        lanes: ["code"],
      },
      findings: [],
      open_questions: [],
      test_gaps: [],
      residual_risks: [],
    }),
    "```",
  ].join("\n");
  const replies = ["No issues found.", validReport];
  const client = {
    async chatCompletion() {
      return {
        choices: [{ message: { role: "assistant", content: replies.shift() } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const tools = {
    schemas: [],
    async execute() {
      return { ok: false, error: "unexpected tool call" };
    },
  };

  const result = await runAgent({
    client,
    tools,
    task: "review this project",
    cwd: "/tmp/workspace",
    model: "test",
    stream: false,
    finalValidator: createReviewFinalValidator({ maxRepairAttempts: 2 }),
  });

  assert.equal(result.steps, 2);
  assert.equal(result.reviewValidation.ok, true);
  assert.equal(result.reviewReport.findings.length, 0);
});

test("verification state records failure, fix, and rerun pass", () => {
  let state = emptyVerificationState();
  state = advanceVerificationState(state, {
    name: "run_shell",
    args: { command: "npm test" },
    result: { ok: false, stderr: "fail" },
    step: 1,
  });
  state = advanceVerificationState(state, {
    name: "edit_file",
    args: { path: "src/a.js" },
    result: { ok: true },
    step: 2,
  });
  state = advanceVerificationState(state, {
    name: "run_shell",
    args: { command: "npm test" },
    result: { ok: true, stdout: "pass" },
    step: 3,
  });

  assert.equal(state.status, "failed-then-passed");
  assert.equal(state.commands.length, 2);
  assert.deepEqual(state.transitions.map((transition) => transition.to).filter(Boolean), [
    "failed",
    "fixed-pending-rerun",
    "failed-then-passed",
  ]);
});

test("workflow state records planning, tool execution, and completion", () => {
  let workflow = createWorkflowState({ requestType: "edit" });
  workflow = advanceWorkflowState(workflow, { type: "planned" });
  workflow = advanceWorkflowState(workflow, { type: "tool-start", tool: "read_file", step: 1 });
  workflow = advanceWorkflowState(workflow, { type: "tool-start", tool: "edit_file", step: 2 });
  workflow = advanceWorkflowState(workflow, { type: "completed", step: 3 });

  assert.equal(workflow.status, "completed");
  assert.deepEqual(workflow.transitions.map((transition) => transition.to).filter(Boolean), [
    "initialized",
    "planned",
    "researching",
    "implementing",
    "completed",
  ]);
});

test("shell guardrails classify destructive commands as blocked", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-policy-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    allowShellWithoutPrompt: true,
  });

  assert.equal(classifyShellCommand("rm -rf /").level, "block");
  assert.equal(classifyShellCommand("rm -r -f /").level, "block");
  assert.equal(classifyShellCommand("rm --recursive --force /tmp/x").level, "block");
  assert.equal(classifyShellCommand("rm file.txt").level, "warn");
  const result = await runtime.execute("run_shell", { command: "rm -rf /" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "SHELL_COMMAND_BLOCKED");

  const approvedRuntime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("blocked shell command should not prompt");
    },
    approvedShellCommands: ["rm -rf /"],
  });
  const approvedResult = await approvedRuntime.execute("run_shell", { command: "rm -rf /" });

  assert.equal(approvedResult.ok, false);
  assert.equal(approvedResult.code, "SHELL_COMMAND_BLOCKED");
});

test("project index summarizes manifests, scripts, source, and tests", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-project-index-"));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }), "utf8");
  await writeFile(join(workspace, "package-lock.json"), "{}", "utf8");
  await writeFile(join(workspace, "src.js"), "console.log('x')", "utf8");
  await writeFile(join(workspace, "foo.test.js"), "test('x', () => {})", "utf8");

  const index = await buildProjectIndex(workspace);

  assert.equal(index.projectName, "demo");
  assert.equal(index.packageManager, "npm");
  assert.equal(index.scripts.test, "node --test");
  assert.equal(index.testFiles.includes("foo.test.js"), true);
});

test("workspace snapshot includes bounded high-signal project context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-workspace-snapshot-"));
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --test" }, dependencies: { leftpad: "1.0.0" } }),
    "utf8",
  );
  await writeFile(join(workspace, "README.md"), "# Demo\n\nRun tests with npm test.", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "Prefer focused changes.", "utf8");
  await writeFile(join(workspace, ".deecoo.md"), "# Project Instructions\n\n- Run npm test before final answer.", "utf8");
  await writeFile(join(workspace, "index.js"), "console.log('x')", "utf8");

  const snapshot = await buildWorkspaceSnapshot(workspace);
  const messages = await buildWorkspaceSnapshotMessages(workspace);

  assert.equal(snapshot.cwd, workspace);
  assert.equal(snapshot.package.name, "demo");
  assert.equal(snapshot.package.scripts.test, "node --test");
  assert.equal(snapshot.package.dependencies.includes("leftpad"), true);
  assert.match(snapshot.readme.content, /Run tests/);
  assert.equal(snapshot.projectInstructions.primary.path, ".deecoo.md");
  assert.equal(snapshot.projectInstructions.additional[0].path, "AGENTS.md");
  assert.equal(snapshot.tree.lines.includes("index.js"), true);
  assert.match(messages[0].content, /Workspace snapshot/);
  assert.match(messages[0].content, /primary project instructions \(.deecoo.md\)/);
  assert.match(messages[0].content, /git:/);
});

test("workspace snapshot falls back to README when no instruction file exists", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-workspace-instructions-"));
  await writeFile(join(workspace, "README.md"), "# Demo\n\nUse small patches.", "utf8");

  const snapshot = await buildWorkspaceSnapshot(workspace);

  assert.equal(snapshot.projectInstructions.primary.path, "README.md");
  assert.equal(snapshot.projectInstructions.primary.fallback, true);
  assert.match(snapshot.projectInstructions.primary.content, /Use small patches/);
});

test("project description refreshes generated section without removing manual notes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-project-description-"));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "demo", scripts: { check: "node --check index.js" } }), "utf8");
  await writeFile(join(workspace, "README.md"), "# Demo", "utf8");

  const first = await ensureProjectDescription(workspace);
  await writeFile(first.path, "Manual note.\n\n" + first.content, "utf8");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }), "utf8");
  await ensureProjectDescription(workspace);

  const content = await readFile(first.path, "utf8");
  assert.match(content, /Manual note/);
  assert.match(content, /test: `node --test`/);
  assert.doesNotMatch(content, /check: `node --check index.js`/);
});

test("review aggregation removes duplicates and sorts by severity", () => {
  const baseFinding = {
    id: "SCOR-002",
    severity: "P2",
    status: "open",
    confidence: "high",
    confidence_score: 90,
    lane: "code",
    scope: "current-diff",
    file: "src/a.js:1",
    finding: "Duplicate bug",
    impact: "Breaks behavior.",
    evidence: "same path",
    reliable_solution: "Fix it.",
    solution_fit: "suited=yes",
    verification_status: "proven-by-code",
    post_cor_candidate: true,
  };
  const report = aggregateReviewReport({
    schema_version: 1,
    review: { target: "diff", base: "HEAD", project_context: "Node", mode: "deep", lanes: ["code"] },
    findings: [
      baseFinding,
      { ...baseFinding, id: "SCOR-003" },
      { ...baseFinding, id: "SCOR-001", severity: "P1", finding: "More severe bug", evidence: "other path" },
    ],
    open_questions: [],
    test_gaps: [],
    residual_risks: [],
  });

  assert.equal(report.findings.length, 2);
  assert.equal(report.aggregation.duplicateCount, 1);
  assert.equal(report.findings[0].severity, "P1");
});

test("audit log redacts secrets before writing", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "deecoo-audit-"));
  const store = { projectDir };
  const session = { id: "12345678-1234-1234-1234-123456789abc" };
  const audit = await saveRunAudit(store, session, {
    task: "test",
    message: "Authorization: Bearer secret-token",
    env: { DEEPSEEK_API_KEY: "sk-secretsecretsecret" },
  });

  const files = await readdir(join(projectDir, "audit", session.id));
  const content = await readFile(join(projectDir, "audit", session.id, files[0]), "utf8");

  assert.equal(Boolean(audit.path), true);
  assert.match(content, /\[REDACTED\]/);
  assert.doesNotMatch(content, /secret-token|sk-secret/);
});

test("task spec and verification planner produce executable contracts", () => {
  const coordination = analyzeTaskCoordination("fix the bug and run tests");
  const taskSpec = buildTaskSpec({
    task: "fix the bug and run tests",
    cwd: "/tmp/project",
    coordination,
    activeSkills: [{ name: "post-cor" }],
  });
  const plan = buildVerificationPlan({
    taskSpec,
    projectIndex: { scripts: { check: "node --check index.js", test: "node --test" } },
  });

  assert.equal(taskSpec.requestType, "debug");
  assert.equal(taskSpec.constraints.activeSkills.includes("post-cor"), true);
  assert.equal(plan.required, true);
  assert.deepEqual(plan.commands.map((command) => command.command), ["npm run check", "npm test"]);
});

test("context builder keeps higher priority messages within budget", () => {
  const messages = buildContextMessages([
    contextItem({ role: "system", content: "low".repeat(100) }, 1),
    contextItem({ role: "system", content: "important" }, 100),
    contextItem({ role: "system", content: "medium" }, 50),
  ], { budget: 30 });

  assert.deepEqual(messages.map((message) => message.content), ["important", "medium"]);
});

test("project memory records and reloads facts, decisions, and failures", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "deecoo-memory-"));
  const store = { projectDir };

  await recordProjectMemory(store, { projectFact: "Uses npm scripts." });
  await recordProjectMemory(store, { decision: "Prefer focused verification." });
  await recordProjectMemory(store, { failure: "Prior test failed." });
  const memory = await loadProjectMemory(store);

  assert.equal(memory.facts[0].text, "Uses npm scripts.");
  assert.equal(memory.decisions[0].text, "Prefer focused verification.");
  assert.equal(memory.failures[0].text, "Prior test failed.");
});

test("output adapters persist summary and structured outputs", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "deecoo-outputs-"));
  const store = { projectDir };
  const session = { id: "12345678-1234-1234-1234-123456789abc" };
  const outputs = await saveRunOutputs(store, session, {
    task: "review",
    result: {
      finalText: "Done",
      workflow: { status: "completed", phase: "done" },
      verification: { status: "passed", commands: [] },
      reviewReport: { schema_version: 1, findings: [] },
    },
  });

  assert.equal(outputs.length, 3);
  assert.equal(outputs.some((output) => output.fileName.endsWith("review-report.json")), true);
  assert.equal(outputs.some((output) => output.fileName.endsWith("summary.md")), true);
});

test("tool runtime exposes capability metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-tool-capabilities-"));
  const runtime = createToolRuntime({ cwd: workspace, prompter: async () => "approve" });
  const capabilities = runtime.capabilities();

  assert.equal(capabilities.some((tool) => tool.name === "edit_file" && tool.requiresApproval), true);
  assert.equal(capabilities.some((tool) => tool.name === "agent" && tool.category === "orchestration"), true);
});

test("subagent scheduler enforces a per-task worker limit", async () => {
  const client = {
    async chatCompletion() {
      return { choices: [{ message: { role: "assistant", content: "done" } }] };
    },
  };
  const tools = {
    schemas: [],
    async execute() {
      return { ok: false, error: "unexpected" };
    },
  };
  const runtime = createSubagentRuntime({
    client,
    workerTools: tools,
    cwd: "/tmp/project",
    config: { model: "test" },
  });

  for (let i = 0; i < 8; i += 1) {
    const result = await runtime.start({ description: "worker " + i, prompt: "do work" });
    assert.equal(result.ok, true);
  }
  const blocked = await runtime.start({ description: "worker 9", prompt: "do work" });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "WORKER_LIMIT_REACHED");
  assert.equal(runtime.snapshot().length, 8);
});
