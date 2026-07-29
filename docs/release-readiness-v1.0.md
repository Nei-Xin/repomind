# RepoMind v1.0 release readiness

## Decision

`v1.0.0-rc.1` is the feature-frozen release candidate for RepoMind's local,
single-user product. All 28 final-product criteria in section 24 of
`REPOMIND_FINAL_PRODUCT_SPEC.md` have implementation and retained acceptance
evidence. The RC changes release metadata and documentation only; it does not
change product behavior, storage, protocols, or archive formats from v0.18.0.

During the RC period, only release-blocking correctness, data-safety, security,
installation, compatibility, and documentation defects may change the product.
New capabilities move to a later version.

## Frozen product scope

The v1.0 candidate includes:

- repository-scoped L1 Evidence-backed Memory with deterministic extraction;
- optional validated remote LLM extraction and optional hybrid vector search;
- governed validation, correction, invalidation, conflict, staleness, and
  physical forget workflows;
- deterministic L2 Module Narratives, L3 Repository Profile, and review-only
  L4 Skill Candidates;
- CLI and 24-tool MCP access tested with Claude Code and OpenCode;
- Host-managed OpenCode lifecycle, run artifacts, and reproducible evaluation;
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
| Database | Schema 11; every published Schema from v0.4.0 upgrades through immutable Migration hashes |
| Logical export | Writes format 2 and reads formats 1 and 2; import remains explicit replace semantics |
| Physical backup | Format 1; restore requires the same Project ID and retains a rollback snapshot |
| Encryption | Envelope format 1 using AES-256-GCM and scrypt; plaintext remains the default |
| CLI and MCP | Existing commands, JSON fields, error codes, and the 24 registered MCP tools form the v1.0 compatibility baseline |
| Providers | Deterministic extraction and FTS remain defaults; remote LLM, Embedding, and encryption are explicit opt-ins |

`v1.0.0-rc.1` maps to Schema 11. No Migration or archive conversion is needed
from v0.18.0. A future incompatible CLI or MCP change requires a major version
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

## Local RC preparation result

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

## RC creation gates

Before creating the `v1.0.0-rc.1` tag:

1. the RC preparation commit is clean and contains no product behavior change;
2. package metadata, CLI banner, MCP handshake, Changelog, and released-Schema
   fixture agree on `1.0.0-rc.1` and Schema 11;
3. local typecheck, build, full regression, version/Migration tests, and package
   content inspection pass;
4. the preparation commit passes Ubuntu, Windows, macOS, coverage, and
   comparison jobs on its first clean push; and
5. only then is an annotated `v1.0.0-rc.1` tag created and pushed, after which
   the independent tag-triggered five-job CI must also pass.

Passwords and provider keys remain environment-only throughout every gate.
Acceptance workspaces stay outside the repository under
`D:\data\code\project\repomind-test`.

## Stable promotion gates

Promotion from RC to `v1.0.0` requires all of the following:

- at least seven consecutive days of RC use without an unresolved P0 or P1
  correctness, data-loss, security, install, upgrade, or recovery defect;
- continuous tasks in at least two real repositories, with both Claude Code
  and OpenCode participating and no unexplained open Session or Host Run;
- fresh-install and v0.18-to-RC upgrade checks using the packed artifact;
- plaintext and encrypted logical/physical recovery checks with zero-write
  authenticated failure behavior and temporary plaintext cleanup;
- a final clean commit and annotated tag passing the same five GitHub CI jobs;
  and
- release notes that list the frozen compatibility contract, security boundary,
  supported runtime, recovery procedure, and deferred capabilities.

Any P0 or P1 fix resets the stability period and produces a later RC. Lower
severity documentation corrections do not reset it when they cannot affect
runtime, stored data, protocols, installation, or recovery.

## Rollback and release discipline

An RC is not promoted when a gate is unknown or waived. A failed RC remains an
immutable tag; the fix is released as `v1.0.0-rc.2` rather than moving the tag.
Operators can restore the retained pre-restore snapshot or a verified v0.18
backup, but a v1.0 database must never be opened by older code unless that
specific downgrade has been tested. RepoMind does not promise downgrade
compatibility.
