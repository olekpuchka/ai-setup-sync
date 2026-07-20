# Changelog

All notable changes to the **AI Setup Sync** extension are documented here.

---

## [1.7.5] — 2026-07-20

### Changed

- **Refreshed the extension description** — the Marketplace listing and READMEs now lead with "syncs AI setup files and MCP configs (Claude Code, Copilot, Cursor, Codex, Antigravity and more)," making the MCP-config support explicit and consistent across every surface.

---

## [1.7.4] — 2026-07-18

### Fixed

- **No leftover block in `.git/info/exclude`** — when the last synced file is removed (or a sync matches no files, e.g. a wrong branch), the extension now fully strips its managed block from `.git/info/exclude` instead of leaving an empty one behind. Previously the empty block could linger even after uninstall.

---

## [1.7.3] — 2026-07-14

### Security

- **Sync source restricted in untrusted workspaces** — `repository` and `branch` set in workspace settings are ignored until you trust the workspace, so a cloned repo can't repoint your sync. User (global) settings are unaffected.
- **Post-sync command trust-restricted** — `postSyncCommand` is now declared restricted, so VS Code ignores a workspace's command until you trust it.
- **Changed commands ask before running** — if `postSyncCommand` differs from the one you last approved (e.g. a `git pull` swapped it), you're shown it in a dismissible notification and it runs only when you click **Run**. An unchanged command never prompts.

### Changed

- **A newly added or edited post-sync command now runs on the next sync** even when no files changed (once approved), instead of staying silent until the next real change.
- **New "Run Post Sync Command" action** — run the configured command on demand from the status-bar menu or Command Palette, without waiting for a sync.
- **Clearer post-sync command feedback** — a brief notification when it finishes, an error toast (with **Show Log** and **Open Settings**) if it fails, plus a status-bar warning that persists across reloads until it succeeds. Run **Sync Now** to retry a failed command.

### Fixed

- **Large repos no longer fail to sync** — pulling many files at once could trip GitHub's rate limit and fail with HTTP 403. Syncs now use gentler concurrency, wait and retry when GitHub asks, and show a clear rate-limit message instead of a cryptic per-file error.
- **A failed sync no longer gets stuck showing "synced" with no files** — after a failure the next sync re-fetches and retries the files that didn't download, instead of assuming nothing changed.

---

## [1.7.2] — 2026-07-13

### Security

- **Sync never writes into `.git/`** — path mappings and target folders can't place a file inside the git directory. `.github`, `.gitignore`, and `.gitattributes` are unaffected.
- **Path mappings reject control characters** — a destination with a newline or other control character is rejected.
- **Tokens bind to their host sooner** — a token saved before a repository is configured now binds on the next sync. Existing setups are unchanged.

---

## [1.7.1] — 2026-07-13

### Security

- **Token stays on its own host** — your GitHub token is only sent to the host it was saved for, so a project can't redirect the repository URL and leak it. Repos on the same host work as before.
- **Token dropped on cross-host redirects** — it's never forwarded to a different host.
- **Safer path mappings** — mapping destinations with backslashes or drive letters (e.g. `C:\…`) are rejected.

### Fixed

- **Synced files stay hidden from git after a failed download** — if one file failed mid-sync, the files that did sync no longer show up as untracked changes.
- **Temporary GitHub errors are retried** — `502`/`503`/`504` responses retry automatically, so a brief GitHub hiccup no longer fails the sync. If one still fails, the notification is short and clear with a **Show Log** button.

---

## [1.7.0] — 2026-07-12

### Added

- **`postSyncCommand` setting** — run a shell command after a sync changes files, e.g. to generate configs from synced templates. Runs from the workspace folder, **only in [trusted workspaces](https://code.visualstudio.com/docs/editor/workspace-trust)**, with a 2-minute timeout; output goes to the **AI Setup Sync** log, and a failure never fails the sync. Empty by default.
- **First-run setup prompt** — opening a project with no repository configured shows a notification pointing to the repository setting, so a fresh install isn't silent. It stops for good once a repository is set.

---

## [1.6.0] — 2026-07-12

### Added

- **Status-bar action menu** — clicking the **AI Setup Sync** status-bar item now opens a quick-pick menu — **Sync Now**, **Show Log**, **Open Settings**, **Remove Synced Files**, **Set GitHub Token** — instead of syncing immediately. Sync Now is the first (default) item, so a click + Enter still syncs. The menu's header line shows status at a glance: when you last synced, how many files, and from which repo. Every command is now reachable without the Command Palette.
- **Sync progress notification** — a sync that downloads files now shows a progress notification with a bar that fills as it goes and a live **"Syncing X of Y files"** count. It appears only while files are actually being transferred, so routine no-op syncs on window focus stay silent.

---

## [1.5.8] — 2026-07-11

### Changed

- **New extension logo** — refreshed the icon to a transparent, theme-adaptive mark (blue→purple sync arrows around a `{ ⋮ }` core). It's a proper 256×256 PNG with no background, so it reads cleanly in both light and dark VS Code themes and on the Marketplace.

---

## [1.5.7] — 2026-07-10

### Added

- **`.antigravity.md` synced by default** — Google Antigravity (IDE and CLI share config) reads an Antigravity-specific project context file, `.antigravity.md`, which takes precedence over the legacy `GEMINI.md` when both exist. It's now included in the default `targetFolders` alongside `.agents` and `AGENTS.md`, completing Antigravity support.
- **Cursor ignore files synced by default** — added `.cursorignore` (files the AI cannot access) and `.cursorindexingignore` (files excluded from indexing). These live at the repo root rather than inside `.cursor/`, so they weren't previously covered. Syncing them lets you standardize AI file-access rules — e.g. blocking `.env`, keys, and build artifacts — across every project.

---

## [1.5.6] — 2026-07-10

### Changed

- **Gemini CLI → Google Antigravity** — dropped the deprecated `.gemini` and `GEMINI.md` defaults. Google is [retiring Gemini CLI on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/); its successor, Antigravity CLI, reads project config from `.agents/` and `AGENTS.md` — both already synced by default — so migrating users are covered with no change. Enterprise users still on Gemini CLI can re-add the old paths via `"aiSetupSync.targetFolders": { ".gemini": true, "GEMINI.md": true }`.

---

## [1.5.5] — 2026-07-09

### Added

- **MCP configs synced across all tools** — added `.vscode/mcp.json` (VS Code / GitHub Copilot) to the defaults. MCP server configs now sync out of the box for Claude Code, Copilot, and Cursor. Only `mcp.json` is synced from `.vscode`, not the rest of your editor settings.

---

## [1.5.4] — 2026-07-02

### Added

- **`.mcp.json` synced by default** — Claude Code's project-scoped MCP server config is now included in the default `targetFolders`, alongside `.claude` and `CLAUDE.md`. Disable it via `"aiSetupSync.targetFolders": { ".mcp.json": false }` if your MCP config contains machine-specific paths or secrets you don't want synced.

---

## [1.5.3] — 2026-06-26

### Added

- **Locally-modified synced files now visible in git** — if you edit a file that AI Setup Sync manages, it is temporarily removed from `.git/info/exclude` so it surfaces in Source Control and `git status`. This makes local changes inspectable and committable (if intentional). The file goes back into the exclude list as soon as you choose *Take repo version* during the next conflict prompt, or when the conflict is otherwise resolved.

---

## [1.5.2] — 2026-06-26

### Fixed

- **"Keep mine" now persists across all sync types** — previously, choosing *Keep mine* during a full-tree sync (triggered when the repo changes) did not write an acknowledgement entry, so the next 304 sync would re-prompt for the same conflict. Acknowledgements are now written consistently whether the prompt appeared during a 304 or full-tree sync. Once you choose *Keep mine*, you won't be re-prompted as long as neither your local file nor the upstream file has changed.
- **Acknowledged files counted in sync summary** — files silently carried forward via a prior *Keep mine* acknowledgement are now included in the "up to date" count shown after each sync.

---

## [1.5.1] — 2026-06-26

### Added

- **Worktree support** — AI Setup Sync now maintains a `.worktreeinclude` file at the workspace root. Both Claude Code and OpenAI Codex read this file when creating a worktree and copy any matching gitignored files into the new working directory, so synced AI configs (`.claude/`, `.github/`, etc.) are available in every worktree session without re-syncing.
  - Target folders (e.g. `.claude`, `.github`) produce folder-level patterns so the entire folder is copied, including files added to the repo since the last sync.
  - File targets (e.g. `CLAUDE.md`) produce exact file patterns.
  - Path-mapped destinations use the mapping's local destination — a directory mapping like `"Claude": ".claude"` copies the whole `.claude/` folder; a file mapping copies the specific file.
  - `.worktreeinclude` itself is added to `.git/info/exclude` so it never appears as an untracked file.
  - On **Remove Synced Files**, the managed block is stripped from `.worktreeinclude`; if the file becomes empty, it is deleted.

---

## [1.4.2] — 2026-06-25

### Fixed

- **Output log status labels** — file lines in the Output panel now consistently show a status tag at the end of each line (`(deleted)`, `(kept — your edits)`) when using the Remove Synced Files command or during repo-change cleanup, matching the format used by regular sync (`(added)`, `(updated)`, `(deleted)`).

---

## [1.4.1] — 2026-06-25

### Changed

- **Conflict policy removed** — the `aiSetupSync.conflictPolicy` setting (`prompt` / `overwrite` / `skip`) has been removed. Conflicts are always resolved interactively: you're prompted per file with a diff viewer. Users on `overwrite` or `skip` will now see the prompt instead.
- **Remove Synced Files — Show details** — the removal toast now includes a **Show details** button (matching the sync success toast) that opens the Output panel with a per-file log of what was removed and what was kept.
- **Remove Synced Files — kept files now logged during repo change** — when the repository URL changes and old files are cleaned up, any locally-edited files that were kept are now logged to the Output panel (previously silent).

### Fixed

- **Remove Synced Files toast** — when all files had local edits (nothing deleted), the warning toast previously read "Removed 0 files. N files were kept…" — it now reads "N files kept due to local edits." correctly.
- **Output log when only kept files** — when every synced file had local edits, the Output panel showed only "Removed 0 synced files." with no list of kept paths. Kept paths are now always logged when present.

---

## [1.4.0] — 2026-06-25

### Added

- **GitHub Enterprise Server support** — set `aiSetupSync.repository` to any GitHub Enterprise Server URL (e.g. `https://github.company.com/your-org/your-repo`). API calls are automatically routed to the instance's `/api/v3` endpoint. A token with the `repo` scope is required for Enterprise Server repos.

### Changed

- **"Keep mine" conflict button** — the bulk conflict dialog button was renamed from "Keep all mine" to "Keep mine" to better reflect that the choice is per-sync, not permanent.

### Fixed

- **Conflict dialog survives a failed diff fetch** — clicking "Show diff" during conflict resolution no longer aborts the entire conflict loop if the remote file can't be fetched (e.g. missing token on an Enterprise Server repo). The error is shown as a toast and the dialog re-appears so you can still choose Overwrite or Keep mine.
- **Actionable error UI after parallel download failure** — when a file download fails with a token or auth error inside a parallel batch, the "Set GitHub Token" button now correctly appears instead of a generic error message.

---

## [1.3.2] — 2026-06-25

### Changed

- Refreshed README and marketplace listing — problem-first intro, architecture diagram, IP protection callout, and aligned feature descriptions across both docs.

---

## [1.3.1] — 2026-06-23

### Fixed

- **Settings changes now clean up excluded files** — when `targetFolders` or `pathMappings` settings change, previously-synced files that are no longer covered by the new settings are deleted on the next sync. Unmodified copies are removed silently; locally-edited copies follow `aiSetupSync.conflictPolicy`. Previously, excluded files were silently forgotten and left on disk. The fix works by invalidating the cached GitHub tree ETag before re-syncing, forcing a full tree fetch that can evaluate the new settings against every previously-synced file.
- **Path mapping changes clean up old local paths** — when a `pathMappings` value changes (e.g. `".claude"` → `"my-claude"`) or a key is removed, files at the old local path are now deleted if unmodified, or left alone if you've edited them. Previously, the old copies were orphaned on disk and had to be removed manually.
- **Delete conflict prompt wording** — the prompt shown when a locally-edited file is removed from the repo or excluded by settings now reads "removed from the repo or excluded by your settings" instead of just "removed from the shared repo", making it clear which event triggered the dialog.

---

## [1.3.0] — 2026-06-22

### Added

- **Map a subfolder to the project root** — set a `pathMappings` value to `"/"` to sync a repo subfolder's contents straight to your project root. For example, `"projectA": "/"` syncs `projectA/.github/` as `.github/` and `projectA/.claude/` as `.claude/`. This is the simplest way to keep a project's whole AI setup in one repo subfolder.

### Fixed

- **Predictable merging when paths overlap** — when a path mapping and a target folder both point a file at the same local path, the path-mapping version now always wins. Previously the outcome depended on processing order and could change between syncs.
- **Spurious conflict after adding a path mapping** — when a user added a path mapping that changed which repo path wins for a given local file, the next sync could show a false conflict prompt even though the on-disk content matched what the extension last wrote. The classifier now falls back to a local-path lookup when the repo-path key is new.
- **Active file could be deleted when a lower-priority repo path was removed from the repo** — if a dedup-loser repo path was later deleted from the setup repo, the deletion logic could target the winner's live local file and prompt the user to delete it, or delete it silently on `overwrite` policy.
- **Cached sync could write the same file twice with different content** — when `state` transiently held two repo paths mapping to the same local path, the 304 restore loop issued concurrent writes to the same file, with the last download to finish winning non-deterministically. A dedup guard now ensures each local path is processed at most once per 304 pass.
- **State zeroed after a download failure during dedup** — when a higher-priority entry displaced a lower-priority one and its download then failed, the extension deleted the loser's state entry before confirming the winner wrote, leaving no tracking for that local path and causing a spurious conflict on every subsequent sync. The loser is now only pruned once the winner is confirmed in state.
- **Loser entry incorrectly pruned even when winner write failed** — the guard that was meant to keep the loser in state after a failed write checked `!== undefined`, which is always true for any previously-tracked winner (their old SHA is present from the state spread). The check now compares against the winner's new SHA so the loser is only pruned on confirmed success.
- **Spurious conflict when a new mapping winner was never previously tracked** — the SHA fallback used to identify "what we last wrote to this local path" was computed with last-write-wins across all state entries for that path. If a lower-priority targetFolder entry happened to iterate last, its SHA overwrote the correct mapping-entry SHA, causing the next sync to misclassify an unmodified file as a conflict. The fallback now gives mapping entries priority over targetFolder entries, matching the dedup logic.
- **304 sync could use a loser's SHA for conflict detection** — during the transient window between a mapping change and the next full-tree sync, both the winner and loser repo paths can be in state. The 304 loop previously iterated state in insertion order, so the loser could be processed first and its SHA used to check for local modifications, producing spurious conflict prompts. State entries are now sorted so mapping-priority winners are always checked first.
- **"Keep mine" acknowledgements lost after a settings change** — changing path mappings or target folders triggers a full-tree sync that previously cleared all "Keep mine" decisions, causing a re-prompt on the very next cached sync even though the repo content hadn't changed. Acknowledgements are now carried forward for files whose repo SHA is unchanged.

### Documentation

- **Path mappings section reworked** — added a "Which pattern do you want?" decision table, a worked example for mapping a whole subfolder to the project root, and a "How overlaps are resolved" subsection that explains precedence with examples. Added a Requirements section.

---

## [1.2.0] — 2026-06-21

### Changed

- **Syncing is now always automatic** — the `aiSetupSync.syncMode` setting has been removed. The extension syncs on project open and whenever you return focus to the VS Code window (throttled so rapid window switching doesn't re-sync). Use **Sync Now** / the status bar to sync on demand, and `aiSetupSync.conflictPolicy` to control whether local edits are overwritten. The old `always`/`onOpen`/`manual` modes collapse to this single behavior; a leftover `aiSetupSync.syncMode` entry in your settings is harmless and can be deleted.
- **Replaced the 24-hour background poll with a focus-based refresh** — config now updates at the moments you're actually present (so a conflict prompt lands when you can act on it), instead of a timer that could change files while you were away.
- **Settings changes re-sync immediately** — editing the repository, branch, target folders, or path mappings now triggers a sync once the value settles (debounced ~1.5s to avoid syncing against a half-typed value), rather than waiting for the next open.
- **Saving a GitHub token re-syncs right away** — after **Set GitHub Token**, the extension retries the sync immediately instead of waiting for the next trigger.

### Fixed

- **Overlapping syncs could run concurrently** — the re-entrancy guard was set only after the token was read, so two triggers firing close together (e.g. window open + focus) could both start a sync, double-fetching and showing duplicate prompts. The guard is now claimed before any async work.

---

## [1.1.3] — 2026-06-21

### Fixed

- **Failed background sync showed a success status** — after a background sync failed (network error, rate limit, etc.), the status bar incorrectly reverted to the green "Synced" indicator instead of staying on the ⚠ error state, and the tooltip reported a recent successful sync that never happened.
- **GitHub rate-limit backoff was silently cleared** — when a background sync hit the GitHub rate limit, the backoff that pauses further background syncs until the limit resets was wiped immediately after being set, so background syncs no longer honoured it.
- **Status bar stuck on "No repository configured"** — after setting the repository URL for the first time, the status bar stayed on the ⚙ unconfigured state until the window was reloaded. It now updates immediately, and an initial sync runs automatically when auto-sync is enabled.
- **Remove Synced Files missed files with `pathMappings`** — if the local cleanup registry was unavailable, the fallback used repo-relative paths against disk, so files were silently left in place when `pathMappings` remapped them. Cleanup now translates to the correct on-disk paths.

### Changed

- **Registry writes are now atomic** — the internal record of synced files is written via a temp file and atomic rename, so a concurrent read (e.g. from another VS Code window) can never see a half-written file.

---

## [1.1.2] — 2026-06-21

### Fixed

- **Changelog tab missing in VS Code extension view** — `CHANGELOG.md` is now bundled with the VSIX so the Changelog tab appears in the Extensions panel.

### Removed

- **Open Settings command** — removed the `AI Setup Sync: Open Settings` command palette entry; the native VS Code settings search (`aiSetupSync`) covers this without the extra command.

---

## [1.1.1] — 2026-06-21

### Changed

- **Marketplace keywords** — optimised for discoverability within the VS Code Marketplace 10-keyword limit; added "claude sync" as an explicit phrase, retained the highest-signal terms for each supported tool.
- **Extension description** — reworded to be tool-neutral and lead with the shared-repo concept rather than listing individual tools.
- **Manual sync mode description** — clarified to read "Only sync when you click AI Setup Sync in the status bar or run Sync Now from the command palette."

### Documentation

- **README rewritten** — professional rewrite with badge row, table of contents, "How it works" section, streamlined features list, numbered setup steps, commands table, FAQ (6 Q&As), and renamed sections for clarity.
- **Root README and CONTRIBUTING.md** updated — badge row, clearer orientation callout, table of contents in CONTRIBUTING, and consistent polish throughout.
- **Classic token** — all references to GitHub tokens now specify **classic** personal access tokens (fine-grained tokens don't support the `repo` scope) across README, settings descriptions, and the token input prompt.
- **License** — `extension/LICENSE.md` now includes the copyright holder name (was missing from the packaged VSIX).

---

## [1.1.0] — 2026-06-20

### Changed

- **Sync now deletes files removed from the repo** — when a file (e.g. a Claude skill) is deleted from the shared repository, it is deleted from your local project on the next sync. Unmodified files are removed silently. Files you've edited locally are handled per `aiSetupSync.conflictPolicy`: `prompt` asks before deleting, `overwrite` deletes without asking, `skip` keeps them on disk. The sync summary now includes a deletion count, e.g. `"1 added, 2 updated, 1 deleted"`.
- **Empty directories removed after file deletions** — when all files in a folder are deleted from the repo, the now-empty directory is removed from your project automatically. Works recursively — only folders that become fully empty are removed.
- **Faster syncs** — increased concurrent file operations from 5 to 20 for network downloads and 50 for local disk reads, reducing sync time for repos with many files.
- **Diff review** — after clicking *Show diff* in the conflict dialog, a quick pick now appears alongside the open diff tab so you can review and decide without the editor being blocked.
- **Sync notifications** — the toast now shows only non-zero counts (e.g. `"1 added"` instead of `"1 added, 0 updated"`). A **Show details** button opens the output panel with a grouped per-file log.

### Fixed

- **Branch not found error** — when `aiSetupSync.branch` points to a non-existent branch, the error now clearly says which branch is missing and the *Open settings* button lands on the branch setting. Previously showed a generic "Repository not found" message.
- **Wrong repo URL vs branch** — the extension now distinguishes between a missing repo, a missing branch, and a missing token, showing the appropriate message and button for each.
- **Rate limit error masked branch-not-found** — when the branch name is wrong and GitHub is simultaneously rate-limited, the error incorrectly showed a rate limit warning instead of a branch-not-found message.
- **Overwrite ignored with pathMappings on 304 sync** — choosing "Overwrite" for a conflict during a 304 (unchanged repo) sync had no effect when `pathMappings` were configured; files were silently kept instead of overwritten.
- **Delete review Escape counted as "Keep"** — pressing Escape in the per-file delete dialog incorrectly incremented the "kept on disk" counter and logged keep entries for unreviewed files. Escape now correctly leaves those files for re-prompt on the next sync with no count recorded.
- **"Kept on disk" toast missing** — when the user chose Keep for a file deleted from the repo, no sync notification was shown. The toast now correctly fires.
- **Delete review Escape permanently silenced the dialog** — pressing Escape in the per-file "Delete or keep?" dialog suppressed re-prompting on future syncs. It now correctly re-prompts on the next sync, consistent with update conflict Escape behavior.
- **Single-file delete conflict showed redundant batch dialog** — a single locally-edited file removed from the repo prompted a "Delete all / Keep all / Review each" batch modal before the per-file choice. Now goes directly to per-file, matching how single update conflicts work.
- **"Up to date" count inflated in cached syncs** — when some tracked files were excluded by `targetFolders` or `pathMappings` settings, the "N up to date" count in the sync log was over-reported by the number of excluded files.
- **Failed file delete silently dropped from tracking** — if deleting a file from disk failed (e.g. permission error), the file was removed from sync state anyway, so the extension would never retry. The file now stays tracked and is retried on the next sync.
- **Spurious "." in multi-folder toast** — when one workspace folder had no changes, its result contributed a bare `"."` to the shared toast message (e.g. `"1 added. ."`).

### Documentation

- GitHub token guidance now specifies **classic** personal access tokens (fine-grained tokens don't support the `repo` scope) across the README, settings description, and token input prompt.

---

## [1.0.8] — 2026-06-18

### Fixed

- **Registry and gitignore after restore** — when files are restored on a 304 (unchanged repo), the uninstall registry and `.git/info/exclude` now correctly use local paths instead of repo paths. Previously, `pathMappings` users would get wrong paths recorded (e.g. `PlatformA/.claude/` instead of `.claude/`).

### Documentation

- Added **Multi-project repositories** section to the README covering per-project and per-platform subfolder patterns with `pathMappings`.
- Clarified that `targetFolders` disables are only needed when the repo has conflicting root-level files alongside per-platform subfolders.

---

## [1.0.7] — 2026-06-17

### Fixed

- **Target folders restore** — files under a folder disabled in `targetFolders` (e.g. `".claude": false`) are no longer restored after local deletion. Previously the 304 restore path skipped the `targetFolders` check and pulled them back.
- **Misleading "removed upstream" log** — files excluded by `targetFolders` changes no longer appear as "removed in repo" in sync logs. They are now silently dropped from state on the next full tree fetch.

---

## [1.0.6] — 2026-06-17

### Fixed

- **Target folders toggle** — toggling a default folder off (e.g. `".claude": false`) now correctly excludes it. Previously, a partial user config caused a fallback to all defaults, making toggles ineffective.
- **Trailing slash in custom paths** — custom target folder paths with a trailing slash (e.g. `.myTool/`) are now normalized so they match correctly.

---

## [1.0.5] — 2026-06-17

### Changed

- **Target folders toggles** — `aiSetupSync.targetFolders` is now an object (`path → true/false`) instead of a string array. Each default path can be toggled on or off directly in the VS Code settings UI without editing JSON. Custom paths can be added via the "Add Item" button.

---

## [1.0.4] — 2026-06-16

### Added

- **Gemini CLI support** — `.gemini` and `GEMINI.md` added to default synced paths.

---

## [1.0.3] — 2026-06-16

### Fixed

- **Token error message** — invalid/expired token toast now reads "GitHub token is invalid or expired" with a direct action button, instead of telling the user to run a command manually.
- **SSO toast** — org name is now shown in the SSO authorization message when available, instead of the generic "this organization".

### Documentation

- Added status bar section to README explaining the bottom-right indicator and all four states.
- README settings table now consistently mentions the `repo` scope requirement.

---

## [1.0.2] — 2026-06-16

### Fixed

- **401 handling** — invalid or expired tokens now show a **"Set GitHub Token"** button instead of a raw API error message.
- **SSO toast** — when GitHub SSO authorization is required, the error toast now shows an **"Authorize SSO"** button that opens the GitHub authorization page directly in the browser.
- **404 with token** — error message now also hints to verify the token has the `repo` scope, not just the URL.
- **Token input** — the "Set GitHub Token" prompt now mentions the required `repo` scope.
- **Settings description** — the repository setting description now mentions the `repo` scope requirement.

---

## [1.0.1] — 2026-06-16

### Fixed

- **Clearer token error** — when a repository returns 404 without a token set, the error toast now shows a **"Set GitHub Token"** button instead of "Open settings", pointing directly at the token input.
- **Error message copy** — the no-token 404 message now explains the `repo` scope requirement rather than suggesting the URL is wrong.

### Documentation

- README now documents the required `repo` scope and links to the GitHub token creation page in all relevant sections.

---

## [1.0.0] — 2026-06-16

Initial release.

### Features

- **Automatic sync** — pulls on project open and re-checks daily in the background.
- **Multi-tool support** — Claude Code, GitHub Copilot, Cursor, Google Antigravity, OpenAI Codex, and any custom paths via `aiSetupSync.targetFolders`.
- **Conflict resolution** — detects local edits and prompts per file with a built-in diff viewer before overwriting. Configurable via `aiSetupSync.conflictPolicy` (`prompt` / `overwrite` / `skip`).
- **Path mappings** — translate repo folder names to the local paths AI tools expect (e.g. `Claude/` → `.claude/`).
- **Configurable branch** — sync from `main`, `master`, or any branch via `aiSetupSync.branch`.
- **Private & SSO repos** — GitHub personal access token stored securely in the OS keychain via VS Code SecretStorage. SAML SSO org repos supported.
- **Git exclude** — synced files are added to `.git/info/exclude` automatically so they never appear as pending changes.
- **Non-destructive** — files removed from the repo are never deleted from disk; local edits are always preserved on removal.
- **ETag/304 caching** — background checks don't consume GitHub API rate-limit quota when nothing has changed.
