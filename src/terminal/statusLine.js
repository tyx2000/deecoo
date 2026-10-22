import { paint } from "./theme.js";
import { prefixAtColumn } from "./promptLayout.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let current;

// Pins one status line to the bottom row while a task runs. The rows above it
// become the scroll region, so streamed text and tool logs scroll past without
// overwriting it (the technique apt uses for its progress bar). The region is
// only set up when the caret is at the start of a line, which is tracked by
// observing every write to the stream.
export function createStatusLine({ stream = process.stdout, render, intervalMs = 100 } = {}) {
  const write = stream.write;
  const emit = (text) => write.call(stream, text);
  let timer, rows, frame = 0, paused = 0, atLineStart = true, wanted = false;

  const draw = () => {
    if (rows === undefined) return;
    const text = prefixAtColumn(render(FRAMES[frame++ % FRAMES.length]), Math.max(1, (stream.columns || 80) - 1));
    // Save and restore the caret (and its attributes) around the bottom row.
    emit(`\x1B7\x1B[${rows};1H\x1B[2K${text}\x1B[0m\x1B8`);
  };
  const reserve = () => {
    if (!wanted || paused || rows !== undefined || !atLineStart || !(stream.rows >= 4)) return;
    rows = stream.rows;
    // The newline makes room when the caret is on the last row; setting the
    // region homes the caret, so it is saved and restored around that.
    emit(`\n\x1B7\x1B[1;${rows - 1}r\x1B8\x1B[1A`);
    draw();
  };
  const release = () => {
    if (rows === undefined) return;
    emit(`\x1B7\x1B[r\x1B[${rows};1H\x1B[2K\x1B8`);
    rows = undefined;
  };
  const onResize = () => { release(); reserve(); };
  const onExit = () => release();

  const line = {
    start() {
      if (wanted || !stream.isTTY) return line;
      wanted = true; current = line;
      stream.write = function (chunk, ...rest) {
        const result = write.call(stream, chunk, ...rest);
        const text = String(typeof chunk === "string" ? chunk : chunk?.toString?.() ?? "").replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
        if (text) atLineStart = text.endsWith("\n");
        reserve();
        return result;
      };
      stream.on?.("resize", onResize);
      process.once("exit", onExit);
      timer = setInterval(draw, intervalMs);
      timer.unref?.();
      reserve();
      return line;
    },
    stop() {
      if (!wanted) return;
      wanted = false;
      clearInterval(timer);
      release();
      stream.write = write;
      stream.off?.("resize", onResize);
      process.off("exit", onExit);
      if (current === line) current = undefined;
    },
    // Interactive prompts need the whole screen; the line returns once they finish.
    pause() {
      paused += 1; release();
      let resumed = false;
      return () => { if (resumed) return; resumed = true; paused -= 1; reserve(); };
    },
  };
  return line;
}

export function pauseStatusLine() {
  return current ? current.pause() : () => {};
}

export function formatStatusLine({ frame, phase, elapsedMs, usage = {} }) {
  const tokens = `↑ ${compactCount(usage.promptTokens)} ↓ ${compactCount(usage.completionTokens)} tokens`;
  return `${paint("title", frame)} ${phase} ${paint("muted", `· ${formatDuration(elapsedMs)} · ${tokens} · esc to interrupt`)}`;
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function compactCount(value) {
  const count = Math.max(0, Math.round(Number(value) || 0));
  if (count < 1000) return String(count);
  if (count < 1e6) return `${(count / 1e3).toFixed(count < 1e4 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(count / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}
