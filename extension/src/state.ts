import * as vscode from "vscode";

/**
 * Per-workspace record of what we last synced, stored in globalState so it is
 * per-machine and never pollutes the repo. The blob SHA map lets us tell
 * "unmodified since last sync" (safe to overwrite) from "edited locally" (prompt).
 */
export interface SyncState {
  ref: string;
  /** The full repository URL this state was synced from. Used to detect repo URL changes. */
  repoUrl?: string;
  /** ETag of the last tree response, for cheap conditional (304) re-checks. */
  treeEtag?: string;
  /** repo-relative path -> git blob SHA we last wrote to disk */
  files: Record<string, string>;
  /**
   * Fingerprint of the targetFolders/pathMappings that produced `files`. A mismatch means the
   * managed set changed since the last sync — including while VS Code was closed, which the
   * in-session settings listener can't see — so the cached ETag must be ignored.
   */
  managedSetKey?: string;
  /**
   * Paths the user said "Keep mine" on. Stored as { localSha, repoSha } so we
   * can suppress re-prompts even across full-tree syncs, as long as neither the local
   * file nor the upstream file has changed since the user's decision.
   * Read via readAck() to handle the legacy plain-string format.
   */
  acknowledged?: Record<string, AckEntry | string>;
}

/** A single "Keep mine" acknowledgement entry. */
export interface AckEntry {
  localSha: string;
  repoSha: string;
}

/**
 * Reads an acknowledgement entry safely, migrating the legacy plain-string format
 * (which stored only localSha) to AckEntry. Legacy entries get repoSha: '' so they
 * never match a real upstream SHA — the user will be prompted once more, after which
 * the new format is stored.
 */
export function readAck(
  acknowledged: Record<string, AckEntry | string> | undefined,
  repoPath: string
): AckEntry | undefined {
  const val = acknowledged?.[repoPath];
  if (!val) return undefined;
  if (typeof val === "string") return { localSha: val, repoSha: "" };
  return val;
}

const KEY_PREFIX = "aiSetupSync.syncState:";

function keyFor(workspaceFolder: vscode.WorkspaceFolder): string {
  return KEY_PREFIX + workspaceFolder.uri.toString();
}

export function getState(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder
): SyncState {
  const saved = context.globalState.get<SyncState>(keyFor(folder));
  if (
    saved &&
    typeof saved === "object" &&
    !Array.isArray(saved) &&
    saved.files &&
    typeof saved.files === "object" &&
    !Array.isArray(saved.files)
  ) {
    return saved;
  }
  return { ref: "", files: {} };
}

export async function saveState(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  state: SyncState
): Promise<void> {
  await context.globalState.update(keyFor(folder), state);
}
