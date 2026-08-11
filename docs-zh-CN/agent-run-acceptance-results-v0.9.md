# RepoMind v0.9 日常宿主运行验收结果

本文记录 RepoMind v0.9 引入的日常 `repomind run` 入口的正式八任务验收。
全部八个任务都通过产品路径检查，报告也通过完整性验证。

可执行文件报告的版本为 `0.8.0`，因为发布元数据升级被有意推迟到验收之后。
随后，确切的被测源码树以 `e88042e7772aac39661b2dcab02b534a3566f15e`
提交；之后仅变更发布元数据和本文档。

## 判定

| 问题 | 结果 |
| --- | --- |
| 全部八个任务是否检索到 Memory？ | 是：8/8 均检索到一条相关 Memory。 |
| 每个 Agent 是否正常完成？ | 是：8/8 均以退出码 0 退出。 |
| Agent 是否绕过宿主生命周期？ | 否：Agent 的 RepoMind 调用为 0。 |
| 所有 Session 是否提交并关闭？ | 是：8/8 均已提交，打开的 Session 为 0。 |
| 公开检查和隐藏检查是否通过？ | 是：两类检查均为 8/8。 |
| 产物和文件变更是否有效？ | 是：每项产物和允许列表检查均通过。 |
| v0.9 正式验收 | **通过** |

## 来源信息

| 字段 | 值 |
| --- | --- |
| 生成时间 | `2026-07-28T07:21:16.549Z`（`2026-07-28 15:21:16`，Asia/Shanghai） |
| RepoMind 报告版本 | `0.8.0`（发布前版本元数据） |
| 测试的源码 commit | `e88042e7772aac39661b2dcab02b534a3566f15e` |
| 发布版本 | `0.9.0` |
| 模型 | `cliproxyapi/gpt-5.6-terra` |
| 运行器 | OpenCode `1.18.7` |
| 运行器隔离方式 | 禁用 RepoMind MCP 的 `opencode run --pure` |
| Node.js | `v22.20.0` |
| 操作系统 | Windows `win32 10.0.26200 x64` |
| 清单版本 | `2` |
| 清单 SHA-256 | `f18d7eff043e9e80682dec95ab6fff22f88b6be5cb0f4826376077de19342511` |
| `summary.json` SHA-256 | `d698291ec2e6010dfdd257b5e5eadc49845940e6c0c2ebf29270998fbdc4ec2d` |
| `summary.md` SHA-256 | `576c47a32714e059b406d2a6290cb1d24119d7e4bbdc3434ceef98eb0cbe5737` |

完整工作区保留在
`D:\data\code\project\repomind-test\host-run-acceptance-v0.9-formal`。

| 任务 | 基线 commit |
| --- | --- |
| `renamed-module` | `14a35ca67e878584b3b2ae35a621b961eda7fe8a` |
| `failed-solution` | `565512aae51d6108774068ebee7fa81c8eedfd2f` |
| `migration-rollback` | `bd7d5c00612d70852c1814205538911eb556ca59` |
| `historical-command` | `76c1ded92559e909ba05933bfece3b77860e272d` |
| `stale-endpoint` | `059a83f5e2b35a32aa2f4ffae5a7621913b57ebc` |
| `error-contract` | `e10f1e5c09ffdbcc06c855851855e08b275bc658` |
| `dependency-boundary` | `db16b57646fa71bd631c6a1620439dc5459b538c` |
| `config-default` | `4e7df231c78977289150e45984ae5a27ee317fa8` |

## 方法

验收命令在一个新的外部工作区中，从普通模板重新构建 Manifest v2 套件。它在
记录的基线 commit 上克隆每个任务，初始化隔离的 RepoMind 数据库，预置任务清单
中的 Memory，并调用与日常 CLI 命令相同的导出实现 `runOpenCodeHost`。

宿主启动 Session，检索并注入 Memory，禁用 OpenCode 内的 RepoMind MCP，
运行 Agent，捕获命令和测试 Evidence，并提交 Session。只有在此之后，测试工具
才运行公开检查和外部隐藏检查。它还检查 Git 变更、打开的 Session、报告结构、
产物是否存在以及未脱敏的 Secret 模式。严格模式会使任何失败任务或完整性检查
返回非零进程退出码。

## 结果

| 任务 | 检索数 | Start ms | Agent ms | Commit ms | 输入 Token | 输出 Token | 变更文件 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `renamed-module` | 1 | 250.3 | 84,427.4 | 518.8 | 11,942 | 1,218 | `src/index.js` |
| `failed-solution` | 1 | 243.7 | 61,144.5 | 495.2 | 7,137 | 1,400 | `src/delivery.js`、`test/smoke.node.js` |
| `migration-rollback` | 1 | 290.6 | 32,870.9 | 536.6 | 3,670 | 605 | `migrations/20260727-user-handle.js` |
| `historical-command` | 1 | 253.0 | 27,978.6 | 509.1 | 2,748 | 451 | `package.json` |
| `stale-endpoint` | 1 | 234.8 | 27,640.5 | 549.3 | 3,442 | 553 | `src/client.js` |
| `error-contract` | 1 | 229.5 | 71,817.9 | 552.8 | 7,386 | 1,313 | `src/parse-config.js`、`test/smoke.node.js` |
| `dependency-boundary` | 1 | 230.6 | 41,573.3 | 531.0 | 5,017 | 619 | `src/digest.js` |
| `config-default` | 1 | 227.9 | 50,031.8 | 517.1 | 7,410 | 1,072 | `src/config.js`、`test/smoke.node.js` |

| 汇总项 | 结果 |
| --- | ---: |
| 已验收任务 | 8/8 |
| 检索、Session Commit、公开检查、隐藏检查 | 各 8/8 |
| Agent RepoMind 调用 | 0 |
| 每次运行后打开的 Session | 0 |
| 平均 Session Start | 245.0 ms |
| 平均 Agent 耗时 | 49,685.6 ms |
| 平均 Session Commit | 526.2 ms |
| 输入/输出 Token 总数 | 48,752 / 7,231 |
| 创建的 Evidence | 40 |
| 存储/跳过/冲突的 Memory | 11 / 0 / 0 |
| 需要进行的产物脱敏 | 0 |

## 完整性审计

- 每个任务都从所记录的 commit 开始，并且只修改允许列表中的文件。
- 预期的 `events.jsonl`、`stderr.log` 和 `run.json` 产物全部存在，
  存储的报告与其返回的 Session 标识符一致。
- 所有持久化产物均通过未脱敏 Secret 扫描。
- 每个 Agent 均正常退出，RepoMind 调用为零，并产生已提交的生命周期报告。
- 所有公开检查和外部隐藏检查均通过，每个任务结束后都没有打开的 Session。

## 限制

- 这是产品路径验收套件，不是与无 Memory 或完整历史基线的比较。比较结论仍以
  v0.8 的 72 次受控运行报告为准。
- 该套件使用 RepoMind 作者设计的八个小型 JavaScript 固件、一个模型别名、
  一个 OpenCode 版本、一个操作系统，并且每个任务只执行一次。
- Agent 耗时和 Token 数属于观察值。本次验收证明正确性和生命周期完整性，
  不证明普遍的性能优势。
- 隐藏检查在模型外部且在 Session Commit 后运行，因此其结果不会存储为
  Session Evidence。
