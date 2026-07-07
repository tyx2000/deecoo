export function buildVerificationPlan({ taskSpec, projectIndex }) {
  const scripts = projectIndex?.scripts ?? {};
  const commands = [];
  if (scripts.check) commands.push({ kind: "check", command: "npm run check", reason: "project defines check script" });
  if (scripts.typecheck) commands.push({ kind: "typecheck", command: "npm run typecheck", reason: "project defines typecheck script" });
  if (scripts.lint) commands.push({ kind: "lint", command: "npm run lint", reason: "project defines lint script" });
  if (scripts.test) commands.push({ kind: "unit-test", command: "npm test", reason: "project defines test script" });

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
