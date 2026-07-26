# ADR-004: FTS5 first; vector retrieval deferred

Status: accepted

## Context

Vector search adds an embedding provider dependency, cache management, and model-versioning concerns. Most repository queries (commands, file paths, identifiers, error strings) match well lexically.

## Decision

Ship FTS5 with identifier-aware tokenization (camelCase/snake_case/path splitting) and a substring fallback first. Add sqlite-vec hybrid retrieval only after the retrieval benchmark exists to measure whether it helps.

## Consequences

- Search works offline with zero configuration.
- `repomind eval` provides the baseline that any future hybrid ranking must beat.
- When embeddings land, their failure must degrade back to FTS5 without breaking session commits.
