# RepoMind v1.0 release readiness

## Decision

The current source prepares **`v1.0.0-rc.3`** for the local, single-user product.
As checked on 2026-10-29, the latest GitHub release is `v1.0.0-rc.2`; the
`v1.0.0-rc.3` tag does not yet exist. This document records preparation, not a
published release or a completed cross-platform CI run.

RC.3 expands the earlier RC scope with explicit native integrations for Claude
Code, OpenCode, Pi, Codex CLI and Gemini CLI, plus Schema 12 activity capture.
The earlier RC.1/RC.2 feature-freeze statement is therefore superseded by this
listed RC.3 scope. New scope requires its own acceptance evidence; historical
28/28 product-criteria results do not by themselves validate these integrations.

See [RC.3 release notes](release-notes-v1.0.0-rc.3.md) for upgrade steps and
client-specific limitations. Stable promotion still requires the gates below.

## RC.3 product scope

The v1.0 candidate includes:

- repository-scoped L1 Evidence-backed Memory with deterministic extraction;
- optional validated remote LLM extraction and optional hybrid vector search;
- governed validation, correction, invalidation, conflict, staleness, and
  physical forget workflows;
- deterministic L2 Module Narratives, L3 Repository Profile, and review-only
  L4 Skill Candidates;
- CLI and 24-tool MCP access tested with Claude Code and OpenCode;
- Host-managed OpenCode/Claude lifecycle, run artifacts, and reproducible evaluation;
- native Claude/OpenCode/Pi/Codex/Gemini recall and activity capture through
  their documented hooks or extensions, with an authenticated local Bridge;
- replace-only logical import, same-Project-ID physical restore, and optional
  encrypted logical and physical archives; and
- versioned Migration, package, scale, cross-platform, and recovery evidence.

The following remain outside v1.0: logical Merge Import, automatic observation
of arbitrary host tools, automatic Skill installation or execution, cloud
sync/upload, multi-user service operation, remote restore tools, and encryption
of the live local SQLite database.

## Compatibility contract

| Surface | v1.0 RC contract |
| --- | --- |
| Runtime | Node.js 22.5 or newer and Git |
| Operating systems | Windows, Linux, and macOS through the GitHub CI matrix |
| Database | Schema 12; every published Schema from v0.4.0 upgrades through immutable Migration hashes |
| Logical export | Writes format 2 and reads formats 1 and 2; import remains explicit replace semantics |
| Physical backup | Format 1; restore requires the same Project ID and retains a rollback snapshot |
| Encryption | Envelope format 1 using AES-256-GCM and scrypt; plaintext remains the default |
| CLI and MCP | Existing commands, JSON fields, error codes, and the 24 registered MCP tools form the v1.0 compatibility baseline |
| Providers | Deterministic extraction and FTS remain defaults; remote LLM, Embedding, and encryption are explicit opt-ins |

RC.2 and v0.18.0 use Schema 11. Opening their repository with RC.3 applies
Migration 12. Back up with the old version before upgrading; do not open a
migrated database with RC.2. Logical/physical archive format versions remain
unchanged, but schema and contents are validated, so this is not a promise of
backward-compatible import into older code. A future incompatible CLI or MCP change requires a major version
or a documented compatibility period; patch releases must continue to open all
published databases.

## Evidence baseline

| Gate | Retained evidence | Status |
| --- | --- | --- |
| Final-product criteria | `docs/final-spec-audit-v0.16.md` plus `docs/final-spec-audit-v0.17.md` | 28/28 complete |
| External cross-session benefit | `docs/external-open-source-cross-session-acceptance-v0.17.md` | Complete |
| Installed package and historical upgrade | `docs/release-readiness-v0.17.md` | Complete |
| 10,000-L1 scale | `docs/scale-acceptance-v0.14.md` | Complete |
| Real cross-Agent lifecycle | `docs/l4-cross-agent-acceptance-v0.15.md` and `docs/remote-extraction-acceptance-v0.16.md` | Complete |
| Encrypted portability | `docs/encrypted-portability-v0.18.md` | 29/29 gates complete |
| v0.18 release tag | GitHub Actions run `30468234422` against `v0.18.0` / `60c8a29` | Five jobs passed |

The v0.18 tag run completed on 2026-07-30 in 7 minutes 17 seconds. Ubuntu,
Windows, macOS, source coverage, and comparison all passed. Each platform also
ran the installed-tarball acceptance, including encrypted export, import,
backup, and restore.

## RC.3 preparation evidence

The final runtime changes are committed at `2dc602d`. On 2026-10-28, the user’s
Debian 13.7 x86_64 server passed build, typecheck and **901 tests across 75 files**;
two Windows-specific tests were skipped. The tested source files were compared
by SHA-256 with the local changes before commit.

An installed `npm pack` artifact passed global npm symlink setup and idempotence.
Gemini CLI 0.66.0 completed real TUI multi-turn recall, cancellation followed by
a new prompt, native session resume, forced Bridge recovery and service shutdown
through the global executable. The final run had five committed tasks and one
abandoned task. Pi 1.4.0 and Codex CLI 0.165.0 native/cross-agent acceptance was
completed separately; see the retained [Pi/Codex](../docs-zh-CN/pi-codex-validation.md)
and [Gemini](../docs-zh-CN/gemini-validation.md) reports.

Model calls used the requested GPT relay. Gemini required a temporary external
protocol converter; the official Gemini model endpoint and token-by-token
upstream streaming were not tested. Provider secrets and test services were
removed after validation. Tests ran outside the source checkout's user data.

On 2026-10-29, the same server also passed `bench:agent-fixtures`,
`bench:cross-session-agent-fixtures`, `bench:layered-consumption-fixtures`, and
all 17 `bench:package-smoke` checks in a fresh external workspace. Reports are
retained under `/home/debian/repomind-validation/rc3-package-smoke` with the
`rc3-*-fixtures.log` files alongside it.

These results do not replace PR, merged-main or tag CI. The CI workflow checks
Ubuntu, Windows and macOS; MemoryProxy on Node 22 and 24; coverage; and the full
comparison benchmark. The release workflow separately runs regression, Agent,
cross-session/layered fixtures and installed-package smoke checks before packing.

## Local RC.2 preparation result

The 2026-08-12 Windows preparation audit passed typecheck, build, all 266
tests across 46 files, the eight-task Agent fixture validator, the full
cross-session fixture validator, and all three derived-only layered sequences.
The installed `repomind@1.0.0-rc.2` tarball passed 17 checks, including clean
version/help output, pre/post-initialization Agent diagnostics, idempotent
initialization, CLI/MCP persistence, encrypted recovery, package-boundary
inspection, and zero open Sessions.

The packed artifact contains 236 files and 1,561,670 unpacked bytes. Benchmark
sources, hidden validators, fixture repositories, local databases, tests, and
coverage output are excluded. The retained Windows tarball SHA-256 is
`b4b3dbf5effc2899e33f808baff19550b7a694e0868db8878547f4fd800ed65d`.
The complete audit and command record is in
[`release-audit-v1.0.0-rc.2.md`](release-audit-v1.0.0-rc.2.md).

## Historical RC.1 preparation result

The 2026-07-30 Windows preparation run used Node.js 22.20.0. Typecheck and
build passed, all 174 tests across 39 files passed, the 15 focused
version/Migration/MCP contract tests passed, and all eight Agent fixtures
validated with their intended public and hidden baselines.

The installed-tarball acceptance passed all 14 checks using
`repomind@1.0.0-rc.1`. The 253-file package contained no forbidden database,
local configuration, top-level test, or coverage files. The installed CLI and
all 24 MCP tools completed plaintext and encrypted lifecycle/recovery checks
and left no open Session.

Artifacts are retained outside the repository at:

```text
D:\data\code\project\repomind-test\v100-rc1-package-precommit-20260730-01
```

- tarball SHA-256:
  `47ecf7cf5d8ec0e8530014c2e6dce4db71eac79c21cd3feec1651407547710d6`
- package report: `package-smoke-report.json`

This is pre-commit validation of the metadata and documentation worktree. It
does not replace the required clean-commit main and tag CI runs.

## RC.3 creation gates

1. Version metadata, CLI/MCP version, Changelog and release notes agree on
   `1.0.0-rc.3`; the current database migration is 12. The historical released
   schema manifest must keep the immutable RC.1/RC.2 mapping to Schema 11.
2. Push the reviewed branch and open a PR against `main`; pass all configured
   CI jobs at its final head, including cross-platform package checks.
3. Merge the PR and verify CI on the resulting main commit. Do not infer its
   result from a different branch revision or earlier server run.
4. Verify the release tag is unused, then create an annotated `v1.0.0-rc.3` tag
   at that tested main commit. Never move a published tag or replace its assets.
5. Verify both tag CI and the Release workflow. The latter publishes a GitHub
   **prerelease** with a tarball and `SHA256SUMS`; verify the downloaded checksum
   and attach the prepared release notes before declaring release complete.

No npm Registry publication is part of this workflow. The unscoped npm package
`repomind` belongs to another publisher; install only this project's GitHub
artifact or source. A registry release would require a separately chosen,
owned package name and its own publication setup.

## Stable promotion gates

Promotion from RC to `v1.0.0` requires all of the following:

- at least seven consecutive days of RC use without an unresolved P0 or P1
  correctness, data-loss, security, install, upgrade, or recovery defect;
- continuous tasks in at least two real repositories, with both Claude Code
  and OpenCode participating and no unexplained open Session or Host Run;
- fresh-install and v0.18-to-RC upgrade checks using the packed artifact;
- plaintext and encrypted logical/physical recovery checks with zero-write
  authenticated failure behavior and temporary plaintext cleanup;
- a final clean commit and annotated tag passing all configured GitHub CI jobs;
  and
- release notes that list the frozen compatibility contract, security boundary,
  supported runtime, recovery procedure, and deferred capabilities.

Any P0 or P1 fix resets the stability period and produces a later RC. Lower
severity documentation corrections do not reset it when they cannot affect
runtime, stored data, protocols, installation, or recovery.

## Rollback and release discipline

An RC is not promoted when a gate is unknown or waived. A failed RC remains an
immutable tag; the fix is released as a later RC rather than moving the tag.
Operators can restore the retained pre-restore snapshot or a verified v0.18
backup, but a v1.0 database must never be opened by older code unless that
specific downgrade has been tested. RepoMind does not promise downgrade
compatibility.
