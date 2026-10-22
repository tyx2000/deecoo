import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { createContextFileAccess } from "./fileAccess.js";
import { isExcludedWorkspacePath, isSensitivePath } from "../tools/pathPolicy.js";

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|h|hpp|swift|rb|php|cs)$/i;
const DEFINITIONS = [
  { kind: "function", pattern: /\b(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g },
  { kind: "type", pattern: /\b(?:class|interface|enum|struct|trait|type)\s+([A-Za-z_$][\w$]*)/g },
  { kind: "variable", pattern: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g },
  { kind: "function", pattern: /\b(?:def|fn|func)\s+([A-Za-z_$][\w$]*)/g },
];

// A bounded lexical navigator. Results identify exact source/hash/line and state
// their heuristic nature; ambiguous names are returned rather than guessed.
export async function createCodeNavigator(cwd, { maxFiles = 2000, maxFileBytes = 2 * 1024 * 1024 } = {}) {
  const access = await createContextFileAccess(cwd);
  const cache = new Map();
  const metrics = { scans: 0, filesRead: 0, cacheHits: 0, cacheMisses: 0, invalidations: 0, bytesRead: 0, preparationMs: 0 };
  async function scan(directory = ".") {
    const started = performance.now();
    const candidates = [];
    let truncated = false;
    async function walk(path, depth) {
      if (depth > 16 || candidates.length >= maxFiles) { truncated = true; return; }
      const entries = await access.readDirectory(path);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = (path === "." ? "" : path + "/") + entry.name;
        if (isExcludedWorkspacePath(child) || isSensitivePath(child) || child.split("/").includes(".deecoo")) continue;
        if (entry.isDirectory()) await walk(child, depth + 1);
        else if (entry.isFile() && SOURCE.test(child)) {
          if (candidates.length >= maxFiles) { truncated = true; break; }
          candidates.push(child);
        }
      }
    }
    // readDirectory enforces the workspace/symlink/sensitive-path boundary first.
    await walk(directory, 0);
    const records = [];
    const seen = new Set();
    for (const path of candidates) {
      let text;
      try { text = await access.readText(path); } catch (error) { if (["ENOENT", "EACCES"].includes(error.code)) continue; throw error; }
      const bytes = Buffer.byteLength(text, "utf8");
      metrics.filesRead += 1; metrics.bytesRead += bytes; seen.add(path);
      if (bytes > maxFileBytes || text.includes("\0")) { truncated = true; continue; }
      const hash = createHash("sha256").update(text).digest("hex");
      const prior = cache.get(path);
      if (prior?.contentHash === hash) { metrics.cacheHits += 1; records.push(prior); continue; }
      if (prior) metrics.invalidations += 1;
      metrics.cacheMisses += 1;
      const record = { path, text, contentHash: hash, version: hash, symbols: extractSymbols(text, path, hash) };
      cache.set(path, record); records.push(record);
    }
    const prefix = directory === "." ? "" : directory.replace(/\/$/, "") + "/";
    for (const path of cache.keys()) if (path.startsWith(prefix) && !seen.has(path)) { cache.delete(path); metrics.invalidations += 1; }
    metrics.scans += 1; metrics.preparationMs += performance.now() - started;
    return { records, truncated };
  }
  return {
    async symbols({ query = "", directory = ".", maxResults = 100 } = {}) {
      const { records, truncated } = await scan(normalizeDirectory(cwd, directory));
      const limit = normalizeLimit(maxResults);
      const all = records.flatMap((file) => file.symbols).filter((symbol) => symbol.name.toLowerCase().includes(String(query).toLowerCase()));
      return { ok: true, navigationMode: "lexical-not-language-server", symbols: all.slice(0, limit), truncated: truncated || all.length > limit, metrics: { ...metrics } };
    },
    async references({ symbol, directory = ".", maxResults = 100, includeDeclarations = true } = {}) {
      if (!/^[A-Za-z_$][\w$]*$/.test(String(symbol ?? ""))) return { ok: false, error: "symbol must be a source identifier", code: "INVALID_SYMBOL" };
      const { records, truncated } = await scan(normalizeDirectory(cwd, directory));
      const all = [];
      for (const file of records) {
        const expression = new RegExp("(?<![A-Za-z0-9_$])" + String(symbol).replaceAll("$", "\\$") + "(?![A-Za-z0-9_$])", "g");
        for (const match of file.text.matchAll(expression)) {
          const line = file.text.slice(0, match.index).split("\n").length;
          const declaration = file.symbols.some((item) => item.name === symbol && item.line === line);
          if (!includeDeclarations && declaration) continue;
          all.push({ path: file.path, name: symbol, line, column: match.index - file.text.lastIndexOf("\n", match.index - 1), declaration,
            contentHash: file.contentHash, version: file.version, confidence: "lexical", preview: file.text.split(/\r?\n/)[line - 1].slice(0, 300) });
        }
      }
      const limit = normalizeLimit(maxResults);
      return { ok: true, navigationMode: "lexical-not-language-server", references: all.slice(0, limit), truncated: truncated || all.length > limit, metrics: { ...metrics } };
    },
    metrics() { return { ...metrics }; },
    clear() { metrics.invalidations += cache.size; cache.clear(); },
  };
}

export async function findWorkspaceSymbols(workspace, _getRealWorkspace, args, permissionState = {}) {
  permissionState.codeNavigator ??= createCodeNavigator(workspace);
  return (await permissionState.codeNavigator).symbols(args);
}
export async function findWorkspaceReferences(workspace, _getRealWorkspace, args, permissionState = {}) {
  permissionState.codeNavigator ??= createCodeNavigator(workspace);
  return (await permissionState.codeNavigator).references(args);
}
function extractSymbols(text, path, contentHash) {
  const symbols = [];
  for (const { kind, pattern } of DEFINITIONS) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index + match[0].lastIndexOf(match[1]);
      symbols.push({ name: match[1], kind, path, line: text.slice(0, index).split("\n").length,
        column: index - text.lastIndexOf("\n", index - 1), contentHash, version: contentHash, confidence: "lexical" });
    }
  }
  return symbols.sort((a, b) => a.line - b.line || a.column - b.column);
}
function normalizeDirectory(cwd, directory) { return relative(resolve(cwd), resolve(cwd, directory)) || "."; }
function normalizeLimit(value) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error("maxResults must be a positive integer"); return Math.min(number, 500); }
