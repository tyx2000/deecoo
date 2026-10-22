import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createExecutionBackend } from "../execution/backend.js";
import { listMemory, editMemory, deleteMemory, pruneMemory } from "../memory/projectMemory.js";
import { createChangeSet, listChangeSets } from "../workspace/changes.js";

export async function runManagementCommand({ args, cwd, config, sessionStore }) {
  const [action, id, ...remaining] = args.taskParts;
  if (remaining.length) throw new Error("Unexpected management arguments: " + remaining.join(" "));
  const requiredId = () => { if (!id) throw new Error(`${args.command} ${action} requires an explicit ID`); return id; };
  if (["capabilities", "list", "prune"].includes(action) && id) throw new Error(`${args.command} ${action} does not accept an ID`);
  const scope = args.scope ?? "project";
  let result;
  if (args.command === "jobs") {
    const backend = createExecutionBackend({ cwd, stateDir: join(sessionStore.projectDir, "jobs"), sandboxPolicy: config.sandboxPolicy });
    if (action === "capabilities") result = backend.capabilities();
    else if (action === "status") result = await backend.getJob(requiredId());
    else if (action === "output") result = await backend.readOutput(requiredId(), { stream: args.outputStream, offset: args.offset, maxBytes: args.maxBytes });
    else if (action === "stop") result = await backend.stopJob(requiredId());
    else throw new Error("jobs requires status ID, output ID, stop ID, or capabilities");
  } else if (args.command === "memory") {
    if (action === "list") result = { entries: await listMemory(sessionStore, { scope, includeExpired: args.includeExpired }) };
    else if (action === "edit") {
      if (args.memoryText === undefined && args.expiresAt === undefined) throw new Error("memory edit requires --text or --expires-at");
      const entry = await editMemory(sessionStore, { id: requiredId(), scope, text: args.memoryText, expiresAt: args.expiresAt === "none" ? null : args.expiresAt });
      if (!entry) throw new Error("Memory entry was not found");
      result = { entry };
    } else if (action === "delete") { result = await deleteMemory(sessionStore, { id: requiredId(), scope }); if (!result.deleted) throw new Error("Memory entry was not found"); }
    else if (action === "prune") result = await pruneMemory(sessionStore, { scope: args.scope ?? "all" });
    else throw new Error("memory requires list, edit ID, delete ID, or prune");
  } else if (args.command === "storage") {
    if (action === "status") result = { policy: sessionStore.storagePolicy, ...(await sessionStore.inventory()) };
    else if (action === "prune") result = await sessionStore.prune({ dryRun: args.dryRun === true });
    else throw new Error("storage requires status or prune");
  } else if (args.command === "changes") {
    const stateDir = join(sessionStore.projectDir, "changes");
    if (action === "list") result = { changes: await listChangeSets({ cwd, stateDir }) };
    else {
      const changeSet = await createChangeSet({ cwd, stateDir, id: requiredId() });
      if (action === "show") result = await changeSet.inspect({ path: args.path });
      else if (["accept", "undo"].includes(action)) {
        result = await changeSet.decide({ action, path: args.path, hunkIds: args.hunkIds });
        if (args.path && !result.outcomes.length) throw new Error("The selected path has no task changes");
      }
      else if (action === "export") {
        result = await changeSet.exportPatch({ path: args.path });
        if (args.outputPath) { const path = resolve(args.outputPath); await writeFile(path, result.patch, { flag: "wx", mode: 0o600 }); result = { id, path, bytes: Buffer.byteLength(result.patch) }; }
      } else throw new Error("changes requires list, show ID, accept ID, undo ID, or export ID");
    }
  } else throw new Error("Unsupported management command: " + args.command);
  return { schemaVersion: 1, kind: "management-result", command: args.command, action, ok: result?.ok !== false, result };
}
