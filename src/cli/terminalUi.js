import { basename } from "node:path";
import { paint } from "../terminal/theme.js";

export function buildInputPrompt({ config, cwd, branch }) {
  const parts = ["deecoo", config.model, basename(cwd) || cwd];
  if (branch) parts.push(branch);
  const status = parts.join(" >> ");
  if (!process.stdout.isTTY) return status + "\n> ";
  return paint("title", status) + "\n" + paint("prompt", ">") + " ";
}

export function printStartupInfo(entries) {
  const width = Math.max(...entries.map(([label]) => label.length));
  console.log("");
  for (const [label, value] of entries) {
    console.log(paint("title", label.padStart(width) + " : " + value));
  }
  console.log("");
}

export function createTerminalTitleManager() {
  let changed = false;
  return {
    set(title) {
      if (!process.stdout.isTTY) return;
      changed = true;
      writeTerminalTitle(title);
    },
    restore() {
      if (!changed) return;
      writeTerminalTitle("");
    },
  };
}

function writeTerminalTitle(title) {
  process.stdout.write("\x1B]0;" + title + "\x07");
}

export function clearTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
}
