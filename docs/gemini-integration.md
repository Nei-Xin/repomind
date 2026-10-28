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
