# Gemini CLI native integration

RepoMind can attach to Gemini CLI through its native project Hooks. Run setup once in a Git repository:

```sh
repomind init
repomind gemini setup --repo .
repomind gemini status --repo .
```

Then run `gemini` normally. `BeforeAgent` injects relevant repository memories. `BeforeTool` and `AfterTool` record activity, while `AfterAgent` commits the task after a terminal model response. Gemini's `BeforeModel` and `AfterModel` Hooks maintain the terminal outcome across streamed model chunks.

Trust the workspace when Gemini asks, and review the RepoMind definitions in `/hooks`. Gemini disables project settings, including project Hooks, until the workspace is trusted. Keep `hooksConfig.enabled` true and do not add RepoMind hook names to `hooksConfig.disabled`. Setup preserves existing settings and user Hooks.

The first validated version is Gemini CLI **0.66.0**. `repomind doctor gemini` checks the repository, installation, version and Bridge health. The model provider and credentials remain Gemini's configuration. RepoMind does not change them.

Gemini 0.66 does not expose a stable turn ID or a successful shell exit code. RepoMind uses a private SQLite state file containing only hashes, timestamps and correlation IDs to reject stale or ambiguous events. Shell output that says `Exit Code: 0` is not treated as verification. Such tasks remain partial unless another source supplies structured evidence. Cancellation has no dedicated Hook; an unfinished task is abandoned on the next prompt, resume, or best-effort session end.

The Gemini model protocol must be Gemini-compatible. If a relay only accepts OpenAI requests, use a temporary external protocol adapter in a test environment; RepoMind itself does not proxy or rewrite model traffic.

Global npm installations and executable symlinks are supported. Re-run `repomind gemini setup` after moving or upgrading the installation so Hooks use the current package paths. A Bridge started by automatic recovery remains manageable through the global `repomind services` command.

Hook replay receipts are cleared when a turn completes, is abandoned, or is superseded. Each native session keeps a small SQLite file with the last turn timestamp and any unresolved tool correlations. These markers deliberately survive cleanup so a delayed event cannot reopen an old task or attach a result to a new one. SQLite reuses freed pages; this is per-turn receipt pruning, not automatic deletion of old session files.
