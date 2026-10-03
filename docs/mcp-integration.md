# MCP Integration

RepoMind runs as a local stdio MCP server. Build it before configuring a client:

```powershell
npm.cmd run build
node C:\path\to\repomind\dist\cli\index.js mcp
```

The server exposes seven tools:

- `repo_session_start`
- `repo_memory_search`
- `repo_session_commit`
- `repo_memory_inspect`
- `repo_memory_validate`
- `repo_memory_correct`
- `repo_memory_invalidate`

## Codex

Codex reads durable MCP settings from the user-level `~/.codex/config.toml`. A trusted repository can also provide `.codex/config.toml`; project configuration is ignored until the repository is trusted.

Copy `examples/codex/config.toml` into the appropriate config file and replace the RepoMind build path with an absolute path. Restart Codex after changing MCP configuration. In Codex CLI, use `/mcp` to list the configured tools and inspect server details.

For durable task behavior, copy the relevant rules from `examples/codex/AGENTS.md` into the target repository's `AGENTS.md`. MCP registration makes tools available; the repository instructions tell the agent when to call them.

The configuration format follows the current Codex MCP configuration reference: <https://learn.chatgpt.com/docs/extend/mcp>.

## Verification

1. Start Agent A in an initialized repository.
2. Confirm the seven RepoMind tools are available.
3. Ask Agent A to start a RepoMind session, make a bounded change, test it, and commit the RepoMind session.
4. Close Agent A and start a new session or a second MCP client.
5. Search for the first session's decision or verified command.
6. Inspect the returned memory and confirm it links to Git and test Evidence.
7. Change a related file, search again, and confirm the memory becomes `uncertain`.
8. Validate, correct, or invalidate the memory and inspect its Evidence and Audit history.

RepoMind cannot observe the host agent's file, shell, or test tools automatically. The agent must explicitly call session start and commit. After the MCP process restarts, pass `repo_path` to commit, inspect, validate, correct, and invalidate calls.

## Optional structured handoff

`repo_session_commit` accepts an optional `handoff` alongside its existing fields:

```json
{
  "summary": "Review closed.\n\nOnly on Linux, preserve case-sensitive matching.\n\nImplement the parser later.",
  "handoff": {
    "version": 1,
    "constraints": ["Only on Linux, preserve case-sensitive matching."],
    "remainingWork": ["Implement the parser later."]
  }
}
```

Each entry must exactly match a unique, complete paragraph in `summary`, retaining
conditions and warnings. Each array allows 16 entries, each entry 2,000 Unicode
code points, and both arrays together 4,000. Entries follow source order and cannot
appear in both categories. Invalid input fails before persistence. The nested key
is `remainingWork`; the existing outer MCP key remains `remaining_work`. If both
are provided, their arrays must match exactly.

A complete first constraint on one line, within 160 UTF-16 code units, can title a
new solution. Otherwise the existing title extraction applies. The full prose is
retained under the existing secret-redaction policy. Deduplicated memories retain
their existing titles. The `agent_summary` Evidence's `metadata_json.handoffAudit`
records source spans, verification references, and whether a new title was applied.

Do not supply verification or Evidence IDs in `handoff`. Verification comes from
persisted command evidence; MCP test claims remain `caller-reported`. Omitting
`handoff` preserves existing behavior. Separately, OpenCode Host runs can request
the optional output protocol with `repomind run --runner opencode --task "..."
--structured-handoff`. This flag is off by default and is not required for MCP
commits. Invalid optional Host output falls back with audit diagnostics; invalid
explicit MCP input still rejects the commit.
