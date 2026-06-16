# Changelog

All notable changes to the **AI Setup Sync** extension are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
- **Multi-tool support** — Claude Code, GitHub Copilot, Cursor, Google Antigravity 2.0, OpenAI Codex, and any custom paths via `aiSetupSync.targetFolders`.
- **Conflict resolution** — detects local edits and prompts per file with a built-in diff viewer before overwriting. Configurable via `aiSetupSync.conflictPolicy` (`prompt` / `overwrite` / `skip`).
- **Path mappings** — translate repo folder names to the local paths AI tools expect (e.g. `Claude/` → `.claude/`).
- **Configurable branch** — sync from `main`, `master`, or any branch via `aiSetupSync.branch`.
- **Private & SSO repos** — GitHub personal access token stored securely in the OS keychain via VS Code SecretStorage. SAML SSO org repos supported.
- **Git exclude** — synced files are added to `.git/info/exclude` automatically so they never appear as pending changes.
- **Non-destructive** — files removed from the repo are never deleted from disk; local edits are always preserved on removal.
- **ETag/304 caching** — background checks don't consume GitHub API rate-limit quota when nothing has changed.
