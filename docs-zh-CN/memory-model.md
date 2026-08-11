# 记忆模型

RepoMind 将原始 Evidence 与可复用结论分开，并按照结论的抽象程度分层。本文记录这些层次，因为分层决定了下一步可以安全构建什么。

## L0 - Evidence（证据）

Evidence 是尽量不加解释地捕获“实际发生了什么”。当前保存九类 Evidence：

| 类型 | 来源 |
| --- | --- |
| `user_requirement` | 传给 `repo_session_start` 的任务文本 |
| `agent_summary` | Agent 在 commit 时报告的内容 |
| `git_snapshot` | 基线和最终状态的 branch、HEAD、dirty state、porcelain status |
| `git_diff` | 基线与最终状态之间的有界 diff，排除敏感路径 |
| `test_result` | 命令、退出码和摘要 |
| `command_result` | 命令、退出码和摘要 |
| `manual` | 人工直接记录的事实 |
| `validation` / `correction` / `invalidation` | 治理操作给出的原因 |

Evidence 一旦被引用就不可变。修正会创建新记录，而不是编辑历史，因此 Audit 轨迹不会被后来的声明改写。写入时会应用大小限制和 Secret 脱敏；超限内容不会被静默丢弃，而会保留哈希、截断标记和来源。

Evidence 不会作为召回文本返回。它用于决定是否相信一条 Memory，这与提供上下文是不同任务。

## L1 - 原子 Memory

一条 L1 Memory 只陈述一个可复用的仓库事实。它是搜索返回的单位，也是治理操作的单位。

| 类型 | 表达内容 | 示例 |
| --- | --- | --- |
| `architecture` | 结构或职责 | HTTP route 只在 `src/routes` 注册 |
| `convention` | 项目规则 | 公共 API 导出显式类型 |
| `decision` | 选择及其原因 | SQLite 是本地事实来源 |
| `command` | 已验证命令 | `npm test -- storage` 运行存储套件 |
| `failure` | 已确认失败 | 原生模块无法在此 Node 版本加载 |
| `solution` | 已验证修复 | 使用匹配架构重新安装依赖可恢复 loader |
| `dependency` | 版本或工具约束 | 要求 Node.js 22.5+ |
| `location` | 内容位置 | MCP 工具在 `src/mcp/server.ts` 注册 |
| `requirement` | 长期项目要求 | 每条 Memory 必须携带 Evidence |
| `risk` | 高风险区域 | 迁移必须保持向后兼容 |

类型会驱动行为。**声明式**类型（`architecture`、`convention`、`decision`、`dependency`、`location`、`requirement`、`risk`）参与矛盾检测，因为“规则是什么”不能同时有两个不同答案。**事件型**类型（`command`、`failure`、`solution`）不参与，因为同一命令两次产生不同结果属于历史，而不是矛盾。

每条 Memory 还包含：

- **scope**：`repository`、`module` 或 `path`，可带一个可选值。Scope 是 Memory 身份的一部分：不同模块中相同标题代表两个事实，而不是冲突。
- **confidence**：从 Evidence 强度推导，而不是由模型自行声明。
- **status**：`active`、`uncertain`、`superseded` 或 `invalid`。
- **fingerprint**：类型、脱敏内容和 scope 的哈希。它使重复记录同一事实成为 no-op，而不是创建副本；这也是已退役 Memory 在被遗忘或重新激活前永久拥有其内容的原因。
- **related files**：包含文件哈希、大小和修改时间，用于检测过期。

一条好的 L1 Memory 必须脱离原始对话后仍然成立。“修好了 bug”对未来毫无价值；“Windows loader 失败是因为原生模块为不同架构构建，重新安装依赖解决了问题”则可以复用。提取会有意生成少量 Memory，而不是抄录所有活动。

## L2 - Module Narrative（模块叙述）

L2 Narrative 聚合属于一个模块的 L1 Memory：模块职责和边界、关键文件、塑造它的决策、常见失败模式以及当前风险。每项声明都必须能追溯到底层记录，Narrative 也必须有长度预算，避免退化为代码库的第二份副本。

## L3 - Repository Profile（仓库画像）

L3 Profile 是稳定的仓库级摘要：技术栈、目录职责、构建和测试命令、核心决策、长期约束和高风险区域。它值得在任务开始时主动提供，但也正因如此，不能被一个低置信度 Session 覆盖。RepoMind 从有 Evidence 支持的仓库级 L1 事实和 L2 模块边界派生 Profile，保留每个生成版本，并暴露完整来源链供检查。过期 Profile 仍可 inspect，但不会注入新任务。

## L4 - Skill Candidate（技能候选项）

L4 检测至少三个已提交 Session 中重复成功的工作流，并将其作为提案输出：触发条件、输入、步骤、验证、风险及其来源 Evidence。确定性的 v0.15 实现要求成功命令集和测试集匹配，并排除 failed、partial、abandoned、无命令和一次性 Session。

Candidate 使用 `pending`、`approved` 和 `rejected` 审查状态。新的来源 Evidence 会将 approved 或 rejected Candidate 重置为 `pending`。只有 approved Candidate 才能导出为 `SKILL.md`；RepoMind 绝不会安装或执行它。开始执行操作的记忆系统就不再只是记忆系统。

## 分层为何重要

每一层都以细节换取上下文成本。L0 完整但注入成本过高；L1 足够小，可以交给 Agent，同时又足够具体可执行。L2 和 L3 进一步压缩，但会损失细节，因此它们必须能够从 L1 和 Evidence 重新派生，而不能被直接写入。

相关阅读：[`memory-governance.md`](memory-governance.md) 介绍状态转换，[`stale-detection.md`](stale-detection.md) 介绍如何发现文件变化，[`architecture.md`](architecture.md) 介绍各层在代码中的位置。
