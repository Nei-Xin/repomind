# OpenCode Integration

RepoMind can run as a project-local stdio MCP server in OpenCode. Build RepoMind first:

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

RepoMind cannot observe OpenCode's other tools automatically. The agent must explicitly start and commit a RepoMind session.

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
  --max-memories 5
```

The repository must already be initialized with `repomind init`. `--runner`
defaults to `opencode`; other runners are rejected in this release. Omit
`--model` to inherit OpenCode's configured default model. Use `--output <dir>`
to select an empty artifact directory. Otherwise the command creates a unique
directory under `~/.repomind/runs/`, or under `REPOMIND_DATA_DIR` when set.

The command performs these phases sequentially:

1. Start a RepoMind session and retrieve up to `--max-memories` memories.
2. Render the evidence-backed memories into the OpenCode task prompt.
3. Run OpenCode with JSON events, `--pure`, and a temporary host Agent.
4. Extract the final response plus observed shell command and test evidence.
5. Commit a successful, partial, or failed session after a normal process exit.

OpenCode configuration is overlaid through `OPENCODE_CONFIG_CONTENT`; the
repository's `opencode.json` is not rewritten. The overlay disables the
conventional `mcp.repomind` entry and the host prompt forbids RepoMind calls.
An observed Agent-side RepoMind call is treated as a lifecycle violation and
the run cannot be successful. Other OpenCode MCP configuration remains
available, while external plugins are disabled by `--pure` for reproducibility.

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
- `run.json`: redacted lifecycle, retrieval, Agent metric, and commit report.

Secret redaction is deterministic and pattern-based; it is not a substitute for
keeping credentials out of task prompts and repositories. Artifacts are local
but can still contain non-secret source code and command output.

A normal Agent exit is committed even when its exit code is nonzero, preserving
failure evidence; the command returns that exit code. A timeout, signal, spawn
failure, or invalid process completion abandons the session and exits nonzero.
A normally exited run whose captured stdout was truncated commits as partial
instead of producing a success memory. `SIGINT` and `SIGTERM` map to exit codes
130 and 143. In every handled
path the session ends as committed, partial, failed, or abandoned rather than
remaining open.

### Library integration

Hosts that need deterministic lifecycle behavior can keep RepoMind outside the
model loop. The package exports these OpenCode integration helpers:

- `startHostLifecycle(repository, task, dataDirectory?)` starts retrieval and
  returns the session, memories, and measured start time.
- `hostManagedPrompt(task, memories)` renders the retrieved context for the
  OpenCode task prompt.
- `analyzeOpenCodeOutcome(jsonl, fallback)` extracts the final response and
  command/test evidence from OpenCode JSON events.
- `commitHostLifecycle(input)` stores the final Git diff, response, and test or
  command evidence with a measured commit time.
- `abandonHostLifecycle(repository, sessionId, dataDirectory?)` closes an open
  host session when Agent execution cannot be committed safely.
- `runOpenCodeHost(options)` implements the complete daily lifecycle and accepts
  an injectable process executor and `AbortSignal` for host integration.

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
