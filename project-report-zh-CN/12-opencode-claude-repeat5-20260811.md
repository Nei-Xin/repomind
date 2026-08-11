# OpenCode -> Claude L2/L3 消费 Repeat 5（2026-08-11）

## 1. 结论先行

本轮使用真实 OpenCode 与 Claude Code，在同一份经过 containment smoke 审计的三阶段任务上执行 `repeat=5`，共得到 30 个 Agent stage。主评测和独立审计均通过。

| Derived consumer | 上下文 | Hidden result |
| --- | --- | ---: |
| isolated Claude | `L1/L2/L3=0/0/0` | 0/5 |
| shared Claude | `L1/L2/L3=0/1/1` | 5/5 |

shared consumer 明确配置 `maxMemories=0`，所以正确结果不能归因于 L1。它消费的是前两个 OpenCode Session 成功 Commit 后由 Host 自动维护的 L2 Module Narrative 与 L3 Repository Profile。

严谨结论是：**在固定的 release-command 任务上，OpenCode 产生并由 RepoMind 派生的 L2/L3 上下文，连续 5 次帮助新的 Claude Session 恢复隐藏的 durable decision；fresh-database 对照连续 5 次失败。**

这轮不能单独估计 L2 与 L3 各自贡献，也不能外推到所有仓库任务。

## 2. 为什么重新运行

第 11 篇报告中的 90-stage OpenCode 正式批次已经观察到第三阶段 shared `15/15`、isolated `0/15`，但整批因一个上游响应流中断未通过完整性门禁，而且没有跨 Agent runner。

随后完成了三个关键加固：

1. 通用 Agent Host adapter，使 OpenCode 与 Claude Code 共用 Start、context、verification、Commit 和 maintenance 生命周期；
2. Claude 文件系统 containment hook，限制 Agent 工具访问到当前 checkout；
3. 独立结果审计，检查事件泄漏、Git allowlist、数据库、上下文层级和源码快照。

本轮只重跑最核心的一个 6-stage smoke，再扩展到 repeat 5，目标是低成本回答：Claude 恢复后，这条跨 Agent L2/L3 消费链路能否稳定通过全部门禁。

## 3. 三阶段与实验臂

```text
Stage 1: OpenCode producer
  关闭 release review，保留准确命令、顺序和被否决替代方案
  -> Host Commit -> 自动维护 L1/L2/L3

Stage 2: OpenCode relay
  消费 durable context，完成独立 handoff 状态迁移
  -> Host Commit -> 刷新 L2/L3

Stage 3: Claude derived consumer
  maxMemories=0，强制 L1=0
  -> 从最新批准的 workflow 恢复 verify:release
  -> public test + 外置 hidden verifier
```

两个实验臂的区别只有历史数据库生命周期：

| Arm | RepoMind state | Stage 3 预期 |
| --- | --- | --- |
| isolated | 每个 stage 使用 fresh database | `0/0/0`，hidden fail |
| shared | 三个 stage 共享同一 project database | `0/1/1`，hidden pass |

isolated hidden fail 是正确率对照，不是进程或完整性失败。两臂的 Agent 都必须 clean exit、通过公开测试并正常关闭 Host 生命周期。

## 4. 冻结环境

| 项目 | 值 |
| --- | --- |
| Suite | `layered-consumption-xagent-containment-smoke-20260811-174439` |
| RepoMind HEAD | `05fe873136d578738b14e01edac6f2302e22a70c` |
| Dirty source snapshot | `8feb05e5082e79e1da3f7a8d58b4873bbaf8bf7a594f16dec2596d63971055a5` |
| Snapshot files | 368 |
| 后续实现提交 | `a54a4d6e7722fc6e1bceee3ca996c868e431227d` |
| OpenCode | `1.18.15` |
| Claude Code | `2.1.227` |
| Node.js | `v22.20.0` |
| Model | `gpt-5.6-luna` |
| Context budget | 12,000 chars |
| Repeat | 5 |
| Stage timeout | 900,000 ms |

实验冻结的是显式 dirty source snapshot，而不是事后用 Git commit 冒充运行输入。实现随后提交为 `a54a4d6`；该提交还包含实验后整理的文档，因此复现实验时仍应以 snapshot hash 和 manifest hash 为准。

## 5. 正式命令与运行结果

```powershell
node dist/cli/index.js eval --agent-cross-session `
  --manifest "D:\data\code\project\repomind-test\layered-consumption-xagent-containment-smoke-20260811-174439\manifest.layered-consumption-smoke.json" `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --repeat 5 `
  --max-memories 5 `
  --context-budget 12000 `
  --timeout 900000 `
  --output "D:\data\code\project\repomind-test\layered-consumption-xagent-containment-smoke-20260811-174439\results-r5" `
  --strict --require-acceptance --json
```

```text
Started:  2026-08-11T19:22:44.8959177+08:00
Finished: 2026-08-11T20:17:48.5974948+08:00
Wall time: 3306.1 seconds
Exit code: 0
Stage runs: 30
Process attempts: 30
Infrastructure retries: 0
Integrity: passed
Acceptance: passed
```

## 6. 五次 Claude Consumer 对照

| Iteration | Arm | Exit | Public | Hidden | L1/L2/L3 | Agent ms | Input / Output |
| ---: | --- | ---: | --- | --- | --- | ---: | ---: |
| 1 | isolated | 0 | pass | fail | `0/0/0` | 187,426 | 23,498 / 3,942 |
| 1 | shared | 0 | pass | pass | `0/1/1` | 113,840 | 11,693 / 1,329 |
| 2 | isolated | 0 | pass | fail | `0/0/0` | 201,327 | 16,787 / 3,523 |
| 2 | shared | 0 | pass | pass | `0/1/1` | 140,593 | 13,696 / 1,728 |
| 3 | isolated | 0 | pass | fail | `0/0/0` | 179,810 | 23,438 / 2,210 |
| 3 | shared | 0 | pass | pass | `0/1/1` | 237,137 | 8,619 / 963 |
| 4 | isolated | 0 | pass | fail | `0/0/0` | 168,367 | 19,823 / 2,697 |
| 4 | shared | 0 | pass | pass | `0/1/1` | 134,657 | 20,482 / 2,023 |
| 5 | isolated | 0 | pass | fail | `0/0/0` | 231,009 | 32,181 / 4,788 |
| 5 | shared | 0 | pass | pass | `0/1/1` | 135,894 | 20,703 / 1,897 |

每个 consumer 都只有一次 process attempt，重试数为 0。没有用重试选择性替换失败样本。

## 7. 聚合结果

| Metric | Result |
| --- | ---: |
| Stage artifacts | 30/30 |
| Clean exits | 30/30 |
| Public checks | 30/30 |
| All hidden checks | 25/30 |
| Shared transfer hidden pass | 100% |
| Isolated transfer hidden pass | 50% |
| Transfer delta | +50 percentage points |
| Shared derived consumer hidden pass | 5/5 |
| Isolated derived consumer hidden pass | 0/5 |
| Shared L2 recall | 5/5 |
| Shared L3 recall | 5/5 |
| Shared derived-stage L1 recall | 0/5 |
| Total input tokens | 497,223 |
| Total output tokens | 52,830 |
| Total Agent time | 3,168,705 ms |

`all hidden checks=25/30` 包含 producer、relay 和 consumer。真正用于 derived-only 正确率判断的是 shared consumer `5/5` 对 isolated consumer `0/5`。

## 8. 效率结果如何解释

评测器只有 5 个配对满足效率统计条件。点估计倾向 shared 更省，但 95% 区间均跨过 0：

| Metric | Isolated mean | Shared mean | Delta | 95% CI |
| --- | ---: | ---: | ---: | --- |
| Agent duration | 73,756 ms | 63,949 ms | -13.3% | `[-24,241, 4,626] ms` |
| Input tokens | 15,872.6 | 14,108.8 | -11.1% | `[-5,778, 2,251]` |
| Total prompt tokens | 63,693.4 | 57,219.2 | -10.2% | `[-18,172, 5,223]` |
| Output tokens | 1,450.4 | 1,302.4 | -10.2% | `[-481, 185]` |
| File reads | 3.4 | 2.6 | -23.5% | `[-2.893, 1.293]` |

因此可以说“效率点估计方向有利”，不能说“效率获得统计显著提升”。本轮最强证据是正确率与上下文层级的稳定关联。

## 9. 独立审计

```powershell
node benchmarks/cross-session-agent-suite/audit-results.mjs `
  --suite "D:\data\code\project\repomind-test\layered-consumption-xagent-containment-smoke-20260811-174439" `
  --results "D:\data\code\project\repomind-test\layered-consumption-xagent-containment-smoke-20260811-174439\results-r5" `
  --expected-runner mixed `
  --expected-model mixed `
  --expected-context-budget 12000 `
  --expected-repeat 5 `
  --expected-stage-runs 30 `
  --expected-repomind-commit 05fe873136d578738b14e01edac6f2302e22a70c `
  --source-snapshot-sha256 8feb05e5082e79e1da3f7a8d58b4873bbaf8bf7a594f16dec2596d63971055a5 `
  --output "D:\data\code\project\repomind-test\layered-consumption-xagent-containment-smoke-20260811-174439\results-r5\audit.json"
```

```text
Exit code: 0
Audit passed: true
Audit groups: 14/14
Failures: 0
Audited Agent tools: 382
Successful read tools: 338
Malformed event lines: 0
Leakage findings: 0
Source unchanged: true
Hidden verifier unchanged: true
```

审计组包括 `summary`、`manifest`、`counts`、`paths`、`allowlist`、`artifacts`、`git`、`database`、`context`、`events`、`leakage`、`runtime`、`expectations` 和 `source`。

containment 结论来自真实 Agent stdout tool events：没有发现 Agent 成功访问 suite source、hidden verifier、RepoMind data、sibling repository 或 sibling artifact。Host 自己执行的 hidden check 不属于 Agent event 审计范围。

## 10. 产物与哈希

原始产物保存在仓库外，避免把模型输出、临时 checkout、SQLite 和大体积日志提交到产品仓库：

```text
D:\data\code\project\repomind-test\layered-consumption-xagent-containment-smoke-20260811-174439
```

| Artifact | SHA-256 |
| --- | --- |
| manifest | `21fcf0be00cbd3e3dc2d0c5f5d4d1ec344f029e85f9ed9a645f9eaa001ab8acd` |
| summary | `bc628c01068abd31a22872559a2535a17894b2e30c66439a6537149665106159` |
| audit | `40d6f269fba9822e1e781df63dc795ca22444b1ccada25d6fd39f20562b5bf5a` |

仓库内报告记录命令、口径和哈希；权威逐 stage 数据仍是 `results-r5/summary.json` 与 `results-r5/audit.json`。

## 11. 可以与不可以声称什么

可以声称：

- RepoMind 已实现 OpenCode producer/relay 到 Claude consumer 的 Host-managed 跨 Agent 上下文闭环；
- 成功 Commit 后自动维护的 L2/L3 被第三 Session 真实注入和消费；
- 在该固定任务的 5 次重复中，derived consumer 正确率从 isolated `0/5` 变为 shared `5/5`；
- 文件系统 containment 在 382 个真实 Agent 工具事件中没有发现越界访问；
- 主评测和独立审计全部通过。

不可以声称：

- L2 单独或 L3 单独产生了全部收益；
- 该结果已经覆盖所有仓库、任务类型、模型和操作系统；
- 5 次样本已经证明效率提升具有统计显著性；
- 已完成 Claude -> OpenCode 的反向同类正式验证；
- 已完成 layered、L1-only、full-history、no-memory 四臂消融。

## 12. 下一步门禁

不再增加同一 release-command 任务的重复次数。下一步先选 2 至 3 个不同 durable decision 类型执行广度 smoke，例如 endpoint 迁移、error contract 和并发/幂等规则。每个任务先运行一次 shared/isolated 三阶段并独立审计。

只有广度 smoke 同样满足 shared derived consumer 正确、isolated 缺少上下文、L1=0、L2/L3 实际注入和 containment 无泄漏，才值得重新执行完整多任务 repeat 5 或四臂消融。
