# Memory governance

RepoMind `v0.3.0` provides explicit, audited transitions for memories that need human or agent review.

```text
active -> uncertain -> active       validate
active/uncertain -> superseded      correct
active/uncertain -> invalid         invalidate
any status -> physically deleted    forget
```

Search returns `active` and `uncertain` memories by default. It excludes `superseded` and `invalid` memories, while inspect keeps their complete Evidence, relation, status reason, and Audit history available.

## Conflict detection

When a new declarative memory (`architecture`, `convention`, `decision`, `dependency`, `location`, `requirement`, `risk`) shares the type, scope, and title of an existing `active` or `uncertain` memory but states different content, RepoMind refuses to merge them silently. It stores the new memory, links the pair with a `contradicts` relation, marks both `uncertain` with a `conflict` status reason, and writes `memory_conflict_detected` Audit entries. Search then returns both sides with an explicit conflict warning.

Resolve a conflict with the same governance tools: `validate` the side that holds, `correct` or `invalidate` the side that does not. Episodic types (`command`, `failure`, `solution`) never conflict automatically because repeating them with different outcomes is normal history, not contradiction.

Correcting one side of a conflict is allowed even when the replacement still contradicts the surviving side: the correction succeeds, the replacement stays `uncertain`, and `CorrectMemoryResult.conflicts` names every memory it still contradicts. A correction is refused only when its content collides with a memory that is already `superseded` or `invalid`; forget that memory or choose different wording.

## Recording a retired fact again

A memory's content owns its fingerprint permanently, so recording a fact identical to a `superseded` or `invalid` memory would otherwise be a silent no-op. Instead, `record` (and `repo_memory_record`) reactivates that memory, attaches the new evidence, and writes a `memory_reactivated` audit entry; the result reports `reactivated: true`. If the revived fact contradicts a live memory, normal conflict detection applies and both sides become `uncertain`.

Automatic extraction and `correct` never reactivate. Neither expresses intent to resurrect a memory somebody deliberately retired, so extraction skips the candidate and `correct` returns an explicit error.

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

## Forget

Forgetting is the only governance action that physically deletes data. It removes the Memory row, its FTS entries, file links, relations, and Audit entries. With the default `memory-and-evidence` scope it also deletes Evidence that no other Memory references; `--scope memory` keeps all Evidence rows. A content-free tombstone (Memory ID, type, scope, reason, timestamp) is written to `forget_log` so the deletion itself stays verifiable.

The CLI prints what would be deleted and exits without deleting unless `--yes` is passed:

```powershell
node D:\data\code\project\repomind\dist\cli\index.js forget <memory-id> `
  --repo D:\data\code\project\repomind-demo `
  --reason "The memory captured a secret that must be removed." `
  --yes `
  --json
```

MCP tool: `repo_memory_forget` (requires `confirm: true`; agents must obtain user approval before confirming)

## OpenCode verification

After rebuilding RepoMind, restart OpenCode so its MCP process loads `v0.3.0`. Then:

1. Search for an `uncertain` Memory and call `repo_memory_validate`; confirm a new search returns it as `active`.
2. Call `repo_memory_correct`; confirm the old ID disappears from search and the replacement ID is returned.
3. Inspect both IDs; confirm the `supersedes` relation and `memory_corrected` Audit entry.
4. Create or select another disposable Memory and call `repo_memory_invalidate`; confirm search excludes it while inspect reports `invalid`.

Every governance call requires a non-empty reason. A Memory already marked `superseded` or `invalid` cannot be validated, corrected, or invalidated again.
