import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTaskSpec } from "../src/harness/taskSpec.js";
import { canonicalCheckCommand, evaluateTaskAcceptance } from "../src/harness/acceptance.js";
import { buildVerificationPlan } from "../src/verification/planner.js";
import { advanceVerificationState, createVerificationStateMachine, emptyVerificationState, verificationIsFresh } from "../src/verification/state.js";
import { validateTaskFinal } from "../src/harness/finalValidation.js";

function contract(task, options = {}) {
  const taskSpec = buildTaskSpec({ task, ...options });
  const verificationPlan = buildVerificationPlan({ taskSpec });
  return { taskSpec, verificationPlan };
}
function command(state, text, plan, extra = {}) {
  return advanceVerificationState(state, { name: "run_shell", args: { command: text }, result: { effects: { events: [{ type: "command", command: text, revision: state.workspaceRevision + 1, ok: true, ...extra }] } } }, { plan });
}

test("NEXT-002 requested command and every required check need actual matching evidence", () => {
  const one = contract("Run npm test.");
  const wrong = command(emptyVerificationState(), "pwd", one.verificationPlan);
  assert.match(validateTaskFinal({ ...one, verification: wrong, agentState: { commandsRun: ["pwd"] }, finalText: "Ran the command successfully." }).join(), /required check.*missing/);
  const both = contract("Run npm test and npm run check.");
  assert.equal(both.taskSpec.requiredChecks.length, 2);
  let state = command(emptyVerificationState(), "npm run check", both.verificationPlan);
  assert.equal(evaluateTaskAcceptance({ ...both, verification: state }).satisfied, false);
  state = command(state, "npm run test", both.verificationPlan);
  assert.equal(evaluateTaskAcceptance({ ...both, verification: state }).satisfied, true);
  assert.equal(verificationIsFresh(state, both.verificationPlan), true, "consecutive required checks share a validation revision");
  state = command(state, "pwd", both.verificationPlan);
  assert.equal(evaluateTaskAcceptance({ ...both, verification: state }).checks.every((check) => check.status === "stale"), true);
});

test("NEXT-002 explicit targets scopes and equivalent paths override inferred candidates", () => {
  const spec = contract("Run npm test", { requiredChecks: [{ id: "api", target: "API tests", scope: "packages/api", executionPaths: [{ command: "node --test api.test.js" }, { command: "npm test" }] }] });
  assert.deepEqual(spec.taskSpec.requiredChecks.map((check) => check.id), ["api"]);
  let state = command(emptyVerificationState(), "npm test", spec.verificationPlan);
  assert.equal(evaluateTaskAcceptance({ ...spec, verification: state }).satisfied, false, "wrong workspace scope cannot satisfy a scoped target");
  state = command(state, "node --test api.test.js", spec.verificationPlan, { scope: "packages/api" });
  assert.equal(evaluateTaskAcceptance({ ...spec, verification: state }).satisfied, true);
  assert.equal(buildTaskSpec({ task: "Run npm test" }).requiredChecks[0].id, buildTaskSpec({ task: "Please run npm run test." }).requiredChecks[0].id);
  assert.notEqual(canonicalCheckCommand('npm test -- -t "a  b"'), canonicalCheckCommand('npm test -- -t "a b"'));
  for (const command of ["npm test --help", "npm test -- --version", "npm test && pwd", "npm test --ignore-scripts", "cargo test --no-run"]) assert.equal(canonicalCheckCommand(command), undefined);
});

test("NEXT-002 conditional no-change requires complete inspected source plus current proof", () => {
  const spec = contract("Fix src/add.js if needed; if already correct leave it unchanged and run npm test.");
  const verification = command(emptyVerificationState(), "npm test", spec.verificationPlan, { id: "run" });
  const input = { ...spec, verification, agentState: { filesEdited: [], commandsRun: ["npm test"] }, finalText: "src/add.js already adds correctly; no change was needed. npm test passed." };
  assert.ok(validateTaskFinal(input).length, "prose and checks alone do not establish current source state");
  const effects = { revision: 1, events: [{ id: "read", type: "file-read", path: "src/add.js", chars: 43, revision: 0 }, { id: "run", type: "command", command: "npm test", revision: 1 }] };
  assert.equal(validateTaskFinal({ ...input, effects }).length, 0);
  assert.equal(evaluateTaskAcceptance({ ...input, effects }).completionType, "no-change");
  effects.events[0].truncated = true;
  assert.ok(validateTaskFinal({ ...input, effects }).length);
});

test("NEXT-002 source assertions independently prove no-change and failures survive prose", () => {
  const spec = contract("Fix a.js if needed", { acceptance: { targetPaths: ["a.js"], requirements: [{ id: "already-correct", kind: "file-content", path: "a.js", contains: "return a + b" }] } });
  const effects = { revision: 0, events: [{ id: "read", type: "file-read", path: "a.js", chars: 40, revision: 0, content: "export function add(a,b) { return a + b; }" }] };
  assert.equal(evaluateTaskAcceptance({ ...spec, effects }).satisfied, true);
  const failed = command(emptyVerificationState(), "npm test", spec.verificationPlan, { ok: false });
  const result = evaluateTaskAcceptance({ ...spec, effects, verification: failed });
  assert.equal(result.satisfied, false);
  assert.equal(result.completionType, "blocked");
  assert.match(validateTaskFinal({ ...spec, effects, verification: failed, finalText: "No changes needed. Tests not run because dependencies are missing." }).join(), /verification failed/);
});

test("NEXT-002 edit, recovery and explicit partial outcomes never reuse prior revision", () => {
  const spec = contract("Run npm test and npm run check");
  let state = command(emptyVerificationState(), "npm test", spec.verificationPlan, { ok: false });
  assert.equal(state.evidence[0].failureOrigin, "baseline");
  state = advanceVerificationState(state, { name: "edit_file", args: {}, result: { ok: true } }, { plan: spec.verificationPlan });
  state = command(state, "npm test", spec.verificationPlan, { ok: false });
  assert.equal(state.evidence.at(-1).failureOrigin, "pre-existing");
  state = command(state, "npm test", spec.verificationPlan);
  state = command(state, "npm run check", spec.verificationPlan);
  assert.equal(verificationIsFresh(state, spec.verificationPlan), true);
  const restored = createVerificationStateMachine({ ...state, workspaceRevision: state.workspaceRevision + 1, status: "pending" }, { plan: spec.verificationPlan }).snapshot();
  assert.equal(evaluateTaskAcceptance({ ...spec, verification: restored }).satisfied, false);
  assert.equal(evaluateTaskAcceptance({ ...spec, verification: state, completionType: "partial" }).satisfied, false);
});

test("NEXT-002 aliases preserve CLI semantics and no-change assertions cannot be empty", () => {
  assert.notEqual(canonicalCheckCommand("npm install"), canonicalCheckCommand("npm run install"));
  assert.notEqual(canonicalCheckCommand("npm check"), canonicalCheckCommand("npm run check"));
  assert.equal(canonicalCheckCommand("npm test"), canonicalCheckCommand("npm run test"));
  assert.throws(() => contract("Fix a.js", { acceptance: { requirements: [{ kind: "file-content", path: "a.js" }] } }), /Source requirements/);
  const spec = contract("Fix a.js if needed", { acceptance: { noChangeRequiresSourceEvidence: false } });
  assert.equal(evaluateTaskAcceptance(spec).satisfied, false);
});

test("NEXT-002 concrete command arguments stop at request conjunctions", () => {
  const spec = contract("Run node --test test/a.js and npm test -- --runInBand and npm run check.");
  assert.deepEqual(spec.taskSpec.requiredChecks.map((check) => check.executionPaths[0].command), ["node --test test/a.js", "npm test -- --runInBand", "npm run check"]);
});

test("NEXT-002 natural-language test requests and project checks require the intended target", () => {
  const taskSpec = buildTaskSpec({ task: "Run tests and report the result." });
  const verificationPlan = buildVerificationPlan({ taskSpec, projectIndex: { packageManager: "pnpm", scripts: { test: "node --test", check: "tsc" } } });
  const verification = command(emptyVerificationState(), "pnpm run check", verificationPlan);
  assert.equal(evaluateTaskAcceptance({ taskSpec, verificationPlan, verification }).satisfied, false);
  assert.equal(verificationPlan.requiredChecks[0].executionPaths[0].command, "pnpm test");
  const editSpec = buildTaskSpec({ task: "Fix src/value.js" });
  assert.equal(buildVerificationPlan({ taskSpec: editSpec, projectIndex: { scripts: { test: "node --test" } } }).requiredChecks.length, 1);
  const explicit = buildTaskSpec({ task: "Fix src/value.js", requiredChecks: [] });
  assert.equal(buildVerificationPlan({ taskSpec: explicit, projectIndex: { scripts: { test: "node --test" } } }).requiredChecks.length, 0);
});

test("required target equivalence resolves a failure but reusing an ID cannot change its proof", () => {
  const original = contract("Run the suite", { requiredChecks: [{ id: "unit", target: "unit tests", executionPaths: [{ command: "node --test test.js" }, { command: "npm test" }] }] });
  let verification = command(emptyVerificationState(), "node --test test.js", original.verificationPlan, { ok: false });
  verification = command(verification, "npm test", original.verificationPlan);
  assert.equal(evaluateTaskAcceptance({ ...original, verification }).satisfied, true);
  assert.equal(verificationIsFresh(verification, original.verificationPlan), true);
  const changed = contract("Run another suite", { requiredChecks: [{ id: "unit", command: "cargo test", scope: "." }] });
  assert.equal(evaluateTaskAcceptance({ ...changed, verification }).satisfied, false, "check IDs are labels; the command and scope remain authoritative");
  assert.equal(verificationIsFresh(verification, changed.verificationPlan), false);
});

test("uncertain executor mutation is a blocked acceptance outcome", () => {
  const result = evaluateTaskAcceptance({ agentState: { uncertainFiles: ["a.js"] } });
  assert.equal(result.satisfied, false); assert.equal(result.completionType, "blocked"); assert.match(result.errors.join(), /uncertain/);
});
