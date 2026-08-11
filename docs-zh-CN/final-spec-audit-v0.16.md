# RepoMind v0.16 最终规格审计

## 结果

本次审计对照 `REPOMIND_FINAL_PRODUCT_SPEC.md` 第 24 节，核验了
v0.16.0 之后的实现和保留证据。28 项标准中有 27 项具备可执行证据。
仍有一项产品证明标准未完成：在外部真实开源仓库上开展连续任务收益研究。

不会仅因源代码存在就将某项功能计为已实现。下方每个已完成条目均指向测试、
可重新构建的运行器、正式报告或跨平台 CI。本审计不会将 v0.16.0 更名为 v1.0。

## 产品能力

| 标准 | 证据 | 状态 |
| --- | --- | --- |
| 在真实 Git 仓库中初始化和运行 | `tests/e2e.test.ts`、L2/L3 真实仓库报告 | 完成 |
| 至少两个 MCP Agent 宿主 | `docs/quality-and-cross-agent-v0.13.md`、`docs/l4-cross-agent-acceptance-v0.15.md` | 完成 |
| Start -> Recall -> Commit -> Extract | `tests/e2e.test.ts`、`docs/remote-extraction-acceptance-v0.16.md` | 完成 |
| 跨进程和跨 Agent Recall | CLI E2E 以及 v0.16 Claude Code -> OpenCode 验收 | 完成 |
| L0-L3 数据流 | `docs/l2-real-repository-acceptance-v0.12.md`、`docs/l3-real-repository-acceptance-v0.12.md` | 完成 |
| 需审查的 L4 Candidate | `docs/skill-candidate-acceptance-v0.15.md` | 完成 |
| 搜索、检查、记录、纠正、验证、遗忘 | 治理和 E2E 测试 | 完成 |
| 具备回退机制的 FTS/向量混合检索 | `tests/vector.test.ts`、`docs/vector-search.md` | 完成 |
| 状态、冲突、替代和审计 | 治理、冲突、重新激活及遗忘测试 | 完成 |

## 可信性

| 标准 | 证据 | 状态 |
| --- | --- | --- |
| 自动生成的 Memory 绑定 Evidence | 确定性提取测试和远程提取测试 | 完成 |
| Inspect 可解释来源和状态 | CLI/MCP E2E 及跨 Agent 报告 | 完成 |
| 文件变更可检测过期状态 | 过期检测和性能测试 | 完成 |
| 弱推断不能覆盖更强的事实 | 冲突测试和远程验证测试 | 完成 |
| 不会静默合并冲突 | 冲突测试和保守的远程去重 | 完成 |
| 纠正和删除仍可审计 | 审查、纠正、遗忘和重新激活测试 | 完成 |

## 工程质量

| 标准 | 证据 | 状态 |
| --- | --- | --- |
| Windows、Linux、macOS CI | v0.16 主分支和标签 CI 运行 | 完成 |
| Core、SQLite、MCP、E2E | v0.16 的 167 项回归测试套件 | 完成 |
| 每个已发布 Schema 均可升级 | 锁定的发布清单和 Migration 固件测试 | 在 v0.17 工作树中完成 |
| MCP stdout 协议纯净性 | `tests/mcp-stdio.test.ts` | 完成 |
| 数据库、LLM、Embedding 的失败行为 | Migration 回滚、远程原子失败及 FTS 回退测试 | 完成 |
| 检索性能 | `docs/scale-acceptance-v0.14.md` | 完成 |
| 安全与 Secret Redaction | 安全、脱敏、可移植性和远程验收测试 | 完成 |

## 项目证明

| 标准 | 证据 | 状态 |
| --- | --- | --- |
| 可重新构建的演示仓库和脚本 | `benchmarks/` 下的八任务生成器和验收运行器 | 完成 |
| 无 Memory、平铺检索、RepoMind 对比 | 对比基准和三组 Agent 基准 | 完成 |
| 成功率、Token、重复探索、过期误用 | v0.7-v0.8 报告和阶段分析器 | 完成 |
| 已记录宿主观察限制 | 架构、日常工作流及 MCP 集成文档 | 完成 |
| README、架构、ADR、贡献指南 | 仓库文档和十份 ADR | 完成 |
| 外部真实开源项目的跨 Session 收益 | 当前真实仓库测试使用 RepoMind 自身；跨 Agent 任务仓库是受控固件 | 未完成 |

## 明确不作为门槛的项目

- 目前有意不提供逻辑合并导入，因为受治理的 ID、Evidence、冲突及替代关系
  需要单独定义合并策略。替换导入满足当前的可移植性契约。
- 加密归档仍是有价值的安全增强，但第 24 节的本地恢复要求已经由带校验和的
  备份与恢复功能满足。
- 在没有稳定的提供商价格表时，不声明提供商货币成本。正式报告保留提供商报告的
  Token 用量。
- RepoMind 不安装或执行 L4 Skill，也不会自动观察宿主工具。这些是产品安全边界，
  而不是缺失的 Agent 功能。
