import * as vscode from "vscode";
import { gitBlobSha } from "./blobSha";
import { log } from "./output";
import { applyGitExclude } from "./sync";
import { isSyncing } from "./syncLock";

// Detects edits to managed files and removes them from .git/info/exclude so they surface
// in git status / diff.

interface WatcherState {
  /** Paths currently visible to git because their content diverges from remote */
  modifiedPaths: Set<string>;
  disposables: vscode.Disposable[];
}

const workspaceWatchers = new Map<string, WatcherState>();

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
    return;
  }

  const modifiedPaths = new Set(carriedOver);
  const disposables: vscode.Disposable[] = [];
  let pending = Promise.resolve();

  const handleChangeSingle = async (uri: vscode.Uri): Promise<void> => {
    // Compute local path relative to the workspace folder.
    const folderPath = folder.uri.fsPath;
    const uriPath = uri.fsPath;
    if (!uriPath.startsWith(folderPath + "/") && !uriPath.startsWith(folderPath + "\\")) {
      return;
    }
    const localPath = uriPath.slice(folderPath.length + 1).replace(/\\/g, "/");

    const remoteSha = managedFiles[localPath];
    if (remoteSha === undefined) return; // not a managed file

    let changed = false;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const localSha = gitBlobSha(Buffer.from(bytes));
      if (localSha !== remoteSha) {
        changed = !modifiedPaths.has(localPath);
        modifiedPaths.add(localPath);
      } else {
        changed = modifiedPaths.has(localPath);
        modifiedPaths.delete(localPath);
      }
    } catch {
      // File deleted — leave exclude state as-is; next sync will restore and re-evaluate.
      return;
    }

    if (!changed) return; // exclude block unchanged, skip the write

    // Skip the write while a sync is in progress — sync will write the correct exclude at the end.
    if (isSyncing()) return;

    const managed = Object.keys(managedFiles);
    const excludePaths = managed.filter((p) => !modifiedPaths.has(p));
    await applyGitExclude(folder, excludePaths, managed.length > 0).catch((err) =>
      log(`Warning: failed to update git exclude: ${err instanceof Error ? err.message : String(err)}`)
    );
  };

  const handleChange = (uri: vscode.Uri): void => {
    pending = pending.then(() => handleChangeSingle(uri)).catch(() => {});
  };

  for (const pattern of watchPatternsFor(Object.keys(managedFiles))) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, pattern)
    );
    disposables.push(watcher.onDidChange(handleChange));
    disposables.push(watcher.onDidCreate(handleChange));
    disposables.push(watcher.onDidDelete(handleChange));
    disposables.push(watcher);
  }

  workspaceWatchers.set(folder.uri.fsPath, { modifiedPaths, disposables });
}

/** Disposes every folder watcher (used on deactivation). */
export function disposeAllWatchers(): void {
  for (const state of workspaceWatchers.values()) {
    state.disposables.forEach((d) => d.dispose());
  }
  workspaceWatchers.clear();
}
