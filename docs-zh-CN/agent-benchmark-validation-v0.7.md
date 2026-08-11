# RepoMind v0.7 Agent 基准基础设施验收

本文记录 v0.7 三组基准基础设施的确定性验收，不声明模型任务结果成功。
已完成的正式 report-v4 运行另行记录在
[`agent-benchmark-results-v0.7.md`](agent-benchmark-results-v0.7.md)；
其实验完整性通过，但预先声明的结果验收失败。

## 来源信息

| 字段 | 值 |
| --- | --- |
| 日期 | `2026-07-28`（Asia/Shanghai） |
| RepoMind 基线 commit | `d857056d8229796398f5f222fec29e7ea5540320` |
| 工作树 | 有变更的 v0.7 Candidate |
| Node.js | `v22.20.0` |
| 操作系统 | Windows `win32 10.0.26200 x64` |
| 清单模板 SHA-256 | `13ed7a5eba633b94eec84403abf8103f580607ebc6b4b46b999ed9c2793c2f74` |

## 已验收能力

- Manifest v1 保持为双组协议；Manifest v2 要求每个任务都有原始
  `fullHistory`，并运行三个实验组。
- 三组实验的执行顺序通过拉丁方在各次重复之间轮换。
- 完整历史组没有 RepoMind MCP 配置。
- Report schema v4 分别计算 RepoMind 与无 Memory、完整历史两类基线的比较。
- 验收门槛可以限制相对于两类基线的隐藏检查差值和耗时差值。
- `agent-summary` 对源报告计算哈希，并重新计算带近似 95% 区间的汇总配对指标。
- 随附套件可以确定性地重建八个 Git 仓库。

## 固件基线验证

| 任务 | 基线 commit | 公开基线 | 隐藏基线 |
| --- | --- | --- | --- |
| `renamed-module` | `14a35ca67e878584b3b2ae35a621b961eda7fe8a` | 通过 | 按设计失败 |
| `failed-solution` | `565512aae51d6108774068ebee7fa81c8eedfd2f` | 通过 | 按设计失败 |
| `migration-rollback` | `bd7d5c00612d70852c1814205538911eb556ca59` | 通过 | 按设计失败 |
| `historical-command` | `76c1ded92559e909ba05933bfece3b77860e272d` | 通过 | 按设计失败 |
| `stale-endpoint` | `059a83f5e2b35a32aa2f4ffae5a7621913b57ebc` | 通过 | 按设计失败 |
| `error-contract` | `e10f1e5c09ffdbcc06c855851855e08b275bc658` | 通过 | 按设计失败 |
| `dependency-boundary` | `db16b57646fa71bd631c6a1620439dc5459b538c` | 通过 | 按设计失败 |
| `config-default` | `4e7df231c78977289150e45984ae5a27ee317fa8` | 通过 | 按设计失败 |

使用同一模板进行两次生成的测试还要求：两个独立输出目录中的每个基线 commit
必须完全相同。

## 限制

- 随附的八个任务全部是 RepoMind 作者设计的小型 JavaScript 固件。
  更大的套件扩大了覆盖范围，但没有提高外部有效性。
- Windows 验证在本地运行。Ubuntu 验证由 CI 强制执行；在将可移植性解释为
  已获证明之前，应检查发布 commit 上的 CI 结果。
- 本基础设施文档不代表任何 OpenCode/模型任务结果。结果指标及其失败的正式验收
  仅记录在单独的 v0.7 结果文档中。
- 报告的 95% 区间使用配对差值的正态近似；解读小样本时必须谨慎。
