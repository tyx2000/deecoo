import {
  appSettingsPath,
  collectSettingsEnv,
  defaultSettingsEnv,
  loadSettingsEnv,
  resetShellApprovals,
  writeProviderSettings,
  writeSettingsEnv,
} from "../config/settings.js";
import { PROVIDER_NAMES, inferProviderFromModel, normalizeProviderName } from "../config/providers.js";

export async function handleConfigCommand(args) {
  const action = args.configAction ?? "help";

  if (args.provider || args.apiKey) {
    if (!args.provider || !args.apiKey) {
      throw new Error("Both -provider and -key are required. Example: deecoo config -provider deepseek -key sk-...");
    }
    const provider = normalizeProviderName(args.provider);
    const modelProvider = inferProviderFromModel(args.model);
    if (modelProvider && modelProvider !== provider) {
      throw new Error(`Model "${args.model}" belongs to provider "${modelProvider}", not "${provider}".`);
    }
    const result = await writeProviderSettings({
      settingsPath: args.settings,
      provider,
      apiKey: args.apiKey,
      model: args.model,
    });
    console.log("Configured provider: " + provider);
    console.log("Model: " + result.config.model);
    console.log("Wrote " + result.path);
    return;
  }

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
    console.log("Configure a provider key before running Deecoo:");
    console.log("deecoo config -provider deepseek -key sk-...");
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
    console.log(JSON.stringify({
      activeProvider: settings.activeProvider,
      providers: redactProviderSecrets(settings.providers),
      env: redactSecrets(settings.env),
      permissions: settings.permissions,
    }, null, 2));
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

function redactProviderSecrets(providers) {
  return Object.fromEntries(
    Object.entries(providers ?? {}).map(([provider, config]) => [provider, { ...config, ...(config.apiKey ? { apiKey: "********" } : {}) }]),
  );
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
    "  deecoo config -provider <" + PROVIDER_NAMES.join("|") + "> -key <api-key>",
    "  deecoo config path",
    "  deecoo config init",
    "  deecoo config import-env",
    "  deecoo config show",
    "  deecoo config reset-shell-approvals",
    "",
    "Config defaults to " + appSettingsPath() + ".",
    "Use --settings <path> to override the settings file or directory.",
    "Optional: add --model <model> when configuring a provider.",
  ].join("\n"));
}
