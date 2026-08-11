# 08 源码阅读与重点掌握清单

## 1. 阅读目标

读完源码不应只知道“有哪些命令”，而应能完成四件事：

1. 从一次 Agent task 追到 Session、Evidence、Memory 和 FTS 的具体写入；
2. 解释检索、stale、conflict、governance 每个状态变化；
3. 对照通用 Agent Host、OpenCode/Claude Adapter 和 Eval Runner 解释效果指标从哪里来；
4. 指出当前实现边界，并能提出可落地的 Schema、事务和测试改进。

## 2. 仓库规模与入口

发布基线与冻结实验快照：

```text
Release baseline: v1.0.0-rc.1 / 05fe873136d578738b14e01edac6f2302e22a70c
Frozen current snapshot: 6d421ddab90d45a2747f1b25c2d270fb3c306e5e
Source: 75 TypeScript files / about 15,672 lines
Tests directory: 46 TypeScript files / 45 test-suite files / about 8,340 lines / 259 tests
Full Vitest: 45/45 files and 259/259 tests passed on 2026-08-11
Schema: 11
Snapshot additions: layered Host context, derived maintenance, marker path hardening, report v7, cross-session Eval, OpenCode/Claude Host adapters
```

先执行：

```powershell
Set-Location D:\data\code\project\repomind
git status --short
git rev-parse HEAD
node --version
npm.cmd run typecheck
npm.cmd run build
node .\dist\cli\index.js --help
```

这样先建立“当前代码能运行、CLI surface 是什么”的基线，再进入实现。

## 3. 推荐源码阅读顺序

### 阶段一：产品契约和架构决策

按顺序阅读：

1. [`../README.md`](../README.md)
2. [`../docs/architecture.md`](../docs/architecture.md)
3. [`../docs/memory-model.md`](../docs/memory-model.md)
4. [`../docs/adr/README.md`](../docs/adr/README.md)
5. ADR-001、002、003、004、005、006、007、008、009、010
6. [`../REPOMIND_FINAL_PRODUCT_SPEC.md`](../REPOMIND_FINAL_PRODUCT_SPEC.md)
7. [`../docs/release-readiness-v1.0.md`](../docs/release-readiness-v1.0.md)

目标：能够解释独立 Core、MCP-first 显式协议、SQLite Source of Truth、FTS-first、Evidence/Memory 分离、信号驱动状态、marker/data 分离、validated output 和 Git 边界。

注意：部分版本文档已经过时，例如 MCP 7 Tool、L4“未来层”等。以当前源码和 release-readiness 为准。

### 阶段二：身份、Schema 和事务

阅读：

1. [`../src/config/paths.ts`](../src/config/paths.ts)
2. [`../src/repository.ts`](../src/repository.ts)
3. [`../src/storage/migrations.ts`](../src/storage/migrations.ts)
4. [`../src/storage/database.ts`](../src/storage/database.ts)
5. [`../src/domain/types.ts`](../src/domain/types.ts)
6. [`../src/errors.ts`](../src/errors.ts)

必须回答：

- Project ID、checkout ID 和 DB path 如何得到；
- 为什么一个 Project 可以有多个 checkout；
- 11 个 Migration 各增加了什么；
- 哪些表是 Source of Truth，哪些是派生索引；
- `BEGIN IMMEDIATE` 与 SAVEPOINT 如何工作；
- Session/Memory/L4 状态的 TypeScript 与 SQL CHECK 是否一致；
- marker 为什么同时做 canonical UUID 和 DB path containment；它为何仍不是身份认证凭证。

### 阶段三：Core 生命周期

主文件：[`../src/core.ts`](../src/core.ts)。不要直接从第一行读到最后一行，按函数分组：

1. constructor/close；
2. `startSession`、`startSessionHybrid`；
3. `commitSession`；
4. `extractSession`；
5. `record`；
6. validate/correct/invalidate/forget；
7. search/searchHybrid/inspect；
8. review/applyReview/history；
9. L2/L3/L4 delegation 与 `maintainDerivedLayers`；
10. status/reindex；
11. Host Run；
12. private Evidence/Memory/stale/conflict helpers。

建议画出两条调用链：

```text
startSession
  -> inspectGit
  -> DB transaction(Session + Evidence)
  -> search + searchModuleNarratives + getRepositoryProfile

commitSession
  -> receipt check
  -> inspectGit + captureDiff
  -> DB transaction
       -> insertEvidence
       -> storeMemory
       -> conflict/file/FTS/audit
       -> close Session + receipt
```

阅读时专门标记事务边界：Git 在事务外，数据库多表更新在事务内。再思考两个并发进程 Commit 时会发生什么。

### 阶段四：检索与 Embedding

阅读：

1. [`../src/search/lexical.ts`](../src/search/lexical.ts)
2. [`../src/embedding/provider.ts`](../src/embedding/provider.ts)
3. [`../src/embedding/deterministic.ts`](../src/embedding/deterministic.ts)
4. [`../src/embedding/openai-compatible.ts`](../src/embedding/openai-compatible.ts)
5. [`../src/embedding/config.ts`](../src/embedding/config.ts)
6. [`../src/search/vector-index.ts`](../src/search/vector-index.ts)
7. 回到 Core 的 `search` 和 `searchHybrid`

必须自己计算一个 RRF 示例。假设 Memory A 的 lexical rank=1、vector rank=5：

```text
score(A) = 0.65 / 61 + 0.35 / 65
```

再与只在 vector rank=1 出现的 Memory B 比较，理解为什么两路共同命中通常更稳定。

### 阶段五：Git、脱敏和远程提取

阅读：

1. [`../src/git/git-inspector.ts`](../src/git/git-inspector.ts)
2. [`../src/security/redaction.ts`](../src/security/redaction.ts)
3. [`../src/extraction/prompt.ts`](../src/extraction/prompt.ts)
4. [`../src/extraction/schema.ts`](../src/extraction/schema.ts)
5. [`../src/extraction/runner.ts`](../src/extraction/runner.ts)
6. [`../src/extraction/openai-compatible.ts`](../src/extraction/openai-compatible.ts)
7. 回到 Core `extractSession`

重点追踪：

- 原始 task 在哪里脱敏、哪里又被用于 Hybrid Query；
- Git diff 的 64 KiB 与 Git stdout 1 MiB 是两种不同上限；
- sensitive path 是排除正文，还是连文件名也不可见；
- Remote Evidence 每条/总批次如何截断；
- 为什么模型请求发生在事务外；
- 为什么要先验证整个 Candidate batch；
- Schema 能防什么，不能防什么。

### 阶段六：L2/L3/L4

阅读：

1. [`../src/narratives/module-narratives.ts`](../src/narratives/module-narratives.ts)
2. [`../src/profiles/repository-profile.ts`](../src/profiles/repository-profile.ts)
3. [`../src/skills/skill-candidates.ts`](../src/skills/skill-candidates.ts)

建立对比表：

| 属性 | L2 | L3 | L4 |
| --- | --- | --- | --- |
| 来源 | active Evidence-backed 模块 L1 | 高置信稳定 L1 + current 模块来源 | committed Session 的成功 command/test |
| 默认门槛 | 无 confidence 门槛 | confidence >=0.8 | >=3 Session |
| 默认预算 | 4,000 chars | 6,000 chars | 结构化字段 |
| 版本历史 | 正文覆盖、version++ | 保存完整 versions | Audit + source fingerprint |
| Current/Review | source fingerprint current | source fingerprint current | pending/approved/rejected |
| 自动执行 | 否 | 否 | 否，只导出 |

重点验证 L4 的 `workflowSignature`：排序如何丢失顺序，任务语义为何没有进入分组。

### 阶段七：CLI、MCP 和 Host Adapter

阅读：

1. [`../src/cli/index.ts`](../src/cli/index.ts)
2. [`../src/cli/commit-input.ts`](../src/cli/commit-input.ts)
3. [`../src/mcp/server.ts`](../src/mcp/server.ts)
4. [`../src/integrations/agent-host/registry.ts`](../src/integrations/agent-host/registry.ts)
5. [`../src/integrations/agent-host/run.ts`](../src/integrations/agent-host/run.ts)
6. [`../src/integrations/opencode/adapter.ts`](../src/integrations/opencode/adapter.ts)
7. [`../src/integrations/claude/adapter.ts`](../src/integrations/claude/adapter.ts)
8. [`../src/integrations/claude/events.ts`](../src/integrations/claude/events.ts)
9. [`../src/integrations/opencode/context.ts`](../src/integrations/opencode/context.ts)
10. [`../src/integrations/opencode/lifecycle.ts`](../src/integrations/opencode/lifecycle.ts)

必须确认：

- CLI 有哪些能力不在 MCP；
- MCP 当前为何是 24 Tool；
- ID->repo path 映射为什么在 Server 重启后丢失；
- Registry 如何选择 OpenCode/Claude Adapter，二者如何设置权限与禁用 Agent-side RepoMind MCP；
- Host Prompt 如何过滤 current L2/L3、保留 L1 排名，并按 5:3:2 分配 `1,000-24,000` 字符预算；
- 为什么完整 task、生命周期说明和 framing 不计入 repository-context 预算；
- Windows 28,000 字符 Prompt guard、libuv quoting 估算和 32,767 字符完整命令行 guard 如何在 spawn 前 abandon Session；
- OpenCode 与 Claude 各有哪些 event 被识别为 Shell/Test，Claude 为何要求唯一 `tool_use`/`tool_result` 配对；
- timeout/spawn failure/nonzero exit 分别 Commit 还是 Abandon；
- successful/partial/failed/abandoned 中哪些触发派生层维护，失败为何不改变 Commit；
- `events.jsonl`、`stderr.log`、schema version 3 的 `run.json` 如何产生。

### 阶段八：Eval 与统计

阅读顺序：

1. [`../src/eval/agent/manifest.ts`](../src/eval/agent/manifest.ts)
2. [`../src/eval/agent/runner.ts`](../src/eval/agent/runner.ts)
3. [`../src/eval/agent/events.ts`](../src/eval/agent/events.ts)
4. [`../src/eval/agent/aggregate.ts`](../src/eval/agent/aggregate.ts)
5. [`../src/eval/agent/report.ts`](../src/eval/agent/report.ts)
6. [`../src/eval/agent/profile.ts`](../src/eval/agent/profile.ts)
7. [`../src/eval/comparison/`](../src/eval/comparison/)
8. [`../benchmarks/agent-suite/manifest.template.json`](../benchmarks/agent-suite/manifest.template.json)
9. [`../docs/agent-benchmark-results-v0.7.md`](../docs/agent-benchmark-results-v0.7.md)
10. [`../docs/agent-benchmark-results-v0.8.md`](../docs/agent-benchmark-results-v0.8.md)

重点追踪：

- fresh clone 和 isolated data dir；
- 当前 RepoMind arm 如何在 seed L1 后维护 L2/L3，以及为什么历史 v5 批次仍是 L1-only；
- arm schedule；
- hidden verifier 运行时机；
- Host Commit 为什么发生在 hidden check 前；
- integrity failure 与 hidden failure 的区别；
- pair key；
- relative delta、win/tie/loss 和区间；
- report schema v7 如何分开 `commitMs` 与 `maintenanceMs/status`、保存 L1-L3 telemetry，strict 为何把维护失败视为实验完整性问题；legacy v6 又缺少哪些字段；
- v0.7 为什么失败；
- 120 次证书故障为什么使整批不正式。

## 4. 功能与测试映射

| 能力 | 先看测试 |
| --- | --- |
| 初始化/仓库隔离 | `bootstrap.test.ts`、`repository.test.ts` |
| Session/Commit/幂等 | `core.test.ts`、`e2e.test.ts` |
| CLI Commit Schema | `commit-input.test.ts` |
| FTS/CJK | `lexical.test.ts` |
| Vector/Fallback | `vector.test.ts` |
| Stale/racy window | `stale-performance.test.ts`、`reactivation.test.ts` |
| Conflict | `conflict.test.ts` |
| Governance/Forget | `review.test.ts`、`forget.test.ts` |
| Remote Extraction | `extraction*.test.ts`、`remote-extraction-runner.test.ts` |
| L2 | `module-narrative.test.ts`、`layered-benchmark.test.ts` |
| L3 | `repository-profile.test.ts` |
| L4 | `skill-candidate*.test.ts` |
| MCP | `mcp.test.ts`、`mcp-stdio.test.ts` |
| Host 分层上下文 | `host-context.test.ts` |
| 派生层维护 | `derived-maintenance.test.ts`、`host-run.test.ts` |
| Host Run | `host-run.test.ts`、`host-acceptance.test.ts` |
| Agent Eval | `agent-eval.test.ts`、`agent-profile.test.ts` |
| Portability | `portability*.test.ts`、`encrypted-portability.test.ts` |
| Migration | `migration.test.ts`、released schema fixture |

建议先读测试描述，再回源码。测试名往往比实现更清楚地表达契约和边界。

## 5. 必做动手练习

### 练习 A：完整生命周期

1. 新建临时 Git 仓库；
2. init；
3. Start；
4. 修改 tracked file；
5. 提交一个成功 test result；
6. Commit；
7. Search solution/command；
8. Inspect Evidence；
9. 重用同 idempotency key；
10. 修改 payload 后再次重用，确认被拒绝。

掌握点：事务、Evidence 绑定、确定性提取和幂等。

### 练习 B：Stale

1. `record --related-files`；
2. Search 确认 active；
3. 修改文件但保持大小尽量相同；
4. 立即 Search，确认两秒窗口仍能发现 hash 变化；
5. Validate；
6. 删除文件，确认 deleted reason。

掌握点：metadata fast path、racy-mtime、uncertain warning。

### 练习 C：Conflict 与治理

1. 同 type/scope/title 记录两个不同内容；
2. Inspect 双方 relation；
3. Validate 一方；
4. Invalidate 另一方；
5. 确认剩余状态；
6. Correct 一个 Memory；
7. Forget retired Memory。

掌握点：启发式边界、supersedes/contradicts、tombstone。

### 练习 D：Hybrid Fallback

1. 不配置 Provider 运行 Search，查看 fallback reason；
2. 使用 deterministic Provider；
3. vector-reindex；
4. 用同义表达查询；
5. 模拟错误维度或 Provider failure；
6. 确认仍返回 FTS。

掌握点：derived cache、RRF、graceful degradation。

### 练习 E：L2/L3/L4

1. 为多个模块记录 Evidence-backed L1；
2. rebuild L2 并 Inspect sources；
3. rebuild L3 并查看 versions；
4. 修改高置信来源，确认 L3 non-current；
5. 创建三个相同成功 workflow Session；
6. rebuild L4；
7. approve/export；
8. 加第四个来源，确认回 pending。

掌握点：来源指纹、Host-only 自动维护与其他入口显式 rebuild 的边界、best-effort 失败隔离、L4 review boundary。

### 练习 F：真实跨 Session Agent

用同一真实仓库执行两个相关 `repomind run`：

- 第一次生成可复用 solution/command；
- 第二次确认 retrievedMemories > 0；
- 对照 `events.jsonl` 和 `run.json`；
- 检查 context 的 L1/L2/L3 injected/truncated/omitted 和完整 task；
- 检查成功 Commit 的 maintenance，并模拟/观察无 L3 source 的 skipped；
- 确认 Agent 内 RepoMind call 为 0；
- 确认无 open Session。

掌握点：Host-managed lifecycle 和实际 uplift 的最小闭环。

## 6. 三层掌握标准

### Level 1：能介绍

```text
[ ] 1 分钟项目介绍
[ ] 画总体架构和 Session 时序
[ ] 解释 Evidence/Memory 与 L0-L4
[ ] 说清 Host-managed 的价值
[ ] 准确引用 v0.8 正式结果
```

### Level 2：能追源码

```text
[ ] 能从 CLI/MCP 追到 Core 和 SQL
[ ] 能解释 Commit 事务边界
[ ] 能手算 RRF
[ ] 能解释 stale/conflict 状态变化
[ ] 能指出 L2/L3/L4 current/source fingerprint
[ ] 能解释 Eval 的配对与完整性规则
```

### Level 3：能改项目

```text
[ ] 能新增 Migration 并保持 released schema 升级测试
[ ] 能新增 MCP Tool 而不复制业务规则
[ ] 能修并发 Commit CAS 并写跨进程测试
[ ] 能修改 Host 分层预算分配且保持 task 永不截断，并设计 layered-vs-L1-only A/B 门槛
[ ] 能解释已完成的 marker UUID/containment hardening，并继续修 symlink/合法 ID 身份边界
[ ] 能扩展或重试 Host 派生层维护而不破坏 Commit 成功语义和 L4 人工审核
[ ] 能扩展公开仓库、多模型预注册实验
```

## 7. 自测问题

1. 为什么 Agent summary 是 Evidence，却不等于客观证明？
2. Decision、Command、Solution 的 Evidence 绑定有什么差异？
3. Commit receipt 为什么不能完全解决并发提交？
4. FTS query 为什么使用 OR；这会带来什么副作用？
5. 什么查询会触发 substring fallback？
6. Provider 在生成第 65 条 embedding 时失败，前 64 条会落库吗？
7. 文件 hash 恢复后为什么不自动 active？
8. 两条真实矛盾但 title 不同的 Memory 会怎样？
9. final worktree clean 时 related files 为什么可能为空？
10. L2 与 L3 的版本保留有什么区别？
11. 低置信 L1 改变为什么不使 L3 stale？
12. L4 为什么会把不同语义任务误归组？
13. Host-managed 为什么检测 Agent-side RepoMind Tool Call？
14. Hidden verifier 为什么必须放在任务仓库外？
15. 120 次实验为什么不能以 40/40 直接写“正式通过”？
16. 10k Hybrid 为什么不代表远程向量表现？
17. Logical Import 和 Physical Restore 的身份语义有何不同？
18. Archive 加密为什么不等于数据库加密？
19. marker UUID 与 containment 已经阻止什么攻击，为什么仍不能把 marker 当认证凭证？
20. 为什么 Host context budget 不包含 task 和 lifecycle framing？
21. 某次 L2 maintenance 失败时，L3/L4、Session 和 Host Run 分别应是什么状态？
22. 为什么自动刷新 L4 不能顺便 approve/export？
23. 如何让 branch-aware Memory 不破坏共享项目事实？

参考答案分散在 [02](02-core-data-model-and-memory-principles.md)、[03](03-layered-memory-search-and-governance.md)、[05](05-testing-evaluation-and-results.md)、[06](06-engineering-highlights-limitations-and-roadmap.md) 和 [07](07-interview-questions-and-answers.md)。

## 8. 面试前压缩复习法

### 第一天：架构和数据

- 手画总体架构、Session、Memory 状态机；
- 阅读 Core Start/Commit/storeMemory；
- 复述 Evidence 信任层级和 Schema 表。

### 第二天：算法和集成

- 手算 RRF；
- 复述 CJK/identifier/stale/conflict；
- 对比 L2/L3/L4；
- 从 `repomind run` 追到 Host Prompt 和 Commit。

### 第三天：实验和质疑

- 背熟 v0.7 失败原因、v0.8 正式数字、120 次边界；
- 解释三臂、fresh clone、hidden、integrity；
- 准备三个不足和三个改进，不回避限制。

最终目标不是背 API，而是能把“设计 -> 实现 -> 证据 -> 限制 -> 改进”连成一条完整技术叙事。
