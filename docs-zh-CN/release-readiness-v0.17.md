# RepoMind v0.17 发布分发与升级就绪情况

## 目标

本轮工作证明可安装的 npm 产物和历史数据库升级路径。仅测试源码检出无法证明
包元数据、生成的 bin 入口、随包文件、运行时依赖或恢复命令在安装后可以工作。

## 打包安装验收

通过 npm 运行验收，使运行器可以调用同一个 npm CLI，而无需依赖平台特定的
Shell 包装器：

```powershell
npm run bench:package-smoke -- `
  --workspace D:\data\code\project\repomind-test\v0.17-package-<new-id>
```

运行器拒绝使用已存在的工作区。它仅在新工作区中执行以下操作：

1. 使用 `npm pack --json` 构建并打包 RepoMind；
2. 将 tarball 安装到隔离的消费方项目；
3. 检查包清单、bin shim、校验和及禁止文件列表；
4. 创建临时 Git 仓库和隔离的 `REPOMIND_DATA_DIR`；
5. 通过已安装包运行 Init、Record、Search、Inspect、Backup、恢复预览及确认的 Restore；
6. 启动已安装的 MCP 服务器并调用 Start、Search、Inspect 和 Abandon；以及
7. 写入 `package-smoke-report.json` 和 `package-smoke-report.md`。

如果包中包含数据库、`.repomind`、`.env`、本地 Agent 配置、顶层开发测试套件或
覆盖率输出，就会被拒绝。有意保留的 Benchmark 固件仍会打包，因为已安装的
`eval` 命令需要使用它们。运行器不会发布到 npm，也不使用远程 LLM 或 Embedding
凭据。

GitHub CI 会在完整测试套件之后，于 Ubuntu、Windows 和 macOS 上运行同一验收。

## 已发布 Schema 固件

`tests/fixtures/released-schema-manifest.json` 记录 v0.4.0 至 v0.17.0
的每个 Git 标签、随附 Schema 版本，以及每个已发布 Migration 主体的 SHA-256。
如果旧 Migration 被编辑或某个发布映射消失，测试将失败。

对于每个不同的已发布 Schema，Migration 套件会预置该版本支持的、有代表性的
仓库、Session、Evidence、L1、文件、Audit、向量、宿主运行、L2、L3 和 L4 数据行。
通过当前数据库层打开时，必须应用所有后续 Migration，同时保留适用的数据行、
外键和 SQLite 完整性。

一个有意构造的不兼容 v5 数据库会强制 Migration 6 失败。测试要求 Migration
版本和现有数据保持不变，随后移动被拒绝的数据库文件，以证明失败的构造函数已经
释放 SQLite 句柄。

## 发布门槛

v0.17.0 发布要求：

- 本地类型检查、构建、测试、覆盖率和打包安装验收通过；
- 一个干净 commit 通过全部 GitHub CI job，包括三次打包安装矩阵执行；
- 在此记录干净 commit 的包报告和 CI 运行；以及
- 外部真实开源验收已经完成，或仍明确列为 v1.0 证明门槛。

## 本地实现结果

第二次本地运行在 Windows 和 Node.js 22.20.0 上通过全部 11 项门槛。它从包含
249 个条目的 tarball 安装 `repomind@0.16.0`，未发现禁止文件，暴露全部 24 个
MCP 工具，完成 CLI 和 MCP 生命周期，恢复基线 Memory，移除备份后的变更，
并且打开的 Session 数为零。

产物保留在仓库外部：

```text
D:\data\code\project\repomind-test\v017-package-local-20260729-02
```

- JSON 报告 SHA-256：
  `bf217fdbc5736ac97adf86c721f533f669c40689778c88486ee2655eb0eab8c9`
- Markdown 报告 SHA-256：
  `ef94dc705158944a45ca8c507fb30143782b5621395fde3e6c0fc6f7455563de`
- tarball SHA-256：
  `fa34e2c5a8dc7ba918bce370adf8f68c7fda3dc191295716dcd52778ad4bd1d4`

第一次尝试保留在
`D:\data\code\project\repomind-test\v017-package-local-20260729-01`，不计入结果。
所有产品操作都通过，但最初的禁止文件规则把 `benchmarks/` 下有意保留的 Agent
Benchmark 隐藏检查误认为顶层开发测试套件。修正后的规则仍会拒绝顶层测试、
数据库、本地配置和覆盖率输出。

完整本地回归通过 38 个文件中的 169 项测试。覆盖率达到既有下限：语句/行 83.82%、
分支 77.54%、函数 95.04%。

## 干净 commit 跨平台结果

Commit `432f4f68523fe4275716b8089aa28afd7b3fbab3` 在干净工作树中修复了
包运行器、Migration 固件、产品代码和文档。
[GitHub Actions 运行 30444019485](https://github.com/Nei-Xin/repomind/actions/runs/30444019485)
于 2026-07-29 成功完成。

五个 job 全部通过：Ubuntu 验证、Windows 验证、macOS 验证、源码覆盖率和对比基准。
每个验证 job 都完成类型检查、构建、全部 169 项测试、八任务固件验证，以及新的
已安装 tarball 验收。因此，package-smoke 命令通过生成的 npm bin shim 在全部
三个受支持 CI 操作系统上成功运行。macOS 验证 job 用时 1 分 10 秒；最慢的矩阵
job Windows 用时 6 分 18 秒。

这关闭了 v0.17 的分发和升级发布门槛。它本身不满足另一项 v1.0 要求，即在外部
真实开源仓库上提供跨 Session 收益案例。

## 正式发布和标签结果

发布 commit `6961a65ed0e96c90fc3041811da4b5ceb7f5d8e2` 更新了包版本、
Changelog 和发布措辞。附注标签 `v0.17.0` 指向该 commit，并于 2026-07-29 推送。

[GitHub Actions 标签运行 30451648338](https://github.com/Nei-Xin/repomind/actions/runs/30451648338)
用时 6 分 5 秒成功完成。Ubuntu、Windows、macOS、覆盖率和对比 job 均在该标签
commit 上通过。这与成功的主分支发布 commit 运行 `30451228817` 相互独立。

## 发布后外部证明

随后，单独的外部真实开源标准在固定的 MIT 许可 `sindresorhus/p-limit` 仓库上通过。
Claude Code 任务 1 创建了有 Evidence 支持的 Memory，之后三组使用全新上下文的
OpenCode 任务 2 配对运行，从相同的任务 1 后 commit 比较无 Memory 与宿主管理的
RepoMind。两组均通过所有检查；RepoMind 将平均输入 Token 减少 41.1%，将 Agent
耗时减少 17.5%，而且每一组配对都有这两项改善。参见
[`external-open-source-cross-session-acceptance-v0.17.md`](external-open-source-cross-session-acceptance-v0.17.md)。

该发布后报告关闭了最后一项 v1.0 证明标准，但不会改变已经发布的 v0.17.0 标签
内容或身份。

## 下一轮安全迭代

在 v0.17 分发证明提交且跨平台 CI 通过后，下一轮限定范围的安全迭代应增加可选择
启用的加密逻辑导出和物理备份归档。它必须使用认证加密、内存困难型密码 KDF、
版本化信封元数据、错误密钥和篡改时的零写入行为，以及仅在执行时提供的凭据。

逻辑合并导入仍然推迟。它需要为 Project ID、重复 Memory、Evidence 身份、冲突、
替代关系、Audit 历史和 L2-L4 派生数据单独制定策略；将替换当作合并会违反当前
恢复契约。
