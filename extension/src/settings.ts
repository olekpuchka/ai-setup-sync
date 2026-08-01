import * as vscode from "vscode";

/** Settings namespace and command prefix. */
export const CONFIG = "aiSetupSync";

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

export interface Settings {
  repository: string;
  branch: string;
  targetFolders: string[];
  pathMappings: Record<string, string>;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(CONFIG);
  const raw = c.get<Record<string, boolean>>("targetFolders");
  // Normalise trailing slashes BEFORE merging, or a slashed key can't override its unslashed
  // default — `{".github/": false}` would leave the default `.github: true` in place.
  const overrides: Record<string, boolean> = {};
  if (raw && typeof raw === "object") {
    for (const [folder, on] of Object.entries(raw)) {
      overrides[folder.replace(/\/+$/, "")] = on;
    }
  }
  const merged = { ...DEFAULT_TARGET_MAP, ...overrides };
  const targetFolders = Object.entries(merged).filter(([, on]) => on).map(([f]) => f);
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
export function inspectRepository() {
  return vscode.workspace.getConfiguration(CONFIG).inspect<string>("repository");
}
