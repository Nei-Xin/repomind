# RepoMind v0.17 外部开源仓库跨 Session 收益验收

## 结果

正式验收于 2026-07-29 通过。Claude Code 在真实 `sindresorhus/p-limit` 仓库上的任务生成了有 Evidence 支持的 RepoMind Memory。后续六个 OpenCode Session 从同一个 Task 1 后 commit 启动，对比三次 no-memory 与三次 RepoMind 运行。两个 arm 均通过全部 public 和外部 hidden check。RepoMind 将平均输入 Token 降低 41.1%，将平均 Agent 耗时降低 17.5%，三组配对重复均有改善。

这闭合了最终产品规范中的外部真实开源跨 Session 证明标准。它证明一个有界收益案例，不声称每个仓库任务都会更快或使用更少 Token。

## 外部仓库与固定状态

| 字段 | 值 |
| --- | --- |
| Upstream | `https://github.com/sindresorhus/p-limit.git` |
| Upstream tag | `v7.3.1` |
| Upstream commit | `df476048d023ff868cd45b35ee47f5fb0ca2b25a` |
| License | MIT |
| License SHA-256 | `5c932d88256b4ab958f64a856fa48e8bd1f55bc1d96b8149c65689e0c61789d3` |
| 共享 Task 1 后 commit | `a8d74fe28f000ec4f323e43c10863b0d47c7d8b3` |
| RepoMind | `0.17.0` / `6961a65ed0e96c90fc3041811da4b5ceb7f5d8e2` |
| Task 1 Agent | Claude Code `2.1.220` / `gpt-5.6-luna` |
| Task 2 Agent | OpenCode `1.18.7` / `cliproxyapi/gpt-5.6-terra` |
| 主机 | Windows x64 / Node.js `v22.20.0` |

保留 workspace 位于产品仓库之外：

```text
D:\data\code\project\repomind-test\v017-external-cross-session-20260729-01
```

协议在两个任务运行前登记，SHA-256 为 `df1d481f6917a33a14b5c3e7254a8976a4570594cad17214dddb01d1efc567e4`。Task prompt、hidden verifier、原始 Agent 事件、进程报告、克隆运行仓库、隔离 RepoMind 数据库和每次运行哈希均保留在该 workspace。

## 连续任务

Task 1 要求全新、无持久会话的 Claude Code 在 runtime、TypeScript declaration、README、AVA 测试和 tsd 测试中加入只读 `limit.isIdle` 行为。Claude 只修改五个 allowlist 文件。独立 `npx ava`、`npx tsd` 和外部 hidden verifier 通过。

RepoMind 提交七条 Evidence，并提取六条 L1 Memory。为 Task 2 选中的两条 Memory 是：

- solution `mem_0dc72b3b-b23e-4b41-bd4a-e44ce9dfa700`，绑定 Git snapshot、Git diff、测试结果、命令结果、Agent summary 和全部五个文件哈希；
- decision `mem_9c0edabe-647a-4e31-b7d1-13b7d4cf8726`，记录公共 API property 必须更新 `index.js`、`index.d.ts`、`readme.md`、`test.js` 和 `index.test-d.ts`。

Task 2 要求全新 OpenCode Session 添加只读 `limit.isSaturated`。提示描述行为，但不重复 Task 1 的五文件约定。每个 arm 克隆相同 Task 1 commit，使用相同模型、提示 wrapper、Agent 限制、依赖树、10 分钟 timeout、public check、hidden verifier 和 allowlist。唯一处理差异是 Host-managed RepoMind 生命周期注入的两条 Task 1 Memory。重复之间轮换执行顺序。

在该 Windows 主机上，上游聚合 `npm test` 在任何任务修改前就会失败，因为 XO 无法将 declaration file 关联到 TypeScript project service，并报告现有 TODO 警告。协议在 Agent 执行前记录了这一点。独立 AVA 和 tsd 命令在上游状态通过，因此被固定为 public check。

## 结果

| 重复 | Arm | Public | Hidden | 检索数 | 文件读取 | 输入 Token | 输出 Token | Agent ms |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | no-memory | 通过 | 通过 | 0 | 6 | 25,983 | 2,428 | 114,653 |
| 1 | RepoMind | 通过 | 通过 | 2 | 6 | 16,376 | 2,059 | 106,587 |
| 2 | RepoMind | 通过 | 通过 | 2 | 6 | 13,975 | 2,092 | 95,512 |
| 2 | no-memory | 通过 | 通过 | 0 | 6 | 33,303 | 2,073 | 124,848 |
| 3 | no-memory | 通过 | 通过 | 0 | 6 | 16,665 | 2,068 | 104,740 |
| 3 | RepoMind | 通过 | 通过 | 2 | 6 | 14,385 | 1,915 | 81,794 |

| 指标 | No memory | RepoMind | 变化 |
| --- | ---: | ---: | ---: |
| Public pass rate | 100% | 100% | 0 pp |
| Hidden pass rate | 100% | 100% | 0 pp |
| 平均输入 Token | 25,317 | 14,912 | **-41.1%** |
| 平均输出 Token | 2,190 | 2,022 | **-7.7%** |
| 平均 reasoning Token | 738 | 695 | **-5.8%** |
| 平均 Agent 耗时 | 114,747 ms | 94,631 ms | **-17.5%** |
| 平均文件读取 | 6 | 6 | 0 |
| 平均重复文件读取 | 0 | 0 | 0 |

RepoMind 输入 Token delta 为 `-9,607`、`-19,328` 和 `-2,280`；Agent 耗时 delta 为 `-8,066`、`-29,336` 和 `-22,945` ms。因此每组配对重复的两项主要效率指标都有改善。不声明文件读取收益。

每次 RepoMind 运行都检索到同两条相关 Task 1 Memory，Agent 侧 RepoMind 调用为零，写入 commit Evidence，并且没有 open Session 或 running Host Run。Task 2 前 Memory 为 active。Task 2 修改相关文件后，post-run inspect 正确地报告它们 uncertain；这是文件过期检测，不是错误召回。

## 透明修正

第一次生成的 summary 报告 acceptance 失败，SHA-256 为 `0dc33ae0a67923bba88881d93078a4f84bd8cbc089b976b701e531f2d6b1e0ad`。v1 runner 错误地要求 `sessionStatus === committed`，但登记门禁实际要求成功生命周期 commit。六个 Agent 都尝试了已知失败的上游 `npm test`；因此三次 RepoMind Session 在定向检查通过后被保守地关闭为 `partial`。每个 partial Session 都有 commit Evidence 和非空 commit duration，三个数据库都报告零 open Session。

没有重复任何 Agent 运行。只读重新分析将 `committed` 和 `partial` 都视为已关闭、成功提交的生命周期状态，前提是存在 commit Evidence 且无 open Session 或 Host Run。正式 JSON SHA-256 为 `25afc3699a169d92b027fbe99f2d000fc3170f63f14e32e28d0920eaf5320398`。十项正式门禁全部通过：运行完整性、public/hidden 结果、检索、生命周期 commit、Session 清理、错误召回、聚合效率、配对输入 Token 收益和配对耗时收益。

## 限制

- 这只是一个外部仓库、一对连续任务、一个 OS 和三次重复，是一个真实收益案例的 Evidence，而非整体因果估计。
- Task 1 创建本地验收 commit，没有向 upstream 提交或 push。
- 两组文件读取相同，因为两个 Agent 都检查了全部公共 API 表面。观察到的收益来自更小模型输入和更短执行时间。
- 未报告提供方货币成本，因为协议没有固定公开价格表。
