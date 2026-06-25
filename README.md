<div align="center">
  <img src="extension/media/icon.png" width="128" alt="AI Setup Sync" />
  <h1>AI Setup Sync</h1>
  <p><strong>One repo. Every project. Always in sync.</strong></p>

  [![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue)](https://marketplace.visualstudio.com/items?itemName=olekpuchka.ai-setup-sync)
  [![Version](https://img.shields.io/github/v/release/olekpuchka/ai-setup-sync?label=version)](https://github.com/olekpuchka/ai-setup-sync/releases)
  [![Stars](https://img.shields.io/github/stars/olekpuchka/ai-setup-sync)](https://github.com/olekpuchka/ai-setup-sync/stargazers)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
</div>

Every AI coding tool needs its own config files in every repo. AI Setup Sync maintains yours once
in a GitHub repository and distributes it automatically across every project — Claude Code, GitHub
Copilot, Cursor, Google Antigravity, Gemini CLI, OpenAI Codex, and more. No copy-pasting.

> 📖 For installation, settings, path mappings, conflict handling, and the FAQ, see **[extension/README.md](extension/README.md)**.

## What it does

- **Syncs automatically** — pulls from your GitHub repo on project open and window focus.
- **Protects your Intellectual Property** — your AI setup lives in your own private repository, syncs automatically into each project, and is excluded from git. Your instructions never touch a client's codebase.
- **Supports every tool** — any file-based AI config works out of the box (Claude Code, Copilot, Cursor, and more). Custom path mappings cover anything else.
- **Protects local edits** — detects files you've changed and prompts before overwriting, with a built-in diff.
- **Stays out of git** — synced files are added to `.git/info/exclude`, never cluttering your changes.

## How it works

Sync triggers automatically on startup, window focus, and settings changes. Push to your config repo and every project picks up the change on the next sync — here's how the pieces connect:

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

    D[("GITHUB API
    · Repo tree (ETag cached)
    · Raw file content
    · PAT auth (keychain)
    · 304 Not Modified")]:::github -->|provides files| C

    C{{"SYNC ENGINE
    · Parallel downloads & deletions
    · Conflict detection
    · ETag deduplication
    · Path mapping rules"}}:::sync -->|writes| E

    C -->|saves state| F

    E["LOCAL FILES
    · .claude, .github and more
    · Hidden from git tracking"]:::local

    F[("STATE / REGISTRY
    · ETags per file
    · File paths + repo URL")]:::state

    linkStyle 0 stroke:#8B5CF6,stroke-width:2px
    linkStyle 1 stroke:#58A6FF,stroke-width:2px
    linkStyle 2 stroke:#3FB950,stroke-width:2px
    linkStyle 3 stroke:#F97316,stroke-width:2px
    linkStyle 4 stroke:#F97316,stroke-width:2px
```

## Install

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=olekpuchka.ai-setup-sync)
   (or search **AI Setup Sync** in the Extensions view).
2. Set `aiSetupSync.repository` to your GitHub repository URL in VS Code **user** settings.
3. Open a project — sync runs automatically.

For private repos, SSO-protected orgs, or GitHub Enterprise Server, add a token — see the
[full setup guide](extension/README.md#setting-up-your-repository).

## Contributing

Pull requests are welcome for features, bug fixes, and documentation. See
[CONTRIBUTING.md](CONTRIBUTING.md) for local setup, project architecture, and PR guidelines.

## License

Released under the [MIT License](LICENSE) — free to use, modify, and distribute.
