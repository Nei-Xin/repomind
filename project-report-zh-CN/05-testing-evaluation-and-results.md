# 05 测试、评测与效果分析

> **2026-08-11 更新**：冻结提交 `6d421dd` 已完成新的跨 Session `6 sequences × 2 arms × 2 stages × 5 repeats = 120` 次 OpenCode/Luna 正式实验，correctness、efficiency 与独立审计均通过。本文保留此前的历史实验和设计推导；旧版 L1-only 结果与当前 Host 结果的证据边界，以 [第 10 篇正式实验报告](10-cross-session-formal-experiment-20260811.md) 为准。

## 1. “项目有效”需要拆成哪些问题

RepoMind 的效果不能用“Agent 看起来回答得更好”证明，至少要分别回答：

1. **实现正确性**：状态机、事务、Schema、检索、恢复是否按契约工作；
2. **Agent 正确率**：有 Memory 时是否更容易通过仓库外隐藏检查；
3. **效率**：耗时、输入/输出 Token、文件读取、轮次、工具调用是否下降；
4. **生命周期完整性**：Session 是否成功检索、提交、关闭，有无跨实验臂污染；
5. **规模**：10,000 条 L1 时性能是否仍可接受；
6. **跨 Agent**：不同宿主是否真的能延续同一项目知识；
7. **数据安全**：错误密码、归档篡改、非法远程输出是否零写入；
8. **外部效度**：结果是否只对作者设计的小 fixture 成立。

本项目的亮点之一，是把这些问题拆成不同测试和 acceptance，而不是用单一单测通过率代替产品效果。

## 2. 测试体系

| 层级 | 验证目标 | 示例 |
| --- | --- | --- |
| 单元测试 | tokenizer、Schema、统计、状态转换 | `lexical.test.ts`、`comparison.test.ts` |
| Core 集成测试 | Session、Evidence、Memory、conflict、vector | `core.test.ts`、`vector.test.ts` |
| 跨进程 E2E | 真 CLI 进程、stdio MCP、持久数据库 | `e2e.test.ts`、`mcp-stdio.test.ts` |
| Runner smoke | 评测 runner 自身不会生成伪报告 | scale/L4 runner tests |
| 固定提交 Acceptance | L2/L3/L4、10k、恢复、远程提取 | `benchmarks/` 脚本 |
| 真实 Agent Acceptance | OpenCode、Claude Code、跨 Session/Agent | `docs/*acceptance*.md` |

### 2.1 已提交 RC 的历史测试基线

此前审计在 `v1.0.0-rc.1`、commit `05fe873136d578738b14e01edac6f2302e22a70c` 上执行：

```powershell
npm test
npx vitest list
```

结果：

```text
Test Files: 39 passed / 39
Tests:      174 passed / 174
Duration:   about 229.5 s
```

当时 `vitest list` 也枚举出 174 个测试，说明该次报告数量与实际发现数量一致。日志中的 `node:sqlite` experimental warning 和 Windows LF/CRLF warning 不是失败。

这组 `39/174` 是**已提交 RC 的历史基线**，不能继续写成包含当前未提交改动的测试结果。

### 2.2 当前开发工作树验证状态（2026-08-10）

2026-08-10 审计时的工作树加入了 Host 分层上下文预算、成功 Commit 后的 L2/L3/L4 派生维护、Host Run 诊断信息和 Agent eval schema v6。它与上面的 RC 基线不是同一份代码快照；随后冻结的 `6d421dd` 已把 Agent report 推进到 v7，并增加逐层上下文 telemetry 与通用 Host Adapter。

| 检查 | 当前观察 | 可以得出的结论 |
| --- | --- | --- |
| `npx vitest list` | 41 个 test suites、202 个测试定义 | 这是当前测试库存；通过结论仍需完整运行 |
| 第一轮 focused regression | 26/26 通过 | 新增 Host context、维护和相关集成路径的定向检查通过 |
| 扩展 focused regression（含 `agent-eval`） | 42/42 通过 | 当时的 maintenance/report v6、Host L3 prompt 和相关定向路径通过；8-task 的 L2/L3 逐项注入由另行通过的 Host acceptance 覆盖 |
| 最终审计修复聚焦回归 | 6 files、49/49 通过 | realpath、dangling link、失败命令、零 L1、并发目录、Windows argv、结构注入与 Eval Runner 门禁 |
| `npm run typecheck` | 通过 | 当前 TypeScript 类型检查通过 |
| `npm run build` | 通过 | 当前源码能够完成构建 |
| 2026-08-10 最终完整 `npm test` | 41/41 test files、202/202 tests 通过；exit 0；约 258.9 秒 | 当时工作树的完整测试套件全绿 |
| 2026-08-11 冻结版本复核 | 45/45 test files、259/259 tests 通过；exit 0；约 414.9 秒 | 通用 Host Adapter、Claude、cross-session Eval 与 report v7 纳入后仍全绿 |

验证过程并非一次全绿：较早的完整回归暴露 2 项 Windows junction 路径失败，随后 Agent profile v6 兼容 fixture 又暴露 1 项失败。继续深审还发现并修复了 related-file realpath、失败非测试命令误判、Host data directory 并发、Windows quote expansion、伪 Host 标题、dangling SQLite link 和零 L1 语义。日常 Host 与正式 Eval Runner 也已统一为“全部观察命令成功且无 Agent-side RepoMind 调用”才可 success。对应聚焦测试通过后，2026-08-10 从当时工作树重新执行完整套件并取得 202/202；功能继续推进后，2026-08-11 又从当前版本完整重跑并取得 259/259，退出码 0。

### 2.3 覆盖率

仓库现有 `coverage/coverage-summary.json` 对应此前 RC 测试快照：

| 指标 | 现有结果 | CI 全局门槛 |
| --- | ---: | ---: |
| Statements | 83.80% | 80% |
| Branches | 77.73% | 75% |
| Functions | 95.20% | 90% |
| Lines | 83.80% | 80% |

门槛定义在 [`../vitest.config.ts`](../vitest.config.ts)。这是聚合覆盖率，不等于每个模块充分覆盖：例如 CLI 源入口的源码覆盖显示很低或为 0，主要依靠编译后跨进程测试；Embedding 配置等小模块也存在薄弱区域。由于当前工作树新增了 context renderer、派生维护和报告字段，这份旧 summary 不能证明新增代码已经达到同样覆盖率，需重新运行 `npm run test:coverage`。

### 2.4 CI

[`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) 包含：

- Ubuntu、Windows、macOS：install、typecheck、build、test、8-task fixture validator、installed-package smoke；
- Ubuntu coverage job；
- 独立 deterministic comparison benchmark job；
- 产物上传。

当前 release 文档明确记录了 v0.18 tag 的五个 CI job 通过，以及 RC 的本地 pre-commit 准备结果；没有记录 RC tag 自身的 Actions run ID，因此不应凭推断声称“RC tag CI 已正式通过”。

### 2.5 Agent report v6 -> v7 向后兼容审计

当前 `loadAgentReport()` 接受 schema v4、v5、v6、v7，但这不是一次完整的旧报告迁移：它只检查版本、`runs` 数组和 `provenance` 是否存在，然后把结果视为当前 `AgentEvalReport`。因此要区分“旧报告能被特定分析器消费”和“旧报告已具备 v7 的全部字段及语义”。

本轮直接读取 RC 的真实 v5 产物：

```text
D:\data\code\project\repomind-test\uplift-v1-preflight-20260804-01\results-repeat-5-luna-retry-2\summary.json
```

观察结果：

| 操作 | 结果 | 解释 |
| --- | --- | --- |
| `loadAgentReport` + `aggregateAgentReports` | 成功读取 120 runs；no-memory 配对数 40；Aggregate Integrity 保持 failed | 聚合兼容 v4-v7 的共有 checks、event metrics、provenance 和时间字段；v4 的时间可回退到 `wallDurationMs` |
| `profileAgentReport` | 成功分析 120 runs，没有因 maintenance 字段缺失产生 `NaN` 或崩溃 | Integrity 仍因源报告失败和证书故障对应的未完成 raw step 而失败，这是预期保留，不是兼容误判 |
| `renderAgentMarkdown(loadAgentReport(v5).report)` | `TypeError: Cannot read properties of undefined (reading 'toFixed')` | 当前 v7 renderer 仍直接读取旧报告没有的字段；2026-08-11 已用真实 v5 再次复现，直接渲染不兼容 |

因此当前兼容边界是：**CLI 的 aggregate/profile 路径可以消费已审计的真实 v5，v4 聚合也有定向测试；旧报告不能直接交给 v7 单报告 renderer。**另外，加载器不会用 v7 的 maintenance/context 规则重算旧报告 Integrity，而是保留源报告结论。这避免把旧 v5 因“没有新字段”误判失败，但也意味着“旧报告 Integrity passed”不代表它满足 v7 的派生维护与分层 telemetry 契约。

现有聚合测试名称声称覆盖 v4/v5，但测试数据实际是一份降级为 v4 的报告加一份当前 v7 报告，没有显式构造缺失 maintenance 字段的 v5。建议后续加入真实 v5 fixture、嵌套字段校验和显式 migration/normalization，并让 renderer 对旧字段输出 `n/a` 或拒绝旧版本，而不是运行到 `toFixed` 才失败。

## 3. 三臂真实 Agent 实验

### 3.1 实验臂

| 实验臂 | Agent 获得的历史知识 | 用途 |
| --- | --- | --- |
| no-memory | 无历史；仍可正常读当前仓库 | 测量从零探索的基线 |
| full-history | 原始历史直接注入 Prompt | 测量完整历史的正确率与上下文成本 |
| RepoMind | 只注入检索到的 Evidence-backed Memory | 测量筛选记忆的正确率与效率 |

full-history 不是刻意做弱的 strawman。它在正式实验中达到 100% 隐藏正确率；RepoMind 的目标是用更短、更受治理的上下文匹配它。

### 3.2 八类任务

| Task | 要验证的历史知识 |
| --- | --- |
| `renamed-module` | 模块已经迁移到新位置 |
| `failed-solution` | 历史失败方案与真正解法 |
| `migration-rollback` | migration 必须实现 rollback |
| `historical-command` | 非显然的正确验证命令 |
| `stale-endpoint` | 历史端点已变更 |
| `error-contract` | 错误类型/返回契约 |
| `dependency-boundary` | 依赖边界约束 |
| `config-default` | 历史默认值约定 |

这些任务有意要求“当前代码不足以稳定恢复的历史信息”，因为这正是仓库记忆的目标场景。它也带来选择偏差，后文会单独讨论。

### 3.3 实验控制

每个 `task × arm × iteration`：

1. 创建独立 clone；
2. checkout manifest 固定 commit；
3. 使用隔离的 RepoMind data directory；
4. OpenCode 使用 `--pure`；
5. 禁用委派和后台 Agent；
6. 三种循环顺序轮换实验臂，降低时段/顺序偏差；
7. 使用同一 model、timeout、任务文本和 verifier；
8. 公开/隐藏检查在 Agent 和 RepoMind Commit 后独立执行；
9. 隐藏 verifier 位于任务仓库外；
10. 结果只按相同 task + iteration 配对。

### 3.4 Integrity 与 Acceptance 分开

这是实验设计中最重要的严谨性规则：

- **隐藏检查失败**：是合法的能力结果，不自动破坏实验；
- **Agent 异常退出、错误 base commit、越界文件修改、跨臂 MCP 污染、Session 未闭合**：破坏完整性；
- 只有 Integrity 通过后，正确率和效率 Acceptance 才能称正式结果。

预先声明门槛包括：RepoMind hidden pass rate、相对基线差值、retrieval/commit rate、最大耗时回归、至少一个效率指标改善、指定历史任务必须胜出。

### 3.5 历史 Agent 实验的功能边界：仅 L1

v0.7、v0.8 的 72 次实验，以及 RC 的 120 次实验，RepoMind 实验臂都只向 Agent 注入 Start 检索得到的排序 L1 Memory。当时的 Host prompt 尚未接入 current L2 Module Narrative、current L3 Repository Profile，也没有成功 Commit 后自动执行 L2/L3/L4 maintenance。

因此这些实验能支持的结论是“**Host-managed、Evidence-backed L1 检索**相对 no-memory/full-history 的效果”，不能被重新解释为：

- L1+L2+L3 分层上下文已经提升真实 Agent 正确率或效率；
- 自动派生维护已经改善下一次 Session；
- maintenance 的额外耗时已包含在旧实验的独立指标中。

仓库已有 L2、L3、L4 的固定提交 Acceptance，证明的是各能力本身按门禁工作；它们不是 Agent uplift 对照实验。

## 4. 迭代结果：为什么 Host-managed 是关键创新

### 4.1 v0.6：两臂 24 次

4 任务 × 2 臂 × 3 次：

- RepoMind hidden `12/12`；
- no-memory `9/12`；
- 输入 Token `-26.554%`；
- 文件读取 `-15.556%`；
- 耗时 `+4.995%`。

它提供早期能力信号，但任务数和实验臂不足。

### 4.2 v0.7：Agent-managed 72 次，正式失败

8 × 3 × 3：

| 指标 | no-memory | full-history | RepoMind |
| --- | ---: | ---: | ---: |
| Hidden | 12/24 | 24/24 | 24/24 |

RepoMind 正确率达到 full-history，但相对 full-history 慢 `39.713%`，超过预声明的 15% 最大回归，Outcome Acceptance 失败。

原因主要是模型要主动：

- 调用 Start；
- 处理 MCP 响应；
- 任务末构造 Commit payload；
- 再完成额外模型轮次。

这次负面结果很有价值：它说明数据库操作本身不是唯一成本，协议放在模型循环内会放大延迟和 Token。

### 4.3 v0.8：Host-managed 72 次，正式通过

Host 在模型外完成 Start/Commit 后：

| 指标 | no-memory | full-history | RepoMind |
| --- | ---: | ---: | ---: |
| Agent clean exit | 24/24 | 24/24 | 24/24 |
| Public checks | 24/24 | 24/24 | 24/24 |
| Hidden checks | 12/24 | 24/24 | 24/24 |
| 平均总耗时 | 64.675 s | 44.705 s | 39.023 s |
| 平均输入 Token | 6,814 | 5,335 | 4,650 |
| 平均输出 Token | 1,068 | 802 | 664 |
| 平均文件读取 | 3.667 | 2.750 | 2.667 |
| Agent turns | 9.417 | 7.333 | 6.250 |
| Agent tool calls | 13.083 | 9.667 | 7.958 |

RepoMind 相对 no-memory：

| 指标 | 变化 |
| --- | ---: |
| Hidden success | +50 percentage points |
| Wall time | -39.663% |
| Input Token | -31.761% |
| Output Token | -37.803% |
| File reads | -27.273% |

RepoMind 相对 full-history：

| 指标 | 变化 |
| --- | ---: |
| Hidden success | 相同，24/24 |
| Wall time | -12.711% |
| Input Token | -12.849% |
| Output Token | -17.211% |
| Agent turns | -14.773% |
| Agent tool calls | -17.672% |

Host Start + Commit 平均 737.297 ms，占总生命周期 1.89%；24/24 成功检索和提交，0 个 open Session。这里的 Commit 阶段不包含当前工作树后来增加的自动 maintenance。

正式结论：在这 8 个固定任务、该模型、OpenCode 版本和 Windows 环境中，RepoMind 用筛选 L1 达到 full-history 的正确率，同时明显优于 no-memory 的正确率和效率。

v0.7/v0.8 是不同批次、不同 OpenCode 版本，二者之间的差值只能用于架构诊断，不是严格的跨批因果估计。v0.8 的正式结论来自同批配对。

## 5. RC 的 120 次 Luna 实验

### 5.1 配置

```text
RepoMind: 1.0.0-rc.1
Commit: 05fe873136d578738b14e01edac6f2302e22a70c
OpenCode: 1.18.12
Model: cliproxyapi/gpt-5.6-luna
Lifecycle: host-managed
Injected repository context: ranked L1 only
Automatic derived maintenance: not present in this historical run
Runs: 8 tasks × 3 arms × 5 repeats = 120
Wall duration: 7,938,311 ms (about 2 h 12 m 18 s)
```

产物保存在仓库外：

```text
D:\data\code\project\repomind-test\uplift-v1-preflight-20260804-01
```

### 5.2 严格结论

```text
Integrity: FAILED
Acceptance: failed
```

唯一完整性故障：`failed-solution/full-history-1` 在模型调用时发生 `unknown certificate verification error`，Agent exit 1。

这个故障不是解题错误，但实验规则必须把非零退出判为完整性失败。不能只替换这一条样本后宣称整批通过，因为事后替换会破坏预先声明的调度、配对和可审计性。

### 5.3 描述性观察

| Arm | Hidden | Pass rate | Clean exit | Public |
| --- | ---: | ---: | ---: | ---: |
| no-memory | 29/40 | 72.5% | 40/40 | 40/40 |
| full-history | 39/40 | 97.5% | 39/40 | 40/40 |
| RepoMind | 40/40 | 100% | 40/40 | 40/40 |

RepoMind 相对 no-memory：

| 指标 | no-memory | RepoMind | 变化 |
| --- | ---: | ---: | ---: |
| 平均总耗时 | 78,329 ms | 58,616 ms | -25.167% |
| Agent 可观察耗时 | 67,066 ms | 46,320 ms | -30.933% |
| Agent turns | 10.975 | 9.650 | -12.073% |
| Tool calls | 17.300 | 13.475 | -22.110% |
| Input Token | 20,064 | 16,773 | -16.405% |
| Output Token | 1,340 | 1,101 | -17.841% |
| Cache-read Token | 58,189 | 34,266 | -41.113% |
| File reads | 4.050 | 2.850 | -29.630% |

40 个 RepoMind Run 全部成功检索、Commit，结束后 0 个 open Session。平均 Start 228.395 ms，Commit 471.253 ms。

### 5.4 分任务 Hidden

| Task | no-memory | full-history | RepoMind |
| --- | ---: | ---: | ---: |
| renamed-module | 5/5 | 5/5 | 5/5 |
| failed-solution | 5/5 | 4/5（证书故障） | 5/5 |
| migration-rollback | 5/5 | 5/5 | 5/5 |
| historical-command | 2/5 | 5/5 | 5/5 |
| stale-endpoint | 0/5 | 5/5 | 5/5 |
| error-contract | 4/5 | 5/5 | 5/5 |
| dependency-boundary | 5/5 | 5/5 | 5/5 |
| config-default | 3/5 | 5/5 | 5/5 |

收益集中在历史知识确实必要的任务，而不是所有任务都平均提升。这符合产品目标，也提醒用户：对完全能从当前代码解决的任务，Memory 可能没有明显价值。

### 5.5 敏感性分析

排除证书故障及对应 RepoMind 配对后：

| 指标 | full-history | RepoMind | 变化 |
| --- | ---: | ---: | ---: |
| Hidden | 39/39 | 39/39 | 相同 |
| 平均耗时 | 60,754 ms | 58,570 ms | -3.595% |
| Input Token | 15,935 | 16,574 | +4.013% |
| Output Token | 1,125 | 1,090 | -3.082% |
| File reads | 3.128 | 2.846 | -9.016% |

因此不能声称 RC 120 次实验中 RepoMind 全面优于 full-history。更准确的说法是：它在无基础设施故障的配对中匹配 full-history 正确率，文件读取更少、耗时略低，但输入 Token 高 4.013%。

### 5.6 可采用表述

> RC 的 120 次实验因 1 次外部证书错误未通过严格完整性门槛；描述性结果中，RepoMind 在 40 次运行里全部通过隐藏检查，并相对 no-memory 降低约 25.2% 总耗时、16.4% 输入 Token 和 29.6% 文件读取。排除故障配对后，RepoMind 与 full-history 都为 39/39，不能据此声称能力高于完整历史。

## 6. 外部真实仓库 p-limit

在 `sindresorhus/p-limit` 的外部仓库实验中：

1. Claude Code 产生前序 Memory；
2. fresh-context OpenCode 执行 no-memory / RepoMind 配对；
3. 共 3 个任务对；
4. 两臂全部通过公开和隐藏检查。

观察到 RepoMind：

- uncached/raw input Token `-41.1%`；
- Agent duration `-17.5%`；
- 文件读取没有改善。

该历史产物没有当前 schema 的 cache-read/cache-write/total-prompt 分解，也没有 provider 价格加权，因此不能把 `-41.1%` 写成总 Prompt 或货币成本下降。

这比纯作者 fixture 更接近真实跨 Agent 使用，但仍只有一个仓库、三个配对，不能推广到所有开源项目。

## 7. 其他正式 Acceptance

| 能力 | 结果 | 说明 |
| --- | --- | --- |
| 10,000 L1 | 19/19 gates | FTS hit P95 80.363 ms；Hybrid P95 302.774 ms；Inspect 0.891 ms；Start 621.154 ms；CLI cold start 374.829 ms |
| L2 | 全部门槛通过 | 13 reviewed L1、6 个真实模块、来源追踪、预算、stale、定向 rebuild、搜索和注入 |
| L3 | 15 gates | 低置信变化不使 Profile stale；高置信来源变化停止注入；rebuild 保留 v1/v2 |
| L4 deterministic | 20 gates | 至少三次成功 Session；排除 failed/partial/command-free；审批后导出；新来源重置 pending |
| L4 cross-Agent | 17/17 | OpenCode 产生来源，Claude Code 审批/导出，新 OpenCode 来源触发 pending |
| Remote Extraction | 13/13 | 9 场景；recall/precision 1.0；P50 9.565 s、P95 12.669 s；非法结构/伪造 Evidence/取消零写入 |
| 普通可移植性 | 通过 | replace import、同 Project restore、损坏拒绝、rollback snapshot、FTS rebuild |
| 加密可移植性 | 29/29 | 错误密码、篡改、purpose mismatch 零写入；临时明文清理 |
| Installed package | 14 checks | 真实 tarball、CLI、恢复、24 项 MCP Tool |

10k Hybrid 使用离线 deterministic cached vector，不代表远程 Embedding 的延迟、成本或语义质量。

### 7.1 Harness 实现验证与 2026-08-11 正式结果衔接

当前工作树已经推进到下一代评测接线：

1. `seedRepoMind` 在写入 fixture L1 后调用派生维护，使 Agent eval 的 fresh data directory 能产生可用的 L2/L3；
2. Host-managed prompt 接入 current L3、相关 current L2 和排序 L1，并实施总 repository-context 字符预算；
3. Agent eval schema v6 先拆分 `commitMs`、`maintenanceMs` 与 maintenance attempted/status；当前 v7 又增加 L1/L2/L3 检索、注入、预算、质量和派生层快照 telemetry；
4. maintenance 为 `partial` 或 `failed` 时进入 Integrity failure，而不是静默混入成功报告。

本轮还在系统临时目录中对正式 manifest 的 8 个 fixture 逐一执行了“复制仓库 -> Git commit -> 写入预置 Memory -> 派生维护 -> Start 检索”，结束后删除临时目录。结果如下：

| 运行时检查 | 观察结果 |
| --- | ---: |
| maintenance status | success 8/8 |
| L2 创建 | 每个任务 1-2 个，共 11 个 |
| Start 实际检索到 L2 | 8/8；每个任务 1-2 个，共 11 个 |
| current L3 已创建并由 Start 返回 | 8/8 |
| L1 检索 | 8/8；每个任务 1 条 |

这说明正式 8-task fixture 在当前实现中确实能形成并检索 L1/L2/L3，而不只是调用了一个空 maintenance。`location` 和 `failure` 不属于 L3 的直接 stable-memory 类型，但仍可通过各自的 current L2 module source 进入 L3；不能表述成“所有 L1 类型都会直接进入 L3”。

自动化覆盖也已同步补齐：daily Host acceptance 的 `seedTask()` 会在首次 Start 前执行派生维护，maintenance 为 `partial`/`failed` 时直接拒绝该任务；8-task Host acceptance 测试逐项断言最终 Host context 的 `l2.injected >= 1`、`l3.injected === 1`。因此“正式 fixture 首轮只有 L1”已经不再是当前实现的限制。上表记录的是 Core Start 检索结果，可能返回 1-2 个 L2；Host acceptance 断言的是经过上下文选择和预算后的最终注入数量，两者口径不同。

仍有两个实现边界：

1. 自定义 manifest 若既没有 `relatedFiles`/module scope，Memory 类型又不属于稳定 L3 类型，派生维护可以合法 `skipped`；runner 只拒绝 `partial`/`failed`，不会保证每个任务一定有 L2/L3；
2. legacy Agent eval v6 只持久化 `retrievedMemories`（L1 数量）；当前 Agent report v7 和 cross-session report v3 都已保存 L1/L2/L3 的 provided/eligible/injected/deduplicated ID、数量和字符数，使本轮能够确认 uplift 实际由 L1 承担。

在 2026-08-10 的原审计时点，这些仍只是**实现和 wiring 验证**。2026-08-11 的新跨 Session 正式批次已证明 shared L1 在该 fixture 中带来正确率和总体效率 uplift，并证明 L2/L3 自动维护与 provenance 去重真实运行；但因为 consumer start 时 L2 为 0、L3 全被 L1 去重，它仍没有证明 L2/L3 的独立增量作用。

## 8. 如何复现项目验证

### 8.1 基础验证

```powershell
Set-Location D:\data\code\project\repomind
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run test:coverage
npm.cmd run bench:agent-fixtures
npm.cmd run bench
```

`bench` 是 deterministic comparison，不调用真实 Agent；它验证检索臂、预算和统计管道。

### 8.2 创建全新 Agent 实验套件

```powershell
node .\benchmarks\agent-suite\create.mjs D:\data\code\project\repomind-test\new-agent-suite
```

检查并冻结：

- base commit；
- model；
- OpenCode version；
- manifest hash；
- acceptance threshold；
- hidden verifier 在目标仓库外；
- 输出目录不存在。

### 8.3 运行 5 次重复

```powershell
node .\dist\cli\index.js eval `
  --agent `
  --manifest D:\data\code\project\repomind-test\new-agent-suite\manifest.json `
  --runner opencode `
  --model <available-model-id> `
  --lifecycle host-managed `
  --repeat 5 `
  --output D:\data\code\project\repomind-test\new-agent-results `
  --strict `
  --require-acceptance `
  --json
```

输出目录必须全新。失败后保留原目录，不要覆盖、补写或把部分样本并入另一批正式实验。

### 8.4 其他验收

```powershell
npm.cmd run bench:l2-real -- --repo . --workspace D:\fresh\l2 --repeat 50
npm.cmd run bench:l3-real -- --repo . --workspace D:\fresh\l3 --repeat 50
npm.cmd run bench:scale-10k -- --repo . --workspace D:\fresh\scale --commit HEAD --repeat 50
npm.cmd run bench:l4-real -- --repo . --workspace D:\fresh\l4 --commit HEAD --repeat 20
npm.cmd run bench:remote-extraction -- --repo . --workspace D:\fresh\remote --commit HEAD --mock
npm.cmd run bench:portability-real -- --repo . --workspace D:\fresh\recovery --commit HEAD --repeat 10
npm.cmd run bench:package-smoke -- --workspace D:\fresh\package
```

## 9. 为新仓库设计 Uplift 实验

### 9.1 假设

建议预注册两个主假设：

```text
H1 正确率：RepoMind hidden pass rate >= no-memory。
H2 效率：在正确率不下降的前提下，RepoMind 的 total-prompt Token、耗时或文件读取至少一项改善。
```

把 full-history 作为参考臂：希望 RepoMind 正确率不低于它，同时上下文成本不显著更差。

### 9.2 任务选择

任务应覆盖：

- 需要历史信息；
- 不需要历史信息；
- Memory 已陈旧；
- 历史包含失败方案；
- 精确命令/路径；
- 架构约束；
- 冲突历史；
- 无相关 Memory 的负对照。

不要只选择 RepoMind 明显占优的任务。至少加入一组“当前代码足够解决”的任务，测量不必要注入的成本。

### 9.3 指标

主指标：

- hidden success；
- integrity pass；
- Session retrieval/commit/closure。

次指标：

- wall duration；
- Agent duration；
- total-prompt Token（input + cache-read + cache-write）；
- raw input、cache-read、cache-write 和 output Token 分项诊断；
- turns、tool calls、file reads；
- Host Start/Commit/Maintenance overhead；
- uncertain Memory 使用情况；
- 越界修改和 test pass。

### 9.4 配对与随机化

- 使用 `taskId + iteration` 配对；
- 每个配对相同 commit/model/timeout；
- 循环轮换 arm 顺序；
- 每次 fresh clone 和 fresh data dir；
- 预先确定 repeat 数；
- 不因结果不好临时删除样本。

### 9.5 统计解释

报告平均差、相对差、win/tie/loss，并给出配对差值区间。不要只比较三组独立平均值，也不要把一个任务的大提升当成普遍规律。

### 9.6 下一轮实验一：分层上下文消融

下一轮不能只把当前 RepoMind 与 no-memory 比较，否则无法知道收益来自 L1 检索还是 L2/L3。建议至少预注册四个实验臂：

| Arm | Agent 获得的仓库历史 | 目的 |
| --- | --- | --- |
| no-memory | 无历史上下文 | 从零探索基线 |
| full-history | 相同历史的原始完整文本 | 正确率参考与上下文成本上界 |
| RepoMind-L1 | 与旧实验一致，只注入排序 L1 | 建立可与 v0.8/RC 对照的桥接臂 |
| RepoMind-layered | 相同 L1 来源，再注入 current L2/L3 | 估计分层上下文相对 L1-only 的增量作用 |

关键控制要求：

1. L1-only 和 layered 使用完全相同的 L1 数据、任务、commit、模型和字符预算；
2. 报告实际 injected L1/L2/L3 数量、字符数、ID 和版本，不能只报告“检索成功”；
3. 至少包含“L2/L3 有帮助”“L2/L3 无额外信息”“派生层已 stale”三类任务；
4. 对 `RepoMind-layered - RepoMind-L1` 做同 task/iteration 配对，而不是跨批比较旧 v0.8；
5. 每个任务至少 5 次，轮换 arm 顺序，并预先冻结失败样本处理规则。

主判断应是：layered hidden success 不低于 L1-only，同时 total-prompt Token、Agent duration 或文件读取至少一项改善。Raw input、cache-read、cache-write 和 output 应分开报告，但不能用其中单项替代 total prompt；若正确率相同但上下文更长、耗时更高，也应如实判为没有 uplift。

### 9.7 下一轮实验二：自动 maintenance 的纵向价值

自动 maintenance 发生在任务 Commit 之后，无法通过同一次任务的 hidden check 证明价值。应采用两阶段序列：

```text
Task A：Agent 完成真实修改并 Commit Evidence/Memory
  ├─ control：不构建派生层
  └─ treatment：自动维护 L2 -> L3 -> L4

Task B：在同一项目 ID、fresh Agent 上下文中完成后续任务
```

Task A 两臂必须产生相同的 L1/Evidence；Task B 的差异只来自 Task A 后是否成功构建 current L2/L3。需要同时报告：

- Task A 的 `commitMs` 与 `maintenanceMs`，以及两任务合计 wall time；
- Task B hidden success、total-prompt Token、raw/cache 分项、文件读取、首次定位正确模块所需操作；
- L2/L3 版本、source fingerprint/current 状态和实际注入字符；
- maintenance success/partial/failed、Task B 结束后的 open Session 数；
- 如果 maintenance 成本大于 Task B 节省，也要计入总体结论。

建议把“Task B 正确率/探索成本改善”设为收益指标，把“Task A maintenance 延迟”设为成本指标。只有 treatment 在配对序列的总成本或正确率上获益，才能称自动维护提升了真实 Agent，而不能仅凭 L2/L3 表发生变化得出该结论。

### 9.8 执行与发布门禁

正式运行前先完成：

1. 保持当前 45-suite、259-test 完整回归全绿，并将 Windows junction、symlink 与旧 report fixture 纳入后续 CI；
2. 用 fake runner 验证四臂 prompt 差异和 maintenance 分阶段计时；
3. 在一个小型真实仓库执行 1 次 preflight，确认 Agent、证书、Token 事件和隐藏检查可用；
4. 创建全新正式目录，一次性完成计划样本，不覆盖或事后补跑单点；
5. 同时保留 raw JSONL、stderr、run report、manifest hash、模型/Runner 版本和失败案例。

## 10. 已知实验限制

1. 八个 JavaScript fixture 由作者设计，存在选择偏差；
2. 正式 v0.8 只有每任务 3 次重复；
3. RC 5 次重复仍只有 8 类任务；
4. 主要覆盖一个 Agent Runner、少数模型、Windows 时间段；
5. Token 来自 OpenCode 事件，没有第二 tokenizer 独立复算；
6. full-history 较短，未测试历史大到无法放入 Prompt 的临界点；
7. public/hidden checks 在 Commit 后运行，不进入本次 Memory Evidence；
8. 预置 Memory 实验测的是“给到正确历史知识后的 uplift”，不单独证明自动提取质量；
9. 外部 p-limit 只有一个仓库和三个配对；
10. 云模型会受证书、限流、服务波动和模型目录变化影响；
11. v0.7/v0.8 的 72 次与 RC 120 次实验都是 L1-only，不能证明 L2/L3 uplift；
12. 当前 cross-session harness 已完成 120-stage 真实 Agent 正式重跑，但尚未完成 layered-vs-L1-only 四臂消融或第三 Session 的 L2/L3 消费实验；
13. 当前 Windows junction、related-file realpath 和 dangling-link 均有本机回归，但仍未覆盖所有平台的挂载点、重解析点和对抗性 TOCTOU 组合；
14. 新 cross-session report v3 与 Agent report v7 已保存实际注入与去重的 L1/L2/L3 ID、数量和字符数；legacy Agent eval v6 仍缺少这些字段，不能与新结果混合归因；
15. v4/v5 的兼容仅在 aggregate/profile 路径成立，旧报告直接进入当前 v7 renderer 会失败；
16. Host 已将所有观察到的 shell 命令失败判为 partial，但仍不强制至少一项测试，也无法解释未知 Agent event；
17. Windows argv quoting 和 data-directory 并发问题已修复并定向测试，但 Prompt 仍经 argv 传递，属于平台产品约束；
18. `maxMemories=0` 已可构造零 L1 且保留 L2/L3，不过当前三臂 Runner 还没有内置完整的 layered-vs-L1-only 四臂消融模式。

## 11. 如何讲解“项目实现的效果”

建议分三层：

**产品能力**：跨 Session/Agent 共享可治理、Evidence-backed 仓库记忆；当前代码已接入 L1/L2/L3 Host context 和成功 Commit 后的 best-effort 派生维护。
**正式 L1 证据**：v0.8 的 72 次 Host-managed、L1-only 实验完整通过，RepoMind hidden 24/24，对 no-memory 提升正确率并减少耗时/Token/读取，与 full-history 正确率相同。
**更大样本 L1 信号**：RC 120 次 L1-only 实验中 RepoMind 40/40，但因一次 full-history 证书错误导致 Integrity 失败，只能作为观察性证据；敏感性分析显示与 full-history 正确率相同，输入 Token 未必更低。
**当前跨 Session 正式证据**：2026-08-11 的 120-stage OpenCode/Luna 批次中，shared hidden 为 15/15、isolated 为 0/15；在两臂都正确的另 15 个 pair 中，Host 时长均值下降 18.055%，total prompt 下降 11.854%。独立审计通过；实际 uplift 由 L1 注入承担。
**尚未证明**：L2/L3 在第三个 Session 被实际消费并产生独立增量、紧预算效果，以及 Claude/OpenCode 跨 Agent 正式结果。

这种表述既体现效果，也能承受面试官对实验严谨性的追问。
