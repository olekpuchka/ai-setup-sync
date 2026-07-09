import * as vscode from "vscode";
import { removeManagedFiles } from "./cleanup";
import { ConfigError, RateLimitError, RepoRef } from "./github";
import { initOutput, log, showOutput } from "./output";
import { readRegistry, setWorkspaceFiles } from "./registry";
import { getState, saveState } from "./state";
import { localizeStateFiles, toastSummary, syncFolder, applyGitExclude } from "./sync";
import { gitBlobSha } from "./blobSha";
import { REMOTE_SCHEME, remoteContentProvider } from "./remoteContent";
import { deleteToken, getToken, setToken } from "./token";

const CONFIG = "aiSetupSync";

// --- Status bar -----------------------------------------------------------

let statusBar: vscode.StatusBarItem | undefined;
let lastSyncSuccessAt: number | undefined;

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

function setStatus(
  state: "idle" | "syncing" | "error" | "unconfigured",
  detail?: string
): void {
  if (!statusBar) {
    return;
  }
  switch (state) {
    case "syncing":
      statusBar.text = "$(sync~spin) AI Setup Sync";
      statusBar.tooltip = "Syncing…";
      statusBar.backgroundColor = undefined;
      break;
    case "error":
      statusBar.text = "$(warning) AI Setup Sync";
      statusBar.tooltip = `Sync failed: ${detail ?? "unknown error"}\nClick to retry.`;
      statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      break;
    case "unconfigured":
      statusBar.text = "$(gear) AI Setup Sync";
      statusBar.tooltip = "No repository configured. Click to set up.";
      statusBar.backgroundColor = undefined;
      break;
    default:
      statusBar.text = "$(check) AI Setup Sync";
      statusBar.tooltip =
        (lastSyncSuccessAt ? `Synced ${relativeTime(lastSyncSuccessAt)}` : "Ready") +
        (detail ? ` • ${detail}` : "") +
        "\nClick to sync now.";
      statusBar.backgroundColor = undefined;
  }
}

const DEFAULT_TARGET_FOLDERS = [
  // Claude Code
  ".claude", "CLAUDE.md", ".mcp.json",
  // GitHub Copilot / VS Code
  ".github", ".vscode/mcp.json",
  // Cursor
  ".cursor",
  // OpenAI Codex + shared agent standard
  ".codex", ".agents", "AGENTS.md",
  // Gemini CLI
  ".gemini", "GEMINI.md",
];
const DEFAULT_TARGET_MAP: Record<string, boolean> = Object.fromEntries(DEFAULT_TARGET_FOLDERS.map((f) => [f, true]));

interface Settings {
  repository: string;
  branch: string;
  targetFolders: string[];
  pathMappings: Record<string, string>;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(CONFIG);
  const raw = c.get<Record<string, boolean>>("targetFolders");
  const merged = raw && typeof raw === "object" ? { ...DEFAULT_TARGET_MAP, ...raw } : DEFAULT_TARGET_MAP;
  const targetFolders = Object.entries(merged).filter(([, on]) => on).map(([f]) => f.replace(/\/+$/, ""));
  // Normalize trailing slashes on both keys and values to prevent silent mismatches.
  const rawMappings = c.get<Record<string, string>>("pathMappings") ?? {};
  const pathMappings: Record<string, string> = {};
  for (const [from, to] of Object.entries(rawMappings)) {
    if (typeof from === "string" && typeof to === "string") {
      pathMappings[from.replace(/\/+$/, "")] = to.replace(/\/+$/, "");
    }
  }
  return {
    repository: (c.get<string>("repository") ?? "").trim(),
    branch: (c.get<string>("branch") ?? "main").trim() || "main",
    targetFolders,
    pathMappings,
  };
}

/** Extracts the repo slug (owner/name) from a repository URL. Accepts github.com and GitHub Enterprise Server URLs. Returns null if the URL is invalid. */
function parseRepo(raw: string): string | null {
  const m = raw.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// File watcher — detects edits to managed files and immediately removes them
// from .git/info/exclude so they surface in git status / diff.
// ---------------------------------------------------------------------------

interface WatcherState {
  /** localPath → remote blob SHA (the SHA last synced from the AI setup repo) */
  managedFiles: Record<string, string>;
  /** Paths currently visible to git because their content diverges from remote */
  modifiedPaths: Set<string>;
  disposables: vscode.Disposable[];
}

const workspaceWatchers = new Map<string, WatcherState>();

function refreshWatcher(
  folder: vscode.WorkspaceFolder,
  managedFiles: Record<string, string>,
  initialModifiedPaths: string[]
): void {
  // Dispose previous watcher for this folder.
  const prev = workspaceWatchers.get(folder.uri.fsPath);
  if (prev) {
    prev.disposables.forEach((d) => d.dispose());
  }

  if (Object.keys(managedFiles).length === 0) {
    workspaceWatchers.delete(folder.uri.fsPath);
    return;
  }

  const modifiedPaths = new Set(initialModifiedPaths);
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
    if (syncing) return;

    const excludePaths = Object.keys(managedFiles).filter((p) => !modifiedPaths.has(p));
    await applyGitExclude(
      folder,
      excludePaths.length > 0 ? [...excludePaths, ".worktreeinclude"] : excludePaths
    ).catch((err) =>
      log(`Warning: failed to update git exclude: ${err instanceof Error ? err.message : String(err)}`)
    );
  };

  const handleChange = (uri: vscode.Uri): void => {
    pending = pending.then(() => handleChangeSingle(uri)).catch(() => {});
  };

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, "**")
  );
  disposables.push(watcher.onDidChange(handleChange));
  disposables.push(watcher.onDidCreate(handleChange));
  disposables.push(watcher.onDidDelete(handleChange));
  disposables.push(watcher);

  workspaceWatchers.set(folder.uri.fsPath, { managedFiles, modifiedPaths, disposables });
}

/** A re-entrancy guard so overlapping triggers don't sync the same folders twice. */
let syncing = false;
/** When rate-limited, background syncs/checks pause until this epoch ms. */
let rateLimitedUntil = 0;
/** Minimum gap between focus-triggered syncs, so rapid alt-tabbing doesn't re-sync. */
const FOCUS_RESYNC_MIN_MS = 10 * 60 * 1000; // 10 minutes
/** Debounce before re-syncing after a content-affecting setting change settles. */
const CONFIG_RESYNC_DEBOUNCE_MS = 1500;
/** Timestamp of the last committed sync *attempt* (success or failure); throttles focus syncs. */
let lastSyncAttemptAt = 0;

/** Centralized handling for a failed sync. Returns nothing; sets status + logs. */
function handleSyncError(err: unknown, interactive: boolean): void {
  const msg = err instanceof Error ? err.message : String(err);
  log(`Sync failed: ${msg}`);

  if (err instanceof RateLimitError) {
    if (err.isSso) {
      // SSO is a one-time auth action, not a rate limit — don't back off background syncs.
      setStatus("error", "SSO authorization required");
      if (interactive) {
        const buttons = err.ssoUrl ? ["Authorize SSO", "Set GitHub Token"] : ["Set GitHub Token"];
        void vscode.window.showWarningMessage(msg, ...buttons).then((choice) => {
          if (choice === "Authorize SSO" && err.ssoUrl) {
            void vscode.env.openExternal(vscode.Uri.parse(err.ssoUrl));
          } else if (choice === "Set GitHub Token") {
            void vscode.commands.executeCommand(`${CONFIG}.setGitHubToken`);
          }
        });
      }
    } else {
      // Back off all background activity until the rate limit resets.
      rateLimitedUntil = err.resetAt ?? Date.now() + 60 * 60 * 1000;
      setStatus("error", "GitHub rate limit");
      if (interactive) {
        void vscode.window
          .showWarningMessage(msg, "Set GitHub Token")
          .then((choice) => {
            if (choice) {
              void vscode.commands.executeCommand(`${CONFIG}.setGitHubToken`);
            }
          });
      }
    }
    return;
  }

  setStatus("error", msg);
  if (interactive) {
    if (err instanceof ConfigError) {
      if (err.needsToken) {
        void vscode.window.showErrorMessage(`AI Setup Sync: ${msg}`, "Set GitHub Token").then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand(`${CONFIG}.setGitHubToken`);
          }
        });
      } else {
        void vscode.window.showErrorMessage(`AI Setup Sync: ${msg}`, "Open settings").then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand("workbench.action.openSettings", err.setting ?? `${CONFIG}.repository`);
          }
        });
      }
    } else {
      void vscode.window.showErrorMessage(`AI Setup Sync: sync failed: ${msg}`);
    }
  }
}

async function runSync(
  context: vscode.ExtensionContext,
  interactive: boolean
): Promise<void> {
  if (syncing) {
    return;
  }
  // Honor an active rate-limit backoff for background runs; a manual run always tries.
  if (!interactive && Date.now() < rateLimitedUntil) {
    return;
  }
  const settings = readSettings();
  if (!settings.repository) {
    setStatus("unconfigured");
    if (interactive) {
      const choice = await vscode.window.showWarningMessage(
        "AI Setup Sync: No repository configured — add a GitHub repository URL in settings to start syncing.",
        "Open settings"
      );
      if (choice) {
        await vscode.commands.executeCommand("workbench.action.openSettings", `${CONFIG}.repository`);
      }
    }
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (interactive) {
      void vscode.window.showInformationMessage(
        "AI Setup Sync: Open a folder first — there's nowhere to sync files to."
      );
    }
    return;
  }

  if (settings.repository && !parseRepo(settings.repository)) {
    const msg = `AI Setup Sync: '${settings.repository}' is not a valid GitHub repository URL. Expected: https://github.com/your-org/your-repo or https://ghe.company.com/your-org/your-repo`;
    log(msg);
    setStatus("error", msg);
    if (interactive) {
      void vscode.window.showErrorMessage(msg, "Open settings").then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand("workbench.action.openSettings", `${CONFIG}.repository`);
        }
      });
    }
    return;
  }

  const runSyncFolders = async (repoRef: RepoRef) => {
    const summaries: string[] = [];
    let changed = false;
    let noFilesFound = false;
    let hadError = false;
    for (const folder of folders) {
      // Isolate each folder: an error in the repo-change cleanup or the sync itself
      // skips just this folder, not the rest of the workspace.
      try {
        // Detect repo URL change — prompt to clean up files from the previous repo.
        const prevState = getState(context, folder);
        if (prevState.repoUrl && prevState.repoUrl !== settings.repository && Object.keys(prevState.files).length > 0) {
          // Changing the repo is rare and deliberate, so it's worth prompting to clean up
          // the previous repo's files — it's the only moment that decision is offered.
          const choice = await vscode.window.showWarningMessage(
            `AI Setup Sync: Repository changed to ${settings.repository}. Remove files synced from the previous repo?`,
            { modal: true },
            "Remove",
            "Keep"
          );
          if (choice === undefined) {
            continue; // dismissed — skip this folder
          }
          if (choice === "Remove") {
            const reg = readRegistry();
            // Registry holds local (on-disk) paths; state.files is keyed by repo
            // path, so localize the fallback before deleting (matters with pathMappings).
            const files =
              reg.workspaces[folder.uri.fsPath]?.files ??
              localizeStateFiles(prevState.files, settings.pathMappings);
            const removed = removeManagedFiles(folder.uri.fsPath, files);
            if (removed.keptPaths.length > 0) {
              log(`Kept ${removed.keptPaths.length} file(s) with local edits during repo change:`);
              for (const rel of removed.keptPaths) {
                log(`  ${folder.name}/${rel} (kept — your edits)`);
              }
            }
          }
          await saveState(context, folder, { ref: "", files: {} });
          setWorkspaceFiles(folder.uri.fsPath, {});
        }

        const result = await syncFolder(
          context,
          folder,
          {
            repoRef,
            targetFolders: settings.targetFolders,
            pathMappings: settings.pathMappings,
          }
        );
        // Refresh the file watcher so edits to managed files surface in git immediately.
        const reg = readRegistry();
        refreshWatcher(folder, reg.workspaces[folder.uri.fsPath]?.files ?? {}, result.locallyModifiedPaths);
        if (result.noFilesFound) {
          noFilesFound = true;
        } else if (!result.noChanges) {
          changed = true;
          summaries.push(toastSummary(result));
        }
      } catch (err) {
        handleSyncError(err, interactive);
        hadError = true;
        // Preserve any pre-existing locally-modified paths so they stay visible in git.
        const regErr = readRegistry();
        const errFiles = regErr.workspaces[folder.uri.fsPath]?.files ?? {};
        const prevWatcher = workspaceWatchers.get(folder.uri.fsPath);
        const prevModified = prevWatcher
          ? [...prevWatcher.modifiedPaths].filter((p) => errFiles[p] !== undefined)
          : [];
        refreshWatcher(folder, errFiles, prevModified);
      }
    }

    if (hadError) {
      // handleSyncError already set the error status (and any rate-limit
      // backoff) for the failed folder(s); don't overwrite them with a success
      // state, and don't clear the backoff we may have just armed.
      return;
    }

    lastSyncSuccessAt = Date.now();
    rateLimitedUntil = 0; // we got through; clear any backoff
    setStatus("idle", settings.repository);
    if (noFilesFound) {
      void vscode.window.showWarningMessage(
        `AI Setup Sync: No files found to sync. Check that "${settings.branch}" is the correct branch and that the paths in Target Folders exist in your repo.`,
        "Open settings"
      ).then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand("workbench.action.openSettings", `${CONFIG}.branch`);
        }
      });
    } else if (changed && summaries.length > 0) {
      void vscode.window.showInformationMessage(
        `AI Setup Sync: ${summaries.join(" ")}`,
        "Show details"
      ).then((choice) => {
        if (choice === "Show details") {
          showOutput();
        }
      });
    }
  };

  // Claim the sync slot and stamp the attempt before the first await, so concurrent
  // triggers (open, focus, token-save, settings-change) can't race past the `syncing`
  // guard above, and so a failing background sync still throttles the focus trigger.
  syncing = true;
  lastSyncAttemptAt = Date.now();
  setStatus("syncing");
  try {
    const token = await getToken(context);
    const repoRef: RepoRef = { repo: parseRepo(settings.repository) ?? "", url: settings.repository, ref: settings.branch, token };
    await runSyncFolders(repoRef);
  } catch (err) {
    // Per-folder failures are handled inside runSyncFolders; this catches the rest
    // (e.g. getToken rejecting on a locked keychain) so the status bar shows an error
    // instead of spinning forever on "syncing".
    handleSyncError(err, interactive);
  } finally {
    syncing = false;
  }
}

/** Removes the synced setup files from the open workspace(s), preserving local edits. */
async function removeSyncedFiles(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage("AI Setup Sync: Open a folder first — there's nowhere to sync files to.");
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    "AI Setup Sync: Remove synced setup files from this project? Files you edited locally will be kept.",
    { modal: true },
    "Remove"
  );
  if (confirm !== "Remove") {
    return;
  }

  const settings = readSettings();
  const reg = readRegistry();
  const allKeptPaths: Array<{ folder: vscode.WorkspaceFolder; rel: string }> = [];
  const allDeletedPaths: Array<{ folder: vscode.WorkspaceFolder; rel: string }> = [];

  for (const folder of folders) {
    // Registry holds local (on-disk) paths; state.files is keyed by repo path,
    // so localize the fallback before deleting (matters with pathMappings).
    const files =
      reg.workspaces[folder.uri.fsPath]?.files ??
      localizeStateFiles(getState(context, folder).files, settings.pathMappings);
    if (!files || Object.keys(files).length === 0) {
      continue;
    }
    const summary = removeManagedFiles(folder.uri.fsPath, files);
    for (const rel of summary.keptPaths) {
      allKeptPaths.push({ folder, rel });
    }
    for (const rel of summary.deletedPaths) {
      allDeletedPaths.push({ folder, rel });
    }
    setWorkspaceFiles(folder.uri.fsPath, {});
    refreshWatcher(folder, {}, []);
    await saveState(context, folder, { ref: "", files: {} });
  }

  const deleted = allDeletedPaths.length;
  const kept = allKeptPaths.length;
  if (deleted > 0 || kept > 0) {
    if (deleted > 0) {
      log(`Removed ${deleted} synced file(s):`);
      for (const { folder, rel } of allDeletedPaths) {
        log(`  ${folder.name}/${rel} (deleted)`);
      }
    }
    if (kept > 0) {
      log(`Kept ${kept} file(s) with local edits:`);
      for (const { folder, rel } of allKeptPaths) {
        log(`  ${folder.name}/${rel} (kept — your edits)`);
      }
    }
  } else {
    log(`Removed 0 synced files.`);
  }

  const showDetails = (choice: string | undefined) => { if (choice === "Show details") { showOutput(); } };
  if (kept > 0) {
    void vscode.window.showWarningMessage(
      deleted > 0
        ? `AI Setup Sync: Removed ${deleted} ${deleted === 1 ? "file" : "files"}, kept ${kept} with local edits.`
        : `AI Setup Sync: ${kept} ${kept === 1 ? "file" : "files"} kept due to local edits.`,
      "Show details"
    ).then(showDetails);
  } else if (deleted > 0) {
    void vscode.window.showInformationMessage(
      `AI Setup Sync: Removed ${deleted} synced ${deleted === 1 ? "file" : "files"}.`,
      "Show details"
    ).then(showDetails);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settings = readSettings();

  initOutput(context);
  log(`Activated. Source: ${settings.repository || "(unconfigured)"}@${settings.branch}.`);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = `${CONFIG}.syncNow`;
  setStatus(settings.repository ? "idle" : "unconfigured");
  statusBar.show();
  context.subscriptions.push(statusBar);
  context.subscriptions.push({
    dispose: () => {
      for (const state of workspaceWatchers.values()) {
        state.disposables.forEach((d) => d.dispose());
      }
      workspaceWatchers.clear();
    },
  });

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, remoteContentProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG}.syncNow`, () =>
      runSync(context, true)
    ),
    vscode.commands.registerCommand(`${CONFIG}.removeSyncedFiles`, () =>
      removeSyncedFiles(context)
    ),
    vscode.commands.registerCommand(`${CONFIG}.setGitHubToken`, async () => {
      const existing = await getToken(context);
      const input = await vscode.window.showInputBox({
        title: "AI Setup Sync: Set GitHub Token",
        prompt: existing
          ? "A token is already saved. Enter a new one to replace it, or leave blank to remove it."
          : "Enter a classic GitHub personal access token with the 'repo' scope (fine-grained tokens don't support this scope). Required for private repos, SAML SSO-protected orgs, and GitHub Enterprise Server.",
        password: true,
        placeHolder: "ghp_... or github_pat_...",
      });
      if (input === undefined) {
        return; // dismissed with Escape
      }
      if (input === "") {
        if (existing) {
          await deleteToken(context);
          log("GitHub token cleared.");
          void vscode.window.showInformationMessage("AI Setup Sync: GitHub token cleared.");
        }
        return;
      }
      if (!/^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/.test(input)) {
        const proceed = await vscode.window.showWarningMessage(
          "AI Setup Sync: This token doesn't look like a valid GitHub token (expected ghp_, gho_, ghu_, ghs_, ghr_, or github_pat_). Save it anyway?",
          "Save",
          "Cancel"
        );
        if (proceed !== "Save") {
          return;
        }
      }
      await setToken(context, input);
      log("GitHub token saved to secure storage.");
      void vscode.window.showInformationMessage("AI Setup Sync: GitHub token saved.");
      void runSync(context, false);
    })
  );

  // Trigger: sync automatically when a workspace opens.
  void runSync(context, false);

  // Trigger: refresh when the user returns focus to the window — this keeps config
  // current at the moments the user is actually present (so a conflict prompt lands
  // when they can act on it), without a background timer changing files while away.
  // Throttled against the last sync *attempt* (not just successes) so a repo that keeps
  // failing over the network — bad token, 404 — doesn't re-hit the GitHub API on every
  // alt-tab. A manual Sync Now ignores the throttle.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        return;
      }
      if (lastSyncAttemptAt && Date.now() - lastSyncAttemptAt < FOCUS_RESYNC_MIN_MS) {
        return;
      }
      void runSync(context, false);
    })
  );

  // React to setting changes: refresh the status bar (so first-time setup doesn't stay
  // stuck on "unconfigured") and re-sync when a content-affecting setting changes so the
  // result reflects the new value immediately. The re-sync is debounced: the settings UI
  // writes on every keystroke, so syncing mid-edit (against a half-typed URL or branch)
  // would flash an error and waste requests.
  const CONTENT_KEYS = ["repository", "branch", "targetFolders", "pathMappings"];
  // Settings that change which files are managed — a 304 from GitHub won't trigger the
  // full-tree path, so we invalidate the cached ETag to force a fresh tree fetch that
  // can detect and clean up newly-excluded files.
  const MANAGED_SET_KEYS = ["targetFolders", "pathMappings"];
  let resyncTimer: NodeJS.Timeout | undefined;
  const clearResync = () => {
    if (resyncTimer) {
      clearTimeout(resyncTimer);
      resyncTimer = undefined;
    }
  };
  context.subscriptions.push({ dispose: clearResync });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG)) {
        return;
      }
      const s = readSettings();
      if (!syncing) {
        setStatus(s.repository ? "idle" : "unconfigured");
      }
      if (!CONTENT_KEYS.some((k) => e.affectsConfiguration(`${CONFIG}.${k}`))) {
        return;
      }
      // Capture at event time so each debounce cycle is self-contained — no shared
      // flag that could be reset before the awaits inside fire() complete.
      const needsEtagInvalidation = MANAGED_SET_KEYS.some((k) => e.affectsConfiguration(`${CONFIG}.${k}`));
      clearResync();
      const fire = async () => {
        // If a sync is already in flight, retry shortly rather than dropping the change —
        // otherwise the edited setting wouldn't apply until the next focus/open sync.
        if (syncing) {
          resyncTimer = setTimeout(() => void fire(), CONFIG_RESYNC_DEBOUNCE_MS);
          return;
        }
        resyncTimer = undefined;
        // Invalidate the cached tree ETag so the next sync does a full tree fetch.
        // The 304 short-circuit path can't detect files excluded by the new settings —
        // a fresh fetch reaches the full-tree path which handles cleanup correctly.
        if (needsEtagInvalidation) {
          try {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
              const current = getState(context, folder);
              if (current.treeEtag) {
                await saveState(context, folder, { ...current, treeEtag: undefined });
              }
            }
          } catch (err) {
            log(`Warning: failed to invalidate tree ETag after settings change: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        void runSync(context, false);
      };
      resyncTimer = setTimeout(() => void fire(), CONFIG_RESYNC_DEBOUNCE_MS);
    })
  );
}
