# 受控 Agent 基准

`repomind eval --agent` 使用 no-memory、raw full-history 和 RepoMind 三个 arm，衡量端到端编码 Agent 任务结果。当前支持 OpenCode，并始终创建一个不能把工作委派给后台 Agent 的受控主 Agent。Runner 为 OpenCode 传入 `--pure`，因此全局插件无法向受控 arm 添加未版本化的工具、MCP 服务器或提示行为。

```powershell
repomind eval --agent `
  --manifest D:\path\to\manifest.json `
  --runner opencode `
  --model cliproxyapi/gpt-5.6-terra `
  --lifecycle host-managed `
  --repeat 3 `
  --output D:\path\to\results `
  --strict `
  --require-acceptance `
  --json
```

每个任务和 arm 都从 `baseRepository` 独立克隆，并 checkout 到 `baseCommit`。Manifest v2 按重复次数轮换三种执行顺序。RepoMind arm 获得隔离数据目录和 manifest Memory。执行前，Runner 会进行确定性的派生维护，使符合条件的 L2 Module Narrative 和 current L3 Profile 可用于分层 Host prompt；seed maintenance 为 partial 或 failed 时直接中止 Run，避免静默评测一个实际只有 L1 的配置。full-history arm 获得可能包含过期尝试和噪声的原始历史，但不获得 MCP 服务器；no-memory arm 两者都没有。Manifest v1 仍受支持，并保留原有的交替双 arm 运行。

## 生命周期模式

`--lifecycle agent-managed` 是向后兼容默认值。RepoMind MCP 服务器暴露给 OpenCode，因此 Session start 和 commit 在模型循环内部发生，其直接执行时间包含在 Agent 墙钟时间中。

`--lifecycle host-managed` 将 RepoMind MCP 排除在 Agent 工具集之外。Runner 在 OpenCode 前启动 Session，将 current L3、相关 current L2 和排序 L1 注入任务提示，运行 Agent，并使用 Agent 最终响应和观察到的命令/测试事件从宿主提交 Session。Start、Agent、commit 和成功 Commit 后的派生 maintenance 是四个独立顺序计时阶段，全部计入 `totalLifecycleMs`。外部 public 和 hidden check 在 maintenance 后运行，处于模型上下文和已保存 Memory Evidence 之外。

Host-managed 模式内部使用导出的 `startHostLifecycle`、`hostManagedPrompt`、`analyzeOpenCodeOutcome` 和 `commitHostLifecycle`。其他 OpenCode 宿主可复用它们，而无需依赖 benchmark runner。

## Manifest（清单）

命令表示为程序加参数数组，绝不接受 Shell 命令字符串。Check 命令或参数中的 `{repo}` 会替换为新克隆路径。

```json
{
  "version": 2,
  "name": "example suite",
  "tasks": [{
    "id": "example",
    "baseRepository": "./base",
    "baseCommit": "HEAD",
    "prompt": "Implement the requested change.",
    "fullHistory": [
      "An old attempt used the legacy API and failed.",
      "A later review recorded the current convention among unrelated discussion."
    ],
    "publicChecks": [{ "command": "node", "args": ["--test"] }],
    "hiddenChecks": [{ "command": "node", "args": ["./hidden/verify.mjs", "{repo}"] }],
    "memories": [{
      "type": "convention",
      "title": "Historical rule",
      "content": "The fact the RepoMind arm should retrieve."
    }],
    "allowedChanges": ["src/target.js"]
  }],
  "acceptance": {
    "minRepoMindHiddenPassRate": 1,
    "minHiddenPassRateDelta": 0,
    "minFullHistoryHiddenPassRateDelta": 0,
    "minRetrievalRate": 1,
    "minSessionCommitRate": 1,
    "maxMeanDurationRegressionPercent": 15,
    "maxFullHistoryDurationRegressionPercent": 15,
    "requireEfficiencyImprovement": true,
    "requiredTaskWins": ["example"]
  }
}
```

Hidden verifier 必须位于 `baseRepository` 之外，否则 Agent 可以检查预期答案。Public check 应证明常规仓库健康状态，同时不泄漏被测历史事实。

## 输出与 strict 模式

输出目录在 `runs/` 下包含新仓库，在 `data/` 下包含隔离 RepoMind 数据库，在 `raw/` 下包含 OpenCode JSONL 和 stderr，另外包含 `summary.json` 与 `summary.md`。

报告包括 hidden/public 通过数量、耗时、Token、文件读取、工具失败、RepoMind 调用、检索到的 Memory、变化文件和 Session 清理状态。它还记录 RepoMind 版本、commit 和 worktree 状态、Node 和 OS、runner 版本、manifest SHA-256，以及每个任务解析后的 base commit。Report v7 为每次运行记录 `startMs`、`agentMs`、`commitMs`、`maintenanceMs`、`totalLifecycleMs`，以及彼此独立的 Commit/Maintenance 成功与状态 telemetry，避免把派生刷新成本和故障折叠进 `commitMs`。它还记录 L1/L2/L3 的提供、资格、注入、预算和截断信息、Prompt SHA-256、权威检查、Git snapshot 稳定性及命令恢复状态，但不保存完整 Prompt。

`--strict` 在以下实验完整性缺陷出现时失败：Agent 崩溃、base commit 错误、意外文件变化、跨 arm MCP 使用、RepoMind 生命周期操作缺失或失败、committed Host Run 没有尝试 maintenance、maintenance 为 partial/failed、阶段总数无法对齐、清理后仍有 open Session。Hidden check 失败仍是合法任务结果，本身不会使实验无效。

报告将 `integrity` 与 `acceptance` 分开。Report schema v7 分别保存与 no-memory 和 full-history 的配对比较。Acceptance 标准在 manifest 中声明，并生成独立测量门禁。配置的 task win 表示该任务的 RepoMind hidden pass rate 必须严格高于 no-memory。标准缺失或失败时，`--require-acceptance` 以失败退出；它不会改变 `--strict` 的含义。

配对统计针对相同任务和重复编号，将 RepoMind 与每个可用基线比较。JSON 与 Markdown 报告包含 hidden/public 成功率、墙钟时间、输入/输出 Token 和文件读取的 mean/median delta、相对变化以及 RepoMind win/tie/loss 数量。

## 聚合报告

合并多个模型或 OS 产生的 report v4-v7：

```powershell
repomind eval --agent-summary `
  --reports "D:\results\**\summary.json" `
  --output D:\results\aggregate `
  --strict `
  --json
```

聚合报告会哈希每个来源 JSON，并从原始运行重新计算 paired mean、win/tie/loss 数量和近似 95% interval。任何来源报告 integrity 失败时，`--strict` 失败。它不会重新解释或覆盖每个实验的 acceptance 结果。

## 离线阶段 Profile

无需再次调用模型，即可归因现有 report v4-v7 的运行时间与 Token 成本：

```powershell
repomind eval --agent-profile `
  --report D:\results\summary.json `
  --output D:\results\profile `
  --strict `
  --json
```

命令默认读取来源报告及其同级 `raw/` 目录。JSONL 已移动时使用 `--raw <dir>`。它写入 `profile.json` 和 `profile.md`，哈希来源报告，并针对报告中的 turn、Token 和工具计数验证每个原始文件。

Profile v2 会区分旧报告中“无法提供”“不适用”和“字段缺失”的 telemetry，避免把缺失数据误报为零。它报告三个不同边界：

- 各 MCP 工具自身 start/end 时间戳给出的直接 RepoMind 工具时间；
- 包含 Session start、Session commit 或其他 RepoMind 工具的完整模型 cycle，以及紧随其后的模型 cycle；
- 与 no-memory 和 full-history 相比，墙钟时间、观察事件时间、进程开销、turn、工具调用和 Token 的配对端到端 delta。

直接工具时间是 storage/MCP 执行成本。周边 cycle 还包含模型和宿主编排时间，因此是诊断窗口，而不是可以独立相加的因果估计。配对端到端 delta 仍是权威总成本。

## 重建随附套件

八任务套件以普通模板而不是嵌套 Git 仓库保存。在新的外部目录中生成已提交 fixture 仓库：

```powershell
node .\benchmarks\agent-suite\create.mjs `
  D:\data\code\project\repomind-test\agent-suite-v2
```

生成器拒绝覆盖现有目录。它将 hidden verifier 复制到每个 base repository 之外，初始化并提交各 base，并将 verifier 绝对路径和实际 base commit 写入 `manifest.json`。它固定 Git author/committer 时间戳并强制 LF 行尾，因此在不同目录中生成同一模板会得到相同 base commit ID。生成 `.gitignore` 会继续排除结果。

`npm run bench:agent-fixtures` 重建全部八个仓库，验证 commit 身份，要求每个 public baseline check 通过，并要求每个外部 hidden check 在未修改 baseline 上按设计失败。CI 在 Windows 和 Ubuntu 上运行该验证，不需要模型账户。

## 验收日常 `repomind run` 路径

三臂基准回答对比研究问题。要验证日常产品路径，请在全部八个任务上使用专用 Host-run 验收 harness：

```powershell
npm run bench:host-run -- `
  --workspace D:\data\code\project\repomind-test\host-run-acceptance-v0.9 `
  --model cliproxyapi/gpt-5.6-terra `
  --strict
```

Workspace 必须不存在。命令重建固定 commit 套件，然后在 `results/runs` 下再次克隆每个任务。Harness 调用与 `repomind run` 相同的 `runOpenCodeHost` 实现前，每个克隆都获得独立 RepoMind 数据库和 manifest Memory。

每个任务的 acceptance 要求至少检索一条 Memory、零 Agent RepoMind 调用、Agent 干净退出、Session committed、public 和外部 hidden check 通过、无 open Session、只有 allowlist 文件变化，并且运行制品存在、可解析且通过 Secret 扫描。结果写入 `results/summary.json` 和 `results/summary.md`。任何任务或完整性要求失败时，`--strict` 返回非零退出码。省略 `--model` 会使用 OpenCode 配置的默认模型。

正式 v0.8 Host-managed 三臂运行的 provenance、生命周期成本、置信区间和已通过结果验收记录在 [`agent-benchmark-results-v0.8.md`](agent-benchmark-results-v0.8.md)。早期正式 v0.7 Agent-managed 运行作为有效负面结果保存在 [`agent-benchmark-results-v0.7.md`](agent-benchmark-results-v0.7.md)。确定性 v0.7 基础设施验收记录在 [`agent-benchmark-validation-v0.7.md`](agent-benchmark-validation-v0.7.md)，更早 v0.6 双臂结果保存在 [`agent-benchmark-results-v0.6.md`](agent-benchmark-results-v0.6.md)。
