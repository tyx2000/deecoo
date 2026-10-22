import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { assertExistingWorkspacePath, assertSafePath, assertWorkspaceWriteParent, isPathNotFoundError } from "../tools/pathPolicy.js";

// Context collection has the same workspace boundary as interactive file tools. Resolve
// the selected root once (e.g. macOS /var -> /private/var), then reject links beneath it.
export async function createContextFileAccess(cwd) {
  const workspace = await realpath(resolve(cwd));
  const getRealWorkspace = async () => workspace;

  async function checkedPath(requestedPath, { allowMissing = false } = {}) {
    const path = assertSafePath(workspace, requestedPath);
    const parts = relative(workspace, path).split(sep).filter(Boolean);
    let current = workspace;
    let info = await assertExistingWorkspacePath(workspace, getRealWorkspace, current);
    for (let index = 0; index < parts.length; index += 1) {
      if (!info.isDirectory()) throw new Error("Context parent is not a directory: " + relative(workspace, current));
      current = join(current, parts[index]);
      try {
        info = await assertExistingWorkspacePath(workspace, getRealWorkspace, current);
      } catch (error) {
        if (allowMissing && isPathNotFoundError(error)) return { path, info: undefined };
        throw error;
      }
    }
    return { path, info };
  }

  return {
    async readText(requestedPath) {
      const { path, info } = await checkedPath(requestedPath);
      if (!info.isFile()) throw new Error("Context path is not a regular file: " + requestedPath);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("Context file changed before reading: " + requestedPath);
        // Recheck parents after opening too; the handle protects the final file from link
        // replacement, while pathPolicy checks real containment and sensitive targets.
        await checkedPath(requestedPath);
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    },
    async readDirectory(requestedPath = ".") {
      const { path, info } = await checkedPath(requestedPath);
      if (!info.isDirectory()) throw new Error("Context path is not a directory: " + requestedPath);
      return readdir(path, { withFileTypes: true });
    },
    async writeTextAtomically(requestedPath, content) {
      const { path } = await checkedPath(requestedPath, { allowMissing: true });
      await assertWorkspaceWriteParent(workspace, getRealWorkspace, path);
      await mkdir(dirname(path), { recursive: true });
      await checkedPath(requestedPath, { allowMissing: true });
      const temporary = join(dirname(path), "." + basename(path) + "." + randomUUID() + ".tmp");
      const relativeTemporary = relative(workspace, temporary);
      let handle;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(content, "utf8");
        await handle.sync();
        const written = await handle.stat();
        await handle.close();
        handle = undefined;
        await checkedPath(requestedPath, { allowMissing: true });
        const temporaryState = await checkedPath(relativeTemporary);
        if (temporaryState.info.dev !== written.dev || temporaryState.info.ino !== written.ino) throw new Error("Context temporary file changed before replacement.");
        await rename(temporary, path);
      } finally {
        await handle?.close();
        // Never follow a replaced parent just to clean up a temporary file.
        try { await checkedPath(relativeTemporary); await unlink(temporary); } catch { /* removed or unsafe parent */ }
      }
    },
  };
}
