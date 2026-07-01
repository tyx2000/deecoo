import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { ansi, paint, styleStart } from "./theme.js";

const promptHistory = [];

export async function selectOption({ title, options, selectedIndex = 0, filterable = true }) {
  if (!input.isTTY || !output.isTTY) {
    return options[selectedIndex] ?? options[0];
  }

  let selected = Math.max(0, Math.min(selectedIndex, options.length - 1));
  let query = "";
  let renderedLines = 0;

  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  output.write("\x1B[?25l");

  return await new Promise((resolve) => {
    const filteredOptions = () => {
      const needle = normalize(query);
      if (!needle) return options;
      return options.filter((option) => normalize(option.label).includes(needle));
    };

    const render = () => {
      if (renderedLines > 0) {
        output.write(`\x1B[${renderedLines}A`);
        output.write("\x1B[J");
      }

      const visible = filteredOptions();
      if (selected >= visible.length) selected = Math.max(0, visible.length - 1);

      output.write(paint("title", title));
      if (filterable) {
        output.write(
          query ? `  ${paint("muted", "filter:")} ${highlightQuery(query, query)}` : `  ${paint("muted", "type to filter")}`,
        );
      }
      output.write("\n");

      if (visible.length === 0) {
        output.write(`  ${paint("muted", "No matches")}\n`);
        renderedLines = 2;
        return;
      }

      for (let i = 0; i < visible.length; i += 1) {
        if (i === selected) {
          const selectedStyle = styleStart("selected");
          const label = highlightQuery(visible[i].label, query, { selectedStyle });
          output.write(`${selectedStyle}> ${label}${ansi.reset}\n`);
        } else {
          const label = highlightQuery(visible[i].label, query);
          output.write(`  ${label}\n`);
        }
      }

      const preview = visible[selected]?.preview;
      if (preview) {
        output.write(`\n${preview}\n`);
      }
      renderedLines = visible.length + 1 + (preview ? previewLineCount(preview) + 1 : 0);
    };

    const cleanup = (value) => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      output.write("\x1B[?25h");
      resolve(value);
    };

    const onKeypress = (str, key) => {
      if (key.ctrl && key.name === "c") {
        output.write("\n");
        cleanup(undefined);
        return;
      }
      if (key.name === "up") {
        const visible = filteredOptions();
        if (visible.length === 0) return;
        selected = selected === 0 ? visible.length - 1 : selected - 1;
        render();
        return;
      }
      if (key.name === "down") {
        const visible = filteredOptions();
        if (visible.length === 0) return;
        selected = selected === visible.length - 1 ? 0 : selected + 1;
        render();
        return;
      }
      if (key.name === "return") {
        const visible = filteredOptions();
        if (visible.length === 0) {
          render();
          return;
        }
        output.write("\n");
        cleanup(visible[selected]);
        return;
      }
      if (filterable && key.name === "backspace") {
        query = query.slice(0, -1);
        selected = 0;
        render();
        return;
      }
      if (key.name === "escape") {
        output.write("\n");
        cleanup(undefined);
        return;
      }
      if (filterable && str && !key.ctrl && !key.meta) {
        query += str;
        selected = 0;
        render();
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

export async function readPromptLine(prompt, slashOptions, { history } = {}) {
  if (!input.isTTY || !output.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input, output });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }

  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);

  return await new Promise((resolve) => {
    const activeHistory = Array.isArray(history) ? normalizedHistory(history) : promptHistory;
    let buffer = "";
    let cursorIndex = 0;
    let selected = 0;
    let renderedLines = 0;
    let selectionTouched = false;
    let historyIndex = activeHistory.length;
    let draftBuffer = "";

    const cleanup = (value, { keepLine = false } = {}) => {
      if (!keepLine) clearRendered();
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      resolve(value);
    };

    const slashQuery = () => {
      if (!slashOptions?.length || !buffer.startsWith("/")) return undefined;
      return buffer.slice(1);
    };

    const filteredSlashOptions = () => {
      const query = slashQuery();
      if (query === undefined) return [];
      const needle = normalize(query);
      if (!needle) return slashOptions;
      return slashOptions.filter((option) => normalize(option.label).includes(needle) || normalize(option.value).includes(needle));
    };

    const isBrowsingHistory = () => historyIndex !== activeHistory.length;

    const clearRendered = () => {
      if (renderedLines === 0) return;
      const inputLineIndex = promptInputLines(prompt, "").length - 1;
      if (inputLineIndex > 0) output.write(`\x1B[${inputLineIndex}A`);
      output.write("\r\x1B[J");
      renderedLines = 0;
    };

    const render = () => {
      const visible = filteredSlashOptions();
      if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
      const query = slashQuery();
      const showMenu = query !== undefined && visible.length > 0;
      const baseLines = promptInputLines(prompt, buffer);
      const inputLineIndex = baseLines.length - 1;
      const promptLastLine = String(prompt ?? "").split("\n").at(-1) ?? "";
      const lines = [...baseLines];

      if (showMenu) {
        for (let i = 0; i < visible.length; i += 1) {
          if (i === selected) {
            const selectedStyle = styleStart("selected");
            const label = highlightQuery(visible[i].label, query, { selectedStyle });
            lines.push(`${selectedStyle}> ${label}${ansi.reset}`);
          } else {
            lines.push(`  ${highlightQuery(visible[i].label, query)}`);
          }
        }
      }

      clearRendered();
      output.write(lines.join("\n"));
      renderedLines = lines.length;
      const linesBelowInput = renderedLines - inputLineIndex - 1;
      if (linesBelowInput > 0) output.write(`\x1B[${linesBelowInput}A`);
      moveCursorToColumn(visibleWidth(promptLastLine) + visibleWidth(sliceByCodePoint(buffer, 0, cursorIndex)));
    };

    const onKeypress = async (str, key) => {
      if (key.ctrl && key.name === "c") {
        output.write("\n");
        cleanup("exit");
        return;
      }
      if (key.name === "up" && (buffer === "" || isBrowsingHistory())) {
        if (activeHistory.length === 0) return;
        if (historyIndex === activeHistory.length) draftBuffer = buffer;
        historyIndex = Math.max(0, historyIndex - 1);
        buffer = activeHistory[historyIndex] ?? "";
        cursorIndex = codePointLength(buffer);
        selected = 0;
        selectionTouched = false;
        render();
        return;
      }
      if (key.name === "down" && isBrowsingHistory()) {
        historyIndex = Math.min(activeHistory.length, historyIndex + 1);
        buffer = historyIndex === activeHistory.length ? draftBuffer : activeHistory[historyIndex] ?? "";
        cursorIndex = codePointLength(buffer);
        selected = 0;
        selectionTouched = false;
        render();
        return;
      }
      if (key.name === "up" && slashQuery() !== undefined) {
        const visible = filteredSlashOptions();
        if (visible.length > 0) {
          selected = selected === 0 ? visible.length - 1 : selected - 1;
          selectionTouched = true;
          render();
        }
        return;
      }
      if (key.name === "down" && slashQuery() !== undefined) {
        const visible = filteredSlashOptions();
        if (visible.length > 0) {
          selected = selected === visible.length - 1 ? 0 : selected + 1;
          selectionTouched = true;
          render();
        }
        return;
      }
      if (key.name === "tab" && slashQuery() !== undefined) {
        const visible = filteredSlashOptions();
        if (visible.length > 0) {
          buffer = visible[selected].value;
          cursorIndex = codePointLength(buffer);
          selected = 0;
          selectionTouched = false;
          render();
        }
        return;
      }
      if (key.name === "left") {
        cursorIndex = Math.max(0, cursorIndex - 1);
        render();
        return;
      }
      if (key.name === "right") {
        cursorIndex = Math.min(codePointLength(buffer), cursorIndex + 1);
        render();
        return;
      }
      if (key.name === "home") {
        cursorIndex = 0;
        render();
        return;
      }
      if (key.name === "end") {
        cursorIndex = codePointLength(buffer);
        render();
        return;
      }
      if (key.name === "return") {
        const visible = filteredSlashOptions();
        if (slashQuery() !== undefined && visible.length > 0) {
          const exact = visible.find((option) => option.value === buffer);
          buffer = exact?.value ?? visible[selected]?.value ?? buffer;
          cursorIndex = codePointLength(buffer);
        }
        clearRendered();
        output.write(`${prompt}${buffer}\n`);
        renderedLines = 0;
        rememberPrompt(buffer);
        cleanup(buffer, { keepLine: true });
        return;
      }
      if (key.name === "backspace") {
        if (cursorIndex === 0) return;
        buffer = removeCodePointBefore(buffer, cursorIndex);
        cursorIndex -= 1;
        selected = 0;
        selectionTouched = false;
        historyIndex = activeHistory.length;
        draftBuffer = "";
        render();
        return;
      }
      if (key.name === "escape" && slashQuery() !== undefined) {
        buffer = "";
        cursorIndex = 0;
        selected = 0;
        selectionTouched = false;
        historyIndex = activeHistory.length;
        draftBuffer = "";
        render();
        return;
      }
      if (key.name === "delete") {
        if (cursorIndex >= codePointLength(buffer)) return;
        buffer = removeCodePointAt(buffer, cursorIndex);
        selected = 0;
        selectionTouched = false;
        historyIndex = activeHistory.length;
        draftBuffer = "";
        render();
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        buffer = insertAtCodePoint(buffer, cursorIndex, str);
        cursorIndex += codePointLength(str);
        selected = 0;
        selectionTouched = false;
        historyIndex = activeHistory.length;
        draftBuffer = "";
        render();
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

function rememberPrompt(value) {
  const text = String(value ?? "").trim();
  if (!text) return;
  if (promptHistory[promptHistory.length - 1] === text) return;
  promptHistory.push(text);
  if (promptHistory.length > 200) promptHistory.shift();
}

function normalizedHistory(values) {
  const seen = new Set();
  const items = [];
  for (const value of values ?? []) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
  }
  return items.slice(-200);
}

function previewLineCount(value) {
  return String(value ?? "").split(/\r?\n/).length;
}

function normalize(value) {
  return String(value ?? "").toLowerCase();
}

function visibleWidth(value) {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += charWidth(char.codePointAt(0));
  }
  return width;
}

function charWidth(codePoint) {
  if (codePoint === undefined) return 0;
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningMark(codePoint)) return 0;
  if (isWideCodePoint(codePoint)) return 2;
  return 1;
}

function isCombiningMark(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function moveCursorToColumn(column) {
  output.write("\r");
  if (column > 0) output.write(`\x1B[${column}C`);
}

function codePointLength(value) {
  return [...String(value ?? "")].length;
}

function sliceByCodePoint(value, start, end) {
  return [...String(value ?? "")].slice(start, end).join("");
}

function insertAtCodePoint(value, index, insertion) {
  const chars = [...String(value ?? "")];
  chars.splice(index, 0, ...String(insertion ?? ""));
  return chars.join("");
}

function removeCodePointBefore(value, index) {
  const chars = [...String(value ?? "")];
  chars.splice(index - 1, 1);
  return chars.join("");
}

function removeCodePointAt(value, index) {
  const chars = [...String(value ?? "")];
  chars.splice(index, 1);
  return chars.join("");
}

function promptInputLines(prompt, buffer) {
  const lines = String(prompt ?? "").split("\n");
  const last = lines.length - 1;
  lines[last] = `${lines[last]}${buffer}`;
  return lines;
}

function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, "");
}

function highlightQuery(label, query, { selectedStyle = "" } = {}) {
  if (!query) return label;
  const haystack = normalize(label);
  const needle = normalize(query);
  const index = haystack.indexOf(needle);
  if (index === -1) return label;
  const before = label.slice(0, index);
  const match = label.slice(index, index + query.length);
  const after = label.slice(index + query.length);
  if (selectedStyle) {
    return `${before}${styleStart("match")}${match}${selectedStyle}${after}`;
  }
  return `${before}${paint("match", match)}${after}`;
}
