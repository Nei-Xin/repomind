# Memory 维护

RepoMind v0.11 引入维护队列，用于处理必须经过审查后才能视为当前仓库知识的 Memory。第一阶段将现有可审计治理操作组合成可重复的“检查、决定、执行、验证”工作流。

## 列出待处理工作

在仓库中运行 review：

```bash
repomind review
```

人类可读输出将每条 uncertain Memory 分为三类：

- `stale`：相关文件被创建、修改或删除。
- `conflict`：另一条存活 Memory 在相同标题和 scope 下提出矛盾声明。
- `other`：持久化原因不可用或来自更新生产者的 uncertain 记录。

自动化可使用过滤器或机器可读输出：

```bash
repomind review --kind stale --limit 20 --json
repomind review --kind conflict --json
```

构建队列前，RepoMind 会刷新全部存活 Memory 的文件哈希。JSON 结果独立于所选过滤器和 limit 报告待处理总数、分类数量，以及每个返回项的状态原因、Evidence 数量、相关文件、更新时间和建议命令。

## 解决一项工作

选择操作前，先检查 Evidence 和 Audit 轨迹：

```bash
repomind inspect mem_... --json
```

保留仍然正确的 Memory，并绑定当前文件哈希：

```bash
repomind memory-validate mem_... --reason "Reviewed against the current implementation"
```

替换结论已经变化的声明：

```bash
repomind memory-correct mem_... \
  --reason "The repository now uses the new transaction boundary" \
  --title "Transaction boundary" \
  --content "Each import batch runs in one transaction"
```

保留 Audit 轨迹，但从检索中移除已被证伪的声明：

```bash
repomind memory-invalidate mem_... --reason "Disproven by the current integration test"
```

`forget` 仍是独立的、需要显式确认的破坏性操作，只应用于必须物理删除的数据。常规维护应优先使用 validation、correction 或 invalidation，因为它们保留 provenance。

## 验证闭环

每批维护后再次运行 `repomind review`。验证后的 Memory 变为 active 并离开队列。Correction 会 supersede 旧记录；只有替换项仍存在冲突时，才可能把替换项加入队列。Invalidation 会从存活检索中移除该声明，并可能自动重新激活最后一个剩余的冲突方。

空结果是明确的闭环状态：

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

该命令不会自动作出治理决定。文件过期只能证明 Evidence 发生变化，不能证明 Memory 错误。

## 应用已批准批次

检查每条列出的 Memory 后，创建严格 JSON 决策文件：

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

从文件或 stdin 应用决策：

```bash
repomind review-apply --input review-decisions.json --json
repomind review-apply --input - --json
```

每个目标都必须仍处于待审查状态。RepoMind 会在写入前验证完整批次，并在一个事务中应用，因此无效或过期决策不会留下部分应用的批次。Correction 仍是单 Memory 操作，因为它需要替换内容和元数据。

MCP 客户端可以使用 `repo_memory_review` 和 `repo_memory_review_apply` 执行同一工作流。MCP apply 工具接受 snake-case 的 `memory_id` 字段。

## 检查维护历史

```bash
repomind review-history --limit 50 --json
```

历史从现有 append-only Memory Audit 日志派生。它包含 uncertain、conflict、reconciliation、validation、correction 和 invalidation 事件，不会建立第二事实来源。
