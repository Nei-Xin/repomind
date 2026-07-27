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
  }]
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
