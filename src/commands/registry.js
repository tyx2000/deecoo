export const SLASH_COMMANDS = sortSlashCommands([
  { label: "/resume Select previous project conversation", value: "/resume" },
  { label: "/delete Delete previous project conversation", value: "/delete" },
  { label: "/export Export previous project conversation", value: "/export" },
  { label: "/fork   Fork from an answer in this conversation", value: "/fork" },
  { label: "/new    Start a new conversation", value: "/new" },
  { label: "/permissions Select edit permission mode", value: "/permissions" },
  { label: "/skills Load a Codex skill for this session", value: "/skills" },
  { label: "/theme  Select terminal color theme", value: "/theme" },
  { label: "/model  Select active model", value: "/model" },
  { label: "/usage  Show API key balance/usage", value: "/usage" },
  { label: "/help   Show commands", value: "/help" },
  { label: "/exit   Leave Deecoo", value: "/exit" },
]);

export const APP_COMMANDS = new Set(["model", "resume", "delete", "export", "permissions", "skills", "theme", "usage", "help"]);
export const EXIT_SIGNAL = Symbol("exit");

export function isExitCommand(value) {
  const command = String(value ?? "").trim().toLowerCase();
  return command === "/exit" || command === "exit" || command === "quit" || command === "q!";
}

export function printSlashHelp() {
  console.log("Commands:\n" + SLASH_COMMANDS.map((command) => "  " + command.label).join("\n"));
}

function sortSlashCommands(commands) {
  return [...commands].sort((a, b) => {
    if (a.value === "/exit") return 1;
    if (b.value === "/exit") return -1;
    return a.value.localeCompare(b.value);
  });
}

