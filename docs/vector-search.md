# Vector and hybrid search

RepoMind keeps FTS5 as the zero-configuration retrieval path. When an
embedding provider and sqlite-vec are available, `repo_memory_search` and the
CLI search command combine lexical and vector ranks using weighted reciprocal
rank fusion. Any provider, configuration, or extension error returns the FTS5
results with a fallback reason through MCP.

## Providers

Set `REPOMIND_EMBEDDING_PROVIDER=deterministic` for the offline feature-hash
provider. It exists for reproducible tests and benchmarks; it is not a learned
semantic model.

Set these variables for a remote OpenAI-compatible endpoint:

```text
REPOMIND_EMBEDDING_PROVIDER=openai-compatible
REPOMIND_EMBEDDING_BASE_URL=https://api.example.com/v1
REPOMIND_EMBEDDING_API_KEY=...
REPOMIND_EMBEDDING_MODEL=...
REPOMIND_EMBEDDING_DIMENSIONS=1536
```

Remote requests receive the already-redacted memory title and content. They do
not receive evidence bodies or Git diffs. Whether repository text may leave
the machine remains an explicit operator decision: no remote provider is
enabled by default.

## Cache lifecycle

`memory_embeddings` is derived data. Rows are keyed by memory ID and include
the provider model, dimensions, and a content hash. Search embeds missing or
outdated rows lazily. `repomind vector-reindex` forces a full rebuild after a
model change. Embeddings are computed before the write transaction starts, so
a failed batch writes nothing. Forget uses the memory foreign key to delete its
cached vector automatically.

Use `repomind status --json` to inspect configured capabilities and
`repomind doctor --json` to verify that the platform extension loads.
