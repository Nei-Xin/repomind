# RepoMind 项目技术报告（中文）

> 当前发布基线：`v1.0.0-rc.2`（提交 `dfe022fb55b1826327eecd45e70a2381f644427a`）
> 更新日期：2026-08-12
> 项目定位：面向 Coding Agent 的、以证据为支撑的仓库级持久记忆系统

RC.1、冻结提交 `6d421dd` 以及 2026-08-11 的实验仍作为历史快照保留；除明确标注历史口径的章节外，“当前实现”均指已经发布的 RC.2。

## 1. 这组报告回答什么问题

这不是 README 的简单翻译，而是基于完整源码、测试、基准脚本、ADR、验收报告和外部 120 次 Agent 实验产物整理的技术说明。重点回答：

1. RepoMind 解决了 Coding Agent 的什么真实问题；
2. 为什么采用显式 Session、Evidence/Memory 分离和 L0-L4 分层；
3. 跨 OpenCode、Claude Code 等 Agent 的记忆为什么能够复用；
4. FTS5、可选向量检索、陈旧检测、冲突治理如何实现；
5. Host-managed 生命周期为什么比让模型自己管理生命周期更稳定；
6. 项目目前实际实现了什么，没有实现什么；
7. 正式实验和真实重复实验分别证明了什么；
8. 如何安装、运行、维护、评测和排查问题；
9. 面试中如何准确介绍项目并回答追问。

## 2. 文档导航

| 文档 | 重点 | 建议读者 |
| --- | --- | --- |
| [01 项目总览与系统架构](01-project-overview-and-architecture.md) | 问题定义、整体架构、跨 Agent 原理、两种生命周期 | 所有人，先读 |
| [02 核心数据模型与记忆原理](02-core-data-model-and-memory-principles.md) | Session、Evidence、Memory、事务、幂等、L0-L4 | 后端、Agent 工程面试 |
| [03 分层记忆、检索与治理](03-layered-memory-search-and-governance.md) | FTS5/向量/RRF、stale、冲突、L2-L4 算法 | 算法与工程实现追问 |
| [04 Agent 集成与完整使用教程](04-agent-integration-and-usage-guide.md) | OpenCode/Claude/Codex、CLI、MCP、维护、备份 | 实际使用和演示 |
| [05 测试、评测与效果分析](05-testing-evaluation-and-results.md) | 单测、72 次正式实验、120 次实验、规模与跨 Agent 结果 | 证明效果、复现实验 |
| [06 工程亮点、限制与路线图](06-engineering-highlights-limitations-and-roadmap.md) | 亮点、可信边界、缺陷、改进优先级 | 技术评审、简历答辩 |
| [07 面试问题与参考答案](07-interview-questions-and-answers.md) | 项目介绍、架构、实现、实验、安全、反驳题 | 面试准备 |
| [08 源码阅读与重点掌握清单](08-source-reading-and-learning-guide.md) | 阅读路径、关键函数、动手练习、自测问题 | 深入掌握项目 |
| [09 本次审计与验证记录](09-audit-and-verification-record.md) | 审计基线、实际命令、结果、数据来源和未执行项 | 复核与后续更新 |
| [10 跨 Session Host 正式实验](10-cross-session-formal-experiment-20260811.md) | 新 120-stage OpenCode/Luna 实验、独立审计、正确率与效率结果、L1-L3 证据边界 | 结果复核、简历和面试答辩 |
| [11 三阶段 L2/L3 消费实验](11-three-stage-l2-l3-consumption-experiment-20260811.md) | derived-only 第三 Session、五连测、独立审计、上游断流与结论边界 | 分层上下文效果复核、面试答辩 |
| [12 OpenCode -> Claude Repeat 5](12-opencode-claude-repeat5-20260811.md) | 跨 Agent derived-only 消费、30-stage repeat 5、containment 14/14 审计 | 最新核心效果证据、面试答辩 |
| [13 RC.2 发布工程审计](13-v1.0.0-rc.2-release-audit.md) | 安装与首次使用修复、跨平台门禁、制品校验、GitHub prerelease | 发布复核、交付说明 |
| [14 小型三臂 18-run Agent 实验](14-three-arm-18run-experiment-20260812.md) | no-memory/full-history/RepoMind 正式复核、效率指标、分层注入归因与证据哈希 | 最新三臂效果口径、面试答辩 |

## 3. 一句话结论

RepoMind 将一次 Agent 任务拆成“显式开始 -> 检索历史结论 -> Agent 正常改代码 -> 显式提交结果 -> 保存证据并生成可复用记忆”，再通过稳定 Project ID 和用户目录下的 SQLite，让不同 Agent、不同会话和同一项目的多个 checkout 共享经过治理的仓库知识。

它的核心价值不是“记住所有聊天”，而是把高成本、噪声大的历史过程压缩成少量、可检索、可追溯、能失效、能纠错的仓库事实。

## 4. 当前实现概览

| 维度 | 当前实现 |
| --- | --- |
| 版本与规模 | `1.0.0-rc.2`；提交 `dfe022f`；77 个 TypeScript 源文件、约 16,006 行；`tests/` 有 47 个 TypeScript 文件，其中 46 个测试套件，约 8,580 行、266 项测试 |
| 运行环境 | Node.js `>=22.5`、Git；TypeScript；`node:sqlite` |
| 数据层 | SQLite Schema 11、WAL、FTS5、可选 sqlite-vec |
| 记忆层 | L0 Evidence、L1 Atomic Memory、L2 Module Narrative、L3 Repository Profile、L4 Skill Candidate |
| 接口 | 完整 CLI；当前源码注册 24 个 MCP 工具；OpenCode 与 Claude Code Host-managed 适配器 |
| 检索 | 标识符增强 FTS5、CJK bigram、substring fallback、可选向量与 weighted RRF |
| 治理 | validate、correct、invalidate、forget、stale、conflict、审计日志、Review Queue |
| 安全 | 模式脱敏、敏感 Git path 排除、只采用预定义 Git 调用、路径边界校验、可选加密归档 |
| 可移植性 | 逻辑 export/import（replace-only）、物理 backup/restore、AES-256-GCM 可选加密 |
| 评测 | Fixture 比较、真实 Agent 三臂实验、Host-managed 审计、规模/跨 Agent/远程提取验收 |
| 发布 | GitHub prerelease tarball；17/17 安装验收；Ubuntu/Windows/macOS、coverage、bench 五项 CI 门禁 |

## 5. 证据口径

本报告有意区分三类结论：

- **源码事实**：可以从 `src/`、`tests/` 和 Schema 直接确认；
- **仓库正式验收**：完整性门槛和结果门槛都通过，能够作为该固定环境下的正式证据；
- **观察性结果**：实验中出现基础设施失败，但其余样本仍提供能力信号；不能写成正式验收通过。

尤其是 2026-08-04 的 `8 × 3 × 5 = 120` 次 Luna 实验：RepoMind 臂观察到 40/40 隐藏检查通过，但有一个 full-history 样本发生证书验证错误，导致严格实验完整性失败。因此报告只把它作为更大样本的观察结果，并同时给出排除故障配对后的敏感性分析。

2026-08-11 又在冻结提交 `6d421dd` 上完成了新的跨 Session `6 sequences × 2 arms × 2 stages × 5 repeats = 120` 次 OpenCode/Luna 实验。Correctness 与 efficiency cohort 的 Integrity、Acceptance 和独立 Audit 均通过。它验证的是当前 Host 路径，不是对旧三臂实验的重复；详细口径见第 10 篇报告。

2026-08-12 发布的 RC.2 没有重跑真实模型实验，而是完成发布前工程审计：266/266 单测、8/8 Agent fixtures、跨 Session/分层 fixtures、17/17 安装包 smoke、main/tag 五项 CI 和 GitHub prerelease 制品核验。它证明可安装性和工程交付，不新增效果 uplift 结论。

随后在提交 `58ef902` 上完成 `3 tasks × 3 arms × 2 repeats = 18` 次 OpenCode/Luna 小型三臂复核。Integrity 与 Acceptance 9/9 通过；RepoMind/full-history/no-memory hidden 为 `6/6、6/6、2/6`。RepoMind 相对 no-memory 的 wall time、output token、file reads 分别下降 `28.2%、24.5%、46.2%`；相对 full-history 正确率相同、耗时近似，input token 点估计反而高 `22.1%`。本轮实际注入 L1/L2/L3 为 `1/0/0`，不能用于证明 L2/L3 独立 uplift。详见第 14 篇报告。

## 6. 关键源码入口

| 主题 | 入口 |
| --- | --- |
| Core API | [`../src/core.ts`](../src/core.ts) |
| 类型与状态机 | [`../src/domain/types.ts`](../src/domain/types.ts) |
| Schema 与 Migration | [`../src/storage/migrations.ts`](../src/storage/migrations.ts) |
| SQLite 事务 | [`../src/storage/database.ts`](../src/storage/database.ts) |
| 词法检索 | [`../src/search/lexical.ts`](../src/search/lexical.ts) |
| 向量索引 | [`../src/search/vector-index.ts`](../src/search/vector-index.ts) |
| Git 采集 | [`../src/git/git-inspector.ts`](../src/git/git-inspector.ts) |
| 远程提取 | [`../src/extraction/runner.ts`](../src/extraction/runner.ts)、[`../src/extraction/schema.ts`](../src/extraction/schema.ts) |
| L2/L3/L4 | [`../src/narratives/module-narratives.ts`](../src/narratives/module-narratives.ts)、[`../src/profiles/repository-profile.ts`](../src/profiles/repository-profile.ts)、[`../src/skills/skill-candidates.ts`](../src/skills/skill-candidates.ts) |
| Agent Host | [`../src/integrations/agent-host/run.ts`](../src/integrations/agent-host/run.ts)、[`../src/integrations/agent-host/registry.ts`](../src/integrations/agent-host/registry.ts)、[`../src/integrations/opencode/adapter.ts`](../src/integrations/opencode/adapter.ts)、[`../src/integrations/claude/adapter.ts`](../src/integrations/claude/adapter.ts) |
| MCP | [`../src/mcp/server.ts`](../src/mcp/server.ts) |
| CLI | [`../src/cli/index.ts`](../src/cli/index.ts) |
| 发布 CLI 入口 | [`../src/cli/entry.ts`](../src/cli/entry.ts) |
| Agent 评测 | [`../src/eval/agent/runner.ts`](../src/eval/agent/runner.ts) |

## 7. 推荐阅读顺序

准备演示时：`01 -> 04 -> 05 -> 06`。
准备技术面试时：`01 -> 02 -> 03 -> 05 -> 07 -> 08`。
准备继续开发时：先读 `08`，再按其中路径进入源码和测试。

## 8. 重要限定

- RepoMind 不能被动观察 Agent 的任意文件、Shell 或测试工具，必须显式 Start/Commit，或由 Host-managed Adapter 代管。
- “Verified command”表示宿主提交的 `exitCode=0` 被保存，不表示 Core 独立重新执行了命令。
- 默认是本地 FTS5；Embedding 和远程 LLM 提取均为显式 opt-in。
- 当前跨 Agent 共享是同一用户数据目录、同一 Project ID 下的本机共享，不是云同步。
- RC.2 通过 GitHub Release 的 `.tgz` 安装；公开 npm 上无作用域的 `repomind` 属于其他项目，不能执行 `npm install -g repomind` 安装本仓库。
- `repomind run` 当前支持 OpenCode 与 Claude Code。两者共用同一 Host 生命周期和默认 `12,000` 字符 repository-context 预算，注入 current L3、相关 current L2 和按相关性排序的 L1；完整任务、生命周期说明、标题和信任边界说明不计入该预算，也不会被截断。
- 只有成功的 Host-managed Commit 会同步、best-effort 地维护 L2、尝试 L3、刷新 L4 候选。直接调用 Core、`repomind commit`、MCP/Agent-managed Commit 仍需显式 rebuild；partial、failed、abandoned Run 不执行派生层维护。
- 派生层维护失败独立写入 Run 报告，不回滚已经 committed 的 Session，也不把成功 Host Run 改判失败。没有 L3 来源时记为 skipped。
- L4 自动维护最多生成或刷新 pending Candidate；不会自动 approve、export、install 或 execute，人工审核边界不变。
- v0.8 的 72 次和 2026-08-04 RC 120 次实验仍是旧 L1-only Host 路径，不能把它们的数字归因于新实现。2026-08-11 的 120-stage OpenCode 跨 Session 正式实验实际 uplift 由 L1 注入承担；后续三阶段实验已证明 L2/L3 能在 L1=0 的第三 Session 被消费。最新 OpenCode -> Claude repeat 5 中 shared consumer 5/5、isolated 0/5，独立审计 14/14 通过；该证据仍只有一个任务类型，也不是双向四臂消融。
- 最新 18-run 三臂复核中 RepoMind 与 full-history 均为 hidden `6/6`；RepoMind 相对 full-history 没有稳定成本优势，input token 点估计高 `22.1%`。本轮 L2/L3 虽被发现，但因 provenance 去重未注入，实际上下文仍为 L1-dominant。
