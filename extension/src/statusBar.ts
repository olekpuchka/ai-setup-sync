import * as vscode from "vscode";

type StatusState = "idle" | "syncing" | "error" | "unconfigured";

let statusBar: vscode.StatusBarItem | undefined;
let lastSyncSuccessAt: number | undefined;
// Last state passed to setStatus, so the post-sync-failure overlay can re-render without losing it.
let lastStatusState: StatusState = "idle";
let lastStatusDetail: string | undefined;
// Folder keys whose last post-sync command failed. Shown persistently in the status bar
// (a fast-sync toast can be missed), retried by a manual Sync Now, and cleared when the
// command next succeeds. Persisted in workspaceState so it survives a window reload.
const postSyncFailedFolders = new Set<string>();
const POST_SYNC_FAILED_KEY = "postSyncCommand.failed";

function relativeTime(ms: number): string {
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) {
    return "just now";
  }
  const mins = Math.round(secs / 60);
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Creates and shows the status bar item, and restores persisted post-sync failures so the
 * warning (and the Sync Now retry) survive a window reload.
 */
export function initStatusBar(context: vscode.ExtensionContext, command: string): void {
  for (const key of context.workspaceState.get<string[]>(POST_SYNC_FAILED_KEY) ?? []) {
    postSyncFailedFolders.add(key);
  }
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = command;
  statusBar.show();
  context.subscriptions.push(statusBar);
}

export function setStatus(state: StatusState, detail?: string): void {
  if (!statusBar) {
    return;
  }
  lastStatusState = state;
  lastStatusDetail = detail;
  // A post-sync failure persists over the "idle" (sync-succeeded) state — the sync
  // itself was fine, but the command wasn't, and a toast alone can be missed.
  if (state === "idle" && postSyncFailedFolders.size > 0) {
    statusBar.text = "$(warning) AI Setup Sync";
    statusBar.tooltip = "AI Setup Sync: the Post Sync Command failed.\nClick for actions.";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    return;
  }
  switch (state) {
    case "syncing":
      statusBar.text = "$(sync~spin) AI Setup Sync";
      statusBar.tooltip = "Syncing";
      statusBar.backgroundColor = undefined;
      break;
    case "error":
      statusBar.text = "$(warning) AI Setup Sync";
      statusBar.tooltip = `Sync failed: ${detail ?? "unknown error"}\nClick for actions.`;
      statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      break;
    case "unconfigured":
      statusBar.text = "$(gear) AI Setup Sync";
      statusBar.tooltip = "No repository configured. Click for actions.";
      statusBar.backgroundColor = undefined;
      break;
    default:
      statusBar.text = "$(check) AI Setup Sync";
      statusBar.tooltip =
        syncedLabel("Ready") +
        (detail ? ` • ${detail}` : "") +
        "\nClick for actions.";
      statusBar.backgroundColor = undefined;
  }
}

export function markSyncSuccess(): void {
  lastSyncSuccessAt = Date.now();
}

/** "Synced 5m ago", or `fallback` if no sync has succeeded this session. */
export function syncedLabel(fallback: string): string {
  return lastSyncSuccessAt ? `Synced ${relativeTime(lastSyncSuccessAt)}` : fallback;
}

/** Records a folder's post-sync outcome, persists it, and re-renders if it changed. */
export function setPostSyncFolderFailed(
  context: vscode.ExtensionContext,
  folderKey: string,
  failed: boolean
): void {
  const wasFailed = postSyncFailedFolders.has(folderKey);
  if (failed) {
    postSyncFailedFolders.add(folderKey);
  } else {
    postSyncFailedFolders.delete(folderKey);
  }
  if (wasFailed !== failed) {
    // Persistence is non-critical — ignore a storage-write failure rather than let it reject unhandled.
    void context.workspaceState
      .update(POST_SYNC_FAILED_KEY, [...postSyncFailedFolders])
      .then(undefined, () => {});
    setStatus(lastStatusState, lastStatusDetail);
  }
}

export function hasPostSyncFailure(folderKey: string): boolean {
  return postSyncFailedFolders.has(folderKey);
}

export function postSyncFailedKeys(): string[] {
  return [...postSyncFailedFolders];
}
