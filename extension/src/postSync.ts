import * as cp from "child_process";
import * as vscode from "vscode";
import { CONFIG } from "./settings";
import { log, showOutput } from "./output";
import { hasPostSyncFailure, postSyncFailedKeys, setPostSyncFolderFailed } from "./statusBar";
import { acquireSync, isSyncing, releaseSync } from "./syncLock";

/** Longest a post-sync command may run before it's killed. */
const POST_SYNC_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
// Generous cap: we only log the output, so a chatty-but-successful generator
// shouldn't fail with ENOBUFS. Still bounds memory against a real runaway.
const POST_SYNC_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * A fast sync fires its own notifications in a burst, and a result toast raised in that
 * window gets bumped to the notification center. Only affects the transient toast — the
 * status bar reflects failures regardless.
 */
const POST_SYNC_RESULT_SETTLE_MS = 750;

/** Logged once per session so an untrusted workspace doesn't spam the log on every sync. */
let warnedUntrustedPostSync = false;

/**
 * Folder key → command already surfaced by an approval prompt this session, so repeated
 * syncs don't stack a second prompt for the same pending command.
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
 * Runs the `postSyncCommand` of every folder whose sync changed files, plus any folder
 * whose command differs from the one last approved — so a newly added or edited command
 * runs on the next sync rather than sitting unused until the next real change. A command
 * needing approval is surfaced by `promptPostSyncApproval` and runs only when the user
 * clicks Run; once approved it runs silently until it changes.
 *
 * Called *after* the whole sync finishes, so a slow build step isn't reported as "Syncing
 * files" and one folder's command doesn't delay another folder's download.
 *
 * Security: the setting is workspace-settable, so a cloned repo's .vscode/settings.json
 * could carry a malicious command — Workspace Trust is the gate that stops that. Skipping
 * no-op syncs is a behavior choice, not a security control. Failures never fail the sync.
 */
export async function runPostSyncCommands(
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
  for (const key of postSyncFailedKeys()) {
    if (!jobKeys.has(key)) {
      setPostSyncFolderFailed(context, key, false);
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
    const retryFailed = interactive && hasPostSyncFailure(key);
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
  await runPostSyncJobs(context, approved);
}

/** True if any open workspace folder has a non-empty `postSyncCommand`. */
export function anyPostSyncCommandConfigured(): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => (vscode.workspace.getConfiguration(CONFIG, folder.uri).get<string>("postSyncCommand") ?? "").trim() !== ""
  );
}

/**
 * Runs the configured command(s) on demand, independent of a sync — every folder is treated
 * as changed so each command is considered regardless of file changes.
 */
export async function runPostSyncCommandNow(context: vscode.ExtensionContext): Promise<void> {
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
  if (isSyncing()) {
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
  acquireSync();
  try {
    await runPostSyncCommands(context, folders, folders, true);
  } finally {
    releaseSync();
  }
}

/**
 * Runs jobs in one progress notification, then reports the outcome. Toasts fire after the
 * run and after a short settle so they aren't dropped in the sync's notification burst.
 */
async function runPostSyncJobs(
  context: vscode.ExtensionContext,
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
        setPostSyncFolderFailed(context, folder.uri.toString(), !ok);
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
 * Records approval and runs the command, holding the sync lock so a sync can't write files
 * concurrently. Used for the out-of-band run when the user clicks Run on the notification;
 * the in-sync batch already holds the lock. If a sync is in flight the approval is still
 * recorded but the run is deferred to the next qualifying sync.
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
  if (isSyncing()) {
    log(`Post-sync command for ${folder.name} approved; a sync is in progress, so it will run on the next sync that changes this folder.`);
    return;
  }
  acquireSync();
  try {
    await runPostSyncJobs(context, [{ folder, command }]);
  } finally {
    releaseSync();
  }
}

/**
 * Surfaces a new/changed command as a dismissible notification with a **Run** action — the
 * single approval prompt for both manual and background syncs. A background sync shows it
 * at most once per (folder, command) per session; `force` re-shows it for a manual sync, so
 * dismissing it doesn't leave Sync Now doing nothing. The run is idempotent.
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
