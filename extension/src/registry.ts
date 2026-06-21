// A small on-disk registry of every file this extension has synced, keyed by
// workspace. Lives at a stable path in the user's home dir so the
// `vscode:uninstall` script — a plain Node process with no vscode API and no
// workspace context — can read it and clean up. No vscode imports here.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface WorkspaceRecord {
  /** repo-relative path -> git blob SHA we last wrote */
  files: Record<string, string>;
}

export interface Registry {
  workspaces: Record<string, WorkspaceRecord>;
}

export function registryDir(): string {
  return path.join(os.homedir(), ".ai-setup-sync");
}

export function registryFilePath(): string {
  return path.join(registryDir(), "managed.json");
}

export function readRegistry(): Registry {
  try {
    const raw = fs.readFileSync(registryFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Registry;
    return parsed.workspaces ? parsed : { workspaces: {} };
  } catch {
    return { workspaces: {} };
  }
}

/**
 * Writes the registry via a temp file + atomic rename so a concurrent reader (or
 * another VS Code window) never sees a half-written file. A lost update is still
 * possible if two windows write at the same instant, but the worst case is bounded
 * — the uninstall hook misses one workspace's files, which "Remove Synced Files"
 * can still clean from within that workspace (it also reads globalState).
 */
function writeRegistry(reg: Registry): void {
  fs.mkdirSync(registryDir(), { recursive: true });
  const target = registryFilePath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

/** Records (or clears) the managed file map for a workspace. */
export function setWorkspaceFiles(
  workspaceFsPath: string,
  files: Record<string, string>
): void {
  const reg = readRegistry();
  if (Object.keys(files).length === 0) {
    delete reg.workspaces[workspaceFsPath];
  } else {
    reg.workspaces[workspaceFsPath] = { files };
  }
  writeRegistry(reg);
}
