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
`formalScaleTargetEvaluated` to `false`; they cannot be cited as the
10,000-L1 result.

## Interpretation

Passing this runner proves the specified local operations on the recorded
machine and dataset. It does not prove remote LLM extraction quality, remote
Embedding behavior, Coding Agent outcome improvements, L4 Skill Candidates,
logical merge import, or encrypted archives. Cross-platform CI should exercise
the runner's implementation with smaller tests only; a formal 10,000-L1 report
must retain its raw artifacts and environment metadata.

CLI cold-start samples launch a new Node.js process every time. They do not
flush operating-system file or database page caches between samples.

## Development baseline

The current v0.14 development run passed all 19 gates on 2026-07-28.
It retained raw artifacts outside the repository at:

```text
D:\data\code\project\repomind-test\v0.14-scale-20260728-02
```

The run wrote 10,000 L1 records at 368.208 records/second, built 10,000 cached
embeddings in 3.770 seconds, and produced a 41,259,008-byte SQLite/WAL/SHM
footprint. Observed process RSS reached 160,739,328 bytes. The latency P95
values were 109.896 ms for FTS hits, 130.699 ms for empty FTS results, 295.528
ms for cached hybrid search, 1.158 ms for Inspect, 626.812 ms for Session Start,
and 380.662 ms for CLI process cold start.

This was an honest development baseline: the target checkout was fixed at
`01865c60c7b4bd8785f29a11cd65303a63596121`, while the runner itself was still
an uncommitted worktree change. It therefore demonstrates the implementation's
current behavior but is not the final clean-commit v0.14 release artifact. The
formal release acceptance must be rerun after the implementation is committed
so the runner checksum and RepoMind commit identify a clean, reproducible state.
