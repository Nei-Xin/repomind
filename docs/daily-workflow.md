# Daily repository workflow

RepoMind v0.10 adds two pieces beyond the daily `repomind run` command:
reviewable cold-start candidates and persistent run history.

## Bootstrap a cold repository

Initialize the repository once, then generate a candidate bundle outside the
working tree:

```powershell
repomind init --repo D:\path\to\repository --json

repomind bootstrap `
  --repo D:\path\to\repository `
  --output D:\data\code\project\repomind-test\my-project-bootstrap.json `
  --json
```

Generation is read-only with respect to repository memory. It considers the
root `README.md`, root `CONTRIBUTING.md`, up to 50 Markdown ADRs under
`docs/adr`, and the latest 20 Git commit subjects. Large Markdown files over
128 KiB are skipped, code fences are omitted, candidate content is bounded,
and known secret patterns are redacted before the bundle is written.

Every candidate records a deterministic ID, memory type, confidence, tags,
source reference, and source SHA-256. README and contribution candidates are
deliberately lower confidence than ADR candidates. Git history is represented
as one low-confidence candidate rather than twenty assumed facts.

Review the JSON and preview all candidates without storing anything:

```powershell
repomind bootstrap-apply `
  --repo D:\path\to\repository `
  --input D:\data\code\project\repomind-test\my-project-bootstrap.json `
  --json
```

The preview exits unsuccessfully by design because confirmation is still
missing. Apply every reviewed candidate with `--yes`, or apply an explicit
comma-separated subset:

```powershell
repomind bootstrap-apply `
  --repo D:\path\to\repository `
  --input D:\data\code\project\repomind-test\my-project-bootstrap.json `
  --candidate btc_0123456789abcdef01234567,btc_89abcdef0123456789abcdef `
  --yes `
  --json
```

Applying a bundle checks its project ID and re-hashes each selected source.
Changed, deleted, outside-repository, unknown, or cross-project sources are
rejected. Reapplying unchanged candidates is idempotent through RepoMind's
existing memory fingerprint rules.

## Run with bounded layered context

```powershell
repomind run `
  --repo D:\path\to\repository `
  --task "Implement the next repository change" `
  --context-budget 12000
```

The default 12,000-character budget applies only to injected repository
context: the current L3 profile, relevant current L2 narratives, and ranked L1
memories. RepoMind keeps the full current task and fixed Host lifecycle
instructions outside the budget, so context pressure cannot silently shorten
the user's request. The Host report records a summary of what the bounded
context renderer included, clipped, or omitted. The accepted range is
1,000-24,000 characters. Windows additionally rejects a complete rendered Host
prompt above 28,000 characters before process launch because the prompt is
currently passed through argv. The Host additionally models libuv's Windows
argument quoting and rejects a complete quoted command line above the 32,767
character platform boundary.

When this Host-managed run commits successfully, it synchronously rebuilds L2,
attempts L3, and refreshes L4 candidates. No eligible L3 source is a normal
skip. Other maintenance errors are recorded independently and do not undo the
commit or change an otherwise successful run. Partial, failed, and abandoned
runs do not perform derived maintenance. L4 output always remains subject to
human review: automatic approval, export, installation, and execution are
outside the lifecycle.

This behavior is scoped to `repomind run` and the Host-managed library path.
Agent-managed use, `repomind commit`, and `repo_session_commit` still require
explicit `module-rebuild`, `profile-rebuild`, and `skill-rebuild` calls (or the
equivalent MCP tools). Those manual controls remain available for repair,
administration, and deliberate rebuilds.

## Inspect daily runs

Every `repomind run` now creates a `host_runs` record linked to its session.
The record is independent of the artifact directory, so runs using a custom
`--output` remain discoverable.

```powershell
repomind runs --repo D:\path\to\repository --limit 20 --json

repomind runs `
  --repo D:\path\to\repository `
  --status failed `
  --limit 50 `
  --json

repomind run-inspect ses_... `
  --repo D:\path\to\repository `
  --json
```

Run IDs currently equal their RepoMind session IDs. List and detail results
include task, model, lifecycle status, retrieval count, Agent exit and signal,
retrieved memory IDs, duration, input/output tokens, Agent-side RepoMind call
count, output and report paths, failure text, phase timings, redaction counts,
and timestamps. Host-managed reports and persisted metadata also summarize the
bounded context injection and any successful-commit derived maintenance; a
maintenance error is diagnostic state, not a replacement run status.

The host registers the run immediately after session retrieval. Normal exits,
nonzero exits, timeouts, signals, and output setup failures all close both the
session and the run record. A migration upgrades existing repository databases
in place; historical v0.9 sessions do not receive synthetic run records.

## Continuous-use check

A useful real-repository smoke test is:

1. Bootstrap and confirm only facts that are still authoritative.
2. Run one task that changes the repository and commits a clear final summary.
3. Inspect `run.json` to confirm the Session committed, context stayed within
   its configured repository budget, and post-commit maintenance completed or
   recorded an explicit skip.
4. Run a related second task.
5. Inspect the second `run.json` and verify its bounded L3/L2/L1 context and
   prompt behavior reflect the first task's durable results.

The automated `daily-workflow.test.ts` performs this sequence without a model:
it bootstraps a cold repository, commits the first Host-managed run, and proves
the second run receives the first run's exact summary in its injected prompt.
