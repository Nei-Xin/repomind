# RepoMind v0.17 release distribution and upgrade readiness

## Goal

This iteration proves the installable npm artifact and historical database
upgrade path. Source-checkout tests alone cannot show that package metadata,
the generated bin entry, shipped files, runtime dependencies, or recovery
commands work after installation.

## Packaged-install acceptance

Run the acceptance through npm so the runner can invoke the same npm CLI
without platform-dependent shell wrappers:

```powershell
npm run bench:package-smoke -- `
  --workspace D:\data\code\project\repomind-test\v0.17-package-<new-id>
```

The runner refuses an existing workspace. It performs these operations only in
the new workspace:

1. builds and packs RepoMind with `npm pack --json`;
2. installs the tarball into an isolated consumer project;
3. checks the package manifest, bin shim, checksum, and forbidden file list;
4. creates a temporary Git repository and isolated `REPOMIND_DATA_DIR`;
5. runs Init, Record, Search, Inspect, Backup, restore preview, and confirmed
   Restore through the installed package;
6. starts the installed MCP server and calls Start, Search, Inspect, and
   Abandon; and
7. writes `package-smoke-report.json` and `package-smoke-report.md`.

The package is rejected if it contains databases, `.repomind`, `.env`, local
Agent configuration, the top-level development test suite, or coverage output.
The intentional Benchmark fixtures remain packaged because installed `eval`
commands consume them. The runner does not publish to npm and does not use
remote LLM or Embedding credentials.

GitHub CI runs the same acceptance on Ubuntu, Windows, and macOS after the full
test suite.

## Published Schema fixtures

`tests/fixtures/released-schema-manifest.json` records every Git tag from
v0.4.0 through v0.17.0, its shipped Schema version, and the SHA-256 of every
published Migration body. Tests fail if an old Migration is edited or a
release mapping disappears.

For each distinct released Schema, the Migration suite seeds representative
repository, Session, Evidence, L1, file, audit, vector, Host Run, L2, L3, and
L4 rows supported at that version. Opening it through the current database
layer must apply all later Migrations while preserving applicable rows,
foreign keys, and SQLite integrity.

A deliberately incompatible v5 database forces Migration 6 to fail. The test
requires the Migration version and existing data to remain unchanged and then
moves the rejected database file, proving the failed constructor released its
SQLite handle.

## Release gate

The v0.17.0 release requires:

- local typecheck, build, tests, coverage, and packaged-install acceptance pass;
- a clean commit passes all GitHub CI jobs, including the three packaged-
  install matrix executions;
- the clean-commit package report and CI run are recorded here; and
- the external real-open-source acceptance is either completed or remains
  explicitly listed as the v1.0 proof gate.

## Local implementation result

The second local run passed all 11 gates on Windows with Node.js 22.20.0. It
installed `repomind@0.16.0` from a 249-entry tarball, found no forbidden files,
exposed all 24 MCP tools, completed the CLI and MCP lifecycle, restored the
baseline Memory, removed the post-backup mutation, and left zero open Sessions.

Artifacts are retained outside the repository at:

```text
D:\data\code\project\repomind-test\v017-package-local-20260729-02
```

- JSON report SHA-256:
  `bf217fdbc5736ac97adf86c721f533f669c40689778c88486ee2655eb0eab8c9`
- Markdown report SHA-256:
  `ef94dc705158944a45ca8c507fb30143782b5621395fde3e6c0fc6f7455563de`
- tarball SHA-256:
  `fa34e2c5a8dc7ba918bce370adf8f68c7fda3dc191295716dcd52778ad4bd1d4`

The first attempt is retained at
`D:\data\code\project\repomind-test\v017-package-local-20260729-01` and is not
counted. All product operations passed, but the initial forbidden-file rule
mistook intentional Agent Benchmark hidden checks under `benchmarks/` for the
top-level development test suite. The corrected rule still rejects top-level
tests, databases, local configuration, and coverage output.

The full local regression passed 169 tests across 38 files. Coverage passed the
existing floors at 83.82% statements/lines, 77.54% branches, and 95.04%
functions.

## Clean-commit cross-platform result

Commit `432f4f68523fe4275716b8089aa28afd7b3fbab3` fixed the package runner,
Migration fixtures, product code, and documentation in a clean worktree.
[GitHub Actions run 30444019485](https://github.com/Nei-Xin/repomind/actions/runs/30444019485)
completed successfully on 2026-07-29.

All five jobs passed: Ubuntu verify, Windows verify, macOS verify, source
coverage, and the comparison benchmark. Each verify job completed typecheck,
build, all 169 tests, the eight-task fixture validation, and the new installed-
tarball acceptance. The package-smoke command therefore passed through the
generated npm bin shim on all three supported CI operating systems. The macOS
verify job completed in 1 minute 10 seconds; Windows, the slowest matrix job,
completed in 6 minutes 18 seconds.

This closes the v0.17 distribution and upgrade release gates. It does not by
itself satisfy the separate v1.0 requirement for a cross-session benefit case
on an external real open-source repository.

## Formal release and tag result

Release commit `6961a65ed0e96c90fc3041811da4b5ceb7f5d8e2` updated the package
version, Changelog, and release wording. Annotated tag `v0.17.0` points to that
commit and was pushed on 2026-07-29.

[GitHub Actions tag run 30451648338](https://github.com/Nei-Xin/repomind/actions/runs/30451648338)
completed successfully in 6 minutes 5 seconds. Ubuntu, Windows, macOS,
coverage, and comparison jobs all passed against the tagged commit. This is
separate from the successful main-branch release-commit run `30451228817`.

## Post-release external proof

The separate external real-open-source criterion subsequently passed on the
fixed MIT-licensed `sindresorhus/p-limit` repository. A Claude Code Task 1
created Evidence-backed Memory, and three paired fresh-context OpenCode Task 2
runs compared no memory with Host-managed RepoMind from the same post-Task-1
commit. Both arms passed all checks; RepoMind reduced mean input Tokens by
41.1% and Agent duration by 17.5%, with both improvements present in every
pair. See
[`external-open-source-cross-session-acceptance-v0.17.md`](external-open-source-cross-session-acceptance-v0.17.md).

This post-release report closes the final v1.0 proof criterion without changing
the contents or identity of the already published v0.17.0 tag.

## Next security iteration

After the v0.17 distribution proof is committed and cross-platform CI passes,
the next scoped security iteration should add opt-in encrypted logical exports
and physical backup archives. It must use authenticated encryption, a
memory-hard password KDF, versioned envelope metadata, wrong-key and tampering
zero-write behavior, and credentials supplied only at execution time.

Logical Merge Import remains deferred. It needs a separate policy for Project
IDs, duplicate Memories, Evidence identity, conflicts, replacements, audit
history, and L2-L4 derived data; treating replacement as merge would violate
the current recovery contract.
