# AI Setup Sync

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue.png)](https://marketplace.visualstudio.com/items?itemName=olekpuchka.ai-setup-sync)
[![Version](https://img.shields.io/github/v/release/olekpuchka/ai-setup-sync.png?label=version)](https://github.com/olekpuchka/ai-setup-sync/releases)
[![Stars](https://img.shields.io/github/stars/olekpuchka/ai-setup-sync.png)](https://github.com/olekpuchka/ai-setup-sync/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.png)](https://github.com/olekpuchka/ai-setup-sync/blob/main/LICENSE)

**One repo. Every project. Always in sync.**

Every AI coding tool needs its own config files in every repo. AI Setup Sync maintains yours once
in a GitHub repository and distributes it automatically across every project — Claude Code, GitHub
Copilot, Cursor, Google Antigravity, OpenAI Codex, and more. No copy-pasting.

Treat your AI setup like shared code: change it in one place, and it propagates everywhere.

---

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Setting up your repository](#setting-up-your-repository)
- [Default synced paths](#default-synced-paths)
- [Settings](#settings)
- [Path mappings & multi-project repos](#path-mappings--multi-project-repos)
- [Post-sync command](#post-sync-command)
- [Conflict handling](#conflict-handling)
- [Status bar](#status-bar)
- [Commands](#commands)
- [How files stay out of git](#how-files-stay-out-of-git)
- [Removing synced files](#removing-synced-files)
- [FAQ](#faq)

---

## How it works

Put your shared AI config files in one GitHub repo (`.claude/`, `CLAUDE.md`,
`.github/copilot-instructions.md`, `.cursor/rules/`, …). Point the extension at that repo, and it
pulls the latest files into each project on open and window focus.

Sync flows one way: **repo → projects**. You can still edit files locally — the extension detects
those edits and lets you choose what to keep, so no work is ever silently overwritten.

> **Before you start** — you'll need a GitHub repository containing your shared AI setup files.
> See [Setting up your repository](#setting-up-your-repository).

## Features

- **Syncs automatically** — pulls from your GitHub repo on project open and window focus. No manual steps.
- **Protects your Intellectual Property** — your AI setup lives in your own private repository, syncs automatically into each project, and is excluded from git. Your instructions never touch a client's codebase.
- **Supports every tool** — any file-based AI config works out of the box (Claude Code, Copilot, Cursor, and more). Custom path mappings cover anything else.
- **Protects local edits** — detects local edits and prompts per file, with a built-in diff viewer before anything is overwritten.
- **Maps paths flexibly** — translate any repo path to the local path a tool expects (e.g. `Claude/` → `.claude/`), or map a whole subfolder to your project root with `"projectA": "/"`.
- **Handles deletions safely** — files removed from the repo or excluded by a settings change are removed locally; your local edits are protected, and emptied directories are cleaned up.
- **Stays out of git** — synced files are added to `.git/info/exclude` so they never clutter your pending changes. Edit one locally and it surfaces automatically so you can see the diff.
- **Works across parallel agent sessions** — synced configs are automatically available in every Claude Code and Codex worktree, so AI tools have your setup no matter which isolated session they run in.
- **Supports private, SSO, and Enterprise Server repos** — GitHub token stored securely in the OS keychain (VS Code SecretStorage).
- **Fully configurable** — choose the branch and which folders to sync.
- **One-click status bar** — a status-bar item shows sync state and opens an action menu (Sync Now, Show Log, Open Settings, Remove Synced Files, Set GitHub Token); larger syncs show a live progress notification.
- **Runs your build step** — an optional post-sync command turns synced templates into finished configs (generate, inject secrets, merge), only in trusted workspaces.

## Requirements

- **VS Code 1.85** or later.
- **A GitHub repository** containing your shared AI setup files — public, private, SAML SSO org, or hosted on GitHub Enterprise Server.
- **For private, SSO-protected, or Enterprise Server repos:** a GitHub **classic** personal access token with the **`repo`** scope.

## Quick start

1. Install **AI Setup Sync** from the VS Code Marketplace (or the Install button on this page).
2. Set `aiSetupSync.repository` to your GitHub repository URL in VS Code **user** settings.
3. Open a project — sync runs automatically.

That's it for public repos. For private repos, SSO-protected orgs, or Enterprise Server, add a token (see below).

> **New here?** Open a project before configuring anything and AI Setup Sync prompts you, with a shortcut to the repository setting.

## Setting up your repository

The extension syncs from any GitHub repository you own.

**1. Create a repository** and add your setup files on your default branch (`main` or `master`).
Any combination of tools works — just place files where each tool expects them.

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
├── .cursorignore                      # Cursor: files the AI can't access
├── .agents/
│   └── skills/
│       └── code-review.md             # Google Antigravity skills
├── .antigravity.md                    # Google Antigravity workspace context
└── .codex/
    └── config.toml                    # OpenAI Codex config
```

**2. Point the extension at it** — set `aiSetupSync.repository` to your repository URL in VS Code
**user** settings.

**3. Map paths if needed.** If your repo organises files under different names (e.g. `Claude/`
instead of `.claude/`), configure `aiSetupSync.pathMappings` — keys are repo paths, values are
local destinations:

```json
"aiSetupSync.pathMappings": {
  "Claude":  ".claude",
  "Copilot": ".github",
  "Cursor":  ".cursor",
  "Codex":   ".codex"
}
```

`Claude/instructions/style.md` then syncs to `.claude/instructions/style.md`, and so on.

**4. Add a token for private repos, SSO orgs, or Enterprise Server.** Run **AI Setup Sync: Set GitHub Token** from the
command palette. [Create a **classic** personal access token](https://github.com/settings/tokens/new)
with the **`repo`** scope (fine-grained tokens don't support this scope). For SAML SSO orgs, also
authorize it for your org (*Settings → Personal access tokens → Configure SSO → Authorize*).

**5. Set the branch if it isn't `main`** — set `aiSetupSync.branch` to match (e.g. `master`).

**6. Push and you're done.** Every project picks up the change the next time it's opened or refocused.

> **Shared vs project-specific files:** Add shared instructions to the central repo and open a PR —
> on merge they sync to every project. Keep project-specific files in your project repo; the
> extension only touches files it synced and leaves everything else alone.

## Default synced paths

By default, the extension syncs these paths from the `main` branch (configurable via
`aiSetupSync.branch`). `.cursorrules` is not included — use `.cursor/rules/` instead.

| Path | Tool |
| --- | --- |
| `.claude` | Claude Code |
| `CLAUDE.md` | Claude Code |
| `.mcp.json` | Claude Code (project-scoped MCP servers) |
| `.github` | GitHub Copilot |
| `.vscode/mcp.json` | GitHub Copilot / VS Code (MCP servers) |
| `.cursor` | Cursor |
| `.cursorignore` | Cursor (blocks AI access) |
| `.cursorindexingignore` | Cursor (excludes from indexing) |
| `.agents` | Google Antigravity |
| `AGENTS.md` | Google Antigravity (also read by Cursor and Claude Code) |
| `.antigravity.md` | Google Antigravity (Antigravity-specific context) |
| `.codex` | OpenAI Codex |

Configure via `aiSetupSync.targetFolders` — toggle defaults on or off, or add custom paths.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `aiSetupSync.repository` | *(required)* | GitHub repository URL to sync from, e.g. `https://github.com/your-org/your-repo`. GitHub Enterprise Server is also supported (e.g. `https://github.company.com/your-org/your-repo`). Private repos, SAML SSO orgs, and Enterprise Server repos need a token — see [Setting up your repository](#setting-up-your-repository). |
| `aiSetupSync.branch` | `main` | Branch to sync from. Set to `master` or any other branch if your repo uses a different default. |
| `aiSetupSync.targetFolders` | *(see above)* | Files and folders to sync from the repo root. Each entry can be toggled on or off — set to `false` to disable a default without removing it. Add entries for any tool that reads config from your project. |
| `aiSetupSync.pathMappings` | `{}` | Rename paths as files sync from the repo to your project. `"Claude": ".claude"` rewrites `Claude/instructions/style.md` → `.claude/instructions/style.md`. Use `"/"` to map a subfolder to your project root: `"projectA": "/"` syncs `projectA/.github/` as `.github/`. See [Path mappings & multi-project repos](#path-mappings--multi-project-repos) for how overlaps are resolved. |
| `aiSetupSync.postSyncCommand` | *(empty)* | Shell command to run after a sync changes files — e.g. generate configs from synced templates. Runs **only in trusted workspaces**. See [Post-sync command](#post-sync-command). |

## Path mappings & multi-project repos

Path mappings rewrite a repo path to a different local path as files sync. Reach for them when your
repo's layout doesn't match what your tools expect at the project root — for example, when setup
files live under per-project or per-platform subfolders, or under names like `Claude/` instead of
`.claude/`.

**Which pattern do you want?**

| If you want to… | Set | See |
| --- | --- | --- |
| Rename a folder | `"Claude": ".claude"` | [Setting up your repository](#setting-up-your-repository) |
| Sync one subfolder's contents to your project root | `"projectA": "/"` | [Map a whole subfolder](#map-a-whole-subfolder-to-the-workspace-root) |
| Pull only specific subpaths from a multi-project repo | `"PlatformA/.claude": ".claude"` | [Map individual subpaths](#map-individual-subpaths) |

### Map a whole subfolder to the workspace root

Set the mapping value to `"/"` to strip a subfolder prefix and sync everything inside it straight to
your project root. This is the simplest setup when one repo subfolder holds a project's whole AI setup:

**Example repo layout:**

```
your-setup-repo/
├── .github/                        # shared across all projects
└── projectA/
    ├── .github/                    # projectA-specific agents and instructions
    ├── .claude/
    └── .cursor/
```

**Config:**

```json
"aiSetupSync.pathMappings": {
  "projectA": "/"
}
```

Every file under `projectA/` syncs to the workspace root with its prefix stripped:

| Repo path | Local path |
| --- | --- |
| `projectA/.github/agents/coding.md` | `.github/agents/coding.md` |
| `projectA/.claude/commands/foo.md` | `.claude/commands/foo.md` |
| `projectA/.cursor/rules/style.mdc` | `.cursor/rules/style.mdc` |

**Merging root files with the subfolder**

If both the root `.github/` and `projectA/.github/` exist in the repo, files from both land in your
local `.github/`. Differently named files simply merge together. If the same file exists in both, the
**mapped subfolder wins** — `projectA/.github/agents/coding.md` overrides the root
`.github/agents/coding.md`.

To sync only specific root folders alongside the subfolder — for example `.github` from the root but
nothing else — disable the defaults you don't need:

```json
"aiSetupSync.targetFolders": {
  ".claude": false,
  ".cursor": false,
  ".agents": false
},
"aiSetupSync.pathMappings": {
  "projectA": "/"
}
```

### Map individual subpaths

For finer control — or when different projects share the same repo and each needs only its own
folder — map specific subpaths instead of the whole project folder:

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

- `PlatformA/.claude/` and everything inside → `.claude/` locally
- `PlatformA/CLAUDE.md` → `CLAUDE.md` locally
- `PlatformA/.github/`, `PlatformB/`, and everything else → ignored (no mapping defined)

**If your repo also has shared files at the root** (e.g. a common `.claude/` alongside the
per-platform folders), they'll be synced too because `targetFolders` includes `.claude` by default.
To prevent that, disable the root-level entries:

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

To switch platforms, update the mapping keys (e.g. replace `PlatformA` with `PlatformB`). Everything
else stays the same.

### How overlaps are resolved

When more than one rule could apply to the same file, the outcome is always predictable:

- **A mapping and a target folder point at the same file** → the mapping wins. (Example: a root
  `.github/agents/coding.md` from a target folder and a `projectA/.github/agents/coding.md` mapped to
  `.github/` — the mapped one is kept.)
- **Two mapping keys match the same file** → the more specific key wins (the one that matches more of
  the path). This lets a nested key override a broader one:

  ```json
  "aiSetupSync.pathMappings": {
    "projectA":         "/",
    "projectA/.github": "archive/.github"
  }
  ```

  Here `projectA/.github/agents/coding.md` follows the more specific `projectA/.github` rule and syncs
  to `archive/.github/agents/coding.md`, while everything else under `projectA/` falls back to the
  broader `"/"` rule and syncs to your project root.

In every case each repo file syncs to exactly one local path — overlapping rules never produce
duplicate copies.

## Post-sync command

When synced files need a build step — rendering a template, injecting secrets, merging a fragment —
`aiSetupSync.postSyncCommand` runs a shell command after a sync changes files:

```json
"aiSetupSync.postSyncCommand": "npm run generate"
```

- Runs once the whole sync finishes, **only in [trusted workspaces](https://code.visualstudio.com/docs/editor/workspace-trust)** — a cloned repo can't run code just because you opened it.
- Skips no-op syncs, has a 2-minute timeout, and logs its output to the **AI Setup Sync** channel.
- If it fails you get an error toast, but the sync itself still succeeds.

Leave it empty to disable. Two things to keep in mind:

- **Don't write into synced paths** — the next sync would treat those files as locally edited.
- **Its output goes to the log**, exactly like a terminal — so keep secrets in files (`op inject`, `sops`, `envsubst`), not echoed to stdout.

## Conflict handling

On each sync the extension compares file content against what it last wrote:

- **Unmodified** → updated silently.
- **Deleted locally** → re-added automatically.
- **Edited locally** → you're prompted to choose:

  | Choice | Effect |
  | --- | --- |
  | *Overwrite all* | Replace with the repo version. (Shown when multiple files conflict; a single file goes straight to the per-file dialog.) |
  | *Keep mine* | Leave your edits; won't re-prompt as long as your local version **and** the upstream file both stay unchanged. |
  | *Review each* | Decide file by file — each dialog has a *Show diff* button to compare local vs. repository. |
  | Escape / close | Re-prompts on the next sync. |

**Files removed from the repo** or **excluded by a settings change** (e.g. you toggled a folder
off in `targetFolders`, changed a `pathMappings` key, or changed its destination path) are deleted
from your project on the next sync. Unmodified files are removed silently; locally-edited files
prompt you before deletion (Escape re-prompts next sync). Directories that become empty after
deletions are removed automatically.

## Status bar

Look for **AI Setup Sync** in the status bar (bottom-right of the VS Code window). It shows sync
state at a glance; click it to open the **action menu** (Sync Now, Show Log, Open Settings, Remove
Synced Files, Set GitHub Token). Sync Now is the first item, so a click + Enter syncs immediately.

| Indicator | Meaning |
| --- | --- |
| `✓ AI Setup Sync` | Up to date — last sync completed successfully. |
| `⟳ AI Setup Sync` | Sync in progress. |
| `⚠ AI Setup Sync` | Sync failed — hover to see the error, click for the action menu. |
| `⚙ AI Setup Sync` | No repository configured — click for the action menu. |

When a sync downloads files, a progress notification with a bar and a live **"Syncing X of Y
files"** count appears — only while files are actually being transferred, so routine no-op syncs
stay silent.

## Commands

Every action is available from the status-bar **action menu**. **Sync Now**, **Remove Synced
Files**, and **Set GitHub Token** are also in the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
under the **AI Setup Sync** category; **Show Log** and **Open Settings** are menu-only shortcuts to
VS Code's own actions.

| Action | Description |
| --- | --- |
| **Sync Now** | Sync immediately. |
| **Show Log** | Open the **AI Setup Sync** output channel. |
| **Open Settings** | Open the extension's settings. |
| **Remove Synced Files** | Delete synced files from the project (local edits are preserved). |
| **Set GitHub Token** | Securely store a GitHub PAT in the OS keychain — needed for private, SAML SSO, and Enterprise Server repos. See [Setting up your repository](#setting-up-your-repository) for token requirements. Submit empty to clear. |

Activity is logged to the **AI Setup Sync** output channel (Output panel → dropdown, or **Show
Log** from the menu).

## How files stay out of git

Synced files are automatically added to `.git/info/exclude` (per-clone, never committed) so they
don't show up as pending changes. Only the exact synced files are excluded — anything you create
yourself in the same folders (e.g. a project-specific skill) stays visible to git and committable
normally.

If you edit a synced file locally, the extension detects the change on save and removes it from
the exclude list immediately — the file surfaces in Source Control and `git status` without any
manual step. The next time you sync, you'll be prompted to keep your edits or take the repo
version; taking the repo version puts the file back into the exclude list, while keeping your
edits leaves it visible so the drift stays inspectable.

### Parallel agent sessions (worktrees)

Claude Code and OpenAI Codex can run tasks in isolated copies of your repo called
[git worktrees](https://git-scm.com/docs/git-worktree) — for example, fixing a bug in one terminal
while building a feature in another. Each worktree is a fresh checkout, so synced files wouldn't
normally be there.

AI Setup Sync handles this automatically by maintaining a `.worktreeinclude` file at your workspace
root. Both tools read it when creating a worktree and copy any matching gitignored files across, so
your AI configs are present in every session without any extra steps.

The patterns mirror your sync configuration:

- **Folder targets** (e.g. `.claude`, `.github`) copy the whole folder — including files added to
  the repo after the last sync.
- **File targets** (e.g. `CLAUDE.md`, `AGENTS.md`) copy the exact file.
- **Path mappings** use the local destination, file or folder (e.g. `"Claude": ".claude"` copies
  the whole `.claude/` folder; `"src/config.json": ".cursor/config.json"` copies just that file).

`.worktreeinclude` itself is excluded from git tracking so it never appears as an untracked file.

## Removing synced files

Run **Remove Synced Files** before uninstalling for an immediate cleanup. The extension also runs a
cleanup hook on uninstall, but it fires only after a full VS Code restart.

Only files whose content matches what the extension last wrote are removed — files you edited
locally are kept so no work is lost. If any files are kept, a warning toast appears with a
**Show details** button that lists them in the **AI Setup Sync** output channel.

## FAQ

**When does it sync?**
Automatically: when you open a project, when you return focus to the VS Code window (throttled so
rapid window-switching doesn't re-sync), and shortly after you change a relevant setting or set a
GitHub token. You can also sync on demand any time with **Sync Now** — from the status-bar action
menu or the command palette. There's no schedule to configure — it just stays current at the
moments you're working.

**Does it ever modify files I created myself?**
No. The extension only touches files it synced from the repo. Anything else in your project is left
untouched and stays visible to git.

**Is syncing two-way?**
No — it's one-way, repo → projects. Local edits aren't pushed back; instead they're detected and you
choose whether to keep them or take the repo version.

**Why does it need a *classic* token and not a fine-grained one?**
Fine-grained personal access tokens don't support the `repo` scope this extension relies on. Use a
[classic token](https://github.com/settings/tokens/new) with the `repo` scope.

**Where is my token stored?**
In the OS keychain via VS Code's SecretStorage — never in settings, files, or the repo.

**Can I sync from a private or SSO-protected repo?**
Yes — add a GitHub token; see [Setting up your repository](#setting-up-your-repository).

**Does it support GitHub Enterprise Server?**
Yes. Set `aiSetupSync.repository` to your Enterprise Server repo URL (e.g. `https://github.company.com/your-org/your-repo`); it always requires a token — see [Setting up your repository](#setting-up-your-repository).

**Will it work across a whole team?**
That's the point. Everyone installs the extension and points at the same repo; merge a change and it
reaches every project on the next sync.

## License

[MIT](https://github.com/olekpuchka/ai-setup-sync/blob/main/LICENSE)
