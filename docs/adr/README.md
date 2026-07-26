# Architecture Decision Records

Each record captures one load-bearing decision, its context, and its consequences. Statuses: `accepted`, `superseded`, `proposed`.

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-001](ADR-001-independent-core.md) | RepoMind is an independent core, not bound to one agent | accepted |
| [ADR-002](ADR-002-mcp-first-protocol.md) | MCP is the first public protocol, not a host tool hook | accepted |
| [ADR-003](ADR-003-sqlite-source-of-truth.md) | SQLite is the local source of truth | accepted |
| [ADR-004](ADR-004-fts5-before-vectors.md) | FTS5 first; vector retrieval deferred | accepted |
| [ADR-005](ADR-005-memory-evidence-separation.md) | Memory and Evidence are stored separately | accepted |
| [ADR-006](ADR-006-status-transitions-not-time-decay.md) | Memories change status on signals, not time decay | accepted |
| [ADR-007](ADR-007-marker-in-repo-data-in-home.md) | Project UUID lives in the repo; data lives in the user directory | accepted |
| [ADR-008](ADR-008-core-independent-of-mcp-sdk.md) | The core does not depend on the MCP SDK | accepted |
| [ADR-009](ADR-009-validated-output-before-persistence.md) | Model output must pass structured validation before persistence | accepted |
| [ADR-010](ADR-010-read-only-git-commands.md) | Only predefined read-only Git commands are executed | accepted |
