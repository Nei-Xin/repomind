# 14 小型三臂 18-run Agent 实验

> 实验日期：2026-08-12  
> 运行代码：`58ef9029571432952005eb721edef16ccc960d1a`  
> 实验规模：`3 tasks × 3 arms × 2 repeats = 18 Agent runs`  
> 结论等级：Integrity 与预注册 Acceptance 通过；效率结果因每任务仅重复 2 次，只作方向性证据

## 1. 实验目的

这次实验以较低成本复核三个真实用户问题：

1. 没有历史信息时，Agent 能否仅依靠当前代码恢复正确实现；
2. 完整历史和 RepoMind 精炼上下文能否提高需要历史知识的任务正确率；
3. RepoMind 相对 no-memory 与 full-history 的耗时、Token 和代码探索成本如何。

它不是新的大规模普遍性研究，也不拆分 L1、L2、L3 的独立贡献。

## 2. 预注册设计

### 2.1 环境与实验臂

| 项目 | 配置 |
| --- | --- |
| Runner | OpenCode `1.18.15` |
| Model | `cliproxyapi/gpt-5.6-luna` |
| OS | Windows |
| RepoMind | `1.0.0-rc.2` |
| 生命周期 | RepoMind 使用 Host-managed |
| 实验臂 | no-memory、full-history、RepoMind |
| 重复数 | 每个任务、每个臂 2 次 |

三个任务分别是：

- `historical-command`：需要恢复历史发布命令；
- `stale-endpoint`：需要知道已经迁移的 endpoint；
- `error-contract`：需要恢复既有错误处理契约。

每个 run 使用独立 Git clone；每个 RepoMind run 还使用独立数据目录。iteration 1 的顺序为 no-memory -> full-history -> RepoMind，iteration 2 为 full-history -> RepoMind -> no-memory，以减少固定顺序偏差。Public checks、hidden checks 和允许修改文件均由 manifest 固定，原始事件、stderr、工作仓库、SQLite 和汇总报告全部保留。

### 2.2 预注册门禁

- Integrity 必须通过；
- RepoMind hidden 必须为 `6/6`；
- RepoMind 相对 no-memory 的 hidden pass rate 至少提高 `0.5`；
- RepoMind hidden 不劣于 full-history；
- RepoMind retrieval、Session Commit 均为 `100%`；
- RepoMind 相对 no-memory/full-history 的平均总时长回归均不得超过 `25%`；
- RepoMind 相对 no-memory 的 input token 或 file reads 至少一项改善。

因为只有两次重复，效率指标即使通过门禁，也不能外推为对所有仓库、模型和任务都稳定提升。

## 3. 实际执行命令

先执行模型健康探针：

```powershell
opencode.cmd run --pure --format json --model cliproxyapi/gpt-5.6-luna --dir D:\data\code\project\repomind "Return exactly READY. Do not inspect files or call tools."
```

模型返回 `READY`，exit code 为 `0`。

正式实验命令：

```powershell
node dist/cli/entry.js eval --agent `
  --manifest D:\data\code\project\repomind-test\three-arm-18run-20260812\manifest.json `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --lifecycle host-managed `
  --repeat 2 `
  --timeout 600000 `
  --output D:\data\code\project\repomind-test\three-arm-18run-20260812\results-formal `
  --strict `
  --require-acceptance `
  --json
```

第一次启动在任何 Agent 调用前失败：初始 manifest 误把仓库内 fixture 模板目录作为可 clone Git 仓库，Runner 报告 `Clone historical-command failed`。失败目录只有空的 `runs/`、`data/` 骨架，没有形成实验样本。

随后使用官方脚本生成独立 fixture suite：

```powershell
node benchmarks/agent-suite/create.mjs D:\data\code\project\repomind-test\three-arm-18run-20260812\fixture-suite
```

正式 manifest 只修正 base repository、hidden verifier 和 `baseCommit` 的物理路径，不改变任务、处理、重复数与验收阈值；正式输出写入此前不存在的 `results-formal/`。

## 4. 完整性结果

正式命令耗时 `1533.7 s`，约 25.6 分钟，exit code 为 `0`。

```text
Runs: 18/18
Agent clean exit: 18/18
Public checks: 18/18
Unexpected file changes: 0
Integrity: passed
Acceptance: passed (9/9 gates)
```

审计产物进一步确认：

- 18 个独立 run repository；
- 18 个独立 data directory；
- 18 个非空 raw JSONL，重新解析 `malformedLines=0`；
- 18 个 stderr 文件，总大小为 0 bytes；
- RepoMind 6/6 retrieval、6/6 Commit、6/6 maintenance；
- 清理后 open Session 为 0；
- Agent 内 RepoMind calls 为 0；
- 主 Runner 和独立 `agent-profile --strict` 的 Integrity 均通过。

## 5. 正确率结果

| Arm | Hidden checks | Public checks |
| --- | ---: | ---: |
| no-memory | 2/6 | 6/6 |
| full-history | 6/6 | 6/6 |
| RepoMind | 6/6 | 6/6 |

逐任务 hidden 结果：

| Task | no-memory | full-history | RepoMind |
| --- | ---: | ---: | ---: |
| historical-command | 0/2 | 2/2 | 2/2 |
| stale-endpoint | 0/2 | 2/2 | 2/2 |
| error-contract | 2/2 | 2/2 | 2/2 |

RepoMind 相对 no-memory 的 hidden pass rate 绝对提高 `0.667`；相对 full-history 为 `0`，即正确率相同。no-memory 能从当前代码和测试自行恢复 error contract，但无法稳定猜出精确历史命令和已经迁移的 endpoint。

## 6. 效率结果

### 6.1 RepoMind 相对 no-memory

| Metric | no-memory mean | RepoMind mean | Relative delta | 95% interval / W-T-L |
| --- | ---: | ---: | ---: | --- |
| Wall duration | 102.65 s | 73.71 s | **-28.19%** | `-47.39 s to -10.49 s`；6/0/0 |
| Input tokens | 22,194 | 15,747 | -29.05% | `-18,238 to +5,345`；4/0/2 |
| Output tokens | 1,375 | 1,038 | **-24.52%** | `-493 to -181`；6/0/0 |
| File reads | 4.33 | 2.33 | **-46.15%** | 5/1/0 |
| Tool calls | 19.00 | 12.83 | **-32.46%** | `-8.45 to -3.88`；6/0/0 |

正确率、耗时、输出量和探索行为的方向一致。Input token 点估计下降 29.05%，但 95% 区间跨 0，因此不能写成稳定显著下降。

### 6.2 RepoMind 相对 full-history

| Metric | full-history mean | RepoMind mean | Relative delta | 95% interval / W-T-L |
| --- | ---: | ---: | ---: | --- |
| Hidden pass | 6/6 | 6/6 | 0 | 0/6/0 |
| Wall duration | 75.67 s | 73.71 s | -2.60% | `-9.33 s to +5.41 s`；3/0/3 |
| Input tokens | 12,901 | 15,747 | **+22.07%** | `-2,605 to +8,298`；2/0/4 |
| Output tokens | 981 | 1,038 | +5.76% | `-164 to +277`；4/0/2 |
| File reads | 2.67 | 2.33 | -12.50% | 2/4/0 |
| Tool calls | 13.67 | 12.83 | -6.10% | `-3.62 to +1.96`；2/2/2 |

RepoMind 与 full-history 正确率相同，耗时与工具调用没有稳定差异。RepoMind input token 点估计反而高 22.1%，主要由 `error-contract` 的任务异质性造成，而且成本区间均跨 0。本轮不支持“RepoMind 全面优于 full-history”，只支持“正确率相同、文件读取略少、总体成本近似”。

## 7. Host 生命周期与分层归因

六个 RepoMind run 的生命周期结果：

```text
retrieval: 6/6
session committed: 6/6
derived maintenance success: 6/6
open sessions after cleanup: 0
RepoMind calls inside Agent: 0
mean Start: 291.6 ms
mean Commit: 516.5 ms
mean maintenance: 8.8 ms
```

seed 阶段生成了 current L2/L3，Host 也成功发现它们；但 provenance-aware dedup 判断这些来源已经由更具体的 L1 覆盖：

```text
mean injected L1/L2/L3 = 1/0/0
mean repository context = 401 chars / 12,000-char budget
```

因此本轮效果实际由 L1 承担，不能作为 L2/L3 独立 uplift 证据。它验证的是当前 Host 的精炼 L1 路径，以及 L2/L3 发现、跨层来源去重、成功 Commit 后自动 maintenance 和 Agent 内零 RepoMind 协议调用。

## 8. 可审计证据

RepoMind provenance 中的 `repoMindDirty=true` 仅来自源码仓库原有的未跟踪 `tmp/`。运行代码固定为提交 `58ef9029571432952005eb721edef16ccc960d1a`；`tmp/` 未进入 fixture clone、Prompt、允许修改范围或实验输出，未发现实验臂污染。

关键文件 SHA-256：

```text
manifest.json
9d4743b7a0b01f361771adbde7965f167f6db3520f2522a79f62ee4d41519920

results-formal/summary.json
52490f294acd6b35ac314a69991aa418ba30a16536ea6db81d2fa81fbcbf0ede

results-formal/profile/profile.json
68f9f981f4f41c420f5dc3b366d25740585ef7a0582bf260d1609eea9afe0b02
```

完整机器产物保留在外部实验目录 `D:\data\code\project\repomind-test\three-arm-18run-20260812\results-formal`，没有将 clone、SQLite、JSONL 等大体积运行数据复制进产品仓库。

## 9. 最终结论与边界

可以采用的表述：

> 在 OpenCode/Luna、Windows、3 类固定合成任务、每项 2 次重复的 18-run 小型三臂实验中，Integrity 与预注册 Acceptance 全部通过。RepoMind 和 full-history hidden 均为 6/6，no-memory 为 2/6。RepoMind 相对 no-memory 平均减少 28.2% wall time、24.5% output tokens 和 46.2% file reads；相对 full-history 正确率相同、耗时近似，但 input token 点估计高 22.1%。本轮 RepoMind 实际注入 L1，L2/L3 因来源去重未注入。

不能据此声称：

- RepoMind 对所有任务、仓库和模型都优于 no-memory；
- RepoMind 比 full-history 更省 Token 或全面更高效；
- 当前结果证明了 L2/L3 的独立贡献；
- 两次重复足以给出稳定总体统计结论；
- 合成 fixture 等同于长期真实用户使用。
