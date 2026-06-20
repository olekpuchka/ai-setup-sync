import * as vscode from "vscode";
import { forceRemoveFiles, removeManagedFiles } from "./cleanup";
import { ConfigError, RateLimitError, RepoRef } from "./github";
import { initOutput, log, showOutput } from "./output";
import { readRegistry, setWorkspaceFiles } from "./registry";
import { getState, saveState } from "./state";
import { ConflictPolicy, toastSummary, syncFolder, SyncResult } from "./sync";
import { REMOTE_SCHEME, remoteContentProvider } from "./remoteContent";
import { deleteToken, getToken, setToken } from "./token";

const CONFIG = "aiSetupSync";

// --- Status bar -----------------------------------------------------------

let statusBar: vscode.StatusBarItem | undefined;
let lastSyncAt: number | undefined;

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
        (lastSyncAt ? `Synced ${relativeTime(lastSyncAt)}` : "Ready") +
        (detail ? ` • ${detail}` : "") +
        "\nClick to sync now.";
      statusBar.backgroundColor = undefined;
  }
}

type SyncMode = "always" | "onOpen" | "manual";

const DEFAULT_TARGET_FOLDERS = [".claude", "CLAUDE.md", ".github", ".cursor", ".agents", "AGENTS.md", ".gemini", "GEMINI.md", ".codex"];
const DEFAULT_TARGET_MAP: Record<string, boolean> = Object.fromEntries(DEFAULT_TARGET_FOLDERS.map((f) => [f, true]));

interface Settings {
  repository: string;
  branch: string;
  targetFolders: string[];
  pathMappings: Record<string, string>;
  syncMode: SyncMode;
  conflictPolicy: ConflictPolicy;
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
    syncMode: (c.get<string>("syncMode") as SyncMode) ?? "always",
    conflictPolicy: (c.get<string>("conflictPolicy") as ConflictPolicy) ?? "prompt",
  };
}

/** Extracts the repo slug from a GitHub URL for the GitHub API. Returns null if the URL is invalid. */
function parseRepo(raw: string): string | null {
  const m = raw.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/** A re-entrancy guard so overlapping triggers don't sync the same folders twice. */
let syncing = false;
/** When rate-limited, background syncs/checks pause until this epoch ms. */
let rateLimitedUntil = 0;

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
    const msg = `AI Setup Sync: '${settings.repository}' is not a valid GitHub repository URL. Expected: https://github.com/your-org/your-repo`;
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

  const token = await getToken(context);
  const repoRef: RepoRef = { repo: parseRepo(settings.repository) ?? "", url: settings.repository, ref: settings.branch, token };

  const runSyncFolders = async () => {
    const summaries: string[] = [];
    let changed = false;
    let noFilesFound = false;
    for (const folder of folders) {
      // Detect repo URL change — prompt to clean up files from the previous repo.
      const prevState = getState(context, folder);
      if (prevState.repoUrl && prevState.repoUrl !== settings.repository && Object.keys(prevState.files).length > 0) {
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
          const files = reg.workspaces[folder.uri.fsPath]?.files ?? prevState.files;
          removeManagedFiles(folder.uri.fsPath, files);
        }
        await saveState(context, folder, { ref: "", files: {} });
        setWorkspaceFiles(folder.uri.fsPath, {});
      }

      let result: SyncResult;
      try {
        result = await syncFolder(
          context,
          folder,
          {
            repoRef,
            targetFolders: settings.targetFolders,
            pathMappings: settings.pathMappings,
            conflictPolicy: settings.conflictPolicy,
          }
        );
      } catch (err) {
        handleSyncError(err, interactive);
        continue;
      }
      if (result.noFilesFound) {
        noFilesFound = true;
      } else {
        if (!result.noChanges) {
          changed = true;
          summaries.push(toastSummary(result));
        }
      }
    }

    lastSyncAt = Date.now();
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

  syncing = true;
  setStatus("syncing");
  try {
    await runSyncFolders();
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

  const reg = readRegistry();
  let deleted = 0;
  const allKeptPaths: Array<{ folder: vscode.WorkspaceFolder; rel: string }> = [];

  for (const folder of folders) {
    const files =
      reg.workspaces[folder.uri.fsPath]?.files ?? getState(context, folder).files;
    if (!files || Object.keys(files).length === 0) {
      continue;
    }
    const summary = removeManagedFiles(folder.uri.fsPath, files);
    deleted += summary.deleted;
    for (const rel of summary.keptPaths) {
      allKeptPaths.push({ folder, rel });
    }
    setWorkspaceFiles(folder.uri.fsPath, {});
    await saveState(context, folder, { ref: "", files: {} });
  }

  const kept = allKeptPaths.length;
  if (kept > 0) {
    log(`Removed ${deleted} synced file(s). Kept ${kept} with local edits:`);
    for (const { folder, rel } of allKeptPaths) {
      log(`  ${folder.name}/${rel}`);
    }
  } else {
    log(`Removed ${deleted} synced file(s).`);
  }

  if (kept > 0) {
    const action = await vscode.window.showWarningMessage(
      `AI Setup Sync: Removed ${deleted} ${deleted === 1 ? "file" : "files"}. ${kept} ${kept === 1 ? "file was" : "files were"} kept due to local edits — see the Output panel for details.`,
      "Force remove all",
      "Keep them"
    );
    if (action === "Force remove all") {
      let forceDeleted = 0;
      for (const folder of folders) {
        const paths = allKeptPaths
          .filter((p) => p.folder === folder)
          .map((p) => p.rel);
        forceDeleted += forceRemoveFiles(folder.uri.fsPath, paths);
      }
      log(`Force-removed ${forceDeleted} additional ${forceDeleted === 1 ? "file" : "files"}.`);
      void vscode.window.showInformationMessage(
        `AI Setup Sync: Removed ${forceDeleted} additional ${forceDeleted === 1 ? "file" : "files"}.`
      );
    }
  } else {
    void vscode.window.showInformationMessage(`AI Setup Sync: Removed ${deleted} synced ${deleted === 1 ? "file" : "files"}.`);
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
    vscode.commands.registerCommand(`${CONFIG}.openSettings`, () =>
      vscode.commands.executeCommand("workbench.action.openSettings", CONFIG)
    ),
    vscode.commands.registerCommand(`${CONFIG}.setGitHubToken`, async () => {
      const existing = await getToken(context);
      const input = await vscode.window.showInputBox({
        title: "AI Setup Sync: Set GitHub Token",
        prompt: existing
          ? "A token is already saved. Enter a new one to replace it, or leave blank to remove it."
          : "Enter a classic GitHub personal access token with the 'repo' scope (fine-grained tokens don't support this scope). Required for private repos and SAML SSO-protected org repos.",
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
    })
  );

  // Trigger: sync automatically when a workspace opens.
  if (settings.syncMode === "always" || settings.syncMode === "onOpen") {
    void runSync(context, false);
  }

  // Trigger: periodic background check for content + extension updates.
  schedulePolling(context);

  // Re-arm polling if the user changes our settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG)) {
        schedulePolling(context);
      }
    })
  );
}

let pollTimer: NodeJS.Timeout | undefined;
let pollDisposableRegistered = false;

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function schedulePolling(context: vscode.ExtensionContext): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (readSettings().syncMode !== "always") {
    return;
  }
  pollTimer = setInterval(() => {
    void runSync(context, false);
  }, POLL_INTERVAL_MS);
  // Register the dispose function only once to avoid subscription leak (OPT-4).
  if (!pollDisposableRegistered) {
    pollDisposableRegistered = true;
    context.subscriptions.push({
      dispose: () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
      },
    });
  }
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}
