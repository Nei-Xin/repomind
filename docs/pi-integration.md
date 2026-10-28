# Pi native integration

RepoMind supports Pi coding agent through a project-local extension. The first
validated version is Pi **1.4.0** (`@earendil-works/pi-coding-agent`), with
Node.js 22.5+ available to RepoMind.

```bash
repomind pi setup --repo /path/to/repository
repomind doctor pi --repo /path/to/repository
cd /path/to/repository
pi
```

Setup initializes repository memory, writes `.pi/extensions/repomind.ts`, and
starts the local Bridge. Trust the project extension in Pi. Restart an existing
Pi session or use `/reload` after setup. Re-run setup after moving RepoMind.
Setup preserves other extensions and refuses to replace an unmanaged file at
the same path. `repomind pi status` checks the installation, version and Bridge;
it cannot verify Pi's project trust decision or model consumption.

Keep Pi's provider, model and API key configured in Pi as usual. RepoMind
neither changes model routing nor requires a model API key of its own. Use the
same `REPOMIND_DATA_DIR` for setup and Pi when overriding the default directory.
The Bridge token is read from that directory. Do not enable a second,
model-managed RepoMind MCP lifecycle alongside the automatic extension.

## Lifecycle

- `before_agent_start` starts a task and injects recalled L1–L3 context as a
  hidden custom message. Custom extension-triggered runs do not start tasks.
- Tool calls and results are recorded, including explicit shell exit codes
  from `structuredContent`. An absent exit code is unknown, never inferred
  from output saying a test passed. Image bodies are not recorded.
- Final assistant text is observed through `message_end`. `agent_settled`
  commits the task only after automatic retries, compaction and continuations
  settle. `agent_end` alone does not finish a task.
- Escape cancellation abandons the task. Final model errors are failed and
  truncated responses are partial. Session shutdown, reload, switch, fork or
  tree navigation abandons any remaining active task.

The existing memory quality and redaction rules apply. A successful read-only
answer remains evidence; reusable solutions require a repository outcome.
Verified commands can be recalled by Claude, OpenCode and Codex against the
same repository and data directory.

Bridge connection refusal at the default endpoint triggers automatic recovery.
Other failures produce a warning and let Pi continue. There is no offline
queue; SIGKILL cannot guarantee task finalization. Event writes are serialized,
and task identity checks prevent late events from altering a newer task.

Validated scope: local Pi CLI, including native interactive use. The extension
does not add Pi to `repomind run --runner` or guarantee independent third-party
subagent extensions use the same lifecycle.

Official interface: [Pi extensions](https://pi.dev/docs/latest/extensions).
