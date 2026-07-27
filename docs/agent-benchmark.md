# Controlled agent benchmark

`repomind eval --agent` measures end-to-end coding-agent task outcomes using
no-memory, raw full-history, and RepoMind arms. It currently supports OpenCode and always creates a controlled
primary agent that cannot delegate work to background agents.

```powershell
repomind eval --agent `
  --manifest D:\path\to\manifest.json `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-terra `
  --repeat 3 `
  --output D:\path\to\results `
  --strict `
  --require-acceptance `
  --json
```

Every task and arm is cloned independently from `baseRepository` and checked
out at `baseCommit`. Manifest v2 rotates the three execution orders by
repetition. The RepoMind arm gets an isolated data directory and the manifest
memories. The full-history arm receives raw history that can contain obsolete
attempts and noise, but no MCP server. The no-memory arm receives neither.
Manifest v1 remains supported and retains the original alternating two-arm run.

## Manifest

Commands are represented as a program plus an argument array. They are never
accepted as shell command strings. `{repo}` in a check command or argument is
replaced with the fresh clone path.

```json
{
  "version": 2,
  "name": "example suite",
  "tasks": [{
    "id": "example",
    "baseRepository": "./base",
    "baseCommit": "HEAD",
    "prompt": "Implement the requested change.",
    "fullHistory": [
      "An old attempt used the legacy API and failed.",
      "A later review recorded the current convention among unrelated discussion."
    ],
    "publicChecks": [{ "command": "node", "args": ["--test"] }],
    "hiddenChecks": [{ "command": "node", "args": ["./hidden/verify.mjs", "{repo}"] }],
    "memories": [{
      "type": "convention",
      "title": "Historical rule",
      "content": "The fact the RepoMind arm should retrieve."
    }],
    "allowedChanges": ["src/target.js"]
  }],
  "acceptance": {
    "minRepoMindHiddenPassRate": 1,
    "minHiddenPassRateDelta": 0,
    "minFullHistoryHiddenPassRateDelta": 0,
    "minRetrievalRate": 1,
    "minSessionCommitRate": 1,
    "maxMeanDurationRegressionPercent": 15,
    "maxFullHistoryDurationRegressionPercent": 15,
    "requireEfficiencyImprovement": true,
    "requiredTaskWins": ["example"]
  }
}
```

Keep hidden verifiers outside `baseRepository`; otherwise an agent can inspect
the expected answer. Public checks should establish ordinary repository health
without revealing the historical fact under test.

## Output and strict mode

The output directory contains fresh repositories under `runs/`, isolated
RepoMind databases under `data/`, OpenCode JSONL and stderr under `raw/`, plus
`summary.json` and `summary.md`.

The report includes hidden/public pass counts, duration, tokens, file reads,
tool failures, RepoMind calls, retrieved memories, changed files, and session
cleanup. It also records the RepoMind version, commit, and worktree state, Node
and operating system, runner version, manifest SHA-256, and the resolved base
commit for each task. `--strict` fails on experiment-integrity defects: agent crashes, wrong
base commits, unexpected file changes, cross-arm MCP use, missing RepoMind use,
or sessions left open after cleanup. A hidden-check failure remains a legitimate
task outcome and does not by itself invalidate the experiment.

The report keeps `integrity` and `acceptance` separate. Report schema v4 stores
independent paired comparisons against no-memory and full-history. Acceptance criteria are
declared in the manifest and produce individual measured gates. A configured
task win means that task's RepoMind hidden pass rate must be strictly higher
than its no-memory pass rate. `--require-acceptance` exits unsuccessfully when
criteria are missing or fail; it does not change the meaning of `--strict`.

Paired statistics compare RepoMind with each available baseline for the same
task and repetition. The JSON and Markdown reports include mean and median
deltas, relative change, and RepoMind win/tie/loss counts for hidden/public
success, wall time, input/output tokens, and file reads.

## Aggregate reports

Combine report v4 files from multiple models or operating systems:

```powershell
repomind eval --agent-summary `
  --reports "D:\results\**\summary.json" `
  --output D:\results\aggregate `
  --strict `
  --json
```

The aggregate report hashes every source JSON file and recomputes paired means,
win/tie/loss counts, and approximate 95% intervals from raw runs. `--strict`
fails when any source report failed integrity. It does not reinterpret or
override each experiment's acceptance result.

## Rebuild the shipped suite

The eight-task suite is stored as ordinary templates rather than nested Git
repositories. Generate fresh committed fixture repositories in a new external
directory:

```powershell
node .\benchmarks\agent-suite\create.mjs `
  D:\data\code\project\repomind-test\agent-suite-v2
```

The generator refuses to overwrite an existing directory. It copies the
hidden verifiers outside every base repository, initializes and commits each
base, and writes an absolute verifier path and the actual base commit into
`manifest.json`. It pins Git author and committer timestamps and enforces LF
line endings, so generating the same template in different directories yields
the same base commit IDs. Results remain excluded by the generated `.gitignore`.

`npm run bench:agent-fixtures` rebuilds all eight repositories, verifies their
commit identities, requires every public baseline check to pass, and requires
every external hidden check to fail on the unmodified baseline. CI runs this
validation on Windows and Ubuntu without requiring a model account.

The formal three-repeat v0.6 acceptance run, including its provenance, results,
acceptance gates, and limitations, is documented in
[`agent-benchmark-results-v0.6.md`](agent-benchmark-results-v0.6.md).
The v0.7 three-arm infrastructure acceptance is documented in
[`agent-benchmark-validation-v0.7.md`](agent-benchmark-validation-v0.7.md).
