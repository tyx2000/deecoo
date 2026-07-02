import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import { ansi, paint, paintFixed, styleStart } from "./theme.js";

const DIFF_ADD_STYLE = { fg: "#007a24", bg: "#e7f6e9" };
const DIFF_DELETE_STYLE = { fg: "#c91919", bg: "#fdebea" };
const MAX_RENDER_WIDTH = 110;
const BLOCK_GAP = "\n\n";
const markdownParser = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
});

export function renderMarkdown(markdown) {
  const clean = stripPseudoToolMarkup(String(markdown ?? ""));
  return parseMarkdownItBlocks(markdownParser.parse(clean, {}))
    .map((block) => renderBlock(block))
    .filter((value, index, values) => value !== "" || values[index - 1] !== "")
    .join(BLOCK_GAP);
}

export function printAssistantResponse(markdown, footer) {
  const rule = paint("muted", "-".repeat(56));
  console.log(`\n${rule}`);
  console.log(`${paint("title", "Deecoo")}\n`);
  console.log(renderMarkdown(markdown));
  if (footer) {
    console.log(`\n${paint("muted", footer)}`);
  }
  console.log(rule);
}

export function createAssistantStreamPrinter() {
  const rule = paint("muted", "-".repeat(56));
  const renderer = createMarkdownStreamRenderer();
  let started = false;

  return {
    push(chunk) {
      if (!started) {
        console.log(`\n${rule}`);
        console.log(`${paint("title", "Deecoo")}\n`);
        started = true;
      }
      renderer.push(chunk);
    },
    finish(footer) {
      if (!started) return false;
      renderer.flush();
      if (footer) {
        console.log(`\n${paint("muted", footer)}`);
      }
      console.log(rule);
      return true;
    },
  };
}

export function formatToolLine(text) {
  return paint("muted", text);
}

export function formatActionPrompt(text) {
  return paint("action", ` ${text} `);
}

export function formatRunFooter({ elapsedMs, steps, usage, stoppedReason }) {
  const parts = [`time ${formatElapsed(elapsedMs)}`, `steps ${steps ?? 0}`];
  if (usage?.totalTokens || usage?.promptTokens || usage?.completionTokens) {
    parts.push(
      `tokens ${usage.totalTokens ?? 0} (${usage.promptTokens ?? 0} in / ${usage.completionTokens ?? 0} out)`,
    );
  } else {
    parts.push("tokens unavailable");
  }
  if (stoppedReason) parts.push(`status ${stoppedReason}`);
  return parts.join(" | ");
}

export function renderDiff(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => (isDiffLine(line) ? renderDiffLine(line, { targetWidth: getContentWidth() }) : line))
    .join("\n");
}

export function createMarkdownStreamRenderer({ write = (chunk) => process.stdout.write(chunk) } = {}) {
  let buffer = "";
  let printed = false;

  return {
    push(chunk) {
      buffer += String(chunk ?? "");
      const flushable = splitFlushableMarkdown(buffer);
      buffer = flushable.rest;
      if (!flushable.ready) return;
      const rendered = renderMarkdown(flushable.ready);
      if (!rendered) return;
      write(`${printed ? BLOCK_GAP : ""}${rendered}`);
      printed = true;
    },
    flush() {
      if (!buffer) return;
      const rendered = renderMarkdown(buffer);
      if (rendered) write(`${printed ? BLOCK_GAP : ""}${rendered}`);
      buffer = "";
      printed = true;
    },
  };
}

function parseMarkdownItBlocks(tokens) {
  const blocks = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token.type === "heading_open") {
      const inline = tokens[index + 1];
      blocks.push({
        type: "heading",
        level: Number(token.tag?.slice(1)) || 1,
        text: inline?.content ?? "",
      });
      index += 3;
      continue;
    }

    if (token.type === "paragraph_open") {
      const inline = tokens[index + 1];
      blocks.push({ type: "paragraph", text: inline?.content ?? "" });
      index += 3;
      continue;
    }

    if (token.type === "fence" || token.type === "code_block") {
      blocks.push({
        type: "code",
        lang: token.info?.trim().split(/\s+/)[0] ?? "",
        lines: trimFinalEmptyLine(token.content.split(/\r?\n/)),
      });
      index += 1;
      continue;
    }

    if (token.type === "blockquote_open") {
      const closeIndex = findMatchingToken(tokens, index, "blockquote_open", "blockquote_close");
      const innerBlocks = parseMarkdownItBlocks(tokens.slice(index + 1, closeIndex));
      blocks.push({ type: "quoteBlocks", blocks: innerBlocks });
      index = closeIndex + 1;
      continue;
    }

    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const { block, nextIndex } = collectListTokenBlock(tokens, index);
      blocks.push(block);
      index = nextIndex;
      continue;
    }

    if (token.type === "table_open") {
      const { rows, nextIndex } = collectTableTokenRows(tokens, index);
      blocks.push({ type: "table", rows });
      index = nextIndex;
      continue;
    }

    if (token.type === "hr") {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (token.type === "inline" && token.content) {
      blocks.push({ type: "paragraph", text: token.content });
    }
    index += 1;
  }

  return compactBlankBlocks(blocks);
}

function collectListTokenBlock(tokens, startIndex) {
  const open = tokens[startIndex];
  const ordered = open.type === "ordered_list_open";
  const closeType = ordered ? "ordered_list_close" : "bullet_list_close";
  const closeIndex = findMatchingToken(tokens, startIndex, open.type, closeType);
  const startNumber = Number(open.attrGet?.("start") ?? 1);
  const items = [];
  let cursor = startIndex + 1;
  let itemNumber = Number.isFinite(startNumber) ? startNumber : 1;

  while (cursor < closeIndex) {
    if (tokens[cursor].type !== "list_item_open") {
      cursor += 1;
      continue;
    }
    const itemClose = findMatchingToken(tokens, cursor, "list_item_open", "list_item_close");
    const itemTokens = tokens.slice(cursor + 1, itemClose);
    const { text, childBlocks } = parseListItemTokens(itemTokens);
    const task = parseTaskMarker(text);
    items.push({
      ordered,
      number: ordered ? String(itemNumber) : undefined,
      indent: 0,
      text: task?.text ?? text,
      taskChecked: task?.checked,
      childBlocks,
    });
    itemNumber += 1;
    cursor = itemClose + 1;
  }

  return {
    block: { type: "list", items },
    nextIndex: closeIndex + 1,
  };
}

function parseListItemTokens(tokens) {
  if (tokens[0]?.type === "paragraph_open" && tokens[1]?.type === "inline") {
    return {
      text: tokens[1].content ?? "",
      childBlocks: parseMarkdownItBlocks(tokens.slice(3)),
    };
  }
  if (tokens[0]?.type === "inline") {
    return {
      text: tokens[0].content ?? "",
      childBlocks: parseMarkdownItBlocks(tokens.slice(1)),
    };
  }
  return {
    text: "",
    childBlocks: parseMarkdownItBlocks(tokens),
  };
}

function parseTaskMarker(text) {
  const match = String(text ?? "").match(/^\[([ xX])\]\s+(.*)$/);
  if (!match) return undefined;
  return {
    checked: match[1].toLowerCase() === "x",
    text: match[2],
  };
}

function collectTableTokenRows(tokens, startIndex) {
  const closeIndex = findMatchingToken(tokens, startIndex, "table_open", "table_close");
  const rows = [];
  let row = undefined;
  let cursor = startIndex + 1;

  while (cursor < closeIndex) {
    const token = tokens[cursor];
    if (token.type === "tr_open") {
      row = [];
    } else if (token.type === "tr_close") {
      if (row) rows.push(row);
      row = undefined;
    } else if ((token.type === "th_open" || token.type === "td_open") && row) {
      const inline = tokens[cursor + 1];
      row.push({
        text: inline?.type === "inline" ? inline.content : "",
        align: tableCellAlign(token),
      });
    }
    cursor += 1;
  }

  return { rows, nextIndex: closeIndex + 1 };
}

function tableCellAlign(token) {
  const style = token.attrGet?.("style") ?? "";
  if (/text-align\s*:\s*center/i.test(style)) return "center";
  if (/text-align\s*:\s*right/i.test(style)) return "right";
  return "left";
}

function findMatchingToken(tokens, startIndex, openType, closeType) {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    if (tokens[index].type === openType) depth += 1;
    if (tokens[index].type === closeType) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length - 1;
}

function trimFinalEmptyLine(lines) {
  const output = [...lines];
  if (output.at(-1) === "") output.pop();
  return output;
}

function compactBlankBlocks(blocks) {
  const compacted = [];
  for (const block of blocks) {
    if (block.type === "blank" && (compacted.length === 0 || compacted.at(-1)?.type === "blank")) {
      continue;
    }
    compacted.push(block);
  }
  while (compacted.at(-1)?.type === "blank") compacted.pop();
  return compacted;
}

function renderBlock(block) {
  switch (block.type) {
    case "blank":
      return "";
    case "heading":
      return renderHeading(block);
    case "paragraph":
      return renderParagraph(block.text);
    case "quote":
      return renderQuote(block.lines);
    case "quoteBlocks":
      return renderQuoteBlocks(block.blocks);
    case "list":
      return renderList(block.items);
    case "table":
      return renderTable(block.rows);
    case "code":
      return renderCodeBlock(block);
    case "rule":
      return paint("muted", "─".repeat(Math.min(56, getContentWidth())));
    default:
      return "";
  }
}

function renderHeading(block) {
  return wrapRenderedInline(block.text, getContentWidth())
    .map((line) => `${styleStart("heading")}${line}${ansi.reset}`)
    .join("\n");
}

function renderParagraph(text) {
  return wrapRenderedInline(text, getContentWidth()).join("\n");
}

function renderQuote(lines) {
  const contentWidth = Math.max(20, getContentWidth() - 2);
  return lines
    .flatMap((line) => wrapRenderedInline(line, contentWidth))
    .map((line) => `${paint("muted", "│")} ${line}`)
    .join("\n");
}

function renderQuoteBlocks(blocks) {
  const rendered = blocks.map((block) => renderBlock(block)).join("\n");
  return rendered
    .split(/\r?\n/)
    .map((line) => `${paint("muted", "│")} ${line}`)
    .join("\n");
}

function renderList(items) {
  const width = getContentWidth();
  return items
    .flatMap((item) => {
      const marker = item.taskChecked !== undefined ? (item.taskChecked ? "[x]" : "[ ]") : item.ordered ? `${item.number}.` : "-";
      const markerText = item.ordered
        ? `${styleStart("bullet")}${marker}${ansi.reset}`
        : paint("bullet", marker);
      const indent = " ".repeat(displayWidth(marker) + 1 + item.indent);
      const wrapped = wrapRenderedInline(item.text, Math.max(16, width - displayWidth(indent)));
      const lines = wrapped.length === 0 ? [""] : wrapped.map((line, lineIndex) => {
        if (lineIndex === 0) return `${" ".repeat(item.indent)}${markerText} ${line}`;
        return `${indent}${line}`;
      });
      if (item.childBlocks?.length) {
        const childIndent = " ".repeat(displayWidth(marker) + 2 + item.indent);
        const childLines = item.childBlocks
          .map((block) => renderBlock(block))
          .join("\n")
          .split(/\r?\n/)
          .map((line) => `${childIndent}${line}`);
        lines.push(...childLines);
      }
      return lines;
    })
    .join("\n");
}

function renderCodeBlock(block) {
  const lang = String(block.lang ?? "").trim();
  const codeWidth = getContentWidth();
  const header = paint("muted", `┌─ code${lang ? `: ${lang}` : ""}`);
  const body = renderCodeBody(block.lines, lang, codeWidth);
  const footer = paint("muted", "└─");
  return [header, ...body, footer].join("\n");
}

function renderInline(line) {
  return renderInlineMarkdown(line);
}

function wrapRenderedInline(markdown, width) {
  const rendered = renderInlineMarkdown(markdown);
  if (displayWidth(rendered) <= width) return [rendered];
  return wrapAnsiText(rendered, width);
}

function renderInlineMarkdown(markdown) {
  const parsed = markdownParser.parseInline(String(markdown ?? ""), {});
  return renderInlineTokens(parsed[0]?.children ?? []);
}

function renderInlineTokens(tokens) {
  const activeStyles = [];
  const linkStack = [];
  let output = "";

  for (const token of tokens) {
    if (token.type === "text") {
      output += token.content;
    } else if (token.type === "code_inline") {
      output += `${styleStart("inlineCode")}${token.content}${ansi.reset}${styleSequence(activeStyles)}`;
    } else if (token.type === "softbreak") {
      output += " ";
    } else if (token.type === "hardbreak") {
      output += "\n";
    } else if (token.type === "strong_open") {
      activeStyles.push({ type: "strong", code: ansi.bold });
      output += ansi.bold;
    } else if (token.type === "strong_close") {
      output += closeInlineStyle(activeStyles, "strong");
    } else if (token.type === "em_open") {
      activeStyles.push({ type: "em", code: "\x1B[3m" });
      output += "\x1B[3m";
    } else if (token.type === "em_close") {
      output += closeInlineStyle(activeStyles, "em");
    } else if (token.type === "s_open") {
      activeStyles.push({ type: "strike", code: "\x1B[9m" });
      output += "\x1B[9m";
    } else if (token.type === "s_close") {
      output += closeInlineStyle(activeStyles, "strike");
    } else if (token.type === "link_open") {
      linkStack.push(token.attrGet?.("href") ?? "");
    } else if (token.type === "link_close") {
      const href = linkStack.pop();
      if (href) output += ` ${ansi.dim}(${href})${ansi.reset}${styleSequence(activeStyles)}`;
    } else if (token.type === "image") {
      const src = token.attrGet?.("src");
      const alt = token.content || token.attrGet?.("alt") || "image";
      output += src ? `${alt} ${ansi.dim}(${src})${ansi.reset}${styleSequence(activeStyles)}` : alt;
    } else if (token.children?.length) {
      output += renderInlineTokens(token.children);
    } else if (token.content) {
      output += token.content;
    }
  }

  if (activeStyles.length > 0) output += ansi.reset;
  return output;
}

function closeInlineStyle(activeStyles, type) {
  const index = activeStyles.findLastIndex((style) => style.type === type);
  if (index !== -1) activeStyles.splice(index, 1);
  return `${ansi.reset}${styleSequence(activeStyles)}`;
}

function styleSequence(activeStyles) {
  return activeStyles.map((style) => style.code).join("");
}

function renderCodeBody(lines, codeLang, targetWidth = getContentWidth()) {
  const lang = String(codeLang ?? "").toLowerCase();
  if (lang === "diff" || lines.some((line) => isDiffLine(line))) {
    return lines.map((line) => renderCodeLine(line, lang, targetWidth));
  }
  const highlighted = highlightCode(lines.join("\n"), lang);
  return highlighted.split(/\r?\n/).map((line) => `${paint("muted", "│")} ${line}`);
}

function renderCodeLine(line, codeLang, targetWidth = getContentWidth()) {
  const lang = String(codeLang ?? "").toLowerCase();
  if (lang === "diff" || isDiffLine(line)) {
    return renderDiffLine(line, {
      prefix: paint("muted", "│ "),
      targetWidth: Math.max(20, targetWidth - 2),
    });
  }
  return `${paint("muted", "│")} ${syntaxHighlightCode(line)}`;
}

function highlightCode(code, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return highlightHtmlToAnsi(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
    }
    return highlightHtmlToAnsi(hljs.highlightAuto(code).value);
  } catch {
    return code.split(/\r?\n/).map((line) => syntaxHighlightCode(line)).join("\n");
  }
}

function highlightHtmlToAnsi(html) {
  return decodeHtmlEntities(String(html ?? "")
    .replace(/<span class="([^"]+)">/g, (_, className) => styleForHighlightClass(className))
    .replace(/<\/span>/g, ansi.reset)
    .replace(/<[^>]+>/g, ""));
}

function styleForHighlightClass(className) {
  if (/\bhljs-(keyword|selector-tag|built_in|type|meta|name)\b/.test(className)) {
    return styleStart("keyword");
  }
  if (/\bhljs-(string|regexp|template-string|symbol|subst)\b/.test(className)) {
    return styleStart("string");
  }
  if (/\bhljs-(number|literal|variable|attr|attribute)\b/.test(className)) {
    return styleStart("literal");
  }
  if (/\bhljs-(comment|quote|doctag)\b/.test(className)) {
    return styleStart("muted");
  }
  if (/\bhljs-(title|section|function|class)\b/.test(className)) {
    return styleStart("heading");
  }
  return "";
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function syntaxHighlightCode(line) {
  return String(line)
    .replace(/\b(const|let|var|function|return|if|else|for|while|async|await|import|export|from|class|new|try|catch|throw)\b/g, `${styleStart("keyword")}$1${ansi.reset}`)
    .replace(/(".*?"|'.*?'|`.*?`)/g, `${styleStart("string")}$1${ansi.reset}`)
    .replace(/\b(true|false|null|undefined)\b/g, `${styleStart("literal")}$1${ansi.reset}`);
}

function isDiffLine(line) {
  return /^(\+\+\+|---|@@|diff --git|\+[^+]|-[^-])/.test(line);
}

function renderDiffLine(line, { prefix = "", targetWidth } = {}) {
  const padded = padToWidth(line, targetWidth ?? diffTargetWidth(prefix));
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return `${prefix}${paintFixed(DIFF_ADD_STYLE, padded)}`;
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return `${prefix}${paintFixed(DIFF_DELETE_STYLE, padded)}`;
  }
  if (line.startsWith("@@")) {
    return `${prefix}${paint("heading", line)}`;
  }
  if (line.startsWith("diff --git")) {
    return `${prefix}${ansi.bold}${line}${ansi.reset}`;
  }
  if (line.startsWith("+++") || line.startsWith("---")) {
    return `${prefix}${paint("muted", line)}`;
  }
  return `${prefix}${line}`;
}

function diffTargetWidth(prefix) {
  return Math.max(20, getContentWidth() - displayWidth(prefix));
}

function renderTable(rows) {
  if (rows.length === 0) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const naturalWidths = Array.from({ length: columnCount }, (_, column) => {
    return Math.max(...rows.map((row) => displayWidth(renderInline(tableCellText(row[column])))));
  });
  const widths = fitTableColumnWidths(naturalWidths, getTableContentWidth());
  const aligns = tableColumnAligns(rows, columnCount);

  const border = (left, middle, right, fill) => {
    return `${left}${widths.map((width) => fill.repeat(width + 2)).join(middle)}${right}`;
  };
  const rowLines = (row) => {
    const wrappedCells = widths.map((width, column) => wrapTableCell(tableCellText(row[column]), width));
    const height = Math.max(...wrappedCells.map((cell) => cell.length));
    const lines = [];
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
      const cells = widths.map((width, column) => {
        const cell = renderInline(wrappedCells[column][rowIndex] ?? "");
        return ` ${padCell(cell, width, aligns[column])} `;
      });
      lines.push(`│${cells.join("│")}│`);
    }
    return lines;
  };

  const output = [border("┌", "┬", "┐", "─"), ...rowLines(rows[0]).map((line) => paint("heading", line))];
  const bodyRows = rows.slice(1);
  if (bodyRows.length > 0) output.push(border("├", "┼", "┤", "─"));
  for (let index = 0; index < bodyRows.length; index += 1) {
    const row = bodyRows[index];
    output.push(...rowLines(row));
    if (index < bodyRows.length - 1) output.push(border("├", "┼", "┤", "─"));
  }
  output.push(border("└", "┴", "┘", "─"));
  return output.join("\n");
}

function tableCellText(cell) {
  if (cell && typeof cell === "object") return String(cell.text ?? "");
  return String(cell ?? "");
}

function tableColumnAligns(rows, columnCount) {
  return Array.from({ length: columnCount }, (_, column) => {
    for (const row of rows) {
      const cell = row[column];
      if (cell && typeof cell === "object" && cell.align) return cell.align;
    }
    return "left";
  });
}

function padCell(text, width, align) {
  const value = String(text ?? "");
  const padding = Math.max(0, width - displayWidth(value));
  if (align === "right") return `${" ".repeat(padding)}${value}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(padding - left)}`;
  }
  return `${value}${" ".repeat(padding)}`;
}

function stripPseudoToolMarkup(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (
    lines.some((line) => {
      return /\bDSML\b/.test(line) || /<\|?\s*\|?\s*(tool_calls|invoke|parameter)\b/i.test(line);
    })
  ) {
    return "The model returned internal tool-call markup instead of a readable final answer. Deecoo hid that raw markup.";
  }
  return markdown;
}

function padToWidth(text, width) {
  const value = String(text ?? "");
  const padding = Math.max(0, width - displayWidth(value));
  return `${value}${" ".repeat(padding || (value ? 0 : 1))}`;
}

function getContentWidth() {
  const columns = process.stdout.columns;
  if (!Number.isFinite(columns) || columns <= 0) return 88;
  return Math.max(40, Math.min(MAX_RENDER_WIDTH, columns - 2));
}

function getTableContentWidth() {
  const columns = process.stdout.columns;
  if (!Number.isFinite(columns) || columns <= 0) return 120;
  return Math.max(40, columns - 2);
}

function fitTableColumnWidths(naturalWidths, tableWidth) {
  const columnCount = naturalWidths.length;
  const borderWidth = columnCount * 3 + 1;
  const available = Math.max(columnCount * 3, tableWidth - borderWidth);
  if (sum(naturalWidths) <= available) return naturalWidths;

  const widths = [...naturalWidths];
  const minWidths = naturalWidths.map((width) => Math.min(width, Math.max(3, Math.floor(available / columnCount / 2))));

  while (sum(widths) > available) {
    let widest = -1;
    let reducible = 0;
    for (let index = 0; index < widths.length; index += 1) {
      const extra = widths[index] - minWidths[index];
      if (extra > reducible) {
        reducible = extra;
        widest = index;
      }
    }
    if (widest === -1) break;
    widths[widest] -= 1;
  }

  while (sum(widths) > available) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 1) break;
    widths[widest] -= 1;
  }

  return widths.map((width) => Math.max(1, width));
}

function wrapTableCell(cell, width) {
  const text = String(cell ?? "").trim();
  if (!text) return [""];
  if (displayWidth(renderInline(text)) <= width) return [text];
  return wrapPlainText(inlinePlainText(text), width);
}

function wrapAnsiText(text, width) {
  const tokens = tokenizeAnsiText(text);
  const lines = [];
  let line = [];
  let lineWidth = 0;
  let lastBreakIndex = -1;

  for (const token of tokens) {
    line.push(token.value);
    lineWidth += token.width;
    if (token.breakable) lastBreakIndex = line.length - 1;

    if (lineWidth <= width || line.length === 1) continue;

    if (lastBreakIndex >= 0) {
      const head = trimAnsiLineEnd(line.slice(0, lastBreakIndex));
      if (head.length > 0) lines.push(head.join(""));
      line = trimAnsiLineStart(line.slice(lastBreakIndex + 1));
    } else {
      const overflow = line.pop();
      const head = trimAnsiLineEnd(line);
      if (head.length > 0) lines.push(head.join(""));
      line = overflow ? [overflow] : [];
    }

    lineWidth = displayWidth(line.join(""));
    lastBreakIndex = findLastBreakableTokenIndex(line);
  }

  const tail = trimAnsiLineEnd(line);
  if (tail.length > 0) lines.push(tail.join(""));
  return lines.length > 0 ? lines : [""];
}

function tokenizeAnsiText(text) {
  const value = String(text ?? "");
  const tokens = [];
  let index = 0;
  while (index < value.length) {
    const ansiMatch = readAnsiSequence(value, index);
    if (ansiMatch) {
      tokens.push({ value: ansiMatch, width: 0, breakable: false });
      index += ansiMatch.length;
      continue;
    }

    const codePoint = value.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    tokens.push({
      value: char,
      width: charWidth(codePoint),
      breakable: /\s/u.test(char),
    });
    index += char.length;
  }
  return tokens;
}

function readAnsiSequence(value, index) {
  if (value.charCodeAt(index) !== 0x1b) return "";
  const csi = value.slice(index).match(/^\x1B\[[0-?]*[ -/]*[@-~]/);
  if (csi) return csi[0];
  const osc = value.slice(index).match(/^\x1B\][^\x07]*(?:\x07|\x1B\\)/);
  if (osc) return osc[0];
  const twoByte = value.slice(index).match(/^\x1B[@-_][0-?]*[ -/]*[@-~]/);
  return twoByte?.[0] ?? "";
}

function trimAnsiLineStart(tokens) {
  let index = 0;
  while (index < tokens.length && displayWidth(tokens[index]) > 0 && /^\s$/u.test(stripAnsi(tokens[index]))) {
    index += 1;
  }
  return tokens.slice(index);
}

function trimAnsiLineEnd(tokens) {
  let index = tokens.length - 1;
  while (index >= 0 && displayWidth(tokens[index]) > 0 && /^\s$/u.test(stripAnsi(tokens[index]))) {
    index -= 1;
  }
  return tokens.slice(0, index + 1);
}

function findLastBreakableTokenIndex(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (displayWidth(tokens[index]) > 0 && /^\s$/u.test(stripAnsi(tokens[index]))) return index;
  }
  return -1;
}

function inlinePlainText(markdown) {
  const parsed = markdownParser.parseInline(String(markdown ?? ""), {});
  return collectInlinePlainText(parsed[0]?.children ?? []);
}

function collectInlinePlainText(tokens) {
  let output = "";
  for (const token of tokens) {
    if (token.type === "text" || token.type === "code_inline") {
      output += token.content;
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      output += " ";
    } else if (token.type === "image") {
      output += token.content || token.attrGet?.("alt") || "image";
    } else if (token.children?.length) {
      output += collectInlinePlainText(token.children);
    } else if (token.content) {
      output += token.content;
    }
  }
  return output;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function wrapPlainText(text, width) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [""];
  const output = [];
  let current = "";
  for (const word of normalized.split(/\s+/)) {
    if (!current) {
      current = word;
      continue;
    }
    if (displayWidth(`${current} ${word}`) <= width) {
      current = `${current} ${word}`;
      continue;
    }
    output.push(current);
    current = word;
  }
  if (current) output.push(current);
  return output.flatMap((line) => hardWrapLongLine(line, width));
}

function hardWrapLongLine(line, width) {
  if (displayWidth(line) <= width) return [line];
  const output = [];
  let current = "";
  for (const char of line) {
    if (displayWidth(current + char) > width && current) {
      output.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) output.push(current);
  return output;
}

function splitFlushableMarkdown(markdown) {
  const text = String(markdown ?? "");
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let flushLine = -1;

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (/^```+/.test(lines[index])) inFence = !inFence;
    if (!inFence && lines[index].trim() === "") {
      flushLine = index;
    }
  }

  if (flushLine === -1) {
    return { ready: "", rest: text };
  }

  const ready = lines.slice(0, flushLine + 1).join("\n");
  const rest = lines.slice(flushLine + 1).join("\n");
  return { ready, rest };
}

function displayWidth(value) {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += charWidth(char.codePointAt(0));
  }
  return width;
}

function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, "");
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

function formatElapsed(ms) {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
