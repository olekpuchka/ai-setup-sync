import * as cp from "child_process";
import * as vscode from "vscode";
import { removeManagedFiles } from "./cleanup";
import { ConfigError, RateLimitError, RepoRef } from "./github";
import { initOutput, log, showOutput } from "./output";
import { readRegistry, setWorkspaceFiles } from "./registry";
import { getState, saveState } from "./state";
import { localizeStateFiles, toastSummary, syncFolder, applyGitExclude, PartialSyncError } from "./sync";
import { gitBlobSha } from "./blobSha";
import { REMOTE_SCHEME, remoteContentProvider } from "./remoteContent";
import { deleteToken, getToken, getTokenHost, setToken } from "./token";

const CONFIG = "aiSetupSync";

// --- Status bar -----------------------------------------------------------

let statusBar: vscode.StatusBarItem | undefined;
let lastSyncSuccessAt: number | undefined;
// Last state passed to setStatus, so the post-sync-failure overlay can re-render without losing it.
let lastStatusState: "idle" | "syncing" | "error" | "unconfigured" = "idle";
let lastStatusDetail: string | undefined;
// Folder keys whose last post-sync command failed. Shown persistently in the status bar
// (a fast-sync toast can be missed), retried by a manual Sync Now, and cleared when the
// command next succeeds. Persisted in workspaceState so it survives a window reload.
const postSyncFailedFolders = new Set<string>();
const POST_SYNC_FAILED_KEY = "postSyncCommand.failed";
// Set in activate() so status helpers can persist the failure set without threading context.
let extensionContext: vscode.ExtensionContext | undefined;

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
      statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      break;
    case "unconfigured":
      statusBar.text = "$(gear) AI Setup Sync";
      statusBar.tooltip = "No repository configured. Click for actions.";
      statusBar.backgroundColor = undefined;
      break;
    default:
      statusBar.text = "$(check) AI Setup Sync";
      statusBar.tooltip =
        (lastSyncSuccessAt ? `Synced ${relativeTime(lastSyncSuccessAt)}` : "Ready") +
        (detail ? ` • ${detail}` : "") +
        "\nClick for actions.";
      statusBar.backgroundColor = undefined;
  }
}

/** Records a folder's post-sync outcome, persists it, and re-renders the status bar if it changed. */
function setPostSyncFolderFailed(folderKey: string, failed: boolean): void {
  const wasFailed = postSyncFailedFolders.has(folderKey);
  if (failed) {
    postSyncFailedFolders.add(folderKey);
  } else {
    postSyncFailedFolders.delete(folderKey);
  }
  if (wasFailed !== failed) {
    // Persistence is non-critical — ignore a storage-write failure rather than let it reject unhandled.
    void extensionContext?.workspaceState.update(POST_SYNC_FAILED_KEY, [...postSyncFailedFolders]).then(undefined, () => {});
    setStatus(lastStatusState, lastStatusDetail);
  }
}

/**
 * A progress notification for a sync run, created lazily on the first downloaded
 * file so no-op focus syncs never pop it. Shows a determinate bar that fills
 * left→right with a running "X of Y files" count. `onProgress` is called once per
 * downloaded file (with that file's position within its phase); `finish` closes
 * the popup when the run ends.
 *
 * A sync can run several download phases (restore missing, overwrite conflicts,
 * write new) across one or more workspace folders, each reporting its own 1..N
 * sequence. Each phase is folded into a cumulative total so the count climbs
 * monotonically, and the bar only ever advances — a later phase that enlarges the
 * total holds the bar rather than rewinding it.
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
    const when = lastSyncSuccessAt ? `Synced ${relativeTime(lastSyncSuccessAt)}` : "Not synced yet";
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

const DEFAULT_TARGET_FOLDERS = [
  // Claude Code
  ".claude", "CLAUDE.md", ".mcp.json",
  // GitHub Copilot / VS Code
  ".github", ".vscode/mcp.json",
  // Cursor
  ".cursor", ".cursorignore", ".cursorindexingignore",
  // OpenAI Codex + shared agent standard
  ".codex", ".agents", "AGENTS.md",
  // Google Antigravity
  ".antigravity.md",
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

/** Reads the per-scope values (user/global vs workspace vs folder) of the `repository` setting. */
function inspectRepository() {
  return vscode.workspace.getConfiguration(CONFIG).inspect<string>("repository");
}

/**
 * True when the sync repository is being withheld because the workspace is untrusted.
 * `repository` is trust-restricted, so in an untrusted workspace VS Code suppresses a
 * workspace/folder-scoped value and the effective setting reads empty. This distinguishes
 * that case from a genuinely unconfigured extension, so we can prompt to trust rather than
 * to configure. A user (global) value is always honored, so it never counts as blocked.
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

/** Extracts the repo slug (owner/name) from a repository URL. Accepts github.com and GitHub Enterprise Server URLs. Returns null if the URL is invalid. */
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
 * Guards against a workspace `.vscode/settings.json` silently redirecting the
 * repository URL to an attacker-controlled host and exfiltrating the stored
 * GitHub token (which is a machine-global secret, shared across every workspace).
 *
 * The token is bound to the GitHub host it was configured for (see token.ts) and
 * is only ever sent to that host — so a workspace-scoped repository pointing
 * elsewhere gets no credentials, even when the repo is configured only per-project.
 *
 * Legacy tokens saved before host-binding have no bound host: for those we fall
 * back to the *user*-level repository host (a scope a cloned repo cannot write) as
 * the trusted baseline, and — only when the user has no user-level repository at
 * all — preserve prior behavior so purely per-workspace setups keep working until
 * the token is next saved (which binds it).
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

/** Longest a post-sync command may run before it's killed. */
const POST_SYNC_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
// Generous cap: we only log the output, so a chatty-but-successful generator
// shouldn't fail with ENOBUFS. Still bounds memory against a real runaway.
const POST_SYNC_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * After a fast sync, its own notifications (progress closing, the "N added" summary toast)
 * fire in a tight burst; a post-sync result toast raised in that window can be bumped to the
 * notification center. Wait this long after the command finishes so the toast lands cleanly.
 * (The status bar reflects failures regardless, so this only improves the transient toast.)
 */
const POST_SYNC_RESULT_SETTLE_MS = 750;

/** Logged once per session so an untrusted workspace doesn't spam the log on every sync. */
let warnedUntrustedPostSync = false;

/**
 * Per-folder commands already surfaced by an approval notification this session
 * (folder key → command), so repeated syncs (window-focus, manual, startup) don't
 * stack a second prompt for the same pending command. Replaced when the command changes.
 */
const postSyncApprovalPrompted = new Map<string, string>();

/** Turns an exec failure into a cause the user can act on, not a bare/blank message. */
function describeExecError(err: cp.ExecException, output: string): string {
  const detail = output ? `\n${output}` : "";
  // A maxBuffer kill also sets killed + SIGTERM, so it must be checked before the
  // timeout branch or an over-large output gets misreported as a timeout.
  if (/maxBuffer/i.test(err.message)) {
    return `Command output exceeded ${POST_SYNC_COMMAND_MAX_BUFFER / (1024 * 1024)} MB and was killed.${detail}`;
  }
  if (err.killed && err.signal === "SIGTERM") {
    return `Command timed out after ${POST_SYNC_COMMAND_TIMEOUT_MS / 1000}s and was killed.${detail}`;
  }
  return output || err.message;
}

const POST_SYNC_APPROVED_KEY = "postSyncCommand.approved";

/** The per-folder map of last-approved post-sync commands (folder key → command). */
function getPostSyncApprovals(context: vscode.ExtensionContext): Record<string, string> {
  return context.workspaceState.get<Record<string, string>>(POST_SYNC_APPROVED_KEY) ?? {};
}

/** Records `command` as approved for a folder so it runs silently until it changes again. */
function recordPostSyncApproval(
  context: vscode.ExtensionContext,
  folderKey: string,
  command: string
): Thenable<void> {
  return context.workspaceState.update(POST_SYNC_APPROVED_KEY, { ...getPostSyncApprovals(context), [folderKey]: command });
}

/**
 * Runs the `postSyncCommand` of every folder whose sync changed files, plus any
 * folder whose command differs from the one last approved — so a newly added or
 * edited command runs on the next sync even when no files changed, rather than
 * sitting unused until the next real change.
 *
 * A command that needs approval is surfaced as a dismissible notification (see
 * `promptPostSyncApproval`) — the same prompt for manual and background syncs, so
 * they can't stack two prompts. It runs when the user clicks Run on it; once approved
 * for a folder it runs silently until it changes.
 *
 * Deliberately runs *after* the whole sync (all folders + progress notification)
 * finishes, so a slow build step isn't shown as "Syncing files" and one folder's
 * command doesn't delay another folder's download.
 *
 * Security: the setting is workspace-settable (that's its value — per-project
 * generate steps), so a cloned repo's .vscode/settings.json could carry a
 * malicious command. Workspace Trust is the gate that stops that — nothing runs
 * until the user trusts the workspace. (Running only on changed/changed-command
 * syncs is a behavior choice, to skip no-op focus syncs, not a security control.)
 * Failures are logged and toasted but never fail the sync itself.
 */
async function runPostSyncCommands(
  context: vscode.ExtensionContext,
  folders: readonly vscode.WorkspaceFolder[],
  changedFolders: readonly vscode.WorkspaceFolder[],
  interactive: boolean
): Promise<void> {
  const jobs = folders
    .map((folder) => ({
      folder,
      command: (vscode.workspace.getConfiguration(CONFIG, folder.uri).get<string>("postSyncCommand") ?? "").trim(),
    }))
    .filter((job) => job.command);
  // Clear a stuck failure state for any folder that no longer has a command (setting
  // removed/emptied) or was removed from the workspace, so the status bar doesn't stay
  // yellow for a command that can't run anymore.
  const jobKeys = new Set(jobs.map((job) => job.folder.uri.toString()));
  for (const key of [...postSyncFailedFolders]) {
    if (!jobKeys.has(key)) {
      setPostSyncFolderFailed(key, false);
    }
  }
  if (jobs.length === 0) {
    return;
  }
  if (!vscode.workspace.isTrusted) {
    if (!warnedUntrustedPostSync) {
      warnedUntrustedPostSync = true;
      log(`Post-sync command skipped: workspace is not trusted. Trust this workspace to enable it.`);
    }
    return;
  }
  const changedKeys = new Set(changedFolders.map((f) => f.uri.toString()));

  // Trust is granted once per workspace, but a later `git pull` could swap the
  // checked-in command for a different one. Re-confirm whenever the command for a
  // folder differs from the one the user last approved, so a silent change can't
  // run unnoticed.
  const approvals = getPostSyncApprovals(context);
  const approved: typeof jobs = [];
  for (const job of jobs) {
    const key = job.folder.uri.toString();
    const needsApproval = approvals[key] !== job.command;
    // A manual sync retries a folder whose command last failed, so "Sync Now" clears a
    // stuck failure state even when nothing else changed.
    const retryFailed = interactive && postSyncFailedFolders.has(key);
    // Run when this folder's files changed, its command is new/edited, or we're retrying a
    // failure. A no-op background sync with an already-approved command is skipped.
    if (!changedKeys.has(key) && !needsApproval && !retryFailed) {
      continue;
    }
    if (needsApproval) {
      // Surface the approval notification; the command runs when the user clicks Run,
      // not as part of this batch. A manual sync always re-shows it; a background sync
      // shows it once per session so window-focus can't spam it.
      promptPostSyncApproval(context, job.folder, job.command, interactive);
      continue;
    }
    approved.push(job);
  }
  if (approved.length === 0) {
    return;
  }
  await runPostSyncJobs(approved);
}

/** True if any open workspace folder has a non-empty `postSyncCommand`. */
function anyPostSyncCommandConfigured(): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => (vscode.workspace.getConfiguration(CONFIG, folder.uri).get<string>("postSyncCommand") ?? "").trim() !== ""
  );
}

/**
 * Runs the configured post-sync command(s) on demand (menu or Command Palette), independent
 * of a sync. Reuses `runPostSyncCommands` by treating every folder as changed, so each command
 * is considered regardless of file changes — approving/running or re-prompting as appropriate.
 */
async function runPostSyncCommandNow(context: vscode.ExtensionContext): Promise<void> {
  // The Command Palette runs this regardless of config (unlike the menu item, which is
  // hidden when unset), so guide the user rather than silently doing nothing.
  if (!anyPostSyncCommandConfigured()) {
    void vscode.window
      .showInformationMessage("AI Setup Sync: No Post Sync Command configured.", "Open Settings")
      .then((choice) => {
        if (choice) {
          void openPostSyncSetting();
        }
      });
    return;
  }
  if (syncing) {
    void vscode.window.showInformationMessage("AI Setup Sync: a sync or command is already running.");
    return;
  }
  if (!vscode.workspace.isTrusted) {
    void vscode.window
      .showWarningMessage("AI Setup Sync: trust this workspace to run the Post Sync Command.", "Manage Workspace Trust")
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand("workbench.trust.manage");
        }
      });
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  syncing = true;
  try {
    await runPostSyncCommands(context, folders, folders, true);
  } finally {
    syncing = false;
  }
}

/**
 * Runs post-sync command jobs in one progress notification, then reports the outcome.
 * Toasts fire after the run (not from inside `execPostSyncCommand`) and after a short
 * settle, so they aren't dropped in the sync's own notification burst — see below.
 */
async function runPostSyncJobs(
  jobs: ReadonlyArray<{ folder: vscode.WorkspaceFolder; command: string }>
): Promise<void> {
  const succeeded: Array<{ folder: string; command: string }> = [];
  const failed: Array<{ folder: string; command: string }> = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "AI Setup Sync: Running Post Sync Command" },
    async () => {
      for (const { folder, command } of jobs) {
        const ok = await execPostSyncCommand(folder, command);
        // Persistent per-folder signal: a fast sync's notification burst can bump the
        // toast to the notification center, so also reflect failure in the status bar
        // (and a manual sync retries failed folders). Cleared here when it next succeeds.
        setPostSyncFolderFailed(folder.uri.toString(), !ok);
        if (ok) {
          succeeded.push({ folder: folder.name, command });
        } else {
          failed.push({ folder: folder.name, command });
        }
      }
    }
  );
  // Let the sync's own notification burst clear before showing ours, so the result toast
  // isn't dropped/bumped to the notification center on a fast sync.
  await new Promise<void>((resolve) => setTimeout(resolve, POST_SYNC_RESULT_SETTLE_MS));
  for (const { folder, command } of failed) {
    void vscode.window
      .showErrorMessage(`AI Setup Sync: Post Sync Command failed in "${folder}" — ${command}`, "Show Log", "Open Settings")
      .then((choice) => {
        if (choice === "Open Settings") {
          void openPostSyncSetting();
        } else if (choice) {
          showOutput();
        }
      });
  }
  if (failed.length === 0 && succeeded.length > 0) {
    // Show Log lets you check the command's output; matches the failure toast and the sync summary.
    void vscode.window
      .showInformationMessage(
        succeeded.length === 1
          ? `AI Setup Sync: Post Sync Command finished for "${succeeded[0].folder}" — ${succeeded[0].command}`
          : `AI Setup Sync: ${succeeded.length} Post Sync Commands finished.`,
        "Show Log"
      )
      .then((choice) => {
        if (choice) {
          showOutput();
        }
      });
  }
}

/** Opens Settings focused on the post-sync command setting. */
function openPostSyncSetting(): Thenable<unknown> {
  return vscode.commands.executeCommand("workbench.action.openSettings", `${CONFIG}.postSyncCommand`);
}

/**
 * Records approval for a folder's post-sync command and runs it, holding the
 * `syncing` guard so a sync can't start writing files while the command runs. Used
 * for the out-of-band run when the user clicks Run on the approval notification (the
 * in-sync batch in `runPostSyncCommands` already runs under the guard). If a sync is
 * already in flight, the approval is still recorded but the immediate run is skipped
 * to avoid overlap — it runs on the next qualifying sync.
 */
async function approveAndRunPostSyncCommand(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  command: string
): Promise<void> {
  const key = folder.uri.toString();
  // Idempotent: if this exact command is already approved (e.g. the user clicked Run
  // on a duplicate notification, or a sync already ran it), don't run it a second time.
  if (getPostSyncApprovals(context)[key] === command) {
    return;
  }
  await recordPostSyncApproval(context, key, command);
  if (syncing) {
    log(`Post-sync command for ${folder.name} approved; a sync is in progress, so it will run on the next sync that changes this folder.`);
    return;
  }
  syncing = true;
  try {
    await runPostSyncJobs([{ folder, command }]);
  } finally {
    syncing = false;
  }
}

/**
 * Surfaces a new/changed post-sync command as a dismissible notification with a
 * **Run** action — the single approval prompt for both manual and background syncs.
 * A background sync shows it at most once per (folder, command) per session so
 * window-focus can't spam it; a manual sync passes `force` to re-show even if it was
 * already surfaced (so dismissing it doesn't leave a manual Sync Now doing nothing).
 * Clicking **Run** records the approval and runs it; dismissing leaves it unapproved.
 * The run is idempotent, so a duplicate notification can't run the command twice.
 */
function promptPostSyncApproval(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  command: string,
  force: boolean
): void {
  const key = folder.uri.toString();
  if (!force && postSyncApprovalPrompted.get(key) === command) {
    return;
  }
  postSyncApprovalPrompted.set(key, command);
  // A previously-approved (different) command means this one was changed — call that out,
  // since a swapped command (e.g. from a `git pull`) is the case worth scrutinizing.
  const changed = Boolean(getPostSyncApprovals(context)[key]);
  log(`Post-sync command for ${folder.name} ${changed ? "changed and needs" : "needs"} approval: ${command}`);
  const message = changed
    ? `AI Setup Sync: Post Sync Command for "${folder.name}" changed. Run it? — ${command}`
    : `AI Setup Sync: Run Post Sync Command for "${folder.name}"? — ${command}`;
  void vscode.window
    .showWarningMessage(message, "Run", "Open Settings")
    .then(async (choice) => {
      if (choice === "Open Settings") {
        await openPostSyncSetting();
        return;
      }
      if (choice !== "Run") {
        return;
      }
      await approveAndRunPostSyncCommand(context, folder, command);
    })
    .then(undefined, (err: unknown) => {
      log(`Post-sync command approval failed for ${folder.name}: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/** Runs one command, logging its output. Returns true on success, false on failure. Shows no UI. */
async function execPostSyncCommand(folder: vscode.WorkspaceFolder, command: string): Promise<boolean> {
  log(`Running post-sync command in ${folder.name}: ${command}`);
  try {
    const output = await new Promise<string>((resolve, reject) => {
      cp.exec(
        command,
        { cwd: folder.uri.fsPath, timeout: POST_SYNC_COMMAND_TIMEOUT_MS, maxBuffer: POST_SYNC_COMMAND_MAX_BUFFER },
        (err, stdout, stderr) => {
          const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
          if (err) {
            reject(new Error(describeExecError(err, combined)));
          } else {
            resolve(combined);
          }
        }
      );
    });
    if (output) {
      log(output);
    }
    log(`Post-sync command finished in ${folder.name}.`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Post-sync command failed: ${msg}`);
    return false;
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

  // Claim the sync slot and stamp the attempt before the first await, so concurrent
  // triggers (open, focus, token-save, settings-change) can't race past the `syncing`
  // guard above, and so a failing background sync still throttles the focus trigger.
  syncing = true;
  lastSyncAttemptAt = Date.now();
  setStatus("syncing");
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
  // commands now, still under the `syncing` guard so a new sync can't overlap.
  try {
    await runPostSyncCommands(context, folders, changedFolders, interactive);
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
 * First-run nudge: a new user has no way to discover they must set a repository —
 * the status-bar gear is easy to miss and background syncs stay silent. Show one
 * dismissible prompt per session while unconfigured (the flag resets on window
 * reload, so a still-unconfigured project nudges again next time), and never once
 * a repository is set. Skipped in an empty window — nothing to sync into there.
 * "Don't Show Again" persists to globalState and silences the nudge for good.
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

  // Restore persisted post-sync failures so the warning (and Sync Now retry) survive a reload.
  extensionContext = context;
  for (const key of context.workspaceState.get<string[]>(POST_SYNC_FAILED_KEY) ?? []) {
    postSyncFailedFolders.add(key);
  }

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = `${CONFIG}.showMenu`;
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
