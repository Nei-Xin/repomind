# RepoMind v0.11 Memory 维护验收

日期：2026-07-28

## 范围

本次验收在不允许 RepoMind 自动作出治理决定的前提下，闭合 review-first 维护循环。

接受的工作流为：

1. 通过 CLI 或 MCP 刷新并列出 uncertain Memory。
2. 检查 Evidence 和 Audit 历史。
3. 单独或批量提交显式 validate/invalidate 决策。
4. 原子应用完整批次。
5. 验证队列已关闭，并检查维护历史。

该版本还暴露 `repo_session_abandon`，补全 CLI 和 Host-managed runner 已具备的 MCP Session 生命周期。

## 验收结果

| 门禁 | 结果 |
| --- | --- |
| TypeScript strict typecheck | 通过 |
| 生产构建 | 通过 |
| Vitest | 26 个文件、126 个测试通过 |
| MCP 内存工具契约 | 通过，12 个工具 |
| MCP stdio 协议纯净性 | 通过 |
| 跨进程 CLI review batch | 通过 |
| 原子批次 rollback | 通过 |
| 八任务 Agent fixture 验证 | 8/8 通过 |

## 完整性属性

- 写入任何决策之前，每个批次目标必须仍为 `uncertain`。
- 重复目标、缺失 Memory、空原因和无效 action 会拒绝整个请求。
- 嵌套治理操作在一个外层事务下使用 SQLite savepoint，防止部分批次。
- Validation 和 invalidation 继续创建 Evidence，并追加到现有 Memory Audit 日志。
- 维护历史是 Audit 日志上的 read model，不是第二事实来源。
- Correction 仍是显式单 Memory 操作，因为替换内容需要独立人工审查。

## 剩余最终产品工作

该版本不声称提供 L2/L3 Memory、第二个真实 Coding Agent 验收、export/import/backup/restore、macOS CI 或 Skill Candidate 支持。这些仍按最终 v1.0 完成标准追踪。
