# 三阶段 L2/L3 派生上下文消费实验（2026-08-11）

## 1. 结论先行

本轮实验已经完成真实 OpenCode Agent 调用，而不是 mock、离线回放或只检查数据库。

最终 smoke 的 6 个 stage 通过了完整性、效果门禁和独立审计。随后正式批次执行了 `3 sequences x 2 arms x 3 stages x 5 repeats = 90 stages`。正式批次的第三阶段得到完全一致的描述性结果：

| 第三阶段结果 | shared | isolated |
| --- | ---: | ---: |
| 有效运行数 | 15 | 15 |
| L1 注入 | 0/15 | 0/15 |
| L2 注入 | 15/15 | 0/15 |
| L3 注入 | 15/15 | 0/15 |
| hidden pass | 15/15 | 0/15 |
| Host commit | 15/15 | 15/15 |

这证明了三件事：

1. `maxMemories=0` 确实关闭了 L1，没有发生 L1 泄漏；
2. 前两个 Session 成功 Commit 后自动维护的 L2/L3，能在第三个 Session 被 Host 实际检索并注入；
3. 当秘密契约已从仓库删除、第三阶段又没有 L1 时，shared Agent 仍能完成 hidden contract，而 fresh-database isolated Agent 不能。

严谨表述应是：**L2/L3 派生上下文的联合消费在 15 组第三阶段配对中与 hidden correctness 的 0/15 -> 15/15 改变同时出现。** 本实验没有分别关闭 L2 或 L3，因此不能声称“L2 单独贡献多少”或“L3 单独贡献多少”。

正式批次整体仍应标记为 **未通过预注册完整性门禁**。90 个 stage 中有一个 isolated Stage 2 遇到 OpenCode 上游响应流中断，退出码为 1，独立审计因此失败。该异常没有发生在第三阶段，也没有改变上述 30 个第三阶段运行的结果，但它使整轮 `r5` 不能被包装成完全通过的正式实验。

## 2. 为什么需要三阶段

以前的两阶段实验只能证明：

- shared 数据库能跨 Session 召回 L1；
- Commit 后 L2/L3 maintenance 确实执行；
- telemetry 中能看到派生记录被创建或更新。

它不能证明下一个 Agent 真正消费了 L2/L3。原因是第二阶段仍可能直接拿到 L1，L2/L3 还可能因 provenance 去重而没有进入 prompt。

本实验把生产、转述和消费拆成三个 Session：

```text
Stage 1: producer
  读取秘密契约 -> 删除原始 review 文件 -> 更新状态文件
  -> Host Commit -> 自动生成 L1、L2、L3

Stage 2: relay
  shared 组读取 Host durable context -> 首行准确复述 -> 删除 relay 文件
  -> 更新另一份 handoff 状态文件 -> Host Commit -> 刷新 L2、L3

Stage 3: derived-only consumer
  maxMemories=0，强制 L1=0
  shared: 只能从 L2/L3 获得历史契约
  isolated: fresh DB，L1/L2/L3 都为 0
  -> 修改真实代码 -> 外置 hidden verifier 验证秘密契约
```

Stage 2 使用独立的 handoff status 文件很关键。若 Stage 1 和 Stage 2 反复绑定同一个状态文件，去重和派生层维护可能认为没有新的有效派生来源，无法稳定地产生可供 Stage 3 使用的 current L2/L3。

## 3. 实验问题与假设

### 3.1 主问题

在原始秘密契约已经从当前 Git 仓库删除、L1 被明确关闭时，RepoMind 自动维护的 L2/L3 能否帮助另一个真实 Agent 恢复正确实现？

### 3.2 预注册的可观测条件

shared Stage 3 必须同时满足：

- `maxMemories=0`；
- `context.l1.injected=0`；
- `context.l2.injected>0`；
- `context.l3.injected>0`；
- hidden verifier pass；
- Agent clean exit；
- Host commit success。

isolated Stage 3 必须同时满足：

- fresh database；
- `L1=L2=L3=0`；
- hidden verifier fail；
- Agent 本身 clean exit；
- Host 正常关闭 Session 并创建 checkpoint。

最后一项很重要：isolated 的 hidden fail 是实验预期，不应被误判成基础设施失败。

## 4. 任务与实验臂

三个 sequence 分别覆盖三种不容易靠常识猜中的仓库契约：

| Sequence | 第三阶段目标 | 被删除的历史信息 |
| --- | --- | --- |
| `layered-release-command` | 恢复 release script | 精确命令及顺序 |
| `layered-stale-endpoint` | 修复 jobs client endpoint | supported/obsolete route |
| `layered-error-contract` | 恢复 parser error contract | error type、code、cause 和 valid behavior |

每个 sequence 有两个实验臂：

| 实验臂 | 数据库生命周期 | 第三阶段预期 |
| --- | --- | --- |
| `shared` | 三个 stage 共用同一 RepoMind DB | L1=0，L2/L3 可用，hidden pass |
| `isolated` | 每个 stage 使用全新 RepoMind DB | L1/L2/L3 全为 0，hidden fail |

三个 sequence、两个实验臂、三个 stage、五次重复，共 90 个真实 Agent stage。顺序由 manifest 固定并轮换，runner、模型、上下文预算、repeat 和源码快照均由审计器重新核对。

## 5. 环境与冻结信息

| 项目 | 值 |
| --- | --- |
| 日期 | 2026-08-11 |
| OS | Windows 10 `10.0.26200` x64 |
| Node | `v22.20.0` |
| RepoMind | `1.0.0-rc.1` |
| RepoMind HEAD | `05fe873136d578738b14e01edac6f2302e22a70c` |
| dirty source snapshot | `7cff3b18efd5a870e81db391772d4863b7edf0cc3691f6ab5ad6ceee9ed4c708` |
| snapshot 文件数 | 364 |
| Agent runner | OpenCode `1.18.15` |
| 模型 | `cliproxyapi/gpt-5.6-luna` |
| context budget | 12,000 chars |
| max L1 memories | Stage 1/2 为 5；Stage 3 为 0 |
| repeat | 5 |
| per-stage timeout | 900,000 ms |

正式实验期间源码 snapshot 和 hidden verifier 均未改变。报告是在实验及独立审计结束后写入，因此不属于被冻结的执行输入。

## 6. 实际命令

### 6.1 运行前验证

```powershell
npm test -- tests/cross-session-eval.test.ts
npm test
npm run typecheck
npm run build
npm run bench:layered-consumption-fixtures
npm run bench:cross-session-agent-fixtures
```

结果：focused cross-session 测试 6/6 通过；完整回归、typecheck、build、layered fixture validator 和原 cross-session fixture validator 均退出 0。

### 6.2 正式运行

```powershell
node dist/cli/index.js eval --agent-cross-session `
  --manifest "D:\data\code\project\repomind-test\layered-consumption-formal-luna-r5-20260811-114658\manifest.layered-consumption.json" `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --repeat 5 `
  --max-memories 5 `
  --context-budget 12000 `
  --timeout 900000 `
  --output "D:\data\code\project\repomind-test\layered-consumption-formal-luna-r5-20260811-114658\results-r5" `
  --strict --require-acceptance --json
```

结果：90/90 stage 产物生成，90 次 process attempt，0 retry，0 timeout；命令运行约 7,884.7 秒后退出 1。退出 1 的直接原因是完整性门禁发现一个 Agent clean-exit 失败，不是 acceptance 的 L1/L2/L3 数值门禁失败。

### 6.3 独立审计

```powershell
node benchmarks/cross-session-agent-suite/audit-results.mjs `
  --suite "D:\data\code\project\repomind-test\layered-consumption-formal-luna-r5-20260811-114658" `
  --results "D:\data\code\project\repomind-test\layered-consumption-formal-luna-r5-20260811-114658\results-r5" `
  --expected-runner opencode `
  --expected-model cliproxyapi/gpt-5.6-luna `
  --expected-context-budget 12000 `
  --expected-repeat 5 `
  --expected-stage-runs 90 `
  --expected-repomind-commit 05fe873136d578738b14e01edac6f2302e22a70c `
  --source-snapshot-sha256 7cff3b18efd5a870e81db391772d4863b7edf0cc3691f6ab5ad6ceee9ed4c708 `
  --output "D:\data\code\project\repomind-test\layered-consumption-formal-luna-r5-20260811-114658\results-r5\audit.json"
```

第一次审计被调用工具的 120 秒外层时限中止，退出 124，且没有留下 `audit.json`。把外层时限调到 900 秒后，同一审计在约 132.4 秒内完成并退出 1。审计失败项只指向同一个 OpenCode clean-exit 异常。

## 7. Smoke 演进与真实失败原因

### 7.1 第一次 smoke：设计没有稳定生成 L2

目录：`layered-consumption-smoke-20260811-102852`

- 18/18 stage 完整性通过；
- shared Stage 3 为 `L1=0, L2=0, L3=1`；
- shared hidden pass rate 只有 0.5，`sharedL2RecallRate=0`；
- acceptance failed。

根因：Stage 1/2 只删除 pending 文件，没有更新仍然存在的模块文件。Commit 后 L2 maintenance 合法地返回 `skipped`，因为删除后的文件不能形成 current module narrative。这个 smoke 证明了“maintenance 被调用”不等于“必然有 L2 可消费”。

修复：Stage 1/2 在删除秘密/relay 文件之外，同时更新 `ops/status` 中的状态文件，使派生层有稳定、仍存在且可绑定的模块来源。

### 7.2 第二次 smoke：重复绑定与 Agent 超时

目录：`layered-consumption-smoke-fixed-20260811-110659`

- 6/6 stage 产物生成；
- shared Stage 3 为 `L1=0, L2=1, L3=0`，hidden fail；
- isolated Stage 2 在完成目标修改后没有产生 terminal event，最终被 SIGTERM；
- integrity 和 acceptance 都失败。

根因有两部分：

1. Stage 1 和 Stage 2 重复修改同一 status 文件，使 Stage 2 的 L3 maintenance 为 `skipped`，第三阶段没有 current L3 注入；
2. isolated Stage 2 已完成文件修改和 diff 检查，但在最终回复前停住，触发 timeout，Host 因 incomplete trace 拒绝正常 Commit。

修复：Stage 2 改为独立的 `*-handoff.status` 文件；正式调用 timeout 提升到 900 秒。

### 7.3 最终 smoke：全部通过

目录：`layered-consumption-smoke-final-20260811-113106`

| 指标 | 结果 |
| --- | ---: |
| stage runs | 6/6 |
| process attempts | 6 |
| retries/timeouts | 0/0 |
| integrity | passed |
| acceptance | passed |
| independent audit | passed |
| shared Stage 3 | `L1/L2/L3=0/1/1`，hidden pass |
| isolated Stage 3 | `L1/L2/L3=0/0/0`，hidden fail |

最终 smoke 证明实验设计本身可以得到完整且可审计的因果对照。

## 8. 正式批次逐阶段结果

### 8.1 各 arm/stage 汇总

| Arm | Stage | n | clean exit | hidden pass | commit | L1 injected | L2 injected | L3 injected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| isolated | 1 | 15 | 15 | 15 | 15 | 0 | 0 | 0 |
| shared | 1 | 15 | 15 | 15 | 15 | 0 | 0 | 0 |
| isolated | 2 | 15 | 14 | 14 | 15 | 0 | 0 | 0 |
| shared | 2 | 15 | 15 | 15 | 15 | 15 | 0 | 0 |
| isolated | 3 | 15 | 15 | 0 | 15 | 0 | 0 | 0 |
| shared | 3 | 15 | 15 | 15 | 15 | 0 | 15 | 15 |

Stage 2 shared 仍允许 L1，用于让 relay Agent 把秘密契约转化为新的 durable evidence。Stage 3 才是 derived-only 消费阶段，因此 Stage 3 的 L1 必须严格为 0。

### 8.2 第三阶段五连测

每个单元格依次表示五次重复；`0/1/1:P` 表示 `L1/L2/L3=0/1/1` 且 hidden pass，`0/0/0:F` 表示三层都未注入且 hidden fail。

| Sequence | shared repeats 1-5 | isolated repeats 1-5 |
| --- | --- | --- |
| release command | `0/1/1:P` x 5 | `0/0/0:F` x 5 |
| stale endpoint | `0/1/1:P` x 5 | `0/0/0:F` x 5 |
| error contract | `0/1/1:P` x 5 | `0/0/0:F` x 5 |

shared Stage 3 的 context chars 约为 1,706-1,724；isolated 固定为 138 个空 section/结构字符。两组都没有 L1，差异来自 Host 注入的 current L2/L3 派生上下文。

### 8.3 派生层 telemetry

`derivedConsumption` 汇总为：

| 指标 | 值 |
| --- | ---: |
| runs per arm | 15 |
| shared derived recall | 1.000 |
| isolated derived recall | 0.000 |
| shared L1 recall | 0.000 |
| isolated L1 recall | 0.000 |
| shared L2 recall | 1.000 |
| shared L3 recall | 1.000 |

所有派生层数值门禁都通过。整体 acceptance 失败仅因为 acceptance 首先要求 integrity 必须通过。

## 9. 效率指标如何解读

报告只对两臂 hidden 都成功的 pair 计算效率。30 个 transfer pair 中只有 14 个进入效率比较：15 个 isolated Stage 3 按设计 hidden fail，另有 1 个 isolated Stage 2 上游断流，因此排除了 16 个 pair。

| 指标 | isolated mean | shared mean | delta | 95% CI |
| --- | ---: | ---: | ---: | ---: |
| Host lifecycle | 73,335 ms | 69,782 ms | -4.845% | [-13,875, 6,769] ms |
| Agent duration | 72,502 ms | 68,935 ms | -4.920% | [-13,886, 6,752] ms |
| input tokens | 17,336 | 15,211 | -12.259% | [-5,470, 1,219] |
| total prompt tokens | 70,365 | 56,098 | -20.276% | [-20,871, -7,663] |
| output tokens | 1,388 | 1,219 | -12.204% | [-279, -60] |
| file reads | 3.643 | 2.786 | -23.529% | [-1.310, -0.404] |

这些效率 pair 实际来自 Stage 2，而 Stage 2 的 shared 组使用 L1。因此它们只能作为本批次 Host 行为的辅助观测，**不能归因于第三阶段 L2/L3 消费**。本实验对 L2/L3 的主证据是 correctness 和逐层注入 telemetry，不是效率 uplift。

## 10. 正式批次唯一异常

异常 run：

```text
layered-stale-endpoint / isolated / iteration 1 / relay-refresh-jobs-context
```

原始事实：

| 字段 | 值 |
| --- | --- |
| Agent exit code | 1 |
| duration | 59,902.894 ms |
| timed out | false |
| aborted | false |
| stderr | empty |
| structured terminal event | `error` |
| error code | `upstream_stream_read_error` |
| message | `Upstream response stream was interrupted` |
| Agent changed files | none |
| Host checkpoint | succeeded |

这次调用只完成了 todo 写入和仓库 glob，还没有执行任务修改。它不是 isolated hidden fail 的正常对照结果，而是一次上游基础设施故障。

当前 runner 的 retry telemetry 为 0，说明基础设施重试分类只看到了非零退出，未把 OpenCode stdout 结构化事件中的 `upstream_stream_read_error` 识别成可重试错误。这是实验暴露出的实际实现缺口。

因此：

- 不能把 formal `r5` 写成“integrity passed”；
- 不能用整体 isolated hidden pass 0.467 与 shared 1.0 作为最终无瑕疵效果量；
- 可以报告 30 个独立 Stage 3 run 的描述性结果，因为这些 run 均 clean exit、commit 完成且通过独立上下文/数据库/泄漏审计；
- 修复 retry classification 后应在全新目录重新跑完整正式批次，不能原地覆盖或手工删除失败 run。

## 11. 独立审计结果

通过的审计组：

- manifest identity 和 SHA-256；
- 90 个 stage、90 次 attempt、90 个 repository、60 个数据库、90 个 event log；
- 结果路径 containment 与 deterministic layout；
- initial cleanliness、allowed changes；
- Host artifacts 和权威检查来源；
- parentless Git checkpoint、独立 object store、无 remote/reflog/unreachable object；
- SQLite integrity、foreign key、Session/Host Run 关闭状态；
- shared/isolated L1-L3 treatment 约束；
- Agent event 完整性和指标重算；
- Agent 未读取 hidden verifier、RepoMind DB 或其他实验臂；
- runner/model/budget/repeat/stage 固定值；
- RepoMind 源码与 hidden verifier 在执行前后不变。

失败的审计组：

- `summary`：summary 如实报告 integrity false；
- `runtime`：同一异常 run 的 live record 和 stored attempt 都是 exit 1。

审计器没有掩盖失败，说明 fail-closed 门禁生效。

## 12. 文件与哈希

### 12.1 Formal r5

| 文件 | SHA-256 |
| --- | --- |
| `manifest.layered-consumption.json` | `c49cede9bc9f655ecf5035f1fa7703ea6bc8a7a6e65143c78e6c71160240b9b7` |
| `results-r5/summary.json` | `7111243962ac5a97285c34106bdda868cf8786cb793247a0930b27a573faf46e` |
| `results-r5/audit.json` | `846cd2ef704b9e86e86a0ef8c6f76e17f6b23f8bd53b0f44c2069a1f68a131d7` |

Formal 根目录：

```text
D:\data\code\project\repomind-test\layered-consumption-formal-luna-r5-20260811-114658
```

### 12.2 Final smoke

| 文件 | SHA-256 |
| --- | --- |
| `manifest.layered-consumption-smoke.json` | `3ef555124eb01fdc4ac3a338df361a2ee44119378116b9dd48731c50b6233763` |
| `results-r1/summary.json` | `1d39337edbbd4200b9b8d3cb8f6a27ec7c38464b56e339f8c057ae8117659f11` |
| `results-r1/audit.json` | `bb5b8725fbf2bcee034656d2b42357bb963b851c935c6f9bcf13ed12f9e52713` |

## 13. 项目能力可以如何表述

可以确认：

> RepoMind Host 已形成 Start -> 预算化 L1-L3 context -> Agent -> fail-closed Commit -> 自动 L2/L3 maintenance 的三 Session 闭环。最终 smoke 经独立审计完全通过；90-stage 正式批次的全部 15 组 derived-only shared consumer 都在 L1=0、L2=1、L3=1 时通过 hidden contract，而 isolated 的 15 组在 L1/L2/L3 全为 0 时全部失败。

必须同时披露：

> 正式批次有一个无关的 isolated Stage 2 遇到上游 stream interruption，导致整轮 integrity/acceptance/audit 为 failed。当前结论是强描述性证据和通过审计的 smoke，不是一个可以省略异常的最终正式效果声明。

不应表述：

- “L2 单独提升 100%”；
- “L3 单独提升 100%”；
- “正式 90-stage 实验全部通过”；
- “效率下降 20% 是 L2/L3 导致的”；
- “三个真实外部仓库都验证成功”。

本轮使用的是一个真实 Git fixture 仓库、真实 OpenCode CLI 和真实模型调用，但仍是预注册的合成秘密契约任务。外部仓库和跨 Agent 外部效度需要后续实验。

## 14. 下一步

优先级从高到低：

1. 在 OpenCode adapter/runner 中解析结构化 `error` event，把明确的 `upstream_error`、`upstream_stream_read_error` 归类为 infrastructure retry；增加单测，确保语义任务失败不会被重试；
2. build、回归、在全新 suite/results 目录跑一次 smoke；
3. 用全新目录重新执行 90-stage repeat 5，要求 90 clean exits、audit passed；
4. 增加四臂消融：isolated、L1-only、L2-only、L3-only 或至少 L2-only/L3-only，以拆分两层贡献；
5. 增加 2k/4k/12k 紧预算条件，测量派生层在预算竞争下的正确率、截断和 token 成本；
6. 用 Claude -> OpenCode 和 OpenCode -> Claude 的顺序完成跨 Agent 复现。

## 15. 面试问答

### Q1：为什么不是两个 Session？

两个 Session 中 consumer 仍可直接拿到原始 L1，无法证明派生层被消费。第三阶段把 `maxMemories` 设为 0，并删除原始契约文件，才把信息来源收敛到 L2/L3。

### Q2：怎么证明 Agent 没有从仓库偷看到答案？

秘密文件在前一阶段被删除；每个 stage 使用 parentless checkpoint；hidden verifier 在实验仓库外；审计器扫描全部 Agent read 工具事件，确认没有读取 hidden、数据库、其他 arm 或结果目录。

### Q3：isolated hidden fail 为什么不是系统失败？

Agent clean exit、public checks 和 Host commit 可以全部成功，但 hidden contract 因缺少秘密历史而失败。manifest 将这种结果预注册为控制组预期。基础设施失败则表现为 timeout、signal、非零退出、事件不完整或 Host lifecycle 异常。

### Q4：为什么 formal 整体失败，仍然能讨论 Stage 3？

必须把两种结论分开。整轮 acceptance 不能通过；但 30 个 Stage 3 run 本身都有完整事件、clean exit、正确隔离和 commit，可以作为透明的描述性子分析。最终对外主结果仍应等修复后重跑。

### Q5：这证明 L2 和 L3 谁更重要吗？

没有。shared Stage 3 同时注入一个 L2 和一个 L3，两层共同变化。需要逐层消融才能估计独立贡献和交互作用。

### Q6：为什么 Host commit 在上游断流时仍显示成功？

Host 会保存失败 Session 的证据并创建可审计 checkpoint，但质量状态为 failed，不会把它当成成功 maintenance 闭环。这里的 `commitSucceeded=true` 表示状态被一致地持久化，不表示 Agent 任务成功。

### Q7：本轮最大的工程发现是什么？

除了确认 derived-only 消费路径，实验还发现 retry classifier 没有利用 OpenCode 结构化 error event。真实 Agent 系统不能只检查 stderr 字符串；adapter 应把 provider/runner 的机器可读错误映射为统一的 infrastructure failure taxonomy。

## 16. 低成本修复与复验（2026-08-11 14:34）

没有重跑 90-stage 正式批次。低成本处理只完成以下工作：

1. 在既有上游 stream interruption 信号桶中加入 `upstream_stream_read_error` 和 `Upstream response stream was interrupted`；
2. 用 formal r5 的真实 OpenCode error payload 更新集成测试，验证有 session token、无 shell/RepoMind 调用且只发生 resume-safe 本地活动时，会继续同一 provider session；
3. 保留普通显式 Agent error、Host timeout、abort、shell activity 和不安全工具不重试的门禁；
4. 运行 focused tests、typecheck、build 和一轮新的 6-stage smoke；
5. 对 smoke 执行独立审计。

验证结果：

| 验证 | 结果 |
| --- | --- |
| focused tests | `2 files / 51 tests` passed |
| typecheck | exit 0 |
| build | exit 0 |
| 真实 smoke | `6/6 stages`，exit 0，0 retry，0 timeout |
| smoke integrity | passed |
| smoke acceptance | passed |
| independent audit | passed，所有 14 个审计组通过 |
| shared Stage 3 | `L1/L2/L3=0/1/1`，hidden pass |
| isolated Stage 3 | `L1/L2/L3=0/0/0`，hidden fail |

本轮 smoke 没有随机遇到上游断流，所以运行 telemetry 中 `retries=0` 是正常的。断流恢复分支由精确结构化事件测试覆盖；真实 smoke 的作用是确认正常 Agent、L2/L3 消费、Git/SQLite/事件和审计路径没有回归。

新产物目录：

```text
D:\data\code\project\repomind-test\layered-consumption-low-cost-smoke-luna-20260811-142600
```

产物哈希：

| 文件 | SHA-256 |
| --- | --- |
| `manifest.layered-consumption-smoke.json` | `17350c07188c4930e774856096d473854eb24a27232db47a169601410fc7fee1` |
| `results-r1/summary.json` | `ec3e9f992df5f36c329c0981c9c98bbf8cda519ae9c63c421268ca71ca8fda4b` |
| `results-r1/audit.json` | `14c59b795646efb45b7b871ce3d4c5adff03e28856aa3abf9ebfa7e66d990ebc` |

该处理解决了 formal r5 暴露出的已知 retry 分类缺口，但没有把历史 r5 的失败记录改写为通过，也没有生成新的 repeat-5 正式统计结论。

## 17. OpenCode → Claude 小型跨 Agent smoke（2026-08-11）

### 17.1 完整回归

在跨 Agent smoke 前执行：

```powershell
npm test
```

Vitest 完整回归耗时约 467.7 秒并退出 0。随后 `audit-results.mjs` 增加了 `--expected-runner mixed` / `--expected-model mixed` 支持；逐 stage runner/model 仍由 manifest 精确校验。该小改动通过 `node --check`、原 cross-session fixture validator 和 layered fixture validator，且在本轮独立审计中 `expectations` 组通过。

### 17.2 第一次尝试

第一次 manifest 使用 `OpenCode → Claude → Claude`，共 6 stages。执行到 `5/6` 时，外层命令总时限 900 秒终止了 harness；这不是某个 stage 的 Agent timeout。该批次没有 summary，因此不用于效果判断，也没有在原目录续写或伪造第六个结果。

### 17.3 修订后的低成本设计

为减少 Claude 调用并直接测试核心边界，使用全新目录改为：

```text
Stage 1: OpenCode producer
Stage 2: OpenCode relay and L2/L3 maintenance
Stage 3: Claude derived-only consumer, maxMemories=0
```

shared/isolated 两臂各三阶段，共 6 stages。这个设计直接回答“OpenCode 产生并维护的 L2/L3 能否被 Claude Agent 消费”。

### 17.4 实际结果与根因

6/6 stage 产物全部生成，但完整性和 acceptance 失败：

| 项目 | 结果 |
| --- | --- |
| OpenCode stages | 4/4 clean exit |
| Claude stages | 0/2 clean exit |
| shared Claude context | `L1/L2/L3=0/1/1` |
| isolated Claude context | `L1/L2/L3=0/0/0` |
| Claude repository changes | 两臂均为 0 |
| Claude input/output tokens | 两臂均为 0 |
| Claude CLI internal retries | 每个调用 10 次 |
| 最终错误 | `503 auth_unavailable: no auth available (providers=codex, model=gpt-5.6-luna)` |

这说明 Host 跨 Agent 编排和 L2/L3 注入已经到达 Claude 调用边界，但 Claude 网关没有为该模型提供可用认证，模型没有开始推理。因此本轮不能评价 Claude 是否能利用 L2/L3，也不能把 hidden fail 归因于 RepoMind 或 Claude 推理能力。

额外用 `opus`（配置映射到 `gpt-5.6-terra`）执行单 turn 健康探针，90 秒内仍未返回；为避免继续触发网关内部 10 次长退避，终止了该探针残留进程并停止盲目重跑。

### 17.5 独立审计

审计正确返回 failed：

- 通过：manifest、counts、paths、allowlist、artifacts、Git、database、context、events、leakage、mixed expectations、source；
- 失败：summary 与 runtime，原因仅是两个 Claude exit 1；
- shared 第三阶段的 L2=1、L3=1、L1=0 约束由审计器重新验证通过；
- 源码快照与 hidden verifier 在实验到审计期间保持不变。

产物目录：

```text
D:\data\code\project\repomind-test\layered-consumption-xagent-consumer-smoke-20260811-153000
```

| 文件 | SHA-256 |
| --- | --- |
| manifest | `4490a3c7c2a9b800acdca97cdb6eba4bb5fef0295ab7f5fe9cbace1149649385` |
| summary | `518767066ffaf66dfb37e4bed13d37f5f4e4ba1fbddf6034d1dd0718710eec15` |
| audit | `1a984d17fa737792c211195366d26fd7aba6c3affd0fa07ca7abf636d4df258c` |

后续前置条件不是修改 RepoMind 业务逻辑，而是先让 Claude CLI 对至少一个模型完成零成本健康调用。认证恢复后只需重跑这一份 6-stage smoke，不需要先跑 repeat 5 或 90-stage 正式批次。

## 18. Claude 网关恢复后的 R2 复验与隔离审计

### 18.1 运行结果

Claude 健康探针已恢复为 exit 0，并返回 `OK`。随后在 `results-r2` 中执行同一份 6-stage OpenCode -> Claude smoke：

| 项目 | 结果 |
| --- | --- |
| 主命令 | exit 0，840.9 秒 |
| stage / process attempt | 6 / 6 |
| retry / timeout | 0 / 0 |
| OpenCode clean exit | 4/4 |
| Claude clean exit | 2/2 |
| Host commit | 6/6 |
| shared Stage 3 | `L1/L2/L3=0/1/1`，public/hidden pass |
| isolated Stage 3 | `L1/L2/L3=0/0/0`，public pass、hidden fail |
| summary integrity / acceptance | passed / passed |

shared Claude 用 20 turns 完成任务；isolated Claude 用 61 turns 仍未恢复正确命令。shared 的 Agent input/output 为 31,065/1,397，isolated 为 65,252/4,737。这一现象与有效上下文减少搜索成本的方向一致，但不能直接作为效率 uplift 结论，原因见下一节。

### 18.2 独立审计推翻了严格有效性

独立审计返回 exit 1，13 个审计组通过，只有 `leakage` 失败。源码快照、hidden verifier、manifest、Git、SQLite、Host lifecycle、上下文分臂和 runtime 都保持有效。

审计从 isolated Claude 的事件流中确认：Agent 虽然以正确 Stage 3 checkout 作为 cwd 启动，却主动把 `Glob` 扩大到整个 `repomind-test`，并读取 suite 源仓库及 isolated Stage 1/2 sibling checkout。该访问是模型真实发起且工具成功返回的，不是路径字符串误报。

因此必须把两个层次分开：

- 功能结论成立：OpenCode 产生证据，Host 自动维护 L2/L3，Claude 在 L1=0 时收到并使用派生上下文，端到端链路完成；
- 严格实验结论不成立：isolated 对照臂能读取 sibling 数据，违反 treatment isolation，不能用本轮计算因果提升或正式正确率数字。

### 18.3 根因与修复优先级

`trustedIsolatedCheckout` 允许 Claude adapter 使用 `bypassPermissions`，但该选项只是免交互授权，不是操作系统文件系统沙箱。把多个 checkout 放在同一个可读父目录时，Agent 仍能通过绝对路径越界读取。

下一步最高优先级不是扩大样本，而是增加执行时 containment：

1. 让每个 Agent 只看见当前 checkout，例如容器、Windows Sandbox，或独立低权限账户加 ACL；
2. 增加 canary 泄漏测试，主动诱导 Agent 读取 checkout 外文件，并要求系统层拒绝；
3. containment 单测和 6-stage smoke 全部通过后，再运行 repeat 5；
4. 继续保留事件级 leakage 审计作为第二道 fail-closed 门禁。

提示词声明“不要访问外部目录”不能代替权限边界，事后审计也只能发现污染，不能恢复已失效的对照实验。

### 18.4 R2 产物

完整命令、逐 stage 指标、Claude model usage、审计失败明细和结论边界记录在：

```text
D:\data\code\project\repomind-test\layered-consumption-xagent-consumer-smoke-20260811-153000\CROSS-AGENT-SMOKE-R2-LOG.md
```

| 文件 | SHA-256 |
| --- | --- |
| manifest | `4490a3c7c2a9b800acdca97cdb6eba4bb5fef0295ab7f5fe9cbace1149649385` |
| summary | `e647b0aa350e4fe3f90036b40a060fe6308ce3aa5cc6ebe8425252ded0c31476` |
| audit | `4f00003744d6d8eb2c5b0402ca96fcb1c539e46e9dbae972d6dffd966bd45b5a` |

### 18.5 核心 containment 修复

为优先解决 R2 已观察到的 Claude `Glob/Read` sibling 泄漏，Host 已在 trusted isolated checkout 模式增加 fail-closed `PreToolUse` containment，并限制 Claude 可见工具集合。文件工具的路径必须同时通过 lexical 与 canonical checkout containment；shell 输入拒绝父目录遍历、checkout 外绝对路径、home 展开和嵌套 interpreter。

聚焦验证结果为：`2 files / 10 tests`、typecheck、build 全部通过。真实 Claude canary 在 94.7 秒内返回 `CONTAINMENT_OK`：外部 Read 被拒绝、`denialObserved=true`、随机 secret 未进入事件流、`failedTools=1`。

该修复针对真实实验泄漏路径，属于 Agent tool boundary，不等价于对任意恶意仓库脚本的完整 OS sandbox。根据后续“只聚焦核心功能”的要求，本轮停止在 canary 门禁，没有继续执行 6-stage 或 repeat 5。
