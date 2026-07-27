# RepoMind

RepoMind is a local, evidence-backed memory layer for coding agents. It captures repository task evidence, stores reusable L1 memories, and exposes them through a CLI and MCP server.

The current implementation includes repository identity, SQLite/FTS5/sqlite-vec storage, Git snapshots, session start/commit, deterministic memory extraction, hybrid search with deterministic fallback, inspection, file-hash stale-memory detection, deterministic conflict detection, secret redaction, and audited validation, correction, invalidation, and forget workflows.

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

When a related file changes or is deleted, later search and inspect calls mark the memory `uncertain` and return a concrete warning plus expected/current file hashes. RepoMind does not automatically delete or invalidate the memory because a file change means the conclusion needs review, not necessarily that it is wrong.

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

The MCP server exposes nine tools:

- `repo_session_start`
- `repo_memory_search`
- `repo_session_commit`
- `repo_memory_inspect`
- `repo_memory_record`
- `repo_memory_validate`
- `repo_memory_correct`
- `repo_memory_invalidate`
- `repo_memory_forget`

See [`docs/mcp-integration.md`](docs/mcp-integration.md), [`docs/opencode-integration.md`](docs/opencode-integration.md), and the client examples under [`examples/`](examples/) for setup and end-to-end verification flows.

See [`docs/stale-detection.md`](docs/stale-detection.md) for the `active` to `uncertain` behavior and a reproducible validation flow.

See [`docs/memory-governance.md`](docs/memory-governance.md) for the `validate`, `correct`, and `invalidate` state transitions.

For commit and inspect calls, pass `repo_path` when a request is made after the MCP server has restarted.

Secrets are redacted from everything that reaches long-term storage, and Git diff capture skips sensitive paths outright. See [`SECURITY.md`](SECURITY.md) for the threat model and the limits of pattern-based redaction.

## Vector search

Vector retrieval is optional. With no provider configured, search remains the
same repository-scoped FTS5 search as before. For an offline reproducible
provider suitable for development and tests:

```powershell
$env:REPOMIND_EMBEDDING_PROVIDER = "deterministic"
$env:REPOMIND_EMBEDDING_DIMENSIONS = "256"
repomind vector-reindex --json
```

For an OpenAI-compatible embeddings endpoint:

```text
REPOMIND_EMBEDDING_PROVIDER=openai-compatible
REPOMIND_EMBEDDING_BASE_URL=https://api.example.com/v1
REPOMIND_EMBEDDING_API_KEY=...
REPOMIND_EMBEDDING_MODEL=...
REPOMIND_EMBEDDING_DIMENSIONS=1536
```

`repomind status` and `repomind doctor` report sqlite-vec and provider state.
Embedding failures return FTS results and do not partially update the vector
cache. See [`docs/vector-search.md`](docs/vector-search.md) for lifecycle and
privacy details.

## Scope

The current release intentionally does not include remote LLM extraction, L2/L3 narratives, automatic host-tool observation, or Skill Candidate generation. See `REPOMIND_PROJECT_PLAN.md` and `REPOMIND_FINAL_PRODUCT_SPEC.md` for the staged roadmap.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Measure retrieval quality and cross-session guarantees (see [`docs/benchmark.md`](docs/benchmark.md)):

```bash
repomind eval --dataset benchmarks/datasets/basic-retrieval.json --json
repomind eval --scenarios --json
repomind eval --compare --markdown
```

The comparison benchmark scores the context bundle each memory strategy delivers under a fixed token budget, including no-memory, full-history, lexical, vector, and hybrid arms. It measures context quality, not agent task success — see [`docs/benchmark-comparison.md`](docs/benchmark-comparison.md) for what it deliberately does not prove.

[`docs/architecture.md`](docs/architecture.md) explains how the pieces fit and [`docs/memory-model.md`](docs/memory-model.md) explains what is stored and why; the reasoning behind each structural choice is recorded under [`docs/adr/`](docs/adr/). [`docs/troubleshooting.md`](docs/troubleshooting.md) covers error codes and common situations, and [`CONTRIBUTING.md`](CONTRIBUTING.md) lists the architecture rules a change must respect.
