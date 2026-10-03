# 日常仓库工作流

Host 与交互式自动任务共用测试/构建步骤的状态判定：`ls`、`cat`、`rg`、
`git status` 等探索失败保留证据，不单独导致 partial。每个已识别验证步骤以最后
结果为准；同一测试或构建后来明确通过可解除先前失败，后来再次失败则仍为 partial。
目录、环境和参数不同的步骤分别跟踪；`build && test` 两步都需要解决。管道、
`|| true` 等掩盖退出状态的命令不算通过，未知测试退出码也必须有后续有效验证。
分类复用内置命令识别器，不声称支持所有自定义脚本或 Shell 语法。

Host 额外保留运行完整性检查：事件畸形/不完整、输出截断、协议违规仍导致 partial；
进程非零退出或权威验证失败仍为 failed。权威验证全部通过且仓库快照稳定时，
仍可按原规则解除验证失败。可归属到已知探索命令的未知退出结果仅作诊断；无法
归属的缺失命令结果仍视为采集不完整。超时/中断沿用 abandoned 生命周期。
Host 报告的 `quality.commands.failed` 保留原始非零/未知命令次数，
`nonVerificationFailures` 单列不阻断状态的次数，`recovered/unrecovered` 统计
验证命令失败的恢复情况；`quality.verification` 记录验证键数量和最终未解决数量。
`unknown-command-result` 可以是成功任务中的诊断标记，不应单凭该标记推断 partial。

Host（OpenCode、Claude）与交互式自动结束任务统一使用 solution 入库门槛：只有
成功任务产生了相对任务开始时的文件变更，或持久化了可信的通过测试/Host 验证
证据，才生成 solution。只读问答仍保留会话、摘要 Evidence 和运行/活动记录。
原有脏文件不算本次变更，新增、删除和任务中自行提交的变更均计入；关联文件仅
使用仍存在的文件。摘要自述“测试通过”、普通探索命令或单独构建通过不能替代
测试证据。隐藏检查若未作为公开 Evidence 保存，也不会单独触发 solution。
未知退出码只保留在 trace/活动记录，不伪造命令 Evidence。显式 CLI/MCP 提交仍
保留原有主动提交语义；不迁移旧记忆或重算历史会话。

工具采集的通过测试会使用规范化测试命令进入命令记忆；后续跨会话通过会更新同一
条记忆、追加新的 `test_result`/`command_result` Evidence 并刷新校验时间。已标记
为 `invalid` 或 `superseded` 的命令拥有不可复活的历史身份，新的输出不会重新激活
或复制它。

显式 JSON 提交可使用可选 `handoff` 标注 summary 中的完整约束与剩余工作段落：
`repomind commit --input result.json --repo /path/to/repository --json`。
输入沿用 `sessionId`、`idempotencyKey`、`status`、`summary`，增加
`handoff: { "version": 1, "constraints": [...], "remainingWork": [...] }` 即可。
旧 `remainingWork` 同时存在时必须与新数组相同。完整规则和示例见
[结构化交接](structured-handoff-v1.md)。无效结构会拒绝提交，已有会话保持 open；
修正输入后可重试。摘要文字中的“测试通过”仍不能替代命令 Evidence。

OpenCode Host 可请求可选输出协议：

```sh
repomind run --runner opencode --task "完成当前任务并交接约束与剩余工作" --structured-handoff
```

开关默认关闭，仅用于 `run`；不支持的 adapter 在启动前拒绝。协议缺失或无效时
记录诊断并沿用自由文本处理，不会仅因此重试或改变任务状态。报告中的 `handoff`
记录是否持久化、summary Evidence ID、接受/拒绝原因和标题实际采用情况。Evidence
保留含 JSON 块的完整最终回答，接受后的 solution 正文只使用块前原文。
`attempts[].prompt` 审计每次 fresh/resume 提示词；协议指令计入 promptChars，
不占召回记忆字符预算。真实模型输出可靠性及 token 收益仍待独立验收。

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
