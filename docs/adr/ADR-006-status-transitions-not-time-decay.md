# ADR-006: Memories change status on signals, not time decay

Status: accepted

## Context

Repository knowledge does not expire on a clock. A convention set two years ago may still hold; a file location from yesterday may already be wrong. Time-based forgetting deletes good knowledge and keeps bad knowledge.

## Decision

Memories move through `active → uncertain → superseded / invalid` driven by concrete signals: related-file hash changes, deletions, contradicting new memories, corrections, and explicit invalidation. `uncertain` means "needs review", never "wrong"; every transition is audited and carries a machine-readable reason.

## Consequences

- Search may return `uncertain` memories, but always with a specific warning.
- Validation restores `active` and re-baselines the file hashes.
- No background job is needed; staleness is evaluated lazily on search/inspect.
