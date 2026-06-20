import * as vscode from "vscode";
import { gitBlobSha } from "./blobSha";
import { getRawFile, getTree, RepoRef, TreeEntry } from "./github";
import { getState, saveState, SyncState } from "./state";
import { computePatterns, upsertBlock } from "./gitignore";
import { setWorkspaceFiles } from "./registry";
import { log } from "./output";
import { cacheRemoteContent, clearRemoteContent, remoteDocUri } from "./remoteContent";

const DOWNLOAD_CONCURRENCY = 20; // GitHub fetch + local write
const DISK_CONCURRENCY = 50;     // local read/delete only

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
  deleted: number;
  /** Locally-edited files that were removed from the repo but kept on disk (per conflictPolicy). */
  keptDeleted: number;
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
  options: SyncOptions
): Promise<SyncResult> {
  const { repoRef, targetFolders, pathMappings, conflictPolicy } = options;
  // Sort once so every toLocalPath call in this sync run shares the same order.
  const sortedMappings: [string, string][] = Object.entries(pathMappings).sort((a, b) => b[0].length - a[0].length);
  const state = getState(context, workspaceFolder);

  const tree = await getTree(repoRef, state.treeEtag);

  // Cheap short-circuit: a 304 means the repo tree is byte-identical to the last
  // sync (and the request didn't count against the GitHub rate limit). The repo
  // is unchanged — but a file may have been deleted locally (restore it) or
  // edited locally without the repo changing (prompt if conflictPolicy allows).
  if (tree.notModified) {
    // One pass: detect missing and locally-modified files simultaneously (OPT-1).
    const missing: { repoPath: string; localPath: string }[] = [];
    const acknowledged = state.acknowledged ?? {};
    const locallyModified: PlannedFile[] = [];
    let syncableCount = 0;
    for (const [repoPath, lastSyncedSha] of Object.entries(state.files)) {
      if (!isSyncable(repoPath, targetFolders, pathMappings)) {
        continue;
      }
      syncableCount++;
      const localPath = toLocalPath(repoPath, sortedMappings);
      validateLocalPath(localPath);
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
      const onDisk = await readIfExists(fileUri);
      if (!onDisk) {
        missing.push({ repoPath, localPath });
        continue;
      }
      const localSha = gitBlobSha(onDisk);
      if (localSha !== lastSyncedSha && acknowledged[repoPath] !== localSha) {
        // entry.sha == lastSyncedSha because the repo hasn't changed (304).
        locallyModified.push({ entry: { path: repoPath, sha: lastSyncedSha, type: "blob" }, localPath, classification: "conflict" });
      }
    }

    // Restore missing files (re-fetch from raw — no API cost).
    let addedCount = 0;
    if (missing.length > 0) {
      await parallelLimit(missing, DOWNLOAD_CONCURRENCY, async ({ repoPath, localPath }) => {
        const bytes = await getRawFile(repoRef, repoPath);
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
        const parentUri = vscode.Uri.joinPath(fileUri, "..");
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(fileUri, bytes);
      });
      addedCount = missing.length;
      // Keep registry + gitignore in sync after restore.
      try {
        const localFiles: Record<string, string> = {};
        for (const [repoPath, sha] of Object.entries(state.files)) {
          const lp = toLocalPath(repoPath, sortedMappings);
          validateLocalPath(lp);
          localFiles[lp] = sha;
        }
        setWorkspaceFiles(workspaceFolder.uri.fsPath, localFiles);
        await applyGitExclude(workspaceFolder, Object.keys(localFiles));
      } catch (err) {
        log(`Warning: failed to update registry/gitignore after restore: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let newAcknowledged = { ...acknowledged };
    let wasDismissed = false;
    let updatedCount = 0;
    let toOverwrite: typeof locallyModified = [];
    let toKeep: typeof locallyModified = [];

    if (locallyModified.length > 0) {
      const resolution = await resolveConflicts(locallyModified, conflictPolicy, repoRef, workspaceFolder);
      wasDismissed = resolution.wasDismissed;

      toOverwrite = locallyModified.filter((p) => resolution.shouldOverwrite(p.localPath));
      toKeep = locallyModified.filter((p) => !resolution.shouldOverwrite(p.localPath));

      // Always write files the user approved, even if they escaped on a later file.
      await parallelLimit(toOverwrite, DOWNLOAD_CONCURRENCY, async (p) => {
        const bytes = await getRawFile(repoRef, p.entry.path);
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, p.localPath);
        const parentUri = vscode.Uri.joinPath(fileUri, "..");
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(fileUri, bytes);
        delete newAcknowledged[p.entry.path];
      });
      updatedCount = toOverwrite.length;

      // Only acknowledge "kept" files when the review was completed — if dismissed
      // mid-review we can't tell "Keep mine" from "Escaped", so let treeEtag=undefined
      // cause a re-prompt next sync for the unresolved files.
      if (!wasDismissed) {
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

    const fileLog304: string[] = [];
    for (const { localPath } of missing) {
      fileLog304.push(`  ${localPath} (added)`);
    }
    for (const p of toOverwrite) {
      fileLog304.push(`  ${p.localPath} (updated)`);
    }
    if (!wasDismissed) {
      for (const p of toKeep) {
        fileLog304.push(`  ${p.localPath} (kept — your edits)`);
      }
    }
    const result304: SyncResult = {
      added: addedCount,
      updated: updatedCount,
      skipped: wasDismissed ? 0 : toKeep.length,
      upToDate: syncableCount - addedCount - locallyModified.length,
      deleted: 0,
      keptDeleted: 0,
      noChanges: addedCount === 0 && updatedCount === 0,
      noFilesFound: false,
    };
    if (fileLog304.length > 0) {
      log(summarize(workspaceFolder.name, result304).replace(/\.$/, ":"));
      fileLog304.forEach((line) => log(line));
    }
    return result304;
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
    deleted: 0,
    keptDeleted: 0,
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

  const fileLog: string[] = [];
  const toWrite: PlannedFile[] = [];
  for (const p of planned) {
    if (p.classification === "up-to-date") {
      result.upToDate++;
      newState.files[p.entry.path] = p.entry.sha;
    } else if (p.classification === "conflict" && !overwriteConflict(p.localPath)) {
      if (!wasDismissed) {
        result.skipped++;
        fileLog.push(`  ${p.localPath} (kept — your edits)`);
      }
      newState.files[p.entry.path] = p.entry.sha;
    } else {
      toWrite.push(p);
    }
  }

  // Write files; save state even on partial failure so progress is not lost (BUG-4).
  let syncError: unknown;
  try {
    await parallelLimit(toWrite, DOWNLOAD_CONCURRENCY, async (p) => {
      const bytes = await getRawFile(repoRef, p.entry.path);
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, p.localPath);
      const parentUri = vscode.Uri.joinPath(fileUri, "..");
      await vscode.workspace.fs.createDirectory(parentUri);
      await vscode.workspace.fs.writeFile(fileUri, bytes);
      // OPT-2: the tree API already returns the blob SHA — no need to recompute it.
      newState.files[p.entry.path] = p.entry.sha;
      if (p.classification === "new") {
        result.added++;
        fileLog.push(`  ${p.localPath} (added)`);
      } else {
        result.updated++;
        fileLog.push(`  ${p.localPath} (updated)`);
      }
    });
  } catch (err) {
    syncError = err;
  }

  // Forget excluded files in our state (disabled via targetFolders/pathMappings — not deleted from disk).
  for (const p of excludedBySettings) {
    delete newState.files[p];
  }

  // Delete files removed from the repo. Unmodified files are deleted silently;
  // locally-edited ones are handled per conflictPolicy.
  let deleteWasDismissed = false;
  if (removedInRepo.length > 0) {
    type RemovedEntry = { repoPath: string; localPath: string };
    const safeToDelete: RemovedEntry[] = [];
    const editedAndRemoved: RemovedEntry[] = [];

    await parallelLimit(removedInRepo, DISK_CONCURRENCY, async (repoPath) => {
      const localPath = toLocalPath(repoPath, sortedMappings);
      validateLocalPath(localPath);
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
      const onDisk = await readIfExists(fileUri);
      if (!onDisk) {
        // Already gone — just drop from state, nothing to delete.
        delete newState.files[repoPath];
        return;
      }
      const localSha = gitBlobSha(onDisk);
      if (localSha === state.files[repoPath]) {
        safeToDelete.push({ repoPath, localPath });
      } else {
        editedAndRemoved.push({ repoPath, localPath });
      }
    });

    const editedLocalPaths = editedAndRemoved.map(({ localPath }) => localPath);
    const deleteResolution = await resolveDeleteConflicts(editedLocalPaths, conflictPolicy);
    deleteWasDismissed = deleteResolution.wasDismissed;

    const deletedLocalPaths: string[] = [];

    for (const { repoPath, localPath } of safeToDelete) {
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
      try {
        await vscode.workspace.fs.delete(fileUri, { useTrash: false });
        result.deleted++;
        fileLog.push(`  ${localPath} (deleted)`);
        delete newState.files[repoPath];
        deletedLocalPaths.push(localPath);
      } catch (err) {
        log(`Warning: could not delete ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const { repoPath, localPath } of editedAndRemoved) {
      if (deleteResolution.shouldDelete(localPath)) {
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
        try {
          await vscode.workspace.fs.delete(fileUri, { useTrash: false });
          result.deleted++;
          fileLog.push(`  ${localPath} (deleted)`);
          delete newState.files[repoPath];
          deletedLocalPaths.push(localPath);
        } catch (err) {
          log(`Warning: could not delete ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        if (!deleteWasDismissed) {
          result.keptDeleted++;
          fileLog.push(`  ${localPath} (kept — deleted in repo)`);
          // User explicitly chose to keep — stop tracking so we don't re-prompt next sync.
          delete newState.files[repoPath];
        }
        // If dismissed (Escape), leave in state so the next sync re-prompts.
      }
    }

    // Remove directories that became empty after file deletions (deepest first).
    if (deletedLocalPaths.length > 0) {
      const dirCandidates = new Set<string>();
      for (const localPath of deletedLocalPaths) {
        let dir = localPath.includes("/") ? localPath.slice(0, localPath.lastIndexOf("/")) : "";
        while (dir) {
          dirCandidates.add(dir);
          dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
        }
      }
      const sortedDirs = [...dirCandidates].sort((a, b) => b.length - a.length);
      for (const dir of sortedDirs) {
        const dirUri = vscode.Uri.joinPath(workspaceFolder.uri, dir);
        try {
          const entries = await vscode.workspace.fs.readDirectory(dirUri);
          if (entries.length === 0) {
            await vscode.workspace.fs.delete(dirUri, { useTrash: false });
            fileLog.push(`  ${dir}/ (directory removed)`);
          }
        } catch {
          // Directory already gone or inaccessible — skip.
        }
      }
    }
  }

  // If the user dismissed any conflict prompt (Escape/X) without making a
  // choice, don't cache the tree ETag — the next sync must re-fetch the tree
  // and re-offer the dialog.
  if (wasDismissed || deleteWasDismissed) {
    newState.treeEtag = undefined;
  }

  await saveState(context, workspaceFolder, newState);

  if (syncError) {
    throw syncError;
  }

  if (fileLog.length > 0) {
    log(summarize(workspaceFolder.name, result).replace(/\.$/, ":"));
    fileLog.forEach((line) => log(line));
  }

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

  result.noChanges = result.added === 0 && result.updated === 0 && result.deleted === 0 && result.keptDeleted === 0;
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

/** Closes the diff tab opened by showFileDiff for the given local path, if still open. */
async function closeFileDiff(localPath: string): Promise<void> {
  const remoteUri = remoteDocUri(localPath).toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === remoteUri) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
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

  // policy === "prompt": for multiple files offer a batched choice first; for a single
  // file go straight to per-file review ("Review each" with one item is the same thing).
  const overwrite = new Set<string>();

  if (conflicts.length > 1) {
    const choice = await vscode.window.showWarningMessage(
      `${conflicts.length} setup files you edited locally differ from the repository. What would you like to do?`,
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
    // "Review each" — fall through to per-file loop.
  }

  // Per-file dialog with a Show diff button.
  // Track the currently-open diff tab so we can close it on error or early return.
  let currentDiff: string | undefined;
  try {
    for (const c of conflicts) {
      let diffShown = false;
      let per: string | undefined;

      while (true) {
        if (diffShown) {
          // Quick pick stays open while the user scrolls through the diff (ignoreFocusOut),
          // and doesn't block the editor like a modal would.
          const pick = await vscode.window.showQuickPick(
            [
              { label: "$(repo-forked) Overwrite", description: "Replace with the repository version", value: "Overwrite" },
              { label: "$(edit) Keep mine", description: "Keep your local edits", value: "Keep mine" },
            ],
            {
              title: `Conflict: ${c.localPath}`,
              placeHolder: "Diff is open in the editor below — pick an action when ready",
              ignoreFocusOut: true,
            }
          );
          per = pick?.value;
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
          currentDiff = c.localPath;
          diffShown = true;
          continue;
        }
        break;
      }

      if (per === "Overwrite") {
        overwrite.add(c.localPath);
      }
      clearRemoteContent(c.localPath);
      if (diffShown) {
        await closeFileDiff(c.localPath);
      }
      currentDiff = undefined;

      if (per === undefined) {
        // User dismissed (Escape) — apply decisions made so far, re-prompt remaining files next sync.
        return { shouldOverwrite: (p) => overwrite.has(p), wasDismissed: true };
      }
    }
  } finally {
    // Close any diff tab left open due to an unexpected error or early return.
    if (currentDiff) {
      clearRemoteContent(currentDiff);
      await closeFileDiff(currentDiff);
    }
  }

  return { shouldOverwrite: (p) => overwrite.has(p), wasDismissed: false };
}

/**
 * Resolves what to do with locally-edited files that were deleted from the repo.
 * Similar to resolveConflicts but simpler: no diff view (there is no repo version to show).
 */
async function resolveDeleteConflicts(
  localPaths: string[],
  policy: ConflictPolicy
): Promise<{ shouldDelete: (localPath: string) => boolean; wasDismissed: boolean }> {
  const noop = { shouldDelete: () => false, wasDismissed: false };
  if (localPaths.length === 0) {
    return noop;
  }
  if (policy === "overwrite") {
    return { shouldDelete: () => true, wasDismissed: false };
  }
  if (policy === "skip") {
    return noop;
  }

  // For multiple files, offer a batched choice first; a single file goes straight
  // to per-file review ("Review each" with one item is the same thing).
  if (localPaths.length > 1) {
    const choice = await vscode.window.showWarningMessage(
      `${localPaths.length} setup files were removed from the shared repo but you've edited them locally. Delete anyway?`,
      { modal: true },
      "Delete all",
      "Keep all",
      "Review each"
    );

    if (choice === undefined) {
      return { shouldDelete: () => false, wasDismissed: true };
    }
    if (choice === "Delete all") {
      return { shouldDelete: () => true, wasDismissed: false };
    }
    if (choice === "Keep all") {
      return noop;
    }
    // "Review each" — fall through to per-file loop.
  }

  // Per-file dialog.
  const toDelete = new Set<string>();
  for (const localPath of localPaths) {
    const per = await vscode.window.showWarningMessage(
      `"${localPath}" was removed from the shared repo but you've edited it locally. Delete it?`,
      { modal: true },
      "Delete",
      "Keep mine"
    );
    if (per === undefined) {
      return { shouldDelete: (p) => toDelete.has(p), wasDismissed: true };
    }
    if (per === "Delete") {
      toDelete.add(localPath);
    }
  }
  return { shouldDelete: (p) => toDelete.has(p), wasDismissed: false };
}

function resultParts(r: SyncResult): string[] {
  const parts: string[] = [];
  if (r.added) parts.push(`${r.added} added`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.deleted) parts.push(`${r.deleted} deleted`);
  if (r.skipped) parts.push(`${r.skipped} kept`);
  if (r.keptDeleted) parts.push(`${r.keptDeleted} kept on disk`);
  return parts;
}

export function summarize(folderName: string, r: SyncResult): string {
  return `${folderName}: ${resultParts(r).join(", ")}.`;
}

export function toastSummary(r: SyncResult): string {
  return `${resultParts(r).join(", ")}.`;
}
