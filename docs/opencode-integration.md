# OpenCode Integration

## Transparent interactive lifecycle

Build and link RepoMind from a source checkout, or install a release package:

```powershell
npm.cmd run build
npm.cmd link
```

Set up a target repository once:

```powershell
repomind opencode setup --repo D:\path\to\repository
repomind opencode status --repo D:\path\to\repository
```

`setup` initializes RepoMind, installs the managed project plugin at
`.opencode/plugins/repomind.js`, and starts only the loopback RepoMind Bridge at
`127.0.0.1:7345`. MemoryProxy is not involved. After setup, use the normal
interactive CLI from the target repository:

```powershell
opencode
```

For every root-session user message, the plugin starts a RepoMind task, retrieves
relevant current L1-L3 context, and injects it as an untrusted synthetic text
part before model dispatch. Root-session and delegated child-session tool calls,
results, and failures are recorded automatically against the root task while
preserving the originating Session ID. Root `session.idle` captures the last assistant response,
commits Git, command, and test evidence, then performs the existing best-effort
L2/L3/L4 maintenance. Bridge failures are logged and do not prevent OpenCode
from continuing.

Child-session user messages do not create separate RepoMind tasks, and child
`session.idle` or deletion events do not finish or abort the root task. Nested
child sessions resolve through their parent chain, so commands and tests run by
delegated Agents remain part of the root task evidence.

The generated project plugin imports the installed RepoMind implementation by
absolute file URL. Re-run `repomind opencode setup` after moving or updating the
RepoMind installation. `repomind opencode status` checks the repository marker,
plugin target, Bridge health, and OpenCode executable.

Do not combine this transparent lifecycle with Agent-managed RepoMind MCP calls.
The plugin disables an existing `mcp.repomind` entry in OpenCode's effective
in-process configuration, and `status` warns until the redundant project entry
is removed or disabled explicitly:

```json
{
  "mcp": {
    "repomind": {
      "enabled": false
    }
  }
}
```

## MCP-managed lifecycle

RepoMind can also run as a project-local stdio MCP server in OpenCode. Build RepoMind first:

```powershell
npm.cmd run build
```

The repository-level `opencode.json` registers RepoMind with a relative command:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "repomind": {
      "type": "local",
      "command": ["node", "./dist/cli/index.js", "mcp"],
      "enabled": true
    }
  }
}
```

Verify the resolved configuration and MCP connection:

```powershell
opencode.cmd debug config
opencode.cmd mcp list
```

OpenCode should report `repomind` as connected. Start OpenCode from the repository root so the relative `dist/cli/index.js` path resolves correctly.

For consistent tool usage, apply the workflow in `examples/opencode/AGENTS.md` to the target repository's agent instructions.

In MCP-managed mode, RepoMind cannot observe OpenCode's other tools automatically.
The Agent must explicitly start and commit a RepoMind session. Use this mode
only when the transparent project plugin is not installed.

## Host-managed lifecycle

### Daily command

Use `repomind run` when RepoMind should own the lifecycle while OpenCode owns
the repository task:

```powershell
repomind run `
  --repo D:\path\to\repository `
  --task "Fix invoice quantity arithmetic" `
  --model cliproxyapi/gpt-5.6-terra `
  --timeout 600000 `
  --max-memories 5 `
  --context-budget 12000
```

The repository must already be initialized with `repomind init`. `--runner`
defaults to `opencode`; specify it explicitly when a script must remain pinned
to OpenCode. Omit `--model` to inherit OpenCode's configured default model. Use `--output <dir>`
to select an empty artifact directory. Otherwise the command creates a unique
directory under `~/.repomind/runs/`, or under `REPOMIND_DATA_DIR` when set.

`--context-budget` defaults to 12,000 characters. This is a repository-context
budget, not a cap on the complete OpenCode prompt: it bounds only the injected
current L3 profile, relevant current L2 narratives, and ranked L1 memories.
The Host lifecycle instructions and the user's complete current task remain
outside that budget and are not truncated. Lower-ranked records may be clipped
or omitted when the three eligible layers exceed the budget. The accepted
range is 1,000-24,000 characters. On Windows, the Host also rejects a complete
rendered prompt above 28,000 characters before spawn because the prompt is
currently passed through argv. The Host also models libuv's Windows argument
quoting and rejects a complete quoted command line above the 32,767-character
platform boundary.

The command performs these phases sequentially:

1. Start a RepoMind session and retrieve ranked L1, relevant current L2, and
   the current L3 profile when available.
2. Register a persistent Host-run record linked to that session.
3. Render the eligible repository layers under `--context-budget`, then append
   the full lifecycle instructions and current task. Every untrusted L1-L3
   record line is prefixed as a Markdown blockquote, so a forged heading stays
   inside quoted data rather than becoming Host structure.
4. Run OpenCode with JSON events, `--pure`, and a temporary host Agent.
5. Extract the final response plus observed shell command and test evidence.
6. Commit a successful, partial, or failed session after a normal process exit.
7. Only after a successful commit, synchronously rebuild L2, attempt L3, and
   refresh L4 candidates.
8. Close the Host-run record and return the final Host report.

The three derived-maintenance stages are best effort and independently
reported. An L3 attempt with no eligible source is skipped rather than failed.
A maintenance failure does not roll back an already committed Session and does
not change an otherwise successful Host-run outcome. Partial, failed, and
abandoned runs skip all three stages. L4 maintenance only generates or refreshes
review-required candidates; it never approves, exports, installs, or executes
them.

A normal Agent process exit is not sufficient for success. Every observed
`bash` or `shell` command must have exit code zero; any observed nonzero command
commits the Session as `partial`, marks the Host report unsuccessful, and skips
derived maintenance. The Host still does not require that at least one test was
observed unless an external acceptance harness supplies that policy.

OpenCode configuration is overlaid through `OPENCODE_CONFIG_CONTENT`; the
repository's `opencode.json` is not rewritten. The overlay disables the
conventional `mcp.repomind` entry and the host prompt forbids RepoMind calls.
An observed Agent-side RepoMind call is treated as a lifecycle violation and
the run cannot be successful. Other OpenCode MCP configuration remains
available, while external plugins are disabled by `--pure` for reproducibility.
The dedicated Host Agent also sets OpenCode's `external_directory` permission
to `deny`, so repository tasks cannot inspect sibling experiment artifacts or
data directories through OpenCode tools. This is a Host policy boundary, not a
replacement for an operating-system or container sandbox against a hostile
process.

In normal terminal mode, Agent text is shown as JSON events arrive and lifecycle
status is written to stderr. `--json` reserves stdout for one final report and
suppresses streamed Agent output:

```powershell
$result = repomind run `
  --repo D:\path\to\repository `
  --task "Fix invoice quantity arithmetic" `
  --json | ConvertFrom-Json

$result.session.status
$result.agent.exitCode
$result.artifacts.report
```

The artifact directory contains:

- `events.jsonl`: redacted OpenCode events used for evidence extraction.
- `stderr.log`: redacted OpenCode stderr.
- `run.json`: schema version 3 redacted lifecycle, context-injection, Agent
  metric, commit, and post-commit maintenance report. It records the L2/L3
  versions retrieved before execution so post-commit refreshes do not make the
  injected version ambiguous.

Secret redaction is deterministic and pattern-based; it is not a substitute for
keeping credentials out of task prompts and repositories. Artifacts are local
but can still contain non-secret source code and command output.

A normal Agent exit is committed as failed when its exit code is nonzero,
preserving failure evidence; the command returns that exit code. With Agent exit
zero, any observed nonzero shell command or truncated stdout produces a partial
Session instead of successful memories. A timeout, signal, spawn failure, or
invalid process completion abandons the Session and exits nonzero. `SIGINT` and
`SIGTERM` map to exit codes 130 and 143. Every handled path ends committed,
partial, failed, or abandoned rather than remaining open.

Query the persistent run catalog without scanning artifact directories:

```powershell
repomind runs --repo D:\path\to\repository --status committed --limit 20 --json
repomind run-inspect ses_... --repo D:\path\to\repository --json
```

The catalog also records output setup failures and interrupted runs. Custom
`--output` directories remain discoverable through their stored report path.
The final report and persistent Host-run metadata summarize context injection
and derived-maintenance outcomes for later diagnosis without redefining the
Session or run status.

### Library integration

Hosts that need deterministic lifecycle behavior can keep RepoMind outside the
model loop. The package exports these OpenCode integration helpers:

- `startHostLifecycle(repository, task, dataDirectory?)` starts retrieval and
  returns the layered Session Start result and measured start time.
- The Host context renderer builds a bounded current L3/L2/L1 context and
  returns aggregate injection information without truncating the task or fixed
  lifecycle instructions.
- `analyzeOpenCodeOutcome(jsonl, fallback)` extracts the final response and
  command/test evidence from OpenCode JSON events.
- `commitHostLifecycle(input)` stores the final Git diff, response, and test or
  command evidence; successful Host commits also perform best-effort derived
  maintenance without changing commit success when maintenance fails.
- `abandonHostLifecycle(repository, sessionId, dataDirectory?)` closes an open
  host session when Agent execution cannot be committed safely.
- `runOpenCodeHost(options)` implements the complete bounded-context daily
  lifecycle and accepts an injectable process executor and `AbortSignal` for
  host integration.

This automatic maintenance belongs to the Host-managed helpers and
`repomind run`. Calling `commitSession` directly, using `repomind commit`, or
committing through `repo_session_commit` does not trigger it; those callers can
invoke the existing CLI or MCP rebuild operations explicitly.

The controlled evaluation runner exercises this real integration with:

```powershell
node .\dist\cli\index.js eval --agent `
  --manifest D:\path\to\manifest.json `
  --lifecycle host-managed `
  --model cliproxyapi/gpt-5.6-terra `
  --output D:\path\to\results
```

In this mode OpenCode receives no RepoMind MCP server. The host owns session
closure, and the report counts start, Agent, and commit time in the end-to-end
total.
