# RepoMind v0.14 scale acceptance

## Goal

The scale runner verifies that the existing L0-L3 foundation remains usable at
10,000 repository-scoped L1 records before L4 Skill Candidate work begins. It
is a performance and integrity acceptance, not an extraction-quality or Agent
task-success benchmark.

## Dataset

The runner clones a requested real Git commit into a new workspace and uses an
isolated `REPOMIND_DATA_DIR`. It records exactly 10,000 deterministic L1 items
through the public RepoMind API. Every item has:

- one independent manual Evidence record;
- one real tracked-file association;
- one creation audit record;
- a repository or module scope;
- one of the ten public Memory types; and
- a deterministic English identifier plus mixed-language tags.

The runner builds a 64-dimensional offline deterministic vector cache. This
keeps the experiment reproducible and measures cached local hybrid retrieval;
it does not model remote Embedding latency or cost.

## Hard gates

| Operation | Target |
| --- | ---: |
| FTS hit and empty-result search P95 | less than 150 ms |
| Cached hybrid search P95 | less than 500 ms |
| Memory Inspect P95 | less than 100 ms |
| Session Start without a remote model P95 | less than 1 second |
| CLI cold start P95 | less than 1 second |

The run also fails if counts drift, an L1 lacks Evidence, FTS or the vector
cache is incomplete, sampled recall misses, repository data crosses Project ID
boundaries, SQLite integrity fails, foreign keys fail, or Sessions remain open.

## Run

Use a new workspace every time; the runner refuses to overwrite an existing
path.

```powershell
npm run bench:scale-10k -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\v0.14-scale-<new-id> `
  --commit <full-commit> `
  --repeat 50
```

The workspace receives `scale-10k-report.json` and
`scale-10k-report.md`. The report records the exact commit, script checksum,
worktree state, OS, Node.js, CPU, memory, generator configuration, database
size, observed process-memory high-water, seed throughput, raw latency samples,
checks, and explicit limitations.

CI and local development can exercise the complete runner with a smaller
dataset:

```powershell
npm run bench:scale-10k -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\v0.14-scale-smoke-<new-id> `
  --smoke --count 100 --repeat 20
```

Only explicit smoke mode accepts `--count`, limited to 100-1,000 records.
Smoke reports use a different report kind and set
`formalScaleTargetEvaluated` to `false`. They enforce the 13 data integrity,
recall, isolation, database, and Session checks, but only record latency; they
do not apply the six machine-dependent performance gates and cannot be cited
as the 10,000-L1 result.

## Interpretation

Passing this runner proves the specified local operations on the recorded
machine and dataset. It does not prove remote LLM extraction quality, remote
Embedding behavior, Coding Agent outcome improvements, L4 Skill Candidates,
logical merge import, or encrypted archives. Cross-platform CI should exercise
the runner's implementation with smaller tests only; a formal 10,000-L1 report
must retain its raw artifacts and environment metadata.

CLI cold-start samples launch a new Node.js process every time. They do not
flush operating-system file or database page caches between samples.

## Formal release evidence

The clean-commit v0.14 acceptance passed all 19 gates on 2026-07-28. The
runner and target checkout were both fixed at commit
`0a0933414542f2e84204eed84232f031405cba8d`, and the report recorded
`repoMindWorktreeDirty: false`.

The raw artifacts are retained outside the repository at:

```text
D:\data\code\project\repomind-test\v0.14-scale-20260728-08
```

The JSON report SHA-256 is
`4f569cb81c8f83b166f15a28af4ce6c353db87f9133a3ce4f160baae48c66cb1`;
the Markdown report SHA-256 is
`7dd0c395d9f07dc9bdc1ee82ff811822629dc5be1e0699e1684e105db161e9d7`.
The runner script SHA-256 recorded inside the report is
`8f85e93d0fedb751c5cecf8e8488fc64d0a18a2a44ab36c97b8bd733d771b178`.

The run stored 10,000 L1 records at 307.880 records/second. All 10,000 were
active, Evidence-backed, file-linked, audited, indexed by FTS, and represented
in the cached vector index. The SQLite/WAL/SHM footprint was 41,267,200 bytes,
and observed process RSS reached 195,092,480 bytes.

| Operation | P95 ms | Gate | Result |
| --- | ---: | ---: | --- |
| FTS hit | 91.326 | less than 150 | passed |
| FTS empty result | 87.604 | less than 150 | passed |
| Cached hybrid search | 330.503 | less than 500 | passed |
| Memory Inspect | 1.016 | less than 100 | passed |
| Session Start | 637.195 | less than 1,000 | passed |
| CLI cold start | 378.916 | less than 1,000 | passed |

GitHub Actions [CI run #51](https://github.com/Nei-Xin/repomind/actions/runs/30375255695)
then passed on the same commit in 5 minutes. Its five successful jobs were the
Ubuntu, Windows, and macOS verification matrix, coverage, and the comparison
benchmark. The run retained both coverage and comparison-report artifacts.

This evidence was produced on Windows 11 x64 with Node.js 22.20.0 and an AMD
Ryzen 7 H 255 processor. It proves the stated local scale and integrity gates
on that machine and deterministic dataset; the limitations listed above still
apply.
