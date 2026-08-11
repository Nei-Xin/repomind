# 文件过期检测

RepoMind 将每条 Memory 保存的相关文件哈希与当前仓库文件比较。Search 和 inspect 会在返回数据前刷新此状态。

每次刷新最多读取同一文件一次，无论多少条 Memory 引用了它；文件大小和修改时间仍与记录值相同时，会完全跳过哈希。该快速路径会有意不信任最近两秒内修改的文件：发生在同一文件系统时间刻度中的编辑可能保持大小和 mtime 不变，因此最近修改的文件始终重新哈希。

系统会检测以下转换：

| 保存状态 | 当前状态 | 原因 |
| --- | --- | --- |
| 存在文件哈希 | 哈希不同 | `file_modified` |
| 存在文件哈希 | 文件不存在 | `file_deleted` |
| 文件原本不存在 | 文件现在存在 | `file_created` |

检测到变化会使 `active` Memory 转为 `uncertain`，在搜索输出中添加 `warning` 和 `staleReasons`，并写入一条 `memory_marked_uncertain` Audit。重复相同搜索不会重复写入 Audit。

文件恢复原状时，RepoMind 不会自动把 Memory 恢复为 `active`。请使用 [`memory-governance.md`](memory-governance.md) 中的显式验证工作流接受当前文件状态。

## OpenCode 验证

先构建 RepoMind 引擎：

```powershell
cd C:\path\to\repomind
npm.cmd run build
```

在 `C:\path\to\repomind-demo` 中搜索一条包含相关文件的 Memory 并 inspect。确认初始 `status` 为 `active`，记下相关文件和 `file_hash`。

在不创建新 RepoMind Memory 的情况下修改相关文件，例如：

```powershell
Add-Content .\README.md "`nA change made after the memory was captured."
```

要求 OpenCode 调用：

```text
repo_memory_search
repo_path = C:\path\to\repomind-demo
query = Migration rollback verification
limit = 5
```

匹配 Memory 现在应包含：

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

然后为该 Memory 调用 `repo_memory_inspect`。Audit 列表应恰好包含一条：

```text
action = memory_marked_uncertain
reason = This memory may be stale: README.md changed.
```

再次执行相同 search 和 inspect。Memory 仍为 `uncertain`，但不会再次添加相同 Audit。
