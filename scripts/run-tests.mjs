#!/usr/bin/env node
// Runs `node --test` with a usable `git` on PATH.
//
// macOS ships /usr/bin/git as an xcrun shim: before doing any work it dlopen()s
// libxcrun from the selected developer directory. Inside a sandbox that hides
// Xcode (Deecoo's own seatbelt profile, or a nested host sandbox) the shim exits
// non-zero with an empty stdout, so `git status` looks like "no changes" and
// every Git-dependent test fails for an environment reason rather than a code
// reason.
//
// This wrapper prefers the first PATH entry whose `git` actually runs. It never
// skips, filters, or weakens a test: the same `node --test` invocation runs, the
// same assertions execute, and the exit code is propagated unchanged. When no
// usable git exists the original PATH is kept so the failure stays visible.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
const usable = (git) => existsSync(git) && spawnSync(git, ["--version"], { stdio: "ignore" }).status === 0;
const candidates = entries.map((entry) => join(entry, "git"));
const chosen = candidates.find(usable);
// The git a plain shell would have used: the first candidate that exists at all.
const shadowed = candidates.find(existsSync);

let env = process.env;
if (chosen && chosen !== shadowed) {
  // Keep the broken toolchain visible instead of silently pretending it works.
  process.stderr.write(`run-tests: ${shadowed ?? "no git on PATH"} is unusable; using ${chosen} for this run\n`);
  const preferred = dirname(chosen);
  env = { ...process.env, PATH: [preferred, ...entries.filter((entry) => entry !== preferred)].join(delimiter) };
}

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("error", (error) => {
  process.stderr.write(`test-runner: failed to start node --test: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
