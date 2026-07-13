// Shared cleanup logic used by BOTH the in-app "Remove Synced Files" command
// (runs in the extension host) and the best-effort vscode:uninstall hook (plain
// Node). Keep it vscode-free so the uninstall script can require it.

import * as fs from "fs";
import * as path from "path";
import { gitBlobSha } from "./blobSha";
import { MARKER_BEGIN, stripBlock } from "./gitignore";

interface CleanupSummary {
  /** Repo-relative paths of files that were successfully deleted. */
  deletedPaths: string[];
  /** Repo-relative paths of files kept because their content differed from the last synced SHA. */
  keptPaths: string[];
}

/**
 * Removes the synced files we recorded for a workspace.
 *
 * Safety: a file is deleted only if its current content still matches the git
 * blob SHA we last wrote (i.e. the developer did not edit it). Locally-modified
 * files are kept so no manual work is lost. Empty directories are pruned and the
 * managed block is stripped from `.git/info/exclude`.
 */
export function removeManagedFiles(
  workspaceFsPath: string,
  files: Record<string, string>
): CleanupSummary {
  const summary: CleanupSummary = { deletedPaths: [], keptPaths: [] };
  const dirsTouched = new Set<string>();
  const workspaceResolved = path.resolve(workspaceFsPath);

  for (const [rel, sha] of Object.entries(files)) {
    const full = path.resolve(workspaceFsPath, rel);
    // Reject any path that escapes the workspace root (defense-in-depth).
    if (!full.startsWith(workspaceResolved + path.sep)) {
      continue;
    }
    try {
      const content = fs.readFileSync(full);
      if (gitBlobSha(content) === sha) {
        fs.unlinkSync(full);
        summary.deletedPaths.push(rel);
        dirsTouched.add(path.dirname(full));
      } else {
        summary.keptPaths.push(rel);
      }
    } catch {
      // Missing or unreadable — nothing to remove.
    }
  }

  pruneEmptyDirs(workspaceFsPath, dirsTouched);
  cleanGitExclude(workspaceFsPath);
  cleanWorktreeInclude(workspaceFsPath);
  return summary;
}

/** Removes now-empty directories, walking up toward (but not removing) the workspace root. */
function pruneEmptyDirs(workspaceFsPath: string, dirs: Set<string>): void {
  // Resolve the root and match with a trailing separator, exactly as removeManagedFiles does.
  // The `dirs` entries come from path.resolve(...), so comparing against the raw arg could
  // mismatch on a drive-letter casing/normalization difference (Windows) and stop the walk
  // early; anchoring to the resolved root keeps the walk correct and inside the workspace.
  const workspaceResolved = path.resolve(workspaceFsPath);
  const ordered = [...dirs].sort((a, b) => b.length - a.length); // deepest first
  for (let dir of ordered) {
    while (dir.startsWith(workspaceResolved + path.sep)) {
      try {
        if (fs.readdirSync(dir).length > 0) {
          break;
        }
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } catch {
        break;
      }
    }
  }
}

function cleanWorktreeInclude(workspaceFsPath: string): void {
  const include = path.join(workspaceFsPath, ".worktreeinclude");
  try {
    const content = fs.readFileSync(include, "utf8");
    if (!content.includes(MARKER_BEGIN)) {
      return;
    }
    const stripped = stripBlock(content);
    if (stripped.trim() === "") {
      fs.unlinkSync(include);
    } else {
      fs.writeFileSync(include, stripped, "utf8");
    }
  } catch {
    // No file — nothing to clean.
  }
}

function cleanGitExclude(workspaceFsPath: string): void {
  const exclude = path.join(workspaceFsPath, ".git", "info", "exclude");
  try {
    const content = fs.readFileSync(exclude, "utf8");
    if (!content.includes(MARKER_BEGIN)) {
      return;
    }
    fs.writeFileSync(exclude, stripBlock(content), "utf8");
  } catch {
    // No exclude file — nothing to clean.
  }
}
