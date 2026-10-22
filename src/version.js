import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const installationRoot = fileURLToPath(new URL("../", import.meta.url));

export async function getVersionInfo() {
  const { name, version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const info = { name, version, revision: null, dirty: null };
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
  return info.version + (info.revision ? " (" + info.revision + (info.dirty ? ", dirty" : "") + ")" : "");
}
