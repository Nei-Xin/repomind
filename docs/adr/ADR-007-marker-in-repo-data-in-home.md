# ADR-007: Project UUID lives in the repo; data lives in the user directory

Status: accepted

## Context

Memories must follow a project across clones and working directories, but the memory database contains execution traces and possibly sensitive fragments that must never be committed.

## Decision

`repomind init` writes only `.repomind/project.json` (a stable UUID and name) into the repository; it is safe to commit. All data lives in `~/.repomind/repositories/<projectId>/repomind.db` (overridable via `REPOMIND_DATA_DIR`). Forks can take a new identity with `init --new-id`.

## Consequences

- Two checkouts of the same project share one memory database on the same machine.
- The database never appears in `git status`; nothing sensitive can be committed by accident.
- Checkout paths are tracked in `repository_checkouts` so path moves are recognized.
