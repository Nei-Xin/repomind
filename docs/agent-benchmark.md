# Controlled agent benchmark

`repomind eval --agent` measures end-to-end coding-agent task outcomes using
no-memory, raw full-history, and RepoMind arms. It currently supports OpenCode and always creates a controlled
primary agent that cannot delegate work to background agents.
The runner passes OpenCode `--pure`, so globally configured plugins cannot add
unversioned tools, MCP servers, or prompt behavior to the controlled arms.

```powershell
repomind eval --agent `
  --manifest D:\path\to\manifest.json `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --lifecycle host-managed `
  --repeat 3 `
  --output D:\path\to\results `
  --strict `
  --require-acceptance `
  --json
```

Every task and arm is cloned independently from `baseRepository` and checked
out at `baseCommit`. Manifest v2 rotates the three execution orders by
repetition. The RepoMind arm gets an isolated data directory and the manifest
memories. Before execution, the runner performs deterministic derived
maintenance so eligible L2 module narratives and the current L3 profile are
available to the layered Host prompt. A partial or failed seeding-maintenance
result aborts the run instead of silently evaluating an L1-only setup. The
full-history arm receives raw history that can contain obsolete
attempts and noise, but no MCP server. The no-memory arm receives neither.
Manifest v1 remains supported and retains the original alternating two-arm run.

## Lifecycle modes

`--lifecycle agent-managed` is the backward-compatible default. The RepoMind
MCP server is exposed to OpenCode, so session start and commit happen inside
the model loop. Their direct execution time is nested inside Agent wall time.

`--lifecycle host-managed` keeps RepoMind MCP out of the Agent tool set. The
runner starts a session before OpenCode, injects current L3, relevant current
L2, and ranked L1 into the task prompt, runs the Agent, and commits the session
from the host using the Agent's final response and observed command/test
events. Host-owned public and hidden checks run before commit so they can
authoritatively classify clean, recovered, partial, and failed outcomes.
Only public check evidence is persisted; hidden commands and output never
become reusable Memory. Start, Agent, commit, and successful-commit derived maintenance are
timed as separate sequential phases; all four are included in
`totalLifecycleMs`. Checks stay outside the model context, and hidden checks
stay outside stored memory evidence.

Host-managed mode uses the exported `startHostLifecycle`,
`hostManagedPrompt`, `analyzeOpenCodeOutcome`, and `commitHostLifecycle`
functions internally. They are exported from the package root for other
OpenCode hosts to reuse without depending on the benchmark runner.

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
commit for each task. Report v7 records `startMs`, `agentMs`, `commitMs`,
`maintenanceMs`, `totalLifecycleMs`, L1-L3 candidate/eligible/injected IDs and
budgets, prompt SHA-256, outcome quality flags, authoritative verification,
and before/after derived-layer maintenance telemetry. This keeps context,
recovery decisions, and derived refresh cost visible without persisting the
full rendered prompt.
`--strict` fails on experiment-integrity defects: agent crashes, wrong base
commits, unexpected file changes, cross-arm MCP use, missing or failed
RepoMind lifecycle operations, a committed Host run that did not attempt
maintenance, partial/failed maintenance, phase totals that do not reconcile,
or sessions left open after cleanup. A hidden-check failure remains a legitimate
task outcome and does not by itself invalidate the experiment.

The report keeps `integrity` and `acceptance` separate. Report schema v7 stores
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

Combine report v4-v7 files from multiple models or operating systems:

```powershell
repomind eval --agent-summary `
  --reports "D:\results\**\summary.json" `
  --output D:\results\aggregate `
  --strict `
  --json
```

Aggregate report v2 hashes every source JSON file, records its schema version,
and recomputes paired means, win/tie/loss counts, and approximate 95% intervals
from raw runs. Context, maintenance, and quality coverage distinguish `full`,
`unavailable`, `notApplicable`, and `missing`; an old report's absent field is
never treated as a zero measurement. `--strict` fails when any source report
failed integrity. It does not reinterpret or override acceptance.

## Offline phase profiles

Attribute the runtime and token cost of an existing report-v4 through report-v7 run without
calling the model again:

```powershell
repomind eval --agent-profile `
  --report D:\results\summary.json `
  --output D:\results\profile `
  --strict `
  --json
```

The command reads the source report and its sibling `raw/` directory by
default. Use `--raw <dir>` if the JSONL files were moved. It writes
`profile.json` and `profile.md`, hashes the source report, and validates every
raw file against the report's turn, token, and tool counts.

Profile v2 reports four different boundaries:

- direct RepoMind tool time from each MCP tool's own start/end timestamps;
- the complete model cycle containing session start, session commit, or another
  RepoMind tool, plus the immediately following model cycle;
- paired end-to-end deltas in wall time, observed event time, process overhead,
  turns, tool calls, and tokens against no-memory and full-history.
- Host-managed start, Agent, commit, maintenance, L1-L3 injection, quality,
  maintenance status, and telemetry coverage without pretending these are MCP calls.

Direct tool time is the storage/MCP execution cost. Surrounding cycles also
contain model and host orchestration time, so they are diagnostic windows, not
independent additive causal estimates. Paired end-to-end deltas remain the
authoritative total cost.

## Cross-Session learning

Use `repomind eval --agent-cross-session` when the treatment under test is
knowledge learned by an earlier real Agent Session rather than manifest-seeded
Memory. It compares shared and per-stage-isolated database chains while every
stage starts in a fresh checkout with the same projectId. See
[`cross-session-agent-benchmark.md`](cross-session-agent-benchmark.md) for the
manifest, fixture generator, strictness rules, commands, and interpretation.

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

## Accept the daily `repomind run` path

The three-arm benchmark answers comparative research questions. Use the
dedicated host-run acceptance harness to verify the daily product path across
all eight tasks:

```powershell
npm run bench:host-run -- `
  --workspace D:\data\code\project\repomind-test\host-run-acceptance-v0.9 `
  --model cliproxyapi/gpt-5.6-terra `
  --strict
```

The workspace must not exist. The command rebuilds the fixed-commit suite,
then clones every task again under `results/runs`. Each clone gets its own
RepoMind database and manifest memory before the harness invokes the same
`runOpenCodeHost` implementation used by `repomind run`.

For every task, acceptance requires at least one retrieved memory, zero Agent
RepoMind calls, a clean Agent exit, a committed session, passing public and
external hidden checks, no open sessions, only allowlisted file changes, and
present, parseable, secret-scanned run artifacts. Results are written to
`results/summary.json` and `results/summary.md`. `--strict` returns a nonzero
exit code when any task or integrity requirement fails. Omitting `--model`
uses OpenCode's configured default model.

The formal v0.8 host-managed three-arm run, including its provenance, lifecycle
costs, confidence intervals, and passed outcome acceptance, is documented in
[`agent-benchmark-results-v0.8.md`](agent-benchmark-results-v0.8.md). The
earlier formal v0.7 agent-managed run remains preserved as a valid negative
result in
[`agent-benchmark-results-v0.7.md`](agent-benchmark-results-v0.7.md). The
deterministic v0.7 infrastructure acceptance is separate and documented in
[`agent-benchmark-validation-v0.7.md`](agent-benchmark-validation-v0.7.md).
The earlier v0.6 two-arm result is preserved in
[`agent-benchmark-results-v0.6.md`](agent-benchmark-results-v0.6.md).
