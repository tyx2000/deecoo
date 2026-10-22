import { normalizeRequiredChecks } from "../harness/acceptance.js";
export function buildVerificationPlan({ taskSpec, projectIndex }) {
  const scripts = projectIndex?.scripts ?? {};
  const packageManager = projectIndex?.packageManager || "npm";
  const commands = [];
  if (scripts.check) commands.push({ kind: "check", command: scriptCommand(packageManager, "check"), reason: "project defines check script" });
  if (scripts.typecheck) commands.push({ kind: "typecheck", command: scriptCommand(packageManager, "typecheck"), reason: "project defines typecheck script" });
  if (scripts.lint) commands.push({ kind: "lint", command: scriptCommand(packageManager, "lint"), reason: "project defines lint script" });
  if (scripts.test) commands.push({ kind: "unit-test", command: testCommand(packageManager), reason: "project defines test script" });
  if (scripts.build) commands.push({ kind: "build", command: scriptCommand(packageManager, "build"), reason: "project defines build script" });

  const requestType = taskSpec?.requestType ?? "general";
  const required =
    requestType === "edit" ||
    requestType === "debug" ||
    requestType === "command" ||
    /test|check|verify|验证|测试/.test(taskSpec?.goal ?? "");

  let requiredChecks = taskSpec?.requiredChecks ?? taskSpec?.acceptance?.requiredChecks ?? [];
  if (!requiredChecks.length && taskSpec?.acceptance?.requiredChecksSource !== "explicit") {
    const goal = taskSpec?.goal ?? "";
    const asksTests = /(?:run|execute|运行|执行)[^.;。\n]{0,24}(?:tests?|测试)/i.test(goal) && !/(?:do not|don't|不要|无需|不必)\s*(?:run|execute|运行|执行)?[^.;。\n]{0,12}(?:tests?|测试)/i.test(goal);
    const primary = commands.find((item) => item.kind === "unit-test") ?? commands.find((item) => ["check", "typecheck", "lint"].includes(item.kind));
    if (asksTests) requiredChecks = [{ command: testCommand(packageManager), target: "project:tests", purpose: "Execute the requested project tests", source: "project-inferred" }];
    else if (taskSpec?.requiresCodeChange && primary) requiredChecks = [{ ...primary, target: "project:" + primary.kind, purpose: "Verify the scoped implementation", source: "project-inferred" }];
  }
  return {
    schemaVersion: 2,
    requiredChecks: normalizeRequiredChecks(requiredChecks),
    required,
    status: commands.length || requiredChecks.length ? "planned" : "no-known-command",
    commands,
    fallback: commands.length || requiredChecks.length ? "" : "Inspect project docs or package scripts before claiming verification was run.",
  };
}

function testCommand(packageManager) {
  if (packageManager === "npm") return "npm test";
  return `${packageManager} test`;
}

function scriptCommand(packageManager, script) {
  return `${packageManager} run ${script}`;
}

export function verificationPlanMessage(plan) {
  return {
    role: "system",
    content: [
      "Verification plan:",
      JSON.stringify(plan, null, 2),
      "Every requiredChecks item needs fresh successful executor evidence on an allowed execution path. commands are discovery candidates; explain skipped candidates. Missing or failed required checks mean a partial or blocked outcome, never a completed task.",
    ].join("\n"),
  };
}
