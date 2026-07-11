# Contributing to AI Setup Sync

Thanks for your interest in contributing! This guide covers everything you need to go from a fresh
clone to an open pull request.

PRs and issues are welcome — features, bug fixes, docs, and questions.

## Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running the extension locally](#running-the-extension-locally)
- [Project structure](#project-structure)
- [Key concepts](#key-concepts)
- [Building a .vsix](#building-a-vsix)
- [Code style](#code-style)
- [Submitting a pull request](#submitting-a-pull-request)
- [Versioning and releases](#versioning-and-releases)

## Prerequisites

- [Node.js](https://nodejs.org/) 24+
- [VS Code](https://code.visualstudio.com/) 1.85+
- `npm`

## Setup

```sh
git clone https://github.com/olekpuchka/ai-setup-sync.git
cd ai-setup-sync/extension
npm install
npm run compile
```

## Running the extension locally

1. Open the `extension/` folder in VS Code (or the repo root).
2. Press **F5** — this launches an **Extension Development Host** window with the extension loaded.
3. Open any folder in the dev host to trigger a sync.

Changes to TypeScript source require a recompile (`npm run compile`, or `npm run watch` to rebuild
on save) and a reload of the dev host (**Ctrl+R** / **Cmd+R** in the dev host window).

## Project structure

```
extension/
├── src/
│   ├── extension.ts      — activation, commands, status bar + action menu, sync triggers (startup/focus/settings)
│   ├── sync.ts           — core sync logic: diff, conflict resolution, write
│   ├── github.ts         — GitHub API: tree, file fetch, rate-limit/SSO/Enterprise Server handling
│   ├── token.ts          — SecretStorage helpers for the GitHub PAT
│   ├── state.ts          — per-workspace persisted SHA map (globalState)
│   ├── registry.ts       — cross-workspace file registry (for uninstall hook)
│   ├── cleanup.ts        — file removal logic (shared with the uninstall script)
│   ├── blobSha.ts        — git blob SHA computation (mirrors GitHub's hashing)
│   ├── gitignore.ts      — .git/info/exclude management
│   ├── remoteContent.ts  — virtual document provider for diff editor
│   ├── output.ts         — Output channel wrapper
│   └── uninstall.ts      — vscode:uninstall hook (plain Node, no VS Code API)
├── package.json          — manifest, contributes, settings, commands
└── tsconfig.json
```

## Key concepts

**Git blob SHA versioning** — instead of a manifest, the extension uses GitHub's git tree API,
which returns each file's blob SHA. The same SHA is computed locally (`blobSha.ts`) to detect
changes without reading content.

**ETag/304 caching** — tree API requests include the previous ETag. A 304 response means nothing
changed and doesn't count against GitHub's rate limit.

**Sync state** — stored per workspace folder in `context.globalState`. It holds the last-synced
blob SHA for every tracked file (used to distinguish "unmodified since last sync" from "locally
edited"), the tree ETag for 304 caching, and the full repository URL (`repoUrl`) to detect when the
configured repo changes. Every file seen in a sync — including ones already up to date — is
recorded so the restore path can detect local deletions.

**Branch** — `aiSetupSync.branch` (default `main`) is passed as `RepoRef.ref` to all GitHub API
calls. Changing it affects which branch the tree and raw-file requests target.

**Path mappings** — `aiSetupSync.pathMappings` is a `Record<string, string>` that translates
repo-relative source paths to workspace-relative destination paths at write time. Keys are matched
longest-first so more specific paths always win, and trailing slashes are normalized on read. State
is always keyed by the repo path; disk I/O uses the mapped local path. Both the repo-side path
(`validateRepoPath`) and the mapped local path (`validateLocalPath`) are checked for traversal
sequences before any file I/O — this prevents a malicious workspace `.vscode/settings.json` from
writing files outside the workspace root.

## Building a .vsix

```sh
cd extension
npm run vsce:package
# Output: /tmp/ai-setup-sync.vsix
```

## Code style

- TypeScript strict mode.
- ES6+ — arrow functions, `const`/`let`, destructuring, template literals. No `var`.
- `const` by default; `let` only when reassignment is needed.
- No comments explaining *what* the code does — only *why*, and only when the reason is non-obvious.
- No unused variables or imports.
- Run `npm run lint` (type-check) before submitting. There is no separate linter — TypeScript
  strict mode is the bar.

## Submitting a pull request

1. Fork the repo and create a branch from `main`.
2. Make your changes. If you touched the extension, run `npm run lint` to confirm it type-checks clean.
3. Add an entry to [`CHANGELOG.md`](CHANGELOG.md) under a new version header (the maintainer assigns
   the version number).
4. Open a PR against `main`. Keep the title concise — it becomes the commit message on merge.

## Versioning and releases

Releases are built automatically by CI on `v*` tag pushes. The pipeline publishes to the VS Code
Marketplace, extracts the matching `CHANGELOG.md` section as release notes, and creates a GitHub
Release. Only the maintainer cuts releases — you don't need to bump the version in your PR.
