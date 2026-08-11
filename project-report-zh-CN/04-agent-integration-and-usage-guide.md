# 04 Agent 集成与完整使用教程

## 1. 推荐使用方式

当前最稳定的日常路径是：

```text
OpenCode + repomind run + Host-managed lifecycle
```

原因：Session Start、上下文注入、OpenCode 执行、事件解析和 Commit 都由宿主完成，不依赖模型记住生命周期协议。Agent-managed MCP 更适合需要任务中二次 search/inspect 的场景，也适合 Claude Code 等没有 Host Adapter 的客户端。

本教程使用以下路径作为示例：

```text
RepoMind 源码：D:\data\code\project\repomind
目标测试仓库：D:\data\code\project\repomind-test\yocto-queue-repomind-rc1
```

替换目标路径即可用于其他真实仓库。

## 2. 前置条件

```powershell
node --version
git --version
opencode.cmd --version
```

要求：

- Node.js `>=22.5.0`；
- Git 可用，目标目录是 Git 仓库；
- Host-managed 场景安装 OpenCode；
- 模型 Provider 已能被 OpenCode 正常调用。

Node 当前仍可能输出 `SQLite is an experimental feature` warning，这是 Node `node:sqlite` 的运行时提示，不等于 RepoMind 失败。

## 3. 构建 RepoMind

```powershell
Set-Location D:\data\code\project\repomind
npm.cmd install
npm.cmd run typecheck
npm.cmd run build
```

确认 CLI：

```powershell
node D:\data\code\project\repomind\dist\cli\index.js --help
```

为什么先 typecheck 再 build：前者确认类型契约，后者生成 MCP、CLI 和 Host Adapter 实际运行的 `dist/`。MCP 配置指向 `dist/cli/index.js`，只改源码不重新 build 不会生效。

为了让后续命令清晰，可以设置会话变量：

```powershell
$repoMindCli = "D:\data\code\project\repomind\dist\cli\index.js"
$targetRepo = "D:\data\code\project\repomind-test\yocto-queue-repomind-rc1"
```

## 4. 初始化真实仓库

先确认目标：

```powershell
git -C $targetRepo status --short
node $repoMindCli doctor --repo $targetRepo --json
```

初始化一次：

```powershell
node $repoMindCli init --repo $targetRepo
node $repoMindCli status --repo $targetRepo --json
```

预期变化：

```text
<targetRepo>/.repomind/project.json
<user data dir>/repositories/<projectId>/repomind.db
```

为什么 marker 在仓库、数据库在用户目录：marker 让不同 checkout 识别为同一项目；执行历史和可能敏感的 Evidence 不会被 Git 意外提交。

不要对已经在使用的项目随意执行 `init --new-id`。新 Project ID 会创建一套全新记忆身份，旧数据库不会自动合并。

## 5. 推荐路径：Host-managed Agent（OpenCode / Claude Code）

### 5.1 先检查模型可用性

```powershell
opencode.cmd models cliproxyapi

opencode.cmd run `
  --pure `
  --format json `
  --model cliproxyapi/gpt-5.6-luna `
  --dir $targetRepo `
  "Return exactly READY. Do not inspect files or call tools."
```

模型目录会变化。仓库外部 120 次实验开始前，原定 `gpt-5.6-terra` 已不可用，后来用 `cliproxyapi/gpt-5.6-luna` 探针确认服务。健康探针只能证明短请求可用，不能保证长任务不会超时。

### 5.2 执行第一次真实任务

选择一个会产生可复用知识的任务，而不是“打开 README”这类一次性动作。例如：

```powershell
node $repoMindCli run `
  --repo $targetRepo `
  --task "修复队列任务失败后的重试逻辑，运行相关测试，并说明关键约束" `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-luna `
  --max-memories 5 `
  --context-budget 12000 `
  --timeout 600000 `
  --json
```

不指定 `--model` 时使用 OpenCode 默认模型。不指定 `--output` 时，RepoMind 在数据目录的 `runs/` 下创建唯一目录；指定输出目录时，该目录必须尚不存在或为空。`--context-budget` 可设为 `1,000-24,000` 的整数，默认 `12,000`。Windows 上完整 Prompt 超过 `28,000` 字符会在 spawn 前拒绝；实现还按 libuv quoting 规则计算 command 与全部 argv，超过平台的 `32,767` 字符边界也会拒绝。两条路径都会 abandon Session；遇到时缩短 task 或预算。长期仍可考虑 stdin/文件以彻底移除 argv 约束。

Host 依次执行：

1. Start Session，检索最多 5 条排序后的 L1、最多 2 条相关 current L2，并读取 current L3；
2. 建立持久 Host Run 记录；
3. 在 repository-context 预算内按 L1:L2:L3=`5:3:2` 分配并渲染三个层级；完整 task、固定生命周期说明、标题和信任边界说明不计入预算且不截断；
4. 以 `opencode run --pure --format json` 启动 Agent；
5. 解析最终回答、Shell 命令和测试证据；
6. 根据正常成功、部分完成、失败、超时或 signal Commit/Abandon；
7. 仅当 Commit 结果为 committed 时，同步 best-effort 地维护 L2、尝试 L3、刷新 L4 Candidate；
8. 关闭 Host Run，写出 schema version 3 的 `run.json` 并返回报告。

为什么使用 `--pure`：避免全局插件、额外 MCP 或 Prompt 修改污染实验与日常生命周期。RepoMind MCP 也会在 Agent 内禁用，防止 Host 和 Agent 重复管理同一 Session。

### 5.3 审计运行结果

```powershell
node $repoMindCli runs --repo $targetRepo --limit 20 --json
node $repoMindCli sessions --repo $targetRepo --json
node $repoMindCli status --repo $targetRepo --json
```

从 `runs` 结果取得 ID 后：

```powershell
node $repoMindCli run-inspect <run-id> --repo $targetRepo --json
```

重点检查：

| 字段 | 期望 |
| --- | --- |
| status | `committed`，或与真实失败一致的 `partial/failed/abandoned` |
| retrievedMemories | 第一次可能为 0，后续相关任务应大于 0 |
| retrievedModuleNarrativeVersions/repositoryProfileVersion | 有可用 current L2/L3 时记录其 ID 和注入时版本，避免 Commit 后维护造成版本歧义 |
| context | 实际预算、三个层的 provided/eligible/injected/truncated/omitted、完整 task 未截断统计 |
| maintenance | committed 时分别报告 L2/L3/L4；其他状态为 null；无 L3 来源允许 skipped |
| agentExitCode | 成功通常为 0 |
| repoMindCalls | Host-managed 应为 0 |
| inputTokens/outputTokens | 当前 Adapter 事件上报值；不同 Runner/Provider 不直接横比 |
| durationMs | 完整 Host lifecycle |
| reportPath/outputDirectory | 可定位原始产物 |
| openSessions/runningHostRuns | 任务结束后应为 0 |

Run 目录通常包含：

```text
events.jsonl
stderr.log
run.json
```

### 5.4 执行第二个相关任务，验证跨 Session 复用

```powershell
node $repoMindCli run `
  --repo $targetRepo `
  --task "在同一重试机制中加入超时分类，遵循现有失败处理约定并运行测试" `
  --model cliproxyapi/gpt-5.6-luna `
  --max-memories 5 `
  --timeout 600000 `
  --json
```

验证：

1. 第二次 `retrievedMemories > 0`；
2. `run.json` 中记录的 Memory ID 能通过 `inspect` 查到；
3. Memory 的 Evidence 能回溯第一次 Session；
4. Agent 行为确实利用了历史约束，而不是只在 Prompt 中出现但未采用；
5. 第二次结束后没有 open Session。

为什么一定要第二个任务：第一次运行只能证明“能写记忆”，第二次相关任务才证明“跨会话可召回并影响行为”。

### 5.5 使用同一 Host 生命周期运行 Claude Code

Claude Code 已接入通用 Host Adapter。先确认 `claude --version` 与 `claude auth status --text` 正常，再把同一命令的 Runner 和模型改为 Claude：

```powershell
node $repoMindCli run `
  --repo $targetRepo `
  --task "修复队列任务失败后的重试逻辑，运行相关测试，并说明关键约束" `
  --runner claude `
  --model gpt-5.6-luna `
  --max-memories 5 `
  --context-budget 12000 `
  --timeout 600000 `
  --json
```

Claude Adapter 使用显式工具 allowlist 和 `dontAsk` 模式；日常仓库不会开放 `bypassPermissions`。它要求终止 `result` 明确成功，并将 Bash/PowerShell 的唯一 `tool_use` 与唯一 `tool_result` 配对后才信任 exit code。当前实现与单测已经覆盖该路径，但 2026-08-11 的 120-stage 正式结果只运行了 OpenCode，不能据此声称 Claude 与 OpenCode 的当前分层 Host 效果相同。

## 6. Agent-managed MCP：OpenCode

在目标仓库的 `opencode.json` 中使用 RepoMind build 的绝对路径：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "repomind": {
      "type": "local",
      "command": [
        "node",
        "D:/data/code/project/repomind/dist/cli/index.js",
        "mcp"
      ],
      "enabled": true
    }
  }
}
```

验证：

```powershell
Set-Location $targetRepo
opencode.cmd debug config
opencode.cmd mcp list
```

再将 [`../examples/opencode/AGENTS.md`](../examples/opencode/AGENTS.md) 的生命周期规则合并到目标仓库的 Agent 指令中。仅注册 MCP 只代表“工具可见”，不会保证 Agent 知道何时 Start/Commit。

推荐规则：

```markdown
- 每个仓库任务开始时调用 repo_session_start。
- recalled Memory 是有来源的上下文，不覆盖用户请求和当前代码。
- uncertain Memory 必须先核对。
- 初始召回不足时调用 repo_memory_search。
- 最终回答前调用 repo_session_commit，并提交 summary、decisions、tests、commands、remaining work。
- commit/inspect 始终带 repo_path，以便 MCP 重启后仍可解析。
```

## 7. Agent-managed MCP：Claude Code

可以在受信任项目的 `.mcp.json` 中配置 stdio Server。具体配置能力随 Claude Code 版本变化，下面使用仓库 README 所采用的通用 MCP 结构：

```json
{
  "mcpServers": {
    "repomind": {
      "command": "node",
      "args": [
        "D:/data/code/project/repomind/dist/cli/index.js",
        "mcp"
      ]
    }
  }
}
```

启动前检查：

```powershell
claude mcp list
```

并在项目 `CLAUDE.md` 中加入与 OpenCode 相同的 Start/Search/Commit 规则。

仓库中的历史 v0.15 跨 Agent 验收覆盖了 OpenCode 与 Claude Code：OpenCode 产生重复成功 Session，Claude Code 通过独立 MCP 读取、重建、审批并导出 L4；新 OpenCode 来源到达后，候选重新变为 pending。它证明同库互操作与 L4 生命周期，不证明当前 L1-L3 Host 管线已经完成混合 Agent 正式实验，也不应扩展成“所有 Agent 都已验证”。

## 8. Agent-managed MCP：Codex

根据 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp/) 和 [配置参考](https://developers.openai.com/codex/config-reference/)，用户配置使用 `[mcp_servers.<id>]` 表，`enabled_tools` 是可选工具 allowlist。

将以下内容加入用户级 `~/.codex/config.toml`，或受信任仓库的 `.codex/config.toml`：

```toml
[mcp_servers.repomind]
enabled = true
required = false
command = "node"
args = ["D:\\data\\code\\project\\repomind\\dist\\cli\\index.js", "mcp"]
startup_timeout_sec = 10.0
tool_timeout_sec = 60.0
```

不设置 `enabled_tools` 可以避免仓库旧示例只 allowlist 9 项工具的问题；需要最小权限时再显式列出所需工具。当前源码共有 24 项 MCP Tool。

把 [`../examples/codex/AGENTS.md`](../examples/codex/AGENTS.md) 的规则合并进目标仓库 `AGENTS.md`，重启 Codex 后检查 MCP 工具。

边界：仓库提供 Codex 配置示例，但没有保留与 OpenCode+Claude Code 同等的真实 Codex acceptance 产物，因此应说“支持 Codex MCP 接入”，不要说“已完成 Codex 跨 Agent 实测”。

## 9. 当前 24 项 MCP Tool

| 分类 | Tool |
| --- | --- |
| Session | `repo_session_start`、`repo_session_commit`、`repo_session_abandon` |
| L1 搜索与检查 | `repo_memory_search`、`repo_memory_inspect` |
| L1 写入与治理 | `repo_memory_record`、`repo_memory_validate`、`repo_memory_correct`、`repo_memory_invalidate`、`repo_memory_forget` |
| 远程提取 | `repo_memory_extract` |
| 批量维护 | `repo_memory_review`、`repo_memory_review_apply` |
| L2 | `repo_module_rebuild`、`repo_module_list`、`repo_module_inspect` |
| L3 | `repo_profile_rebuild`、`repo_profile_get`、`repo_profile_inspect` |
| L4 | `repo_skill_candidate_rebuild`、`repo_skill_candidate_list`、`repo_skill_candidate_inspect`、`repo_skill_candidate_review`、`repo_skill_candidate_export` |

`init/status/doctor/reindex/export/import/backup/restore/run/eval` 只在 CLI，不在 MCP。

仓库旧的 [`../docs/mcp-integration.md`](../docs/mcp-integration.md) 仍写 7 项工具，属于历史文档；以 [`../src/mcp/server.ts`](../src/mcp/server.ts) 和当前 README 为准。

## 10. 纯 CLI 手动生命周期

### 10.1 Start

```powershell
$started = node $repoMindCli start `
  --repo $targetRepo `
  --task "检查队列超时处理并修复" `
  --json | ConvertFrom-Json

$started.sessionId
$started.memories
$started.moduleNarratives
$started.repositoryProfile
```

### 10.2 Agent 或人工完成修改和测试

```powershell
npm.cmd test
$testExitCode = $LASTEXITCODE
```

### 10.3 构造 Commit Payload

```powershell
$commitPayload = [ordered]@{
  sessionId = $started.sessionId
  idempotencyKey = "tutorial-$($started.sessionId)"
  status = if ($testExitCode -eq 0) { "success" } else { "partial" }
  summary = "修复了队列超时分类，并保留原有重试边界。"
  decisions = @(
    "超时错误保持可重试，参数校验错误保持不可重试。"
  )
  tests = @(
    [ordered]@{
      command = "npm test"
      exitCode = $testExitCode
      summary = "运行项目测试。"
    }
  )
  commands = @()
  remainingWork = if ($testExitCode -eq 0) { @() } else { @("调查失败测试") }
}

$commitInput = Join-Path $env:TEMP "repomind-commit-input.json"
$commitPayload | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $commitInput

node $repoMindCli commit `
  --input $commitInput `
  --repo $targetRepo `
  --json
```

用相同 idempotency key 和完全相同 payload 重试会返回原 receipt；同 key 修改 payload 会被拒绝。

## 11. 搜索、检查与手工记录

```powershell
node $repoMindCli search "队列 重试" --repo $targetRepo --limit 5 --json
node $repoMindCli inspect <memory-id> --repo $targetRepo --json

node $repoMindCli record `
  --type convention `
  --title "队列错误分类" `
  --content "超时错误可重试，参数错误不可重试。" `
  --scope-type module `
  --scope-value src/queue `
  --related-files src/queue/retry.ts `
  --repo $targetRepo `
  --json
```

Inspect 时应检查：Evidence ID/kind/preview、related file hash、status reason、relation、Audit，而不只看正文。

## 12. 冷启动 Bootstrap

```powershell
$bootstrapFile = "D:\data\code\project\repomind-test\yocto-bootstrap.json"

node $repoMindCli bootstrap `
  --repo $targetRepo `
  --output $bootstrapFile `
  --json

node $repoMindCli bootstrap-apply `
  --repo $targetRepo `
  --input $bootstrapFile `
  --json
```

第二条没有 `--yes` 时只预览并失败退出，这是有意的确认门槛。审查后：

```powershell
node $repoMindCli bootstrap-apply `
  --repo $targetRepo `
  --input $bootstrapFile `
  --candidate <candidate-id-1>,<candidate-id-2> `
  --yes `
  --json
```

为什么只选权威候选：Bootstrap 来源有限，README、CONTRIBUTING、ADR 和 commit subject 不等于当前代码事实。

## 13. L2/L3/L4 维护

成功的 Host-managed `repomind run` 已经自动执行一次同步 best-effort 维护。这里的命令仍然必要，因为 `repomind commit`、MCP `repo_session_commit`、Agent-managed 和直接 Core 调用不会隐式维护；它们也用于定向模块重建、调整预算/阈值以及运维复核。

自动维护的失败和 Session Commit 分开：某层失败会记录 error 并继续后续层，不回滚 committed Session，也不把成功 Host Run 改为失败。partial、failed、abandoned Run 不维护。L4 自动阶段只生成或刷新 pending Candidate，绝不自动 approve、export、install 或 execute。

### 13.1 重建 L2

```powershell
node $repoMindCli module-rebuild `
  --module src/queue,src/storage `
  --budget 4000 `
  --repo $targetRepo `
  --json

node $repoMindCli modules --repo $targetRepo --json
node $repoMindCli module-inspect <l2-id> --repo $targetRepo --json
```

### 13.2 重建 L3

```powershell
node $repoMindCli profile-rebuild `
  --budget 6000 `
  --min-confidence 0.8 `
  --repo $targetRepo `
  --json

node $repoMindCli profile --repo $targetRepo --json
node $repoMindCli profile-inspect --repo $targetRepo --json
```

### 13.3 生成和审批 L4

```powershell
node $repoMindCli skill-rebuild --min-sessions 3 --repo $targetRepo --json
node $repoMindCli skills --status pending --repo $targetRepo --json
node $repoMindCli skill-inspect <l4-id> --repo $targetRepo --json

node $repoMindCli skill-review <l4-id> `
  --action approve `
  --reason "已人工核对步骤、顺序和验证命令" `
  --repo $targetRepo `
  --json

node $repoMindCli skill-export <l4-id> `
  --output D:\data\code\project\repomind-test\reviewed-SKILL.md `
  --repo $targetRepo `
  --json
```

导出目标必须不存在。审查时特别恢复真实命令顺序，因为当前 L4 签名和 steps 使用排序后的命令集合。

## 14. 可选向量检索

离线测试 Provider：

```powershell
$env:REPOMIND_EMBEDDING_PROVIDER = "deterministic"
$env:REPOMIND_EMBEDDING_DIMENSIONS = "256"

node $repoMindCli vector-reindex --repo $targetRepo --json
node $repoMindCli search "用另一种表达描述重试失败" --repo $targetRepo --json
```

OpenAI-compatible Provider：

```powershell
$env:REPOMIND_EMBEDDING_PROVIDER = "openai-compatible"
$env:REPOMIND_EMBEDDING_BASE_URL = "https://provider.example/v1"
$env:REPOMIND_EMBEDDING_API_KEY = "<secret>"
$env:REPOMIND_EMBEDDING_MODEL = "<embedding-model>"
$env:REPOMIND_EMBEDDING_DIMENSIONS = "1536"
```

远程 Provider 会接收 Memory title/content 和查询文本。不要在禁止仓库内容外发的环境开启。

## 15. 可选远程 LLM 提取

```powershell
$env:REPOMIND_EXTRACTION_PROVIDER = "openai-compatible"
$env:REPOMIND_EXTRACTION_BASE_URL = "https://provider.example/v1"
$env:REPOMIND_EXTRACTION_API_KEY = "<secret>"
$env:REPOMIND_EXTRACTION_MODEL = "<model>"
$env:REPOMIND_EXTRACTION_TIMEOUT_MS = "60000"

node $repoMindCli extract `
  --session <completed-session-id> `
  --repo $targetRepo `
  --json
```

为什么 Commit 后单独执行：确定性 L1 和生命周期不依赖远程服务；只有用户明确允许时，已脱敏且有界的 Evidence 才发送给 Provider。

## 16. 导出、备份与恢复

### 16.1 逻辑导出/导入

```powershell
node $repoMindCli export `
  --repo $targetRepo `
  --output D:\backups\yocto-repomind.json `
  --json

node $repoMindCli import `
  --repo $targetRepo `
  --input D:\backups\yocto-repomind.json `
  --dry-run `
  --json
```

确认 Import 使用 replace，不是 merge；执行 `--yes` 会替换目标逻辑数据。先做 dry-run 和 backup。

### 16.2 加密物理备份

```powershell
$env:REPOMIND_ARCHIVE_PASSPHRASE = Read-Host "Archive passphrase" -MaskInput

node $repoMindCli backup `
  --repo $targetRepo `
  --output D:\backups\yocto-repomind.db.enc `
  --encrypt `
  --json

node $repoMindCli restore `
  --repo $targetRepo `
  --input D:\backups\yocto-repomind.db.enc `
  --dry-run `
  --json

Remove-Item Env:REPOMIND_ARCHIVE_PASSPHRASE
```

Restore 必须匹配同一 Project ID；加密只保护归档，不保护 live DB 和 pre-restore snapshot。

## 17. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| MCP 无工具或立即断开 | 未 build、路径错、stdout 被非 JSON 污染 | build，使用绝对路径，运行 MCP stdio 测试 |
| `repo_path is required` | MCP 进程重启后 ID->repo 内存映射丢失 | commit/inspect/治理显式传 repo_path |
| Search 找不到已知 Memory | superseded/invalid 被过滤，或旧索引 | inspect/status；必要时 `reindex` |
| 大量 uncertain | related files 在重构中变化 | review 后 validate/correct/invalidate |
| Session 一直 open | Agent-managed 忘记 Commit | `sessions` 审计，必要时 `session-abandon` |
| Hybrid 退回 FTS | Provider、sqlite-vec 或维度失败 | 查看 `fallbackReason` 和 `doctor --json` |
| Host Run 有 RepoMind call | Agent 绕过 Host 调用了 MCP | 检查配置覆盖和 Prompt；该 Run 不应判成功 |
| `--context-budget` 被拒绝 | 不是 `1,000-24,000` 的整数 | 调整预算；长 task 不受该预算影响，不要为保留 task 盲目增大 |
| Windows `prompt too long` | Prompt 超过 28,000，或按 libuv quoting 计算后的完整命令行超过 32,767 | 缩短 task 或降低 `--context-budget`；Session 会被 abandon；长期可改用非 argv 通道 |
| committed 但 maintenance failed/partial | 派生层某个 rebuild 失败 | Session/L0/L1 已提交；查看 `run.json.maintenance`，修复后手工运行对应 rebuild |
| 导出被 sensitive gate 阻止 | 发现 credential pattern | 检查内容；只有明确接受风险才用 `--allow-sensitive` |
| Import/Restore 被拒绝 | 有 open Session/running Run 或 active-work guard | 先结束生命周期，不要强行替换运行中数据库 |

## 18. 最小验收清单

一次真实接入至少完成：

```text
[ ] doctor/typecheck/build 通过
[ ] 目标仓库 init，projectId 稳定
[ ] 第一次真实任务产生 committed Session
[ ] 第二次相关任务 retrievedMemories > 0
[ ] `run.json` 的 context 统计与 `1,000-24,000` 预算一致，Current Task 未被截断
[ ] committed Run 有 maintenance 结果；partial/failed/abandoned 没有自动维护
[ ] L4 自动维护后仍为 pending，审批和导出由人显式完成
[ ] Inspect 能看到 Evidence 和 Audit
[ ] 修改 related file 后 Memory 变 uncertain
[ ] 人工 validate/correct/invalidate 后状态正确
[ ] 没有 open Session 或 running Host Run 泄漏
[ ] 做过 export 或 backup 的 dry-run 恢复检查
[ ] 若声称提升，使用三臂、多次重复、隐藏检查，而不是主观观察
```
