# RepoMind v0.11 memory maintenance acceptance

Date: 2026-07-28

## Scope

This acceptance closes the review-first maintenance loop without allowing
RepoMind to make governance decisions automatically.

The accepted workflow is:

1. Refresh and list uncertain memories through CLI or MCP.
2. Inspect Evidence and audit history.
3. Submit explicit validate or invalidate decisions individually or as a batch.
4. Apply the complete batch atomically.
5. Verify the queue is closed and inspect the maintenance history.

The release also exposes `repo_session_abandon`, completing the MCP session
lifecycle already available through the CLI and Host-managed runner.

## Acceptance results

| Gate | Result |
| --- | --- |
| TypeScript strict typecheck | Passed |
| Production build | Passed |
| Vitest | 26 files, 126 tests passed |
| MCP in-memory tool contract | Passed, 12 tools |
| MCP stdio protocol purity | Passed |
| Cross-process CLI review batch | Passed |
| Atomic batch rollback | Passed |
| Eight-task Agent fixture validation | 8/8 passed |

## Integrity properties

- Every batch target must still be `uncertain` before any decision is written.
- Duplicate targets, missing memories, empty reasons, and invalid actions reject
  the whole request.
- Nested governance operations use SQLite savepoints under one outer
  transaction, preventing partial batches.
- Validation and invalidation continue to create Evidence and append to the
  existing memory audit log.
- Maintenance history is a read model over the audit log, not a second source
  of truth.
- Correction remains explicit and single-memory because replacement content
  requires separate human review.

## Remaining final-product work

This release does not claim L2/L3 memory, a second real Coding Agent
acceptance, export/import/backup/restore, macOS CI, or Skill Candidate support.
Those remain tracked against the final v1.0 completion standard.
