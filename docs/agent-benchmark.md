# Controlled agent benchmark

`repomind eval --agent` measures end-to-end coding-agent task outcomes with and
without RepoMind. It currently supports OpenCode and always creates a controlled
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
out at `baseCommit`. Odd repetitions run no-memory before RepoMind; even
repetitions reverse the order. The RepoMind arm gets an isolated data directory
and the manifest memories. The no-memory arm has no RepoMind MCP configuration.

## Manifest

Commands are represented as a program plus an argument array. They are never
accepted as shell command strings. `{repo}` in a check command or argument is
replaced with the fresh clone path.

```json
{
  "version": 1,
  "name": "example suite",
  "tasks": [{
    "id": "example",
    "baseRepository": "./base",
    "baseCommit": "HEAD",
    "prompt": "Implement the requested change.",
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
    "minRetrievalRate": 1,
    "minSessionCommitRate": 1,
    "maxMeanDurationRegressionPercent": 15,
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
cleanup. `--strict` fails on experiment-integrity defects: agent crashes, wrong
base commits, unexpected file changes, cross-arm MCP use, missing RepoMind use,
or sessions left open after cleanup. A hidden-check failure remains a legitimate
task outcome and does not by itself invalidate the experiment.

The report keeps `integrity` and `acceptance` separate. Acceptance criteria are
declared in the manifest and produce individual measured gates. A configured
task win means that task's RepoMind hidden pass rate must be strictly higher
than its no-memory pass rate. `--require-acceptance` exits unsuccessfully when
criteria are missing or fail; it does not change the meaning of `--strict`.

Paired statistics compare the two arms for the same task and repetition. The
JSON and Markdown reports include mean and median deltas, relative change, and
RepoMind win/tie/loss counts for hidden/public success, wall time, input/output
tokens, and file reads.

## Rebuild the shipped suite

The four-task suite is stored as ordinary templates rather than nested Git
repositories. Generate fresh committed fixture repositories in a new external
directory:

```powershell
node .\benchmarks\agent-suite\create.mjs `
  D:\data\code\project\repomind-test\agent-suite-v2
```

The generator refuses to overwrite an existing directory. It copies the
hidden verifiers outside every base repository, initializes and commits each
base, and writes an absolute verifier path into `manifest.json`. Results remain
excluded by the generated `.gitignore`.
