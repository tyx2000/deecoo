import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const installationRoot = fileURLToPath(new URL("../", import.meta.url));

export async function getVersionInfo() {
  const { name, version, releasedAt } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  // The release time travels inside package.json, so a copied or published install reports it too.
  const info = { name, version, releasedAt: validTimestamp(releasedAt) ? releasedAt : null, revision: null, dirty: null };
  try {
    // A package installed inside another repository must not inherit its HEAD.
    await lstat(join(installationRoot, ".git"));
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) delete env[key];
    const git = async (...args) => (await exec("git", ["-C", installationRoot, ...args], { env, timeout: 1500, maxBuffer: 65536 })).stdout.trim();
    if (await realpath(await git("rev-parse", "--show-toplevel")) !== await realpath(installationRoot)) return info;
    const revision = await git("rev-parse", "--short=12", "HEAD");
    if (!/^[0-9a-f]{12,64}$/.test(revision)) return info;
    info.revision = revision;
    try { info.dirty = (await git("status", "--porcelain", "--untracked-files=normal")) !== ""; } catch { /* Revision is still known. */ }
  } catch { /* Published packages and systems without Git still have a version. */ }
  return info;
}

export function formatVersion(info) {
  const released = info.releasedAt ? " " + formatReleaseTime(info.releasedAt) : "";
  return info.version + released + (info.revision ? " (" + info.revision + (info.dirty ? ", dirty" : "") + ")" : "");
}

// Local wall-clock time, year to second: 2026-10-26 11:20:33.
export function formatReleaseTime(timestamp) {
  const date = new Date(timestamp);
  if (!validTimestamp(timestamp)) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}
