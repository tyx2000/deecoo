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

  return {
    schemaVersion: 1,
    required,
    status: commands.length ? "planned" : "no-known-command",
    commands,
    fallback: commands.length ? "" : "Inspect project docs or package scripts before claiming verification was run.",
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
      "Use this to choose affordable validation commands. If you skip a planned command, explain why.",
    ].join("\n"),
  };
}
