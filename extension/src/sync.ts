import * as vscode from "vscode";
import { gitBlobSha } from "./blobSha";
import { getRawFile, getTree, RepoRef, TreeEntry } from "./github";
import { getState, saveState, SyncState } from "./state";
import { computePatterns, upsertBlock } from "./gitignore";
import { setWorkspaceFiles } from "./registry";
import { log } from "./output";
import { cacheRemoteContent, clearRemoteContent, remoteDocUri } from "./remoteContent";

/** Runs `fn` over `items` with at most `limit` concurrent executions. Throws if any item fails. */
async function parallelLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = items.slice();
  const errors: unknown[] = [];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        await fn(item);
      } catch (err) {
        errors.push(err);
      }
    }
  });
  await Promise.all(workers);
  if (errors.length > 0) {
    const messages = errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    throw new Error(`${errors.length} file(s) failed to sync: ${messages}`);
  }
}

export type ConflictPolicy = "prompt" | "overwrite" | "skip";

export interface SyncOptions {
  repoRef: RepoRef;
  targetFolders: string[];
  /** Maps repo-relative source paths to workspace-relative destination paths. */
  pathMappings: Record<string, string>;
  conflictPolicy: ConflictPolicy;
}

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
  upToDate: number;
  removedInRepo: string[];
  /** True if nothing on disk changed (used to keep auto-sync quiet). */
  noChanges: boolean;
  /** True when the tree was fetched but no files matched the configured paths — likely a wrong branch or targetFolders. */
  noFilesFound: boolean;
}

/**
 * Translates a repo-relative path to a workspace-relative path using pre-sorted
 * mapping entries (longest key first so more specific paths always win).
 */
function toLocalPath(repoPath: string, sortedMappings: [string, string][]): string {
  for (const [from, to] of sortedMappings) {
    if (repoPath === from) {
      return to;
    }
    if (repoPath.startsWith(from + "/")) {
      return to + repoPath.slice(from.length);
    }
  }
  return repoPath;
}

/**
 * Rejects local paths that could escape the workspace root after pathMappings
 * translation. Protects against a malicious workspace `.vscode/settings.json`
 * mapping a repo path to `../../etc/passwd` (SEC-1b).
 */
function validateLocalPath(p: string): void {
  if (!p || p.startsWith("/") || p.split("/").some((seg) => seg === "..")) {
    throw new Error(`Path mapping produces unsafe local path: "${p}"`);
  }
}

/** Paths we never sync even though they live under a target folder. */
function isSyncable(path: string, targetFolders: string[], mappings: Record<string, string>): boolean {
  const base = path.split("/").pop() ?? "";
  if (base === ".DS_Store") {
    return false;
  }
  // The repo's own CI must not be copied into consumers' projects.
  if (path.startsWith(".github/workflows/")) {
    return false;
  }
  if (targetFolders.some((f) => path === f || path.startsWith(f + "/"))) {
    return true;
  }
  return Object.keys(mappings).some((f) => path === f || path.startsWith(f + "/"));
}

/**
 * Rejects paths that could escape the workspace root via traversal or absolute
 * references. Paths from the GitHub tree API should never need these, so treating
 * them as errors is the right policy (SEC-1).
 */
function validateRepoPath(p: string): void {
  if (!p || p.startsWith("/") || p.includes("\\") || p.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`Unsafe path rejected from repository: "${p}"`);
  }
}

async function readIfExists(uri: vscode.Uri): Promise<Buffer | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes);
  } catch {
    return undefined;
  }
}

type Classification = "new" | "safe-update" | "conflict" | "up-to-date";

interface PlannedFile {
  entry: TreeEntry;
  /** Workspace-relative destination path (may differ from entry.path when pathMappings is set). */
  localPath: string;
  classification: Classification;
}

/**
 * Syncs all syncable files from the repo into a single workspace folder.
 * Returns a summary; writes only what changed.
 */
export async function syncFolder(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
  options: SyncOptions,
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<SyncResult> {
  const { repoRef, targetFolders, pathMappings, conflictPolicy } = options;
  // Sort once so every toLocalPath call in this sync run shares the same order.
  const sortedMappings: [string, string][] = Object.entries(pathMappings).sort((a, b) => b[0].length - a[0].length);
  const state = getState(context, workspaceFolder);

  progress?.report({ message: "Checking for updates…" });
  const tree = await getTree(repoRef, state.treeEtag);

  // Cheap short-circuit: a 304 means the repo tree is byte-identical to the last
  // sync (and the request didn't count against the GitHub rate limit). The repo
  // is unchanged — but a file may have been deleted locally (restore it) or
  // edited locally without the repo changing (prompt if conflictPolicy allows).
  if (tree.notModified) {
    // One pass: detect missing and locally-modified files simultaneously (OPT-1).
    const missing: string[] = [];
    const acknowledged = state.acknowledged ?? {};
    const locallyModified: PlannedFile[] = [];
    for (const [repoPath, lastSyncedSha] of Object.entries(state.files)) {
      if (!isSyncable(repoPath, targetFolders, pathMappings)) {
        continue;
      }
      const localPath = toLocalPath(repoPath, sortedMappings);
      validateLocalPath(localPath);
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
      const onDisk = await readIfExists(fileUri);
      if (!onDisk) {
        missing.push(repoPath);
        continue;
      }
      const localSha = gitBlobSha(onDisk);
      if (localSha !== lastSyncedSha && acknowledged[repoPath] !== localSha) {
        // entry.sha == lastSyncedSha because the repo hasn't changed (304).
        locallyModified.push({ entry: { path: repoPath, sha: lastSyncedSha, type: "blob" }, localPath, classification: "conflict" });
      }
    }

    // Restore missing files (re-fetch from raw — no API cost).
    let restored = 0;
    if (missing.length > 0) {
      await parallelLimit(missing, 5, async (repoPath) => {
        const localPath = toLocalPath(repoPath, sortedMappings);
        validateLocalPath(localPath);
        progress?.report({ message: `Restoring ${localPath}…` });
        const bytes = await getRawFile(repoRef, repoPath);
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
        const parentUri = vscode.Uri.joinPath(fileUri, "..");
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(fileUri, bytes);
      });
      restored = missing.length;
      // Keep registry + gitignore in sync after restore.
      try {
        setWorkspaceFiles(workspaceFolder.uri.fsPath, state.files);
        await applyGitExclude(workspaceFolder, Object.keys(state.files));
      } catch (err) {
        log(`Warning: failed to update registry/gitignore after restore: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let newAcknowledged = { ...acknowledged };
    let wasDismissed = false;
    let overwrittenCount = 0;

    if (locallyModified.length > 0) {
      const resolution = await resolveConflicts(locallyModified, conflictPolicy, repoRef, workspaceFolder);
      wasDismissed = resolution.wasDismissed;

      if (!wasDismissed) {
        const toRestore = locallyModified.filter((p) => resolution.shouldOverwrite(p.entry.path));
        const toKeep = locallyModified.filter((p) => !resolution.shouldOverwrite(p.entry.path));

        await parallelLimit(toRestore, 5, async (p) => {
          progress?.report({ message: `Restoring ${p.localPath}…` });
          const bytes = await getRawFile(repoRef, p.entry.path);
          const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, p.localPath);
          const parentUri = vscode.Uri.joinPath(fileUri, "..");
          await vscode.workspace.fs.createDirectory(parentUri);
          await vscode.workspace.fs.writeFile(fileUri, bytes);
          delete newAcknowledged[p.entry.path];
        });
        overwrittenCount = toRestore.length;

        // Record "Keep all mine" at the current local SHA so we don't re-prompt
        // unless the file changes again.
        for (const p of toKeep) {
          const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, p.localPath);
          const onDisk = await readIfExists(fileUri);
          if (onDisk) {
            newAcknowledged[p.entry.path] = gitBlobSha(onDisk);
          }
        }
      }
    }

    if (locallyModified.length > 0) {
      const newState: SyncState = {
        ...state,
        repoUrl: repoRef.url,
        acknowledged: Object.keys(newAcknowledged).length > 0 ? newAcknowledged : undefined,
        treeEtag: wasDismissed ? undefined : state.treeEtag,
      };
      await saveState(context, workspaceFolder, newState);
    }

    log(
      restored > 0 || overwrittenCount > 0
        ? `${workspaceFolder.name}: 304, restored ${restored} missing + ${overwrittenCount} overwritten.`
        : `${workspaceFolder.name}: up to date (304, no changes).`
    );
    return {
      added: restored,
      updated: overwrittenCount,
      skipped: locallyModified.length - overwrittenCount,
      upToDate: Object.keys(state.files).length - restored - locallyModified.length,
      removedInRepo: [],
      noChanges: restored === 0 && overwrittenCount === 0,
      noFilesFound: false,
    };
  }

  const entries = tree.entries.filter((e) => isSyncable(e.path, targetFolders, pathMappings));

  // Validate all paths before any file I/O (SEC-1).
  for (const entry of entries) {
    validateRepoPath(entry.path);
  }

  // Classify each remote file against what's on disk + what we last synced.
  const planned: PlannedFile[] = [];
  for (const entry of entries) {
    const localPath = toLocalPath(entry.path, sortedMappings);
    validateLocalPath(localPath);
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
    const onDisk = await readIfExists(fileUri);
    if (!onDisk) {
      planned.push({ entry, localPath, classification: "new" });
      continue;
    }
    const localSha = gitBlobSha(onDisk);
    if (localSha === entry.sha) {
      planned.push({ entry, localPath, classification: "up-to-date" });
      continue;
    }
    const lastSynced = state.files[entry.path];
    if (lastSynced && lastSynced === localSha) {
      // On disk matches what we wrote last time → user didn't touch it.
      planned.push({ entry, localPath, classification: "safe-update" });
    } else {
      // Local content diverges from both repo and our last write.
      planned.push({ entry, localPath, classification: "conflict" });
    }
  }

  const conflicts = planned.filter((p) => p.classification === "conflict");
  const { shouldOverwrite: overwriteConflict, wasDismissed } = await resolveConflicts(
    conflicts,
    conflictPolicy,
    repoRef,
    workspaceFolder
  );

  // Files that are removed from the repo but were previously synced by us.
  const allRepoPaths = new Set(tree.entries.map((e) => e.path));
  const remotePaths = new Set(entries.map((e) => e.path));
  const removedInRepo = Object.keys(state.files).filter((p) => !remotePaths.has(p) && !allRepoPaths.has(p));
  // Previously synced files still in the repo but now excluded by targetFolders/pathMappings — silently drop from state.
  const excludedBySettings = Object.keys(state.files).filter((p) => !remotePaths.has(p) && allRepoPaths.has(p));

  const result: SyncResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    upToDate: 0,
    removedInRepo,
    noChanges: true,
    noFilesFound: entries.length === 0,
  };

  // acknowledged is intentionally omitted — a full tree fetch means the repo
  // changed, so prior "Keep all mine" acknowledgements no longer apply.
  const newState: SyncState = {
    ref: repoRef.ref,
    repoUrl: repoRef.url,
    treeEtag: tree.etag,
    files: { ...state.files },
  };

  const toWrite: PlannedFile[] = [];
  for (const p of planned) {
    if (p.classification === "up-to-date") {
      result.upToDate++;
      newState.files[p.entry.path] = p.entry.sha;
    } else if (p.classification === "conflict" && !overwriteConflict(p.localPath)) {
      result.skipped++;
      newState.files[p.entry.path] = p.entry.sha;
    } else {
      toWrite.push(p);
    }
  }

  // Write files; save state even on partial failure so progress is not lost (BUG-4).
  let syncError: unknown;
  try {
    await parallelLimit(toWrite, 5, async (p) => {
      progress?.report({ message: `Syncing ${p.localPath}…` });
      const bytes = await getRawFile(repoRef, p.entry.path);
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, p.localPath);
      const parentUri = vscode.Uri.joinPath(fileUri, "..");
      await vscode.workspace.fs.createDirectory(parentUri);
      await vscode.workspace.fs.writeFile(fileUri, bytes);
      // OPT-2: the tree API already returns the blob SHA — no need to recompute it.
      newState.files[p.entry.path] = p.entry.sha;
      if (p.classification === "new") {
        result.added++;
      } else {
        result.updated++;
      }
    });
  } catch (err) {
    syncError = err;
  }

  // Forget removed and excluded files in our state (we don't delete them from disk).
  for (const p of [...removedInRepo, ...excludedBySettings]) {
    delete newState.files[p];
  }

  // If the user dismissed the conflict prompt (Escape/X) without making a
  // choice, don't cache the tree ETag — the next sync must re-fetch the tree
  // and re-offer the dialog. Explicit "Keep all mine" is a deliberate choice
  // and is respected until the repo actually changes.
  if (wasDismissed) {
    newState.treeEtag = undefined;
  }

  await saveState(context, workspaceFolder, newState);

  if (syncError) {
    throw syncError;
  }

  log(
    `${workspaceFolder.name}: ${result.added} added, ${result.updated} updated, ` +
      `${result.skipped} kept (local edits), ${result.upToDate} unchanged` +
      (removedInRepo.length ? `, ${removedInRepo.length} removed upstream` : "") +
      ` [${repoRef.repo}@${repoRef.ref}].`
  );

  // Record what we manage so the uninstall hook can clean it up later.
  // Use local paths (what's on disk) for the registry and git exclude.
  const localFiles: Record<string, string> = {};
  for (const [repoPath, sha] of Object.entries(newState.files)) {
    const lp = toLocalPath(repoPath, sortedMappings);
    validateLocalPath(lp);
    localFiles[lp] = sha;
  }
  try {
    setWorkspaceFiles(workspaceFolder.uri.fsPath, localFiles);
    await applyGitExclude(workspaceFolder, Object.keys(localFiles));
  } catch (err) {
    log(`Warning: failed to update registry/gitignore: ${err instanceof Error ? err.message : String(err)}`);
  }

  result.noChanges = result.added === 0 && result.updated === 0;
  return result;
}

/**
 * Inserts/updates (or removes) the managed ignore block in the repo's LOCAL
 * exclude file (`.git/info/exclude`). Using the local exclude rather than a
 * tracked `.gitignore` means the rules never show up as a change to commit.
 * No-ops if the workspace is not a plain git repository.
 */
async function applyGitExclude(
  workspaceFolder: vscode.WorkspaceFolder,
  managedPaths: string[]
): Promise<void> {
  const gitDir = vscode.Uri.joinPath(workspaceFolder.uri, ".git");
  try {
    const stat = await vscode.workspace.fs.stat(gitDir);
    // Only the standard ".git directory" layout has .git/info/exclude.
    if (!(stat.type & vscode.FileType.Directory)) {
      return;
    }
  } catch {
    return; // not a git repo
  }

  const infoDir = vscode.Uri.joinPath(gitDir, "info");
  const excludeUri = vscode.Uri.joinPath(infoDir, "exclude");
  const existing = (await readIfExists(excludeUri))?.toString("utf8") ?? "";
  const next = upsertBlock(existing, computePatterns(managedPaths));

  if (next !== undefined) {
    await vscode.workspace.fs.createDirectory(infoDir);
    await vscode.workspace.fs.writeFile(excludeUri, Buffer.from(next, "utf8"));
  }
}

interface ConflictResolution {
  shouldOverwrite: (path: string) => boolean;
  /** True when the user closed the dialog without making an explicit choice. */
  wasDismissed: boolean;
}

/**
 * Opens a VS Code diff editor: local file (left) vs. repository version (right).
 * Fetches and caches the remote content first; the caller is responsible for
 * calling `clearRemoteContent` when done.
 */
async function showFileDiff(
  c: PlannedFile,
  repoRef: RepoRef,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
  const bytes = await getRawFile(repoRef, c.entry.path);
  cacheRemoteContent(c.localPath, bytes);
  const localUri = vscode.Uri.joinPath(workspaceFolder.uri, c.localPath);
  const remoteUri = remoteDocUri(c.localPath);
  const fileName = c.localPath.split("/").pop() ?? c.localPath;
  await vscode.commands.executeCommand(
    "vscode.diff",
    localUri,
    remoteUri,
    `${fileName} (local ↔ repository)`
  );
}

/**
 * Decides which conflicting files get overwritten, honoring the policy.
 * `wasDismissed` is true when the user pressed Escape/X without choosing —
 * the caller uses this to avoid caching the tree ETag so the dialog re-appears
 * on the next sync. An explicit "Keep all mine" is not a dismissal.
 */
async function resolveConflicts(
  conflicts: PlannedFile[],
  policy: ConflictPolicy,
  repoRef: RepoRef,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<ConflictResolution> {
  const noop: ConflictResolution = { shouldOverwrite: () => false, wasDismissed: false };
  if (conflicts.length === 0) {
    return noop;
  }
  if (policy === "overwrite") {
    return { shouldOverwrite: () => true, wasDismissed: false };
  }
  if (policy === "skip") {
    return noop;
  }

  // policy === "prompt": offer a batched choice, then per-file if needed.
  const overwrite = new Set<string>();
  const fileWord = conflicts.length === 1 ? "file" : "files";
  const choice = await vscode.window.showWarningMessage(
    `${conflicts.length} setup ${fileWord} you edited locally differ from the repository. What would you like to do?`,
    { modal: true },
    "Review each",
    "Overwrite all",
    "Keep all mine"
  );

  if (choice === undefined) {
    return { shouldOverwrite: () => false, wasDismissed: true };
  }
  if (choice === "Overwrite all") {
    conflicts.forEach((c) => overwrite.add(c.localPath));
    return { shouldOverwrite: (p) => overwrite.has(p), wasDismissed: false };
  }
  if (choice === "Keep all mine") {
    return noop;
  }

  // Review each: per-file dialog with a Show diff button.
  // Track all paths opened in the diff editor so we can clean up on error (BUG-5).
  const openDiffs = new Set<string>();
  try {
    for (const c of conflicts) {
      let diffShown = false;
      let per: string | undefined;

      while (true) {
        if (diffShown) {
          per = await vscode.window.showWarningMessage(
            `"${c.localPath}" was modified locally and differs from the repository.`,
            { modal: true },
            "Overwrite",
            "Keep mine"
          );
        } else {
          per = await vscode.window.showWarningMessage(
            `"${c.localPath}" was modified locally and differs from the repository.`,
            { modal: true },
            "Overwrite",
            "Keep mine",
            "Show diff"
          );
        }
        if (per === "Show diff") {
          await showFileDiff(c, repoRef, workspaceFolder);
          openDiffs.add(c.localPath);
          diffShown = true;
          continue;
        }
        break;
      }

      if (per === "Overwrite") {
        overwrite.add(c.localPath);
      }
      clearRemoteContent(c.localPath);
      openDiffs.delete(c.localPath);
    }
  } finally {
    // Clear any cached diff content left open due to an unexpected error (BUG-5).
    for (const localPath of openDiffs) {
      clearRemoteContent(localPath);
    }
  }

  return { shouldOverwrite: (p) => overwrite.has(p), wasDismissed: false };
}

export function summarize(folderName: string, r: SyncResult): string {
  const parts = [`${r.added} added`, `${r.updated} updated`];
  if (r.skipped) {
    parts.push(`${r.skipped} kept (local edits)`);
  }
  if (r.removedInRepo.length) {
    parts.push(`${r.removedInRepo.length} removed in repo (left on disk)`);
  }
  return `${folderName}: ${parts.join(", ")}.`;
}
