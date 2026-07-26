# Memory governance

RepoMind `v0.3.0` provides explicit, audited transitions for memories that need human or agent review.

```text
active -> uncertain -> active       validate
active/uncertain -> superseded      correct
active/uncertain -> invalid         invalidate
```

Search returns `active` and `uncertain` memories by default. It excludes `superseded` and `invalid` memories, while inspect keeps their complete Evidence, relation, status reason, and Audit history available.

## Validate

Validation accepts the repository's current related-file hashes as the new baseline. It clears the stale reason, updates `last_validated_at`, adds `validation` Evidence, and writes a `memory_validated` Audit entry.

```powershell
node D:\data\code\project\repomind\dist\cli\index.js memory-validate <memory-id> `
  --repo D:\data\code\project\repomind-demo `
  --reason "Reviewed the changed files and confirmed the rule still applies." `
  --json
```

MCP tool: `repo_memory_validate`

## Correct

Correction creates a replacement Memory instead of overwriting history. The replacement is `active`, the old Memory becomes `superseded`, and a `supersedes` relation links the replacement to the old Memory. Both memories reference the `correction` Evidence.

```powershell
node D:\data\code\project\repomind\dist\cli\index.js memory-correct <memory-id> `
  --repo D:\data\code\project\repomind-demo `
  --reason "The rollback policy changed after the migration refactor." `
  --title "Current migration rollback policy" `
  --content "Every migration must run in a transaction and pass rollback verification." `
  --json
```

MCP tool: `repo_memory_correct`

Inspect the old Memory to find `status = superseded`, its `replacementMemoryId`, and an incoming `supersedes` relation. Inspect the replacement to find the corresponding outgoing relation.

## Invalidate

Invalidation is for a disproven Memory that has no replacement. It keeps all previous Evidence, adds `invalidation` Evidence, stores the reason, and writes a `memory_invalidated` Audit entry.

```powershell
node D:\data\code\project\repomind\dist\cli\index.js memory-invalidate <memory-id> `
  --repo D:\data\code\project\repomind-demo `
  --reason "The diagnosis was disproven by the migration test." `
  --json
```

MCP tool: `repo_memory_invalidate`

## OpenCode verification

After rebuilding RepoMind, restart OpenCode so its MCP process loads `v0.3.0`. Then:

1. Search for an `uncertain` Memory and call `repo_memory_validate`; confirm a new search returns it as `active`.
2. Call `repo_memory_correct`; confirm the old ID disappears from search and the replacement ID is returned.
3. Inspect both IDs; confirm the `supersedes` relation and `memory_corrected` Audit entry.
4. Create or select another disposable Memory and call `repo_memory_invalidate`; confirm search excludes it while inspect reports `invalid`.

Every governance call requires a non-empty reason. A Memory already marked `superseded` or `invalid` cannot be validated, corrected, or invalidated again.
