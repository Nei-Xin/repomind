# ADR-003: SQLite is the local source of truth

Status: accepted

## Context

The single-user version stores all memories, evidence, sessions, and audit history locally. It needs transactions, migrations, FTS, and future vector indexes without a server process.

## Decision

One SQLite database per project (via `node:sqlite`), with WAL, foreign keys ON, versioned migrations, and a single connection per process. FTS5 and any future vector index are derived data that can be rebuilt from the base tables.

## Consequences

- Every write path that spans tables runs inside one transaction.
- Node.js 22.5+ is required for `node:sqlite`.
- Derived indexes (FTS, vectors) must never be the only copy of any fact.
