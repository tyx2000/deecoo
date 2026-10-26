import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { GENERATED_PATH_SEGMENTS, TEST_FILE_NAME_PATTERN, TEST_PATH_SEGMENTS, taskWritePathViolation } from "../permissions/taskPolicy.js";

const MAX_SCANNED_PATHS = 100_000;
const error = (code, message) => Object.assign(new Error(message), { code });
const literalRegex = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
// Seatbelt's regex dialect does not need flag extensions when case folding is
// represented with ASCII character classes. This also protects case aliases on
// the default macOS filesystem.
const foldedLiteral = (value) => [...value].map((char) => /[A-Za-z]/.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]`
  // Seatbelt regex literals cannot safely embed quotes with Scheme/JSON
  // escaping. Widen this one character rather than emit executable profile text.
  : char === '"' ? "[^/]" : literalRegex(char)).join("");

export async function compileWriteRestrictions(workspace, restrictions, { signal, maxPaths = MAX_SCANNED_PATHS } = {}) {
  if (!Array.isArray(restrictions)) throw error("TASK_SCOPED_RESTRICTIONS_INVALID", "Write restrictions must be an array.");
  const root = await realpath(workspace);
  if (/[\x00-\x1f\x7f]/.test(root)) throw error("TASK_SCOPED_UNSUPPORTED_PATH", "Control characters in a scoped workspace path cannot be represented safely.");
  const policy = { writeRestrictions: structuredClone(restrictions) };
  const explicit = [];
  for (const rule of policy.writeRestrictions) {
    if (!["tests", "generated", "path"].includes(rule?.kind) || rule.kind === "path" && (typeof rule.path !== "string" || !rule.path || /[\x00-\x1f\x7f]/.test(rule.path))) throw error("TASK_SCOPED_RESTRICTIONS_INVALID", "Unsupported task write restriction.");
    if (rule.kind !== "path") continue;
    const path = resolve(root, rule.path.replaceAll("\\", "/"));
    assertInside(root, path);
    rule.path = relative(root, path) || ".";
    explicit.push(path);
    const canonical = await canonicalTarget(path);
    assertInside(root, canonical);
    explicit.push(canonical);
  }
  const entries = [];
  const protectedAliases = new Set();
  const queue = [root];
  while (queue.length) {
    checkAborted(signal);
    const directory = queue.pop();
    let names;
    try { names = await readdir(directory); }
    catch (cause) { throw error("TASK_SCOPED_SCAN_FAILED", `Cannot inspect scoped write safety for ${relative(root, directory) || "."}: ${cause.message}`); }
    for (const name of names) {
      checkAborted(signal);
      const path = join(directory, name);
      if (entries.length >= maxPaths) throw error("TASK_SCOPED_SCAN_LIMIT", `Scoped write safety inspection exceeds ${maxPaths} paths; no command was started.`);
      let info;
      try { info = await lstat(path); }
      catch (cause) { throw error("TASK_SCOPED_SCAN_FAILED", `Workspace changed during scoped safety inspection: ${cause.message}`); }
      entries.push({ path, info });
      if (info.isDirectory()) queue.push(path);
      else if (info.isSymbolicLink() && taskWritePathViolation(path, policy, { workspace: root })) {
        let target;
        try { target = await realpath(path); }
        catch (cause) { throw error("TASK_SCOPED_SCAN_FAILED", `Cannot resolve protected symbolic link ${relative(root, path)}: ${cause.message}`); }
        assertInside(root, target);
        protectedAliases.add(target);
      }
    }
  }
  // A path-based sandbox cannot distinguish existing hardlink aliases. Refuse
  // to launch rather than pretend the alias's unrelated name is safe to write.
  const ancestors = new Set([root]);
  const protectedPaths = [];
  const aliases = [...protectedAliases];
  for (const { path, info } of entries) {
    const protectedPath = taskWritePathViolation(path, policy, { workspace: root }) || [...aliases, ...explicit].some((target) => pathWithin(target, path));
    if (!protectedPath) continue;
    protectedPaths.push(path);
    if (info.isFile() && info.nlink > 1) throw error("TASK_SCOPED_HARDLINK_UNSAFE", `Protected file has hardlink aliases: ${relative(root, path)}. Remove the aliases before running scoped shell commands.`);
    let ancestor = info.isDirectory() ? path : dirname(path);
    while (pathWithin(root, ancestor)) {
      ancestors.add(ancestor);
      if (ancestor === root) break;
      ancestor = dirname(ancestor);
    }
  }
  // An explicit path may not exist yet. Preserve existing ancestors so a command
  // cannot rename an ordinary parent and create the protected relative file at
  // a new spelling before the next command's scan.
  for (const target of [...explicit, ...aliases]) {
    let current = dirname(target);
    while (pathWithin(root, current)) { ancestors.add(current); if (current === root) break; current = dirname(current); }
  }
  const prefix = "^" + foldedLiteral(root) + "/";
  // Tool path policy accepts backslashes as separators. Deny unusual literal
  // backslash names in scoped shell jobs too, so they cannot acquire a second
  // spelling that disagrees with that policy.
  const regexes = [prefix + ".*\\\\"];
  const components = (names) => `(?:${names.map(foldedLiteral).join("|")})`;
  if (policy.writeRestrictions.some((rule) => rule.kind === "tests")) {
    regexes.push(prefix + `(?:[^/]+/)*${components(TEST_PATH_SEGMENTS)}(?:/|$)`);
    regexes.push(prefix + `(?:[^/]+/)*${TEST_FILE_NAME_PATTERN}(?:/|$)`);
  }
  if (policy.writeRestrictions.some((rule) => rule.kind === "generated")) {
    regexes.push(prefix + `(?:[^/]+/)*${components(GENERATED_PATH_SEGMENTS)}(?:/|$)`);
    regexes.push(prefix + `(?:[^/]+/)*[^/]*\\.${foldedLiteral("generated")}\\.[^/]+(?:/|$)`);
  }
  for (const path of [...explicit, ...aliases]) regexes.push("^" + foldedLiteral(path) + "(?:/|$)");
  // Seatbelt accepts (?:...) syntactically but treats it differently from JS;
  // ordinary ERE groups are required for the rule to match real paths.
  return { scopedWriteRestrictions: policy.writeRestrictions, denyWriteRegexes: [...new Set(regexes.map((pattern) => pattern.replaceAll("(?:", "(")))], denyUnlinkPaths: [...ancestors], denyHardLinks: true,
    scopeEvidence: { scannedPaths: entries.length, protectedPaths: protectedPaths.length, protectedAncestors: ancestors.size, hardlinkInspection: "protected-regular-files", externalMutation: "not-coordinated" } };
}

function pathWithin(root, path) { const rel = relative(root, path); return rel === "" || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); }
function assertInside(root, path) { if (!pathWithin(root, path)) throw error("TASK_SCOPED_PATH_OUTSIDE_WORKSPACE", "A scoped write restriction resolves outside the execution workspace."); }
function checkAborted(signal) { if (signal?.aborted) throw Object.assign(new Error(signal.reason?.message ?? "Task interrupted."), { code: "ABORT_ERR", name: "AbortError" }); }
async function canonicalTarget(path) {
  const tail = [];
  while (true) {
    try { return resolve(await realpath(path), ...tail); }
    catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
      const parent = dirname(path);
      if (parent === path) throw cause;
      tail.unshift(basename(path)); path = parent;
    }
  }
}
