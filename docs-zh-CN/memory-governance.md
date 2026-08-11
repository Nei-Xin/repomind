# Memory 治理

使用 [`memory-maintenance.md`](memory-maintenance.md) 中的 `repomind review` 队列发现并关闭待处理的治理工作。

RepoMind 为需要人工或 Agent 复核的 Memory 提供显式、可审计的状态转换。

```text
active -> uncertain -> active       validate
active/uncertain -> superseded      correct
active/uncertain -> invalid         invalidate
any status -> physically deleted    forget
```

搜索默认返回 `active` 和 `uncertain` Memory。`superseded` 和 `invalid` Memory 会被排除，但 inspect 仍保留其完整 Evidence、关系、状态原因和 Audit 历史。

## 冲突检测

当新的声明式 Memory（`architecture`、`convention`、`decision`、`dependency`、`location`、`requirement`、`risk`）与现有 `active` 或 `uncertain` Memory 具有相同类型、scope 和标题，但内容不同，RepoMind 不会静默合并。它会保存新 Memory，通过 `contradicts` 关系连接两者，将两者都标为 `uncertain` 并设置 `conflict` 状态原因，同时写入 `memory_conflict_detected` Audit。随后搜索会返回冲突双方，并附带明确警告。

使用相同治理工具解决冲突：`validate` 仍成立的一方，`correct` 或 `invalidate` 不成立的一方。事件型类型（`command`、`failure`、`solution`）绝不会自动冲突，因为重复执行出现不同结果是正常历史，而不是矛盾。

即使替换项仍与保留的一方冲突，也允许修正冲突的一方：修正成功，替换项保持 `uncertain`，`CorrectMemoryResult.conflicts` 会列出仍与它冲突的全部 Memory。只有当修正内容与已处于 `superseded` 或 `invalid` 的 Memory 碰撞时才会拒绝；此时请遗忘该 Memory 或改用不同措辞。

## 再次记录已退役事实

Memory 内容会永久拥有其 fingerprint，因此重新记录一条与 `superseded` 或 `invalid` Memory 相同的事实原本会成为静默 no-op。为避免这一点，`record`（以及 `repo_memory_record`）会重新激活该 Memory、关联新 Evidence 并写入 `memory_reactivated` Audit；结果返回 `reactivated: true`。若复活的事实与存活 Memory 矛盾，则应用正常冲突检测，双方都变为 `uncertain`。

自动提取和 `correct` 永远不会重新激活。它们都没有表达复活已被人为退役 Memory 的意图，因此提取会跳过候选项，`correct` 会返回明确错误。

## Validate（验证）

Validation 接受仓库中当前相关文件哈希作为新基线。它会清除过期原因、更新 `last_validated_at`、添加 `validation` Evidence，并写入 `memory_validated` Audit。

```powershell
node C:\path\to\repomind\dist\cli\index.js memory-validate <memory-id> `
  --repo C:\path\to\repomind-demo `
  --reason "Reviewed the changed files and confirmed the rule still applies." `
  --json
```

MCP 工具：`repo_memory_validate`

## Correct（纠正）

Correction 创建替换 Memory，而不是覆盖历史。替换项为 `active`，旧 Memory 变为 `superseded`，两者通过从新到旧的 `supersedes` 关系相连。两条 Memory 都引用 `correction` Evidence。

```powershell
node C:\path\to\repomind\dist\cli\index.js memory-correct <memory-id> `
  --repo C:\path\to\repomind-demo `
  --reason "The rollback policy changed after the migration refactor." `
  --title "Current migration rollback policy" `
  --content "Every migration must run in a transaction and pass rollback verification." `
  --json
```

MCP 工具：`repo_memory_correct`

Inspect 旧 Memory 可看到 `status = superseded`、`replacementMemoryId` 和入向 `supersedes` 关系；inspect 替换项可看到对应的出向关系。

## Invalidate（失效）

Invalidation 用于没有替换项、已被证伪的 Memory。它保留此前全部 Evidence，添加 `invalidation` Evidence，保存原因并写入 `memory_invalidated` Audit。

```powershell
node C:\path\to\repomind\dist\cli\index.js memory-invalidate <memory-id> `
  --repo C:\path\to\repomind-demo `
  --reason "The diagnosis was disproven by the migration test." `
  --json
```

MCP 工具：`repo_memory_invalidate`

## Forget（遗忘）

Forgetting 是唯一会物理删除数据的治理操作。它会删除 Memory 行、FTS 项、文件链接、关系和 Audit。默认 `memory-and-evidence` scope 还会删除没有被其他 Memory 引用的 Evidence；`--scope memory` 则保留全部 Evidence 行。系统会向 `forget_log` 写入不含内容的 tombstone（Memory ID、类型、scope、原因、时间戳），使删除本身仍可验证。

CLI 会打印将要删除的内容；除非传入 `--yes`，否则会退出而不执行删除：

```powershell
node C:\path\to\repomind\dist\cli\index.js forget <memory-id> `
  --repo C:\path\to\repomind-demo `
  --reason "The memory captured a secret that must be removed." `
  --yes `
  --json
```

MCP 工具：`repo_memory_forget`（要求 `confirm: true`；Agent 确认前必须获得用户批准）

## OpenCode 验证

重新构建 RepoMind 后，重启 OpenCode，使其 MCP 进程加载新构建。然后：

1. 搜索一条 `uncertain` Memory 并调用 `repo_memory_validate`；确认新搜索将其返回为 `active`。
2. 调用 `repo_memory_correct`；确认旧 ID 从搜索中消失，替换 ID 被返回。
3. Inspect 两个 ID；确认存在 `supersedes` 关系和 `memory_corrected` Audit。
4. 创建或选择另一条可丢弃 Memory，调用 `repo_memory_invalidate`；确认搜索排除它，而 inspect 报告 `invalid`。

每个治理调用都要求非空原因。已经标记为 `superseded` 或 `invalid` 的 Memory 不能再次 validate、correct 或 invalidate。
