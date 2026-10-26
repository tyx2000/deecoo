import readline from "node:readline";
import { formatToolLine } from "../terminal/markdown.js";

// The first request belongs to the task: await its cooperative cancellation and
// descendant cleanup. A second explicit interrupt bounds that wait, including
// when a provider/plugin ignores AbortSignal. Synchronous JS still must yield.
export function installTaskInterrupt(nonInteractive = false, { forceExitAfterMs = 2500 } = {}) {
  const controller = new AbortController();
  let terminationSignal, forceTimer, disposed = false, reported = false;
  let releaseInput = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(forceTimer);
    process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm);
    releaseInput();
  };
  const onSignal = (name) => {
    terminationSignal ??= name;
    if (!controller.signal.aborted) {
      controller.abort(Object.assign(new Error(`Task interrupted by ${name}.`), { code: "ABORT_ERR" }));
    } else if (!forceTimer) {
      process.stderr.write(`Second interrupt: allowing up to ${forceExitAfterMs}ms for cleanup before forced exit.\n`);
      forceTimer = setTimeout(() => {
        dispose();
        process.exit(name === "SIGTERM" ? 143 : 130);
      }, forceExitAfterMs);
    }
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint); process.on("SIGTERM", onSigterm);

  if (!nonInteractive && process.stdin.isTTY) {
    const wasFlowing = process.stdin.readableFlowing;
    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    const onKeypress = (_str, key = {}) => {
      if (key.ctrl && key.name === "c") { onSigint(); return; }
      if (key.name !== "escape" || controller.signal.aborted) return;
      reported = true;
      controller.abort(Object.assign(new Error("Task interrupted by Esc."), { code: "ABORT_ERR" }));
      process.stdout.write("\n" + formatToolLine("interrupted: Esc") + "\n");
    };
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
    releaseInput = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      if (wasFlowing !== true) process.stdin.pause();
      if (reported) process.stdout.write("\n");
    };
  }
  return { signal: controller.signal, get terminationSignal() { return terminationSignal; }, dispose };
}
