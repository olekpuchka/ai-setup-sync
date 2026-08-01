// Runs on extension uninstall ("vscode:uninstall" in package.json). A plain Node process:
// no vscode API, no workspace context. Reads the registry written during syncs and removes
// the files we created.
//
// Timing: VS Code forks this with its own bundled Node, but only after VS Code is fully
// RESTARTED following the uninstall — not when you click Uninstall — and with a ~5s budget,
// so keep it fast. For immediate cleanup use the "Remove Synced Files" command instead.

import * as fs from "fs";
import { removeManagedFiles } from "./cleanup";
import { readRegistry, registryDir, registryFilePath } from "./registry";

function main(): void {
  try {
    const reg = readRegistry();
    for (const [workspaceFsPath, record] of Object.entries(reg.workspaces)) {
      removeManagedFiles(workspaceFsPath, record.files);
    }
    try {
      fs.unlinkSync(registryFilePath());
      fs.rmdirSync(registryDir());
    } catch {
      /* best effort */
    }
  } catch {
    // Uninstall hooks must never throw loudly; cleanup is best-effort.
  }
}

main();
