# RepoMind v0.14 规模验收

## 目标

规模运行器用于验证：在开始 L4 Skill Candidate 工作之前，现有 L0-L3 基础
在仓库范围内存在 10,000 条 L1 记录时仍然可用。这是一项性能和完整性验收，
而不是提取质量或 Agent 任务成功率基准。

## 数据集

运行器将指定的真实 Git commit 克隆到一个新工作区，并使用隔离的
`REPOMIND_DATA_DIR`。它通过 RepoMind 公共 API 精确记录 10,000 个
确定性的 L1 条目。每个条目都具有：

- 一条独立的手动 Evidence 记录；
- 一个真实的被跟踪文件关联；
- 一条创建审计记录；
- 仓库或模块作用域；
- 十种公共 Memory 类型之一；以及
- 一个确定性的英文标识符和混合语言标签。

运行器构建一个 64 维离线确定性向量缓存。这样可以保持实验可复现，并测量
有缓存的本地混合检索；它不模拟远程 Embedding 延迟或成本。

## 硬性门槛

| 操作 | 目标 |
| --- | ---: |
| FTS 命中和空结果搜索 P95 | 小于 150 ms |
| 有缓存的混合搜索 P95 | 小于 500 ms |
| Memory Inspect P95 | 小于 100 ms |
| 不使用远程模型的 Session Start P95 | 小于 1 秒 |
| CLI 冷启动 P95 | 小于 1 秒 |

如果计数发生偏移、某条 L1 缺少 Evidence、FTS 或向量缓存不完整、抽样 Recall
未命中、仓库数据跨越 Project ID 边界、SQLite 完整性检查失败、外键检查失败，
或仍有 Session 处于打开状态，运行也会失败。

## 运行

每次都使用新工作区；运行器拒绝覆盖已有路径。

```powershell
npm run bench:scale-10k -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\v0.14-scale-<new-id> `
  --commit <full-commit> `
  --repeat 50
```

工作区中会生成 `scale-10k-report.json` 和 `scale-10k-report.md`。
报告记录确切 commit、脚本校验和、工作树状态、操作系统、Node.js、CPU、内存、
生成器配置、数据库大小、观测到的进程内存峰值、播种吞吐量、原始延迟样本、
检查项和明确的限制。

CI 和本地开发可以用较小数据集运行完整运行器：

```powershell
npm run bench:scale-10k -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\v0.14-scale-smoke-<new-id> `
  --smoke --count 100 --repeat 20
```

只有显式 smoke 模式接受 `--count`，且仅允许 100-1,000 条记录。Smoke 报告
使用不同的报告类型，并将 `formalScaleTargetEvaluated` 设为 `false`。它会执行
13 项数据完整性、Recall、隔离、数据库及 Session 检查，但只记录延迟；
不会应用六项依赖机器性能的门槛，也不能作为 10,000 条 L1 结果的引用证据。

## 结果解读

通过此运行器可证明指定机器和数据集上的本地操作满足要求。它不能证明远程 LLM
提取质量、远程 Embedding 行为、Coding Agent 结果改善、L4 Skill Candidate、
逻辑合并导入或加密归档。跨平台 CI 只应使用较小测试来运行此运行器的实现；
正式的 10,000 条 L1 报告必须保留原始产物和环境元数据。

CLI 冷启动样本每次都会启动新的 Node.js 进程。采样之间不会清除操作系统文件
缓存或数据库页缓存。

## 正式发布证据

干净 commit 上的 v0.14 验收于 2026-07-29 通过全部 19 项门槛。
运行器和目标检出均固定在 commit
`01d79f26b572a8caf9d2e1c4376991c24f2209fd`，报告记录的
`repoMindWorktreeDirty` 为 `false`。

原始产物保留在仓库外部的以下位置：

```text
D:\data\code\project\repomind-test\v0.14-scale-20260729-09
```

JSON 报告的 SHA-256 为
`6f82f0ff52c28b6117d05040fb2974a6b11bf5185c583824ac4305727b5acb43`；
Markdown 报告的 SHA-256 为
`efa578f052fe60994112188d2e7e55413409c7c8b3a87a064e7a7b14b8a54af1`。
报告中记录的运行器脚本 SHA-256 为
`8f85e93d0fedb751c5cecf8e8488fc64d0a18a2a44ab36c97b8bd733d771b178`。

本次运行以每秒 319.880 条记录的速度存储了 10,000 条 L1。全部 10,000 条
记录都处于 active 状态，具备 Evidence 和文件关联，已审计、已加入 FTS 索引，
并在缓存向量索引中有对应表示。SQLite/WAL/SHM 占用 41,218,048 字节，
观测到的进程 RSS 达到 194,277,376 字节。

| 操作 | P95 ms | 门槛 | 结果 |
| --- | ---: | ---: | --- |
| FTS 命中 | 80.363 | 小于 150 | 通过 |
| FTS 空结果 | 76.431 | 小于 150 | 通过 |
| 有缓存的混合搜索 | 302.774 | 小于 500 | 通过 |
| Memory Inspect | 0.891 | 小于 100 | 通过 |
| Session Start | 621.154 | 小于 1,000 | 通过 |
| CLI 冷启动 | 374.829 | 小于 1,000 | 通过 |

随后，GitHub Actions [CI 运行 #53](https://github.com/Nei-Xin/repomind/actions/runs/30376367751)
在同一 commit 上用时 4 分 19 秒通过。五个成功 job 分别为 Ubuntu、Windows、
macOS 验证矩阵、覆盖率和对比基准。该次运行保留了覆盖率和对比报告两类产物。

此证据在 Windows 11 x64、Node.js 22.20.0 和 AMD Ryzen 7 H 255 处理器上产生。
它证明该机器和确定性数据集满足上述本地规模和完整性门槛；前述限制仍然适用。
