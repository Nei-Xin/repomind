# Transparent Claude Code integration

This integration keeps the native interactive Claude Code process while project
hooks and a local RepoMind Bridge perform recall, L0 capture, and task
finalization. Claude does not call RepoMind MCP lifecycle tools, `repomind run`
is not involved, and Claude's model traffic is not proxied.

```text
Claude Code --project hooks--> RepoMind Bridge --> RepositoryMemoryCore / SQLite
     |
     +--Anthropic API (unchanged: your own endpoint and credentials)
```

## Daily setup

From the RepoMind source checkout, one idempotent command initializes the target
repository, installs or repairs its Claude hooks, and starts the loopback Bridge:

```powershell
repomind claude setup --repo D:\path\to\repository
```

Then use native interactive Claude Code normally from the target repository:

```powershell
claude
```

Inspect the complete interactive chain without changing it:

```powershell
repomind doctor claude --repo D:\path\to\repository
```

## Upgrading from the MemoryProxy route

Earlier releases also routed Claude through MemoryProxy by writing
`ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/...` into the repository's
`.claude/settings.local.json`. Re-running `repomind claude setup` removes that
RepoMind-managed value and reports it under `status.warnings`; `doctor claude`
flags repositories that still carry it. Any other `ANTHROPIC_BASE_URL` is left
untouched.

After the route is removed Claude uses your user-level endpoint. If MemoryProxy
was forwarding to a custom upstream (`upstream.url` in its `config.yaml`), set
`ANTHROPIC_BASE_URL` to that upstream in your own Claude settings or shell.
MemoryProxy's turn write-through only added raw user/assistant text to L0; recall,
evidence, and memories always came from the hooks, so nothing is lost.

To keep routing through MemoryProxy deliberately, pass the route explicitly:
`repomind claude setup --proxy-url http://127.0.0.1:8096/claude-code/default`.
That mode starts both services and requires MemoryProxy's own configuration and
dependencies (see [`services/README.md`](../services/README.md)).

## Manual setup

Build and initialize the target repository, start the Bridge, then install the
project hooks:

```powershell
npm.cmd run build
node D:\path\to\repomind\dist\cli\entry.js init --repo D:\path\to\repository
node D:\path\to\repomind\dist\cli\entry.js bridge
node D:\path\to\repomind\dist\cli\entry.js claude-hook-install `
  --repo D:\path\to\repository `
  --bridge-url http://127.0.0.1:7345
```

The installer merges definitions into `.claude/settings.local.json`, preserves
existing permissions and hooks, and is idempotent. Hook commands embed absolute
paths to Node and the RepoMind CLI, so re-run setup after moving the checkout.

The Bridge listens only on `127.0.0.1:7345` and always requires a bearer token.
On first start it generates one and stores it in `REPOMIND_DATA_DIR/bridge.token`
(or `~/.repomind/bridge.token`) with owner-only permissions; the hooks read the
same file, so no configuration is needed on one machine. If you set
`REPOMIND_DATA_DIR`, set it in the shell that launches Claude as well, or set the
same `REPOMIND_BRIDGE_TOKEN` for the Bridge and Claude; the variable takes
precedence over the file. The Bridge also rejects browser requests (any `Origin`
header), non-JSON writes, and non-loopback `Host` headers.

## Lifecycle

| Claude hook | RepoMind behavior |
| --- | --- |
| `SessionStart` | Registers the Claude session with the repository |
| `UserPromptSubmit` | Starts a RepoMind Session, reads the Git baseline, injects L1/L2/L3 context |
| `PreToolUse` | Records an L0 tool call |
| `PostToolUse` | Records an L0 tool result |
| `PostToolUseFailure` | Records a failed tool result; the task is committed as `partial` |
| `Stop` | Records the final response, reads the final Git state, and commits |
| `SessionEnd` | Abandons a task that is still open; recorded L0 stays |

Each `UserPromptSubmit -> Stop` pair is one RepoMind task. Every activity has an
idempotent event ID and is redacted before it reaches SQLite.

Claude Code reports no exit status for shell commands; a non-zero exit fires
`PostToolUseFailure` instead of `PostToolUse`. RepoMind therefore records a
completed, foreground, uninterrupted `Bash`/`PowerShell` `PostToolUse` as an
observed exit code 0, which lets a passing test become a verified `command`
memory. Interrupted and background (`run_in_background`) commands stay unknown
and keep the task `partial`. A test whose status a later command can replace
(`npm test | tail`, `npm test; echo`, `npm test || true`) is kept as ordinary
command evidence rather than a verified test.

`Stop` commits Git/test Evidence and L1 memories, then deterministically rebuilds
L2 module narratives and the L3 repository profile. Only successfully committed
tasks trigger L2/L3; stages with no stable source are skipped, and maintenance
failures are returned without rolling back the committed task.

## Current limits

- Bridge session-to-repository routing is held in process memory; hooks
  re-register before every event.
- Logical exports do not include L0 `activity_events`; physical SQLite backups do.
- Async LLM extraction and idle finalization remain future work.
