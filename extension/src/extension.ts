import * as vscode from "vscode";
import { removeManagedFiles } from "./cleanup";
import { ConfigError, RateLimitError, RepoRef } from "./github";
import { initOutput, log, showOutput } from "./output";
import { readRegistry, setWorkspaceFiles } from "./registry";
import { getState, saveState } from "./state";
import { localizeStateFiles, toastSummary, syncFolder, PartialSyncError, withIgnoreFileLock } from "./sync";
import { REMOTE_SCHEME, remoteContentProvider } from "./remoteContent";
import { deleteToken, getToken, getTokenHost, setToken } from "./token";
import { CONFIG, inspectRepository, readSettings } from "./settings";
import { initStatusBar, markSyncSuccess, setStatus, syncedLabel } from "./statusBar";
import { acquireSync, isSyncing, releaseSync } from "./syncLock";
import { anyPostSyncCommandConfigured, runPostSyncCommandNow, runPostSyncCommands } from "./postSync";
import { disposeAllWatchers, refreshWatcher } from "./watcher";

/**
 * Progress notification for a sync run, created lazily on the first downloaded file so
 * no-op focus syncs never pop it.
 *
 * A sync runs several download phases across one or more folders, each reporting its own
 * 1..N sequence. Phases are folded into a cumulative total so the count climbs
 * monotonically and the bar only ever advances — a later, larger phase holds it rather
 * than rewinding.
 */
function createSyncProgress(): {
  onProgress: (done: number, total: number) => void;
  finish: () => void;
} {
  let started = false;
  let reporter: vscode.Progress<{ message?: string; increment?: number }> | undefined;
  // Resolve the notification's promise; captured synchronously here (not inside the
  // withProgress callback) so finish() closes the popup regardless of when VS Code
  // invokes that callback.
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let completed = 0; // files actually downloaded so far (monotonic)
  let phaseBase = 0; // completed count when the current phase began
  let lastPct = 0;

  const onProgress = (done: number, total: number): void => {
    if (!started) {
      started = true;
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "AI Setup Sync" },
        (p) => {
          reporter = p;
          return donePromise;
        }
      );
    }
    if (done === 1) {
      // A new phase started (each phase's counter restarts at 1). Fold the files
      // actually completed so far into the base — using the real count, not the
      // previous phase's declared total, so a partially-failed phase doesn't inflate it.
      phaseBase = completed;
    }
    completed = phaseBase + done;
    const cumTotal = phaseBase + total; // `total` is constant within a phase
    const pct = cumTotal > 0 ? (completed / cumTotal) * 100 : 0;
    const increment = Math.max(0, pct - lastPct); // advance only — never rewind
    lastPct = pct;
    const noun = cumTotal === 1 ? "file" : "files";
    reporter?.report({ message: `Syncing ${completed} of ${cumTotal} ${noun}`, increment });
  };

  const finish = (): void => {
    resolveDone();
  };

  return { onProgress, finish };
}

/** Total count of files this extension is currently managing across open workspace folders. */
function syncedFileCount(): number {
  const reg = readRegistry();
  let total = 0;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    total += Object.keys(reg.workspaces[folder.uri.fsPath]?.files ?? {}).length;
  }
  return total;
}

/** Opens the status-bar action menu — the extension's main interactive surface. */
async function showMenu(context: vscode.ExtensionContext): Promise<void> {
  const settings = readSettings();

  let detail: string;
  if (!settings.repository) {
    detail = "No repository configured";
  } else {
    const slug = parseRepo(settings.repository);
    const count = syncedFileCount();
    const when = syncedLabel("Not synced yet");
    const files = count > 0 ? ` · ${count} file${count === 1 ? "" : "s"}` : "";
    const from = slug ? ` from ${slug}` : "";
    detail = `${when}${files}${from}`;
  }

  interface MenuItem extends vscode.QuickPickItem {
    run: () => void | Promise<void>;
  }

  const items: MenuItem[] = [
    {
      label: "$(sync) Sync Now",
      description: "Pull the latest setup files",
      run: () => runSync(context, true),
    },
    ...(anyPostSyncCommandConfigured()
      ? [{
          label: "$(play) Run Post Sync Command",
          description: "Run the configured command",
          run: () => runPostSyncCommandNow(context),
        }]
      : []),
    {
      label: "$(output) Show Log",
      description: "Open the AI Setup Sync output channel",
      run: () => showOutput(),
    },
    {
      label: "$(gear) Open Settings",
      description: "Repository, branch, target folders, path mappings",
      run: () => vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`),
    },
    {
      label: "$(trash) Remove Synced Files",
      description: "Delete files this extension has synced",
      run: () => removeSyncedFiles(context),
    },
    {
      label: "$(key) Set GitHub Token",
      description: "For private repos, SSO orgs, or Enterprise",
      run: () => vscode.commands.executeCommand(`${CONFIG}.setGitHubToken`),
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "AI Setup Sync",
    placeHolder: detail,
  });
  await pick?.run();
}

/**
 * True when the repository is being withheld because the workspace is untrusted — VS Code
 * suppresses the workspace-scoped value, so the setting reads empty. Distinguishes that
 * from genuinely unconfigured, so we prompt to trust rather than to configure. A user
 * (global) value is always honored and so never counts as blocked.
 */
function repositoryBlockedByTrust(): boolean {
  if (vscode.workspace.isTrusted) {
    return false;
  }
  const inspected = inspectRepository();
  const suppressed = (inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? "").trim();
  const globalRepoValue = (inspected?.globalValue ?? "").trim();
  return !!suppressed && !globalRepoValue;
}

/** Prompts the user to trust the workspace so a workspace-configured repository can sync. */
async function promptTrustToSync(kind: "warning" | "info"): Promise<void> {
  const message = "AI Setup Sync: This workspace configures a sync repository, but it won't run until you trust the workspace.";
  const show = kind === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  if (await show(message, "Manage Workspace Trust")) {
    await vscode.commands.executeCommand("workbench.trust.manage");
  }
}

/** Repo slug (owner/name) from a github.com or Enterprise Server URL; null if invalid. */
function parseRepo(raw: string): string | null {
  const m = raw.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/** Hostname of a URL, or undefined if it doesn't parse. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Guards against a workspace `.vscode/settings.json` redirecting the repository URL to an
 * attacker-controlled host and exfiltrating the token, which is machine-global.
 *
 * The token is bound to the host it was configured for (see token.ts) and only ever sent
 * there, so a workspace-scoped repository pointing elsewhere gets no credentials.
 *
 * Legacy tokens have no bound host; those fall back to the *user*-level repository host — a
 * scope a cloned repo cannot write. With no user-level repository at all, prior behavior is
 * preserved so per-workspace setups keep working until the token is next saved.
 */
function tokenAllowedForHost(context: vscode.ExtensionContext, effectiveRepo: string): boolean {
  const effHost = hostOf(effectiveRepo);
  if (!effHost) {
    return false; // unparseable repository URL — nothing to authorize
  }
  const boundHost = getTokenHost(context);
  if (boundHost) {
    return effHost === boundHost;
  }
  // Legacy/unbound token — use the user-level repository host as the baseline.
  const userHost = hostOf((inspectRepository()?.globalValue ?? "").trim());
  return userHost ? effHost === userHost : true;
}

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

  if (err instanceof PartialSyncError) {
    // Some files failed to download while others may have succeeded. The full per-file
    // detail is already in the log (above); keep the toast short and reassuring, since
    // the next sync retries automatically. Transient 5xx get an explicitly calmer message.
    const n = err.count;
    const s = n === 1 ? "" : "s";
    const allTransient = n > 0 && err.transientCount === n;
    setStatus("error", allTransient ? "GitHub temporarily unavailable" : `${n} file${s} failed to sync`);
    if (interactive) {
      const text = allTransient
        ? `AI Setup Sync: GitHub returned a temporary error for ${n} file${s} — they'll sync automatically on the next attempt.`
        : `AI Setup Sync: ${n} file${s} couldn't be synced. They'll retry on the next sync — see the log for details.`;
      void vscode.window.showErrorMessage(text, "Show Log").then((choice) => {
        if (choice) {
          showOutput();
        }
      });
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
        void vscode.window.showErrorMessage(`AI Setup Sync: ${msg}`, "Open Settings").then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand("workbench.action.openSettings", err.setting ?? `${CONFIG}.repository`);
          }
        });
      }
    } else {
      void vscode.window.showErrorMessage(`AI Setup Sync: Sync failed: ${msg}`);
    }
  }
}


async function runSync(
  context: vscode.ExtensionContext,
  interactive: boolean
): Promise<void> {
  if (isSyncing()) {
    return;
  }
  // Honor an active rate-limit backoff for background runs; a manual run always tries.
  if (!interactive && Date.now() < rateLimitedUntil) {
    return;
  }
  const settings = readSettings();
  if (!settings.repository) {
    setStatus("unconfigured");
    if (repositoryBlockedByTrust()) {
      if (interactive) {
        await promptTrustToSync("warning");
      } else {
        log("Sync skipped: the repository is set in workspace settings but the workspace is not trusted. Trust it to sync.");
      }
      return;
    }
    if (interactive) {
      const choice = await vscode.window.showWarningMessage(
        "AI Setup Sync: No repository configured — add a GitHub repository URL in settings to start syncing.",
        "Open Settings"
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
      void vscode.window.showErrorMessage(msg, "Open Settings").then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand("workbench.action.openSettings", `${CONFIG}.repository`);
        }
      });
    }
    return;
  }

  const syncProgress = createSyncProgress();
  const changedFolders: vscode.WorkspaceFolder[] = [];

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
            // Cleanup rewrites .git/info/exclude and .worktreeinclude too, so it queues with the other writers.
            const removed = await withIgnoreFileLock(folder, () => removeManagedFiles(folder.uri.fsPath, files));
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
            onProgress: syncProgress.onProgress,
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
          // Files changed on disk — remember this folder so its post-sync command
          // runs once the whole sync (and its progress notification) has finished.
          changedFolders.push(folder);
        }
      } catch (err) {
        handleSyncError(err, interactive);
        hadError = true;
        // Preserve any pre-existing locally-modified paths so they stay visible in git.
        const regErr = readRegistry();
        const errFiles = regErr.workspaces[folder.uri.fsPath]?.files ?? {};
        refreshWatcher(folder, errFiles);
      }
    }

    if (hadError) {
      // handleSyncError already set the error status (and any rate-limit
      // backoff) for the failed folder(s); don't overwrite them with a success
      // state, and don't clear the backoff we may have just armed.
      return;
    }

    markSyncSuccess();
    rateLimitedUntil = 0; // we got through; clear any backoff
    setStatus("idle", settings.repository);
    if (noFilesFound) {
      void vscode.window.showWarningMessage(
        `AI Setup Sync: No files found to sync. Check that "${settings.branch}" is the correct branch and that the paths in Target Folders exist in your repo.`,
        "Open Settings"
      ).then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand("workbench.action.openSettings", `${CONFIG}.branch`);
        }
      });
    } else if (changed && summaries.length > 0) {
      void vscode.window.showInformationMessage(
        `AI Setup Sync: ${summaries.join(" ")}`,
        "Show Log"
      ).then((choice) => {
        if (choice === "Show Log") {
          showOutput();
        }
      });
    }
  };

  // Claim the lock and stamp the attempt before the first await, so concurrent triggers
  // can't race past the isSyncing() check above and a failing sync still throttles focus.
  // Both phases share one try: callers use `void runSync(...)`, so an escaping rejection
  // would otherwise strand the lock for the rest of the session.
  acquireSync();
  lastSyncAttemptAt = Date.now();
  setStatus("syncing");
  try {
    try {
      const token = await getToken(context);
      // Lazily bind an unbound token (one saved before a repository was configured, or
      // before host-binding existed) to the *user-level* repository host as soon as one is
      // known. Binding only to the global host — never the effective/workspace host — means
      // a workspace-scoped repository URL can't retroactively claim the token, while the
      // common "token saved, repo set globally" case stops lingering in the unbound state.
      if (token && !getTokenHost(context)) {
        const globalRepo = inspectRepository()?.globalValue ?? "";
        const globalHost = hostOf(globalRepo.trim());
        if (globalHost) {
          await setToken(context, token, globalHost);
          log(`GitHub token bound to ${globalHost} (from your user-level repository setting).`);
        }
      }
      let effectiveToken = token;
      if (token && !tokenAllowedForHost(context, settings.repository)) {
        // The repository points at a host the token isn't bound to — withhold it so a
        // workspace-scoped setting can't redirect the token to an unintended host.
        effectiveToken = undefined;
        log(
          `Warning: GitHub token withheld — the repository host "${hostOf(settings.repository) ?? settings.repository}" ` +
            `is not the host your token was saved for. If this repository is genuinely yours, re-run ` +
            `"AI Setup Sync: Set GitHub Token" while it's configured to authorize the token for this host.`
        );
      }
      const repoRef: RepoRef = { repo: parseRepo(settings.repository) ?? "", url: settings.repository, ref: settings.branch, token: effectiveToken };
      await runSyncFolders(repoRef);
    } catch (err) {
      // Per-folder failures are handled inside runSyncFolders; this catches the rest
      // (e.g. getToken rejecting on a locked keychain) so the status bar shows an error
      // instead of spinning forever on "syncing".
      handleSyncError(err, interactive);
    } finally {
      syncProgress.finish();
    }

    // The file sync (and its progress notification) is fully done. Run post-sync
    // commands now, still under the lock so a new sync can't overlap.
    await runPostSyncCommands(context, folders, changedFolders, interactive);
  } finally {
    releaseSync();
  }
}

const BUSY_MESSAGE = "AI Setup Sync: a sync or command is running — try again when it finishes.";

/** Removes the synced setup files from the open workspace(s), preserving local edits. */
async function removeSyncedFiles(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage("AI Setup Sync: Open a folder first — there's nowhere to sync files to.");
    return;
  }
  // Checked before the confirmation too, so the user isn't asked to confirm something that can't run.
  if (isSyncing()) {
    void vscode.window.showInformationMessage(BUSY_MESSAGE);
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
  // Take the sync lock like every other writer: a concurrent sync would re-add what this removes,
  // and the watcher defers its events while the lock is held instead of re-adding the exclude
  // block cleanup just stripped.
  if (isSyncing()) {
    void vscode.window.showInformationMessage(BUSY_MESSAGE);
    return;
  }
  acquireSync();
  try {
    await removeSyncedFilesLocked(context, folders);
  } finally {
    releaseSync();
  }
}

async function removeSyncedFilesLocked(
  context: vscode.ExtensionContext,
  folders: readonly vscode.WorkspaceFolder[]
): Promise<void> {
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
    // Cleanup rewrites .git/info/exclude and .worktreeinclude too, so it queues with the other writers.
    const summary = await withIgnoreFileLock(folder, () => removeManagedFiles(folder.uri.fsPath, files));
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

  const showLogIfChosen = (choice: string | undefined) => { if (choice === "Show Log") { showOutput(); } };
  if (kept > 0) {
    void vscode.window.showWarningMessage(
      deleted > 0
        ? `AI Setup Sync: Removed ${deleted} ${deleted === 1 ? "file" : "files"}, kept ${kept} with local edits.`
        : `AI Setup Sync: ${kept} ${kept === 1 ? "file" : "files"} kept due to local edits.`,
      "Show Log"
    ).then(showLogIfChosen);
  } else if (deleted > 0) {
    void vscode.window.showInformationMessage(
      `AI Setup Sync: Removed ${deleted} synced ${deleted === 1 ? "file" : "files"}.`,
      "Show Log"
    ).then(showLogIfChosen);
  }
}

/** Session-scoped, so the nudge reshows on the next window while still unconfigured. */
let welcomeShownThisSession = false;

/** globalState flag set by "Don't Show Again" — silences the welcome nudge permanently, everywhere. */
const WELCOME_DISMISSED_KEY = "welcome.dismissed";

/**
 * First-run nudge: nothing else tells a new user they must set a repository — the status-bar
 * gear is easy to miss and background syncs stay silent. Shown once per session while
 * unconfigured, never once a repository is set, and skipped in an empty window.
 */
async function maybeShowWelcome(context: vscode.ExtensionContext): Promise<void> {
  if (
    welcomeShownThisSession ||
    context.globalState.get<boolean>(WELCOME_DISMISSED_KEY) ||
    !vscode.workspace.workspaceFolders?.length ||
    readSettings().repository
  ) {
    return;
  }
  welcomeShownThisSession = true;
  if (repositoryBlockedByTrust()) {
    await promptTrustToSync("info");
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    "AI Setup Sync: Add a GitHub repository to start syncing your AI config across projects.",
    "Open Settings",
    "Don't Show Again"
  );
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`);
  } else if (choice === "Don't Show Again") {
    await context.globalState.update(WELCOME_DISMISSED_KEY, true);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settings = readSettings();

  initOutput(context);
  log(`Activated. Source: ${settings.repository || "(unconfigured)"}@${settings.branch}.`);

  initStatusBar(context, `${CONFIG}.showMenu`);
  setStatus(settings.repository ? "idle" : "unconfigured");
  context.subscriptions.push({ dispose: disposeAllWatchers });

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, remoteContentProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG}.showMenu`, () =>
      showMenu(context)
    ),
    vscode.commands.registerCommand(`${CONFIG}.syncNow`, () =>
      runSync(context, true)
    ),
    vscode.commands.registerCommand(`${CONFIG}.runPostSyncCommand`, () =>
      runPostSyncCommandNow(context)
    ),
    vscode.commands.registerCommand(`${CONFIG}.removeSyncedFiles`, () =>
      removeSyncedFiles(context)
    ),
    vscode.commands.registerCommand(`${CONFIG}.showLog`, () => showOutput()),
    vscode.commands.registerCommand(`${CONFIG}.openSettings`, () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`)
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
      // Bind the token to the host it's being configured for, so it's never sent
      // elsewhere (e.g. a workspace-overridden repository URL).
      const tokenHost = hostOf(readSettings().repository);
      await setToken(context, input, tokenHost);
      log(`GitHub token saved to secure storage${tokenHost ? ` (authorized for ${tokenHost})` : ""}.`);
      void vscode.window.showInformationMessage("AI Setup Sync: GitHub token saved.");
      void runSync(context, false);
    })
  );

  // First-run: nudge a brand-new, unconfigured user toward settings.
  void maybeShowWelcome(context);

  // Trigger: sync automatically when a workspace opens.
  void runSync(context, false);

  // Trigger: refresh on window focus, so config is current while the user is present to
  // answer a conflict prompt — no background timer changing files while they're away.
  // Throttled on the last *attempt*, not the last success, so a repo that keeps failing
  // doesn't re-hit the API on every alt-tab. A manual Sync Now ignores the throttle.
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

  // React to setting changes: refresh the status bar so first-time setup doesn't stay stuck
  // on "unconfigured", and re-sync so the result reflects the new value. Debounced — the
  // settings UI writes per keystroke, and syncing against a half-typed URL flashes an error.
  const CONTENT_KEYS = ["repository", "branch", "targetFolders", "pathMappings"];
  // Settings that change which files are managed — a 304 from GitHub won't trigger the
  // full-tree path, so we invalidate the cached ETag to force a fresh tree fetch that
  // can detect and clean up newly-excluded files.
  const MANAGED_SET_KEYS = ["targetFolders", "pathMappings"];
  let resyncTimer: NodeJS.Timeout | undefined;
  // Accumulated across coalesced events, not captured per event: a second change landing
  // inside the debounce window cancels the first event's timer, and a per-event flag would
  // take the earlier event's "invalidate" with it — leaving newly-excluded files on disk
  // until the repo tree happened to change. Cleared only once fire() has acted on it.
  let pendingEtagInvalidation = false;
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
      if (!isSyncing()) {
        setStatus(s.repository ? "idle" : "unconfigured");
      }
      if (!CONTENT_KEYS.some((k) => e.affectsConfiguration(`${CONFIG}.${k}`))) {
        return;
      }
      pendingEtagInvalidation ||= MANAGED_SET_KEYS.some((k) => e.affectsConfiguration(`${CONFIG}.${k}`));
      clearResync();
      const fire = async () => {
        // If a sync is already in flight, retry shortly rather than dropping the change —
        // otherwise the edited setting wouldn't apply until the next focus/open sync.
        if (isSyncing()) {
          resyncTimer = setTimeout(() => void fire(), CONFIG_RESYNC_DEBOUNCE_MS);
          return;
        }
        resyncTimer = undefined;
        // Invalidate the cached tree ETag so the next sync does a full tree fetch.
        // The 304 short-circuit path can't detect files excluded by the new settings —
        // a fresh fetch reaches the full-tree path which handles cleanup correctly.
        if (pendingEtagInvalidation) {
          pendingEtagInvalidation = false;
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
