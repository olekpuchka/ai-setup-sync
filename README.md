<div align="center">
  <img src="extension/media/icon.png" width="128" alt="AI Setup Sync" />
  <h1>AI Setup Sync</h1>
  <p><strong>One repo. Every project. Always in sync.</strong></p>

  [![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue)](https://marketplace.visualstudio.com/items?itemName=olekpuchka.ai-setup-sync)
  [![Version](https://img.shields.io/github/v/release/olekpuchka/ai-setup-sync?label=version)](https://github.com/olekpuchka/ai-setup-sync/releases)
  [![Stars](https://img.shields.io/github/stars/olekpuchka/ai-setup-sync)](https://github.com/olekpuchka/ai-setup-sync/stargazers)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
</div>

Every AI coding tool wants its own config files in every repo. AI Setup Sync keeps one GitHub repo
as the source of truth and pulls them into each project automatically — agents, skills, commands,
MCP configs, and anything else your tools read. No copy-pasting, and nothing committed to the
project you're working in.

## Why AI Setup Sync

- **Your AI setup never touches a client's codebase** — agents, skills, commands, MCP configs,
  whatever your tools read: it all stays in your own setup repo, and every file synced from it is
  excluded from git in the projects it lands in.
- **Works with any file-based AI config** — Claude Code, Copilot, Cursor, Codex, and Antigravity
  work out of the box, MCP configs included. Custom path mappings cover anything else.
- **Never loses your work** — files you've edited locally are detected and you're prompted, with a
  built-in diff, before anything is replaced.
- **Stays out of your way** — syncs on project open and window focus, reports state in the status
  bar, and reaches every Claude Code and Codex worktree so parallel agent sessions get your setup
  too.

## Requirements

- **VS Code 1.125** or later.
- **A GitHub repository** holding your AI setup files — personal or org, public or private,
  including SAML SSO orgs and GitHub Enterprise Server.
- **For private, SSO-protected, or Enterprise Server repos:** a GitHub **classic** personal access
  token with the **`repo`** scope.

## Install

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=olekpuchka.ai-setup-sync)
   (or search **AI Setup Sync** in the Extensions view).
2. Set `aiSetupSync.repository` to your GitHub repository URL in VS Code **user** settings.
3. Open a project — sync runs automatically.

For private repos, SSO-protected orgs, or GitHub Enterprise Server, add a token — see the
[full setup guide](extension/README.md#setting-up-your-repository).

> **New here?** Open a project before configuring anything and AI Setup Sync prompts you, with a
> shortcut to the repository setting.

## Documentation

- **[Full guide](extension/README.md)** — settings, path mappings, conflict handling, post-sync
  commands, and the FAQ.
- **[Changelog](CHANGELOG.md)** — what changed in each release.
- **[Issues](https://github.com/olekpuchka/ai-setup-sync/issues)** — bug reports, questions, and
  feature requests.

## Architecture

Sync triggers on startup, window focus, and settings changes. The extension core throttles those
triggers and hands off to the sync engine, which fetches the repo tree from the GitHub API — using
an ETag so unchanged trees cost nothing — writes the files it needs to your project, and records
what it wrote so the next sync can tell your edits from its own.

```mermaid
flowchart LR
    classDef vscode fill:#1a1030,stroke:#8B5CF6,stroke-width:2px,color:#C4B5FD,font-size:16px
    classDef core   fill:#0d1d30,stroke:#58A6FF,stroke-width:2px,color:#93C5FD,font-size:16px
    classDef sync   fill:#1f1208,stroke:#F97316,stroke-width:2px,color:#FED7AA,font-size:16px
    classDef github fill:#0d1f13,stroke:#3FB950,stroke-width:2px,color:#86EFAC,font-size:16px
    classDef local  fill:#061b1f,stroke:#06B6D4,stroke-width:2px,color:#67E8F9,font-size:16px
    classDef state  fill:#1a1a1a,stroke:#6B7280,stroke-width:2px,color:#9CA3AF,font-size:16px

    A(["VS CODE EVENTS
    · Extension startup
    · Window focused
    · Settings changed
    · Manual sync command"]):::vscode -->|triggers| B

    B["EXTENSION CORE
    · Throttles background syncs
    · Manages status bar
    · Rate limit handling
    · Registers commands"]:::core -->|dispatches| C

    C{{"SYNC ENGINE
    · Parallel downloads & deletions
    · Conflict detection
    · ETag deduplication
    · Path mapping rules"}}:::sync -->|writes| E

    C -->|saves state| F

    D[("GITHUB API
    · Repo tree (ETag cached)
    · Raw file content
    · PAT auth (keychain)
    · 304 Not Modified")]:::github -->|provides files| C

    E["LOCAL FILES
    · .claude, .github and more
    · Hidden from git tracking"]:::local

    F[("STATE / REGISTRY
    · ETags per file
    · File paths + repo URL")]:::state

    linkStyle 0 stroke:#8B5CF6,stroke-width:2px
    linkStyle 1 stroke:#58A6FF,stroke-width:2px
    linkStyle 2 stroke:#F97316,stroke-width:2px
    linkStyle 3 stroke:#F97316,stroke-width:2px
    linkStyle 4 stroke:#3FB950,stroke-width:2px
```

[CONTRIBUTING.md](CONTRIBUTING.md#key-concepts) covers how each piece is implemented.

## Contributing

Pull requests are welcome for features, bug fixes, and documentation. See
[CONTRIBUTING.md](CONTRIBUTING.md) for local setup, project architecture, and PR guidelines.

## License

Released under the [MIT License](LICENSE).
