# Changelog

All notable changes to the **AI Setup Sync** extension are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
