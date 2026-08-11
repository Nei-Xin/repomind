# 架构决策记录

每条记录描述一个关键架构决策、决策背景及其后果。状态包括：`accepted`、`superseded`、`proposed`。

| ADR | 标题 | 状态 |
| --- | --- | --- |
| [ADR-001](ADR-001-independent-core.md) | RepoMind 是独立核心，不绑定单一 Agent | accepted |
| [ADR-002](ADR-002-mcp-first-protocol.md) | MCP 是首个公开协议，而不是宿主工具钩子 | accepted |
| [ADR-003](ADR-003-sqlite-source-of-truth.md) | SQLite 是本地事实来源 | accepted |
| [ADR-004](ADR-004-fts5-before-vectors.md) | 先使用 FTS5，向量检索后置 | accepted |
| [ADR-005](ADR-005-memory-evidence-separation.md) | Memory 与 Evidence 分开存储 | accepted |
| [ADR-006](ADR-006-status-transitions-not-time-decay.md) | Memory 根据具体信号变更状态，而不是随时间衰减 | accepted |
| [ADR-007](ADR-007-marker-in-repo-data-in-home.md) | 项目 UUID 保存在仓库中，数据保存在用户目录中 | accepted |
| [ADR-008](ADR-008-core-independent-of-mcp-sdk.md) | 核心不依赖 MCP SDK | accepted |
| [ADR-009](ADR-009-validated-output-before-persistence.md) | 模型输出持久化前必须通过结构化验证 | accepted |
| [ADR-010](ADR-010-read-only-git-commands.md) | 只执行预定义的只读 Git 命令 | accepted |
