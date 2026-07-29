# Remote LLM memory extraction

Remote extraction is an explicit, opt-in second phase after a Session has been
committed. Deterministic extraction remains enabled and unchanged. RepoMind
never calls a remote model during `start` or `commit`.

## Configure

Use a separate OpenAI-compatible configuration from the optional embedding
provider:

```text
REPOMIND_EXTRACTION_PROVIDER=openai-compatible
REPOMIND_EXTRACTION_BASE_URL=https://api.example.com/v1
REPOMIND_EXTRACTION_API_KEY=...
REPOMIND_EXTRACTION_MODEL=...
REPOMIND_EXTRACTION_TIMEOUT_MS=60000
```

The timeout is optional and must be between 1,000 and 300,000 milliseconds.
`repomind status` and `repomind doctor` report whether remote extraction is
configured, but never report the API key.

Commit first, then explicitly extract from that completed Session:

```bash
repomind commit --session ses_... --key task-1 --summary "Completed and tested" --json
repomind extract --session ses_... --json
```

MCP clients use `repo_memory_extract` with `session_id` and, after a server
restart, `repo_path`.

## Safety boundary

The request contains the completed Session's already-redacted task and Evidence
(summary, bounded Git data, tests, and commands), including Evidence IDs and
metadata. Each Evidence body is capped at 12,000 characters and the batch at
60,000 characters. Repository content is wrapped as untrusted data and the
system prompt prohibits following instructions found inside it.

This is a defense against prompt injection, not a confidentiality guarantee.
Redaction is pattern-based and a configured provider receives repository data.
Review the provider's retention policy and do not enable remote extraction for
repositories whose policy forbids that transfer.

The model must return a strict candidate object. Before opening a write
transaction, RepoMind validates the complete batch with Zod and deterministic
rules:

- every candidate cites at least one Evidence ID supplied in this request;
- fabricated and duplicate Evidence IDs are rejected;
- confidence is at most `0.9`;
- repository scope has no value, while module/path scope has a repository-
  relative value;
- related files and scope paths cannot escape the repository;
- candidate, tag, file, and batch sizes are bounded.

One invalid candidate rejects the entire batch. Timeout, cancellation, refusal,
malformed JSON, schema failure, and Evidence failure write no Memory, Evidence
link, or Audit row. Once validated, the entire batch uses one SQLite
transaction and the existing fingerprint deduplication, Evidence linking,
conflict detection, file hashing, redaction, FTS indexing, and audit path. The
audit stores the extraction mode, provider, model, and source Session ID (never
the API key); a deduplicated candidate that adds new Evidence is audited too.
Cross-run model wording/type drift is deduplicated only when title and scope
match exactly, normalized content similarity is high, and numeric values and
negation agree. This keeps changed limits and opposite claims in the normal
conflict/governance path.

## What this does not do

Remote extraction does not automatically observe host tools, replace the
deterministic extractor, install or execute L4 Skills, or make model output
trusted. It creates governed L1 candidates backed by existing Session Evidence.
The v0.16 real-provider quality, token, cross-Agent, and CI evidence is recorded
in [`remote-extraction-acceptance-v0.16.md`](remote-extraction-acceptance-v0.16.md).
The provider supplied token counts but no price schedule, so the report does not
claim a currency cost for remote extraction.
