import * as vscode from "vscode";
import { gitBlobSha } from "./blobSha";
import { log } from "./output";
import { applyGitExclude } from "./sync";
import { isSyncing, onSyncReleased } from "./syncLock";

// Detects edits to managed files and removes them from .git/info/exclude so they surface
// in git status / diff.

interface WatcherState {
  /** Managed workspace-relative path -> git blob SHA we last wrote */
  managedFiles: Record<string, string>;
  /** Paths currently visible to git because their content diverges from remote */
  modifiedPaths: Set<string>;
  disposables: vscode.Disposable[];
}

const workspaceWatchers = new Map<string, WatcherState>();

/**
 * Per-folder event queue, kept apart from WatcherState so it survives a rebuild. Events are
 * evaluated one at a time against whatever state is current *when they run*, so an event
 * queued before a sync replaced the watcher is judged by the new managed set, not the old.
 */
const pendingByFolder = new Map<string, Promise<void>>();

/**
 * Events that ran while a sync or post-sync command held the lock. Judging them mid-sync would
 * compare against SHAs the sync is about to replace, and any exclude written then is overwritten
 * by the sync anyway — so they wait for the release, when the watcher state is final. Keyed by
 * folder and URI so a burst of writes to one file is evaluated once per folder (nested roots can
 * share a file).
 */
const deferredEvents = new Map<string, { folder: vscode.WorkspaceFolder; uri: vscode.Uri }>();

/** Unsubscribes the release hook; set while any watcher exists. */
let unsubscribeRelease: (() => void) | undefined;

function replayDeferred(): void {
  const events = [...deferredEvents.values()];
  deferredEvents.clear();
  for (const { folder, uri } of events) {
    queueChange(folder, uri);
  }
}

function deferChange(folder: vscode.WorkspaceFolder, uri: vscode.Uri): void {
  deferredEvents.set(`${folder.uri.toString()}\u0000${uri.toString()}`, { folder, uri });
}

/**
 * Glob syntax that would make a literal path match something other than itself, per the set
 * VS Code documents: `*`, `?`, `**`, `{}`, `[]`, `[!...]`. Deliberately excludes `(`/`)` (no
 * extglob support), and `,`/`!` — those are only significant inside `{}`/`[]`, and we never
 * emit a brace list. Keeping them out matters: they are common in real directory names, and
 * over-matching here would push ordinary projects onto the whole-workspace fallback.
 */
const GLOB_METACHARS = /[*?[\]{}]/;

/**
 * Narrowest set of globs covering every managed file, so the handler isn't woken for every
 * file event in the project. One pattern per root, never a `{a,b}` brace list — a comma in a
 * filename would split that and silently stop matching it.
 *
 * Over-matching is harmless (the handler filters on `managedFiles`); under-matching would
 * miss an edit and leave the file hidden from git. So directories widen to `root/**`, and a
 * root carrying glob syntax we can't quote falls back to watching everything.
 */
function watchPatternsFor(managedPaths: string[]): string[] {
  const patterns = new Set<string>();
  for (const p of managedPaths) {
    const slash = p.indexOf("/");
    // Test the literal segment before appending `/**`, or every directory root looks like
    // it contains glob syntax.
    const root = slash < 0 ? p : p.slice(0, slash);
    if (GLOB_METACHARS.test(root)) {
      // VS Code globs have no escape (backslash is invalid in a pattern), so widen rather
      // than risk a pattern that silently stops matching. Logged because it costs an event
      // for every file in the project and would otherwise be invisible.
      log(`Watching all files in this folder: "${root}" contains glob syntax that can't be quoted.`);
      return ["**"];
    }
    patterns.add(slash < 0 ? root : `${root}/**`);
  }
  return [...patterns].sort();
}

/** The current watcher state for a folder, if `localPath` is one of its managed files. */
function stateManaging(folderPath: string, localPath: string): WatcherState | undefined {
  const state = workspaceWatchers.get(folderPath);
  return state?.managedFiles[localPath] !== undefined ? state : undefined;
}

/** Re-evaluates one managed file and updates the git exclude if its visibility changed. */
async function evaluateChange(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<void> {
  // Compute local path relative to the workspace folder.
  const folderPath = folder.uri.fsPath;
  const uriPath = uri.fsPath;
  if (!uriPath.startsWith(folderPath + "/") && !uriPath.startsWith(folderPath + "\\")) {
    return;
  }
  const localPath = uriPath.slice(folderPath.length + 1).replace(/\\/g, "/");
  const before = stateManaging(folderPath, localPath);
  if (!before) {
    return; // not a managed file
  }
  if (isSyncing()) {
    deferChange(folder, uri);
    return;
  }

  let localSha: string;
  try {
    localSha = gitBlobSha(await vscode.workspace.fs.readFile(uri));
  } catch {
    // File deleted — leave exclude state as-is; next sync will restore and re-evaluate.
    return;
  }

  // A sync may have started during the read; its result is what this must be judged against.
  if (isSyncing()) {
    deferChange(folder, uri);
    return;
  }
  // A sync may also have started *and finished* during the read, rebuilding the watcher. These
  // bytes predate that sync, so judging them against its SHAs would flag files it just wrote —
  // read again instead, against the new state.
  if (workspaceWatchers.get(folderPath) !== before) {
    queueChange(folder, uri);
    return;
  }
  const { managedFiles, modifiedPaths } = before;
  let changed: boolean;
  if (localSha !== managedFiles[localPath]) {
    changed = !modifiedPaths.has(localPath);
    modifiedPaths.add(localPath);
  } else {
    changed = modifiedPaths.has(localPath);
    modifiedPaths.delete(localPath);
  }

  if (!changed) return; // exclude block unchanged, skip the write

  const managed = Object.keys(managedFiles);
  const excludePaths = managed.filter((p) => !modifiedPaths.has(p));
  await applyGitExclude(folder, excludePaths, managed.length > 0).catch((err) =>
    log(`Warning: failed to update git exclude: ${err instanceof Error ? err.message : String(err)}`)
  );
}

function queueChange(folder: vscode.WorkspaceFolder, uri: vscode.Uri): void {
  const key = folder.uri.fsPath;
  const next = (pendingByFolder.get(key) ?? Promise.resolve())
    .then(() => evaluateChange(folder, uri))
    .catch((err) =>
      log(`Warning: failed to re-check ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`)
    );
  pendingByFolder.set(key, next);
  // Drop the entry once the queue drains so an idle folder holds no promise chain.
  void next.then(() => {
    if (pendingByFolder.get(key) === next) {
      pendingByFolder.delete(key);
    }
  });
}

/**
 * Rebuilds this folder's watchers for `managedFiles`.
 *
 * `initialModifiedPaths` defaults to whatever was already visible to git, narrowed to paths
 * still managed — what a failed sync wants, so it doesn't lose that state on rebuild.
 */
export function refreshWatcher(
  folder: vscode.WorkspaceFolder,
  managedFiles: Record<string, string>,
  initialModifiedPaths?: string[]
): void {
  const prev = workspaceWatchers.get(folder.uri.fsPath);
  const carriedOver =
    initialModifiedPaths ??
    (prev ? [...prev.modifiedPaths].filter((p) => managedFiles[p] !== undefined) : []);
  prev?.disposables.forEach((d) => d.dispose());

  if (Object.keys(managedFiles).length === 0) {
    workspaceWatchers.delete(folder.uri.fsPath);
    if (workspaceWatchers.size === 0) {
      // Nothing left to judge deferred events against, and no listener left to replay them.
      deferredEvents.clear();
      unsubscribeRelease?.();
      unsubscribeRelease = undefined;
    }
    return;
  }
  unsubscribeRelease ??= onSyncReleased(replayDeferred);

  const disposables: vscode.Disposable[] = [];
  const handleChange = (uri: vscode.Uri): void => queueChange(folder, uri);
  for (const pattern of watchPatternsFor(Object.keys(managedFiles))) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, pattern)
    );
    disposables.push(watcher.onDidChange(handleChange));
    disposables.push(watcher.onDidCreate(handleChange));
    disposables.push(watcher.onDidDelete(handleChange));
    disposables.push(watcher);
  }

  workspaceWatchers.set(folder.uri.fsPath, {
    managedFiles,
    modifiedPaths: new Set(carriedOver),
    disposables,
  });
}

/** Disposes every folder watcher (used on deactivation). */
export function disposeAllWatchers(): void {
  for (const state of workspaceWatchers.values()) {
    state.disposables.forEach((d) => d.dispose());
  }
  workspaceWatchers.clear();
  deferredEvents.clear();
  unsubscribeRelease?.();
  unsubscribeRelease = undefined;
}
