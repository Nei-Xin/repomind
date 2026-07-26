# ADR-010: Only predefined read-only Git commands are executed

Status: accepted

## Context

RepoMind shells out to Git for evidence. Accepting arbitrary arguments would turn a memory tool into a command-execution surface, and any mutating Git command could destroy user work.

## Decision

The Git inspector executes a fixed set of read-only commands (`rev-parse`, `branch --show-current`, `status`, `diff` variants, `mktree` for the empty-tree hash) with timeouts and output caps. No user or model input is ever spliced into Git arguments beyond validated paths. Sensitive paths are excluded from diff capture at the pathspec level.

## Consequences

- RepoMind can never commit, push, checkout, reset, or clean a repository.
- Large diffs are truncated with an explicit marker rather than streamed unbounded.
- Diff capture excludes `.env*`, key material, and `.npmrc`, and records which files were excluded.
