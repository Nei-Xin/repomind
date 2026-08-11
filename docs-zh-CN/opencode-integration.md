# OpenCode 集成

RepoMind 可以作为项目本地 stdio MCP 服务器在 OpenCode 中运行。请先构建 RepoMind：

```powershell
npm.cmd run build
```

仓库级 `opencode.json` 使用相对命令注册 RepoMind：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "repomind": {
      "type": "local",
      "command": ["node", "./dist/cli/index.js", "mcp"],
      "enabled": true
    }
  }
}
```

验证解析后的配置和 MCP 连接：

```powershell
opencode.cmd debug config
opencode.cmd mcp list
```

OpenCode 应报告 `repomind` 已连接。请从仓库根目录启动 OpenCode，确保相对路径 `dist/cli/index.js` 能正确解析。

为了保持工具用法一致，请将 `examples/opencode/AGENTS.md` 中的工作流应用到目标仓库的 Agent 说明。

RepoMind 无法自动观察 OpenCode 的其他工具。Agent 必须显式启动并提交 RepoMind Session。

## Host-managed 生命周期

### 日常命令

当 RepoMind 负责生命周期、OpenCode 负责仓库任务时，使用 `repomind run`：

```powershell
repomind run `
  --repo D:\path\to\repository `
  --task "Fix invoice quantity arithmetic" `
  --model cliproxyapi/gpt-5.6-terra `
  --timeout 600000 `
  --max-memories 5 `
  --context-budget 12000
```

仓库必须已通过 `repomind init` 初始化。`--runner` 默认为 `opencode`；当脚本必须固定使用 OpenCode 时应显式指定。省略 `--model` 可继承 OpenCode 配置的默认模型。使用 `--output <dir>` 选择一个空制品目录；否则命令会在 `~/.repomind/runs/` 下创建唯一目录，设置 `REPOMIND_DATA_DIR` 时则在该目录下创建。

`--context-budget` 默认为 12,000 字符。这是仓库上下文预算，不是完整 OpenCode prompt 的上限：它只约束注入的 current L3 Profile、相关 current L2 Narrative 和排序后的 L1 Memory。Host 生命周期说明与用户完整任务在预算之外，不会被截断。当三个符合条件的层超过预算时，较低优先级的记录可能被截取或省略。可接受范围是 1,000-24,000 字符。在 Windows 上，由于 prompt 当前通过 argv 传递，Host 会在 spawn 前拒绝超过 28,000 字符的完整渲染 prompt；还会按 libuv 的 Windows quoting 规则计算完整命令行，超过平台的 32,767 字符边界时同样拒绝。

命令按顺序执行以下阶段：

1. 启动 RepoMind Session，并在可用时检索排序 L1、相关 current L2 和 current L3 Profile。
2. 注册与该 Session 关联的持久 Host-run 记录。
3. 在 `--context-budget` 下渲染符合条件的仓库层，然后追加完整生命周期说明和当前任务。每条不可信 L1-L3 记录都逐行加 Markdown blockquote 前缀，因此伪造标题仍留在引用数据内，不会成为 Host 结构。
4. 使用 JSON 事件、`--pure` 和临时宿主 Agent 运行 OpenCode。
5. 提取最终响应以及观察到的 Shell 命令和测试 Evidence。
6. 进程正常退出后，提交成功、部分成功或失败的 Session。
7. 仅在成功 Commit 后，同步 rebuild L2、尝试生成 L3，并刷新 L4 Candidate。
8. 关闭 Host-run 记录并返回最终 Host 报告。

三个派生维护阶段都是独立报告的 best-effort 操作。没有符合条件的 L3 来源时记为 skipped，而不是 failed。维护失败不会回滚已经 committed 的 Session，也不会改变原本成功的 Host-run 结果。partial、failed 和 abandoned Run 跳过全部三个阶段。L4 维护只生成或刷新需要审查的 Candidate，绝不会自动 approve、export、install 或 execute。

Agent 进程正常退出不足以判定成功。所有观察到的 `bash`/`shell` 命令都必须为 exit code 0；任一非零命令都会把 Session Commit 为 `partial`、令 Host 报告失败并跳过派生维护。除非外部 Acceptance Harness 提供策略，Host 仍不强制至少观察到一项测试。

OpenCode 配置通过 `OPENCODE_CONFIG_CONTENT` 覆盖；仓库的 `opencode.json` 不会被改写。覆盖配置会禁用常规 `mcp.repomind` 条目，宿主提示也会禁止 RepoMind 调用。若观察到 Agent 侧 RepoMind 调用，将视为生命周期违规，该运行不能成功。其他 OpenCode MCP 配置仍然可用，而外部插件会被 `--pure` 禁用，以保证可复现性。专用 Host Agent 还会把 OpenCode 的 `external_directory` 权限设为 `deny`，使仓库任务不能通过 OpenCode 工具读取相邻的实验制品或数据目录。这是 Host 策略边界，不能替代针对恶意进程的操作系统或容器级沙箱。

在普通终端模式下，Agent 文本会随 JSON 事件到达而显示，生命周期状态写入 stderr。`--json` 会保留 stdout 仅用于最终报告，并抑制 Agent 流式输出：

```powershell
$result = repomind run `
  --repo D:\path\to\repository `
  --task "Fix invoice quantity arithmetic" `
  --json | ConvertFrom-Json

$result.session.status
$result.agent.exitCode
$result.artifacts.report
```

制品目录包含：

- `events.jsonl`：用于提取 Evidence、已经脱敏的 OpenCode 事件。
- `stderr.log`：已经脱敏的 OpenCode stderr。
- `run.json`：schema version 3 的已脱敏生命周期、上下文注入、Agent 指标、Commit 和 Commit 后维护报告。它会记录执行前检索到的 L2/L3 ID 与版本，避免 Commit 后刷新造成“实际注入的是哪个版本”不明确。

Secret 脱敏是确定性的模式匹配，不能替代“不要把凭证放入任务提示和仓库”这一原则。制品保存在本地，但仍可能包含非 Secret 的源代码和命令输出。

即使 Agent 退出码非零，只要是正常退出，仍会以 failed 状态提交并保留失败 Evidence；命令会返回该退出码。Agent exit 0 时，任一观察到的非零 shell 命令或 stdout 捕获截断都会生成 partial Session，而不是 success Memory。超时、信号、启动失败或无效的进程完成状态会放弃 Session，并以非零状态退出。`SIGINT` 和 `SIGTERM` 分别映射到退出码 130 和 143。所有受处理的路径都会使 Session 结束为 committed、partial、failed 或 abandoned，而不是停留在 open。

无需扫描制品目录即可查询持久运行目录：

```powershell
repomind runs --repo D:\path\to\repository --status committed --limit 20 --json
repomind run-inspect ses_... --repo D:\path\to\repository --json
```

目录也会记录输出初始化失败和中断运行。使用自定义 `--output` 的运行仍能通过已存储的报告路径发现。最终报告和持久 Host-run 元数据会汇总上下文注入及派生维护结果，便于后续诊断，但不会重新定义 Session 或 Run 状态。

### 库集成

需要确定性生命周期行为的宿主可以将 RepoMind 保持在模型循环之外。包导出以下 OpenCode 集成辅助函数：

- `startHostLifecycle(repository, task, dataDirectory?)` 启动检索并返回分层 Session Start 结果及测得的启动时间。
- Host context renderer 构造有界的 current L3/L2/L1 上下文，并返回聚合注入信息，不截断任务或固定生命周期说明。
- `analyzeOpenCodeOutcome(jsonl, fallback)` 从 OpenCode JSON 事件提取最终响应和命令/测试 Evidence。
- `commitHostLifecycle(input)` 保存最终 Git diff、响应、测试或命令 Evidence；成功的 Host Commit 还会执行 best-effort 派生维护，维护失败不会改变 Commit 成功状态。
- `abandonHostLifecycle(repository, sessionId, dataDirectory?)` 在无法安全提交 Agent 执行时关闭开放的宿主 Session。
- `runOpenCodeHost(options)` 实现完整的有界上下文日常生命周期，并支持注入进程执行器和用于宿主集成的 `AbortSignal`。

自动维护属于 Host-managed helpers 和 `repomind run`。直接调用 `commitSession`、使用 `repomind commit` 或通过 `repo_session_commit` 提交都不会触发它；这些调用方可以显式执行现有 CLI/MCP rebuild 操作。

受控评估 runner 通过以下命令测试该真实集成：

```powershell
node .\dist\cli\index.js eval --agent `
  --manifest D:\path\to\manifest.json `
  --lifecycle host-managed `
  --model cliproxyapi/gpt-5.6-terra `
  --output D:\path\to\results
```

在该模式下，OpenCode 不会收到 RepoMind MCP 服务器。宿主负责关闭 Session，报告中的端到端总时间包含 start、Agent、commit 和成功 Commit 后 maintenance 四个阶段。
