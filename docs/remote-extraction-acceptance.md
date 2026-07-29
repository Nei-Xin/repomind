# v0.16 remote extraction acceptance

The v0.16 acceptance runner evaluates the safe extraction boundary and one
configured OpenAI-compatible provider against a fixed RepoMind commit. It uses
real Session, Evidence, validation, deduplication, SQLite, FTS, and Audit paths.
The deterministic `--mock` mode makes the harness itself reproducible without
network access or credentials.

## Dataset

`benchmarks/remote-extraction/dataset.json` contains nine controlled Sessions:

- storage transaction architecture;
- MCP stdout/JSON-RPC convention;
- two-phase extraction decision;
- validated-output solution;
- remote-provider privacy risk;
- one confidence-policy fact repeated in an independent Session;
- a cosmetic task with no durable knowledge;
- a prompt-injection task that must remain untrusted data.

Each positive scenario defines allowed L1 types and bounded concept labels.
The fixture contains no API credential and is hashed into every report.

## Run

First validate the harness without a provider. The workspace must not already
exist:

```powershell
npm run bench:remote-extraction -- --repo . `
  --workspace D:\data\code\project\repomind-test\v016-remote-mock `
  --commit HEAD `
  --mock
```

For live acceptance, provide credentials only in the invoking process:

```powershell
$env:REPOMIND_EXTRACTION_PROVIDER = "openai-compatible"
$env:REPOMIND_EXTRACTION_BASE_URL = "https://provider.example/v1"
$env:REPOMIND_EXTRACTION_API_KEY = Read-Host -MaskInput "API key"
$env:REPOMIND_EXTRACTION_MODEL = "model-id"
$env:REPOMIND_EXTRACTION_TIMEOUT_MS = "120000"

npm run bench:remote-extraction -- --repo . `
  --workspace D:\data\code\project\repomind-test\v016-remote-live `
  --commit HEAD

Remove-Item Env:REPOMIND_EXTRACTION_API_KEY
```

Do not put the key in a command argument, `.env` file, fixture, shell history,
or report. The runner reports only whether a credential was configured. Before
writing JSON, it refuses output containing the in-process credential value.

## Gates

Formal live acceptance requires:

- at least 80% positive-scenario recall and 75% candidate precision;
- 100% empty/injection accuracy;
- 100% current-Session Evidence binding and extraction Audit provenance;
- the repeated candidate to deduplicate;
- no forbidden prompt-injection content;
- malformed output, fabricated Evidence, and cancellation probes to reject
  with zero writes;
- extraction P95 below 120 seconds and provider-reported token usage;
- a clean source worktree, SQLite integrity, no foreign-key violations, and no
  open Sessions.

The JSON report retains per-scenario types, titles, counts, latency, usage,
fixed-commit provenance, dataset/script hashes, and gate outcomes. It does not
retain API keys, raw provider responses, or full Evidence bodies. The Markdown
report is a concise review artifact derived from the same run.

## Interpretation

Passing proves that one named model and endpoint met these gates on this fixed
controlled dataset. It does not establish provider confidentiality, universal
model quality, pricing, or cross-Agent usability. Human review and a separate
Claude Code/OpenCode acceptance remain release requirements. The formal v0.16
result records both the live harness and the completed cross-Agent acceptance in
[`remote-extraction-acceptance-v0.16.md`](remote-extraction-acceptance-v0.16.md).
