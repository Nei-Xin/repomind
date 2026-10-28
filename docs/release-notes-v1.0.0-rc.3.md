# RepoMind v1.0.0-rc.3 release notes

Status: prepared on 2026-10-29; pending PR/main/tag CI and GitHub prerelease
publication. This is a release candidate for a local, single-user installation.

## What changes from RC.2

- Native Claude Code, OpenCode, Pi, Codex CLI and Gemini CLI integrations recall
  repository knowledge before a task and record observed activity automatically.
  Configure each repository once with `repomind <agent> setup`; then use the
  original client. Pi/Codex/Gemini are native integrations, not new
  `repomind run --runner` targets. Models and API keys stay in the agent's config.
- Schema 12 stores agent sessions and activity. Task identity checks prevent
  late events from attaching to a superseding task. Recall audit records show
  the exact redacted context generated, not proof that a model consumed it.
- Read-only interactive answers remain evidence rather than becoming solution
  memories. Successful verification refreshes existing command memories instead
  of duplicating them; incomplete checks cannot claim verified success.
- The local Bridge requires a bearer token and rejects browser-origin requests.
  Sensitive structured credentials and sensitive-file output are filtered.
  Filtering does not retroactively remove previously stored data.
- Hooks recover a refused connection to the default local Bridge. Concurrent
  startup, database access during restore, memory/vector consistency and global
  executable symlink handling are hardened. Gemini clears completed-turn replay
  receipts while retaining session markers needed to reject stale events.

## Install and upgrade

Requirements: Node.js **22.5+**, Git and the chosen agent. Use this project's
GitHub release artifact; the unscoped npm Registry package `repomind` is owned
by another publisher. The commands below apply **after RC.3 assets exist**:

```sh
# Download the RC.3 tarball and SHA256SUMS from Nei-Xin/repomind GitHub Releases.
sha256sum -c SHA256SUMS
# On macOS, use: shasum -a 256 -c SHA256SUMS
npm install -g ./repomind-1.0.0-rc.3.tgz
repomind --version
```

Before upgrading, stop active agent/MCP sessions and use the old RepoMind version
to back up each repository to a new path outside the repository. Stop its managed
services before replacing the installation:

```sh
repomind backup --repo /path/to/repository --output /path/to/backups/pre-rc3.db
repomind services stop
```

RC.3 applies Migration 12 on opening a Schema 11 repository. Archive format
versions remain unchanged; do not open an upgraded database with RC.2. Keep the
pre-upgrade backup and use the documented restore flow for recovery; automatic
downgrade is not supported. See [data portability](data-portability.md).

After installing, re-run setup for each agent/repository and review the generated
hooks or extension in that client. Keep `REPOMIND_DATA_DIR` consistent between
setup and the client:

```sh
repomind pi setup --repo /path/to/repository
repomind codex setup --repo /path/to/repository
repomind gemini setup --repo /path/to/repository
repomind doctor gemini --repo /path/to/repository
```

Use `claude setup` or `opencode setup` for those clients. Claude setup now uses
hooks only by default and removes only the RepoMind-managed local proxy endpoint.
If an older MemoryProxy supplied a custom upstream, configure that upstream in
Claude explicitly. `--proxy-url` retains proxy routing as an opt-in.

## Validated scope and limits

- First validated native versions: Pi 1.4.0, Codex CLI 0.165.0 and Gemini CLI
  0.66.0. Client trust is required. `doctor` checks setup and service health,
  not whether hooks are trusted or the model consumed recalled text.
- Codex Bash hooks omit exit status. Gemini omits successful shell exit codes.
  Output claiming tests passed cannot substitute for structured verification;
  unresolved verification keeps a task partial.
- Gemini has no stable hook turn/tool IDs or dedicated cancellation hook.
  Ambiguous events are handled conservatively; unfinished tasks are cleaned up
  at the next prompt/resume or best-effort SessionEnd. Per-session state files
  remain on disk to prevent stale-event replay.
- Native runtime acceptance was on Linux. Codex desktop/cloud and native Windows
  agent behavior are not covered by that acceptance. Cross-platform repository
  CI must pass separately before release.
- The Debian server passed build/typecheck and 901 tests (two platform tests
  skipped), plus global package installation and real Gemini multi-turn,
  cancellation, resume and Bridge recovery. Real model calls used a GPT relay;
  Gemini used a temporary external protocol converter, not a RepoMind feature.

See [release readiness](release-readiness-v1.0.md),
[Pi](pi-integration.md), [Codex](codex-integration.md),
[Gemini](gemini-integration.md) and [Changelog](../CHANGELOG.md).
