# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

Node.js 22.5 or newer is required (`node:sqlite`), plus Git on `PATH`.

Build before testing: the end-to-end and MCP stdio tests spawn the compiled CLI
from `dist/`.

## Checks

```bash
npm run typecheck   # tsc --noEmit, strict + exactOptionalPropertyTypes
npm run build
npm test            # vitest run
```

CI runs all three on Windows and Ubuntu. Cross-platform behavior is not
optional: path handling, file hashing, and process spawning have all broken on
exactly one of the two before.

Two benchmarks double as regression checks:

```bash
repomind eval --dataset benchmarks/datasets/basic-retrieval.json --json
repomind eval --scenarios --json
```

## Architecture rules

These are load-bearing; a change that breaks one needs an ADR, not a patch.

- The core (`src/core.ts`, `src/domain`, `src/storage`, `src/git`,
  `src/security`, `src/eval`) must not import the MCP SDK. The MCP layer only
  parses parameters, calls the core, maps errors, and truncates output.
- CLI and MCP must call the same core methods so their semantics cannot drift.
- Schema changes go through a numbered migration in `src/storage/migrations.ts`.
  Never edit an existing migration; add the next one. If a migration rebuilds a
  table, add a test that pins data preservation.
- Every write that spans tables runs inside one `db.transaction`.
- Anything reaching long-term storage goes through `redactSecrets`. If you add
  a persisted free-text column, redact it and add a test.
- Only predefined read-only Git commands, never user-composed arguments.

See [`docs/adr/`](docs/adr/) for the reasoning behind each rule.

## Tests

New behavior needs a test that fails without the change. Bug fixes need a
regression test that pins the specific scenario, not just the general area.

Tests create throwaway Git repositories and set `REPOMIND_DATA_DIR` to a
temporary directory, so they never touch real memories. Close every core you
open — an open SQLite handle makes cleanup fail on Windows and masks the real
error.

Do not add tests that require a paid model. The extraction pipeline is
deterministic today; when an LLM lands, it must be testable through a mock
runner.

## Commits

One purpose per commit, and every commit should build and test cleanly. Write
the message so it explains why the change was needed, not just what changed.
