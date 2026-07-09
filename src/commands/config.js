import {
  appSettingsPath,
  collectSettingsEnv,
  defaultSettingsEnv,
  loadSettingsEnv,
  resetShellApprovals,
  writeSettingsEnv,
} from "../config/settings.js";

export async function handleConfigCommand(args) {
  const action = args.configAction ?? "help";

  if (action === "path") {
    const settings = await loadSettingsEnv({ settingsPath: args.settings });
    console.log(settings.path);
    return;
  }

  if (action === "init") {
    const importedEnv = collectSettingsEnv(process.env);
    const result = await writeSettingsEnv({
      settingsPath: args.settings,
      env: {
        ...defaultSettingsEnv(),
        ...importedEnv,
      },
    });
    console.log("Wrote " + result.path);
    console.log("Set DEEPSEEK_API_KEY before running Deecoo if it was not already imported.");
    return;
  }

  if (action === "import-env") {
    const importedEnv = collectSettingsEnv(process.env);
    if (Object.keys(importedEnv).length === 0) {
      throw new Error("No supported environment variables found to import.");
    }

    const result = await writeSettingsEnv({ settingsPath: args.settings, env: importedEnv });
    console.log("Wrote " + result.path);
    console.log("Imported: " + Object.keys(importedEnv).sort().join(", "));
    return;
  }

  if (action === "show") {
    const settings = await loadSettingsEnv({ settingsPath: args.settings });
    console.log(JSON.stringify(redactSecrets(settings.env), null, 2));
    return;
  }

  if (action === "reset-shell-approvals") {
    const result = await resetShellApprovals({ settingsPath: args.settings });
    console.log("Cleared shell approvals in " + result.path);
    console.log("Both per-command approvals and \"Always Approve All Commands\" are reset; future shell prompts will ask again.");
    return;
  }

  printConfigHelp();
}

function redactSecrets(env) {
  const redacted = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = isSecretKey(key) ? "********" : value;
  }
  return redacted;
}

function isSecretKey(key) {
  return (
    /(^|_)API_KEY$/i.test(key) ||
    /(^|_)SECRET(_|$)/i.test(key) ||
    /(^|_)PASSWORD$/i.test(key) ||
    /(^|_)(ACCESS|REFRESH)_TOKEN$/i.test(key)
  );
}

function printConfigHelp() {
  console.log([
    "Usage:",
    "  deecoo config path",
    "  deecoo config init",
    "  deecoo config import-env",
    "  deecoo config show",
    "  deecoo config reset-shell-approvals",
    "",
    "Config defaults to " + appSettingsPath() + ".",
    "Use --settings <path> to override the settings file or directory.",
  ].join("\n"));
}

