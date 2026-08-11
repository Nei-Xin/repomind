# Cross-session Agent benchmark

The cross-session benchmark answers a narrower question than a normal coding
benchmark:

> When a new Agent session continues work on an evolving repository, does the
> context learned by RepoMind in earlier sessions improve correctness or reduce
> the work needed to reach the same result?

It runs real OpenCode processes against real Git repositories. The comparison
is paired: `shared` and `isolated` receive the same model, prompts, initial
repository commit, checks, and RepoMind project identity. The intended
treatment is whether RepoMind's database survives from one stage to the next.
Because each arm makes independent model calls, their produced checkpoints can
still differ; sequence design and report review must control that confound.

## Experimental unit

A manifest contains one or more sequences. Each sequence has at least two
ordered stages:

- A producer stage creates useful evidence, decisions, conventions, or failure
  knowledge.
- One or more transfer stages ask a fresh Agent session to do work for which
  that prior knowledge may matter.

For every sequence and repetition, the runner creates one random `projectId`
and uses it for every stage in both arms. A new `projectId` is used for the next
repetition, so learning cannot leak between repetitions.

| Property | `isolated` | `shared` |
| --- | --- | --- |
| Model, prompt, checks, and initial base commit | Same | Same |
| `projectId` within the paired repetition | Same | Same |
| Parentless checkpoint handoff | Current tree preserved between stages | Current tree preserved between stages |
| Stage worktree | Fresh one-commit checkout | Fresh one-commit checkout |
| RepoMind data directory | New for every stage | Reused by all stages |
| Expected transfer-stage recall | Zero | Prior L1/L2/L3 may be injected |

The arm order alternates by repetition. Odd repetitions run isolated first;
even repetitions run shared first. This reduces, but cannot eliminate, bias
from model-service or machine drift over time.

## Stage lifecycle

Each stage follows this sequence:

1. Initialize an empty Git repository and fetch only the configured
   `baseCommit`, or only the previous stage's checkpoint commit.
2. Check out a detached, clean worktree and write the same RepoMind project
   marker used by the paired episode.
3. Start a Host-managed RepoMind session and render budgeted L3, L2, and L1
   context before OpenCode starts.
4. Run OpenCode with the stage prompt. The Agent is explicitly prevented from
   managing RepoMind itself.
5. Run public and external hidden checks as Host-owned authoritative checks.
6. Close the RepoMind session according to the Agent event stream and check
   outcome. Successful committed sessions automatically maintain L2 and L3 and
   refresh L4 candidates; L4 remains subject to human approval.
7. Write the stage tree as a parentless evaluation checkpoint. The next stage
   fetches only this root snapshot into a new repository, never the previous
   worktree or its ancestry.

Hidden failures are legitimate task outcomes. They may cause that Host session
to close without a successful commit or derived maintenance, but they do not
by themselves mean that the experiment was malformed. Hidden command and
output details are not persisted as RepoMind evidence, so a failed hidden
verifier cannot teach the next stage its answer. Public check evidence can be
persisted. Check details remain available in the local evaluation report for
diagnosis.

The checkpoint and the RepoMind commit are different concepts. The checkpoint
advances the code state used by the next stage in that arm. The RepoMind commit
decides whether evidence from the stage is trustworthy enough to become
memory. Keeping these decisions separate lets the experiment preserve a real
repository progression without turning a failed verification into high-quality
memory. A failed stage is still checkpointed; in a sequence with more than two
stages, later tasks may therefore inherit its code changes even though they do
not inherit trusted memory from it.

## Why use fresh snapshots and checkpoints

Reusing one worktree would mix memory transfer with untracked files, tool
caches, editor state, and other process residue. A fresh one-commit repository
makes the stage checkout boundary observable and prevents ordinary Git history
from carrying a producer-only fact into the consumer.

At the same time, starting every stage from the original commit would be
unrealistic. Software evolves between user sessions, so stage `N + 1` sees the
tree produced by stage `N` in the same arm. The checkpoint has no parent:
correctness-only facts cannot leak through ancestry, while efficiency tasks
must retain an independent recovery path in the current tree. Each shipped
producer has one allowlisted transition, deletion of a fixed file, so paired
arms that pass the producer check enter the consumer with the same intended
tree change.

## Shipped six-sequence suite

`benchmarks/cross-session-agent-suite` contains a small dependency-free Node.js
repository and six independent two-stage sequences:

| Cohort | Sequence | Knowledge under test | Primary interpretation |
| --- | --- | --- | --- |
| correctness | `corr-release-command` | Last approved release command and ordering | Hidden-check accuracy |
| correctness | `corr-stale-endpoint` | Current production route versus two obsolete routes | Hidden-check accuracy |
| correctness | `corr-error-contract` | Error class, code, cause, and successful behavior | Hidden-check accuracy |
| efficiency | `eff-dependency-boundary` | Built-in dependency and digest output convention | Time, tokens, and reads at equal accuracy |
| efficiency | `eff-delivery-failure` | Two failed concurrency fixes and accepted retry behavior | Time, tokens, and reads at equal accuracy |
| efficiency | `eff-gateway-history` | Nimbus retry-header contract split across runtime and telemetry evidence | Time, tokens, and reads at equal accuracy |

The correctness facts appear in the producer user's message and final handoff,
but not in the base Git repository or consumer prompt. This models a real
production constraint stated once in an earlier Session. Efficiency facts are
recoverable from indirect evidence that remains in the parentless current tree:

- digest behavior requires joining compatibility vectors with the package's
  zero-dependency boundary;
- delivery behavior requires tracing how the current worker and its immutable
  caller-contract tests distinguish a duplicate and schedule a same-ID retry
  after failure;
- Nimbus behavior requires joining runtime policy limits with the telemetry
  reader's wire-header names and conversions.

The isolated Agent can perform that investigation without sibling runs,
artifacts, hidden verifiers, or Git ancestry. The shared Host can instead
supply the producer's exact handoff and avoid repeated investigation.

Every producer only removes its named marker or review record. Every consumer
performs a real code or package change and is checked by a read-only external
verifier. The verifier output is not persisted as Memory Evidence.

The generator creates a real repository with a deterministic initial commit.
It writes absolute paths for the base repository and hidden verifier into four
generated manifests and refuses to overwrite an existing directory:

- `manifest.json`: all six sequences and the backward-compatible default path;
- `manifest.correctness.json`: the three correctness sequences;
- `manifest.efficiency.json`: the three efficiency sequences;
- `manifest.cross-agent.json`: two bidirectional Claude/OpenCode transfer
  sequences with an explicit runner and model on every stage.

The generator accepts `--opencode-model <id>` and `--claude-model <id>`.
Their defaults are `cliproxyapi/gpt-5.6-luna` and `gpt-5.6-luna`, respectively.
The selected values are materialized into `manifest.cross-agent.json`, so an
archived manifest records the exact model assigned to each Agent host.

Before this expansion, `manifest.json` contained only the Nimbus sequence. Its
path remains compatible, but its meaning has migrated to the complete suite.
Use `manifest.efficiency.json` to reproduce the earlier single-purpose style.

Validate the templates without calling a model:

```powershell
npm.cmd run bench:cross-session-agent-fixtures
```

The validator proves that:

- generation and Git initialization succeed;
- the initial commit is reproducible in different directories;
- the generated worktree is clean and matches `baseCommit`;
- path placeholders became absolute paths and model placeholders became the
  selected model IDs;
- hidden verifiers live outside the Agent repository;
- root Vitest cannot collect the template's Node smoke test;
- correctness facts are absent from the base repository and consumer prompts;
- every efficiency consumer prompt omits the recovered contract, while its
  immutable code/config evidence remains in the current tree after the
  producer's single-file deletion;
- every public check passes on the baseline;
- every hidden check fails on the unsolved baseline and passes in its own
  known-positive two-stage clone;
- producer and consumer changes exactly match their respective allowlists;
- a second attempt to use the same output directory is rejected.

The repository also has a deterministic simulated end-to-end cross-Agent test
in `tests/cross-session-eval.test.ts` using local test adapters. That proves
stage dispatch, model selection, checkpoint transfer, shared/isolated database
topology, reporting, and acceptance wiring. It does not call Claude or
OpenCode providers and therefore cannot replace a real mixed-Agent result or
demonstrate a model-level benefit.

## Run the formal 120-call Luna experiment

Prerequisites are Node.js 22.5 or newer, Git, a built RepoMind checkout, and the
Agent CLI used by the manifest. OpenCode examples below use
`cliproxyapi/gpt-5.6-luna`; Claude Code stages use their Claude-compatible model
identifier, for example `gpt-5.6-luna`.

```powershell
npm.cmd install
npm.cmd run build
opencode.cmd --version

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$suite = "D:\data\code\project\repomind-test\cross-session-suite-$stamp"
$results = Join-Path $suite "results-luna-r5"

node .\benchmarks\cross-session-agent-suite\create.mjs $suite

node .\dist\cli\index.js eval `
  --agent-cross-session `
  --manifest (Join-Path $suite "manifest.json") `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --repeat 5 `
  --max-memories 5 `
  --context-budget 12000 `
  --timeout 600000 `
  --output $results `
  --strict `
  --require-acceptance `
  --json
```

The default manifest contains six sequences. With two arms, two stages, and
five repetitions, the command starts exactly
`6 x 2 x 2 x 5 = 120` real Agent processes: 60 producer calls and 60 consumer
calls. The runner is sequential, so allow several hours and retain the whole
result directory.

Each of those 120 entries is an experimental stage. The Host permits up to
three process attempts. A fresh retry requires an explicit TLS,
connection-reset, network-timeout, HTTP 429, or HTTP 5xx signal before any
model or repository activity: input/output tokens, tools, commands, and
RepoMind calls must all be zero, and the Git snapshot must be unchanged. An
upstream HTTP/2 stream failure may instead resume the same provider session
after resume-safe local read/edit tools, provided no shell command or RepoMind
activity occurred. Abort, signal, and Host timeout are never retried. Business
failures and verifier failures are never retried. `summary.json` reports stage
count, process attempts, retries, retried stages, and exhausted stages
separately; all retry delay and attempt time remain included in the duration
metrics, while every attempt's redacted artifacts remain under the stage
artifact directory.

To run only one 60-call cohort, replace `manifest.json` with
`manifest.correctness.json` or `manifest.efficiency.json` and use a different
empty result directory. The cohort manifests keep correctness and efficiency
acceptance claims separate; the full manifest supplies the single-command
120-call experiment.

## Run the formal 40-call cross-Agent experiment

The cross-Agent manifest measures whether RepoMind knowledge survives a change
of Agent host, rather than only a fresh session of the same host. Both
executables must be available on `PATH`. Generate a fresh suite and run the
two sequences five times with this exact command:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$suite = "D:\data\code\project\repomind-test\cross-agent-suite-$stamp"
$results = Join-Path $suite "results-cross-agent-luna-r5"

node .\benchmarks\cross-session-agent-suite\create.mjs $suite `
  --opencode-model cliproxyapi/gpt-5.6-luna `
  --claude-model gpt-5.6-luna

node .\dist\cli\index.js eval `
  --agent-cross-session `
  --manifest (Join-Path $suite "manifest.cross-agent.json") `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --repeat 5 `
  --max-memories 5 `
  --context-budget 12000 `
  --timeout 600000 `
  --output $results `
  --strict `
  --require-acceptance `
  --json
```

The two explicit directions are:

- `xagent-claude-to-opencode-endpoint`: Claude records the production endpoint
  decision, then a fresh OpenCode session implements it;
- `xagent-opencode-to-claude-parser`: OpenCode records the parser error
  contract, then a fresh Claude session implements it.

Every producer and consumer stage declares its own `runner` and `model`; the
cross-Agent result does not depend on command-level inheritance. Two
sequences, two arms, two stages, and five repetitions start exactly
`2 x 2 x 2 x 5 = 40` real Agent calls.

A real run still depends on the configured endpoint, authentication, and
provider availability. The current probe of the Claude-compatible
`gpt-5.6-luna` endpoint returned HTTP 503, so no real Claude/OpenCode outcome
is claimed from that probe. Re-run the command after the provider is healthy
and retain its result directory before interpreting cross-Agent effectiveness.

Use a new `$suite` path for every formal run. The fixture generator refuses any
existing target, and the evaluation runner refuses a non-empty result
directory. This prevents accidental mixing or overwriting of evidence.

If OpenCode is not discoverable by name, add, for example:

```powershell
  --runner-executable C:\path\to\opencode.cmd
```

Do not redirect only the console output and discard the result directory.
`summary.json`, per-run reports, and JSONL artifacts are the evidence needed to
audit the result.

## Manifest schema

The generated example is directly usable. A minimal hand-authored manifest for
a real repository has this shape:

```json
{
  "version": 1,
  "name": "billing retry policy transfer",
  "sequences": [{
    "id": "billing-retry",
    "baseRepository": "D:\\code\\billing-service",
    "baseCommit": "4a62c4f7d926f46b1d6f6e6bc1c841abffac8f9e",
    "stages": [{
      "id": "producer",
      "prompt": "Complete the migration and preserve durable constraints in the handoff.",
      "publicChecks": [{ "command": "npm.cmd", "args": ["test"] }],
      "hiddenChecks": [{
        "command": "node",
        "args": ["D:\\eval-private\\verify-producer.mjs", "{repo}"],
        "timeoutMs": 120000
      }],
      "allowedChanges": ["src/migration.ts"]
    }, {
      "id": "consumer",
      "prompt": "Implement the follow-up behavior using current repository knowledge.",
      "publicChecks": [{ "command": "npm.cmd", "args": ["test"] }],
      "hiddenChecks": [{
        "command": "node",
        "args": ["D:\\eval-private\\verify-consumer.mjs", "{repo}"]
      }],
      "allowedChanges": ["src/retry.ts", "test/retry.test.ts"]
    }]
  }],
  "acceptance": {
    "minSharedTransferHiddenPassRate": 0.8,
    "minTransferHiddenPassRateDelta": 0.2,
    "minSharedRecallRate": 0.8,
    "maxIsolatedRecallRate": 0,
    "minSharedCommitRate": 0.8,
    "maxMeanDurationRegressionPercent": 25
  }
}
```

`baseRepository` may be relative to the manifest; the loader resolves it to an
absolute path. Use an absolute path in archived manifests when portability is
less important than unambiguous provenance. For formal results, pin a full
commit hash instead of `HEAD`.

Stage and sequence IDs must start with a lower-case letter or digit and may
then contain lower-case letters, digits, `.`, `_`, or `-`. Each sequence needs
2-20 stages. Public and hidden check arrays must both be non-empty.

Each stage may set `runner` to `opencode` or `claude` and may set its own
`model`. Omitted values inherit the command-level defaults. A stage that
switches away from the preceding stage's runner must declare an explicit model
so provider-specific model names cannot silently leak across Agent hosts:

```json
{
  "id": "consumer",
  "runner": "claude",
  "model": "gpt-5.6-luna",
  "prompt": "Implement the follow-up using prior repository knowledge.",
  "publicChecks": [{ "command": "npm.cmd", "args": ["test"] }],
  "hiddenChecks": [{ "command": "node", "args": ["D:\\eval-private\\verify.mjs", "{repo}"] }]
}
```

`--runner-executable` applies only to the command-level default runner. In a
mixed-runner manifest, every non-default Agent executable must be discoverable
on `PATH`. Cross-session Claude stages use permission bypass only because the
runner creates and owns a fresh disposable checkout for every stage; daily
`repomind run --runner claude` does not use that policy.

Checks are a program and argument array, not a shell command string. This
avoids platform-dependent shell parsing. Every `{repo}` substring in a check
program or argument becomes the fresh stage checkout path. `timeoutMs` is per
check and may be 1-600,000 milliseconds.

`allowedChanges` is optional. When present, every path reported by
`git status --short` after the Agent run must be listed. Include legitimate
test and generated-file edits, but do not use a broad allowlist merely to make
strict mode pass.

## Designing a real transfer sequence

Choose a producer event that a real team would want the next session to
remember. Good candidates include a rejected implementation and its reason, a
non-obvious module move, a validated command, a production compatibility rule,
or a design decision whose source is later removed or buried in history.

Then choose a consumer task that is independently useful. It should benefit
from the producer knowledge without literally asking the Agent to repeat the
producer answer. Make the producer transition as deterministic as possible,
use checks and `allowedChanges` to constrain it, and compare the two arms'
checkpoint trees before interpreting transfer results. Do not add different
hints to the shared prompt.

Use public checks for ordinary repository health and the visible contract.
Place hidden verifiers outside `baseRepository`, and keep their paths and code
out of all Agent prompts and tracked files. In a correctness-transfer task, the
contract under test may intentionally appear in the producer user's message;
it must not be repeated in the consumer prompt or current repository. In an
efficiency task, it must remain recoverable from indirect code, configuration,
fixtures, or callers in the current parentless tree.
A verifier must be read-only, deterministic, return zero only on success, and
emit enough output for a human to diagnose infrastructure failures without
revealing hidden-only details to a later Agent.

Before spending model calls, perform these checks:

1. Confirm the base commit is clean and reproducible.
2. Run every public check on the intended stage state.
3. Prove each hidden verifier fails on an unsolved state and passes on a
   separately prepared known-good state.
4. Confirm the producer can create useful committed RepoMind evidence.
5. Predeclare whether the sequence measures retained correctness or recovery
   efficiency. Efficiency sequences need a realistic no-memory recovery route;
   correctness sequences need a durable fact supplied only in the producer.
6. Run a one-repetition smoke test, inspect artifacts, then start the formal
   repeat count in a new directory.

Use at least five repetitions for development comparisons. Ten or more and
multiple sequences are preferable before making a strong effectiveness claim.

## Integrity versus acceptance

`--strict` validates whether the experiment can be trusted. It covers missing
or duplicate runs, wrong commits, dirty initial checkouts, unexpected changes,
Agent crashes or protocol violations, broken checkpoint chains, incorrect
shared/isolated database topology, inconsistent context telemetry, leaked
RepoMind calls from the Agent, checks that could not execute, and lifecycle
resources left open. A hidden assertion failure is a measured outcome, not an
integrity failure. A successful committed session must also report the
expected derived maintenance; an unsuccessful closed session may legitimately
skip it.

`--require-acceptance` validates whether the configured product goals were
met. It exits unsuccessfully when acceptance is absent or any configured gate
fails. The supported gates are:

| Manifest field | Measurement |
| --- | --- |
| `minSharedTransferHiddenPassRate` | Minimum shared hidden pass rate after stage 1 |
| `minTransferHiddenPassRateDelta` | Minimum shared minus isolated hidden pass-rate delta |
| `minSharedRecallRate` | Minimum shared transfer stages with injected L1, L2, or L3 |
| `maxIsolatedRecallRate` | Maximum isolated transfer stages with injected records |
| `minSharedCommitRate` | Minimum shared transfer stages whose Host Commit completed and closed the Session, regardless of task success |
| `maxMeanDurationRegressionPercent` | Maximum shared Host-lifecycle slowdown versus isolated |
| `maxMeanInputTokenRegressionPercent` | Compatibility gate for maximum shared increase in uncached Agent input tokens versus isolated |
| `minInputTokenPairedWinRate` | Compatibility gate for paired wins in uncached Agent input tokens |
| `maxMeanTotalPromptTokenRegressionPercent` | Maximum increase in shared total prompt tokens (`input + cache read + cache write`) versus isolated |
| `minTotalPromptTokenPairedWinRate` | Minimum fraction of paired transfer stages where shared uses fewer total prompt tokens |
| `minAgentDurationPairedWinRate` | Minimum fraction of paired transfer stages where shared Agent execution is faster |
| `minComparablePairCoverageRate` | Minimum fraction of complete transfer pairs where both arms pass every public and hidden check and are eligible for efficiency metrics |

Use both flags for a formal run. Passing strict mode without acceptance means
the experiment was well formed, not that RepoMind helped. Passing acceptance
without strict mode leaves the claimed improvement unsupported by a valid run.

The correctness and cross-Agent manifests intentionally have no duration
gate: unequal correctness is not an efficiency comparison. The correctness
manifest requires a `0.3` shared-minus-isolated hidden-rate delta. The
efficiency manifest requires no hidden regression,
100% comparable-pair coverage, at most 10% mean Host-lifecycle duration
regression, at most 10% mean total-prompt-token regression, and at least `0.6`
paired win rates for both total prompt tokens and Agent duration. Total prompt
tokens include uncached input, cache reads, and cache writes, so provider cache
allocation cannot reverse the main work-volume result. Raw input and both cache
components remain separate diagnostics; monetary cost still requires applying
the provider/model-specific price to each component. These are
non-brittle thresholds grounded in the real Luna R5 Nimbus result: hidden
checks passed in 100% of both arms, shared Agent duration was 19.693% lower
with 5/5 paired wins, and shared input tokens were 25.574% lower with 5/5
paired wins. The ceilings tolerate normal run-to-run variance while the paired
gates still require a majority benefit.

The combined manifest uses a `0.15` hidden-rate delta but intentionally does
not mix in an efficiency gate across correctness and efficiency cohorts. Use
`manifest.efficiency.json` for efficiency claims. These are preregistered
outcome gates, not integrity checks. Before making a causal claim, also require
every producer check to pass and paired producer checkpoint trees to match.
The strict report enforces both conditions automatically.

## Results and telemetry

The result directory contains:

```text
results-luna-r5/
|-- artifacts/        OpenCode events, stderr, and Host run reports
|-- data/             shared episode databases and isolated stage databases
|-- runs/             one fresh Git checkout per arm/stage/repetition
|-- summary.json      complete machine-readable report
`-- summary.md        concise human-readable comparison
```

`summary.json` records provenance including RepoMind version and commit,
worktree dirty state, Node/OS/runner versions, manifest SHA-256, and resolved
sequence base commits. Every stage run records project/data/repository paths,
the requested/base/previous/checkpoint commits, clean-start state, changed and
unexpected files, public and hidden outcomes, verification time, lifecycle
status and phase durations, maintenance status, memory-store counts, Agent
exit state, and artifact paths.

Agent telemetry includes turns, input/output/reasoning/cache tokens, tool-call
counts, failed tools and commands, file reads, repeated reads, and prohibited
RepoMind calls. Context telemetry separately records L1/L2/L3 records supplied,
eligible, injected, truncated, and omitted; their ordered IDs; allocated,
source, and rendered characters; total context/prompt characters; unused
budget; and a SHA-256 of the exact prompt without storing the prompt body in
the summary.

The transfer summary excludes stage 1 because no earlier session exists to
recall. It reports recall, hidden pass, and commit rates for later stages. The
paired comparison reports shared and isolated means, shared-minus-isolated
deltas, relative deltas, and approximate 95% intervals. Token, duration, and
file-read efficiency metrics include only comparable pairs where both arms
passed every public and hidden check; the report separately shows eligible,
excluded, and total pairs plus the coverage rate. Correctness and diagnostic
metrics still use every complete pair. Lower-is-better metrics receive shared
win/tie/loss counts. Injected-record and context-character metrics are
diagnostic, so their pairs are reported as ties even when the numeric delta is
nonzero.

Interpret these signals together:

- Higher shared hidden success with a positive paired delta supports a
  correctness benefit.
- Equal hidden success with fewer shared tokens, reads, or time supports an
  efficiency benefit.
- Injection without an outcome or efficiency change proves recall occurred,
  not that the Agent used it.
- No shared injection points first to retrieval, quality gating, or L1-L3
  maintenance rather than model capability.
- Low shared commit rate means Host lifecycle closure is being lost, so later
  learning opportunities may be unavailable; diagnose it before claiming a
  closed loop. This metric does not require the public or hidden checks to pass.

## Limitations

This is a controlled evaluation, not a causal proof from one run. Agent output,
provider load, cache behavior, and repository tool choices remain stochastic.
Approximate confidence intervals are weak with small samples.

The arms share a project identity but not a database in isolated stages. This
tests within-sequence learning only; it does not test transfer across unrelated
projects or across repetitions. Recall means that at least one record was
injected, not that it was relevant or followed.

Fresh stage repositories remove worktree residue and fetch only a parentless
snapshot, so earlier Git ancestry is not an allowed recovery channel. The
isolated efficiency arm instead investigates evidence deliberately retained in
the current tree. If that evidence is absent or an isolated run fails the
contract, the pair is excluded from efficiency metrics and reduces comparable
coverage.

The runner executes the producer independently in each arm. It verifies both
checkpoint chains, but it does not require their tree hashes to match. A broad
producer task can therefore create a code-state confound before the consumer
stage. Prefer a narrow, uniquely verified producer transition, or add a
separate analysis that rejects non-equivalent producer trees.

Because failed stages are also checkpointed, one failure can change the code
state of every later stage in that arm. Use a two-stage sequence when measuring
one transfer, or predefine how cascading failures will be analyzed in a longer
sequence.

The dedicated OpenCode Host sets `external_directory` to `deny`, so a normal
controlled Agent cannot read sibling runs, output artifacts, data directories,
the base fixture, or the hidden verifier through OpenCode tools. This is a
Host-tool permission boundary, not an OS or container sandbox. The benchmark's
claims therefore apply to non-adversarial controlled evaluation. Use an
isolated OS account or container when hidden-test secrecy must withstand an
adversarial process.

Finally, `allowedChanges`, checks, and acceptance thresholds encode the
experiment author's assumptions. Review them before every formal run, archive
the generated manifest and result directory, and report negative or neutral
results alongside positive ones.
