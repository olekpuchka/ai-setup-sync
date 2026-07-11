import * as vscode from "vscode";
import { gitBlobSha } from "./blobSha";
import { getRawFile, getTree, RepoRef, TreeEntry, ConfigError, RateLimitError } from "./github";
import { getState, saveState, SyncState, AckEntry, readAck } from "./state";
import { computePatterns, computeWorktreePatterns, upsertBlock, stripBlock, MARKER_BEGIN } from "./gitignore";
import { readRegistry, setWorkspaceFiles } from "./registry";
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
    // Surface typed errors (ConfigError, RateLimitError) directly so handleSyncError shows actionable UI.
    const typed = errors.find((e) => e instanceof ConfigError || e instanceof RateLimitError);
    if (typed) throw typed;
    const messages = errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    throw new Error(`${errors.length} file(s) failed to sync: ${messages}`);
  }
}

interface SyncOptions {
  repoRef: RepoRef;
  targetFolders: string[];
  /** Maps repo-relative source paths to workspace-relative destination paths. */
  pathMappings: Record<string, string>;
  /** Called after each file is downloaded, so callers can show sync progress. */
  onProgress?: (done: number, total: number) => void;
}

interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
  upToDate: number;
  deleted: number;
  /** Locally-edited files that were removed from the repo but kept on disk. */
  keptDeleted: number;
  /** True if nothing on disk changed (used to keep auto-sync quiet). */
  noChanges: boolean;
  /** True when the tree was fetched but no files matched the configured paths — likely a wrong branch or targetFolders. */
  noFilesFound: boolean;
  /** Workspace-relative paths of managed files whose local content diverges from the remote — these are removed from .git/info/exclude so git can see them. */
  locallyModifiedPaths: string[];
}

/**
 * Translates a repo-relative path to a workspace-relative path using pre-sorted
 * mapping entries (longest key first so more specific paths always win).
 */
function toLocalPath(repoPath: string, sortedMappings: [string, string][]): string {
  for (const [from, to] of sortedMappings) {
    if (repoPath === from) {
      return to || repoPath;
    }
    if (repoPath.startsWith(from + "/")) {
      const remainder = repoPath.slice(from.length + 1);
      return to ? to + "/" + remainder : remainder;
    }
  }
  return repoPath;
}

/**
 * Translates a repo-relative file map (as stored in SyncState) into the
 * workspace-relative paths actually on disk, applying pathMappings. The registry
 * stores local paths, but `state.files` is keyed by repo path — callers that fall
 * back to `state.files` for cleanup must localize first, or they target the wrong
 * paths (and silently delete nothing) when pathMappings is set.
 */
export function localizeStateFiles(
  files: Record<string, string>,
  pathMappings: Record<string, string>
): Record<string, string> {
  const sorted: [string, string][] = Object.entries(pathMappings).sort((a, b) => b[0].length - a[0].length);
  const out: Record<string, string> = {};
  for (const [repoPath, sha] of Object.entries(files)) {
    out[toLocalPath(repoPath, sorted)] = sha;
  }
  return out;
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

/** Returns true when the repo path is claimed by a pathMappings key (vs. a targetFolder). */
function isMatchedByMapping(repoPath: string, sortedMappings: [string, string][]): boolean {
  return sortedMappings.some(([from]) => repoPath === from || repoPath.startsWith(from + "/"));
}

function isSyncable(path: string, targetFolders: string[], mappings: Record<string, string>): boolean {
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

type Classification = "new" | "safe-update" | "conflict" | "acknowledged" | "up-to-date";

interface PlannedFile {
  entry: TreeEntry;
  /** Workspace-relative destination path (may differ from entry.path when pathMappings is set). */
  localPath: string;
  classification: Classification;
  /** True when the entry was matched by a pathMapping key rather than a targetFolder. */
  fromMapping?: boolean;
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
  const { repoRef, targetFolders, pathMappings } = options;
  // Sort once so every toLocalPath call in this sync run shares the same order.
  const sortedMappings: [string, string][] = Object.entries(pathMappings).sort((a, b) => b[0].length - a[0].length);
  const state = getState(context, workspaceFolder);

  const tree = await getTree(repoRef, state.treeEtag);

  // Cheap short-circuit: a 304 means the repo tree is byte-identical to the last
  // sync (and the request didn't count against the GitHub rate limit). The repo
  // is unchanged — but a file may have been deleted locally (restore it) or
  // edited locally without the repo changing (prompt the user).
  if (tree.notModified) {
    // One pass: detect missing and locally-modified files simultaneously (OPT-1).
    const missing: { repoPath: string; localPath: string }[] = [];
    const locallyModified: PlannedFile[] = [];
    const acknowledgedLocalPaths = new Set<string>();
    let syncableCount = 0;
    // Process mapping-matched state entries first so seenLocalPaths304 keeps the
    // mapping-priority winner for each local path, mirroring the plannedMap dedup logic
    // in the full-tree path. Prevents the 304 path from using a loser's SHA during the
    // transient window between a mapping change and the next full-tree sync.
    const sortedStateEntries = (Object.entries(state.files) as [string, string][]).sort(
      ([a], [b]) => {
        const aMap = isMatchedByMapping(a, sortedMappings);
        const bMap = isMatchedByMapping(b, sortedMappings);
        return aMap === bMap ? 0 : aMap ? -1 : 1;
      }
    );
    const seenLocalPaths304 = new Set<string>();
    for (const [repoPath, lastSyncedSha] of sortedStateEntries) {
      if (!isSyncable(repoPath, targetFolders, pathMappings)) {
        continue;
      }
      syncableCount++;
      const localPath = toLocalPath(repoPath, sortedMappings);
      validateLocalPath(localPath);
      // state.files may transiently have two repo paths mapping to the same local path
      // (before a full-tree sync cleans them up). Skip duplicates so we don't issue
      // concurrent writes to the same file or store a stale SHA in the registry.
      if (seenLocalPaths304.has(localPath)) {
        continue;
      }
      seenLocalPaths304.add(localPath);
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
      const onDisk = await readIfExists(fileUri);
      if (!onDisk) {
        missing.push({ repoPath, localPath });
        continue;
      }
      const localSha = gitBlobSha(onDisk);
      if (localSha !== lastSyncedSha) {
        if (readAck(state.acknowledged, repoPath)?.localSha !== localSha) {
          // entry.sha == lastSyncedSha because the repo hasn't changed (304).
          locallyModified.push({ entry: { path: repoPath, sha: lastSyncedSha, type: "blob" }, localPath, classification: "conflict" });
        } else {
          acknowledgedLocalPaths.add(localPath);
        }
      }
    }

    // Restore missing files (re-fetch from raw — no API cost).
    let addedCount = 0;
    if (missing.length > 0) {
      let done = 0;
      await parallelLimit(missing, DOWNLOAD_CONCURRENCY, async ({ repoPath, localPath }) => {
        const bytes = await getRawFile(repoRef, repoPath);
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
        const parentUri = vscode.Uri.joinPath(fileUri, "..");
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(fileUri, bytes);
        options.onProgress?.(++done, missing.length);
      });
      addedCount = missing.length;
      // Keep registry + gitignore in sync after restore.
      try {
        const localFiles: Record<string, string> = {};
        const seenLp = new Set<string>();
        for (const [repoPath, sha] of sortedStateEntries) {
          const lp = toLocalPath(repoPath, sortedMappings);
          validateLocalPath(lp);
          if (!seenLp.has(lp)) {
            seenLp.add(lp);
            localFiles[lp] = sha;
          }
        }
        const managedPaths = Object.keys(localFiles);
        // Locally-modified files are already visible to git — keep them out of the exclude.
        const modifiedLocalPaths304 = new Set([...locallyModified.map((p) => p.localPath), ...acknowledgedLocalPaths]);
        const excludePaths304 = managedPaths.filter((lp) => !modifiedLocalPaths304.has(lp));
        setWorkspaceFiles(workspaceFolder.uri.fsPath, localFiles);
        await applyGitExclude(workspaceFolder, excludePaths304.length > 0 ? [...excludePaths304, ".worktreeinclude"] : excludePaths304);
        await applyWorktreeInclude(workspaceFolder, managedPaths, targetFolders, pathMappings);
      } catch (err) {
        log(`Warning: failed to update registry/gitignore after restore: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const newAcknowledged: Record<string, AckEntry> = {};
    for (const k of Object.keys(state.acknowledged ?? {})) {
      const ack = readAck(state.acknowledged, k);
      if (ack) newAcknowledged[k] = ack;
    }
    let wasDismissed = false;
    let updatedCount = 0;
    let toOverwrite: typeof locallyModified = [];
    let toKeep: typeof locallyModified = [];

    if (locallyModified.length > 0) {
      const resolution = await resolveConflicts(locallyModified, repoRef, workspaceFolder);
      wasDismissed = resolution.wasDismissed;

      toOverwrite = locallyModified.filter((p) => resolution.shouldOverwrite(p.localPath));
      toKeep = locallyModified.filter((p) => !resolution.shouldOverwrite(p.localPath));

      // Always write files the user approved, even if they escaped on a later file.
      let done = 0;
      await parallelLimit(toOverwrite, DOWNLOAD_CONCURRENCY, async (p) => {
        const bytes = await getRawFile(repoRef, p.entry.path);
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, p.localPath);
        const parentUri = vscode.Uri.joinPath(fileUri, "..");
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(fileUri, bytes);
        delete newAcknowledged[p.entry.path];
        options.onProgress?.(++done, toOverwrite.length);
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
            newAcknowledged[p.entry.path] = { localSha: gitBlobSha(onDisk), repoSha: p.entry.sha };
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

      // Update exclude: overwritten files go back in; kept files stay visible to git.
      try {
        const keptLocalPaths = new Set([...toKeep.map((p) => p.localPath), ...acknowledgedLocalPaths]);
        const allLocalPaths: string[] = [];
        const seen304 = new Set<string>();
        for (const [repoPath] of sortedStateEntries) {
          if (!isSyncable(repoPath, targetFolders, pathMappings)) continue;
          const lp = toLocalPath(repoPath, sortedMappings);
          if (!seen304.has(lp)) { seen304.add(lp); allLocalPaths.push(lp); }
        }
        const excludeAfter304 = allLocalPaths.filter((lp) => !keptLocalPaths.has(lp));
        await applyGitExclude(workspaceFolder, excludeAfter304.length > 0 ? [...excludeAfter304, ".worktreeinclude"] : excludeAfter304);
      } catch (err) {
        log(`Warning: failed to update git exclude after 304 conflict resolution: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      locallyModifiedPaths: [...toKeep.map((p) => p.localPath), ...acknowledgedLocalPaths],
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
  // When two repo paths translate to the same local path (e.g. root .github/ and
  // projectA/.github/ both targeting .github/), the pathMapping-sourced entry wins
  // over the targetFolder-sourced one. Between same-priority entries the first wins
  // (GitHub tree order is stable), so the result is always deterministic.
  // Repo paths that lose the dedup are collected so their stale state entries can be
  // pruned from newState.files — otherwise they accumulate and corrupt the registry.
  // Priority-aware local-path → sha lookup from prior state. Used as a fallback when the
  // current winner's repo path was never previously tracked (mapping change). Two passes
  // mirror the plannedMap priority: mapping entries win over targetFolder entries, with
  // first-in-insertion-order as the tiebreaker within each tier.
  const stateByLocalPath = new Map<string, string>();
  for (const [rp, sha] of Object.entries(state.files)) {
    const lp = toLocalPath(rp, sortedMappings);
    if (!stateByLocalPath.has(lp) && isMatchedByMapping(rp, sortedMappings)) {
      stateByLocalPath.set(lp, sha);
    }
  }
  for (const [rp, sha] of Object.entries(state.files)) {
    const lp = toLocalPath(rp, sortedMappings);
    if (!stateByLocalPath.has(lp)) {
      stateByLocalPath.set(lp, sha);
    }
  }

  const plannedMap = new Map<string, PlannedFile>();
  const skippedRepoPaths = new Set<string>();
  // Maps each loser repo path to the local path it shares with the winner, so we can
  // conditionally prune it only after confirming the winner was successfully written.
  const skippedToLocalPath = new Map<string, string>();
  for (const entry of entries) {
    const localPath = toLocalPath(entry.path, sortedMappings);
    validateLocalPath(localPath);
    const fromMapping = isMatchedByMapping(entry.path, sortedMappings);
    const existing = plannedMap.get(localPath);
    if (existing && (existing.fromMapping || !fromMapping)) {
      skippedRepoPaths.add(entry.path);
      skippedToLocalPath.set(entry.path, localPath);
      continue;
    }
    // If this entry displaces an existing lower-priority entry, track that one as skipped too.
    if (existing) {
      skippedRepoPaths.add(existing.entry.path);
      skippedToLocalPath.set(existing.entry.path, localPath);
    }
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
    const onDisk = await readIfExists(fileUri);
    if (!onDisk) {
      plannedMap.set(localPath, { entry, localPath, classification: "new", fromMapping });
      continue;
    }
    const localSha = gitBlobSha(onDisk);
    if (localSha === entry.sha) {
      plannedMap.set(localPath, { entry, localPath, classification: "up-to-date", fromMapping });
      continue;
    }
    const lastSynced = state.files[entry.path] ?? stateByLocalPath.get(localPath);
    if (lastSynced && lastSynced === localSha) {
      // On disk matches what we wrote last time → user didn't touch it.
      plannedMap.set(localPath, { entry, localPath, classification: "safe-update", fromMapping });
    } else {
      // Local content diverges from both repo and our last write.
      // If the user previously said "Keep mine" and neither side has changed since,
      // skip the prompt and carry the acknowledgement forward silently.
      const ack = readAck(state.acknowledged, entry.path);
      if (ack && ack.localSha === localSha && ack.repoSha === entry.sha) {
        plannedMap.set(localPath, { entry, localPath, classification: "acknowledged", fromMapping });
      } else {
        plannedMap.set(localPath, { entry, localPath, classification: "conflict", fromMapping });
      }
    }
  }
  const planned = [...plannedMap.values()];

  const conflicts = planned.filter((p) => p.classification === "conflict");
  const { shouldOverwrite: overwriteConflict, wasDismissed } = await resolveConflicts(
    conflicts,
    repoRef,
    workspaceFolder
  );

  // Managed files whose local content diverges from the remote (kept mine / acknowledged).
  // These are removed from .git/info/exclude so they show up in git status/diff immediately.
  const locallyModifiedLocalPaths = new Set(
    planned
      .filter(
        (p) =>
          p.classification === "acknowledged" ||
          (p.classification === "conflict" && !overwriteConflict(p.localPath))
      )
      .map((p) => p.localPath)
  );

  // Files that are removed from the repo but were previously synced by us.
  const allRepoPaths = new Set(tree.entries.map((e) => e.path));
  const remotePaths = new Set(entries.map((e) => e.path));
  // Exclude skipped (dedup-loser) paths: if a loser's repo path also disappears from the
  // tree in the same sync, removedInRepo would otherwise target the winner's live local file.
  const removedInRepo = Object.keys(state.files).filter(
    (p) => !remotePaths.has(p) && !allRepoPaths.has(p) && !skippedRepoPaths.has(p)
  );
  // Previously synced files still in the repo but now excluded by targetFolders/pathMappings.
  // Treat identically to removedInRepo: unmodified copies are deleted silently, locally-
  // edited copies go through the conflict prompt so the user decides what to keep.
  const excludedBySettings = Object.keys(state.files).filter(
    (p) => !remotePaths.has(p) && allRepoPaths.has(p) && !skippedRepoPaths.has(p)
  );

  const result: SyncResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    upToDate: 0,
    deleted: 0,
    keptDeleted: 0,
    noChanges: true,
    noFilesFound: entries.length === 0,
    locallyModifiedPaths: [],
  };

  // acknowledged is rebuilt entry-by-entry in the loop below: files classified
  // "acknowledged" carry their ack forward; files kept via the conflict dialog
  // write a fresh ack. Everything else (overwritten, up-to-date, new) gets none.
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
    } else if (p.classification === "acknowledged") {
      // User previously said "Keep mine" and neither local nor upstream changed — skip silently.
      result.upToDate++;
      newState.files[p.entry.path] = p.entry.sha;
      if (!newState.acknowledged) newState.acknowledged = {};
      newState.acknowledged[p.entry.path] = readAck(state.acknowledged, p.entry.path)!;
    } else if (p.classification === "conflict" && !overwriteConflict(p.localPath)) {
      if (!wasDismissed) {
        result.skipped++;
        fileLog.push(`  ${p.localPath} (kept — your edits)`);
        // Store an ack so subsequent syncs (304 or full-tree) won't re-prompt as long
        // as neither the local file nor the upstream file changes.
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, p.localPath);
        const onDisk = await readIfExists(fileUri);
        if (onDisk) {
          if (!newState.acknowledged) newState.acknowledged = {};
          newState.acknowledged[p.entry.path] = { localSha: gitBlobSha(onDisk), repoSha: p.entry.sha };
        }
      }
      newState.files[p.entry.path] = p.entry.sha;
    } else {
      toWrite.push(p);
    }
  }

  // Write files; save state even on partial failure so progress is not lost (BUG-4).
  let syncError: unknown;
  try {
    let writeProgress = 0;
    await parallelLimit(toWrite, DOWNLOAD_CONCURRENCY, async (p) => {
      const bytes = await getRawFile(repoRef, p.entry.path);
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, p.localPath);
      const parentUri = vscode.Uri.joinPath(fileUri, "..");
      await vscode.workspace.fs.createDirectory(parentUri);
      await vscode.workspace.fs.writeFile(fileUri, bytes);
      options.onProgress?.(++writeProgress, toWrite.length);
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

  // Prune loser repo paths from state, but only when their winner was successfully written.
  // If the winner's download failed, leave the loser in state so the next sync retries
  // rather than zeroing tracking for that local path entirely.
  for (const [loserPath, localPath] of skippedToLocalPath) {
    const winner = plannedMap.get(localPath);
    if (!winner || newState.files[winner.entry.path] === winner.entry.sha) {
      delete newState.files[loserPath];
    }
  }

  // Delete files removed from the repo, plus files excluded by the current target folder /
  // path mapping settings. Unmodified files are deleted silently; locally-edited ones are
  // prompted before deletion.
  let deleteWasDismissed = false;
  const allRemovedPaths = [...removedInRepo, ...excludedBySettings];
  if (allRemovedPaths.length > 0) {
    type RemovedEntry = { repoPath: string; localPath: string };
    const safeToDelete: RemovedEntry[] = [];
    const editedAndRemoved: RemovedEntry[] = [];

    await parallelLimit(allRemovedPaths, DISK_CONCURRENCY, async (repoPath) => {
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
    const deleteResolution = await resolveDeleteConflicts(editedLocalPaths);
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
          fileLog.push(`  ${localPath} (kept — no longer synced)`);
          // User explicitly chose to keep — stop tracking so we don't re-prompt next sync.
          delete newState.files[repoPath];
        }
        // If dismissed (Escape), leave in state so the next sync re-prompts.
      }
    }

    // Remove directories that became empty after file deletions (deepest first).
    await pruneEmptyParentDirs(deletedLocalPaths, workspaceFolder.uri, fileLog);
  }

  // If the user dismissed any conflict prompt (Escape/X) without making a
  // choice, don't cache the tree ETag — the next sync must re-fetch the tree
  // and re-offer the dialog.
  // Note: acknowledged entries are preserved inline during the main loop above
  // (the "acknowledged" classification) — no separate carry-over step needed.
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
  // Dedup: if newState.files still has both a winner and a loser for the same local path
  // (e.g. the winner's write failed and the loser was kept), first-wins is safe enough —
  // the next full-tree sync will normalise state and rebuild the registry correctly.
  const localFiles: Record<string, string> = {};
  const seenRegistryPaths = new Set<string>();
  for (const [repoPath, sha] of Object.entries(newState.files)) {
    const lp = toLocalPath(repoPath, sortedMappings);
    validateLocalPath(lp);
    if (!seenRegistryPaths.has(lp)) {
      seenRegistryPaths.add(lp);
      localFiles[lp] = sha;
    }
  }
  // Detect orphaned local files: paths tracked in the previous registry that are no
  // longer in the new one. This happens when a pathMapping value changes (file moves
  // to a new local path, old copy left behind) or its key is removed (file excluded
  // but toLocalPath computed the wrong path so the allRemovedPaths loop missed it).
  // Only delete unmodified copies — if the user edited the file, leave it alone.
  const prevRegFiles = readRegistry().workspaces[workspaceFolder.uri.fsPath]?.files ?? {};
  const orphanedLocalPaths = Object.keys(prevRegFiles).filter((lp) => !(lp in localFiles));
  if (orphanedLocalPaths.length > 0) {
    const orphanDeletedPaths: string[] = [];
    await parallelLimit(orphanedLocalPaths, DISK_CONCURRENCY, async (localPath) => {
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, localPath);
      const onDisk = await readIfExists(fileUri);
      if (!onDisk) {
        return; // already gone
      }
      if (gitBlobSha(onDisk) !== prevRegFiles[localPath]) {
        return; // user edited it — leave it alone
      }
      try {
        await vscode.workspace.fs.delete(fileUri, { useTrash: false });
        result.deleted++;
        fileLog.push(`  ${localPath} (deleted — path mapping changed)`);
        orphanDeletedPaths.push(localPath);
      } catch (err) {
        log(`Warning: could not delete ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    // Remove directories that became empty after orphan deletions.
    await pruneEmptyParentDirs(orphanDeletedPaths, workspaceFolder.uri, fileLog);
  }

  try {
    const managedPaths = Object.keys(localFiles);
    // Locally-modified files are removed from the exclude block so they surface in git
    // status/diff. Everything else stays hidden to avoid polluting the project's git state.
    const excludePaths = managedPaths.filter((lp) => !locallyModifiedLocalPaths.has(lp));
    setWorkspaceFiles(workspaceFolder.uri.fsPath, localFiles);
    await applyGitExclude(workspaceFolder, excludePaths.length > 0 ? [...excludePaths, ".worktreeinclude"] : excludePaths);
    await applyWorktreeInclude(workspaceFolder, managedPaths, targetFolders, pathMappings);
  } catch (err) {
    log(`Warning: failed to update registry/gitignore: ${err instanceof Error ? err.message : String(err)}`);
  }

  result.locallyModifiedPaths = [...locallyModifiedLocalPaths];
  result.noChanges = result.added === 0 && result.updated === 0 && result.deleted === 0 && result.keptDeleted === 0;
  return result;
}

/**
 * Inserts/updates (or removes) the managed ignore block in the repo's LOCAL
 * exclude file (`.git/info/exclude`). Using the local exclude rather than a
 * tracked `.gitignore` means the rules never show up as a change to commit.
 * No-ops if the workspace is not a plain git repository.
 */
export async function applyGitExclude(
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

/**
 * Inserts/updates (or removes) the managed block in `.worktreeinclude` at the
 * workspace root. Claude Code reads this file when creating worktrees and copies
 * any matching gitignored files into the new worktree — ensuring synced AI config
 * files are available in isolated worktree sessions. No-ops if the workspace is
 * not a plain git repository.
 *
 * `.worktreeinclude` itself is added to `.git/info/exclude` by the caller so it
 * never shows up as an untracked change.
 */
async function applyWorktreeInclude(
  workspaceFolder: vscode.WorkspaceFolder,
  managedPaths: string[],
  targetFolders: string[],
  pathMappings: Record<string, string>
): Promise<void> {
  const gitDir = vscode.Uri.joinPath(workspaceFolder.uri, ".git");
  try {
    const stat = await vscode.workspace.fs.stat(gitDir);
    if (!(stat.type & vscode.FileType.Directory)) {
      return;
    }
  } catch {
    return; // not a git repo
  }

  const includeUri = vscode.Uri.joinPath(workspaceFolder.uri, ".worktreeinclude");
  const existing = (await readIfExists(includeUri))?.toString("utf8") ?? "";

  if (managedPaths.length === 0) {
    // No managed files — strip our block; delete the file if nothing else remains.
    if (!existing.includes(MARKER_BEGIN)) {
      return;
    }
    const stripped = stripBlock(existing);
    if (stripped.trim() === "") {
      await vscode.workspace.fs.delete(includeUri, { useTrash: false });
    } else {
      await vscode.workspace.fs.writeFile(includeUri, Buffer.from(stripped, "utf8"));
    }
    return;
  }

  const next = upsertBlock(existing, computeWorktreePatterns(managedPaths, targetFolders, Object.values(pathMappings)));
  if (next !== undefined) {
    await vscode.workspace.fs.writeFile(includeUri, Buffer.from(next, "utf8"));
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
 * on the next sync. An explicit "Keep mine" is not a dismissal.
 */
async function resolveConflicts(
  conflicts: PlannedFile[],
  repoRef: RepoRef,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<ConflictResolution> {
  const noop: ConflictResolution = { shouldOverwrite: () => false, wasDismissed: false };
  if (conflicts.length === 0) {
    return noop;
  }

  // For multiple files offer a batched choice first; for a single
  // file go straight to per-file review ("Review each" with one item is the same thing).
  const overwrite = new Set<string>();

  if (conflicts.length > 1) {
    const choice = await vscode.window.showWarningMessage(
      `${conflicts.length} setup files you edited locally differ from the repository. What would you like to do?`,
      { modal: true },
      "Review each",
      "Overwrite all",
      "Keep mine"
    );

    if (choice === undefined) {
      return { shouldOverwrite: () => false, wasDismissed: true };
    }
    if (choice === "Overwrite all") {
      conflicts.forEach((c) => overwrite.add(c.localPath));
      return { shouldOverwrite: (p) => overwrite.has(p), wasDismissed: false };
    }
    if (choice === "Keep mine") {
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
          try {
            await showFileDiff(c, repoRef, workspaceFolder);
            currentDiff = c.localPath;
            diffShown = true;
          } catch (diffErr) {
            void vscode.window.showErrorMessage(diffErr instanceof Error ? diffErr.message : String(diffErr));
          }
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
  localPaths: string[]
): Promise<{ shouldDelete: (localPath: string) => boolean; wasDismissed: boolean }> {
  const noop = { shouldDelete: () => false, wasDismissed: false };
  if (localPaths.length === 0) {
    return noop;
  }

  // For multiple files, offer a batched choice first; a single file goes straight
  // to per-file review ("Review each" with one item is the same thing).
  if (localPaths.length > 1) {
    const choice = await vscode.window.showWarningMessage(
      `${localPaths.length} setup files are no longer synced (removed from the repo or excluded by your settings) but you've edited them locally. Delete them?`,
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
      `"${localPath}" is no longer synced (removed from the repo or excluded by your settings) but you've edited it locally. Delete it?`,
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

async function pruneEmptyParentDirs(
  deletedPaths: string[],
  rootUri: vscode.Uri,
  fileLog: string[]
): Promise<void> {
  if (deletedPaths.length === 0) return;
  const dirCandidates = new Set<string>();
  for (const localPath of deletedPaths) {
    let dir = localPath.includes("/") ? localPath.slice(0, localPath.lastIndexOf("/")) : "";
    while (dir) {
      dirCandidates.add(dir);
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
  }
  for (const dir of [...dirCandidates].sort((a, b) => b.length - a.length)) {
    const dirUri = vscode.Uri.joinPath(rootUri, dir);
    try {
      if ((await vscode.workspace.fs.readDirectory(dirUri)).length === 0) {
        await vscode.workspace.fs.delete(dirUri, { useTrash: false });
        fileLog.push(`  ${dir}/ (directory removed)`);
      }
    } catch {
      // Directory already gone or inaccessible — skip.
    }
  }
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

function summarize(folderName: string, r: SyncResult): string {
  return `${folderName}: ${resultParts(r).join(", ")}.`;
}

export function toastSummary(r: SyncResult): string {
  return `${resultParts(r).join(", ")}.`;
}
