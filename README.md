# RepoMind

RepoMind is a local, evidence-backed memory layer for coding agents. It captures repository task evidence, stores reusable L1 memories, and exposes them through a CLI and MCP server.

This repository currently implements the first MVP: repository identity, SQLite/FTS5 storage, Git snapshots, session start/commit, deterministic memory extraction, search, inspection, and four MCP tools.

## Requirements

- Node.js 22.5 or newer
- Git

## Install

```bash
npm install
npm run build
npm link
```

Initialize RepoMind inside a Git repository:

```bash
repomind init
repomind doctor
```

Only `.repomind/project.json` is written to the repository. Memory data is stored under `~/.repomind/repositories/<projectId>/repomind.db`. Set `REPOMIND_DATA_DIR` to override the user data directory.

## Five-minute flow

Start a task:

```bash
repomind start --task "Fix the Windows SQLite loader" --json
```

After making changes, commit the RepoMind session using the returned session ID:

```bash
repomind commit --session <session-id> --key demo-1 --summary "Validated the SQLite loader fix" --json
```

Search and inspect the resulting memory:

```bash
repomind search "SQLite loader" --json
repomind inspect <memory-id> --json
```

Record an explicit repository fact without an LLM:

```bash
repomind record --type convention --title "Public API types" --content "Public APIs export explicit TypeScript types."
```

## MCP configuration

```json
{
  "mcpServers": {
    "repomind": {
      "command": "repomind",
      "args": ["mcp"]
    }
  }
}
```

The MVP exposes:

- `repo_session_start`
- `repo_memory_search`
- `repo_session_commit`
- `repo_memory_inspect`

For commit and inspect calls, pass `repo_path` when a request is made after the MCP server has restarted.

## Scope

The MVP intentionally does not include vector retrieval, remote LLM extraction, L2/L3 narratives, automatic host-tool observation, or Skill Candidate generation. See `REPOMIND_PROJECT_PLAN.md` and `REPOMIND_FINAL_PRODUCT_SPEC.md` for the staged roadmap.

## Development

```bash
npm run typecheck
npm test
npm run build
```
