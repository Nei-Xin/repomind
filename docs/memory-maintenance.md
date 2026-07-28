# Memory maintenance

RepoMind v0.11 development introduces a maintenance queue for memories that
must be reviewed before they can be treated as current repository knowledge.
The first slice composes the existing audited governance operations into a
repeatable inspect, decide, act, and verify workflow.

## List pending work

Run the review command from the repository:

```bash
repomind review
```

The human-readable output groups every uncertain memory into one of three
kinds:

- `stale`: a related file was created, modified, or deleted.
- `conflict`: another live memory makes a contradictory claim with the same
  title and scope.
- `other`: an uncertain record whose persisted reason is unavailable or from a
  newer producer.

Use filters or machine-readable output for automation:

```bash
repomind review --kind stale --limit 20 --json
repomind review --kind conflict --json
```

Before constructing the queue, RepoMind refreshes file hashes for all live
memories. The JSON result reports the total pending count independently of the
selected filter and limit, category counts, and each returned item's status
reason, evidence count, related files, update time, and suggested commands.

## Resolve an item

Inspect the evidence and audit trail before choosing an action:

```bash
repomind inspect mem_... --json
```

Keep a still-correct memory and bind it to current file hashes:

```bash
repomind memory-validate mem_... --reason "Reviewed against the current implementation"
```

Replace a claim whose conclusion changed:

```bash
repomind memory-correct mem_... \
  --reason "The repository now uses the new transaction boundary" \
  --title "Transaction boundary" \
  --content "Each import batch runs in one transaction"
```

Retain the audit trail but remove a disproven claim from retrieval:

```bash
repomind memory-invalidate mem_... --reason "Disproven by the current integration test"
```

`forget` remains a separate, explicitly confirmed destructive operation for
data that must be physically removed. Routine maintenance should prefer
validation, correction, or invalidation because they preserve provenance.

## Verify closure

Run `repomind review` again after every maintenance batch. A validated memory
becomes active and leaves the queue. Correction supersedes the old record and
may add a replacement to the queue only if that replacement still conflicts.
Invalidation removes that claim from live retrieval and can automatically
reactivate its last remaining conflict peer.

An empty result is an explicit closed state:

```json
{
  "pending": 0,
  "returned": 0,
  "counts": {
    "stale": 0,
    "conflict": 0,
    "other": 0
  },
  "items": []
}
```

This command does not make governance decisions automatically. A stale file
proves only that evidence changed; it does not prove the memory is false.

## Apply an approved batch

Create a strict JSON decision file after inspecting every listed memory:

```json
{
  "actions": [
    {
      "memoryId": "mem_...",
      "action": "validate",
      "reason": "Checked against the current implementation and tests"
    },
    {
      "memoryId": "mem_...",
      "action": "invalidate",
      "reason": "Disproven by the current integration test"
    }
  ]
}
```

Apply the decisions from a file or stdin:

```bash
repomind review-apply --input review-decisions.json --json
repomind review-apply --input - --json
```

Every target must still be pending review. RepoMind validates the complete
batch before writing and applies it in one transaction, so an invalid or stale
decision cannot leave a partially applied batch. Correction remains a
single-memory operation because it requires replacement content and metadata.

MCP clients can use `repo_memory_review` and `repo_memory_review_apply` with
the same workflow. The MCP apply tool accepts snake-case `memory_id` fields.

## Inspect maintenance history

```bash
repomind review-history --limit 50 --json
```

The history is derived from the existing append-only memory audit log. It
includes uncertain, conflict, reconciliation, validation, correction, and
invalidation events without creating a second source of truth.
