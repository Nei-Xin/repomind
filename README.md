# RepoMind

RepoMind is a local, evidence-backed memory layer for coding agents. It captures repository task evidence, stores reusable L1 memories, and exposes them through a CLI and MCP server.

The current implementation includes repository identity, SQLite/FTS5/sqlite-vec storage, Git snapshots, session start/commit, deterministic memory extraction, opt-in validated remote LLM extraction, hybrid search with deterministic fallback, inspection, file-hash stale-memory detection, deterministic conflict detection, secret redaction, and audited validation, correction, invalidation, and forget workflows.

## Requirements

- Node.js 22.5 or newer
- Git
- OpenCode or Claude Code for `repomind run` (the CLI/MCP memory workflows do
  not require either Agent)

## Install

Install the tagged GitHub Release artifact:

```bash
npm install --global https://github.com/Nei-Xin/repomind/releases/download/v1.0.0-rc.2/repomind-1.0.0-rc.2.tgz
repomind --version
```

The unscoped package name `repomind` on npm belongs to a different project.
Do not use `npm install --global repomind` for this repository. RepoMind's
release workflow publishes the installable tarball and its `SHA256SUMS` file
on the matching GitHub Release until a project-owned npm scope is configured.

To install from a source checkout instead:

```bash
npm ci
npm run build
npm link
```

Initialize RepoMind inside a Git repository:

```bash
repomind init
repomind doctor --runner opencode
```

Use `--runner claude` when Claude Code is the intended Host. `doctor` checks
Git, repository initialization, SQLite/FTS/vector support, and the selected
Agent executable. If an Agent is outside `PATH`, add
`--runner-executable <path>`. Running `init` again is safe and preserves the
existing Project ID; `init --new-id` intentionally creates a new identity.

Only `.repomind/project.json` is written to the repository. Memory data is stored under `~/.repomind/repositories/<projectId>/repomind.db`. Set `REPOMIND_DATA_DIR` to override the user data directory.

## Five-minute flow

For the normal Agent workflow, run the task through RepoMind:

```bash
repomind run --task "Fix the Windows SQLite loader" --runner opencode
```

RepoMind retrieves L1-L3 context, runs the selected Agent, captures evidence,
closes the Session, and maintains derived context after a successful result.

For a manually managed or MCP-driven workflow, start a Session:

```bash
repomind start --task "Fix the Windows SQLite loader" --json
```

After making changes, commit the RepoMind session using the returned session ID:

```bash
repomind commit --session <session-id> --key demo-1 --summary "Validated the SQLite loader fix" --json
```

Optionally run the separate remote LLM extraction phase after configuring an
OpenAI-compatible endpoint:

```text
REPOMIND_EXTRACTION_PROVIDER=openai-compatible
REPOMIND_EXTRACTION_BASE_URL=https://api.example.com/v1
REPOMIND_EXTRACTION_API_KEY=...
REPOMIND_EXTRACTION_MODEL=...
```

```bash
repomind extract --session <session-id> --json
```

This capability is disabled by default. It sends the completed Session's
redacted Evidence to the configured provider, validates every candidate and
Evidence reference before persistence, and writes the accepted batch in one
transaction. See
[`docs/remote-llm-extraction.md`](docs/remote-llm-extraction.md) for the data
boundary, timeout setting, MCP tool, and privacy limitations.

Search and inspect the resulting memory:

```bash
repomind search "SQLite loader" --json
repomind inspect <memory-id> --json
```

For transparent Claude Code integration from a source checkout, manage the
loopback Bridge and the bundled MemoryProxy together:

```powershell
repomind services start
repomind services status
repomind services stop
```

MemoryProxy must first have its local `config.yaml` and dependencies installed
under `services/memory-proxy`. See
[`docs/claude-interactive.md`](docs/claude-interactive.md) for setup and hook
installation.

Run a coding Agent task with RepoMind managing the complete lifecycle outside
the model loop. OpenCode remains the default:

```powershell
repomind run `
  --repo D:\path\to\repository `
  --task "Fix invoice quantity arithmetic" `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-terra `
  --context-budget 12000
```

Claude Code uses the same Host lifecycle:

```powershell
repomind run `
  --repo D:\path\to\repository `
  --task "Fix invoice quantity arithmetic" `
  --runner claude `
  --model gpt-5.6-luna `
  --context-budget 12000
```

`repomind run` retrieves before the selected Agent, injects the returned
memories, captures command and test evidence, and commits after a normal Agent
exit. Omit `--model` to use that Agent's configured default. Daily Claude runs
use `dontAsk` with an explicit coding-tool allowlist; permission bypass is
reserved for Host-created disposable evaluation checkouts. Interrupted, timed
out, or unstartable Agent processes abandon the session instead of leaving it
open. Redacted `events.jsonl`, `stderr.log`, and `run.json` artifacts are stored
under `~/.repomind/runs/` by default. See
[`docs/opencode-integration.md`](docs/opencode-integration.md) and
[`docs/claude-integration.md`](docs/claude-integration.md) for runner-specific
behavior.

The default `--context-budget` is 12,000 characters. It bounds only the
repository context injected by the Host: the current L3 profile, relevant
current L2 narratives, and ranked L1 memories. The complete current task and
the fixed Host lifecycle instructions are not clipped by this repository
context budget. Valid values are 1,000 through 24,000 characters. On Windows,
the Host also rejects a rendered prompt above 28,000 characters before spawn.
It also computes the fully quoted Windows command line and rejects values above
the 32,767-character platform boundary. Shorten the task or lower the context
budget if either guard is reached.

After a successful Host-managed commit, `repomind run` synchronously performs
best-effort derived maintenance in L2, L3, then L4 order. It rebuilds module
narratives, attempts the repository profile (reported as skipped when no
eligible source exists), and refreshes review-required Skill Candidates.
Maintenance errors are recorded separately and do not roll back the committed
Session or turn an otherwise successful Host run into a failure. Partial,
failed, and abandoned runs do not trigger this maintenance. The automation is
limited to the Host-managed lifecycle: direct CLI or MCP commits and
agent-managed runs still use the explicit rebuild commands and tools below.

For a newly initialized repository, generate reviewable memory candidates
without writing them to the database, then explicitly confirm all or a selected
subset:

```bash
repomind bootstrap --output bootstrap-candidates.json --json
repomind bootstrap-apply --input bootstrap-candidates.json --yes --json
```

Inspect Host-managed runs even when they used custom artifact directories:

```bash
repomind runs --status committed --limit 20 --json
repomind run-inspect ses_... --json
```

Review memories that need human maintenance, then resolve each item with the
existing audited governance commands:

```bash
repomind review
repomind review --kind stale --json
repomind memory-validate mem_... --reason "Reviewed against the current files"
repomind review-apply --input review-decisions.json --json
repomind review-history --limit 20 --json
```

The queue refreshes file hashes before listing work and classifies uncertain
memories as `stale`, `conflict`, or `other`. Validated, corrected, invalidated,
or conflict-reconciled memories leave the queue on the next review.

Build bounded L2 narratives from active, evidence-backed L1 memories:

```bash
repomind module-rebuild --json
repomind module-rebuild --module src/storage --budget 4000 --json
repomind modules --json
repomind module-inspect l2_... --json
```

Module narratives are independent derived records with L1 source links,
incremental source fingerprints, FTS recall, and a hard character budget. A
Session Start can return current matching L2 context alongside atomic memories.
Successful Host-managed runs rebuild L2 automatically after commit; the manual
CLI and MCP rebuild operations remain available for every other lifecycle.
Run the fixed-commit real-repository acceptance with `npm run bench:l2-real`;
the recorded v0.12 method and results are in
[`docs/l2-real-repository-acceptance-v0.12.md`](docs/l2-real-repository-acceptance-v0.12.md).

Build the bounded L3 repository profile from stable, evidence-backed L1 facts
and current L2 module boundaries:

```bash
repomind profile-rebuild --json
repomind profile-rebuild --budget 6000 --min-confidence 0.8 --json
repomind profile --json
repomind profile-inspect --json
```

The profile is versioned, preserves its L1/L2 provenance, and becomes stale
when an eligible source changes. Only a current profile is injected into
Session Start; use `repomind start --no-profile` to opt out. See
[`docs/repository-profile.md`](docs/repository-profile.md) for the contract and
[`docs/l3-real-repository-acceptance-v0.12.md`](docs/l3-real-repository-acceptance-v0.12.md)
for the fixed-commit real-repository result.

Build review-required L4 Skill Candidates from workflows observed in at least
three successful Sessions:

```bash
repomind skill-rebuild --json
repomind skills --status pending --json
repomind skill-inspect l4_... --json
repomind skill-review l4_... --action approve --reason "Commands and risks reviewed" --json
repomind skill-export l4_... --output ./review/SKILL.md --json
```

The deterministic v0.15 generator groups committed Sessions only when their
successful command and test sets match. Every candidate retains Session and
Evidence provenance. Failed, partial, abandoned, command-free, and one-off
tasks cannot qualify. A changed source set resets approval to `pending`.
Export requires explicit approval, never overwrites a file, redacts secrets
and absolute paths, and never installs or executes the result. Successful
Host-managed commits refresh candidates automatically, but RepoMind never
automatically approves, exports, installs, or executes one. See
[`docs/skill-candidates.md`](docs/skill-candidates.md).

Create a portable logical export, preview an atomic replacement import, or
create and restore a physical same-project backup:

```powershell
repomind export --output D:\backups\repomind-export.json --json
repomind import --input D:\backups\repomind-export.json --dry-run --json
repomind import --input D:\backups\repomind-export.json --yes --json
repomind backup --output D:\backups\repomind.db --json
repomind restore --input D:\backups\repomind.db --dry-run --json
repomind restore --input D:\backups\repomind.db --yes --json
```

For an encrypted archive, provide the passphrase only through the environment
and opt in when creating it:

```powershell
$env:REPOMIND_ARCHIVE_PASSPHRASE = Read-Host "Archive passphrase" -MaskInput
repomind export --output D:\backups\repomind-export.enc.json --encrypt --json
repomind import --input D:\backups\repomind-export.enc.json --yes --json
repomind backup --output D:\backups\repomind.db.enc --encrypt --json
repomind restore --input D:\backups\repomind.db.enc --yes --json
Remove-Item Env:REPOMIND_ARCHIVE_PASSPHRASE
```

Logical import maps repository references into the initialized target and uses
explicit `replace` semantics. Physical restore requires the same Project ID
and retains a pre-restore snapshot. Outputs never overwrite existing files,
and exports with sensitive-pattern findings require `--allow-sensitive` after
review. Encrypted archives use authenticated AES-256-GCM and scrypt; plaintext
formats remain compatible. See [`docs/data-portability.md`](docs/data-portability.md)
for the data contract, password handling, and recovery procedure. The formal
29-gate result and three-platform installed-package proof are recorded in
[`docs/encrypted-portability-v0.18.md`](docs/encrypted-portability-v0.18.md).

See [`docs/daily-workflow.md`](docs/daily-workflow.md) for candidate sources,
confirmation and staleness rules, run-history fields, and a continuous-use
verification workflow.

When a related file changes or is deleted, later search and inspect calls mark the memory `uncertain` and return a concrete warning plus expected/current file hashes. RepoMind does not automatically delete or invalidate the memory because a file change means the conclusion needs review, not necessarily that it is wrong.

Record an explicit repository fact without an LLM:

```bash
repomind record --type convention --title "Public API types" --content "Public APIs export explicit TypeScript types."
```

## MCP configuration

```json
{
  "mcpServers": {
    "repomind": {
      "command": "repomind",
      "args": ["mcp"]
    }
  }
}
```

The MCP server exposes twenty-four tools:

- `repo_session_start`
- `repo_memory_search`
- `repo_session_commit`
- `repo_memory_extract`
- `repo_session_abandon`
- `repo_memory_inspect`
- `repo_memory_review`
- `repo_memory_review_apply`
- `repo_module_rebuild`
- `repo_module_list`
- `repo_module_inspect`
- `repo_profile_rebuild`
- `repo_profile_get`
- `repo_profile_inspect`
- `repo_skill_candidate_rebuild`
- `repo_skill_candidate_list`
- `repo_skill_candidate_inspect`
- `repo_skill_candidate_review`
- `repo_skill_candidate_export`
- `repo_memory_record`
- `repo_memory_validate`
- `repo_memory_correct`
- `repo_memory_invalidate`
- `repo_memory_forget`

See [`docs/mcp-integration.md`](docs/mcp-integration.md), [`docs/opencode-integration.md`](docs/opencode-integration.md), and the client examples under [`examples/`](examples/) for setup and end-to-end verification flows.

See [`docs/stale-detection.md`](docs/stale-detection.md) for the `active` to `uncertain` behavior and a reproducible validation flow.

See [`docs/memory-governance.md`](docs/memory-governance.md) for the `validate`, `correct`, and `invalidate` state transitions, [`docs/memory-maintenance.md`](docs/memory-maintenance.md) for review batches and maintenance history, [`docs/module-narratives.md`](docs/module-narratives.md) for the L2 derivation contract, [`docs/repository-profile.md`](docs/repository-profile.md) for L3 freshness and provenance, and [`docs/skill-candidates.md`](docs/skill-candidates.md) for the L4 review boundary.

For commit and inspect calls, pass `repo_path` when a request is made after the MCP server has restarted.

Secrets are redacted from everything that reaches long-term storage, and Git diff capture skips sensitive paths outright. See [`SECURITY.md`](SECURITY.md) for the threat model and the limits of pattern-based redaction.

## Vector search

Vector retrieval is optional. With no provider configured, search remains the
same repository-scoped FTS5 search as before. For an offline reproducible
provider suitable for development and tests:

```powershell
$env:REPOMIND_EMBEDDING_PROVIDER = "deterministic"
$env:REPOMIND_EMBEDDING_DIMENSIONS = "256"
repomind vector-reindex --json
```

For an OpenAI-compatible embeddings endpoint:

```text
REPOMIND_EMBEDDING_PROVIDER=openai-compatible
REPOMIND_EMBEDDING_BASE_URL=https://api.example.com/v1
REPOMIND_EMBEDDING_API_KEY=...
REPOMIND_EMBEDDING_MODEL=...
REPOMIND_EMBEDDING_DIMENSIONS=1536
```

`repomind status` and `repomind doctor` report sqlite-vec and provider state.
Embedding failures return FTS results and do not partially update the vector
cache. See [`docs/vector-search.md`](docs/vector-search.md) for lifecycle and
privacy details.

## Packaged release verification

RepoMind verifies the artifact users install, not only the source checkout.
The acceptance packs the current build, installs that tarball into an isolated
consumer, rejects forbidden package files, and exercises CLI, MCP, backup, and
restore through the installed copy:

```powershell
npm run bench:package-smoke -- --workspace D:\data\code\project\repomind-test\package-smoke-<new-id>
```

The workspace must not exist. It receives JSON and Markdown reports plus the
exact tarball and recovery artifacts. CI runs this acceptance on Ubuntu,
Windows, and macOS. See [`docs/release-readiness-v0.17.md`](docs/release-readiness-v0.17.md).

## Scope

RepoMind v1.0.0-rc.2 is the current release candidate for the local
single-user v1.0 product. It includes deterministic L2 Module Narratives, an
evidence-backed L3 Repository Profile, and the first versioned export,
replace-import, backup, and restore loop. It also includes a rebuildable
10,000-L1 scale acceptance runner and deterministic, review-required L4 Skill
Candidate generation with safe export. It includes the explicit, validated
remote LLM extraction introduced in v0.16.0 while keeping deterministic
extraction as the default. v0.17.0 adds installed-tarball verification on all
three CI operating systems and locks every published Schema upgrade path. It
does not passively observe tools used by Agents launched outside RepoMind's
registered Host adapters, and it does not include Skill installation or Skill
execution. v0.18.0 added opt-in encrypted logical exports and physical backups
with environment-only passphrases and authenticated zero-write rejection.
Logical Merge Import remains deferred beyond v1.0. Source-only V8
coverage reporting, regression floors, successful macOS CI, and real
OpenCode/Claude Code Host and MCP interoperability acceptance are included.
The RC.2 Host path automatically injects budgeted L1-L3 context, maintains
derived layers after successful runs, discovers L4 candidates without
approving them, and enforces Claude checkout containment in isolated
evaluation runs. See
`REPOMIND_PROJECT_PLAN.md` and `REPOMIND_FINAL_PRODUCT_SPEC.md` for the staged
roadmap.

The RC freezes database Schema 11, logical export format 2, physical backup
format 1, and encrypted envelope format 1. Promotion to v1.0.0 requires clean
main-branch and annotated-tag CI plus the documented stability period. See
[`docs/release-readiness-v1.0.md`](docs/release-readiness-v1.0.md).

The v0.18.0 encrypted-portability acceptance passes all 29 gates on a clean
fixed commit. GitHub Actions tag run `30468234422` passes Ubuntu, Windows,
macOS, coverage, and comparison against the released tag. See
[`docs/encrypted-portability-v0.18.md`](docs/encrypted-portability-v0.18.md).

The v0.17 distribution acceptance passes all 11 local package gates and the
clean-commit and release-tag GitHub matrices pass installed-tarball verification
on Ubuntu, Windows, and macOS. A post-release external `p-limit` study also
passes six fresh-context OpenCode runs: both arms pass every check, while
RepoMind lowers mean uncached/raw input Tokens by 41.1% and Agent duration by
17.5% after a Claude Code source task. That legacy report does not contain the
new total-prompt breakdown or provider-price weighting, so it is not a cost
claim. See
[`docs/release-readiness-v0.17.md`](docs/release-readiness-v0.17.md),
[`docs/external-open-source-cross-session-acceptance-v0.17.md`](docs/external-open-source-cross-session-acceptance-v0.17.md),
and [`docs/final-spec-audit-v0.17.md`](docs/final-spec-audit-v0.17.md).

The historical v0.15.0 formal L4 report passes all 20 gates on a clean fixed
commit, and its real L4/MCP cross-Agent report passes all 17 checks across
OpenCode and Claude Code. It does not validate the current layered Host prompt.
GitHub CI validates Ubuntu, Windows, macOS, coverage, and the comparison
benchmark. See
[`docs/skill-candidate-acceptance-v0.15.md`](docs/skill-candidate-acceptance-v0.15.md)
and
[`docs/l4-cross-agent-acceptance-v0.15.md`](docs/l4-cross-agent-acceptance-v0.15.md).
The earlier 10,000-L1 result remains documented in
[`docs/scale-acceptance-v0.14.md`](docs/scale-acceptance-v0.14.md).

## Development

```bash
npm run typecheck
npm test
npm run build
```

Measure retrieval quality and cross-session guarantees (see [`docs/benchmark.md`](docs/benchmark.md)):

```bash
repomind eval --dataset benchmarks/datasets/basic-retrieval.json --json
repomind eval --scenarios --json
repomind eval --compare --markdown
```

Rebuild the v0.16 remote-extraction harness with deterministic fixtures, or run
it against an explicitly configured provider:

```bash
npm run bench:remote-extraction -- --repo . --workspace <new-directory> --commit HEAD --mock
npm run bench:remote-extraction -- --repo . --workspace <new-directory> --commit HEAD
```

The live run requires `REPOMIND_EXTRACTION_*` only in the invoking process and
refuses to write a report containing the credential. See
[`docs/remote-extraction-acceptance.md`](docs/remote-extraction-acceptance.md).
The clean-commit `gpt-5.6-terra` result passed all 13 dataset gates. The separate
historical Claude Code to OpenCode continuous task passed all 17 MCP/L4
cross-Agent gates, and
GitHub CI passed Ubuntu, Windows, macOS, coverage, and comparison jobs against
the same pushed commit. See
[`docs/remote-extraction-acceptance-v0.16.md`](docs/remote-extraction-acceptance-v0.16.md).

The comparison benchmark scores the context bundle each memory strategy delivers under a fixed token budget, including no-memory, full-history, lexical, vector, and hybrid arms. It measures context quality, not agent task success — see [`docs/benchmark-comparison.md`](docs/benchmark-comparison.md) for what it deliberately does not prove.

Run a controlled OpenCode three-arm task benchmark:

```bash
repomind eval --agent --manifest path/to/manifest.json --runner opencode --model cliproxyapi/gpt-5.6-luna --lifecycle host-managed --repeat 3 --output agent-results --strict --require-acceptance --json
```

Manifest v2 compares no-memory, raw full-history, and RepoMind arms. Each arm starts from a fresh clone at the same commit, and execution order rotates by repetition. `--lifecycle host-managed` starts retrieval before OpenCode, injects the returned layered context, runs Host-owned public and hidden checks after the Agent, commits the resulting quality status, and maintains L2-L4 only after a successful commit. Hidden checks authorize the outcome but are never persisted as Evidence; only public check evidence may become reusable Memory. The backward-compatible default is `agent-managed`, where OpenCode calls RepoMind MCP tools itself. Hidden checks stay outside the task repository, raw JSONL is retained, and `--strict` validates experimental integrity rather than requiring RepoMind to win. Report v7 separates start, Agent, commit, and maintenance timing/status and records L1-L3 retrieval/injection IDs, budgets, quality flags, authoritative verification, derived-layer snapshots, paired deltas, acceptance gates, and provenance. A reproducible eight-task suite can be generated with `node benchmarks/agent-suite/create.mjs <new-directory>` and validated with `npm run bench:agent-fixtures`. The daily Host-managed entry point has a separate full-path acceptance command: `npm run bench:host-run -- --workspace <new-directory> --model <id> --strict`.

Run a real cross-Session learning experiment without pre-seeding the measured knowledge:

```bash
repomind eval --agent-cross-session --manifest path/to/cross-session-manifest.json --runner opencode --model cliproxyapi/gpt-5.6-luna --repeat 5 --output cross-session-results --strict --require-acceptance --json
```

Each episode compares a `shared` chain with an `isolated` chain. Every stage uses a fresh checkout and the same projectId; only `shared` reuses the previous stage database. Stage checkpoints carry identical within-arm code history forward, while the report measures hidden/public outcomes, recall, L1-L3 injection, duration, Tokens, reads, lifecycle closure, and maintenance. See [`docs/cross-session-agent-benchmark.md`](docs/cross-session-agent-benchmark.md).

The 2026-08-11 repeat-5 formal run used OpenCode only. Its correctness and
efficiency cohorts passed integrity, acceptance, and independent audit; the
observed uplift came from L1 injection, while L2 was not injected and L3 was
deduplicated against its L1 provenance. The mixed Claude/OpenCode manifest has
not yet completed a formal run. See the
[`Chinese formal experiment report`](project-report-zh-CN/10-cross-session-formal-experiment-20260811.md)
for exact results and limitations.

The default runner may also be `claude`. A manifest can override `runner` and
`model` per stage, enabling Claude-to-OpenCode and OpenCode-to-Claude transfer
experiments. When a stage switches runner, give that stage an explicit model.

Aggregate multiple report v4-v7 files without losing their provenance:

```bash
repomind eval --agent-summary --reports "results/**/summary.json" --output aggregate-results --strict --json
```

Profile an existing Agent result without calling the model again:

```bash
repomind eval --agent-profile --report results/summary.json --output agent-profile --strict --json
```

Aggregate report v2 records each source schema and reports missing telemetry as
missing rather than zero. Profile v2 separates direct Agent-managed MCP time
from Host-managed start, Agent, commit, and maintenance phases; it also shows
L1-L3 context injection and telemetry coverage.

See [`docs/agent-benchmark.md`](docs/agent-benchmark.md) for the protocol,
[`docs/agent-run-acceptance-results-v0.9.md`](docs/agent-run-acceptance-results-v0.9.md)
for the formal v0.9 daily-run acceptance (8/8 tasks accepted),
[`docs/daily-workflow-acceptance-results-v0.10.md`](docs/daily-workflow-acceptance-results-v0.10.md)
for the formal v0.10 continuous-workflow acceptance (reviewed bootstrap,
cross-task memory reuse, persistent run history, and timeout cleanup),
[`docs/agent-benchmark-results-v0.8.md`](docs/agent-benchmark-results-v0.8.md)
for the formal v0.8 host-managed result (72/72 runs valid and all outcome
acceptance gates passed),
[`docs/agent-benchmark-results-v0.7.md`](docs/agent-benchmark-results-v0.7.md)
for the formal v0.7 three-arm result (integrity passed, outcome acceptance
failed), and
[`docs/agent-benchmark-validation-v0.7.md`](docs/agent-benchmark-validation-v0.7.md)
for deterministic infrastructure acceptance. The earlier v0.6 two-arm result
is preserved in
[`docs/agent-benchmark-results-v0.6.md`](docs/agent-benchmark-results-v0.6.md).

[`docs/architecture.md`](docs/architecture.md) explains how the pieces fit and [`docs/memory-model.md`](docs/memory-model.md) explains what is stored and why; the reasoning behind each structural choice is recorded under [`docs/adr/`](docs/adr/). [`docs/troubleshooting.md`](docs/troubleshooting.md) covers error codes and common situations, and [`CONTRIBUTING.md`](CONTRIBUTING.md) lists the architecture rules a change must respect.
