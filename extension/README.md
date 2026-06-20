# AI Setup Sync

Keep your team's AI setup files — Claude Code, GitHub Copilot, Cursor, Google Antigravity,
Gemini CLI, OpenAI Codex, and more — in sync across every project, automatically.

AI teams maintain per-tool configuration files: system prompts, coding instructions, agent skills,
Copilot rules. Keeping them consistent across dozens of projects and developers is manual and
error-prone. **AI Setup Sync** solves this by treating your AI setup files like shared code: you
maintain one GitHub repository, and every developer's projects stay current without doing anything.

Changes flow in one direction: repo → projects. Developers can edit files locally; the extension
detects conflicts and lets them choose what to keep.

> **Before you start** — you'll need a GitHub repository containing your shared AI setup files.
> See [Setting up your repository](#setting-up-your-repository) below.

## Features

- **Automatic sync** — pulls on project open and re-checks daily in the background.
- **Multi-tool support** — Claude Code, GitHub Copilot, Cursor, Google Antigravity, Gemini CLI, OpenAI Codex, and any custom paths.
- **Conflict resolution** — detects local edits and prompts per file, with a built-in diff viewer before overwriting.
- **Path mappings** — translate any repo path to the local path tools expect (e.g. `Claude/` → `.claude/`, or `PlatformA/.claude/` → `.claude/`).
- **Configurable branch** — sync from `main`, `master`, or any branch your repo uses.
- **Git exclude** — synced files are silently added to `.git/info/exclude` so they never appear as pending changes.
- **Private & SSO repos** — GitHub token stored securely in the OS keychain (VS Code SecretStorage).
- **Safe deletions** — files removed from the repo are deleted locally on the next sync. Unmodified files are removed silently; files you've edited locally are handled per `aiSetupSync.conflictPolicy`. Directories that become empty after file deletions are removed automatically.

## Quick start

1. Search **AI Setup Sync** in VS Code Extensions and install, or use the Install button on this page.
2. Set `aiSetupSync.repository` to your GitHub repository URL in VS Code **user** settings.
3. Open a project — sync runs automatically.

## Setting up your repository

The extension syncs from any GitHub repository you own. Here's how to set one up:

1. Create a GitHub repository and add your setup files on your default branch (`main` or `master`). Any combination of tools is supported — just place files where each tool expects them.

   **Example layout:**
   ```
   your-setup-repo/
   ├── CLAUDE.md                          # Claude Code root instructions
   ├── AGENTS.md                          # Cross-tool instructions (Antigravity, Cursor, Claude Code)
   ├── .claude/
   │   ├── instructions/
   │   │   └── coding-style.md
   │   └── skills/
   │       └── code-review/
   │           └── SKILL.md
   ├── .github/
   │   └── copilot-instructions.md        # GitHub Copilot instructions
   ├── .cursor/
   │   └── rules/
   │       └── coding-style.mdc           # Cursor rules
   ├── .agents/
   │   └── skills/
   │       └── code-review.md             # Google Antigravity skills
   ├── .gemini/
   │   └── settings.json                  # Gemini CLI config
   ├── GEMINI.md                          # Gemini CLI workspace context
   └── .codex/
       └── config.toml                    # OpenAI Codex config
   ```

2. Set `aiSetupSync.repository` to your repository URL in VS Code **user** settings.
3. If your repo organises files under different names (e.g. `Claude/` instead of `.claude/`), configure `aiSetupSync.pathMappings` — keys are repo paths, values are local destinations:
   ```json
   "aiSetupSync.pathMappings": {
     "Claude":  ".claude",
     "Copilot": ".github",
     "Cursor":  ".cursor",
     "Codex":   ".codex"
   }
   ```
   `Claude/instructions/style.md` → `.claude/instructions/style.md`, and so on.
4. If your repo is private or behind SAML SSO, run **AI Setup Sync: Set GitHub Token** from the command palette. [Create a **classic** personal access token](https://github.com/settings/tokens/new) with the **`repo`** scope (fine-grained tokens don't support this scope), then — for SAML SSO orgs — authorize it for your org on GitHub (*Settings → Personal access tokens → Configure SSO → Authorize*).
5. If your default branch is not `main`, set `aiSetupSync.branch` to match (e.g. `master`).
6. Push changes to your branch — every project syncs automatically on the next open or background check.

**Shared vs project-specific files:** Add shared instructions to the central repo and open a PR — on merge they sync to every project. Keep project-specific files in your project repo; the extension only touches files it synced and leaves everything else alone.

## Default synced paths

By default, the extension syncs these paths from the `main` branch (configurable via `aiSetupSync.branch`). `.cursorrules` is not included — use `.cursor/rules/` instead.

| Path | Tool |
| --- | --- |
| `.claude` | Claude Code |
| `CLAUDE.md` | Claude Code |
| `.github` | GitHub Copilot |
| `.cursor` | Cursor |
| `.agents` | Google Antigravity |
| `AGENTS.md` | Google Antigravity (also read by Cursor and Claude Code) |
| `.gemini` | Gemini CLI |
| `GEMINI.md` | Gemini CLI |
| `.codex` | OpenAI Codex |

Configurable via `aiSetupSync.targetFolders` — toggle defaults on or off, or add custom paths.

> **Private and SSO-protected repositories** require a **classic** GitHub personal access token with the **`repo`** scope — [create one here](https://github.com/settings/tokens/new) (fine-grained tokens don't support this scope). Run
> **AI Setup Sync: Set GitHub Token** from the command palette to store it securely in the
> OS keychain. For SAML SSO repos, also authorize the token for your organisation in GitHub:
> *Settings → Personal access tokens → Configure SSO → Authorize*.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `aiSetupSync.repository` | *(required)* | GitHub repository URL to sync from, e.g. `https://github.com/your-org/your-repo`. Private repos and SAML SSO org repos require a **classic** personal access token with the **`repo`** scope — run **Set GitHub Token** from the command palette. |
| `aiSetupSync.branch` | `main` | Branch to sync from. Set to `master` or any other branch name if your repo uses a different default. |
| `aiSetupSync.targetFolders` | *(see above)* | Files and folders to sync from the repo root. Each entry can be toggled on or off — set to `false` to disable a default without removing it. Add new entries for any tool that reads config from your project. |
| `aiSetupSync.pathMappings` | `{}` | Rename paths as files are synced from the repo to your project. `"Claude": ".claude"` rewrites `Claude/instructions/style.md` → `.claude/instructions/style.md`. More specific (longer) keys always win. |
| `aiSetupSync.conflictPolicy` | `prompt` | How to handle files you've edited locally that differ from the repository version. `prompt` — ask per file, with a *Show diff* button. `overwrite` — always replace. `skip` — never touch local edits. |
| `aiSetupSync.syncMode` | `always` | When to sync automatically. `always` — on open + daily background check. `onOpen` — on open only. `manual` — only when you run *Sync Now*. |

## Multi-project repositories

If your repo organises setup files under per-project subfolders (e.g. `Project1/`, `Project2/`) or per-platform subfolders (e.g. `PlatformA/`, `PlatformB/`), you can use `pathMappings` to pull only from the subfolder that matches your current project.

**Example repo layout:**
```
your-setup-repo/
├── PlatformA/
│   ├── .claude/
│   ├── CLAUDE.md
│   └── .github/
└── PlatformB/
    ├── .claude/
    ├── CLAUDE.md
    └── .github/
```

**Fetching `.claude` and `CLAUDE.md` from PlatformA:**
```json
"aiSetupSync.pathMappings": {
  "PlatformA/.claude": ".claude",
  "PlatformA/CLAUDE.md": "CLAUDE.md"
}
```

Mapping keys can be any repo path, not just top-level folders. In this example:

- `PlatformA/.claude/` and everything inside → `.claude/` locally
- `PlatformA/CLAUDE.md` → `CLAUDE.md` locally
- `PlatformA/.github/`, `PlatformB/`, and everything else → ignored, no mapping defined

**If your repo also has shared files at the root level** (e.g. a common `.claude/` alongside the per-platform folders) they will be synced too, because `targetFolders` includes `.claude` by default. To prevent that, disable the root-level entries:
```json
"aiSetupSync.targetFolders": {
  ".claude": false,
  "CLAUDE.md": false
},
"aiSetupSync.pathMappings": {
  "PlatformA/.claude": ".claude",
  "PlatformA/CLAUDE.md": "CLAUDE.md"
}
```

To switch platforms, update the mapping keys (e.g. replace `PlatformA` with `PlatformB`). Everything else stays the same.

## Conflict handling

On each sync the extension compares file content against what it last wrote:

- **Unmodified** → updated silently.
- **Deleted locally** → re-added automatically.
- **Edited locally** → handled per `aiSetupSync.conflictPolicy`. With `prompt` (default):

  | Choice | Effect |
  | --- | --- |
  | *Overwrite all* | Replace with repo version. (Shown when multiple files conflict; for a single file, the per-file dialog appears directly.) |
  | *Keep all mine* | Leave your edits; won't re-prompt while your local version stays unchanged. |
  | *Review each* | Decide file by file — each dialog has a *Show diff* button to compare local vs. repository before choosing. |
  | Escape / close | Re-prompts on the next sync. |

**Files removed from the repo** are deleted from your project on the next sync. Unmodified files are removed silently. Files you've edited locally follow `aiSetupSync.conflictPolicy` — with `prompt` you'll be asked before deletion (Escape re-prompts on the next sync), with `skip` they are kept on disk. Directories that become empty after file deletions are removed automatically.

## Status bar

Once installed, look for **AI Setup Sync** in the status bar at the very bottom of the VS Code window (right side). It shows sync state at a glance and clicking it triggers an immediate sync.

| Indicator | Meaning |
| --- | --- |
| `✓ AI Setup Sync` | Up to date — last sync completed successfully. |
| `⟳ AI Setup Sync` | Sync in progress. |
| `⚠ AI Setup Sync` | Sync failed — hover to see the error, click to retry. |
| `⚙ AI Setup Sync` | No repository configured — click to open settings. |

## Commands

All commands are under the **AI Setup Sync** category in the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

- **Sync Now** — sync immediately.
- **Remove Synced Files** — delete synced files from the project (local edits are preserved).
- **Open Settings** — jump to extension settings.
- **Set GitHub Token** — securely store a GitHub personal access token in the OS keychain (required for private repos and SAML SSO org repos). Use a **classic** token with the **`repo`** scope (fine-grained tokens don't support this scope); for SAML SSO orgs, also authorize it via *Settings → Personal access tokens → Configure SSO*. Submit empty to clear.

Activity is logged to the **AI Setup Sync** output channel (Output panel → dropdown).

## Git exclude

Synced files are automatically added to `.git/info/exclude` (per-clone, never committed) so
they don't show up as pending changes. Only the exact synced files are excluded — anything you
create yourself in the same folders (e.g. a project-specific skill) stays visible to git and
committable normally.

## Removing synced files

Run **Remove Synced Files** before uninstalling for an immediate cleanup. The extension also
runs a cleanup hook on uninstall, but it fires only after a full VS Code restart.

Only files whose content matches what the extension last wrote are removed — files you edited
locally are kept so no work is lost. If any files are kept, they are listed in the
**AI Setup Sync** output channel and a **Force remove all** button is offered to
delete them regardless of local edits.

## License

[MIT](https://github.com/olekpuchka/ai-setup-sync/blob/main/LICENSE)
