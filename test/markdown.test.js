import assert from "node:assert/strict";
import { test } from "node:test";
import { displayWidth, renderMarkdown } from "../src/terminal/markdown.js";

const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

function visible(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

test("markdown tables align when cells contain emoji", () => {
  const previousColumns = process.stdout.columns;
  process.stdout.columns = 140;
  try {
    const rendered = renderMarkdown([
      "| Feature | Lines | Verdict |",
      "| --- | --- | --- |",
      "| Chunk upload / merge / check / delete | ~200 per backend | ✅ Core purpose |",
      "| File size threshold routing | ~20 | ✅ Reasonable UX |",
      "| Filename / uploadId sanitization | ~20 | ✅ Basic security |",
      "| Static file serving | ~40 | ✅ Needed for frontend |",
    ].join("\n"));
    const tableLines = visible(rendered).split(/\r?\n/).filter((line) => line.startsWith("│") || line.startsWith("┌") || line.startsWith("├") || line.startsWith("└"));
    const widths = tableLines.map((line) => displayWidth(line));

    assert.equal(displayWidth("✅"), 2);
    assert.equal(new Set(widths).size, 1);
  } finally {
    process.stdout.columns = previousColumns;
  }
});
