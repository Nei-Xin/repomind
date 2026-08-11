# 日常仓库工作流

除日常使用的 `repomind run` 命令外，RepoMind v0.10 又增加了两项能力：可审查的冷启动候选项和持久化运行历史。

## 冷启动仓库的 Bootstrap

只需初始化仓库一次，然后在工作树之外生成候选项 bundle：

```powershell
repomind init --repo D:\path\to\repository --json

repomind bootstrap `
  --repo D:\path\to\repository `
  --output D:\data\code\project\repomind-test\my-project-bootstrap.json `
  --json
```

对于仓库记忆而言，生成操作是只读的。它会检查根目录的 `README.md`、根目录的 `CONTRIBUTING.md`、`docs/adr` 下最多 50 个 Markdown ADR，以及最近 20 条 Git commit 标题。超过 128 KiB 的大型 Markdown 文件会跳过，代码围栏会省略，候选内容有长度上限，并且已知 Secret 模式会在 bundle 写入前被脱敏。

每个候选项都记录确定性 ID、Memory 类型、置信度、标签、来源引用和来源 SHA-256。README 和贡献指南候选项的置信度有意低于 ADR 候选项。Git 历史被表示为一个低置信度候选项，而不是二十个未经确认的事实。

检查 JSON，并在不存储任何内容的情况下预览全部候选项：

```powershell
repomind bootstrap-apply `
  --repo D:\path\to\repository `
  --input D:\data\code\project\repomind-test\my-project-bootstrap.json `
  --json
```

由于仍缺少确认，预览会按设计以失败状态退出。使用 `--yes` 应用全部已审查候选项，或应用显式指定的逗号分隔子集：

```powershell
repomind bootstrap-apply `
  --repo D:\path\to\repository `
  --input D:\data\code\project\repomind-test\my-project-bootstrap.json `
  --candidate btc_0123456789abcdef01234567,btc_89abcdef0123456789abcdef `
  --yes `
  --json
```

应用 bundle 时会检查项目 ID，并重新计算每个选中来源的哈希。发生变化、已删除、位于仓库之外、未知或属于其他项目的来源都会被拒绝。通过 RepoMind 现有的 Memory 指纹规则，重复应用未变化的候选项具有幂等性。

## 使用有界分层上下文运行

```powershell
repomind run `
  --repo D:\path\to\repository `
  --task "Implement the next repository change" `
  --context-budget 12000
```

默认的 12,000 字符预算只作用于注入的仓库上下文：current L3 Profile、相关 current L2 Narrative 和排序后的 L1 Memory。RepoMind 将完整当前任务和固定 Host 生命周期说明放在预算之外，因此上下文压力不会静默截短用户请求。Host 报告会汇总有界上下文 renderer 注入、截取或省略了什么。可接受范围为 1,000-24,000 字符。Windows 还会在启动进程前拒绝超过 28,000 字符的完整 Host prompt，因为当前实现通过 argv 传递 prompt；同时会按 libuv 的 Windows quoting 规则计算完整命令行，超过平台的 32,767 字符边界也会在 spawn 前拒绝。

当该 Host-managed Run 成功 Commit 时，RepoMind 会同步 rebuild L2、尝试生成 L3，并刷新 L4 Candidate。没有符合条件的 L3 来源是正常的 skipped 状态。其他维护错误会独立记录，不会撤销 Commit，也不会改变原本成功的 Run。partial、failed 和 abandoned Run 不执行派生维护。L4 输出始终需要人工审查；自动 approve、export、install 和 execute 都不属于该生命周期。

该行为仅适用于 `repomind run` 和 Host-managed 库路径。Agent-managed 使用、`repomind commit` 和 `repo_session_commit` 仍需显式调用 `module-rebuild`、`profile-rebuild`、`skill-rebuild` 或对应 MCP Tool。手动控制继续用于修复、管理和有意重建。

## 检查日常运行

现在每次 `repomind run` 都会创建一条与其 Session 关联的 `host_runs` 记录。该记录独立于制品目录，因此使用自定义 `--output` 的运行仍可被发现。

```powershell
repomind runs --repo D:\path\to\repository --limit 20 --json

repomind runs `
  --repo D:\path\to\repository `
  --status failed `
  --limit 50 `
  --json

repomind run-inspect ses_... `
  --repo D:\path\to\repository `
  --json
```

当前 Run ID 与对应 RepoMind Session ID 相同。列表和详情结果包含任务、模型、生命周期状态、检索数量、Agent 退出码和信号、检索到的 Memory ID、耗时、输入/输出 Token、Agent 侧 RepoMind 调用次数、输出和报告路径、失败文本、阶段计时、脱敏次数及时间戳。Host-managed 报告和持久化元数据还会汇总有界上下文注入与成功 Commit 后的派生维护；维护错误是诊断状态，不会取代 Run 状态。

宿主在 Session 检索后立即注册运行。正常退出、非零退出、超时、信号和输出初始化失败都会关闭 Session 与运行记录。迁移会原地升级现有仓库数据库；历史 v0.9 Session 不会补造运行记录。

## 持续使用检查

一个实用的真实仓库冒烟测试如下：

1. 执行 Bootstrap，并且只确认仍然权威的事实。
2. 运行一个会修改仓库的任务，并提交清晰的最终摘要。
3. 检查 `run.json`，确认 Session 已提交、仓库上下文没有超过配置预算，并且 Commit 后维护已完成或记录了明确的 skipped 状态。
4. 运行一个相关的第二任务。
5. 检查第二次运行的 `run.json`，确认其有界 L3/L2/L1 上下文和提示行为反映了第一次任务的持久结果。

自动化测试 `daily-workflow.test.ts` 会在不使用模型的情况下执行该序列：它为冷仓库执行 Bootstrap，提交第一次 Host-managed 运行，并证明第二次运行会在注入的提示中收到第一次运行的精确摘要。
