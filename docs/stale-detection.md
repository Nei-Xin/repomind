# File stale detection

RepoMind compares each memory's stored related-file hash with the current repository file. Search and inspect refresh this state before returning data.

Each refresh reads a given file at most once, no matter how many memories reference it, and skips hashing entirely when the file's size and modification time still match the recorded values. That fast path deliberately distrusts files modified within the last two seconds: an edit landing in the same filesystem tick can leave size and mtime unchanged, so recently touched files are always re-hashed.

The following transitions are detected:

| Stored state | Current state | Reason |
| --- | --- | --- |
| File hash exists | Different hash | `file_modified` |
| File hash exists | File is absent | `file_deleted` |
| File was absent | File now exists | `file_created` |

A detected change moves an `active` memory to `uncertain`, adds `warning` and `staleReasons` to search output, and writes one `memory_marked_uncertain` audit entry. Repeating the same search does not duplicate that audit entry.

RepoMind does not automatically return the memory to `active` when a file is reverted. Use the explicit validation workflow described in [`memory-governance.md`](memory-governance.md) to accept the current file state.

## OpenCode verification

Build the RepoMind engine first:

```powershell
cd D:\data\code\project\repomind
npm.cmd run build
```

In `D:\data\code\project\repomind-demo`, search for a memory that has a related file and inspect it. Confirm its initial `status` is `active` and note the related file and `file_hash`.

Change that related file without creating a new RepoMind memory. For example:

```powershell
Add-Content .\README.md "`nA change made after the memory was captured."
```

Ask OpenCode to call:

```text
repo_memory_search
repo_path = D:\data\code\project\repomind-demo
query = Migration 回滚验证
limit = 5
```

The matching memory should now contain:

```json
{
  "status": "uncertain",
  "warning": "This memory may be stale: README.md changed.",
  "staleReasons": [
    {
      "kind": "file_modified",
      "filePath": "README.md",
      "expectedHash": "<hash captured with the memory>",
      "currentHash": "<current file hash>"
    }
  ]
}
```

Then call `repo_memory_inspect` for that memory. Its audit list should include exactly one entry with:

```text
action = memory_marked_uncertain
reason = This memory may be stale: README.md changed.
```

Run the same search again and inspect it again. The memory remains `uncertain`, but the identical audit entry is not added a second time.
