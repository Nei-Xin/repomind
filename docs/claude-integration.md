# Claude Code Integration

RepoMind can use Claude Code as a Host-managed coding Agent. Install and
authenticate Claude Code first, then verify the executable:

```powershell
claude --version
claude auth status --text
```

Run a daily repository task with RepoMind owning retrieval, evidence commit,
and derived-layer maintenance:

```powershell
repomind run `
  --runner claude `
  --repo D:\path\to\repository `
  --task "Fix invoice quantity arithmetic and run the relevant tests" `
  --model gpt-5.6-luna `
  --timeout 600000 `
  --max-memories 5 `
  --context-budget 12000
```

Use `--runner-executable <path>` when `claude` is not on `PATH`. Omit `--model`
to use Claude Code's configured default. RepoMind always supplies `--name` to
avoid Claude Code's otherwise separate title-generation model request. It also
uses non-persistent `stream-json` output so command evidence, token totals, and
the final result can be audited.

## Permission boundary

A normal `repomind run --runner claude` uses Claude's `dontAsk` mode with this
explicit allowlist:

```text
Read, Glob, Grep, Edit, Write, Bash, PowerShell
```

This permits the ordinary repository workflow without silently granting every
available tool. RepoMind does not expose a daily CLI switch for
`bypassPermissions`. The Claude Adapter accepts that mode only when its caller
asserts that the repository is a trusted, Host-owned isolated checkout.
RepoMind makes that assertion for cross-session benchmark stages because the
runner creates a fresh disposable checkout for each stage. Selecting
`--runner claude` for an arbitrary working repository is not sufficient.

## Outcome and telemetry

Claude's stdout is retained as redacted JSONL. RepoMind requires a terminal
`result` with `is_error=false` and `terminal_reason=completed`; process exit
zero alone is not enough. API failures may still report `subtype=success`, so
that field is not used as the success gate.

Bash and PowerShell evidence is trusted only when one uniquely identified
`tool_use` has exactly one matching `tool_result`. Missing, duplicated, or
contradictory results make the Host outcome inconclusive. Token telemetry comes
only from the terminal cumulative `usage` object, avoiding double counting
assistant and streaming events. Read calls, repeated paths, and
`mcp__repomind__*` calls are recorded separately; an Agent-side RepoMind call
is a Host protocol violation.

For cross-Agent learning experiments, set `runner` and `model` on individual
manifest stages. See
[`cross-session-agent-benchmark.md`](cross-session-agent-benchmark.md).
