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
   * Paths the user said "Keep mine for now" on during a 304 local-modification check,
   * mapped to the local blob SHA at that moment. We skip re-prompting while the
   * local SHA is unchanged. Cleared when the repo tree changes (full sync).
   */
  acknowledged?: Record<string, string>;
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
