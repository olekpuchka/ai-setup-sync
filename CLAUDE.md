# AI Setup Sync — Claude Code Instructions

## Releasing

Release is tag-triggered via GitHub Actions (`.github/workflows/release.yml`). Never run `vsce publish` or `ovsx publish` manually as part of a normal release.

```
git push
git tag v1.x.x
git push origin v1.x.x
```

The workflow fires on `v*` tags and builds the extension, publishes to the VS Code Marketplace, creates a GitHub Release with notes extracted from `CHANGELOG.md`, and publishes to Open VSX.

Open VSX is the registry Cursor and other VS Code forks install from; the listing is `olekpuchka.ai-setup-sync`. It publishes last so a problem at the newer registry can't cost the GitHub Release after the Marketplace has burned the version. Its one-time setup (signed Eclipse Publisher Agreement, `olekpuchka` namespace, `OVSX_TOKEN` repo secret) is already done.

If a run fails partway, use **Re-run failed jobs** — steps that already succeeded tolerate duplicates on a re-run, so the run resumes where it stopped. Duplicates are *not* tolerated on the first attempt, so a moved or re-pushed tag still fails loudly. To backfill one registry for a version the other already has, publish by hand from the VSIX attached to that version's GitHub Release; that's the one case where a manual publish is correct.
